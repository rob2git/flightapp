import { AIRPORTS, AIRPORT_POS, airportInfo } from './airports.js';
import { drawMap, gcKm, gcAt } from './map.js';
import { fetchFlight, PROVIDERS, ProviderError, demoSeed, demoSnapshot } from './providers.js';
import { fmtTime, fmtDay, fmtDur, tzLabel, todayKey, localDateKey, wallToEpoch, normIdent, prettyIdent, IDENT_RE, uid } from './util.js';

const $ = (s, r = document) => r.querySelector(s);
const STORE = 'flightapp.v1';
const MIN = 60000;

/* ---------- state ---------- */

const defaults = { provider: 'demo', apiKey: '', proxy: '', refresh: 0 };

/** Keys and proxy addresses are kept per provider; apiKey and proxy always hold the ones for the active provider. */
function normSettings(raw) {
  const s = { ...defaults, ...raw };
  s.keys = { ...(raw && raw.keys) };
  s.proxies = { ...(raw && raw.proxies) };
  if (raw && raw.apiKey && !s.keys[s.provider]) s.keys[s.provider] = raw.apiKey;
  if (raw && raw.proxy && !s.proxies[s.provider]) s.proxies[s.provider] = raw.proxy;
  s.apiKey = s.keys[s.provider] || '';
  s.proxy = s.proxies[s.provider] || '';
  return s;
}
let state = load();

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (s && Array.isArray(s.flights)) return { settings: normSettings(s.settings), flights: s.flights };
  } catch { /* first run, or storage unavailable */ }
  return { settings: normSettings({}), flights: seedExamples() };
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* storage full or blocked */ }
}

function seedExamples() {
  const now = Date.now();
  const mk = (ident, from, to, depUtc, durMin, delayMin) => {
    const a = airportInfo(from);
    return {
      id: uid(), ident, from, to, date: localDateKey(depUtc, a ? a.tz : 'UTC'), seed: true, addedAt: now,
      demo: { depUtc, durMin, delayMin },
    };
  };
  return [
    mk('BA286', 'SFO', 'LHR', now - 310 * MIN, 640, 0),
    mk('LH401', 'FRA', 'JFK', now + 70 * MIN, 500, 25),
    mk('QF12', 'LAX', 'SYD', now - 890 * MIN, 850, 0),
    mk('UA900', 'SFO', 'LHR', now + 18 * 1440 * MIN, 625, 0),
  ];
}

/* ---------- derived values ---------- */

function best(leg) { return leg.actual ?? leg.est ?? leg.sched; }
/** True only when the leg has an actual time that has already happened (some feeds send a predicted one). */
function isActual(leg, now = Date.now()) { return leg.actual != null && leg.actual <= now + 2 * MIN; }
function delayMin(leg) {
  const t = leg.actual ?? leg.est;
  return t != null && leg.sched != null ? Math.round((t - leg.sched) / MIN) : 0;
}

/** A saved flight whose date has not started yet. It gets no lookups until the departure date begins. */
function startOf(f) {
  const a = airportInfo(f.from);
  const tz = a ? a.tz : Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { t: wallToEpoch(`${f.date}T00:00`, tz), tz, place: a ? `${a.city} time` : 'your device\'s time' };
}
const noon = (f) => Date.parse(`${f.date}T12:00:00Z`);
const shortDate = (f) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(noon(f));

function waitInfo(f, now = Date.now()) {
  if (f.snap) return null;
  const { t, tz, place } = startOf(f);
  if (t == null || now >= t) return null;
  const left = t - now;
  const soon = left <= 24 * 60 * MIN;
  const day = fmtDay(noon(f), 'UTC');
  return {
    t, tz, day,
    pill: soon ? 'Starts tomorrow' : 'Not tracking yet',
    title: soon ? 'Tracking starts tomorrow' : `Tracking starts ${shortDate(f)}`,
    text: `This flight is saved. Live status will load from the start of ${day} (${place}). No lookups are made before then.`,
    eta: left >= 48 * 60 * MIN ? `Starts in ${Math.ceil(left / (1440 * MIN))} days` : `Starts in ${fmtDur(left / MIN)}`,
  };
}

