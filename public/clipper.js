/**
 * ClipGenius — Frontend JavaScript
 * Handles UI interactions, API calls, polling, downloads.
 */

// API base URL:
// - In production (Vercel): set by the <script> tag in clipper.html via window.CLIPGENIUS_API
// - In local dev: falls back to localhost:5000
const API_BASE = (window.CLIPGENIUS_API || 'http://localhost:5000').replace(/\/$/, '');

// ─── State ─────────────────────────────────────────────────────────────────
let currentJobId = null;
let pollInterval = null;
let currentVideoInfo = null;

// ─── DOM References ─────────────────────────────────────────────────────────
const urlInput        = document.getElementById('url-input');
const btnFetch        = document.getElementById('btn-fetch');
const videoPreview    = document.getElementById('video-preview');
const previewThumb    = document.getElementById('preview-thumb');
const previewTitle    = document.getElementById('preview-title');
const previewChannel  = document.getElementById('preview-channel');
const previewDuration = document.getElementById('preview-duration');
const previewViews    = document.getElementById('preview-views');
const btnGenerate     = document.getElementById('btn-generate');
const btnBatch        = document.getElementById('btn-batch-toggle');

const heroSection         = document.getElementById('input-section').closest('.hero');
const processingSection   = document.getElementById('processing-section');
const resultsSection      = document.getElementById('results-section');

const processingTitle  = document.getElementById('processing-title');
const processingPhase  = document.getElementById('processing-phase');
const progressFill     = document.getElementById('progress-fill');
const progressGlow     = document.getElementById('progress-glow');
const progressPct      = document.getElementById('progress-pct');
const btnCancel        = document.getElementById('btn-cancel');

const clipsGrid      = document.getElementById('clips-grid');
const resultSubtitle = document.getElementById('results-subtitle');
const btnDownloadAll = document.getElementById('btn-download-all');
const btnNewVideo    = document.getElementById('btn-new-video');


// ─── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkAPIHealth();
  setupEventListeners();

  // Auto-detect paste
  urlInput.addEventListener('paste', () => {
    setTimeout(handleUrlChange, 100);
  });
});

function setupEventListeners() {
  btnFetch.addEventListener('click', handleFetch);
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleFetch();
  });
  btnGenerate.addEventListener('click', handleGenerate);
  btnCancel.addEventListener('click', handleCancel);
  btnNewVideo.addEventListener('click', resetToHome);
  btnDownloadAll.addEventListener('click', downloadAllClips);
}

// ─── API Health Check ────────────────────────────────────────────────────────
async function checkAPIHealth() {
  try {
    const resp = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      console.log('✅ ClipGenius API is online');
    }
  } catch {
    showToast('⚠️ Python API not running. Run setup.bat first!', 'error', 6000);
  }
}

