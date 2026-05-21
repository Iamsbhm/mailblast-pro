"""
ClipGenius - Video Clipper
Handles downloading YouTube videos and exporting clips as Shorts format.
Uses yt-dlp for downloading and FFmpeg for video processing.
"""

import subprocess
import os
import json
import uuid
import re
from pathlib import Path


# ─── Paths ────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent
UPLOADS_DIR = BASE_DIR / "uploads"
CLIPS_DIR = BASE_DIR / "clips"
JOBS_DIR = BASE_DIR / "jobs"

for d in [UPLOADS_DIR, CLIPS_DIR, JOBS_DIR]:
    d.mkdir(exist_ok=True)


# ─── YouTube Download ─────────────────────────────────────────────────────────

def get_video_info(url):
    """
    Fetch YouTube video metadata without downloading.
    Returns dict with title, duration, thumbnail, channel, view_count, etc.
    """
    cmd = [
        "yt-dlp",
        "--dump-json",
        "--no-playlist",
        "--skip-download",
        url
    ]
    
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise ValueError(f"Could not fetch video info: {result.stderr[:200]}")
    
    data = json.loads(result.stdout)
    
    return {
        "id": data.get("id", ""),
        "title": data.get("title", "Unknown"),
        "duration": data.get("duration", 0),
        "duration_str": _format_duration(data.get("duration", 0)),
        "thumbnail": data.get("thumbnail", ""),
        "channel": data.get("channel", data.get("uploader", "Unknown")),
        "view_count": data.get("view_count", 0),
        "view_count_str": _format_views(data.get("view_count", 0)),
        "upload_date": data.get("upload_date", ""),
        "description": (data.get("description") or "")[:300],
        "webpage_url": data.get("webpage_url", url),
    }


def download_video(url, job_id, progress_callback=None):
    """
    Download a YouTube video to the uploads directory.
    Returns the path to the downloaded file.
    """
    output_template = str(UPLOADS_DIR / f"{job_id}.%(ext)s")
    
    cmd = [
        "yt-dlp",
        "--no-playlist",
        "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
        "--merge-output-format", "mp4",
        "--write-auto-sub",
        "--sub-lang", "en",
        "--sub-format", "vtt",
        "--convert-subs", "vtt",
        "-o", output_template,
        "--newline",  # progress on new lines
        url
    ]
    
    output_path = None
    
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding='utf-8', errors='replace'
    )
    
    for line in proc.stdout:
        line = line.strip()
        if line:
            print(f"[yt-dlp] {line}")
            # Parse download progress
            if "[download]" in line and "%" in line:
                try:
                    pct = float(re.search(r'(\d+\.?\d*)%', line).group(1))
                    if progress_callback:
                        progress_callback("downloading", pct)
                except Exception:
                    pass
            elif "[Merger]" in line or "Merging" in line:
                if progress_callback:
                    progress_callback("merging", 95)
    
    proc.wait()
    
    if proc.returncode != 0:
        raise RuntimeError("yt-dlp download failed")
    
    # Find the downloaded file
    for ext in ["mp4", "mkv", "webm", "avi"]:
        candidate = UPLOADS_DIR / f"{job_id}.{ext}"
        if candidate.exists():
            output_path = str(candidate)
            break
    
    if not output_path:
        raise FileNotFoundError("Downloaded video file not found")
    
    # Look for subtitle file
    sub_path = None
    for f in UPLOADS_DIR.iterdir():
        if f.stem.startswith(job_id) and f.suffix == ".vtt":
            sub_path = str(f)
            break
    
    return output_path, sub_path


# ─── Clip Export ──────────────────────────────────────────────────────────────

def export_clip(video_path, start, end, clip_id, subtitle_path=None,
                watermark_text=None, add_subtitles=True,
                progress_callback=None):
    """
    Export a single clip from the video in 9:16 Shorts format.
    - Crops/pads to 1080x1920 (9:16)
    - Burns subtitles if available
    - Adds watermark if specified
    
    Returns path to exported clip.
    """
    output_path = str(CLIPS_DIR / f"{clip_id}.mp4")
    duration = end - start
    
    # Build FFmpeg filter chain
    # 1. Scale to fit 1080 width, keeping aspect ratio
    # 2. Pad/crop to 1920 height (9:16)
    # 3. Add blurred background for letterboxed content
    
    vf_filters = []
    
    # Main clip processing: scale + pad to 9:16 with blurred background
    shorts_filter = (
        # Create blurred background
        "[0:v]scale=1080:-1,crop=1080:1920,boxblur=20:20[bg];"
        # Scale main video to fit width 1080, keep aspect
        "[0:v]scale=1080:-2[fg];"
        # Overlay main video centered on blurred background
        "[bg][fg]overlay=(W-w)/2:(H-h)/2[main]"
    )
    
    vf_complex = shorts_filter
    output_map = "[main]"
    
    # Add watermark if specified
    if watermark_text:
        vf_complex += (
            f";[main]drawtext=text='{watermark_text}':"
            "fontsize=36:fontcolor=white@0.7:"
            "x=w-tw-20:y=h-th-20:"
            "shadowcolor=black@0.5:shadowx=2:shadowy=2[watermarked]"
        )
        output_map = "[watermarked]"
    
    # Build FFmpeg command
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(start),
        "-i", video_path,
        "-t", str(duration),
        "-filter_complex", vf_complex,
        "-map", output_map,
        "-map", "0:a?",
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        "-r", "30",
        output_path
    ]
    
    print(f"[Clipper] Exporting clip: {start:.1f}s - {end:.1f}s → {clip_id}.mp4")
    
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding='utf-8', errors='replace'
    )
    
    # Parse FFmpeg progress
    time_pattern = re.compile(r'time=(\d+):(\d+):(\d+\.?\d*)')
    for line in proc.stdout:
        match = time_pattern.search(line)
        if match and progress_callback:
            h, m, s = float(match.group(1)), float(match.group(2)), float(match.group(3))
            current = h * 3600 + m * 60 + s
            pct = min(99, (current / duration) * 100)
            progress_callback(pct)
    
    proc.wait()
    
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg clip export failed for {clip_id}")
    
    if not os.path.exists(output_path):
        raise FileNotFoundError(f"Output clip not found: {output_path}")
    
    size_bytes = os.path.getsize(output_path)
    print(f"[Clipper] Clip saved: {output_path} ({_format_size(size_bytes)})")
    
    return output_path, size_bytes


