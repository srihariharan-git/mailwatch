import express from 'express';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, missingEnv } from './config.js';
import { MailWatcher } from './mail-watcher.js';
import { summarizeEmail } from './summarizer.js';
import { sendDesktopNotification } from './desktop-notify.js';
import { validateImap, validateGemini, writeEnv, ensureTask } from './setup.js';

// When run as a background service there is no console, so record all output
// to mailwatch.log for diagnostics.
const logStream = createWriteStream(path.join(process.cwd(), 'mailwatch.log'), { flags: 'a' });
logStream.on('error', () => {});
process.stdout.write = process.stderr.write = (chunk, encoding, cb) =>
  logStream.write(chunk, encoding, cb);

// A transient network/DNS blip (sleep, VPN, wifi) must never kill the daemon.
// Log and keep going; the poll loop retries on its own.
process.on('uncaughtException', (err) => {
  console.error('[caught]', err?.message || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[caught]', err?.message || err);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ALERTS_FILE = path.join(process.cwd(), 'alerts.json');
const MAX_ALERTS = 50;

function loadAlerts() {
  try {
    const arr = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveAlerts() {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts.slice(0, MAX_ALERTS), null, 2));
}

const alerts = loadAlerts();
const watcher = new MailWatcher(config);
watcher.on('error', (err) => console.error('[watcher]', err.message));
watcher.on('checked', ({ lastUid }) => console.log(`[watcher] poll ok (position ${lastUid})`));

watcher.on('mail', async (alert) => {
  // Guard against the time-window re-evaluating a message we already alerted
  // (e.g. out-of-order UIDs) — each message alerts exactly once across restarts.
  if (alerts.some((a) => a.id === alert.id)) return;

  const record = { ...alert, summary: null, summaryError: null, state: 'summarizing' };
  alerts.unshift(record);
  saveAlerts();
  broadcast('mail', { id: record.id });

  try {
    const result = await summarizeEmail(config, alert);
    record.summary = result.ok ? result.summary : null;
    record.summaryError = result.ok ? null : result.error;
    record.state = record.summary ? 'done' : (record.summaryError ? 'error' : 'done');
  } catch (err) {
    record.summaryError = err.message;
    record.state = 'error';
  }
  saveAlerts();
  broadcast('summary', { id: record.id, summary: record.summary, error: record.summaryError });

  sendDesktopNotification({
    title: `Mail from ${alert.from}`,
    body: record.summary || record.subject || 'New mail from a watched sender.',
  });
});

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

app.get('/api/status', (req, res) => {
  res.json({
    watchedUser: config.gmailUser,
    watchSenders: config.watchSenders,
    pollIntervalSeconds: config.pollIntervalSeconds,
    geminiConfigured: Boolean(config.geminiApiKey),
    geminiModel: config.geminiModel,
    missingEnv: missingEnv(config),
    alertsCount: alerts.length,
  });
});

// Sanitized snapshot of the config for pre-filling the setup form.
// Never exposes the password or API key.
app.get('/api/setup', (req, res) => {
  res.json({
    gmailUser: config.gmailUser,
    imapHost: config.imapHost,
    imapPort: config.imapPort,
    watchSenders: config.watchSenders,
    geminiModel: config.geminiModel,
    pollIntervalSeconds: config.pollIntervalSeconds,
    hasAppPassword: Boolean(config.gmailAppPassword),
    hasGeminiKey: Boolean(config.geminiApiKey),
    missingEnv: missingEnv(config),
  });
});

// First-run wizard: validate credentials, save .env, (re)register the
// background task, then restart the server so it picks everything up.
app.post('/api/setup', async (req, res) => {
  const s = req.body || {};
  const gmailUser = String(s.gmailUser || '').trim();
  const gmailAppPassword = String(s.gmailAppPassword || '').trim();
  const geminiApiKey = String(s.geminiApiKey || '').trim();
  const imapHost = String(s.imapHost || 'imap.gmail.com').trim();
  const imapPort = Number(s.imapPort || 993);
  const geminiModel = String(s.geminiModel || 'gemini-2.5-flash').trim();
  const pollIntervalSeconds = Math.max(15, Number(s.pollIntervalSeconds || 30));
  const watchSenders = String(s.watchSenders || '')
    .split(/[\n,]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  try {
    if (!gmailUser || !gmailAppPassword) {
      return res.status(400).json({ error: 'Email and app password are required.' });
    }
    if (!watchSenders.length) {
      return res.status(400).json({ error: 'Add at least one watched sender (or a @domain).' });
    }

    const imapCheck = await validateImap({ gmailUser, gmailAppPassword, imapHost, imapPort });
    if (!imapCheck.ok) return res.status(400).json({ error: imapCheck.error });

    if (geminiApiKey) {
      const geminiCheck = await validateGemini(geminiApiKey, geminiModel);
      if (!geminiCheck.ok) return res.status(400).json({ error: geminiCheck.error });
    }

    writeEnv({
      gmailUser,
      gmailAppPassword,
      geminiApiKey,
      imapHost,
      imapPort,
      geminiModel,
      watchSenders,
      pollIntervalSeconds,
      port: Number(s.port || 3000),
    });

    const task = await ensureTask();
    console.log(`[setup] saved .env, task: ${task.ok ? 'OK' : task.error}`);

    res.json({ ok: true, restarting: Boolean(s.restart) });

    if (s.restart) {
      setTimeout(() => process.exit(0), 1500);
    }
  } catch (err) {
    console.error('[setup]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/alerts', (req, res) => {
  // Drop the raw email snippet from the response: it's only needed for
  // summarisation, and keeping it out saves a lot of data per request.
  const slim = alerts.slice(0, 50).map(({ snippet, ...rest }) => rest);
  res.json(slim);
});

// Demands a completely fresh check of the mailbox right now.
app.post('/api/poll', async (req, res) => {
  try {
    const result = await watcher.checkNow();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Emits a fake alert so you can verify browser notifications end-to-end.
app.post('/api/test', (req, res) => {
  const alert = {
    id: `test-${Date.now()}`,
    uid: 0,
    from: 'test@example.com',
    subject: 'Test notification from MailWatch',
    date: new Date().toISOString(),
    snippet: 'This is a demo alert to verify browser notifications are working.',
    receivedAt: Date.now(),
  };
  watcher.emit('mail', alert);
  res.json({ ok: true });
});

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 5000\n\n');
  clients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
      clients.delete(res);
      res.end();
    }
  }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

const missing = missingEnv(config);
console.log('Missing env vars:', missing.length ? missing.join(', ') : 'none');

app.listen(config.port, () => {
  console.log(`MailWatch running at http://localhost:${config.port}`);
});

watcher.start();

function shutdown() {
  watcher.stop();
  for (const res of clients) res.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);