// ─── URL Fetch ───────────────────────────────────────────────────────────────
async function handleFetch() {
  const url = urlInput.value.trim();
  if (!url) {
    showToast('Please paste a YouTube URL first', 'error');
    urlInput.focus();
    return;
  }

  if (!isYouTubeUrl(url)) {
    showToast('Please enter a valid YouTube URL', 'error');
    return;
  }

  setBtnLoading(btnFetch, true);
  videoPreview.style.display = 'none';

  try {
    const resp = await fetch(`${API_BASE}/api/video-info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(30000)
    });

    const data = await resp.json();

    if (!resp.ok || !data.success) {
      throw new Error(data.error || 'Failed to fetch video info');
    }

    currentVideoInfo = data.video;
    displayVideoPreview(data.video);
    btnBatch.style.display = 'block';
    showToast('✅ Video found! Configure your clips below.', 'success');

  } catch (err) {
    showToast(`❌ ${err.message || 'Could not fetch video info'}`, 'error', 5000);
  } finally {
    setBtnLoading(btnFetch, false);
  }
}

function handleUrlChange() {
  const url = urlInput.value.trim();
  if (isYouTubeUrl(url)) {
    // Auto-fetch after paste
    handleFetch();
  }
}

function displayVideoPreview(video) {
  previewThumb.src = video.thumbnail || '';
  previewThumb.alt = video.title;
  previewTitle.textContent = video.title;
  previewChannel.textContent = `📺 ${video.channel}`;
  previewDuration.textContent = `⏱ ${video.duration_str}`;
  previewViews.textContent = `👁 ${video.view_count_str}`;

  videoPreview.style.display = 'flex';
  videoPreview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ─── Generate Clips ──────────────────────────────────────────────────────────
async function handleGenerate() {
  const url = urlInput.value.trim();
  if (!url) {
    showToast('Please enter a YouTube URL first', 'error');
    return;
  }
  if (!currentVideoInfo) {
    // Try fetching info first
    await handleFetch();
    if (!currentVideoInfo) return;
  }

  const options = {
    url,
    num_clips: parseInt(document.getElementById('opt-num-clips').value),
    max_duration: parseInt(document.getElementById('opt-clip-length').value),
    min_duration: 30,
    add_subtitles: document.getElementById('opt-subtitles').checked,
    watermark_text: document.getElementById('opt-watermark').value.trim()
  };

  try {
    setBtnLoading(btnGenerate, true);
    btnGenerate.querySelector('span').textContent = '🚀 Starting...';

    const resp = await fetch(`${API_BASE}/api/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(30000)
    });

    const data = await resp.json();

    if (!resp.ok || !data.success) {
      throw new Error(data.error || 'Failed to start processing');
    }

    currentJobId = data.job_id;
    showProcessingSection(data.video);
    startPolling(currentJobId);

  } catch (err) {
    showToast(`❌ ${err.message}`, 'error', 5000);
    setBtnLoading(btnGenerate, false);
    btnGenerate.querySelector('span').textContent = '✨ Generate Shorts';
  }
}

// ─── Processing UI ───────────────────────────────────────────────────────────
function showProcessingSection(video) {
  heroSection.style.display = 'none';
  processingSection.style.display = 'block';
  resultsSection.style.display = 'none';
  processingTitle.textContent = `Processing: ${truncate(video?.title || 'Your video', 50)}`;
  processingSection.scrollIntoView({ behavior: 'smooth' });
  resetSteps();
}

function resetSteps() {
  ['download', 'analyze', 'export', 'ready'].forEach(s => {
    const el = document.getElementById(`step-${s}`);
    el.className = 'step';
    document.getElementById(`step-${s}-status`).textContent = 'waiting';
  });
}

function updateProgress(pct, phase, status) {
  const p = Math.max(0, Math.min(100, pct));
  progressFill.style.width = `${p}%`;
  progressGlow.style.left = `${p}%`;
  progressPct.textContent = `${Math.round(p)}%`;
  if (phase) processingPhase.textContent = phase;

  // Update step indicators
  if (status === 'downloading') {
    setStepActive('download');
  } else if (status === 'analyzing') {
    setStepDone('download');
    setStepActive('analyze');
  } else if (status === 'exporting') {
    setStepDone('download');
    setStepDone('analyze');
    setStepActive('export');
  } else if (status === 'complete') {
    setStepDone('download');
    setStepDone('analyze');
    setStepDone('export');
    setStepDone('ready');
  }
}

function setStepActive(name) {
  const el = document.getElementById(`step-${name}`);
  el.className = 'step active';
  document.getElementById(`step-${name}-status`).textContent = 'active';
}

function setStepDone(name) {
  const el = document.getElementById(`step-${name}`);
  el.className = 'step done';
  document.getElementById(`step-${name}-status`).textContent = '✓ done';
}