function derive(f, now = Date.now()) {
  const s = f.snap;
  if (!s) return null;
  let status = s.status;
  // Providers often publish an actual time before they update the status field, so the times win.
  if (isActual(s.arr, now) && !['cancelled', 'diverted'].includes(status)) status = 'landed';
  else if (isActual(s.dep, now) && ['scheduled', 'checkin', 'boarding'].includes(status)) status = 'departed';
  if (status === 'departed' && best(s.arr) != null && now >= best(s.arr) - 25 * MIN && now < best(s.arr)) status = 'approaching';
  const dd = delayMin(s.dep), ad = delayMin(s.arr);
  const pre = ['scheduled', 'checkin', 'boarding'].includes(status);
  const late = (pre && dd >= 15) || (['departed', 'approaching'].includes(status) && ad >= 15);
  let tone = 'ok';
  if (status === 'departed' || status === 'approaching') tone = late ? 'late' : 'air';
  else if (status === 'landed' || status === 'unknown') tone = 'done';
  else if (status === 'cancelled') tone = 'bad';
  else if (status === 'diverted') tone = 'late';
  else if (late) tone = 'late';
  const labels = { scheduled: 'On schedule', checkin: 'Check-in open', boarding: 'Boarding', departed: 'In the air', approaching: 'Approaching', landed: 'Landed', cancelled: 'Cancelled', diverted: 'Diverted', unknown: 'Status unknown' };
  let label = labels[status] || 'Status unknown';
  if (late && pre) label = 'Delayed';
  if (late && (status === 'departed' || status === 'approaching')) label = status === 'approaching' ? 'Approaching, late' : 'In the air, late';
  return { status, tone, label, dd, ad, live: status === 'departed' || status === 'approaching' || status === 'boarding' };
}

function progress(f, d, now = Date.now()) {
  const s = f.snap;
  if (!d || !s) return 0;
  if (d.status === 'landed') return 1;
  if (d.status !== 'departed' && d.status !== 'approaching') return 0;
  const a = best(s.dep), b = best(s.arr);
  if (a == null || b == null || b <= a) return 0.5;
  return Math.min(0.97, Math.max(0.03, (now - a) / (b - a)));
}

function etaText(f, d, now = Date.now()) {
  const s = f.snap;
  if (!s || !d) return { main: '', sub: '' };
  const dep = best(s.dep), arr = best(s.arr);
  switch (d.status) {
    case 'cancelled': return { main: 'This flight was cancelled.', sub: '' };
    case 'diverted': return { main: 'This flight was diverted.', sub: 'Check the airline for the new destination.' };
    case 'landed': return { main: arr != null ? `Landed ${ago(now - arr)}` : 'Landed', sub: '' };
    case 'departed': case 'approaching': {
      const left = arr != null ? arr - now : null;
      const p = Math.round(progress(f, d, now) * 100);
      return { main: left != null && left > 0 ? `Lands in ${fmtDur(left / MIN)}` : 'Landing now', sub: `${p}% of the way` };
    }
    default: {
      if (dep == null) return { main: '', sub: '' };
      const left = dep - now;
      if (left > 0) return { main: `Departs in ${left >= 36e5 * 48 ? Math.round(left / 864e5) + ' days' : fmtDur(left / MIN)}`, sub: '' };
      return { main: 'Departure time has passed', sub: 'Waiting for the airline to confirm takeoff.' };
    }
  }
}
function ago(ms) {
  const m = Math.round(ms / MIN);
  if (m < 1) return 'just now';
  if (m < 90) return `${m} min ago`;
  if (m < 36 * 60) return `${fmtDur(m)} ago`;
  return `${Math.round(m / 1440)} days ago`;
}

/* ---------- rendering ---------- */

