import { airportInfo } from './airports.js';
import { wallToEpoch, hash, localDateKey } from './util.js';

/*
 * Every provider returns the same shape:
 * {
 *   source, status, airline, ident,
 *   dep: { iata, name, city, tz, sched, est, actual, terminal, gate },
 *   arr: { iata, name, city, tz, sched, est, actual, terminal, gate, baggage },
 *   aircraft: { reg, model } | null,
 *   live: { lat, lon, altFt, speedKt } | null,
 *   track: [{ lat, lon, t, altFt }] | null,   the path flown so far, when the provider has one
 *   distanceKm, updatedAt
 * }
 * Times are epoch milliseconds. Status is one of:
 * scheduled, checkin, boarding, departed, approaching, landed, cancelled, diverted, unknown
 */

export class ProviderError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

export const PROVIDERS = {
  demo: { label: 'Demo (simulated)', needsKey: false },
  adb_rapid: { label: 'AeroDataBox via RapidAPI', needsKey: true },
  adb_market: { label: 'AeroDataBox via API.Market', needsKey: true },
  aviationstack: { label: 'AviationStack', needsKey: true },
  aeroapi: { label: 'FlightAware AeroAPI', needsKey: true },
};

export async function fetchFlight(spec, settings) {
  switch (settings.provider) {
    case 'adb_rapid':
    case 'adb_market': return aeroDataBox(spec, settings);
    case 'aviationstack': return aviationStack(spec, settings);
    case 'aeroapi': return aeroApi(spec, settings);
    default: return demoSnapshot(spec);
  }
}

/* ---------- shared fetch ---------- */

async function getJson(url, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let res;
  try {
    res = await fetch(url, { headers, signal: ctl.signal, cache: 'no-store' });
  } catch (e) {
    if (e.name === 'AbortError') throw new ProviderError('network', 'The provider took too long to answer.');
    throw new ProviderError('network', 'Could not reach the provider. You may be offline, or the provider blocks requests from browsers (see the User guide, "The proxy address").');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204 || res.status === 404) return { status: res.status, body: null };
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body };
}

function httpError(status, body) {
  const msg = body && (body.message || body.detail || body.reason || (body.error && body.error.message));
  const detail = msg ? ` ${msg}` : '';
  if (status === 401) return new ProviderError('auth', 'The provider rejected your API key (HTTP 401). Check it in Settings.');
  if (status === 403) return new ProviderError('auth', `Access denied (HTTP 403). Your plan may not include this lookup.${detail}`);
  if (status === 429) return new ProviderError('rate', 'Rate limit or monthly quota reached (HTTP 429). Try again later or lower auto-refresh.');
  if (status === 400) return new ProviderError('other', `The provider refused the request (HTTP 400).${detail}`);
  return new ProviderError('other', `Provider error (HTTP ${status}).${detail}`);
}

/* ---------- AeroDataBox ---------- */

const ADB_STATUS = {
  Expected: 'scheduled', Unknown: 'unknown', CheckIn: 'checkin', Boarding: 'boarding', GateClosed: 'boarding',
  Delayed: 'scheduled', Departed: 'departed', EnRoute: 'departed', Approaching: 'approaching', Arrived: 'landed',
  Canceled: 'cancelled', CanceledUncertain: 'cancelled', Diverted: 'diverted',
};

function adbTime(x) {
  const s = x && x.utc;
  if (!s) return null;
  const t = Date.parse(String(s).replace(' ', 'T'));
  return Number.isNaN(t) ? null : t;
}

function adbLeg(l) {
  const a = (l && l.airport) || {};
  const iata = (a.iata || '').toUpperCase();
  const known = airportInfo(iata);
  return {
    iata,
    name: a.shortName || a.name || (known && known.name) || iata,
    city: a.municipalityName || (known && known.city) || '',
    tz: a.timeZone || (known && known.tz) || 'UTC',
    sched: adbTime(l && l.scheduledTime),
    est: adbTime(l && (l.revisedTime || l.predictedTime)),
    actual: adbTime(l && l.runwayTime),
    terminal: (l && l.terminal) || '',
    gate: (l && l.gate) || '',
    baggage: (l && l.baggageBelt) || '',
  };
}

