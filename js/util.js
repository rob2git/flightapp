// Time zone helpers. Everything is stored as epoch milliseconds and shown in the airport's own zone.

const dtfCache = new Map();
function dtf(tz, opts, key) {
  const k = tz + '|' + key;
  if (!dtfCache.has(k)) {
    try { dtfCache.set(k, new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts })); }
    catch { dtfCache.set(k, new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts })); }
  }
  return dtfCache.get(k);
}

const PARTS = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' };

/** Offset (ms) of `tz` from UTC at the instant `epoch`. */
export function tzOffsetMs(epoch, tz) {
  const p = {};
  for (const x of dtf(tz, PARTS, 'parts').formatToParts(new Date(epoch))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(epoch / 1000) * 1000;
}

/** Interpret "YYYY-MM-DD[T ]HH:MM[:SS]" as a wall-clock time in `tz`. Returns epoch ms. */
export function wallToEpoch(str, tz) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?/.exec(str || '');
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const e1 = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(e1, tz);
}

export function fmtTime(epoch, tz) {
  if (epoch == null) return '--:--';
  return dtf(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, 'time').format(new Date(epoch));
}

export function fmtDay(epoch, tz) {
  if (epoch == null) return '';
  return dtf(tz, { weekday: 'short', day: 'numeric', month: 'short' }, 'day').format(new Date(epoch));
}

export function localDateKey(epoch, tz) {
  const p = {};
  for (const x of dtf(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }, 'key').formatToParts(new Date(epoch))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

export function dayShift(epoch, fromTz, toTz) {
  const a = Date.parse(localDateKey(epoch, fromTz));
  const b = Date.parse(localDateKey(epoch, toTz));
  return Math.round((b - a) / 86400000);
}

export function tzLabel(epoch, tz) {
  const part = dtf(tz, { timeZoneName: 'short' }, 'tzname').formatToParts(new Date(epoch)).find((x) => x.type === 'timeZoneName');
  return part ? part.value : tz;
}

export function fmtDur(min) {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60), m = min % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

export function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export function normIdent(s) {
  return (s || '').toUpperCase().replace(/[\s-]+/g, '');
}
export const IDENT_RE = /^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/;

export function prettyIdent(s) {
  const m = /^([A-Z0-9]{2,3}?)(\d{1,4}[A-Z]?)$/.exec(s);
  return m ? `${m[1]} ${m[2]}` : s;
}