/** City if known, else the airport name without generic words ("Tampa International Airport" becomes "Tampa"). */
function placeName(p) {
  if (p.city) return p.city;
  const n = (p.name || '').trim();
  const short = n.replace(/\s+(International|Intl|Airport|Regional|Municipal|National|Field)\b.*$/i, '').trim();
  return short || n;
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function flaps(epoch, tz, refEpoch, refTz) {
  if (epoch == null) return '<div class="flaps" aria-label="No time yet"><i>-</i><i>-</i><b>:</b><i>-</i><i>-</i></div>';
  const t = fmtTime(epoch, tz);
  const shift = refTz && refEpoch != null ? Math.round((Date.parse(localDateKey(epoch, tz)) - Date.parse(localDateKey(refEpoch, refTz))) / 864e5) : 0;
  const plus = shift ? `<sup>${shift > 0 ? '+' : ''}${shift}</sup>` : '';
  return `<div class="flaps" role="text" aria-label="${esc(t)}${shift ? ` (${shift > 0 ? '+' : ''}${shift} day)` : ''}"><i>${t[0]}</i><i>${t[1]}</i><b>:</b><i>${t[3]}</i><i>${t[4]}</i>${plus}</div>`;
}

function legHTML(title, leg, kind, refLeg) {
  const t = best(leg);
  const when = isActual(leg) ? (kind === 'dep' ? 'Departed' : 'Landed') : (leg.est != null || leg.actual != null) ? 'Estimated' : 'Scheduled';
  const dm = delayMin(leg);
  const changed = t != null && leg.sched != null && Math.abs(t - leg.sched) >= MIN * 2;
  let chip = '';
  if (leg.sched != null && (leg.est != null || leg.actual != null)) {
    chip = dm >= 5 ? `<span class="chip chip-late">+${fmtDur(dm)}</span>` : dm <= -5 ? `<span class="chip chip-ok">${fmtDur(-dm)} early</span>` : '<span class="chip chip-ok">On time</span>';
  }
  const refT = refLeg ? best(refLeg) : null;
  const facts = [];
  if (leg.terminal) facts.push(`<span>Terminal<b>${esc(leg.terminal)}</b></span>`);
  if (leg.gate) facts.push(`<span>Gate<b>${esc(leg.gate)}</b></span>`);
  if (kind === 'arr' && leg.baggage) facts.push(`<span>Baggage<b>${esc(leg.baggage)}</b></span>`);
  return `<div class="leg">
    <div class="lbl"><span>${title}</span><span>${when}</span></div>
    ${flaps(t, leg.tz, refT, refLeg && refLeg.tz)}
    <div class="sub"><span>${esc(fmtDay(t, leg.tz))} · ${esc(tzLabel(t, leg.tz))}</span>${changed ? `<span>was <s>${fmtTime(leg.sched, leg.tz)}</s></span>` : ''}${chip}</div>
    <div class="facts">${facts.join('') || '<span class="none">Terminal and gate not published yet</span>'}</div>
  </div>`;
}

const P0 = [0, 38], P1 = [100, -14], P2 = [200, 38], ARC_H = 46;
function arcPoint(t) {
  const u = 1 - t;
  return {
    x: u * u * P0[0] + 2 * u * t * P1[0] + t * t * P2[0],
    y: u * u * P0[1] + 2 * u * t * P1[1] + t * t * P2[1],
    dx: 2 * u * (P1[0] - P0[0]) + 2 * t * (P2[0] - P1[0]),
    dy: 2 * u * (P1[1] - P0[1]) + 2 * t * (P2[1] - P1[1]),
  };
}
// The curve is stretched to the card width. Dots and the plane are HTML so they stay round,
// and layoutArcs() places the plane in real pixels after each render.
function arcHTML(p, d) {
  const path = `M${P0} Q${P1} ${P2}`;
  const flying = d && d.status !== 'cancelled' && p > 0 && p < 1;
  return `<div class="arcbox" data-p="${p.toFixed(4)}" aria-hidden="true">
    <svg viewBox="0 0 200 ${ARC_H}" preserveAspectRatio="none">
      <path class="rest" d="${path}" fill="none" stroke-width="2" stroke-dasharray="2 5" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      <path class="done" d="${path}" fill="none" stroke-width="2.5" stroke-linecap="round" pathLength="100" stroke-dasharray="${(p * 100).toFixed(2)} 100" vector-effect="non-scaling-stroke"/>
    </svg>
    <i class="dot dot-a"></i><i class="dot dot-b${d && d.status === 'landed' ? ' full' : ''}"></i>
    ${flying ? '<svg class="plane" viewBox="-8 -6 16 12" width="18" height="14"><polygon points="-7,-5 8,0 -7,5 -3.5,0" fill="currentColor"/></svg>' : ''}
  </div>`;
}
function layoutArcs() {
  for (const box of document.querySelectorAll('.arcbox')) {
    const plane = box.querySelector('.plane');
    if (!plane) continue;
    const w = box.clientWidth || 200;
    const pt = arcPoint(Number(box.dataset.p));
    const ang = Math.atan2(pt.dy, pt.dx * (w / 200)) * 180 / Math.PI;
    plane.style.left = `${(pt.x / 200 * 100).toFixed(2)}%`;
    plane.style.top = `${(pt.y / ARC_H * 100).toFixed(2)}%`;
    plane.style.transform = `translate(-50%, -50%) rotate(${ang.toFixed(1)}deg)`;
  }
}
window.addEventListener('resize', layoutArcs);

function cardHTML(f, d) {
  const w = waitInfo(f);
  if (w) return waitCardHTML(f, w);
  const s = f.snap;
  const isDemo = s ? s.source === 'Demo' : state.settings.provider === 'demo';
  const A = (s && s.dep) || airportInfo(f.from) || { city: '' };
  const B = (s && s.arr) || airportInfo(f.to) || { city: '' };
  const title = `${prettyIdent(f.ident)}`;
  const meta = s
    ? `${esc(s.airline || 'Flight')} · ${esc(fmtDay(best(s.dep), s.dep.tz))}`
    : esc(fmtDay(Date.parse(f.date + 'T12:00:00Z'), 'UTC'));
  const pill = d ? `<span class="pill">${esc(d.label)}</span>` : `<span class="pill">${f.err ? 'No data' : 'Checking'}</span>`;
  const p = progress(f, d);
  const eta = etaText(f, d);
  const err = f.err ? `<p class="problem${f.err.kind === 'network' || s ? ' soft' : ''}" role="status">${esc(f.err.message)}${s ? ' Showing the last known status.' : ''}</p>` : '';
  const body = s ? `
    <div class="times">
      ${legHTML('Departure', s.dep, 'dep', null)}
      ${legHTML('Arrival', s.arr, 'arr', s.dep)}
    </div>
    <p class="eta"><span class="eta-main">${esc(eta.main)}</span><small class="eta-sub">${esc(eta.sub)}</small></p>` : '';
  const detail = s ? `
    <dl class="detail">
      <div><dt>Aircraft</dt><dd>${esc(s.aircraft && (s.aircraft.model || s.aircraft.reg) ? [s.aircraft.model, s.aircraft.reg].filter(Boolean).join(' · ') : 'Not assigned yet')}</dd></div>
      <div><dt>Distance</dt><dd>${(() => { const km = s.distanceKm || (AIRPORT_POS[f.from] && AIRPORT_POS[f.to] ? gcKm(AIRPORT_POS[f.from], AIRPORT_POS[f.to]) : 0); return km ? `${Math.round(km).toLocaleString()} km` : 'Not published'; })()}</dd></div>
      <div><dt>Altitude</dt><dd>${s.live && s.live.altFt != null ? `${Math.round(s.live.altFt).toLocaleString()} ft` : 'Not in flight'}</dd></div>
      <div><dt>Ground speed</dt><dd>${s.live && s.live.speedKt != null ? `${Math.round(s.live.speedKt)} kt` : 'Not in flight'}</dd></div>
      <div><dt>Scheduled block</dt><dd>${s.dep.sched != null && s.arr.sched != null ? fmtDur((s.arr.sched - s.dep.sched) / MIN) : 'Unknown'}</dd></div>
      <div><dt>Data source</dt><dd>${esc(s.source)}</dd></div>
    </dl>` : '';
  const stamp = f.fetchedAt ? `Updated ${esc(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(f.fetchedAt))}` : 'Not updated yet';
  return `
    <header class="card-head">
      <div class="ident"><span class="num">${esc(title)}${isDemo ? '<span class="tag">Demo</span>' : ''}</span><span class="meta">${meta}</span></div>
      ${pill}
    </header>
    <div class="route">
      <div class="end"><span class="code">${esc(f.from)}</span><span class="city" title="${esc(A.name || '')}">${esc(placeName(A))}</span></div>
      ${arcHTML(p, d)}
      <div class="end end-r"><span class="code">${esc(f.to)}</span><span class="city" title="${esc(B.name || '')}">${esc(placeName(B))}</span></div>
    </div>
    ${err}
    ${body}
    ${mapSection(f, d)}
    <details class="more" data-id="${f.id}"${openIds.has(f.id) ? ' open' : ''}>
      <summary>Details</summary>
      ${detail}
      <div class="card-actions">
        <span class="stamp">${stamp}</span>
        <span class="btns">
          <button class="btn btn-sm" type="button" data-act="refresh" data-id="${f.id}">Refresh</button>
          <button class="btn btn-sm btn-danger" type="button" data-act="remove" data-id="${f.id}">Remove</button>
        </span>
      </div>
    </details>`;
}

const mapOpen = new Map(); // remembers which maps you opened or closed

function mapData(f, d, now = Date.now()) {
  const s = f.snap;
  if (!s || !d || !['departed', 'approaching', 'landed'].includes(d.status)) return null;
  const A = AIRPORT_POS[f.from] || null, B = AIRPORT_POS[f.to] || null;
  const track = s.track && s.track.length > 1 ? s.track : null;
  if (!track && !(A && B)) return null;
  const landed = d.status === 'landed';
  let pos = null, estimated = false;
  if (!landed) {
    if (s.live && typeof s.live.lat === 'number') pos = { lat: s.live.lat, lon: s.live.lon };
    else if (track) pos = { lat: track[track.length - 1].lat, lon: track[track.length - 1].lon };
    else { const g = gcAt(A, B, progress(f, d, now)); pos = { lat: g[0], lon: g[1] }; estimated = true; }
  }
  const extra = [s.live && s.live.altFt != null ? `${Math.round(s.live.altFt).toLocaleString()} ft` : '', s.live && s.live.speedKt != null ? `${Math.round(s.live.speedKt)} kt` : ''].filter(Boolean).join(' · ');
  const caption = landed
    ? (track ? `Path flown, from ${s.source}.` : 'Planned route. No flight path was provided.')
    : estimated ? 'Position estimated from the schedule, not tracked.' : `Position from ${s.source}${extra ? ` · ${extra}` : ''}.`;
  return { opts: { from: A, to: B, codes: [f.from, f.to], track, pos, landed }, caption, estimated, airborne: !landed };
}

function mapSection(f, d, now) {
  const m = mapData(f, d, now);
  if (!m) return '';
  const key = `${f.id}:map`;
  const open = mapOpen.has(key) ? mapOpen.get(key) : m.airborne;
  return `<details class="more mapd" data-key="${key}"${open ? ' open' : ''}>
      <summary>Map</summary>
      <div class="mapbox" data-est="${m.estimated ? 1 : 0}">${drawMap(m.opts)}</div>
      <p class="mapcap">${esc(m.caption)}</p>
    </details>`;
}

function waitCardHTML(f, w) {
  const A = airportInfo(f.from) || { city: '', name: '' };
  const B = airportInfo(f.to) || { city: '', name: '' };
  const isDemo = state.settings.provider === 'demo';
  const cal = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
  return `
    <header class="card-head">
      <div class="ident"><span class="num">${esc(prettyIdent(f.ident))}${isDemo ? '<span class="tag">Demo</span>' : ''}</span><span class="meta">${esc(w.day)}</span></div>
      <span class="pill pill-wait">${esc(w.pill)}</span>
    </header>
    <div class="route">
      <div class="end"><span class="code">${esc(f.from)}</span><span class="city">${esc(A.city)}</span></div>
      ${arcHTML(0, null)}
      <div class="end end-r"><span class="code">${esc(f.to)}</span><span class="city">${esc(B.city)}</span></div>
    </div>
    <div class="waitbox">
      <span class="waitbox-ico">${cal}</span>
      <div><p class="waitbox-title">${esc(w.title)}</p><p class="waitbox-text">${esc(w.text)}</p></div>
    </div>
    <p class="eta"><span class="eta-main">${esc(w.eta)}</span><small class="eta-sub">No lookups until then</small></p>
    <details class="more" data-id="${f.id}"${openIds.has(f.id) ? ' open' : ''}>
      <summary>Details</summary>
      <dl class="detail">
        <div><dt>Flight</dt><dd>${esc(prettyIdent(f.ident))}</dd></div>
        <div><dt>Route</dt><dd>${esc(f.from)} to ${esc(f.to)}</dd></div>
        <div><dt>Tracking starts</dt><dd>${esc(fmtDay(w.t, w.tz))}, ${esc(fmtTime(w.t, w.tz))} ${esc(tzLabel(w.t, w.tz))}</dd></div>
        <div><dt>Data source</dt><dd>${esc(PROVIDERS[state.settings.provider].label)}</dd></div>
      </dl>
      <div class="card-actions">
        <span class="stamp">Saved, not looked up yet</span>
        <span class="btns"><button class="btn btn-sm btn-danger" type="button" data-act="remove" data-id="${f.id}">Remove</button></span>
      </div>
    </details>`;
}

const openIds = new Set();
const cards = new Map(); // id -> element

// Flights stay in date order until a day after they finished, then sink to the bottom (newest first).
function sortKey(f, now = Date.now()) {
  const d = derive(f, now);
  const finished = !!(d && ['landed', 'cancelled'].includes(d.status));
  const end = f.snap ? (best(f.snap.arr) ?? best(f.snap.dep)) : null;
  const done = finished && end != null && now - end > 24 * 60 * MIN;
  const t = f.snap ? best(f.snap.dep) : (f.demo ? f.demo.depUtc : Date.parse(f.date));
  return { done, t: t ?? 0 };
}

function render() {
  const list = $('#list');
  const now = Date.now();
  const flights = [...state.flights].sort((a, b) => {
    const A = sortKey(a, now), B = sortKey(b, now);
    if (A.done !== B.done) return A.done ? 1 : -1;
    return A.done ? B.t - A.t : A.t - B.t;
  });
  const keep = new Set(flights.map((f) => f.id));
  for (const [id, el] of cards) if (!keep.has(id)) { el.remove(); cards.delete(id); }
  flights.forEach((f, i) => {
    const d = derive(f, now);
    const w = waitInfo(f, now);
    const sig = JSON.stringify([f.snap, f.err, d && d.status, f.fetchedAt, w && [w.pill, w.title, w.text]]);
    let el = cards.get(f.id);
    if (!el) {
      el = document.createElement('article');
      el.className = 'card';
      el.dataset.id = f.id;
      cards.set(f.id, el);
    }
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.innerHTML = cardHTML(f, d);
    }
    el.dataset.w = w ? '1' : '0';
    el.dataset.st = d ? d.status : '';
    el.dataset.tone = d ? d.tone : 'done';
    el.dataset.live = d && d.live ? '1' : '0';
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
  });
  layoutArcs();
  $('#empty').hidden = flights.length > 0;
  $('#banner').hidden = state.settings.provider !== 'demo' || flights.length === 0;
  summary(now);
}