async function aeroDataBox(spec, s) {
  if (!s.apiKey) throw new ProviderError('auth', 'Add your API key in Settings to get live data.');
  const rapid = s.provider === 'adb_rapid';
  const base = (s.proxy || (rapid ? 'https://aerodatabox.p.rapidapi.com' : 'https://prod.api.market/api/v1/aedbx/aerodatabox')).replace(/\/+$/, '');
  const headers = rapid
    ? { 'X-RapidAPI-Key': s.apiKey, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' }
    : { 'x-api-market-key': s.apiKey };
  const url = `${base}/flights/number/${encodeURIComponent(spec.ident)}/${spec.date}`;

  let r = await getJson(`${url}?withLocation=true`, headers);
  if ((r.status === 400 || r.status === 403) && r.body) r = await getJson(url, headers); // plan without location data
  if (r.status === 204 || r.status === 404 || (Array.isArray(r.body) && r.body.length === 0)) {
    throw new ProviderError('notfound', 'No flight with this number was found for that date. Check the number and the local date.');
  }
  if (r.status >= 400) throw httpError(r.status, r.body);
  const list = Array.isArray(r.body) ? r.body : [];

  const ok = (code, want) => !want || !code || code.toUpperCase() === want;
  const matches = list.filter((f) => ok(f.departure && f.departure.airport && f.departure.airport.iata, spec.from)
    && ok(f.arrival && f.arrival.airport && f.arrival.airport.iata, spec.to));
  if (!matches.length) {
    const seen = list.map((f) => `${(f.departure && f.departure.airport && f.departure.airport.iata) || '?'}→${(f.arrival && f.arrival.airport && f.arrival.airport.iata) || '?'}`).join(', ');
    throw new ProviderError('notfound', `${spec.ident} exists on that date but not as ${spec.from}→${spec.to}. Found: ${seen}.`);
  }
  const f = matches.find((x) => String(x.departure && x.departure.scheduledTime && x.departure.scheduledTime.local || '').startsWith(spec.date)) || matches[0];

  const loc = f.location;
  return {
    source: 'AeroDataBox',
    status: ADB_STATUS[f.status] || 'unknown',
    airline: (f.airline && f.airline.name) || '',
    ident: f.number || spec.ident,
    dep: adbLeg(f.departure),
    arr: adbLeg(f.arrival),
    aircraft: f.aircraft ? { reg: f.aircraft.reg || '', model: f.aircraft.model || '' } : null,
    live: loc && typeof loc.lat === 'number'
      ? { lat: loc.lat, lon: loc.lon, altFt: loc.altitude && loc.altitude.feet != null ? loc.altitude.feet : (loc.pressureAltitude && loc.pressureAltitude.feet) ?? null, speedKt: loc.groundSpeed && loc.groundSpeed.kt != null ? loc.groundSpeed.kt : null }
      : null,
    distanceKm: f.greatCircleDistance && f.greatCircleDistance.km != null ? f.greatCircleDistance.km : null,
    updatedAt: f.lastUpdatedUtc ? Date.parse(String(f.lastUpdatedUtc).replace(' ', 'T')) || Date.now() : Date.now(),
  };
}

/* ---------- AviationStack ---------- */

const AVS_STATUS = { scheduled: 'scheduled', active: 'departed', landed: 'landed', cancelled: 'cancelled', incident: 'unknown', diverted: 'diverted' };

// AviationStack labels airport-local clock times with a "+00:00" offset, so the clock
// digits are read in the airport's own time zone and the offset is ignored.
function avsLeg(l, extra = {}) {
  l = l || {};
  const iata = (l.iata || '').toUpperCase();
  const known = airportInfo(iata);
  const tz = l.timezone || (known && known.tz) || 'UTC';
  return {
    iata,
    name: l.airport || (known && known.name) || iata,
    city: (known && known.city) || '',
    tz,
    sched: wallToEpoch(l.scheduled, tz),
    est: wallToEpoch(l.estimated, tz),
    actual: wallToEpoch(l.actual_runway || l.actual, tz),
    terminal: l.terminal || '',
    gate: l.gate || '',
    baggage: extra.baggage ? (l.baggage || '') : '',
  };
}

async function aviationStack(spec, s) {
  if (!s.apiKey) throw new ProviderError('auth', 'Add your API key in Settings to get live data.');
  const base = (s.proxy || 'https://api.aviationstack.com/v1').replace(/\/+$/, '');
  const icao = /^[A-Z]{3}\d/.test(spec.ident);

  const call = async (withDate) => {
    const q = new URLSearchParams({ access_key: s.apiKey, [icao ? 'flight_icao' : 'flight_iata']: spec.ident, limit: '100' });
    if (spec.from) q.set('dep_iata', spec.from);
    if (spec.to) q.set('arr_iata', spec.to);
    if (withDate) q.set('flight_date', spec.date);
    return getJson(`${base}/flights?${q}`);
  };

  let r = await call(true);
  const code = r.body && r.body.error && r.body.error.code;
  if (code === 'function_access_restricted' || code === 'invalid_flight_date') r = await call(false); // plan without date filter
  if (r.body && r.body.error) {
    const e = r.body.error;
    if (['invalid_access_key', 'missing_access_key', 'inactive_user'].includes(e.code)) throw new ProviderError('auth', 'AviationStack rejected your access key. Check it in Settings.');
    if (['usage_limit_reached', 'rate_limit_reached'].includes(e.code)) throw new ProviderError('rate', 'AviationStack quota reached for this period. Try again later or lower auto-refresh.');
    if (e.code === 'https_access_restricted') throw new ProviderError('auth', 'AviationStack refused the secure (HTTPS) connection for this key. Check your plan on your AviationStack dashboard.');
    throw new ProviderError('other', `AviationStack: ${e.message || e.code || 'request failed'}`);
  }
  if (r.status >= 400) throw httpError(r.status, r.body);

  const list = (r.body && r.body.data) || [];
  if (!list.length) throw new ProviderError('notfound', 'No matching flight was found. Check the number, date and airports.');
  const f = list.find((x) => x.flight_date === spec.date) || list[0];
  if (f.flight_date && f.flight_date !== spec.date) {
    throw new ProviderError('notfound', `The closest match is on ${f.flight_date}, not ${spec.date}. Your plan may not include other dates.`);
  }
  const lv = f.live;
  return {
    source: 'AviationStack',
    status: AVS_STATUS[f.flight_status] || 'unknown',
    airline: (f.airline && f.airline.name) || '',
    ident: (f.flight && (f.flight.iata || f.flight.icao)) || spec.ident,
    dep: avsLeg(f.departure),
    arr: avsLeg(f.arrival, { baggage: true }),
    aircraft: f.aircraft ? { reg: f.aircraft.registration || '', model: f.aircraft.iata || '' } : null,
    live: lv && lv.latitude != null
      ? { lat: lv.latitude, lon: lv.longitude, altFt: lv.altitude != null ? Math.round(lv.altitude * 3.28084) : null, speedKt: lv.speed_horizontal != null ? Math.round(lv.speed_horizontal / 1.852) : null }
      : null,
    distanceKm: null,
    updatedAt: lv && lv.updated ? Date.parse(lv.updated) || Date.now() : Date.now(),
  };
}

/* ---------- FlightAware AeroAPI ---------- */

const FA_BASE = 'https://aeroapi.flightaware.com/aeroapi';

function faTime(x) {
  const t = x ? Date.parse(x) : NaN;
  return Number.isNaN(t) ? null : t;
}

function faLeg(a, kind, f) {
  a = a || {};
  const iata = (a.code_iata || a.code || '').toUpperCase();
  const known = airportInfo(iata);
  const dep = kind === 'dep';
  // Gate times (out/in) drive what is shown; runway times (off/on) fill in when gate times are missing.
  return {
    iata,
    name: a.name || (known && known.name) || iata,
    city: a.city || (known && known.city) || '',
    tz: a.timezone || (known && known.tz) || 'UTC',
    sched: faTime(dep ? f.scheduled_out : f.scheduled_in) ?? faTime(dep ? f.scheduled_off : f.scheduled_on),
    est: faTime(dep ? f.estimated_out : f.estimated_in) ?? faTime(dep ? f.estimated_off : f.estimated_on),
    actual: faTime(dep ? f.actual_out : f.actual_in) ?? faTime(dep ? f.actual_off : f.actual_on),
    terminal: (dep ? f.terminal_origin : f.terminal_destination) || '',
    gate: (dep ? f.gate_origin : f.gate_destination) || '',
    baggage: dep ? '' : (f.baggage_claim || ''),
  };
}

function faStatus(f) {
  if (f.cancelled) return 'cancelled';
  if (f.diverted) return 'diverted';
  if (f.actual_on || f.actual_in) return 'landed';
  if (f.actual_off) return 'departed';
  if (f.actual_out) return 'boarding';
  const t = String(f.status || '');
  if (/arrived|landed/i.test(t)) return 'landed';
  if (/en route|departed|airborne/i.test(t)) return 'departed';
  if (/cancel/i.test(t)) return 'cancelled';
  if (/divert/i.test(t)) return 'diverted';
  return 'scheduled';
}

async function aeroApi(spec, s) {
  if (!s.apiKey) throw new ProviderError('auth', 'Add your FlightAware AeroAPI key in Settings to get live data.');
  const base = (s.proxy || FA_BASE).replace(/\/+$/, '');
  const headers = { 'x-apikey': s.apiKey, accept: 'application/json' };
  const now = Date.now(), DAY = 864e5;
  const d0 = Date.parse(`${spec.date}T00:00:00Z`);
  // AeroAPI answers for the last 10 days and the next 2 days only.
  if (d0 + DAY < now - 10 * DAY) throw new ProviderError('notfound', 'FlightAware only returns flights from the last 10 days.');
  const start = Math.max(d0 - DAY, now - 10 * DAY + 3600e3);
  const end = Math.min(d0 + 2 * DAY, now + 2 * DAY - 60e3);
  if (start >= end) throw new ProviderError('notfound', 'FlightAware only returns flights up to 2 days ahead. Tracking will work closer to the date.');
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const q = new URLSearchParams({ ident_type: 'designator', start: iso(start), end: iso(end), max_pages: '2' });

  const r = await getJson(`${base}/flights/${encodeURIComponent(spec.ident)}?${q}`, headers);
  if (r.status === 204 || r.status === 404) throw new ProviderError('notfound', 'FlightAware has no flight with this number around that date. Check the number and date.');
  if (r.status >= 400) throw httpError(r.status, r.body);
  const list = (r.body && r.body.flights) || [];
  if (!list.length) throw new ProviderError('notfound', 'FlightAware has no flight with this number around that date. Check the number and date.');

  const code = (a) => ((a && (a.code_iata || a.code)) || '').toUpperCase();
  const ok = (c, want) => !want || !c || c === want;
  const matches = list.filter((f) => ok(code(f.origin), spec.from) && ok(code(f.destination), spec.to));
  if (!matches.length) {
    const seen = [...new Set(list.map((f) => `${code(f.origin) || '?'}→${code(f.destination) || '?'}`))].join(', ');
    throw new ProviderError('notfound', `${spec.ident} was found but not as ${spec.from}→${spec.to}. Found: ${seen}.`);
  }
  const dateOf = (f) => {
    const t = faTime(f.scheduled_out) ?? faTime(f.scheduled_off);
    return t == null ? '' : localDateKey(t, (f.origin && f.origin.timezone) || 'UTC');
  };
  const f = matches.find((x) => !x.cancelled && dateOf(x) === spec.date)
    || matches.find((x) => dateOf(x) === spec.date)
    || matches.find((x) => !x.cancelled)
    || matches[0];

  // FLOWN PATH (DISABLED to save API calls, see "Re-enabling the AeroAPI flown path" in README.md).
  // Fetching the track is a second AeroAPI lookup per refresh once the aircraft has left the gate.
  // With it off, `track` stays null and the map draws the planned route plus the last reported position.
  // To turn it back on, remove the "//" at the start of each line from "FLOWN PATH START" to "FLOWN PATH END".
  let track = null;
  // FLOWN PATH START
  // if (f.fa_flight_id && (f.actual_off || f.actual_out)) {
  //   try {
  //     const tr = await getJson(`${base}/flights/${encodeURIComponent(f.fa_flight_id)}/track`, headers);
  //     const pos = tr.status < 400 && tr.body && Array.isArray(tr.body.positions) ? tr.body.positions.filter((p) => p && typeof p.latitude === 'number') : [];
  //     if (pos.length > 1) {
  //       const step = Math.max(1, Math.ceil(pos.length / 250)); // keep it small enough to store
  //       track = pos.filter((_, i) => i % step === 0 || i === pos.length - 1)
  //         .map((p) => ({ lat: p.latitude, lon: p.longitude, t: faTime(p.timestamp), altFt: typeof p.altitude === 'number' ? p.altitude * 100 : null }));
  //     }
  //   } catch { /* the status is still useful without the path */ }
  // }
  // FLOWN PATH END

  const status = faStatus(f);
  const lp = f.last_position;
  const last = track && track[track.length - 1];
  const airborne = status === 'departed';
  const live = airborne && lp && typeof lp.latitude === 'number'
    ? { lat: lp.latitude, lon: lp.longitude, altFt: typeof lp.altitude === 'number' ? lp.altitude * 100 : null, speedKt: typeof lp.groundspeed === 'number' ? lp.groundspeed : null }
    : airborne && last ? { lat: last.lat, lon: last.lon, altFt: last.altFt, speedKt: null } : null;

  return {
    source: 'FlightAware',
    status,
    airline: f.operator_iata || f.operator || '',
    ident: f.ident_iata || f.ident || spec.ident,
    dep: faLeg(f.origin, 'dep', f),
    arr: faLeg(f.destination, 'arr', f),
    aircraft: f.registration || f.aircraft_type ? { reg: f.registration || '', model: f.aircraft_type || '' } : null,
    live,
    track,
    faId: f.fa_flight_id || null,
    distanceKm: null,
    updatedAt: Date.now(),
  };
}

/* ---------- Demo ---------- */

export function demoSeed(spec) {
  // A repeatable departure time, duration and gate for any flight the user types in.
  const h = hash(`${spec.ident}${spec.date}${spec.from}${spec.to}`);
  const from = airportInfo(spec.from);
  const tz = from ? from.tz : 'UTC';
  const hh = String(6 + (h % 15)).padStart(2, '0');
  const mm = String(((h >>> 4) % 12) * 5).padStart(2, '0');
  return {
    depUtc: wallToEpoch(`${spec.date}T${hh}:${mm}`, tz),
    durMin: 70 + (h % 520),
    delayMin: (h >>> 8) % 4 === 0 ? 10 + ((h >>> 10) % 50) : 0,
  };
}

export function demoSnapshot(spec) {
  const d = spec.demo || demoSeed(spec);
  const h = hash(spec.ident + spec.from);
  const now = Date.now();
  const A = airportInfo(spec.from) || { iata: spec.from, name: spec.from, city: '', tz: 'UTC' };
  const B = airportInfo(spec.to) || { iata: spec.to, name: spec.to, city: '', tz: 'UTC' };
  const min = 60000;
  const estDep = d.depUtc + d.delayMin * min;
  const estArr = estDep + d.durMin * min;
  const schedArr = d.depUtc + d.durMin * min;

  let status = 'scheduled';
  if (d.cancelled) status = 'cancelled';
  else if (now >= estArr) status = 'landed';
  else if (now >= estArr - 25 * min) status = 'approaching';
  else if (now >= estDep) status = 'departed';
  else if (now >= estDep - 40 * min) status = 'boarding';
  else if (now >= estDep - 150 * min) status = 'checkin';

  const airborne = status === 'departed' || status === 'approaching';
  const p = Math.min(1, Math.max(0, (now - estDep) / (estArr - estDep)));
  const letter = 'ABCDEF'[h % 6];
  return {
    source: 'Demo',
    status,
    airline: 'Simulated airline',
    ident: spec.ident,
    dep: { iata: A.iata, name: A.name, city: A.city, tz: A.tz, sched: d.depUtc, est: d.delayMin ? estDep : null, actual: now >= estDep && status !== 'cancelled' ? estDep : null, terminal: String(1 + (h % 5)), gate: `${letter}${1 + ((h >>> 3) % 28)}` },
    arr: { iata: B.iata, name: B.name, city: B.city, tz: B.tz, sched: schedArr, est: d.delayMin ? estArr : null, actual: status === 'landed' ? estArr : null, terminal: String(1 + ((h >>> 5) % 4)), gate: '', baggage: String(1 + ((h >>> 7) % 12)) },
    aircraft: { reg: `N${100 + (h % 899)}XX`, model: ['Airbus A320', 'Boeing 737-800', 'Airbus A350-900', 'Boeing 787-9'][h % 4] },
    live: airborne ? { lat: null, lon: null, altFt: Math.round(Math.min(1, p * 8, (1 - p) * 8) * 36000 / 100) * 100, speedKt: Math.round(430 + (h % 40)) } : null,
    distanceKm: Math.round(d.durMin * 13.2),
    updatedAt: now,
  };
}
