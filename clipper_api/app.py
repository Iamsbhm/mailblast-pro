"""
ClipGenius - Flask API Server
REST API for the YouTube Shorts auto-clipper.
"""

import sys
import os
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

from flask import Flask, jsonify, request, send_file, abort
from flask_cors import CORS
import threading
import json
import uuid
import time
from pathlib import Path

from clipper import (
    get_video_info, download_video, export_all_clips, cleanup_job,
    CLIPS_DIR, JOBS_DIR, UPLOADS_DIR
)
from analyzer import find_viral_moments

app = Flask(__name__)

# Allow requests from any origin (Vercel frontend or localhost)
ALLOWED_ORIGINS = os.environ.get('ALLOWED_ORIGINS', '*')
CORS(app, origins=ALLOWED_ORIGINS)

# ─── Job Store (in-memory + disk) ─────────────────────────────────────────────

def save_job(job_id, data):
    job_file = JOBS_DIR / f"{job_id}.json"
    with open(job_file, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)

def load_job(job_id):
    job_file = JOBS_DIR / f"{job_id}.json"
    if not job_file.exists():
        return None
    with open(job_file, 'r', encoding='utf-8') as f:
        return json.load(f)

def update_job(job_id, updates):
    job = load_job(job_id)
    if job:
        job.update(updates)
        save_job(job_id, job)
    return job


# ─── Background Processing ────────────────────────────────────────────────────

def process_video_job(job_id, url, options):
    """Background thread: download → analyze → clip → update job status."""
    
    try:
        # ── Phase 1: Download ──────────────────────────────────────────────
        update_job(job_id, {
            "status": "downloading",
            "phase": "Downloading video...",
            "progress": 5
        })
        
        def download_progress(phase, pct):
            update_job(job_id, {
                "phase": f"Downloading video... {pct:.0f}%",
                "progress": int(5 + pct * 0.45)  # 5% → 50%
            })
        
        video_path, subtitle_path = download_video(url, job_id, download_progress)
        
        update_job(job_id, {
            "phase": "Download complete. Analyzing video...",
            "progress": 52,
            "video_path": video_path
        })
        
        # ── Phase 2: Analyze ───────────────────────────────────────────────
        update_job(job_id, {
            "status": "analyzing",
            "phase": "Finding viral moments...",
            "progress": 55
        })
        
        subtitle_text = ""
        if subtitle_path and os.path.exists(subtitle_path):
            with open(subtitle_path, 'r', encoding='utf-8') as f:
                subtitle_text = f.read()
        
        job_data = load_job(job_id)
        video_duration = job_data.get("video_info", {}).get("duration", None)
        
        moments = find_viral_moments(
            video_path=video_path,
            subtitle_text=subtitle_text,
            num_clips=options.get("num_clips", 4),
            clip_min_duration=options.get("min_duration", 30),
            clip_max_duration=options.get("max_duration", 58),
            video_duration=video_duration
        )
        
        if not moments:
            update_job(job_id, {
                "status": "error",
                "error": "Could not find suitable clips in this video. Try a longer video.",
                "progress": 0
            })
            return
        
        update_job(job_id, {
            "moments": moments,
            "phase": f"Found {len(moments)} viral moments! Generating clips...",
            "progress": 65
        })
        
        # ── Phase 3: Export Clips ──────────────────────────────────────────
        update_job(job_id, {
            "status": "exporting",
            "phase": "Generating Shorts clips...",
            "progress": 68
        })
        
        def export_progress(phase, pct, msg=""):
            update_job(job_id, {
                "phase": msg or f"Exporting clips... {pct:.0f}%",
                "progress": int(68 + pct * 0.30)  # 68% → 98%
            })
        
        clips = export_all_clips(
            video_path=video_path,
            moments=moments,
            job_id=job_id,
            subtitle_path=subtitle_path,
            watermark_text=options.get("watermark_text", ""),
            add_subtitles=options.get("add_subtitles", True),
            progress_callback=export_progress
        )
        
        # ── Phase 4: Complete ──────────────────────────────────────────────
        update_job(job_id, {
            "status": "complete",
            "phase": "All clips ready! 🎉",
            "progress": 100,
            "clips": clips,
            "completed_at": time.time()
        })
        
        # Clean up source video to save space
        try:
            for f in UPLOADS_DIR.iterdir():
                if f.stem == job_id and f.suffix in ['.mp4', '.mkv', '.webm']:
                    f.unlink(missing_ok=True)
                elif f.stem.startswith(job_id) and f.suffix in ['.vtt', '.srt']:
                    f.unlink(missing_ok=True)
        except Exception:
            pass
        
        print(f"[Job {job_id}] ✅ Complete! {len(clips)} clips generated.")
    
    except Exception as e:
        import traceback
        error_msg = str(e)
        print(f"[Job {job_id}] ❌ Error: {error_msg}")
        traceback.print_exc()
        update_job(job_id, {
            "status": "error",
            "error": error_msg,
            "phase": f"Error: {error_msg}",
            "progress": 0
        })