function tickText() {
  const now = Date.now();
  for (const f of state.flights) {
    const el = cards.get(f.id);
    if (!el) continue;
    const w = waitInfo(f, now);
    if ((el.dataset.w === '1') !== !!w) { render(); autoRefresh(); return; } // its date has started
    if (w) {
      const m = el.querySelector('.eta-main');
      if (m && m.textContent !== w.eta) m.textContent = w.eta;
      if (el.dataset.sig !== JSON.stringify([f.snap, f.err, null, f.fetchedAt, [w.pill, w.title, w.text]])) { render(); return; }
      continue;
    }
    if (!f.snap) continue;
    const d = derive(f, now);
    if (d && el.dataset.st !== d.status) { render(); return; }
    const eta = etaText(f, d, now);
    const m = el.querySelector('.eta-main'), s = el.querySelector('.eta-sub');
    if (m && m.textContent !== eta.main) m.textContent = eta.main;
    if (s && s.textContent !== eta.sub) s.textContent = eta.sub;
    const mb = el.querySelector('.mapbox');
    if (mb && mb.dataset.est === '1') { const m = mapData(f, d, now); if (m) mb.innerHTML = drawMap(m.opts); }
    const box = el.querySelector('.arcbox');
    if (box) {
      const p = progress(f, d, now);
      box.dataset.p = p.toFixed(4);
      box.querySelector('.done').setAttribute('stroke-dasharray', `${(p * 100).toFixed(2)} 100`);
    }
  }
  layoutArcs();
  summary(now);
}

