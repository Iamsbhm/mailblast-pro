// ─── STATE ───────────────────────────────────────────────────
let recipients = [];
let sendResults = [];
let isSending = false;

// ─── SMTP PRESETS ─────────────────────────────────────────────
const PRESETS = {
  gmail:   { host: 'smtp.gmail.com',      port: '587' },
  outlook: { host: 'smtp-mail.outlook.com', port: '587' },
  yahoo:   { host: 'smtp.mail.yahoo.com', port: '587' },
  custom:  { host: '',                    port: '' },
};

function applyPreset(name) {
  const p = PRESETS[name];
  document.getElementById('smtpHost').value = p.host;
  document.getElementById('smtpPort').value = p.port;
}

function togglePass() {
  const el = document.getElementById('smtpPass');
  el.type = el.type === 'password' ? 'text' : 'password';
}

// ─── SECTION COLLAPSE ─────────────────────────────────────────
function toggleSection(bodyId, btnId) {
  const body = document.getElementById(bodyId);
  const btn  = document.getElementById(btnId);
  const isHidden = body.style.display === 'none';
  body.style.display = isHidden ? '' : 'none';
  btn.textContent = isHidden ? '▲' : '▼';
}

// ─── SMTP CONNECT ─────────────────────────────────────────────
async function connectSMTP() {
  const btn = document.getElementById('connectBtn');
  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span> Connecting...';

  const payload = {
    host: document.getElementById('smtpHost').value.trim(),
    port: document.getElementById('smtpPort').value.trim(),
    user: document.getElementById('smtpUser').value.trim(),
    pass: document.getElementById('smtpPass').value,
  };

  if (!payload.user || !payload.pass) {
    showToast('Please enter your email and password.', 'error');
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">🔌</span> Test & Connect';
    return;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000); // 15s client-side timeout

    const res = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await res.json();

    if (data.success) {
      setStatus(true);
      // Auto-fill from email
      document.getElementById('fromEmail').value = payload.user;
      showToast('✅ SMTP connected! Ready to send.', 'success');
      // Collapse SMTP section
      document.getElementById('smtpBody').style.display = 'none';
      document.getElementById('smtpToggle').textContent = '▼';
    } else {
      showToast('❌ ' + data.message, 'error');
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      showToast('❌ Connection timed out. Check your email, password and SMTP settings.', 'error');
    } else {
      showToast('❌ Connection failed: ' + e.message, 'error');
    }
  }

  btn.disabled = false;
  btn.innerHTML = '<span class="btn-icon">🔌</span> Test & Connect';
}

function setStatus(connected) {
  const dot  = document.querySelector('.badge-dot');
  const text = document.getElementById('statusText');
  dot.className = 'badge-dot ' + (connected ? 'connected' : 'disconnected');
  text.textContent = connected ? 'Connected' : 'Not Connected';
}

// ─── TABS ──────────────────────────────────────────────────────
function switchTab(name) {
  ['manual','csv'].forEach(t => {
    document.getElementById('tab-' + t).classList.toggle('active', t === name);
    document.getElementById('panel-' + t).style.display = t === name ? '' : 'none';
  });
}

// ─── RECIPIENTS ───────────────────────────────────────────────
function addEmail() {
  const emailEl = document.getElementById('newEmail');
  const nameEl  = document.getElementById('newName');
  const email   = emailEl.value.trim();
  const name    = nameEl.value.trim();

  if (!isValidEmail(email)) { showToast('Enter a valid email address.', 'error'); return; }
  if (recipients.find(r => r.email === email)) { showToast('Email already added.', 'info'); return; }

  recipients.push({ email, name });
  emailEl.value = '';
  nameEl.value  = '';
  renderList();
  updateSummary();
}

function importPaste() {
  const raw = document.getElementById('bulkPaste').value;
  const lines = raw.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
  let added = 0;
  lines.forEach(line => {
    // handle "Name <email>" format
    const match = line.match(/<(.+?)>/);
    const email = match ? match[1] : line;
    const name  = match ? line.split('<')[0].trim() : '';
    if (isValidEmail(email) && !recipients.find(r => r.email === email)) {
      recipients.push({ email, name });
      added++;
    }
  });
  document.getElementById('bulkPaste').value = '';
  renderList();
  updateSummary();
  showToast(`✅ Added ${added} email(s).`, 'success');
}

function removeEmail(email) {
  recipients = recipients.filter(r => r.email !== email);
  renderList();
  updateSummary();
}

function clearAll() {
  if (!confirm('Clear all recipients?')) return;
  recipients = [];
  renderList();
  updateSummary();
}

function renderList() {
  const wrap = document.getElementById('emailListWrap');
  const list = document.getElementById('emailList');
  const countEl = document.getElementById('listCount');
  const badgeEl = document.getElementById('recipientCount');

  badgeEl.textContent = recipients.length + ' contact' + (recipients.length !== 1 ? 's' : '');

  if (recipients.length === 0) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  countEl.textContent = recipients.length + ' recipient' + (recipients.length !== 1 ? 's' : '');

  list.innerHTML = recipients.map((r, i) => `
    <div class="email-item" id="eitem-${i}">
      <div class="email-item-info">
        <span class="email-item-addr">${escHtml(r.email)}</span>
        ${r.name ? `<span class="email-item-name">${escHtml(r.name)}</span>` : ''}
      </div>
      <button class="email-item-remove" onclick="removeEmail('${escHtml(r.email)}')" title="Remove">✕</button>
    </div>
  `).join('');
}

// ─── CSV UPLOAD ───────────────────────────────────────────────
function handleDrop(e) {
  e.preventDefault();
  document.getElementById('dropZone').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) uploadCSV(file);
}

