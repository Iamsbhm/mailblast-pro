"""
ClipGenius - Viral Moment Analyzer
Analyzes YouTube videos to find the most engaging segments using:
- Audio energy peaks (loud/exciting moments)
- Speech density (rapid talking = high info density)
- Subtitle keyword frequency
"""

import subprocess
import json
import os
import re
import math
import tempfile
import struct
import wave


def analyze_audio_energy(video_path, sample_rate=100):
    """
    Extract audio energy over time using FFmpeg.
    Returns a list of (timestamp_seconds, energy) tuples.
    """
    energy_data = []
    
    try:
        # Extract audio as raw PCM using FFmpeg
        cmd = [
            "ffmpeg", "-i", video_path,
            "-vn",  # no video
            "-acodec", "pcm_s16le",
            "-ar", "8000",  # 8kHz sample rate (enough for energy analysis)
            "-ac", "1",  # mono
            "-f", "s16le",  # raw PCM
            "-",  # pipe to stdout
            "-loglevel", "quiet"
        ]
        
        result = subprocess.run(cmd, capture_output=True, timeout=120)
        if result.returncode != 0:
            return []
        
        raw_audio = result.stdout
        if not raw_audio:
            return []
        
        # Convert raw bytes to 16-bit signed integers
        n_samples = len(raw_audio) // 2
        samples = struct.unpack(f'{n_samples}h', raw_audio[:n_samples * 2])
        
        # Calculate RMS energy per window (1 second windows at 8kHz)
        window_size = 8000  # 1 second
        for i in range(0, len(samples) - window_size, window_size):
            window = samples[i:i + window_size]
            rms = math.sqrt(sum(s * s for s in window) / len(window))
            timestamp = i / 8000.0
            energy_data.append((timestamp, rms))
        
        return energy_data
    
    except (subprocess.TimeoutExpired, Exception) as e:
        print(f"Audio analysis error: {e}")
        return []


def analyze_subtitles(subtitle_text):
    """
    Analyze subtitle content to find content-dense segments.
    Returns a dict of {timestamp_seconds: word_density_score}
    """
    scores = {}
    
    if not subtitle_text:
        return scores
    
    # Parse WebVTT or SRT format
    lines = subtitle_text.split('\n')
    current_time = None
    word_count = 0
    
    time_pattern = re.compile(
        r'(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})'
    )
    
    # High-engagement keywords (boost score when found)
    viral_keywords = {
        'amazing', 'incredible', 'shocking', 'unbelievable', 'never', 'always',
        'secret', 'truth', 'exposed', 'revealed', 'breaking', 'exclusive',
        'watch', 'look', 'see', 'wow', 'omg', 'literally', 'actually',
        'insane', 'crazy', 'wild', 'mind', 'blown', 'wait', 'stop'
    }
    
    for line in lines:
        match = time_pattern.match(line.strip())
        if match:
            h, m, s = int(match.group(1)), int(match.group(2)), int(match.group(3))
            current_time = h * 3600 + m * 60 + s
            word_count = 0
        elif current_time is not None and line.strip() and not line.strip().isdigit():
            words = line.lower().split()
            word_count += len(words)
            # Boost for viral keywords
            keyword_bonus = sum(2 for w in words if w.strip('.,!?') in viral_keywords)
            bucket = int(current_time)
            scores[bucket] = scores.get(bucket, 0) + word_count + keyword_bonus
    
    return scores


def normalize_scores(scores_list):
    """Normalize a list of scores to 0-100 range."""
    if not scores_list:
        return []
    min_val = min(scores_list)
    max_val = max(scores_list)
    if max_val == min_val:
        return [50.0] * len(scores_list)
    return [(s - min_val) / (max_val - min_val) * 100 for s in scores_list]