function summary(now) {
  const el = $('#summary');
  const n = state.flights.length;
  if (!n) { el.textContent = ''; return; }
  let air = 0, waiting = 0, next = null;
  for (const f of state.flights) {
    if (waitInfo(f, now)) { waiting++; continue; }
    const d = derive(f, now);
    if (!d) continue;
    if (d.status === 'departed' || d.status === 'approaching') air++;
    const dep = best(f.snap.dep);
    if (['scheduled', 'checkin', 'boarding'].includes(d.status) && dep != null && dep > now - 30 * MIN && (!next || dep < next.t)) next = { t: dep, f };
  }
  const parts = [`${n} ${n === 1 ? 'flight' : 'flights'}`];
  if (air) parts.push(`${air} in the air`);
  if (waiting) parts.push(`${waiting} waiting`);
  if (next) parts.push(`${prettyIdent(next.f.ident)} departs in ${fmtDur(Math.max(0, next.t - now) / MIN)}`);
  el.textContent = parts.join(' · ');
}

/* ---------- refreshing ---------- */

const inFlight = new Set();

async function refreshOne(f, { manual = false } = {}) {
  if (inFlight.has(f.id) || waitInfo(f)) return; // future flights make no requests
  inFlight.add(f.id);
  f.lastTry = Date.now();
  try {
    const snap = await fetchFlight(spec(f), state.settings);
    f.snap = snap;
    f.err = null;
    f.fetchedAt = Date.now();
  } catch (e) {
    f.err = e instanceof ProviderError ? { kind: e.kind, message: e.message } : { kind: 'other', message: 'Something went wrong while loading this flight.' };
    if (manual && !navigator.onLine) f.err = { kind: 'network', message: 'You are offline.' };
    if (!(e instanceof ProviderError)) console.error(e);
  } finally {
    inFlight.delete(f.id);
    save();
    render();
  }
}
const spec = (f) => ({ ident: f.ident, date: f.date, from: f.from, to: f.to, demo: f.demo });

