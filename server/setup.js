import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ImapFlow } from 'imapflow';
import { GoogleGenAI } from '@google/genai';

const execFileAsync = promisify(execFile);
const PROJECT_DIR = process.cwd();
const ENV_FILE = path.join(PROJECT_DIR, '.env');
const SCRIPTS_DIR = path.join(PROJECT_DIR, 'scripts');
const VBS_FILE = path.join(SCRIPTS_DIR, 'run-server-hidden.vbs');
const TASK_NAME = 'MailWatch';

export async function validateImap({ gmailUser, gmailAppPassword, imapHost, imapPort }) {
  const client = new ImapFlow({
    host: imapHost,
    port: Number(imapPort),
    secure: true,
    auth: { user: gmailUser, pass: gmailAppPassword },
    logger: false,
    connectionTimeout: 12000,
    greetingTimeout: 12000,
  });
  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    await client.logout();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeImapError(err) };
  }
}

function describeImapError(err) {
  const code = err?.code || '';
  const msg = String(err?.message || '').replace(/^Command failed:\s*/i, '');
  if (code === 'authenticationFailure' || /FAILED|AUTHENTICAT|LOGIN/i.test(msg) || /^Command failed$/i.test(msg)) {
    return 'Gmail rejected the login. Check the app password (16 characters, not your normal password) and the GMAIL_USER spelling.';
  }
  if (code === 'connectionTimeout' || /timed? *out|ETIMEDOUT/i.test(msg)) {
    return 'Could not reach the IMAP server in time. Check the host/port or your internet.';
  }
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return 'Could not resolve the IMAP server address — check the host name or internet.';
  if (/ECONNREFUSED|ECONNRESET/i.test(msg)) return 'Could not connect to the IMAP server — check the host/port.';
  return msg || String(err);
}

export async function validateGemini(apiKey, model) {
  try {
    const genAI = new GoogleGenAI({ apiKey });
    const res = await genAI.models.generateContent({ model, contents: 'Reply with the single word OK' });
    const parts = res?.candidates?.[0]?.content?.parts || [];
    const text = (parts.map((p) => p.text || '').join('') || res?.text || '').trim();
    if (!text) return { ok: false, error: 'Gemini returned an empty response — check the API key and model name.' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Gemini error: ${err?.message || err}` };
  }
}

export function writeEnv(settings) {
  const content = [
    '# --- Email (IMAP + app password) ---',
    '# For Google-hosted accounts: enable 2-Step Verification, then create an app',
    '# password at https://myaccount.google.com/apppasswords',
    `GMAIL_USER=${settings.gmailUser}`,
    `GMAIL_APP_PASSWORD="${settings.gmailAppPassword}"`,
    '',
    `IMAP_HOST=${settings.imapHost}`,
    `IMAP_PORT=${settings.imapPort}`,
    '',
    '# Comma-separated list of senders to alert on.',
    '# "name@domain.com" = exact match, "@domain.com" = any address at that domain.',
    `WATCH_SENDERS=${settings.watchSenders.join(',')}`,
    '',
    '# --- Google AI Studio (Gemini) ---',
    '# Free API key: https://aistudio.google.com/apikey',
    `GEMINI_API_KEY=${settings.geminiApiKey}`,
    `GEMINI_MODEL=${settings.geminiModel}`,
    '',
    '# --- Optional ---',
    `POLL_INTERVAL_SECONDS=${settings.pollIntervalSeconds}`,
    `PORT=${settings.port}`,
    '',
  ].join('\n');
  fs.writeFileSync(ENV_FILE, content, 'utf8');
}

export async function ensureTask() {
  // Idempotent: registers the hidden-background scheduled task for this user.
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-Command', `Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue`]
    );
    if (String(stdout || '').trim()) return { ok: true, already: true };
  } catch {
    // not registered — fall through to create
  }

  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  fs.writeFileSync(
    VBS_FILE,
    [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.CurrentDirectory = "${PROJECT_DIR}"`,
      `sh.Run """${process.execPath}"" server/index.js 1>>mailwatch.log 2>&1", 0, True`,
      '',
    ].join('\n'),
    'utf8'
  );

  const ps = [
    `$vbs = '${VBS_FILE}'`,
    `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "\\"$vbs\\""`,
    `$triggerA = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
    `$triggerB = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 365)`,
    '$settings = New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable',
    '$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited',
    `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger @($triggerA, $triggerB) -Settings $settings -Principal $principal -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${TASK_NAME}'`,
    `'REGISTERED OK'`,
  ].join('\n');

  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 45000 });
    if (String(stdout || '').includes('REGISTERED OK')) return { ok: true };
    return { ok: false, error: 'Task register finished without confirmation.' };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}