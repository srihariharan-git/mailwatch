const alertsEl = document.getElementById('alerts');
const connDot = document.getElementById('conn-dot');
const connText = document.getElementById('conn-text');
const watchUserEl = document.getElementById('watch-user');
const watchSendersEl = document.getElementById('watch-senders');
const lastCheckEl = document.getElementById('last-check');

let alertsById = new Map();

function setConn(state) {
  connDot.dataset.state = state;
  connText.textContent =
    state === 'connected' ? 'connected — listening for mail' :
    state === 'disconnected' ? 'connection lost — retrying…' :
    'connecting to server…';
}

async function init() {
  await loadStatus();
  await loadAlerts();
  startEvents();
  document.getElementById('btn-test').addEventListener('click', testNotification);
  document.getElementById('btn-poll').addEventListener('click', checkNow);
  bindSetup();
}

async function loadStatus() {
  const res = await fetch('/api/status');
  const status = await res.json();
  setConn('connected');
  watchUserEl.textContent = status.watchedUser || 'not configured';
  watchSendersEl.innerHTML = '';
  for (const s of status.watchSenders) {
    const li = document.createElement('li');
    li.textContent = s;
    watchSendersEl.appendChild(li);
  }
  if (status.watchSenders.length) {
    const li = document.createElement('li');
    li.textContent = '…any other sender = ignored';
    watchSendersEl.appendChild(li);
  }
  if (status.missingEnv.length) {
    connText.textContent = 'setup incomplete — open the Setup panel';
    openSetup();
  }
}

function openSetup() {
  const panel = document.getElementById('setup-panel');
  panel.classList.remove('hidden');
  prefillSetupForm();
}

function bindSetup() {
  const btnSetup = document.getElementById('btn-setup');
  const panel = document.getElementById('setup-panel');
  const form = document.getElementById('setup-form');

  btnSetup.addEventListener('click', () => {
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) prefillSetupForm();
  });
  document.getElementById('btn-setup-cancel').addEventListener('click', () => panel.classList.add('hidden'));
  btnSetup.classList.remove('hidden');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setSetupMsg('Testing Gmail credentials…', false);
    const payload = {
      gmailUser: document.getElementById('s-user').value.trim(),
      gmailAppPassword: document.getElementById('s-pass').value.trim(),
      watchSenders: document.getElementById('s-senders').value.trim(),
      geminiApiKey: document.getElementById('s-gemini').value.trim(),
      imapHost: document.getElementById('s-host').value.trim(),
      imapPort: Number(document.getElementById('s-port').value),
      pollIntervalSeconds: Number(document.getElementById('s-poll').value),
      restart: true,
    };
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Setup failed');
      setSetupMsg('Saved! Restarting the background service…', true);
      form.querySelectorAll('input,textarea,button').forEach((el) => (el.disabled = true));
      setTimeout(() => location.reload(), 3500);
    } catch (err) {
      setSetupMsg(err.message, true);
    }
  });
}

async function prefillSetupForm() {
  try {
    const res = await fetch('/api/setup');
    const s = await res.json();
    if (s.gmailUser) document.getElementById('s-user').value = s.gmailUser;
    if (s.imapHost) document.getElementById('s-host').value = s.imapHost;
    if (s.imapPort) document.getElementById('s-port').value = s.imapPort;
    if (s.watchSenders && s.watchSenders.length) {
      document.getElementById('s-senders').value = s.watchSenders.join('\n');
    }
  } catch {
    // ignore — the form keeps its defaults
  }
}

function setSetupMsg(text, isError) {
  const el = document.getElementById('setup-msg');
  el.textContent = text;
  el.className = isError ? 'setup-msg error' : 'setup-msg';
}

async function loadAlerts() {
  const res = await fetch('/api/alerts');
  const alerts = await res.json();
  alertsById = new Map();
  alertsEl.innerHTML = '';
  for (const a of alerts) upsertAlert(a, false);
  if (!alerts.length) {
    alertsEl.innerHTML = '<li class="empty">No alerts yet. As soon as a watched sender emails you, it shows up here.</li>';
  }
}

function startEvents() {
  const ev = new EventSource('/events');
  ev.onopen = () => setConn('connected');
  ev.onerror = () => setConn('disconnected');

  ev.addEventListener('mail', (e) => {
    const { id } = JSON.parse(e.data);
    const existing = alertsById.get(id);
    if (existing && existing.state === 'done') return;
    upsertAlert({
      id,
      subject: existing?.subject || '(new mail from a watched sender)',
      summary: null,
      state: 'summarizing',
    }, true);
  });

  ev.addEventListener('summary', (e) => {
    const data = JSON.parse(e.data);
    const existing = alertsById.get(data.id);
    if (!existing) return;
    existing.state = data.error ? 'error' : 'done';
    existing.summary = data.summary;
    existing.summaryError = data.error;
    renderAlert(existing, false);
  });
}

function upsertAlert(alert, animate) {
  const existing = alertsById.get(alert.id);
  const merged = existing ? { ...existing, ...alert } : alert;
  alertsById.set(merged.id, merged);
  renderAlert(merged, animate);
}

function renderAlert(alert, animate) {
  let li = document.getElementById('alert-' + cssEscape(alert.id));
  if (!li) {
    li = document.createElement('li');
    li.className = 'alert' + (animate ? ' new' : '');
    li.id = 'alert-' + cssEscape(alert.id);
    alertsEl.prepend(li);
  }
  const time = alert.receivedAt ? new Date(alert.receivedAt).toLocaleString() : '';
  const from = alert.from || 'watched sender';
  const subject = alert.subject || '(no subject)';

  let summaryHtml;
  if (alert.state === 'summarizing') {
    summaryHtml = '<div class="alert-summary state-summarizing">Gemini is summarizing…</div>';
  } else if (alert.state === 'error' || alert.summaryError) {
    summaryHtml = `<div class="alert-summary state-error">Summary unavailable: ${escapeHtml(alert.summaryError || 'error')}</div>`;
  } else {
    summaryHtml = `<div class="alert-summary">${escapeHtml(alert.summary || '')}</div>`;
  }

  li.innerHTML = `
    <div class="alert-meta">
      <span>${escapeHtml(from)}</span>
      <span>${escapeHtml(time)}</span>
    </div>
    <div class="alert-subject">${escapeHtml(subject)}</div>
    ${summaryHtml}
  `;
}

async function testNotification() {
  await fetch('/api/test', { method: 'POST' });
}

async function checkNow() {
  lastCheckEl.textContent = 'checking mailbox…';
  try {
    const res = await fetch('/api/poll', { method: 'POST' });
    const result = await res.json();
    let msg = 'checked';
    if (result.skipped) msg = 'already checking…';
    if (result.found) msg += ` — ${result.found} new message(s)`;
    if (result.error) msg = `check failed: ${result.error}`;
    lastCheckEl.textContent = `Last check: ${new Date().toLocaleTimeString()} (${msg})`;
  } catch (err) {
    lastCheckEl.textContent = 'check failed: ' + err.message;
  }
}

function cssEscape(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '-');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

init();