async function uploadCSV(file) {
  if (!file) return;
  const formData = new FormData();
  formData.append('csv', file);

  try {
    const res  = await fetch('/api/parse-csv', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.success) {
      let added = 0;
      data.emails.forEach(({ email, name }) => {
        if (!recipients.find(r => r.email === email)) {
          recipients.push({ email, name });
          added++;
        }
      });
      renderList();
      updateSummary();
      showToast(`✅ Imported ${added} email(s) from CSV.`, 'success');
    } else {
      showToast('❌ ' + data.message, 'error');
    }
  } catch (e) {
    showToast('❌ CSV import failed.', 'error');
  }
}

// ─── COMPOSE HELPERS ──────────────────────────────────────────
function insertTag(tag) {
  const el = document.getElementById('emailBody');
  const start = el.selectionStart;
  const end   = el.selectionEnd;
  el.value = el.value.slice(0, start) + tag + el.value.slice(end);
  el.selectionStart = el.selectionEnd = start + tag.length;
  el.focus();
}

function toggleHtml() {
  const isHtml = document.getElementById('htmlToggle').checked;
  document.getElementById('emailBody').placeholder = isHtml
    ? '<p>Hi <strong>{{name}}</strong>,</p>\n<p>Your message here...</p>'
    : 'Hi {{name}},\n\nYour message here...';
}

// ─── SUMMARY ─────────────────────────────────────────────────
function updateSummary() {
  document.getElementById('sumRecipients').textContent = recipients.length;
  const subject = document.getElementById('subject').value;
  const subEl   = document.getElementById('sumSubject');
  subEl.textContent = subject ? (subject.length > 20 ? subject.slice(0, 20) + '…' : subject) : '—';
  subEl.title = subject;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('subject').addEventListener('input', updateSummary);
  applyPreset('gmail');
});

// ─── SEND EMAILS ──────────────────────────────────────────────
async function sendEmails() {
  if (isSending) return;

  const from     = document.getElementById('fromEmail').value.trim();
  const fromName = document.getElementById('fromName').value.trim();
  const subject  = document.getElementById('subject').value.trim();
  const body     = document.getElementById('emailBody').value.trim();
  const isHtml   = document.getElementById('htmlToggle').checked;
  const delay    = parseInt(document.getElementById('sendDelay').value) || 500;

  if (!from) { showToast('Enter your sender email.', 'error'); return; }
  if (!subject) { showToast('Enter a subject line.', 'error'); return; }
  if (!body) { showToast('Email body is empty.', 'error'); return; }
  if (recipients.length === 0) { showToast('Add at least one recipient.', 'error'); return; }

  isSending = true;
  sendResults = [];

  const btn = document.getElementById('sendBtn');
  btn.disabled = true;
  document.getElementById('sendBtnText').textContent = 'Sending...';
  document.getElementById('sendBtnIcon').textContent = '⏳';

  document.getElementById('progressWrap').style.display = '';
  document.getElementById('liveFeed').style.display = '';
  document.getElementById('resultsWrap').style.display = 'none';
  document.getElementById('feedList').innerHTML = '';
  document.getElementById('sumStatus').textContent = 'Sending…';

  const total = recipients.length;
  let sent = 0, failed = 0;

  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, fromName, recipients, subject, body, isHtml, delay }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6));

        if (event.type === 'progress') {
          sent = event.sent; failed = event.failed;
          const pct = Math.round(((sent + failed) / total) * 100);
          document.getElementById('progressBar').style.width = pct + '%';
          document.getElementById('progressText').textContent = `Sending ${sent + failed} of ${total}...`;
          document.getElementById('progressPct').textContent = pct + '%';
          addFeedItem(event.email, event.status, event.error);
          sendResults.push({ email: event.email, status: event.status, error: event.error || '' });
        }

        if (event.type === 'done') {
          sent = event.sent; failed = event.failed;
          document.getElementById('progressBar').style.width = '100%';
          document.getElementById('progressText').textContent = 'Done!';
          document.getElementById('progressPct').textContent = '100%';
          document.getElementById('resSent').textContent    = sent;
          document.getElementById('resFailed').textContent  = failed;
          document.getElementById('resTotal').textContent   = total;
          document.getElementById('resultsWrap').style.display = '';
          document.getElementById('sumStatus').textContent  = '✅ Done';
          showToast(`Campaign complete! ✅ ${sent} sent, ❌ ${failed} failed.`, 'success');
        }
      }
    }
  } catch (e) {
    showToast('❌ Send error: ' + e.message, 'error');
  }

  isSending = false;
  btn.disabled = false;
  document.getElementById('sendBtnText').textContent = 'Send Again';
  document.getElementById('sendBtnIcon').textContent = '🔁';
}

function addFeedItem(email, status, error) {
  const list = document.getElementById('feedList');
  const item = document.createElement('div');
  item.className = 'feed-item ' + status;
  item.innerHTML = `
    <div class="feed-dot"></div>
    <span>${escHtml(email)}</span>
    ${error ? `<span style="color:var(--red);font-size:0.75rem;margin-left:auto">${escHtml(error)}</span>` : ''}
  `;
  list.prepend(item);
}

// ─── DOWNLOAD REPORT ─────────────────────────────────────────
function downloadReport() {
  const rows = [['Email', 'Status', 'Error'], ...sendResults.map(r => [r.email, r.status, r.error || ''])];
  const csv  = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'mailblast-report.csv'; a.click();
  URL.revokeObjectURL(url);
}

// ─── UTILS ───────────────────────────────────────────────────
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

let toastTimer;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  clearTimeout(toastTimer);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('show'));
  });
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}
