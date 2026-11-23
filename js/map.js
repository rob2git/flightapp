// Draws a flight map as SVG: coastlines, the planned great-circle route, the path flown and the aircraft.
// Everything is computed here, so it works offline and needs no map service.
import { LAND } from './land.js';

const W = 400, H = 230;
const RAD = Math.PI / 180;
const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Great-circle distance in km. */
export function gcKm(a, b) {
  const [la1, lo1, la2, lo2] = [a[0] * RAD, a[1] * RAD, b[0] * RAD, b[1] * RAD];
  const h = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** n+1 points along the great circle from a to b, as [lat, lon] with longitudes unwrapped to stay continuous. */
export function gcPoints(a, b, n = 64) {
  const [la1, lo1, la2, lo2] = [a[0] * RAD, a[1] * RAD, b[0] * RAD, b[1] * RAD];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
  const pts = [];
  let prev = a[1];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    let lat, lon;
    if (d < 1e-9) { lat = a[0]; lon = a[1]; } else {
      const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
      const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
      const z = A * Math.sin(la1) + B * Math.sin(la2);
      lat = Math.atan2(z, Math.hypot(x, y)) / RAD;
      lon = Math.atan2(y, x) / RAD;
    }
    lon = prev + wrap(lon - prev);
    prev = lon;
    pts.push([lat, lon]);
  }
  return pts;
}

/** The point a fraction f (0 to 1) of the way along the great circle from a to b. */
export function gcAt(a, b, f) {
  const pts = gcPoints(a, b, 100);
  const i = Math.min(100, Math.max(0, Math.round(f * 100)));
  return pts[i];
}

const mercY = (lat) => {
  const l = Math.max(-82, Math.min(82, lat)) * RAD;
  return Math.log(Math.tan(Math.PI / 4 + l / 2)) / RAD;
};

// Bounding box of each coastline ring, worked out once.
let rings = null;
function prepareLand() {
  if (rings) return rings;
  rings = LAND.map((flat) => {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let i = 0; i < flat.length; i += 2) {
      const x = flat[i] / 10, y = flat[i + 1] / 10;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { flat, x0, x1, y0, y1 };
  });
  return rings;
}

const niceStep = (span) => {
  const target = span / 5;
  for (const s of [1, 2, 5, 10, 15, 20, 30, 45, 60, 90]) if (s >= target) return s;
  return 90;
};

/**
 * opts: {
 *   from: [lat, lon] | null, to: [lat, lon] | null, codes: [fromCode, toCode],
 *   track: [{lat, lon}] | null,      the path flown, when the provider has one
 *   pos: {lat, lon} | null,          current (or estimated) aircraft position
 *   landed: boolean, label: string
 * }
 * Returns SVG markup, or '' when there is nothing to draw.
 */
