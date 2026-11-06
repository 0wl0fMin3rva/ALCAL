// AlCal connector for Claude (Model Context Protocol, Streamable HTTP, JSON responses).
// Lets Claude read and change events, planner projects and items, and lists. Changes are stored exactly
// as the app stores them, so every device picks them up on its next sync. Deletions are soft (deleted: true),
// just like in the app.
//
// handleMcp(message, db) takes one JSON-RPC message (or a batch) and returns the reply (or null for
// notifications). db is supplied by the Durable Object:
//   db.all(kind) -> array of records (including deleted ones)      kind: events | projects | cards | lists | settings
//   db.get(kind, id) -> record or null
//   db.put(kind, record)                                            stamps updatedAt and makes it sync
//   db.reminders(prefix, items)                                     replaces unsent reminders whose id starts with prefix

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DAY = 864e5, MIN = 6e4;

/* ---------- time zones ---------- */
const fmts = new Map();
function partsFmt(tz) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmts.set(tz, f);
  }
  return f;
}
// "wall" time: the clock reading in tz, stored as if it were UTC, so plain UTC arithmetic works on it
function toWall(ms, tz) {
  const p = {};
  for (const x of partsFmt(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
}
function fromWall(w, tz) {
  const r0 = w - (toWall(w, tz) - w);
  return w - (toWall(r0, tz) - r0);
}
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }
const wkey = w => new Date(w).toISOString().slice(0, 10);
const keyWall = k => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
const isKey = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(keyWall(s));
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = n => String(n).padStart(2, '0');
function localIso(ms, tz) { const w = new Date(toWall(ms, tz)); return w.toISOString().slice(0, 16); }
function weekday(ms, tz) { return WD[new Date(toWall(ms, tz)).getUTCDay()]; }
function dayLabel(ms, tz) { const w = new Date(toWall(ms, tz)); return `${WD[w.getUTCDay()]} ${w.getUTCDate()} ${MON[w.getUTCMonth()]}`; }
function hhmm(ms, tz) { const w = new Date(toWall(ms, tz)); return pad(w.getUTCHours()) + ':' + pad(w.getUTCMinutes()); }
function dateKey(ms, tz) { return wkey(toWall(ms, tz)); }
function keyLabel(k) { const w = new Date(keyWall(k)); return `${WD[w.getUTCDay()]} ${w.getUTCDate()} ${MON[w.getUTCMonth()]}`; }

// "2026-11-10", "2026-11-10T15:00", "2026-11-10 15:00:00", "2026-11-10T07:00Z", "2026-11-10T15:00+08:00"
function parseWhen(s, tz, field) {
  if (typeof s !== 'string') throw new Error(`${field}: expected a date or date-time string`);
  s = s.trim();
  if (isKey(s)) return { ms: fromWall(keyWall(s), tz), dateOnly: true, key: s };
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) throw new Error(`${field}: could not read "${s}". Use YYYY-MM-DD or YYYY-MM-DDTHH:MM`);
  const w = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (isNaN(w)) throw new Error(`${field}: invalid date "${s}"`);
  let ms;
  if (m[7]) {
    const z = m[7].toUpperCase();
    if (z === 'Z') ms = w;
    else { const sign = z[0] === '-' ? -1 : 1, d = z.slice(1).replace(':', ''); ms = w - sign * (+d.slice(0, 2) * 60 + +d.slice(2)) * MIN; }
  } else ms = fromWall(w, tz);
  return { ms, dateOnly: false, key: dateKey(ms, tz) };
}

/* ---------- app constants (mirrors index.html) ---------- */
const CATS = [['blue', 'Calendar'], ['orange', 'Work'], ['green', 'Personal'], ['purple', 'Travel'], ['red', 'Important'], ['teal', 'Other']];
const REM_TIMED = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];
const REM_ALLDAY = [0, 1440, 2880, 10080];
const CARD_REM = { none: null, on_due_date: 0, day_before: 1440, week_before: 10080 };
const CARD_REM_NAME = { 0: 'on_due_date', 1440: 'day_before', 10080: 'week_before' };
const PRIORITIES = ['none', 'low', 'medium', 'high'];
const SECTIONS = {
  purchase: { name: 'Purchase', tick: true, cats: [['food', 'Food & Drink'], ['clothing', 'Clothing & Accessories'], ['cosmetics', 'Cosmetics'], ['tech', 'Tech'], ['finance', 'Finance'], ['fitness', 'Fitness & Health'], ['subs', 'Subscriptions'], ['misc', 'Miscellaneous']] },
  reading: { name: 'Reading', tick: true, author: true, cats: [['books', 'Books'], ['articles', 'Articles'], ['abooks', 'Academic Books'], ['aarticles', 'Academic Articles']] },
  ideas: { name: 'Ideas', tick: false, desc: true, cats: [['academic', 'Academic'], ['creative', 'Creative'], ['money', 'Money'], ['projects', 'Projects']] },
};
const FREQS = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'];

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }
const live = arr => arr.filter(x => x && !x.deleted);
const norm = s => String(s || '').trim().toLowerCase();
function snapRem(v, allDay) {
  if (v === null || v === undefined || v === '' || v === 'none') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error('reminder_minutes must be a number of minutes, or null for no reminder');
  const opts = allDay ? REM_ALLDAY : REM_TIMED;
  return opts.reduce((b, o) => (Math.abs(o - n) < Math.abs(b - n) ? o : b), opts[0]);
}
function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

/* ---------- context ---------- */
function context(db, args) {
  const settings = db.all('settings');
  const tzRec = settings.find(x => x.id === 'tz');
  let tz = (args && args.timezone) || (tzRec && tzRec.value) || 'UTC';
  if (!validTz(tz)) throw new Error(`Unknown time zone "${tz}". Use an IANA name such as Asia/Taipei or Europe/Zurich`);
  const catRec = settings.find(x => x.id === 'catNames');
  const custom = (catRec && catRec.value) || {};
  const cats = CATS.map(([id, name]) => ({ id, name: typeof custom[id] === 'string' && custom[id].trim() ? custom[id].trim() : name }));
  return { db, tz, cats, now: Date.now() };
}
function catName(ctx, id) { const c = ctx.cats.find(c => c.id === id) || ctx.cats[0]; return c.name; }
function resolveCat(ctx, v) {
  if (v === undefined || v === null || v === '') return null;
  const n = norm(v);
  const c = ctx.cats.find(c => c.id === n || norm(c.name) === n) || ctx.cats.find(c => norm(c.name).startsWith(n));
  if (!c) throw new Error(`Unknown category "${v}". Categories: ${ctx.cats.map(c => c.name).join(', ')}`);
  return c.id;
}

