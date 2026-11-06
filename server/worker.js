// AlCal sync and reminder server.
// One Cloudflare Worker in front of one Durable Object with SQLite storage.
// - /api/sync        two-way sync of events, projects, items and settings. Edits are merged field by field:
//                    a device sends the fields it changed and their previous values, so two devices editing
//                    different fields of the same record both keep their changes. When both changed the same
//                    field, the later edit wins and the overwritten value is reported back as a conflict.
// - /api/backups     nightly snapshots of all data (kept 14 nights), plus manual and safety snapshots
// - /api/feed        fetches a public .ics calendar for the app (browsers block most of these directly)
// - /api/reminders   the app uploads its upcoming reminders; the server sends them as push notifications
// - /api/subscribe   registers a device for push notifications
// - /api/connector   tells the app the address of the Claude connector
// Every /api/ request must carry the sync key: "Authorization: Bearer <SYNC_KEY>".
// - /mcp/<token>     the Claude connector (see mcp.js). The token in the address is derived from the sync key.

import { DurableObject } from 'cloudflare:workers';
import { newVapidKeys, sendPush } from './push.js';
import { handleMcp, connectorToken } from './mcp.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
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
    if (url.pathname.startsWith('/mcp/')) return connector(req, env, url);
    if (!url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    if (!env.SYNC_KEY) return json({ error: 'The server has no sync key yet (SYNC_KEY secret is missing).' }, 500);
    if (url.pathname === '/api/connector') {
      const given = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!sameKey(given, env.SYNC_KEY)) return json({ error: 'Wrong sync key' }, 401);
      return json({ url: url.origin + '/mcp/' + await connectorToken(env.SYNC_KEY) });
    }
    const given = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!sameKey(given, env.SYNC_KEY)) return json({ error: 'Wrong sync key' }, 401);
    let body = null;
    if (req.method === 'POST') {
      try { body = await req.json(); } catch { return json({ error: 'Invalid request' }, 400); }
    }
    if (url.pathname === '/api/feed') return feed(body);
    try { return json(await store(env).handle(url.pathname, body, url.origin)); }
    catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
  },
  // Safety net for reminders (normally sent on time by a Durable Object alarm), and the nightly backup.
  async scheduled(event, env, ctx) { ctx.waitUntil(store(env).tick()); ctx.waitUntil(store(env).nightly()); },
};