async function refreshAll(manual) {
  const btn = $('#btn-refresh');
  btn.classList.add('spin');
  await Promise.all(state.flights.map((f) => refreshOne(f, { manual })));
  btn.classList.remove('spin');
}

/** How long to wait before asking the provider again, given where the flight is in its day. */
function interval(f, now) {
  const s = state.settings;
  const d = derive(f, now);
  if (s.provider === 'demo') return d && ['landed', 'cancelled'].includes(d.status) ? Infinity : MIN;
  if (!d) {
    const k = f.err && f.err.kind;
    if (k === 'auth') return Infinity;
    if (k === 'notfound' || k === 'rate') return s.refresh ? 60 * MIN : Infinity; // wait for a tap rather than retry blindly
    return 10 * MIN;
  }
  if (['landed', 'cancelled', 'diverted'].includes(d.status)) return Infinity;
  if (!s.refresh) return Infinity;
  const dep = best(f.snap.dep), arr = best(f.snap.arr);
  if (dep != null && arr != null && now > dep - 3 * 60 * MIN && now < arr + 60 * MIN) return s.refresh * MIN;
  if (dep != null && now > dep - 24 * 60 * MIN && now < dep) return 30 * MIN;
  return 6 * 60 * MIN;
}

function autoRefresh() {
  if (document.hidden || !navigator.onLine) return;
  const now = Date.now();
  state.flights.forEach((f, i) => {
    if (now - (f.lastTry || 0) >= interval(f, now)) setTimeout(() => refreshOne(f), i * 400);
  });
}

