// AlCal sync and reminder server.
// One Cloudflare Worker in front of one Durable Object with SQLite storage.
// - /api/sync        two-way sync of events, projects, items and settings (last write wins per record)
// - /api/reminders   the app uploads its upcoming reminders; the server sends them as push notifications
// - /api/subscribe   registers a device for push notifications
// Every /api/ request must carry the sync key: "Authorization: Bearer <SYNC_KEY>".

import { DurableObject } from 'cloudflare:workers';
import { newVapidKeys, sendPush } from './push.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

function sameKey(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

function store(env) { return env.STORE.get(env.STORE.idFromName('main')); }

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response('AlCal sync server is running.', { headers: CORS });
    if (!url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    if (!env.SYNC_KEY) return json({ error: 'The server has no sync key yet (SYNC_KEY secret is missing).' }, 500);
    const given = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!sameKey(given, env.SYNC_KEY)) return json({ error: 'Wrong sync key' }, 401);
    let body = null;
    if (req.method === 'POST') {
      try { body = await req.json(); } catch { return json({ error: 'Invalid request' }, 400); }
    }
    try { return json(await store(env).handle(url.pathname, body, url.origin)); }
    catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
  },
  // Safety net: the Durable Object normally wakes itself with an alarm at the next reminder.
  async scheduled(event, env, ctx) { ctx.waitUntil(store(env).tick()); },
};