// Public calendar feeds (for example football fixtures). Only https addresses, only calendar files.
async function feed(body) {
  const u = String((body && body.url) || '').trim().replace(/^webcal:\/\//i, 'https://');
  if (!/^https:\/\/[^\s/]+\.[^\s/]+/i.test(u)) return json({ error: 'Invalid feed address' }, 400);
  let r;
  try {
    r = await fetch(u, { headers: { 'User-Agent': 'AlCal/1.0 (calendar subscription)', Accept: 'text/calendar, */*' },
      cf: { cacheTtl: 1800, cacheEverything: true }, redirect: 'follow' });
  } catch (e) { return json({ error: 'Could not reach the feed' }, 502); }
  if (!r.ok) return json({ error: 'The feed answered ' + r.status }, 502);
  const text = await r.text();
  if (text.length > 4e6) return json({ error: 'The feed is too large' }, 502);
  if (!/BEGIN:VCALENDAR/.test(text)) return json({ error: 'That address is not a calendar feed' }, 502);
  return json({ text });
}

// ---------- field-level merge ----------
// The same code runs in the app (index.html) for edits made while a sync is under way.
function stable(v) {
  return JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x))
    ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x);
}
function same(a, b) { return stable(a) === stable(b); }
function setField(o, f, v) { if (v === undefined) delete o[f]; else o[f] = v; }
// theirs: the stored record; mine: the incoming record; fields: names mine changed; vals: their previous values.
function merge3(theirs, mine, fields, vals, mineWins) {
  const out = Object.assign({}, theirs), conflicts = [];
  const had = f => Object.prototype.hasOwnProperty.call(vals || {}, f);
  for (const f of fields) {
    if (f === 'updatedAt' || f === '_lt') continue;
    const b = had(f) ? vals[f] : undefined, m = mine[f], t = theirs[f];
    if (same(t, b) || same(t, m)) { setField(out, f, m); continue; }
    if (f === 'exdates' && (Array.isArray(m) || Array.isArray(t))) {    // deleted occurrences: combine both sides
      const bs = new Set(Array.isArray(b) ? b : []), ms = Array.isArray(m) ? m : [], ts = Array.isArray(t) ? t : [];
      const removed = new Set([...bs].filter(x => !ms.includes(x)));
      out[f] = [...new Set([...ts, ...ms.filter(x => !bs.has(x))])].filter(x => !removed.has(x));
      continue;
    }
    if (mineWins) { setField(out, f, m); conflicts.push({ field: f, kept: m, lost: t }); }
    else conflicts.push({ field: f, kept: t, lost: m });
  }
  // Deleted on one side, edited on the other: keep the record, so the edit is not lost.
  if (out.deleted && !(theirs.deleted && mine.deleted)) {
    const editedElsewhere = mine.deleted ? true : fields.some(f => f !== 'deleted' && f !== 'updatedAt');
    if (editedElsewhere) { out.deleted = false; conflicts.push({ field: 'deleted', kept: false, lost: true }); }
  }
  return { data: out, conflicts };
}
function short(v) {
  if (v === undefined || v === null) return null;
  const s = typeof v === 'string' ? v : stable(v);
  return s.length > 400 ? s.slice(0, 400) + '...' : (typeof v === 'string' ? v : JSON.parse(s));
}

