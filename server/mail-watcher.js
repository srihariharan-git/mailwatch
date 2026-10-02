import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const STATE_FILE = path.join(process.cwd(), 'seen-state.json');

export class MailWatcher extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.state = { uidValidity: null, lastUid: 0, initialized: false, lastPollAt: null };
    this.polling = false;
    this.timer = null;
    this.stopped = false;
    this._loadState();
  }

  _loadState() {
    try {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (saved && typeof saved.lastUid === 'number') this.state = { ...this.state, ...saved };
    } catch {
      // first run
    }
  }

  _saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
  }

  _matches(from) {
    const f = from.toLowerCase();
    return this.config.watchSenders.some((watched) =>
      watched.startsWith('@') ? f.endsWith(watched) : f === watched
    );
  }

  _clientConfig() {
    return {
      host: this.config.imapHost,
      port: this.config.imapPort,
      secure: true,
      auth: { user: this.config.gmailUser, pass: this.config.gmailAppPassword },
      logger: false,
    };
  }

  async checkNow() {
    if (this.polling) return { skipped: true };
    return this._poll();
  }

  start() {
    this.stopped = false;
    const ms = this.config.pollIntervalSeconds * 1000;
    // First check quickly, then on a fixed interval.
    setTimeout(() => this._poll().catch((e) => this._onError(e)), 1000);
    this.timer = setInterval(() => {
      this._poll().catch((e) => this._onError(e));
    }, ms);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  _onError(err) {
    this.emit('error', err);
  }

  async _poll() {
    if (this.polling) return { skipped: true };
    this.polling = true;
    const client = new ImapFlow(this._clientConfig());
    try {
      await client.connect();
      const mailbox = await client.mailboxOpen('INBOX');

      if (Number(mailbox.uidValidity) !== this.state.uidValidity) {
        this.state.uidValidity = Number(mailbox.uidValidity);
        this.state.lastUid = 0;
        this.state.initialized = false;
      }

      // Fetch only UIDs + sender envelope (cheap) for every message once.
      const all = [];
      // NB: no other IMAP commands may run while iterating client.fetch()
      for await (const msg of client.fetch('1:*', { uid: true, envelope: true, internalDate: true }, { uid: true })) {
        all.push({
          uid: Number(msg.uid),
          from: (msg.envelope?.from?.[0]?.address || '').toLowerCase(),
          date: msg.internalDate ? new Date(msg.internalDate) : null,
        });
      }

      const nowMs = Date.now();

      if (!this.state.initialized) {
        // First run: silently adopt the current mailbox position so we only
        // alert on mail that arrives from now on.
        if (all.length) this.state.lastUid = Math.max(...all.map((m) => m.uid));
        this.state.initialized = true;
        this.state.lastPollAt = nowMs;
        this._saveState();
        await client.logout();
        this.emit('checked', { uidValidity: this.state.uidValidity, lastUid: this.state.lastUid });
        return { checked: true, found: 0 };
      }

      // Gmail does not always issue UIDs in arrival order, so a message can
      // arrive with a UID lower than one we already recorded. Treat mail as new
      // if it is above the last UID *or* arrived within the window since our
      // previous poll.
      const MARGIN = 10 * 60 * 1000;
      const freshSince = this.state.lastPollAt ? new Date(this.state.lastPollAt - MARGIN) : new Date(0);
      const newMsgs = all.filter(
        (m) => m.uid > this.state.lastUid || (m.date && m.date.getTime() >= freshSince.getTime())
      );

      this.state.lastUid = all.length ? Math.max(...all.map((m) => m.uid)) : this.state.lastUid;
      this.state.lastPollAt = nowMs;
      this._saveState();

      if (newMsgs.length) {
        for (const { uid, from } of newMsgs.sort((a, b) => a.uid - b.uid)) {
          if (!this._matches(from)) continue;

          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          const parsed = await simpleParser(Buffer.from(msg.source));
          const alert = {
            id: `${mailbox.uidValidity}-${uid}`,
            uid,
            from: parsed.from?.value?.[0]?.address || parsed.from?.text || from,
            subject: parsed.subject || '(no subject)',
            date: parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString(),
            snippet: (parsed.text || parsed.html || '').slice(0, 1500),
            receivedAt: Date.now(),
          };
          this.emit('mail', alert);
        }
      }

      await client.logout();
      this.emit('checked', { uidValidity: this.state.uidValidity, lastUid: this.state.lastUid });
      return { checked: true, found: newMsgs.length };
    } catch (err) {
      this.emit('error', err);
      return { checked: false, error: err.message };
    } finally {
      this.polling = false;
    }
  }
}