/* ---------- dialogs and forms ---------- */

const dlgAdd = $('#dlg-add'), dlgSet = $('#dlg-set');

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}

function openAdd() {
  $('#f-date').value = todayKey();
  $('#add-error').hidden = true;
  dlgAdd.showModal();
  $('#f-ident').focus();
}

$('#airports').innerHTML = Object.entries(AIRPORTS).sort().map(([c, a]) => `<option value="${c}">${esc(a[1])} · ${esc(a[0])}</option>`).join('');

$('#form-add').addEventListener('submit', (e) => {
  e.preventDefault();
  const err = (m) => { const el = $('#add-error'); el.textContent = m; el.hidden = false; };
  const ident = normIdent($('#f-ident').value);
  const date = $('#f-date').value;
  const from = $('#f-from').value.trim().toUpperCase();
  const to = $('#f-to').value.trim().toUpperCase();
  if (!IDENT_RE.test(ident)) return err('Enter a flight number like BA286 or BA 286: the airline code, then up to 4 digits.');
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) return err('Pick the departure date.');
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return err('Airports need 3-letter IATA codes, such as SFO or LHR.');
  if (from === to) return err('The departure and arrival airports must be different.');
  if (state.flights.some((f) => f.ident === ident && f.date === date && f.from === from && f.to === to)) return err('You are already tracking this flight.');
  const f = { id: uid(), ident, date, from, to, addedAt: Date.now() };
  if (state.settings.provider === 'demo') f.demo = demoSeed(f);
  state.flights.push(f);
  save();
  dlgAdd.close();
  render();
  if (waitInfo(f)) toast(`Saved. Tracking starts ${shortDate(f)}.`);
  else refreshOne(f, { manual: true });
});

let draft = { keys: {}, proxies: {} }, shown = 'demo'; // edits made in the dialog, per provider
function fillSettings() {
  const s = state.settings;
  draft = { keys: { ...s.keys }, proxies: { ...s.proxies } };
  shown = s.provider;
  $('#s-provider').innerHTML = Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  $('#s-provider').value = s.provider;
  $('#s-key').value = draft.keys[shown] || '';
  $('#s-proxy').value = draft.proxies[shown] || '';
  $('#s-refresh').value = String(s.refresh);
  syncSettingsUI();
}
function stashDraft() {
  draft.keys[shown] = $('#s-key').value.trim();
  draft.proxies[shown] = $('#s-proxy').value.trim();
}
const HINTS = {
  demo: 'Demo flights are simulated from the clock so you can see how the board behaves. Nothing is sent anywhere.',
  adb_rapid: 'Get a key by subscribing to AeroDataBox on RapidAPI. Flights are matched by number and local date.',
  adb_market: 'Get a key from AeroDataBox on API.Market. Flights are matched by number and local date.',
  aeroapi: 'Get a key from the FlightAware AeroAPI portal. Each refresh uses one lookup. FlightAware only answers for the last 10 days and the next 2 days.',
  aviationstack: 'Get an access key from aviationstack.com. Plans differ in monthly requests and in which date lookups they allow, so a lookup for a date outside your plan may come back empty.',
};
function syncSettingsUI() {
  const p = $('#s-provider').value;
  $('#row-key').hidden = !PROVIDERS[p].needsKey;
  $('#row-proxy').hidden = !PROVIDERS[p].needsKey;
  $('#provider-hint').textContent = HINTS[p];
}
$('#s-provider').addEventListener('change', () => {
  stashDraft();
  shown = $('#s-provider').value;
  $('#s-key').value = draft.keys[shown] || '';
  $('#s-proxy').value = draft.proxies[shown] || '';
  syncSettingsUI();
});