def find_viral_moments(video_path, subtitle_text="", num_clips=4,
                       clip_min_duration=30, clip_max_duration=58,
                       video_duration=None):
    """
    Main function: finds the most viral moments in a video.
    
    Returns a list of dicts:
    [
        {
            'start': float,      # start time in seconds
            'end': float,        # end time in seconds
            'duration': float,   # clip duration
            'score': float,      # viral score 0-100
            'reason': str        # why this was picked
        },
        ...
    ]
    """
    print(f"[Analyzer] Analyzing video: {os.path.basename(video_path)}")
    
    # Get video duration if not provided
    if video_duration is None:
        try:
            probe_cmd = [
                "ffprobe", "-v", "quiet", "-print_format", "json",
                "-show_format", video_path
            ]
            probe_result = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=30)
            probe_data = json.loads(probe_result.stdout)
            video_duration = float(probe_data['format']['duration'])
        except Exception:
            video_duration = 600  # fallback 10 min
    
    print(f"[Analyzer] Video duration: {video_duration:.1f}s")
    
    # Step 1: Audio energy analysis
    print("[Analyzer] Extracting audio energy...")
    energy_data = analyze_audio_energy(video_path)
    
    # Step 2: Subtitle analysis
    print("[Analyzer] Analyzing subtitles...")
    subtitle_scores = analyze_subtitles(subtitle_text)
    
    # Step 3: Build combined score timeline
    max_time = int(video_duration)
    timeline = [0.0] * (max_time + 1)
    
    # Apply audio energy scores
    if energy_data:
        energy_values = [e for _, e in energy_data]
        norm_energy = normalize_scores(energy_values)
        for i, (timestamp, _) in enumerate(energy_data):
            t = int(timestamp)
            if t < len(timeline):
                timeline[t] += norm_energy[i] * 0.6  # 60% weight
    
    # Apply subtitle scores
    if subtitle_scores:
        sub_values = list(subtitle_scores.values())
        norm_sub = normalize_scores(sub_values)
        keys = list(subtitle_scores.keys())
        for i, t in enumerate(keys):
            if t < len(timeline):
                timeline[t] += norm_sub[i] * 0.4  # 40% weight
    
    # Smooth the timeline (moving average)
    window = 5
    smoothed = []
    for i in range(len(timeline)):
        start = max(0, i - window)
        end = min(len(timeline), i + window + 1)
        smoothed.append(sum(timeline[start:end]) / (end - start))
    
    # Step 4: Find top non-overlapping windows
    clip_duration = min(clip_max_duration, max(clip_min_duration, 45))  # default 45s
    clips = []
    used_ranges = []
    
    # Try different clip lengths for variety
    attempt_durations = [58, 45, 30]
    
    for target_dur in attempt_durations:
        if len(clips) >= num_clips:
            break
        
        # Find best windows of this duration
        best_windows = []
        for start in range(0, max_time - target_dur, 5):  # step every 5s
            end = start + target_dur
            if end > max_time:
                break
            
            # Skip intro (first 30s) and outro (last 30s)
            if start < 30 or end > max_time - 30:
                continue
            
            # Calculate average score for this window
            window_scores = smoothed[start:end]
            if not window_scores:
                continue
            avg_score = sum(window_scores) / len(window_scores)
            peak_score = max(window_scores)
            combined = avg_score * 0.5 + peak_score * 0.5
            
            best_windows.append((combined, start, end))
        
        best_windows.sort(reverse=True)
        
        for score, start, end in best_windows:
            if len(clips) >= num_clips:
                break
            
            # Check overlap with existing clips
            overlap = False
            for us, ue in used_ranges:
                if start < ue and end > us:
                    overlap = True
                    break
            
            if not overlap:
                clips.append({
                    'start': float(start),
                    'end': float(end),
                    'duration': float(end - start),
                    'score': round(min(100.0, score), 1),
                    'reason': _get_reason(score, energy_data, subtitle_scores, start, end)
                })
                used_ranges.append((start, end))
    
    # Sort by timestamp for logical ordering
    clips.sort(key=lambda x: x['start'])
    
    # Re-number and label
    for i, clip in enumerate(clips):
        clip['index'] = i + 1
        clip['label'] = f"Clip {i + 1} ({_format_time(clip['start'])} - {_format_time(clip['end'])})"
    
    print(f"[Analyzer] Found {len(clips)} viral moments")
    return clips


def _get_reason(score, energy_data, subtitle_scores, start, end):
    """Generate a human-readable reason for why this clip was selected."""
    reasons = []
    
    if score > 70:
        reasons.append("🔥 High energy segment")
    elif score > 40:
        reasons.append("⚡ Above average engagement")
    else:
        reasons.append("📈 Good pacing")
    
    # Check if audio energy is high in this segment
    if energy_data:
        segment_energy = [e for t, e in energy_data if start <= t <= end]
        if segment_energy:
            avg_e = sum(segment_energy) / len(segment_energy)
            all_avg = sum(e for _, e in energy_data) / len(energy_data)
            if avg_e > all_avg * 1.5:
                reasons.append("🎵 Loud/exciting audio")
    
    # Check subtitle density
    if subtitle_scores:
        seg_sub = sum(v for t, v in subtitle_scores.items() if start <= t <= end)
        if seg_sub > 0:
            reasons.append("💬 High speech density")
    
    return " · ".join(reasons) if reasons else "📊 Algorithmically selected"


def _format_time(seconds):
    """Format seconds to MM:SS string."""
    m = int(seconds) // 60
    s = int(seconds) % 60
    return f"{m:02d}:{s:02d}"