// ─── Polling ─────────────────────────────────────────────────────────────────
function startPolling(jobId) {
  if (pollInterval) clearInterval(pollInterval);

  pollInterval = setInterval(async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/job/${jobId}`, {
        signal: AbortSignal.timeout(10000)
      });

      if (!resp.ok) return;
      const job = await resp.json();

      updateProgress(job.progress || 0, job.phase, job.status);

      if (job.status === 'complete') {
        clearInterval(pollInterval);
        pollInterval = null;
        setTimeout(() => showResults(job), 600);
      } else if (job.status === 'error') {
        clearInterval(pollInterval);
        pollInterval = null;
        showError(job.error || 'Processing failed');
      }

    } catch (err) {
      console.warn('Polling error:', err.message);
    }
  }, 1500);
}

function handleCancel() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (currentJobId) {
    fetch(`${API_BASE}/api/cleanup/${currentJobId}`, { method: 'DELETE' }).catch(() => {});
    currentJobId = null;
  }
  resetToHome();
  showToast('Processing cancelled', 'error');
}

// ─── Results ─────────────────────────────────────────────────────────────────
function showResults(job) {
  processingSection.style.display = 'none';
  resultsSection.style.display = 'block';
  resultsSection.scrollIntoView({ behavior: 'smooth' });

  const clips = job.clips || [];
  const readyClips = clips.filter(c => c.status === 'ready');

  resultSubtitle.textContent = `${readyClips.length} viral clip${readyClips.length !== 1 ? 's' : ''} generated`;
  clipsGrid.innerHTML = '';

  clips.forEach((clip, idx) => {
    const card = createClipCard(clip, idx);
    clipsGrid.appendChild(card);
  });

  showToast(`🎉 ${readyClips.length} clips ready!`, 'success', 4000);
}

function createClipCard(clip, idx) {
  const card = document.createElement('div');
  card.className = 'clip-card';
  card.style.animationDelay = `${idx * 0.1}s`;

  const durationStr = formatSeconds(clip.duration);
  const isReady = clip.status === 'ready';
  const score = Math.round(clip.score || 0);

  card.innerHTML = `
    <div class="clip-preview">
      <div class="clip-placeholder">
        <div class="clip-placeholder-icon">🎬</div>
        <div class="clip-placeholder-text">Shorts · ${durationStr}</div>
      </div>
      ${score > 0 ? `<div class="clip-score-badge">🔥 ${score}/100</div>` : ''}
    </div>
    <div class="clip-info">
      <div class="clip-label">Clip ${clip.index} — ${formatSeconds(clip.start)} → ${formatSeconds(clip.end)}</div>
      <div class="clip-reason">${clip.reason || ''}</div>
      <div class="clip-meta-row">
        <span class="clip-duration">⏱ ${durationStr}</span>
        ${isReady && clip.size_str ? `<span class="clip-size">${clip.size_str}</span>` : ''}
      </div>
      ${isReady
        ? `<a href="${API_BASE}${clip.download_url}" class="btn-download-clip" download="clip${clip.index}.mp4" id="download-btn-${clip.id}">
             ⬇ Download Clip ${clip.index}
           </a>`
        : `<div class="clip-error">❌ ${clip.error || 'Failed to generate'}</div>`
      }
    </div>
  `;

  return card;
}

function downloadAllClips() {
  const links = document.querySelectorAll('.btn-download-clip');
  if (!links.length) return;

  links.forEach((link, i) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = link.href;
      a.download = link.download;
      a.click();
    }, i * 800);
  });

  showToast(`⬇ Downloading ${links.length} clips...`, 'success');
}

// ─── Error State ─────────────────────────────────────────────────────────────
function showError(message) {
  processingTitle.textContent = '❌ Something went wrong';
  processingPhase.textContent = message;
  showToast(`Error: ${message}`, 'error', 7000);

  setTimeout(() => {
    resetToHome();
  }, 5000);
}

// ─── Reset ───────────────────────────────────────────────────────────────────
function resetToHome() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  heroSection.style.display = 'block';
  processingSection.style.display = 'none';
  resultsSection.style.display = 'none';
  videoPreview.style.display = 'none';
  btnBatch.style.display = 'none';
  urlInput.value = '';
  currentVideoInfo = null;
  currentJobId = null;
  setBtnLoading(btnFetch, false);
  setBtnLoading(btnGenerate, false);
  btnGenerate.querySelector('span').textContent = '✨ Generate Shorts';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function isYouTubeUrl(url) {
  return /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/live\/)/.test(url);
}

function formatSeconds(totalSec) {
  const s = Math.round(totalSec || 0);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}

function setBtnLoading(btn, loading) {
  if (loading) {
    btn.disabled = true;
    btn.classList.add('loading');
  } else {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

let toastTimeout;
function showToast(message, type = 'info', duration = 3500) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.className = 'toast';
  }, duration);
}