/* ---------- recurrence (mirrors occurrences() in index.html, time-zone aware) ---------- */
function baseRange(ev, tz) {
  if (ev.allDay && isKey(ev.sd)) return [fromWall(keyWall(ev.sd), tz), fromWall(keyWall(isKey(ev.ed) ? ev.ed : ev.sd) + DAY, tz)];
  return [Number(ev.start), Number(ev.end)];
}
function nthWall(bw, f, n) {
  const b = new Date(bw), y = b.getUTCFullYear(), mo = b.getUTCMonth(), d = b.getUTCDate(), h = b.getUTCHours(), mi = b.getUTCMinutes();
  if (f === 'daily') return bw + n * DAY;
  if (f === 'weekly') return bw + 7 * n * DAY;
  if (f === 'monthly') { const x = Date.UTC(y, mo + n, d, h, mi); return new Date(x).getUTCDate() === d ? x : null; }
  if (f === 'yearly') { const x = Date.UTC(y + n, mo, d, h, mi); return new Date(x).getUTCMonth() === mo ? x : null; }
  return null;
}
function occurrences(events, rs, re, tz) {
  const out = [];
  for (const ev of events) {
    const [s, e] = baseRange(ev, tz);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    const dur = e - s, r = ev.repeat || {}, f = r.freq || 'none';
    const push = (os, rec) => out.push({ ev, s: os, e: os + dur, rec, key: dateKey(os, tz) });
    if (f === 'none') { if (s < re && e > rs) push(s, false); continue; }
    const until = isKey(r.until) ? r.until : null, ex = new Set(ev.exdates || []);
    const count = r.count || Infinity, step = Math.max(1, r.interval || 1), sw = toWall(s, tz);
    if (f === 'weekdays') {
      let dw = sw, made = 0;
      if (count === Infinity && rs - s > dur) dw = sw + Math.max(0, Math.floor((rs - s - dur) / DAY) - 1) * DAY;
      for (let i = 0; i < 20000; i++) {
        const os = fromWall(dw, tz), k = wkey(dw);
        if (os >= re || (until && k > until) || made >= count) break;
        const wd = new Date(dw).getUTCDay();
        if (wd !== 0 && wd !== 6) { made++; if (os + dur > rs && !ex.has(k)) push(os, true); }
        dw += DAY;
      }
      continue;
    }
    const approx = { daily: DAY, weekly: 7 * DAY, monthly: 31 * DAY, yearly: 366 * DAY }[f];
    if (!approx) continue;
    let n0 = 0;
    if (rs - s > dur) n0 = Math.max(0, Math.floor((rs - s - dur) / (approx * step)) - 2);
    for (let n = n0; n < n0 + 20000; n++) {
      if (n >= count) break;
      const ow = nthWall(sw, f, n * step);
      if (ow == null) continue;
      const os = fromWall(ow, tz), k = wkey(ow);
      if (os >= re || (until && k > until)) break;
      if (os + dur > rs && !ex.has(k)) push(os, true);
    }
  }
  return out.sort((a, b) => (!!b.ev.allDay - !!a.ev.allDay) || a.s - b.s);
}

/* ---------- server-side reminders (same ids as the app, so they merge cleanly) ---------- */
function eventReminders(ctx, ev) {
  if (ev.deleted || ev.reminder == null || ev.reminder === '') return [];
  const from = ctx.now - 36e5, to = ctx.now + 45 * DAY, out = [];
  for (const o of occurrences([ev], from, to + 8 * DAY, ctx.tz)) {
    const fireAt = (ev.allDay ? o.s + 9 * 36e5 : o.s) - ev.reminder * MIN;
    if (fireAt < from || fireAt > to) continue;
    const when = dayLabel(o.s, ctx.tz) + (ev.allDay ? ', all day' : ', ' + hhmm(o.s, ctx.tz) + ' - ' + hhmm(o.e, ctx.tz));
    out.push({ id: 'e:' + ev.id + ':' + o.s + ':' + ev.reminder, fireAt, title: ev.title || '(No title)', body: when + (ev.location ? ' · ' + ev.location : '') });
  }
  return out;
}
function cardReminders(ctx, x) {
  if (x.deleted || !isKey(x.due) || x.remind == null) return [];
  const p = ctx.db.get('projects', x.projectId);
  if (!p || p.deleted || isDone(p, x)) return [];
  const fireAt = fromWall(keyWall(x.due), ctx.tz) + 9 * 36e5 - x.remind * MIN;
  if (fireAt < ctx.now - 36e5 || fireAt > ctx.now + 45 * DAY) return [];
  return [{ id: 'c:' + x.id + ':' + x.due + ':' + x.remind, fireAt, title: x.title || '(No title)', body: 'Due ' + keyLabel(x.due) + ' · ' + p.name }];
}
function saveEvent(ctx, ev) { ctx.db.put('events', ev); ctx.db.reminders('e:' + ev.id + ':', eventReminders(ctx, ev)); }
function saveCard(ctx, x) { ctx.db.put('cards', x); ctx.db.reminders('c:' + x.id + ':', cardReminders(ctx, x)); }

