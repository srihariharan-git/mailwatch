# MailWatch

A personal AI email alert for your own use. It watches your email inbox (Gmail,
Office 365, or any IMAP mailbox — including college-provided accounts) and the moment
a watched sender emails you, it pops a **native Windows desktop notification** with a
**Gemini-generated summary** of the email. No browser tab needs to stay open.

Stack: Node.js + Express + imapflow (IMAP) · Gemini API (summaries) · plain web UI with
Server-Sent Events · node-notifier (Windows toasts).

## How it works

```
 inbox (IMAP) ──poll every 30s──► MailWatcher ──new mail from watched sender──► Gemini ──►
                                                                                             │
   Windows toast ◄────────────────────────────────────────────────────────────────────┘
   web UI history ◄──SSE event── Express
```

## Setup

### 1. Prerequisites

- Node.js 18+ (tested on 24)
- Windows 10/11 (for native desktop toasts)
- A free Gemini API key from <https://aistudio.google.com/apikey>
- Your Gmail **app password** (see step 2)

### 2. Create your app password

The password must **not** be your normal login password — use an app password:

- **Google-hosted account** (includes many college Gmail for Education mailboxes):
  1. Enable **2-Step Verification** at <https://myaccount.google.com/security>
  2. Create an app password at <https://myaccount.google.com/apppasswords>
  3. You get a 16-character password like `abcd efgh ijkl mnop`.
- **Office 365 / college Outlook mailbox**: create a Microsoft app password at
  <https://account.microsoft.com> → Security → App passwords.
- **Other providers**: whatever their docs tell you to generate for IMAP.

> College Google accounts sometimes have IMAP switched off by the IT admin. You can
> check whether yours is a Google account by signing in at <https://accounts.google.com> —
> if it says "couldn't find your Google Account", it isn't Google-hosted and you need a
> different IMAP server (step 3 will find it).

### 3. Install — automatic wizard (recommended)

Copy the folder to your PC, then:

```powershell
npm install
npm start
```

A **setup form appears in the web UI** (<http://localhost:3000>). Fill it in and click
**Test & save**:

- Gmail address + app password (verified live against the mail server before saving)
- Watched senders (one per line — `name@domain.com` or `@domain.com`)
- Gemini API key (optional; leave blank to skip summaries)

On save, MailWatch writes your `.env`, registers the hidden auto-start background task,
and restarts itself. Done — nothing else to run.

### 4. Manual `.env` setup (alternative)

```powershell
Copy-Item .env.example .env
# then edit .env:
#   GMAIL_USER          = your full email address (Gmail-hosted or college)
#   GMAIL_APP_PASSWORD  = the 16-char app password (spaces fine)
#   WATCH_SENDERS       = comma-separated senders to alert on, e.g.  boss@gmail.com,@bank.com
#   GEMINI_API_KEY      = your AI Studio key
```

Not sure which server your email lives on? Let it detect automatically:

```powershell
npm run detect
```

It tries Google, Microsoft 365, Outlook, Zoho, and Yahoo IMAP servers with your
credentials and tells you which one accepts your login. If it finds one, it prints the
`IMAP_HOST` / `IMAP_PORT` lines to add to `.env`. If your provider isn't in the list,
set `IMAP_HOST` manually to whatever your provider's IMAP server is.

### 5. Run

```powershell
npm start
```

That's it. The server watches in the background and Windows toasts pop up on their
own. The web UI at <http://localhost:3000> is just for history/config — you don't
need to keep it open.

### 6. Verify (optional)

- Click **Test notification** on the page — a fake alert fires and a real Windows
  toast appears (with a Gemini summary if you've set an API key).
- Click **Check now** to force a fresh inbox scan.

### 7. Start on login (done) — Windows Scheduled Task "MailWatch"

The setup wizard (or `Start-ScheduledTask`) registers a scheduled task named
**MailWatch** that starts the server at every logon, completely hidden — there is no
window to close and nothing to keep open. The wrapper runs `node.exe` with its output
sent to `mailwatch.log` (this also means closing any PowerShell/console window can
never kill it).

```powershell
Start-ScheduledTask  -TaskName MailWatch   # start now
Get-ScheduledTask   -TaskName MailWatch   # check state (Running)
# fully stop it:
Stop-ScheduledTask  -TaskName MailWatch
Stop-Process        -Name node
# remove auto-start:
Unregister-ScheduledTask -TaskName MailWatch
```

Logs (including poll errors and crashes) accrue in `mailwatch.log` next to the app.

## Notes

- The mailbox is polled every `POLL_INTERVAL_SECONDS` (default 30, min 15).
- Watched-sender detection is based on new message UIDs; already-read messages are ignored.
- Seen UIDs are stored in `seen-state.json`; alerts in `alerts.json` (both gitignored).
- Your credentials live only in `.env`. Nothing is sent anywhere except to your mail
  provider's IMAP server and Google's Gemini endpoint (Gemini gets only the email text).
- To change watched senders or keys, edit `.env` and restart (`Ctrl+C`, `npm start`).
- First run: the app silently adopts your current inbox position, so no flood of
  toasts for old mail — you're only alerted on mail that arrives after you start it.