# ─── API Routes ───────────────────────────────────────────────────────────────

@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "service": "ClipGenius API", "version": "1.0.0"})


@app.route('/api/video-info', methods=['POST'])
def video_info():
    """Fetch YouTube video metadata."""
    data = request.get_json()
    url = (data or {}).get('url', '').strip()
    
    if not url:
        return jsonify({"error": "URL is required"}), 400
    
    # Basic YouTube URL validation
    yt_patterns = [
        r'youtube\.com/watch\?v=',
        r'youtu\.be/',
        r'youtube\.com/shorts/',
        r'youtube\.com/live/'
    ]
    import re
    if not any(re.search(p, url) for p in yt_patterns):
        return jsonify({"error": "Please enter a valid YouTube URL"}), 400
    
    try:
        info = get_video_info(url)
        return jsonify({"success": True, "video": info})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"Failed to fetch video info: {str(e)}"}), 500


@app.route('/api/process', methods=['POST'])
def start_processing():
    """Start a new clip generation job."""
    data = request.get_json()
    url = (data or {}).get('url', '').strip()
    
    if not url:
        return jsonify({"error": "URL is required"}), 400
    
    options = {
        "num_clips": min(8, max(1, int(data.get("num_clips", 4)))),
        "min_duration": max(15, int(data.get("min_duration", 30))),
        "max_duration": min(60, int(data.get("max_duration", 58))),
        "watermark_text": str(data.get("watermark_text", ""))[:50],
        "add_subtitles": bool(data.get("add_subtitles", True)),
    }
    
    # Fetch video info first
    try:
        video_info_data = get_video_info(url)
    except Exception as e:
        return jsonify({"error": f"Invalid URL or video unavailable: {str(e)}"}), 400
    
    # Create job
    job_id = str(uuid.uuid4())[:12].replace('-', '')
    job_data = {
        "id": job_id,
        "url": url,
        "options": options,
        "video_info": video_info_data,
        "status": "queued",
        "phase": "Starting...",
        "progress": 0,
        "clips": [],
        "moments": [],
        "created_at": time.time()
    }
    save_job(job_id, job_data)
    
    # Start background processing
    thread = threading.Thread(
        target=process_video_job,
        args=(job_id, url, options),
        daemon=True
    )
    thread.start()
    
    return jsonify({
        "success": True,
        "job_id": job_id,
        "video": video_info_data,
        "message": "Processing started!"
    })


@app.route('/api/job/<job_id>', methods=['GET'])
def get_job_status(job_id):
    """Get job status and results."""
    # Sanitize job_id
    import re
    if not re.match(r'^[a-f0-9]{12}$', job_id):
        return jsonify({"error": "Invalid job ID"}), 400
    
    job = load_job(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    
    # Don't send full file paths to client
    safe_job = {k: v for k, v in job.items() if k != 'video_path'}
    if 'clips' in safe_job:
        safe_clips = []
        for clip in safe_job['clips']:
            safe_clip = {k: v for k, v in clip.items() if k != 'path'}
            if clip.get('status') == 'ready':
                safe_clip['download_url'] = f"/api/download/{clip['id']}"
            safe_clips.append(safe_clip)
        safe_job['clips'] = safe_clips
    
    return jsonify(safe_job)


@app.route('/api/download/<clip_id>', methods=['GET'])
def download_clip(clip_id):
    """Stream/download a clip file."""
    # Sanitize clip_id
    import re
    if not re.match(r'^[a-f0-9]{12}_clip\d+$', clip_id):
        return jsonify({"error": "Invalid clip ID"}), 400
    
    clip_path = CLIPS_DIR / f"{clip_id}.mp4"
    
    if not clip_path.exists():
        return jsonify({"error": "Clip not found or expired"}), 404
    
    return send_file(
        str(clip_path),
        mimetype='video/mp4',
        as_attachment=True,
        download_name=f"{clip_id}.mp4"
    )


@app.route('/api/cleanup/<job_id>', methods=['DELETE'])
def cleanup(job_id):
    """Delete all files for a job."""
    import re
    if not re.match(r'^[a-f0-9]{12}$', job_id):
        return jsonify({"error": "Invalid job ID"}), 400
    
    removed = cleanup_job(job_id)
    return jsonify({"success": True, "removed": len(removed)})


@app.route('/api/jobs', methods=['GET'])
def list_jobs():
    """List recent jobs."""
    jobs = []
    for f in JOBS_DIR.iterdir():
        if f.suffix == '.json':
            try:
                with open(f, 'r') as fp:
                    job = json.load(fp)
                    jobs.append({
                        "id": job.get("id"),
                        "status": job.get("status"),
                        "phase": job.get("phase"),
                        "progress": job.get("progress"),
                        "video_title": job.get("video_info", {}).get("title", "Unknown"),
                        "clips_count": len(job.get("clips", [])),
                        "created_at": job.get("created_at")
                    })
            except Exception:
                pass
    
    jobs.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return jsonify({"jobs": jobs[:20]})


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"[ClipGenius] API starting on http://0.0.0.0:{port}")
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
