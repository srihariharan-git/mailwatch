import 'dotenv/config';

export function loadConfig() {
  const config = {
    gmailUser: process.env.GMAIL_USER || '',
    gmailAppPassword: process.env.GMAIL_APP_PASSWORD || '',
    watchSenders: String(process.env.WATCH_SENDERS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    imapHost: process.env.IMAP_HOST || 'imap.gmail.com',
    imapPort: Number(process.env.IMAP_PORT || 993),
    pollIntervalSeconds: Math.max(15, Number(process.env.POLL_INTERVAL_SECONDS || 30)),
    port: Number(process.env.PORT || 3000),
  };

  return config;
}

export function missingEnv(config) {
  const missing = [];
  if (!config.gmailUser || !config.gmailAppPassword) missing.push('GMAIL_USER / GMAIL_APP_PASSWORD (must NOT be your normal Gmail password)');
  if (!config.watchSenders.length) missing.push('WATCH_SENDERS');
  if (!config.geminiApiKey) missing.push('GEMINI_API_KEY');
  return missing;
}