// Claude connector: MCP over Streamable HTTP, answered with plain JSON (no event stream needed).
async function connector(req, env, url) {
  if (!env.SYNC_KEY) return json({ error: 'The server has no sync key yet.' }, 500);
  const token = url.pathname.slice(5).replace(/\/+$/, '');
  if (!sameKey(token, await connectorToken(env.SYNC_KEY))) return json({ error: 'Not found' }, 404);
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST', ...CORS } });
  let body;
  try { body = await req.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  let out;
  try { out = await store(env).mcp(body); }
  catch (e) { return json({ jsonrpc: '2.0', id: (body && body.id) ?? null, error: { code: -32603, message: String((e && e.message) || e) } }, 500); }
  if (out == null) return new Response(null, { status: 202, headers: CORS });
  return json(out);
}

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
    this.sql.exec('CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY AUTOINCREMENT, createdAt INTEGER NOT NULL, kind TEXT NOT NULL, records INTEGER, bytes INTEGER, chunks INTEGER)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS backup_chunks (bid INTEGER NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (bid, n))');
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
      case '/api/backups': return { backups: this.listBackups() };
      case '/api/backups/now': return { ok: true, id: this.snapshot('manual') };
      case '/api/backup': return this.readBackup(Number(body && body.id));
      default: throw new Error('Unknown request');
    }
  }

  sync({ since = 0, changes = [] }) {
    let seq = Number(this.meta('seq') || 0);
    const list = (Array.isArray(changes) ? changes : []).slice(0, 20000);
    // A sync that deletes a lot at once gets a safety snapshot first.
    let deletions = 0;
    for (const c of list) {
      if (!c || !c.data || !c.data.deleted || typeof c.kind !== 'string') continue;
      const ex = this.sql.exec('SELECT data FROM records WHERE kind = ? AND id = ?', c.kind, String(c.id)).toArray();
      if (ex.length && !JSON.parse(ex[0].data).deleted) deletions++;
    }
    if (deletions >= 25) this.snapshot('safety');

    const settled = new Set(), conflicts = [];
    for (const c of list) {
      if (!c || typeof c.kind !== 'string' || typeof c.id !== 'string' || c.data == null) continue;
      const u = Number(c.updatedAt) || 0;
      const ex = this.sql.exec('SELECT updatedAt, data FROM records WHERE kind = ? AND id = ?', c.kind, c.id).toArray();
      let data = c.data, stamp = u, asSent = true;
      if (ex.length) {
        const theirs = JSON.parse(ex[0].data), exAt = ex[0].updatedAt;
        const base = c.base && Array.isArray(c.base.fields) ? c.base : null;
        if (!base) {
          if (exAt > u) continue;                                 // older app version: the later save wins
        } else if (Number(base.updatedAt) !== exAt) {             // changed elsewhere since this device last saw it
          const m = merge3(theirs, c.data, base.fields, base.vals || {}, u >= exAt);
          data = m.data; stamp = Math.max(u, exAt) + 1; asSent = false;
          data.updatedAt = stamp;
          if (m.conflicts.length) conflicts.push({ kind: c.kind, id: c.id, title: String(data.title || data.name || data.id || '').slice(0, 120),
            fields: m.conflicts.map(x => ({ field: x.field, kept: short(x.kept), lost: short(x.lost) })) });
        }
      }
      seq++;
      this.sql.exec('INSERT INTO records (kind, id, updatedAt, seq, data) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT (kind, id) DO UPDATE SET updatedAt = excluded.updatedAt, seq = excluded.seq, data = excluded.data',
        c.kind, c.id, stamp, seq, JSON.stringify(data));
      if (asSent) settled.add(c.kind + '\n' + c.id);         // the device already has exactly this version
    }
    this.setMeta('seq', seq);
    // Everything newer than the device's last sync, plus merged records and records that were not taken.
    const sent = new Set(list.filter(c => c && typeof c.id === 'string').map(c => c.kind + '\n' + c.id));
    const rows = this.sql.exec('SELECT kind, id, updatedAt, data FROM records WHERE seq > ? ORDER BY seq', Number(since) || 0).toArray();
    const out = new Map(rows.filter(r => !settled.has(r.kind + '\n' + r.id)).map(r => [r.kind + '\n' + r.id, r]));
    for (const k of sent) {
      if (settled.has(k) || out.has(k)) continue;
      const [kind, id] = k.split('\n');
      const r = this.sql.exec('SELECT kind, id, updatedAt, data FROM records WHERE kind = ? AND id = ?', kind, id).toArray();
      if (r.length) out.set(k, r[0]);
    }
    return {
      seq,
      changes: [...out.values()].map(r => ({ kind: r.kind, id: r.id, updatedAt: r.updatedAt, data: JSON.parse(r.data) })),
      conflicts,
    };
  }

  // ---------- backups ----------
  snapshot(kind) {
    const rows = this.sql.exec('SELECT kind, data FROM records').toArray();
    const snap = { app: 'personal-calendar', version: 1, exported: new Date().toISOString(), source: 'server-backup',
      events: [], projects: [], cards: [], lists: [], settings: [] };
    for (const r of rows) if (snap[r.kind]) snap[r.kind].push(JSON.parse(r.data));
    const text = JSON.stringify(snap), size = 400000, n = Math.max(1, Math.ceil(text.length / size));
    this.sql.exec('INSERT INTO backups (createdAt, kind, records, bytes, chunks) VALUES (?, ?, ?, ?, ?)', Date.now(), kind, rows.length, text.length, n);
    const id = this.sql.exec('SELECT last_insert_rowid() AS id').one().id;
    for (let i = 0; i < n; i++) this.sql.exec('INSERT INTO backup_chunks (bid, n, data) VALUES (?, ?, ?)', id, i, text.slice(i * size, (i + 1) * size));
    const keep = { nightly: 14, manual: 5, safety: 5 }[kind] || 5;
    for (const old of this.sql.exec('SELECT id FROM backups WHERE kind = ? ORDER BY createdAt DESC LIMIT -1 OFFSET ?', kind, keep).toArray()) {
      this.sql.exec('DELETE FROM backup_chunks WHERE bid = ?', old.id);
      this.sql.exec('DELETE FROM backups WHERE id = ?', old.id);
    }
    this.setMeta('backup_seq', this.meta('seq') || 0);
    return id;
  }

  listBackups() {
    return this.sql.exec('SELECT id, createdAt, kind, records, bytes FROM backups ORDER BY createdAt DESC').toArray();
  }

  readBackup(id) {
    const b = this.sql.exec('SELECT id, createdAt, kind FROM backups WHERE id = ?', id).toArray();
    if (!b.length) throw new Error('That backup no longer exists');
    const text = this.sql.exec('SELECT data FROM backup_chunks WHERE bid = ? ORDER BY n', id).toArray().map(r => r.data).join('');
    return { id, createdAt: b[0].createdAt, kind: b[0].kind, data: JSON.parse(text) };
  }

  // Runs from the cron trigger. One snapshot per night, after 03:00 in the time zone of the device that synced last.
  async nightly() {
    if (!this.count('records')) return { skipped: 'empty' };
    let tz = 'Europe/Zurich';
    try {
      const r = this.sql.exec("SELECT data FROM records WHERE kind = 'settings' AND id = 'tz'").toArray();
      if (r.length) { const v = JSON.parse(r[0].data).value; new Intl.DateTimeFormat('en', { timeZone: v }); tz = v; }
    } catch (e) {}
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).map(x => [x.type, x.value]));
    const day = `${p.year}-${p.month}-${p.day}`;
    if (Number(p.hour) < 3 || this.meta('backup_day') === day) return { skipped: 'not due' };
    this.setMeta('backup_day', day);
    if (this.listBackups().some(b => b.kind === 'nightly') && this.meta('backup_seq') === String(this.meta('seq') || 0)) return { skipped: 'unchanged' };
    return { id: this.snapshot('nightly') };
  }

  // Record access for the connector. Writes go through the same table as /api/sync, so devices pull them.
  async mcp(body) {
    const sql = this.sql, self = this;
    let touched = false;
    const db = {
      all(kind) { return sql.exec('SELECT data FROM records WHERE kind = ?', kind).toArray().map(r => JSON.parse(r.data)); },
      get(kind, id) { const r = sql.exec('SELECT data FROM records WHERE kind = ? AND id = ?', kind, String(id)).toArray(); return r.length ? JSON.parse(r[0].data) : null; },
      put(kind, rec) {
        const data = Object.assign({}, rec); delete data._lt;
        const prev = sql.exec('SELECT updatedAt FROM records WHERE kind = ? AND id = ?', kind, data.id).toArray();
        data.updatedAt = Math.max(Date.now(), prev.length ? prev[0].updatedAt + 1 : 0);
        const seq = Number(self.meta('seq') || 0) + 1;
        sql.exec('INSERT INTO records (kind, id, updatedAt, seq, data) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT (kind, id) DO UPDATE SET updatedAt = excluded.updatedAt, seq = excluded.seq, data = excluded.data',
          kind, data.id, data.updatedAt, seq, JSON.stringify(data));
        self.setMeta('seq', seq);
        Object.assign(rec, { updatedAt: data.updatedAt });
      },
      reminders(prefix, items) {
        sql.exec('DELETE FROM reminders WHERE sent = 0 AND substr(id, 1, ?) = ?', prefix.length, prefix);
        for (const it of items) {
          sql.exec('INSERT INTO reminders (id, fireAt, title, body, sent) VALUES (?, ?, ?, ?, 0) ' +
            'ON CONFLICT (id) DO UPDATE SET fireAt = excluded.fireAt, title = excluded.title, body = excluded.body WHERE reminders.sent = 0',
            String(it.id).slice(0, 200), Number(it.fireAt), String(it.title || '').slice(0, 200), String(it.body || '').slice(0, 300));
        }
        touched = true;
      },
    };
    const out = await handleMcp(body, db);
    if (touched) await this.arm();
    return out;
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