export function drawMap(opts) {
  const track = (opts.track || []).filter((p) => p && typeof p.lat === 'number');
  const origin = opts.from || (track.length ? [track[0].lat, track[0].lon] : null);
  if (!origin) return '';
  const dest = opts.to || null;
  const lon0 = origin[1];
  const un = (lon) => lon0 + wrap(lon - lon0); // longitudes relative to the origin, so routes can cross the date line

  // Planned route and flown path, as [lat, lon]
  const planned = dest ? gcPoints(origin, [dest[0], un(dest[1])], 80) : [];
  let flown = [];
  if (track.length > 1) {
    let prev = lon0;
    flown = track.map((p) => { const lo = prev + wrap(p.lon - prev); prev = lo; return [p.lat, lo]; });
  } else if (opts.pos) {
    flown = gcPoints(origin, [opts.pos.lat, un(opts.pos.lon)], 40);
  } else if (opts.landed && planned.length) {
    flown = planned;
  }
  let plane = null;
  if (opts.pos) plane = [opts.pos.lat, flown.length ? flown[flown.length - 1][1] : un(opts.pos.lon)];
  else if (flown.length && !opts.landed) plane = flown[flown.length - 1];

  // View: fit everything in a Mercator window
  const all = [origin, ...planned, ...flown];
  if (plane) all.push(plane);
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const [lat, lon] of all) {
    const y = -mercY(lat);
    if (lon < x0) x0 = lon; if (lon > x1) x1 = lon; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const pad = 0.14;
  let dx = Math.max(x1 - x0, 6), dy = Math.max(y1 - y0, 6 * (H / W));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  // match the drawing's aspect ratio
  if (dx / dy > W / H) dy = dx * (H / W); else dx = dy * (W / H);
  dx *= 1 + pad * 2; dy *= 1 + pad * 2;
  const k = W / dx;
  const px = (lon) => (lon - cx) * k + W / 2;
  const py = (lat) => (-mercY(lat) - cy) * k + H / 2;
  const vx0 = cx - dx / 2, vx1 = cx + dx / 2;
  const latTop = Math.atan(Math.sinh((-(cy - dy / 2)) * RAD)) / RAD;
  const latBot = Math.atan(Math.sinh((-(cy + dy / 2)) * RAD)) / RAD;

  const f1 = (n) => (Math.round(n * 10) / 10).toString();
  const path = (pts) => 'M' + pts.map(([lat, lon]) => `${f1(px(lon))} ${f1(py(lat))}`).join('L');

  // Graticule
  const step = niceStep(dx);
  let grid = '';
  for (let lon = Math.ceil(vx0 / step) * step; lon <= vx1; lon += step) grid += `M${f1(px(lon))} 0V${H}`;
  const latStep = niceStep(Math.abs(latTop - latBot));
  for (let lat = Math.ceil(latBot / latStep) * latStep; lat <= latTop; lat += latStep) grid += `M0 ${f1(py(lat))}H${W}`;

  // Land
  let land = '';
  for (const r of prepareLand()) {
    if (r.y1 < latBot - 1 || r.y0 > latTop + 1) continue;
    for (const shift of [-360, 0, 360]) {
      if (r.x1 + shift < vx0 - 1 || r.x0 + shift > vx1 + 1) continue;
      let d = '';
      for (let i = 0; i < r.flat.length; i += 2) d += (i ? 'L' : 'M') + f1(px(r.flat[i] / 10 + shift)) + ' ' + f1(py(r.flat[i + 1] / 10));
      land += d + 'Z';
    }
  }

  // Airport dots and labels
  const dot = (pt, code, filled) => {
    if (!pt) return '';
    const x = px(pt[1]), y = py(pt[0]);
    const right = x < W - 70;
    return `<circle class="map-dot${filled ? ' map-dot-full' : ''}" cx="${f1(x)}" cy="${f1(y)}" r="4.2"/>` +
      (code ? `<text class="map-label" x="${f1(x + (right ? 8 : -8))}" y="${f1(y - 7)}" text-anchor="${right ? 'start' : 'end'}">${code}</text>` : '');
  };
  const destPt = dest ? [dest[0], planned.length ? planned[planned.length - 1][1] : dest[1]] : null;

  // Plane, pointing along the last stretch of path (or toward the destination)
  let planeSvg = '';
  if (plane) {
    const ref = flown.length > 1 ? flown[Math.max(0, flown.length - 4)] : origin;
    let ang = Math.atan2(py(plane[0]) - py(ref[0]), px(plane[1]) - px(ref[1])) / RAD;
    if (flown.length <= 1 && destPt) ang = Math.atan2(py(destPt[0]) - py(plane[0]), px(destPt[1]) - px(plane[1])) / RAD;
    planeSvg = `<g transform="translate(${f1(px(plane[1]))} ${f1(py(plane[0]))}) rotate(${f1(ang)})"><circle class="map-halo" r="11"/><polygon class="map-plane" points="-8,-6 10,0 -8,6 -4,0"/></g>`;
  }

  const aria = `Map of ${opts.codes && opts.codes[0] || ''} to ${opts.codes && opts.codes[1] || ''}`.trim();
  return `<svg class="map-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${aria}" preserveAspectRatio="xMidYMid meet">
    <defs><clipPath id="mapclip"><rect width="${W}" height="${H}" rx="8"/></clipPath></defs>
    <g clip-path="url(#mapclip)">
      <rect class="map-sea" width="${W}" height="${H}"/>
      <path class="map-grid" d="${grid}"/>
      <path class="map-land" d="${land}"/>
      ${planned.length ? `<path class="map-plan" d="${path(planned)}"/>` : ''}
      ${flown.length > 1 ? `<path class="map-flown" d="${path(flown)}"/>` : ''}
      ${dot(origin, opts.codes && opts.codes[0], true)}${dot(destPt, opts.codes && opts.codes[1], !!opts.landed)}
      ${planeSvg}
    </g>
  </svg>`;
}
