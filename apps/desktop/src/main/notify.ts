// Mac notifications, posted by the app itself (2026-11-08: "I tested
// notifications and it doesnt work (test notif never arrives)"; the hub's
// osascript exited 0 and showed nothing). When the app runs, the hub sends
// each one to it over the board's event stream (event: notify) and waits
// for its answer; the app posts it through Electron's Notification, as
// "Ravenry" with its icon and its own entry in System Settings >
// Notifications, and answers whether macOS showed it (its 'show' event) or
// not (its 'failed' event, with why). A click opens that session.
//
// Offscreen (tests, screenshots) nothing reaches the screen: a stand-in
// records each one (RAVENRY_NOTIFY_LOG, and globalThis.__ravenryNotes for
// a driver step to click), and RAVENRY_NOTIFY_STANDIN=denied answers as
// macOS does when it has not allowed Ravenry's notifications.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { Notification } from 'electron';

export interface NotifyRequest { id: string; title: string; body: string; kind?: string | null; projectId?: string | null; surfaceId?: string | null }
export interface NotifyResult { id: string; ok: boolean; error: string | null; denied: boolean }

/** How long macOS has to say it showed one, before the answer is that it did not. */
const CONFIRM_MS = 5000;

/** macOS's answer when Ravenry's notifications are not allowed (UNErrorCodeNotificationsNotAllowed). */
export function deniedError(err: string): boolean {
  return /not allowed|not authori[sz]ed|UNErrorDomain error 1\b|denied/i.test(err);
}

interface Posted extends EventEmitter { show(): void }

/** The stand-in for tests: records what was posted, answers as macOS would. */
class StandIn extends EventEmitter implements Posted {
  readonly opts: { title: string; body: string };
  constructor(opts: { title: string; body: string }) { super(); this.opts = opts; }
  show(): void {
    const rec = { title: this.opts.title, body: this.opts.body, clickable: this.listenerCount('click') > 0, at: new Date().toISOString() };
    const log = process.env.RAVENRY_NOTIFY_LOG;
    if (log) { try { fs.appendFileSync(log, JSON.stringify(rec) + '\n'); } catch { /* the test went */ } }
    const g = globalThis as unknown as { __ravenryNotes?: StandIn[] };
    (g.__ravenryNotes ||= []).push(this);
    setImmediate(() => {
      if (process.env.RAVENRY_NOTIFY_STANDIN === 'denied') this.emit('failed', {}, 'Notifications are not allowed for this application');
      else this.emit('show', {});
    });
  }
}

// Kept until answered or clicked: a notification that is collected never fires its events.
const live = new Set<Posted>();

/**
 * Posts one and resolves with whether macOS showed it. `open` runs on a
 * click (the session it is about, in the window).
 */
export function postNotification(req: NotifyRequest, opts: { standIn: boolean; open: (req: NotifyRequest) => void; log: (line: string) => void }): Promise<NotifyResult> {
  return new Promise((resolve) => {
    const answer = (ok: boolean, error: string | null) => {
      const r = { id: req.id, ok, error, denied: !ok && !!error && deniedError(error) };
      opts.log(`notify: ${req.title} (${req.kind || 'alert'}) ${ok ? 'shown' : `not shown: ${error}`}`);
      resolve(r);
    };
    if (!opts.standIn && !Notification.isSupported()) { answer(false, 'This Mac does not take notifications from apps.'); return; }
    const n: Posted = opts.standIn ? new StandIn({ title: req.title, body: req.body }) : new Notification({ title: req.title, body: req.body });
    let done = false;
    const finish = (ok: boolean, error: string | null) => { if (done) return; done = true; clearTimeout(timer); answer(ok, error); };
    const timer = setTimeout(() => finish(false, 'macOS did not say it showed it'), CONFIRM_MS);
    n.on('show', () => finish(true, null));
    n.on('failed', (_e: unknown, err: unknown) => { live.delete(n); finish(false, String(err || 'macOS refused it')); });
    n.on('click', () => { live.delete(n); opts.open(req); });
    n.on('close', () => live.delete(n));
    live.add(n);
    try { n.show(); } catch (e) { live.delete(n); finish(false, (e as Error).message); }
  });
}
