# Flightapp

An installable web app (PWA) that tracks flights and shows live status: gate and terminal, delays, estimated and actual times, progress and landing countdown.

Each flight is identified by **flight number + local departure date + departure airport + arrival airport**. The two airports pick the right leg when a number has stops.

## Run it

It is plain HTML, CSS and JavaScript with no build step. Serve the folder over HTTPS (or `http://localhost` for testing):

    cd flightapp
    python3 -m http.server 8080      # then open http://localhost:8080

To install it, host the folder on any static host (GitHub Pages, Netlify, Cloudflare Pages, your own server) and use "Install" / "Add to Home Screen" in the browser. Service workers need HTTPS except on localhost.

## Live data

The app opens in **Demo** mode with three simulated flights. For real data open Settings, choose a provider and paste your key:

| Provider | Notes |
|---|---|
| AeroDataBox via RapidAPI | Looks up by flight number and local date. Includes gate, terminal, baggage belt, aircraft, live position (plan permitting). |
| AeroDataBox via API.Market | Same data, different marketplace and key. |
| FlightAware AeroAPI | Looks up by flight number and date (last 10 days and next 2 days only). Gives gate times, runway times, gates, terminals, baggage claim and the last reported position. Each refresh costs one lookup. The flown path (a second lookup) is switched off, see [Re-enabling the AeroAPI flown path](#re-enabling-the-aeroapi-flown-path). |
| AviationStack | Looks up by flight number, airports and date. The free plan has a small monthly request quota and may not allow date filters; the app retries without the date filter and matches the date itself. |

Keys and flights are stored in the browser's local storage and sent only to the provider.

### If the provider blocks browser requests (CORS)

Some providers or plans do not send CORS headers. The symptom is "Could not reach the provider" with a working key. Deploy `proxy/worker.js` as a Cloudflare Worker (instructions are at the top of the file) and enter its address under Settings > Proxy address.

## Flight maps

Flights that are in the air or have landed get a **Map** section on the card. The map is drawn by the app itself, with a built-in coastline, so it works offline and needs no map service.

- The dashed line is the planned great-circle route; the solid line is the path flown.
- With FlightAware the aircraft sits at its last reported position. The real flown path is available but switched off to save API calls (see below), so the solid line currently runs straight from the origin to the aircraft.
- With AeroDataBox or AviationStack the aircraft sits at the position they report, and there is no flown path to draw.
- With no live position (Demo, or a provider that has none) the position is estimated from the schedule and the caption says so.

Maps need the departure and arrival airports to be in the built-in list of about 140 airports (`js/airports.js`, `AIRPORT_POS`), or a track from the provider. Add airports there if one is missing.

### Re-enabling the AeroAPI flown path

The FlightAware adapter can draw the real path the aircraft flew, but that needs a second request on every refresh, so it is commented out.

**What is off and why.** Once a flight has left the gate, `aeroApi()` in `js/providers.js` used to call `GET /flights/{fa_flight_id}/track` after the main lookup (`GET /flights/{ident}`). That doubled the lookups for every refresh of a flight in the air or just landed. The block now sits between the comments `FLOWN PATH START` and `FLOWN PATH END`, with every line prefixed by `//`. `let track = null;` just above it stays, so `track` is always `null`.

**What you see with it off.**
- In the air: the map shows the dashed planned route, the aircraft at the last position FlightAware reported, and a straight solid line from the origin to the aircraft (not the real path).
- After landing: the map shows the planned route only, captioned "Planned route. No flight path was provided."
- Everything else (times, gates, status, altitude, ground speed) is unchanged, because those come from the main lookup. The app never calls FlightAware's own `/map` image endpoint.

**To turn it back on** (three small edits):
1. In `js/providers.js`, delete the leading `// ` from every line from `// FLOWN PATH START` to `// FLOWN PATH END` (leave the START and END marker lines themselves commented). Keep `let track = null;`.
2. In `js/app.js`, in the `HINTS` text for `aeroapi`, change "Each refresh uses one lookup." back to "Each refresh of a flight in the air uses two lookups (status and flight path)."
3. In `sw.js`, change the cache name (for example `flightapp-shell-v8` to `v9`) so installed copies pick up the new script, and update this README table row.

The track lookup is only made once the flight has `actual_off` or `actual_out`, so flights still at the gate or in the future are not affected. Track points are thinned to at most 250 before they are saved. If the track request fails, the status still shows and the map falls back to the planned route.

## How refreshing works

The app polls only while it is open. Per flight: every 2, 5 or 15 minutes (your choice) from 3 hours before departure until 1 hour after landing, every 30 minutes in the 24 hours before that, every 6 hours earlier, and never after landing or cancellation. This keeps usage low on metered plans. The refresh button always asks right away.

Offline, the app still opens and shows the last known status.

## Files

- `index.html`, `styles.css`: page and styling
- `js/app.js`: dashboard, forms, refresh scheduling
- `js/providers.js`: provider adapters that map each API to one flight shape, plus the demo provider
- `js/airports.js`, `js/util.js`: airport table (names, time zones, locations); time zone helpers
- `js/map.js`, `js/land.js`: flight map drawing and the simplified coastline (Natural Earth, public domain)
- `sw.js`, `manifest.webmanifest`, `icons/`, `fonts/`: offline shell and install metadata
- `proxy/worker.js`: optional CORS proxy