/* ---------- lookups ---------- */
function findBy(list, ref, what, label) {
  if (ref === undefined || ref === null || ref === '') throw new Error(`Please say which ${what}`);
  const all = live(list);
  const byId = all.find(x => x.id === ref);
  if (byId) return byId;
  const n = norm(ref);
  let hits = all.filter(x => norm(label(x)) === n);
  if (!hits.length) hits = all.filter(x => norm(label(x)).includes(n));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`No ${what} matches "${ref}"`);
  throw new Error(`"${ref}" matches ${hits.length} ${what}s: ${hits.slice(0, 8).map(x => `${label(x)} (id ${x.id})`).join('; ')}. Use the id`);
}
const findProject = (ctx, ref) => findBy(ctx.db.all('projects'), ref, 'project', p => p.name);
function findColumn(p, ref) {
  if (ref === undefined || ref === null || ref === '') return p.columns[0];
  const n = norm(ref);
  const c = p.columns.find(c => c.id === ref || norm(c.name) === n) || p.columns.find(c => norm(c.name).startsWith(n))
    || (n === 'done' || n === 'finished' || n === 'complete' ? p.columns[p.columns.length - 1] : null);
  if (!c) throw new Error(`Project "${p.name}" has no column "${ref}". Columns: ${p.columns.map(c => c.name).join(', ')}`);
  return c;
}
function isDone(p, x) { const last = p.columns[p.columns.length - 1]; return !!last && x.col === last.id; }
function lastOrder(ctx, pid, cid, skip) {
  return live(ctx.db.all('cards')).filter(c => c.projectId === pid && c.col === cid && c.id !== skip).reduce((m, c) => Math.max(m, Number(c.order) || 0), 0);
}
function findSection(ref) {
  const n = norm(ref);
  const k = Object.keys(SECTIONS).find(k => k === n || norm(SECTIONS[k].name) === n);
  if (!k) throw new Error(`Unknown list "${ref}". Lists: purchase, reading, ideas`);
  return k;
}
function findListCat(key, ref) {
  const cats = SECTIONS[key].cats, n = norm(ref);
  const c = cats.find(c => c[0] === n || norm(c[1]) === n) || cats.find(c => norm(c[1]).startsWith(n)) || cats.find(c => norm(c[1]).includes(n));
  if (!c) throw new Error(`The ${SECTIONS[key].name} list has no category "${ref}". Categories: ${cats.map(c => c[1]).join(', ')}`);
  return c[0];
}

/* ---------- output shapes ---------- */
function repeatOut(r) {
  if (!r || !r.freq || r.freq === 'none') return undefined;
  const o = { freq: r.freq };
  if (r.interval > 1) o.interval = r.interval;
  if (r.count) o.count = r.count;
  if (r.until) o.until = r.until;
  return o;
}
function occOut(ctx, o) {
  const ev = o.ev, x = { id: ev.id, title: ev.title || '(No title)' };
  if (ev.allDay) {
    x.all_day = true; x.date = o.key;
    const last = dateKey(o.e - 1, ctx.tz); if (last !== o.key) x.end_date = last;
    x.weekday = WD[new Date(keyWall(o.key)).getUTCDay()];
  } else { x.start = localIso(o.s, ctx.tz); x.end = localIso(o.e, ctx.tz); x.weekday = weekday(o.s, ctx.tz); }
  if (o.rec) { x.recurring = repeatOut(ev.repeat); x.occurrence_date = o.key; }
  x.category = catName(ctx, ev.cat);
  if (ev.location) x.location = ev.location;
  if (ev.notes) x.notes = clip(ev.notes, 400);
  if (ev.reminder != null) x.reminder_minutes = ev.reminder;
  return x;
}
function eventOut(ctx, ev) {
  const x = { id: ev.id, title: ev.title || '(No title)' };
  if (ev.allDay) { x.all_day = true; x.date = ev.sd; if (ev.ed && ev.ed !== ev.sd) x.end_date = ev.ed; }
  else { x.start = localIso(ev.start, ctx.tz); x.end = localIso(ev.end, ctx.tz); x.weekday = weekday(ev.start, ctx.tz); }
  const rep = repeatOut(ev.repeat); if (rep) x.repeat = rep;
  if (ev.exdates && ev.exdates.length) x.skipped_dates = ev.exdates;
  x.category = catName(ctx, ev.cat);
  if (ev.location) x.location = ev.location;
  if (ev.notes) x.notes = ev.notes;
  x.reminder_minutes = ev.reminder == null ? null : ev.reminder;
  return x;
}
function cardOut(ctx, x, p) {
  p = p || ctx.db.get('projects', x.projectId);
  const col = p && p.columns.find(c => c.id === x.col);
  const o = { id: x.id, title: x.title || '(No title)', project: p ? p.name : '?', column: col ? col.name : '?' };
  if (x.due) o.due = x.due;
  if (x.priority && x.priority !== 'none') o.priority = x.priority;
  if (x.notes) o.notes = clip(x.notes, 400);
  if (x.remind != null) o.reminder = CARD_REM_NAME[x.remind] || x.remind;
  if (p && isDone(p, x)) o.done = true;
  return o;
}
function listOut(x) {
  const s = SECTIONS[x.section], c = s && s.cats.find(c => c[0] === x.cat);
  const o = { id: x.id, list: s ? s.name : x.section, category: c ? c[1] : x.cat, title: x.title || '(No title)' };
  if (x.author) o.author = x.author;
  if (x.desc) o.description = clip(x.desc, 400);
  if (s && s.tick) o.done = !!x.done;
  return o;
}