def export_all_clips(video_path, moments, job_id, subtitle_path=None,
                     watermark_text=None, add_subtitles=True,
                     progress_callback=None):
    """
    Export all viral moment clips.
    Returns list of clip info dicts.
    """
    clips = []
    subtitle_text = ""
    
    # Read subtitle file
    if subtitle_path and os.path.exists(subtitle_path):
        try:
            with open(subtitle_path, 'r', encoding='utf-8') as f:
                subtitle_text = f.read()
        except Exception:
            pass
    
    total = len(moments)
    for i, moment in enumerate(moments):
        clip_id = f"{job_id}_clip{i + 1}"
        
        try:
            if progress_callback:
                progress_callback(
                    "exporting",
                    int((i / total) * 100),
                    f"Exporting clip {i + 1}/{total}..."
                )
            
            def clip_progress(pct):
                if progress_callback:
                    base = int((i / total) * 100)
                    progress = base + int((pct / 100) * (100 / total))
                    progress_callback("exporting", min(99, progress), f"Clip {i + 1}/{total}")
            
            clip_path, size_bytes = export_clip(
                video_path=video_path,
                start=moment['start'],
                end=moment['end'],
                clip_id=clip_id,
                subtitle_path=subtitle_path,
                watermark_text=watermark_text,
                add_subtitles=add_subtitles,
                progress_callback=clip_progress
            )
            
            clips.append({
                "id": clip_id,
                "index": i + 1,
                "label": moment.get('label', f"Clip {i + 1}"),
                "start": moment['start'],
                "end": moment['end'],
                "duration": moment['duration'],
                "score": moment.get('score', 0),
                "reason": moment.get('reason', ''),
                "path": clip_path,
                "filename": f"{clip_id}.mp4",
                "size_bytes": size_bytes,
                "size_str": _format_size(size_bytes),
                "status": "ready"
            })
        
        except Exception as e:
            print(f"[Clipper] Error exporting clip {i + 1}: {e}")
            clips.append({
                "id": clip_id,
                "index": i + 1,
                "label": moment.get('label', f"Clip {i + 1}"),
                "start": moment['start'],
                "end": moment['end'],
                "duration": moment['duration'],
                "score": moment.get('score', 0),
                "reason": moment.get('reason', ''),
                "status": "error",
                "error": str(e)
            })
    
    return clips


# ─── Cleanup ──────────────────────────────────────────────────────────────────

def cleanup_job(job_id):
    """Remove all files associated with a job (uploads, clips, job data)."""
    removed = []
    
    # Remove uploaded video
    for f in UPLOADS_DIR.iterdir():
        if f.stem.startswith(job_id):
            f.unlink(missing_ok=True)
            removed.append(str(f))
    
    # Remove clips
    for f in CLIPS_DIR.iterdir():
        if f.name.startswith(job_id):
            f.unlink(missing_ok=True)
            removed.append(str(f))
    
    # Remove job file
    job_file = JOBS_DIR / f"{job_id}.json"
    if job_file.exists():
        job_file.unlink()
        removed.append(str(job_file))
    
    return removed


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _format_duration(seconds):
    if not seconds:
        return "Unknown"
    h = int(seconds) // 3600
    m = (int(seconds) % 3600) // 60
    s = int(seconds) % 60
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def _format_views(count):
    if not count:
        return "0 views"
    if count >= 1_000_000:
        return f"{count / 1_000_000:.1f}M views"
    if count >= 1_000:
        return f"{count / 1_000:.1f}K views"
    return f"{count} views"


def _format_size(bytes_val):
    if bytes_val >= 1024 ** 3:
        return f"{bytes_val / 1024 ** 3:.1f} GB"
    if bytes_val >= 1024 ** 2:
        return f"{bytes_val / 1024 ** 2:.1f} MB"
    return f"{bytes_val / 1024:.1f} KB"