$('#form-set').addEventListener('submit', (e) => {
  e.preventDefault();
  const prev = state.settings;
  stashDraft();
  const provider = $('#s-provider').value;
  const next = {
    provider,
    keys: { ...draft.keys },
    proxies: { ...draft.proxies },
    apiKey: draft.keys[provider] || '',
    proxy: draft.proxies[provider] || '',
    refresh: Number($('#s-refresh').value),
  };
  const switched = next.provider !== prev.provider || next.apiKey !== prev.apiKey || next.proxy !== prev.proxy;
  state.settings = next;
  if (switched && next.provider !== 'demo') {
    const before = state.flights.length;
    state.flights = state.flights.filter((f) => !f.seed);
    if (state.flights.length < before) toast('Example flights removed.');
  }
  if (switched) state.flights.forEach((f) => { f.snap = next.provider === 'demo' ? f.snap : null; f.err = null; f.lastTry = 0; if (next.provider !== 'demo') delete f.demo; });
  if (switched && next.provider === 'demo') state.flights.forEach((f) => { f.demo = f.demo || demoSeed(f); f.snap = null; });
  save();
  dlgSet.close();
  render();
  if (switched) refreshAll(true);
});

$('#btn-clear').addEventListener('click', function () {
  if (this.dataset.armed !== '1') {
    this.dataset.armed = '1';
    this.textContent = 'Tap again to remove all';
    setTimeout(() => { this.dataset.armed = '0'; this.textContent = 'Remove all flights'; }, 4000);
    return;
  }
  state.flights = [];
  save(); render(); dlgSet.close();
  toast('All flights removed.');
});

document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) close.closest('dialog').close();
  const act = e.target.closest('[data-act]');
  if (act) {
    const f = state.flights.find((x) => x.id === act.dataset.id);
    if (!f) return;
    if (act.dataset.act === 'refresh') refreshOne(f, { manual: true });
    if (act.dataset.act === 'remove') {
      state.flights = state.flights.filter((x) => x.id !== f.id);
      openIds.delete(f.id);
      save(); render();
      toast(`${prettyIdent(f.ident)} removed.`);
    }
  }
  if (e.target instanceof HTMLDialogElement) e.target.close(); // click on the backdrop
});
$('#list').addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.matches) return;
  if (d.matches('details.mapd')) mapOpen.set(d.dataset.key, d.open);
  else if (d.matches('details.more')) { d.open ? openIds.add(d.dataset.id) : openIds.delete(d.dataset.id); }
}, true);

$('#btn-add').addEventListener('click', openAdd);
$('#empty-add').addEventListener('click', openAdd);
$('#btn-refresh').addEventListener('click', () => refreshAll(true));
$('#btn-settings').addEventListener('click', () => { fillSettings(); dlgSet.showModal(); });
$('#banner-settings').addEventListener('click', () => { fillSettings(); dlgSet.showModal(); });

/* ---------- network, timers, install ---------- */

function netStatus() {
  $('#net').textContent = navigator.onLine ? '' : 'Offline';
}
window.addEventListener('online', () => { netStatus(); autoRefresh(); });
window.addEventListener('offline', netStatus);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); autoRefresh(); } });

if (state.settings.provider === 'demo') {
  for (const f of state.flights) if (!f.snap && !waitInfo(f)) { f.demo = f.demo || demoSeed(f); f.snap = demoSnapshot(spec(f)); f.fetchedAt = Date.now(); }
}
netStatus();
render();
setInterval(tickText, 20000);
setInterval(autoRefresh, 30000);
autoRefresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* needs https or localhost */ });
}