/* ---------- event editing ---------- */
function applyEventFields(ctx, d, a, isNew) {
  if (a.title !== undefined) d.title = String(a.title || '').trim().slice(0, 300);
  if (a.location !== undefined) d.location = String(a.location || '').trim().slice(0, 300);
  if (a.notes !== undefined) d.notes = String(a.notes || '').slice(0, 20000);
  if (a.category !== undefined) d.cat = resolveCat(ctx, a.category) || 'blue';

  const wasAllDay = !!d.allDay;
  const startIsDate = a.start !== undefined && isKey(String(a.start).trim());
  const allDay = a.all_day !== undefined ? !!a.all_day
    : startIsDate && (wasAllDay || (a.end !== undefined && isKey(String(a.end).trim()))) ? true
    : a.start !== undefined && !startIsDate ? false : wasAllDay;
  const timeChange = a.start !== undefined || a.end !== undefined || a.duration_minutes !== undefined || allDay !== wasAllDay;
  if (timeChange) {
    if (allDay) {
      let sd = a.start !== undefined ? parseWhen(a.start, ctx.tz, 'start').key : (d.sd || dateKey(d.start, ctx.tz));
      let ed = a.end !== undefined ? parseWhen(a.end, ctx.tz, 'end').key
        : a.start !== undefined && d.sd && d.ed && wasAllDay ? wkey(keyWall(sd) + (keyWall(d.ed) - keyWall(d.sd))) : sd;
      if (ed < sd) ed = sd;
      d.allDay = true; d.sd = sd; d.ed = ed;
      d.start = fromWall(keyWall(sd), ctx.tz); d.end = fromWall(keyWall(ed) + DAY, ctx.tz);
    } else {
      const oldDur = !wasAllDay && d.end > d.start ? d.end - d.start : 60 * MIN;
      let s = a.start !== undefined ? parseWhen(a.start, ctx.tz, 'start') : { ms: wasAllDay ? fromWall(keyWall(d.sd) + 9 * 36e5, ctx.tz) : d.start };
      if (s.dateOnly) s = { ms: s.ms + (wasAllDay ? 9 * 36e5 : (toWall(d.start, ctx.tz) % DAY)) };
      let e;
      if (a.end !== undefined) {
        const pe = parseWhen(a.end, ctx.tz, 'end');
        if (pe.dateOnly) throw new Error('end: please give a time as well (YYYY-MM-DDTHH:MM)');
        e = pe.ms;
      } else if (a.duration_minutes !== undefined) e = s.ms + Math.max(5, Number(a.duration_minutes) || 60) * MIN;
      else e = s.ms + oldDur;
      if (!(e > s.ms)) e = s.ms + 30 * MIN;
      d.allDay = false; d.start = s.ms; d.end = e; d.sd = dateKey(s.ms, ctx.tz); d.ed = dateKey(e, ctx.tz);
    }
  }
  if (a.reminder_minutes !== undefined) d.reminder = snapRem(a.reminder_minutes, d.allDay);
  else if (isNew) d.reminder = d.allDay ? null : 15;
  else if (d.reminder != null && d.allDay !== wasAllDay) d.reminder = snapRem(d.reminder, d.allDay);

  if (a.repeat !== undefined) {
    const r = a.repeat;
    if (!r || r === 'none' || r.freq === 'none') d.repeat = { freq: 'none' };
    else {
      const freq = typeof r === 'string' ? r : r.freq;
      if (!FREQS.includes(freq)) throw new Error(`repeat.freq must be one of ${FREQS.join(', ')}`);
      const o = { freq };
      if (typeof r === 'object') {
        if (r.until) { const u = parseWhen(r.until, ctx.tz, 'repeat.until').key; o.until = u < d.sd ? d.sd : u; }
        if (r.interval > 1) o.interval = Math.min(99, Math.floor(r.interval));
        if (r.count > 0) o.count = Math.min(9999, Math.floor(r.count));
      }
      d.repeat = o;
    }
  }
  if (!d.repeat) d.repeat = { freq: 'none' };
}
function findEvent(ctx, id) {
  const ev = ctx.db.get('events', id);
  if (!ev || ev.deleted) throw new Error(`No event with id "${id}". Use list_events to find the id`);
  return ev;
}
function checkOccurrence(ctx, ev, key) {
  if (!isKey(key)) throw new Error('occurrence_date must be YYYY-MM-DD');
  const ws = fromWall(keyWall(key), ctx.tz);
  if (!occurrences([ev], ws, ws + DAY, ctx.tz).some(o => o.key === key)) throw new Error(`"${ev.title}" does not take place on ${key}`);
}

/* ---------- tools ---------- */
const S = (type, description, extra) => Object.assign({ type, description }, extra || {});
const WHEN = 'Local date-time "YYYY-MM-DDTHH:MM" in the calendar time zone, or a date "YYYY-MM-DD" for all-day. An explicit offset (e.g. +01:00) is also accepted.';
const EVENT_FIELDS = {
  title: S('string', 'Event title'),
  start: S('string', 'Start. ' + WHEN),
  end: S('string', 'End (exclusive time for timed events; last day, inclusive, for all-day events). Optional.'),
  duration_minutes: S('number', 'Length of a timed event when no end is given (default 60)'),
  all_day: S('boolean', 'All-day event. Implied when start is a plain date'),
  location: S('string', 'Location'),
  notes: S('string', 'Notes'),
  category: S('string', 'Category name or id (see get_overview). Default: the first category'),
  reminder_minutes: S(['number', 'null'], 'Minutes before start for a push reminder; null for none. Timed events: 0,5,10,15,30,60,120,1440,2880,10080 (default 15). All-day events fire at 09:00: 0 (on the day), 1440, 2880, 10080 (default none)'),
  repeat: S(['object', 'null'], 'Repetition, or null / {"freq":"none"} to stop repeating', {
    properties: {
      freq: S('string', 'Frequency', { enum: FREQS }),
      until: S('string', 'Last date YYYY-MM-DD (inclusive)'),
      interval: S('number', 'Every N periods (default 1)'),
      count: S('number', 'Number of occurrences'),
    },
  }),
};
const TZ = { timezone: S('string', 'IANA time zone for reading and writing times. Default: the time zone of the user\'s devices (see get_overview)') };