export class AlcalStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, updatedAt INTEGER NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, id))');
    this.sql.exec('CREATE INDEX IF NOT EXISTS records_seq ON records (seq)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT, device TEXT, created INTEGER)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, fireAt INTEGER NOT NULL, title TEXT, body TEXT, sent INTEGER NOT NULL DEFAULT 0)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS reminders_due ON reminders (sent, fireAt)');
  }

  meta(k) { const r = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray(); return r.length ? r[0].v : null; }
  setMeta(k, v) { this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, String(v)); }
  count(table) { return this.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n; }

  async handle(path, body, origin) {
    if (origin && !this.meta('subject')) this.setMeta('subject', origin);
    switch (path) {
      case '/api/ping': return { ok: true, records: this.count('records'), devices: this.count('subs') };
      case '/api/sync': return this.sync(body || {});
      case '/api/vapid': return { publicKey: (await this.vapid()).pub };
      case '/api/subscribe': return this.subscribe(body || {});
      case '/api/unsubscribe':
        this.sql.exec('DELETE FROM subs WHERE endpoint = ?', String((body && body.endpoint) || ''));
        return { ok: true };
      case '/api/reminders': return this.setReminders(body || {});
      case '/api/test': return this.sendAll({ title: 'AlCal', body: 'Notifications work on this device.', tag: 'alcal-test' });
      default: throw new Error('Unknown request');
    }
  }

  sync({ since = 0, changes = [] }) {
    let seq = Number(this.meta('seq') || 0);
    const accepted = new Set();
    for (const c of (Array.isArray(changes) ? changes : []).slice(0, 20000)) {
      if (!c || typeof c.kind !== 'string' || typeof c.id !== 'string' || c.data == null) continue;
      const u = Number(c.updatedAt) || 0;
      const ex = this.sql.exec('SELECT updatedAt FROM records WHERE kind = ? AND id = ?', c.kind, c.id).toArray();
      if (ex.length && ex[0].updatedAt > u) continue;           // the server already has a newer version
      seq++;
      this.sql.exec('INSERT INTO records (kind, id, updatedAt, seq, data) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT (kind, id) DO UPDATE SET updatedAt = excluded.updatedAt, seq = excluded.seq, data = excluded.data',
        c.kind, c.id, u, seq, JSON.stringify(c.data));
      accepted.add(c.kind + '\n' + c.id);
    }
    this.setMeta('seq', seq);
    const rows = this.sql.exec('SELECT kind, id, updatedAt, data FROM records WHERE seq > ? ORDER BY seq', Number(since) || 0).toArray();
    return {
      seq,
      changes: rows.filter(r => !accepted.has(r.kind + '\n' + r.id))
                   .map(r => ({ kind: r.kind, id: r.id, updatedAt: r.updatedAt, data: JSON.parse(r.data) })),
    };
  }

  async vapid() {
    let pub = this.meta('vapid_pub'), jwk = this.meta('vapid_jwk');
    if (!pub || !jwk) {
      ({ pub, jwk } = await newVapidKeys());
      this.setMeta('vapid_pub', pub); this.setMeta('vapid_jwk', jwk);
    }
    return { pub, jwk, subject: this.meta('subject') || 'https://alcal.invalid' };
  }

  subscribe({ subscription, device }) {
    const s = subscription || {}, k = s.keys || {};
    if (!/^https:\/\//.test(s.endpoint || '') || !k.p256dh || !k.auth) throw new Error('Invalid push subscription');
    this.sql.exec('INSERT INTO subs (endpoint, p256dh, auth, device, created) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device',
      s.endpoint, k.p256dh, k.auth, String(device || '').slice(0, 60), Date.now());
    return { ok: true, devices: this.count('subs') };
  }

  async setReminders({ items = [] }) {
    const keep = new Set();
    for (const it of (Array.isArray(items) ? items : []).slice(0, 5000)) {
      if (!it || !it.id || !Number.isFinite(Number(it.fireAt))) continue;
      const id = String(it.id).slice(0, 200);
      keep.add(id);
      this.sql.exec('INSERT INTO reminders (id, fireAt, title, body, sent) VALUES (?, ?, ?, ?, 0) ' +
        'ON CONFLICT (id) DO UPDATE SET fireAt = excluded.fireAt, title = excluded.title, body = excluded.body WHERE reminders.sent = 0',
        id, Number(it.fireAt), String(it.title || '').slice(0, 200), String(it.body || '').slice(0, 300));
    }
    for (const r of this.sql.exec('SELECT id FROM reminders WHERE sent = 0').toArray()) {
      if (!keep.has(r.id)) this.sql.exec('DELETE FROM reminders WHERE id = ?', r.id);
    }
    this.sql.exec('DELETE FROM reminders WHERE fireAt < ?', Date.now() - 7 * 864e5);
    await this.arm();
    return { ok: true, scheduled: keep.size };
  }

  async arm() {
    const r = this.sql.exec('SELECT MIN(fireAt) AS t FROM reminders WHERE sent = 0').one();
    if (r.t == null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(Date.now() + 500, r.t));
  }

  async alarm() { await this.tick(); }

  async tick() {
    const now = Date.now();
    this.sql.exec('UPDATE reminders SET sent = 1 WHERE sent = 0 AND fireAt < ?', now - 15 * 6e4);   // too late to be useful
    const due = this.sql.exec('SELECT id, title, body FROM reminders WHERE sent = 0 AND fireAt <= ? ORDER BY fireAt LIMIT 50', now + 5000).toArray();
    for (const r of due) {
      this.sql.exec('UPDATE reminders SET sent = 1 WHERE id = ?', r.id);
      await this.sendAll({ title: r.title, body: r.body, tag: r.id });
    }
    if (due.length) console.log(`AlCal: sent ${due.length} reminder(s)`);
    await this.arm();
    return { sent: due.length };
  }

  async sendAll(msg) {
    const subs = this.sql.exec('SELECT endpoint, p256dh, auth, device FROM subs').toArray();
    if (!subs.length) return { ok: true, devices: 0, delivered: 0, errors: ['No device has turned on notifications yet.'] };
    const vapid = await this.vapid();
    let delivered = 0; const errors = [];
    for (const s of subs) {
      try {
        const res = await sendPush(s, JSON.stringify(msg), vapid);
        if (res.status === 404 || res.status === 410) this.sql.exec('DELETE FROM subs WHERE endpoint = ?', s.endpoint);
        else if (res.ok) delivered++;
        else errors.push(`${s.device || 'device'}: ${res.status} ${(await res.text()).slice(0, 160)}`);
      } catch (e) { errors.push(`${s.device || 'device'}: ${e}`); }
    }
    return { ok: true, devices: subs.length, delivered, errors };
  }
}
