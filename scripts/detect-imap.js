import 'dotenv/config';
import { ImapFlow } from 'imapflow';

const user = process.env.GMAIL_USER || '';
const pass = process.env.GMAIL_APP_PASSWORD || '';

if (!user || !pass) {
  console.log('Set GMAIL_USER and GMAIL_APP_PASSWORD in .env first, then run detect again.');
  process.exit(1);
}

const CANDIDATES = [
  { host: 'imap.gmail.com', port: 993, label: 'Google / Gmail (likely if your college uses Google Workspace)' },
  { host: 'outlook.office365.com', port: 993, label: 'Microsoft 365 (many colleges/universities)' },
  { host: 'imap-mail.outlook.com', port: 993, label: 'Outlook.com personal' },
  { host: 'imap.zoho.com', port: 993, label: 'Zoho Mail' },
  { host: 'imap.mail.yahoo.com', port: 993, label: 'Yahoo Mail' },
];

const toTry = process.env.IMAP_HOST
  ? [{ host: process.env.IMAP_HOST, port: Number(process.env.IMAP_PORT || 993), label: process.env.IMAP_HOST }]
  : CANDIDATES;

for (const { host, port, label } of toTry) {
  process.stdout.write(`Testing ${host}:${port} — ${label}\n`);
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,
    connectionTimeout: 12000,
    greetingTimeout: 12000,
  });
  try {
    await client.connect();
    const mailbox = await client.mailboxOpen('INBOX');
    await client.logout();
    console.log(`  >>> SUCCESS! Your email is on ${host} (${mailbox.exists} messages in INBOX).`);
    console.log(`  >>> Copy this line into .env:`);
    console.log(`      IMAP_HOST=${host}`);
    console.log(`      IMAP_PORT=${port}`);
    process.exit(0);
  } catch (err) {
    console.log(`  ${describe(err)}\n`);
  }
}

console.log('No IMAP server from the list accepted your login.\n');
console.log('Likely causes:');
console.log('  1. The address is hosted by a provider not listed here — find its IMAP server, then set IMAP_HOST in .env manually.');
console.log("  2. College Google accounts sometimes have IMAP switched off by the admin — try signing in at https://accounts.google.com");
console.log('     with this address. If it says it cannot find the account, it is NOT a Google account.');
console.log("  3. Wrong password. Google / Microsoft app passwords are 16 characters (e.g. 'abcd efgh ijkl mnop').");

function describe(err) {
  const code = err?.code || '';
  const msg = String(err?.response || err?.message || '');
  if (code === 'authenticationFailure') return 'Authentication failed — server exists but login was rejected (wrong user/app-password, or this provider blocks it).';
  if (code === 'connectionTimeout') return 'Timed out connecting — probably not this provider.';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(msg)) return `Connection failed (${code}) — probably not this provider.`;
  return msg;
}