const TOOLS = [
  {
    name: 'get_overview',
    description: 'Start here. Returns the current date and time in the user\'s time zone, the event categories, the planner projects with their columns and open item counts, and the lists with their categories.',
    inputSchema: { type: 'object', properties: { ...TZ } },
    annotations: { title: 'Overview', readOnlyHint: true },
    run(ctx) {
      const cards = live(ctx.db.all('cards')), items = live(ctx.db.all('lists'));
      return {
        now: localIso(ctx.now, ctx.tz), weekday: weekday(ctx.now, ctx.tz), timezone: ctx.tz,
        event_categories: ctx.cats.map(c => c.name),
        projects: live(ctx.db.all('projects')).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map(p => ({
          id: p.id, name: p.name,
          columns: p.columns.map(c => ({ name: c.name, items: cards.filter(x => x.projectId === p.id && x.col === c.id).length })),
        })),
        lists: Object.entries(SECTIONS).map(([k, s]) => ({
          list: k, name: s.name, tickable: s.tick, has_author: !!s.author, has_description: !!s.desc,
          categories: s.cats.map(c => ({ name: c[1], open: items.filter(x => x.section === k && x.cat === c[0] && !(s.tick && x.done)).length })),
        })),
        notes: 'The last column of each project counts as done. Deleting anything here can be undone in AlCal only by re-creating it, so confirm deletions with the user.',
      };
    },
  },
  {
    name: 'list_events',
    description: 'Calendar agenda between two dates, with repeating events expanded into occurrences. Also returns planner items due in the range. Default range: today plus 7 days.',
    inputSchema: {
      type: 'object', properties: {
        from: S('string', 'First day YYYY-MM-DD (or a date-time). Default today'),
        to: S('string', 'Last day YYYY-MM-DD, inclusive (or a date-time, exclusive). Default from + 7 days'),
        query: S('string', 'Only events whose title, location or notes contain this text'),
        category: S('string', 'Only this category'),
        ...TZ,
      },
    },
    annotations: { title: 'List events', readOnlyHint: true },
    run(ctx, a) {
      const f = a.from ? parseWhen(a.from, ctx.tz, 'from') : { ms: fromWall(keyWall(dateKey(ctx.now, ctx.tz)), ctx.tz), dateOnly: true };
      let t;
      if (a.to) { const p = parseWhen(a.to, ctx.tz, 'to'); t = p.dateOnly ? fromWall(keyWall(p.key) + DAY, ctx.tz) : p.ms; }
      else t = fromWall(toWall(f.ms, ctx.tz) + 8 * DAY, ctx.tz);
      if (!(t > f.ms)) throw new Error('"to" must be after "from"');
      if (t - f.ms > 400 * DAY) throw new Error('Please ask for at most about a year at a time');
      let evs = live(ctx.db.all('events'));
      if (a.category) { const c = resolveCat(ctx, a.category); evs = evs.filter(e => (e.cat || 'blue') === c); }
      if (a.query) { const q = norm(a.query); evs = evs.filter(e => [e.title, e.location, e.notes].some(s => norm(s).includes(q))); }
      const occ = occurrences(evs, f.ms, t, ctx.tz);
      const fk = dateKey(f.ms, ctx.tz), tk = dateKey(t - 1, ctx.tz);
      const due = live(ctx.db.all('cards')).filter(x => isKey(x.due) && x.due >= fk && x.due <= tk).map(x => [x, ctx.db.get('projects', x.projectId)])
        .filter(([x, p]) => p && !p.deleted && !isDone(p, x) && (!a.query || norm(x.title).includes(norm(a.query)))).sort((a, b) => a[0].due < b[0].due ? -1 : 1);
      return {
        timezone: ctx.tz, from: localIso(f.ms, ctx.tz), to: localIso(t, ctx.tz),
        events: occ.slice(0, 400).map(o => occOut(ctx, o)), truncated: occ.length > 400 || undefined,
        planner_items_due: due.slice(0, 100).map(([x, p]) => cardOut(ctx, x, p)),
      };
    },
  },
  {
    name: 'find_free_time',
    description: 'Free slots between timed events, day by day, within working hours. All-day events do not block time.',
    inputSchema: {
      type: 'object', properties: {
        from: S('string', 'First day YYYY-MM-DD. Default today'),
        to: S('string', 'Last day YYYY-MM-DD, inclusive. Default from + 6 days'),
        min_minutes: S('number', 'Shortest useful slot (default 30)'),
        day_start: S('string', 'Start of the day HH:MM (default 09:00)'),
        day_end: S('string', 'End of the day HH:MM (default 18:00)'),
        ...TZ,
      },
    },
    annotations: { title: 'Find free time', readOnlyHint: true },
    run(ctx, a) {
      const fk = a.from ? parseWhen(a.from, ctx.tz, 'from').key : dateKey(ctx.now, ctx.tz);
      const tk = a.to ? parseWhen(a.to, ctx.tz, 'to').key : wkey(keyWall(fk) + 6 * DAY);
      const hm = (s, d) => { const m = String(s || d).match(/^(\d{1,2}):(\d{2})$/); if (!m) throw new Error('day_start / day_end must be HH:MM'); return (+m[1] * 60 + +m[2]) * MIN; };
      const ds = hm(a.day_start, '09:00'), de = hm(a.day_end, '18:00'), min = Math.max(5, Number(a.min_minutes) || 30) * MIN;
      if (keyWall(tk) - keyWall(fk) > 62 * DAY) throw new Error('Please ask for at most two months at a time');
      const occ = occurrences(live(ctx.db.all('events')), fromWall(keyWall(fk), ctx.tz), fromWall(keyWall(tk) + DAY, ctx.tz), ctx.tz).filter(o => !o.ev.allDay);
      const days = [];
      for (let w = keyWall(fk); w <= keyWall(tk); w += DAY) {
        const a0 = Math.max(fromWall(w + ds, ctx.tz), ctx.now), b0 = fromWall(w + de, ctx.tz);
        const busy = occ.filter(o => o.s < b0 && o.e > a0).map(o => [Math.max(o.s, a0), Math.min(o.e, b0)]).sort((x, y) => x[0] - y[0]);
        const free = []; let cur = a0;
        for (const [s, e] of busy) { if (s - cur >= min) free.push([cur, s]); cur = Math.max(cur, e); }
        if (b0 - cur >= min) free.push([cur, b0]);
        if (a0 < b0) days.push({ date: wkey(w), weekday: WD[new Date(w).getUTCDay()], free: free.map(([s, e]) => `${hhmm(s, ctx.tz)}-${hhmm(e, ctx.tz)}`) });
      }
      return { timezone: ctx.tz, days };
    },
  },
  {
    name: 'get_event',
    description: 'Full details of one event (the whole series for a repeating event).',
    inputSchema: { type: 'object', required: ['id'], properties: { id: S('string', 'Event id'), ...TZ } },
    annotations: { title: 'Get event', readOnlyHint: true },
    run(ctx, a) { return eventOut(ctx, findEvent(ctx, a.id)); },
  },
  {
    name: 'create_event',
    description: 'Add an event to the calendar. Times are in the user\'s time zone unless they carry an offset. Default length 60 minutes; default reminder 15 minutes for timed events.',
    inputSchema: { type: 'object', required: ['title', 'start'], properties: { ...EVENT_FIELDS, ...TZ } },
    annotations: { title: 'Create event', readOnlyHint: false, destructiveHint: false },
    run(ctx, a) {
      if (!String(a.title || '').trim()) throw new Error('Please give the event a title');
      const d = { id: uid(), title: '', allDay: false, start: 0, end: 0, sd: '', ed: '', cat: 'blue', location: '', notes: '', repeat: { freq: 'none' }, exdates: [], createdAt: Date.now(), reminder: null };
      const s = parseWhen(a.start, ctx.tz, 'start');
      if (a.all_day === undefined) a = { ...a, all_day: s.dateOnly };
      if (!a.all_day && s.dateOnly) a = { ...a, start: s.key + 'T09:00' };
      d.start = s.ms; d.end = s.ms; d.sd = s.key; d.ed = s.key;
      applyEventFields(ctx, d, { duration_minutes: a.end === undefined && a.duration_minutes === undefined ? 60 : a.duration_minutes, ...a }, true);
      saveEvent(ctx, d);
      return { created: eventOut(ctx, d) };
    },
  },
  {
    name: 'update_event',
    description: 'Change an event. For a repeating event, scope "series" (default) changes every occurrence; scope "occurrence" with occurrence_date changes only that day, which becomes a separate event (as in the app). Only the fields given are changed; a new start without an end keeps the length.',
    inputSchema: {
      type: 'object', required: ['id'], properties: {
        id: S('string', 'Event id'),
        scope: S('string', 'For repeating events', { enum: ['series', 'occurrence'] }),
        occurrence_date: S('string', 'YYYY-MM-DD of the occurrence to change (scope "occurrence")'),
        ...EVENT_FIELDS, ...TZ,
      },
    },
    annotations: { title: 'Update event', readOnlyHint: false, destructiveHint: false },
    run(ctx, a) {
      const ev = findEvent(ctx, a.id);
      const rec = ev.repeat && ev.repeat.freq && ev.repeat.freq !== 'none';
      if (rec && (a.scope === 'occurrence' || (a.occurrence_date && a.scope !== 'series'))) {
        checkOccurrence(ctx, ev, a.occurrence_date);
        const o = occurrences([ev], fromWall(keyWall(a.occurrence_date), ctx.tz), fromWall(keyWall(a.occurrence_date) + DAY, ctx.tz), ctx.tz).find(o => o.key === a.occurrence_date);
        const d = JSON.parse(JSON.stringify(ev));
        Object.assign(d, { id: uid(), repeat: { freq: 'none' }, exdates: [], createdAt: Date.now(), start: o.s, end: o.e, sd: o.key, ed: dateKey(o.e - (ev.allDay ? 1 : 0), ctx.tz) });
        delete d.updatedAt; delete d.deleted;
        const { repeat, ...rest } = a;
        applyEventFields(ctx, d, rest, false);
        ev.exdates = [...new Set([...(ev.exdates || []), a.occurrence_date])];
        saveEvent(ctx, ev); saveEvent(ctx, d);
        return { updated_occurrence: eventOut(ctx, d), series: ev.id };
      }
      const d = JSON.parse(JSON.stringify(ev));
      applyEventFields(ctx, d, a, false);
      if (a.repeat !== undefined && (!d.repeat || d.repeat.freq === 'none')) d.exdates = [];
      saveEvent(ctx, d);
      return { updated: eventOut(ctx, d) };
    },
  },
  {
    name: 'delete_event',
    description: 'Delete an event. For a repeating event, give occurrence_date to skip just that day; without it the whole series is deleted. Confirm with the user first.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: S('string', 'Event id'), occurrence_date: S('string', 'YYYY-MM-DD of one occurrence to remove'), ...TZ } },
    annotations: { title: 'Delete event', readOnlyHint: false, destructiveHint: true },
    run(ctx, a) {
      const ev = findEvent(ctx, a.id);
      const rec = ev.repeat && ev.repeat.freq && ev.repeat.freq !== 'none';
      if (rec && a.occurrence_date) {
        checkOccurrence(ctx, ev, a.occurrence_date);
        ev.exdates = [...new Set([...(ev.exdates || []), a.occurrence_date])];
        saveEvent(ctx, ev);
        return { removed_occurrence: a.occurrence_date, series: ev.title };
      }
      ev.deleted = true; saveEvent(ctx, ev);
      return { deleted: ev.title || '(No title)', id: ev.id };
    },
  },
  {
    name: 'list_planner',
    description: 'Planner (kanban) items. With a project: its columns and items. Without: items across all projects. Items in the last (done) column are left out unless include_done is true.',
    inputSchema: {
      type: 'object', properties: {
        project: S('string', 'Project name or id'),
        column: S('string', 'Only this column'),
        query: S('string', 'Only items whose title or notes contain this text'),
        include_done: S('boolean', 'Include items in the done column (default false)'),
      },
    },
    annotations: { title: 'List planner items', readOnlyHint: true },
    run(ctx, a) {
      const ps = a.project ? [findProject(ctx, a.project)] : live(ctx.db.all('projects')).sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
      const cards = live(ctx.db.all('cards')), q = a.query && norm(a.query);
      return {
        projects: ps.map(p => {
          const cols = a.column ? [findColumn(p, a.column)] : p.columns;
          return {
            id: p.id, name: p.name,
            columns: cols.map((c, i) => {
              const done = c.id === p.columns[p.columns.length - 1].id;
              let its = cards.filter(x => x.projectId === p.id && x.col === c.id).sort((x, y) => (x.order || 0) - (y.order || 0));
              if (q) its = its.filter(x => norm(x.title).includes(q) || norm(x.notes).includes(q));
              const o = { name: c.name, count: its.length };
              if (!done || a.include_done || a.column) o.items = its.slice(0, 200).map(x => cardOut(ctx, x, p));
              if (done) o.is_done_column = true;
              return o;
            }),
          };
        }),
      };
    },
  },
  {
    name: 'create_project',
    description: 'Create a planner project. Default columns: Backlog, In progress, In review, Done. The last column counts as done.',
    inputSchema: { type: 'object', required: ['name'], properties: { name: S('string', 'Project name'), columns: S('array', 'Column names, in order', { items: { type: 'string' } }) } },
    annotations: { title: 'Create project', readOnlyHint: false, destructiveHint: false },
    run(ctx, a) {
      const name = String(a.name || '').trim(); if (!name) throw new Error('Please give the project a name');
      const cols = Array.isArray(a.columns) && a.columns.filter(s => String(s).trim()).length ? a.columns.map(s => String(s).trim()).filter(Boolean) : ['Backlog', 'In progress', 'In review', 'Done'];
      const p = { id: uid(), name: name.slice(0, 200), columns: cols.slice(0, 12).map(n => ({ id: uid(), name: n.slice(0, 80) })), createdAt: Date.now(), noReady: true };
      ctx.db.put('projects', p);
      return { created: { id: p.id, name: p.name, columns: p.columns.map(c => c.name) } };
    },
  },
  {
    name: 'update_project',
    description: 'Rename a project, rename a column, or add columns (added before the done column unless at_end is true).',
    inputSchema: {
      type: 'object', required: ['project'], properties: {
        project: S('string', 'Project name or id'),
        name: S('string', 'New project name'),
        rename_column: S('object', 'Rename one column', { properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] }),
        add_columns: S('array', 'New column names', { items: { type: 'string' } }),
        at_end: S('boolean', 'Add the new columns after the done column (they then become the done column)'),
      },
    },
    annotations: { title: 'Update project', readOnlyHint: false, destructiveHint: false },
    run(ctx, a) {
      const p = JSON.parse(JSON.stringify(findProject(ctx, a.project)));
      if (a.name !== undefined && String(a.name).trim()) p.name = String(a.name).trim().slice(0, 200);
      if (a.rename_column) { const c = findColumn(p, a.rename_column.from); if (String(a.rename_column.to || '').trim()) c.name = String(a.rename_column.to).trim().slice(0, 80); }
      if (Array.isArray(a.add_columns)) {
        const add = a.add_columns.map(s => String(s).trim()).filter(Boolean).map(n => ({ id: uid(), name: n.slice(0, 80) }));
        if (a.at_end || !p.columns.length) p.columns.push(...add); else p.columns.splice(p.columns.length - 1, 0, ...add);
      }
      ctx.db.put('projects', p);
      return { updated: { id: p.id, name: p.name, columns: p.columns.map(c => c.name) } };
    },
  },
  {
    name: 'create_item',
    description: 'Add an item to a planner project. Goes into the first column (Backlog) unless a column is given.',
    inputSchema: {
      type: 'object', required: ['project', 'title'], properties: {
        project: S('string', 'Project name or id'),
        title: S('string', 'Item title'),
        column: S('string', 'Column name, e.g. "In progress"'),
        due: S(['string', 'null'], 'Due date YYYY-MM-DD'),
        priority: S('string', 'Priority', { enum: PRIORITIES }),
        notes: S('string', 'Notes'),
        reminder: S('string', 'Push reminder at 09:00 relative to the due date', { enum: Object.keys(CARD_REM) }),
        ...TZ,
      },
    },
    annotations: { title: 'Create planner item', readOnlyHint: false, destructiveHint: false },
    run(ctx, a) {
      const p = findProject(ctx, a.project), c = findColumn(p, a.column);
      const title = String(a.title || '').trim(); if (!title) throw new Error('Please give the item a title');
      const x = { id: uid(), projectId: p.id, col: c.id, title: title.slice(0, 500), notes: '', due: null, priority: 'none', order: lastOrder(ctx, p.id, c.id) + 1, createdAt: Date.now() };
      cardFields(ctx, x, a);
      saveCard(ctx, x);
      return { created: cardOut(ctx, x, p) };
    },
  },
  {
    name: 'update_item',
    description: 'Change a planner item: title, notes, due date, priority, reminder, or move it to another column or project (moving to the last column marks it done).',
    inputSchema: {
      type: 'object', required: ['id'], properties: {
        id: S('string', 'Item id (or its exact title)'),
        title: S('string', 'New title'),
        project: S('string', 'Move to this project'),
        column: S('string', 'Move to this column'),
        due: S(['string', 'null'], 'Due date YYYY-MM-DD, or null to clear'),
        priority: S('string', 'Priority', { enum: PRIORITIES }),
        notes: S('string', 'Notes (replaces the existing notes)'),
        reminder: S('string', 'Reminder relative to the due date', { enum: Object.keys(CARD_REM) }),
        ...TZ,
      },
    },
    annotations: { title: 'Update planner item', readOnlyHint: false, destructiveHint: false },
    run(ctx, a) {
      const x0 = findBy(ctx.db.all('cards'), a.id, 'item', x => x.title);
      const x = JSON.parse(JSON.stringify(x0));
      if (a.title !== undefined && String(a.title).trim()) x.title = String(a.title).trim().slice(0, 500);
      if (a.project !== undefined || a.column !== undefined) {
        const p = a.project !== undefined ? findProject(ctx, a.project) : ctx.db.get('projects', x.projectId);
        if (!p || p.deleted) throw new Error('This item\'s project no longer exists; give a project');
        const c = a.column !== undefined ? findColumn(p, a.column) : (p.columns.find(c => c.id === x.col) || p.columns[0]);
        if (p.id !== x.projectId || c.id !== x.col) { x.projectId = p.id; x.col = c.id; x.order = lastOrder(ctx, p.id, c.id, x.id) + 1; }
      }
      cardFields(ctx, x, a);
      saveCard(ctx, x);
      return { updated: cardOut(ctx, x) };
    },
  },
  {
    name: 'delete_item',
    description: 'Delete a planner item. Confirm with the user first.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: S('string', 'Item id') } },
    annotations: { title: 'Delete planner item', readOnlyHint: false, destructiveHint: true },
    run(ctx, a) {
      const x = JSON.parse(JSON.stringify(findBy(ctx.db.all('cards'), a.id, 'item', x => x.title)));
      x.deleted = true; saveCard(ctx, x);
      return { deleted: x.title, id: x.id };
    },
  },
  {
    name: 'list_items',
    description: 'Items on the Purchase, Reading or Ideas lists. Ticked (bought / read) items are left out unless include_done is true.',
    inputSchema: {
      type: 'object', required: ['list'], properties: {
        list: S('string', 'Which list', { enum: Object.keys(SECTIONS) }),
        category: S('string', 'Only this category, e.g. "Tech" or "Academic Books"'),
        query: S('string', 'Only items whose title, author or description contain this text'),
        include_done: S('boolean', 'Include ticked items (default false)'),
      },
    },
    annotations: { title: 'List items', readOnlyHint: true },
    run(ctx, a) {
      const key = findSection(a.list), s = SECTIONS[key];
      const cat = a.category ? findListCat(key, a.category) : null, q = a.query && norm(a.query);
      let its = live(ctx.db.all('lists')).filter(x => x.section === key && (!cat || x.cat === cat) && (a.include_done || !s.tick || !x.done));
      if (q) its = its.filter(x => [x.title, x.author, x.desc].some(v => norm(v).includes(q)));
      const order = s.cats.map(c => c[0]);
      its.sort((x, y) => (order.indexOf(x.cat) - order.indexOf(y.cat)) || (!!x.done - !!y.done) || ((x.order || 0) - (y.order || 0)));
      return { list: s.name, items: its.slice(0, 300).map(listOut), truncated: its.length > 300 || undefined };
    },
  },
  {
    name: 'add_list_item',
    description: 'Add something to the Purchase, Reading or Ideas list.',
    inputSchema: {
      type: 'object', required: ['list', 'category', 'title'], properties: {
        list: S('string', 'Which list', { enum: Object.keys(SECTIONS) }),
        category: S('string', 'Category within the list (see get_overview)'),
        title: S('string', 'Title'),
        author: S('string', 'Author (Reading list)'),
        description: S('string', 'Description (Ideas list)'),
      },
    },
    annotations: { title: 'Add list item', readOnlyHint: false, destructiveHint: false },
    run(ctx, a) {
      const key = findSection(a.list), cat = findListCat(key, a.category);
      const title = String(a.title || '').trim(); if (!title) throw new Error('Please give a title');
      const order = live(ctx.db.all('lists')).filter(x => x.section === key && x.cat === cat).reduce((m, x) => Math.max(m, x.order || 0), 0) + 1;
      const x = { id: uid(), section: key, cat, title: title.slice(0, 500), author: String(a.author || '').trim().slice(0, 200), desc: String(a.description || '').slice(0, 5000), done: false, order, createdAt: Date.now() };
      ctx.db.put('lists', x);
      return { created: listOut(x) };
    },
  },
  {
    name: 'update_list_item',
    description: 'Change a list item: title, author, description, category, or tick / untick it (done).',
    inputSchema: {
      type: 'object', required: ['id'], properties: {
        id: S('string', 'Item id (or its exact title)'),
        title: S('string', 'New title'), author: S('string', 'Author'), description: S('string', 'Description'),
        category: S('string', 'Move to this category'), done: S('boolean', 'Ticked (bought / read)'),
      },
    },
    annotations: { title: 'Update list item', readOnlyHint: false, destructiveHint: false },
    run(ctx, a) {
      const x = JSON.parse(JSON.stringify(findBy(ctx.db.all('lists'), a.id, 'list item', x => x.title)));
      if (a.title !== undefined && String(a.title).trim()) x.title = String(a.title).trim().slice(0, 500);
      if (a.author !== undefined) x.author = String(a.author || '').trim().slice(0, 200);
      if (a.description !== undefined) x.desc = String(a.description || '').slice(0, 5000);
      if (a.category !== undefined) {
        const cat = findListCat(x.section, a.category);
        if (cat !== x.cat) { x.cat = cat; x.order = live(ctx.db.all('lists')).filter(y => y.section === x.section && y.cat === cat).reduce((m, y) => Math.max(m, y.order || 0), 0) + 1; }
      }
      if (a.done !== undefined && SECTIONS[x.section] && SECTIONS[x.section].tick) { x.done = !!a.done; x.doneAt = x.done ? Date.now() : null; }
      ctx.db.put('lists', x);
      return { updated: listOut(x) };
    },
  },
  {
    name: 'delete_list_item',
    description: 'Delete a list item. Confirm with the user first.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: S('string', 'Item id') } },
    annotations: { title: 'Delete list item', readOnlyHint: false, destructiveHint: true },
    run(ctx, a) {
      const x = JSON.parse(JSON.stringify(findBy(ctx.db.all('lists'), a.id, 'list item', x => x.title)));
      x.deleted = true; ctx.db.put('lists', x);
      return { deleted: x.title, id: x.id };
    },
  },
];

function cardFields(ctx, x, a) {
  if (a.notes !== undefined) x.notes = String(a.notes || '').slice(0, 20000);
  if (a.priority !== undefined) { if (!PRIORITIES.includes(a.priority)) throw new Error(`priority must be one of ${PRIORITIES.join(', ')}`); x.priority = a.priority; }
  if (a.due !== undefined) x.due = a.due === null || a.due === '' ? null : parseWhen(String(a.due), ctx.tz, 'due').key;
  if (a.reminder !== undefined) {
    if (!(a.reminder in CARD_REM)) throw new Error(`reminder must be one of ${Object.keys(CARD_REM).join(', ')}`);
    x.remind = CARD_REM[a.reminder];
  }
}

/* ---------- JSON-RPC ---------- */
const INSTRUCTIONS = 'AlCal is the user\'s own calendar and planner app. Call get_overview first to learn the current date, time zone, categories, projects and lists. ' +
  'Write times as local "YYYY-MM-DDTHH:MM" in that time zone, or add an offset when the user names another zone. ' +
  'Use list_events / list_planner / list_items to find ids before changing or deleting. Confirm before deleting anything. ' +
  'Changes appear on the user\'s devices within about a minute while AlCal is open.';

async function one(msg, db) {
  const id = msg && msg.id;
  const isNote = !msg || id === undefined || id === null;
  const reply = result => (isNote ? null : { jsonrpc: '2.0', id, result });
  const fail = (code, message) => (isNote ? null : { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request');
  switch (msg.method) {
    case 'initialize': {
      const want = msg.params && msg.params.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'alcal', title: 'AlCal', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const p = msg.params || {}, tool = TOOLS.find(t => t.name === p.name);
      if (!tool) return fail(-32602, `Unknown tool: ${p.name}`);
      try {
        const args = p.arguments && typeof p.arguments === 'object' ? p.arguments : {};
        const out = tool.run(context(db, args), args);
        return reply({ content: [{ type: 'text', text: JSON.stringify(out) }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: 'Error: ' + ((e && e.message) || e) }], isError: true });
      }
    }
    case 'resources/list': return reply({ resources: [] });
    case 'prompts/list': return reply({ prompts: [] });
    default:
      if (msg.method.startsWith('notifications/')) return null;
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(body, db) {
  if (Array.isArray(body)) {
    const out = [];
    for (const m of body) { const r = await one(m, db); if (r) out.push(r); }
    return out.length ? out : null;
  }
  return one(body, db);
}

// The connector address is /mcp/<token>; the token is derived from the sync key, so it changes with it.
export async function connectorToken(syncKey) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('alcal-connector\n' + syncKey));
  return [...new Uint8Array(h)].slice(0, 20).map(b => b.toString(16).padStart(2, '0')).join('');
}

export const _test = { occurrences, parseWhen, toWall, fromWall, TOOLS };
