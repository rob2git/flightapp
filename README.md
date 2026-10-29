# Flightapp

An installable web app (PWA) that tracks flights and shows live status: gate and terminal, baggage claim, delays, estimated and actual times, progress, landing countdown and a drawn map for flights in the air or landed.

Each flight is identified by **flight number + local departure date + departure airport + arrival airport**. The two airports pick the right leg when a number has stops.

## Run it

It is plain HTML, CSS and JavaScript with no build step. Serve the folder over HTTPS (or `http://localhost` for testing):

    cd flightapp
    python3 -m http.server 8080      # then open http://localhost:8080

To install it, host the folder on any static host (GitHub Pages, Netlify, Cloudflare Pages, your own server) and use "Install" / "Add to Home Screen" in the browser. Service workers need HTTPS except on localhost.

## User guide

`guide.html` is a plain-language guide for people using the app: adding flights, reading cards, status labels, maps, getting a key for each provider, refreshing, installing, privacy and troubleshooting. It is a static page that uses `styles.css` and is cached by the service worker, so it works offline.

It is linked from **Settings** (User guide, Providers and keys, How refreshing works) and from the empty list ("How it works"). There is deliberately no link in the top bar. Sections can be linked directly, for example `guide.html#providers` or `guide.html#refresh`. The page has a "Back to Flightapp" button at the top and bottom, because an installed app has no browser back button.

When behaviour changes (refresh rules, providers, status labels, error messages), update `guide.html` as well as this file, and add any new page to the `SHELL` list in `sw.js` and bump the cache name there.

## Using it

- **Track a flight:** tap "Track flight", enter the flight number, the departure date (local to the departure airport) and the two 3-letter IATA airport codes. The app looks it up straight away.
- **Cards:** each flight is a card with the status pill, route arc, departure and arrival times (with gate, terminal and baggage belt when the provider has them), an ETA line, a **Map** section once the flight is in the air or landed, and a **Details** section (aircraft, distance, altitude, ground speed, scheduled block time, data source, last update, Refresh and Remove buttons).
- **Order of the cards:** flights that have not finished are listed by departure time, earliest first. A landed or cancelled flight keeps its place for 24 hours after arrival, then drops to the bottom of the list, most recent first.
- **Airport names:** about 140 major airports (including the major US ones) are built in with their city, name, time zone and location. For any other airport the app shows the city the provider returns, or the airport's name when there is no city.
- **Future flights:** a flight whose departure date has not started yet is saved but makes no requests. Its card says tracking starts on that date. At 00:00 on the departure date (in the departure airport's time zone, or your device's time zone if the airport is not in the built-in list) the first lookup happens and the card becomes a normal one.
- **Offline:** the app shell is cached, so it still opens offline and shows the last known status. An "Offline" label appears in the top bar.

## Demo mode

The app starts in **Demo** mode, with nothing sent anywhere. A banner says so and every card carries a "Demo" tag. On the first run it creates **4 example flights**, with times set relative to the moment you first open the app:

| Flight | Route | What you see |
|---|---|---|
| BA286 | SFO to LHR | In the air, about halfway (left the gate about 5 hours ago) |
| LH401 | FRA to JFK | Shown as Delayed: scheduled to leave in about 70 minutes but running 25 minutes late |
| QF12 | LAX to SYD | Just landed (about 40 minutes ago) |
| UA900 | SFO to LHR | Departs 18 days from now, so it shows the "tracking starts" card and makes no updates until then |

Flights you add while in Demo mode get simulated data too, with a departure time, duration and gate worked out from the flight details, so the same flight always looks the same. Demo flights update every minute and stop once they land or are cancelled, whatever refresh option you picked.

The examples are removed the first time you switch to a real provider (a toast says so). "Remove all flights" in Settings empties the list, and the examples do not come back.

## Live data

For real data open Settings, choose a provider and paste your key:

| Provider | Notes |
|---|---|
| AeroDataBox via RapidAPI | Looks up by flight number and local date. Includes gate, terminal, baggage belt, aircraft, live position (plan permitting). |
| AeroDataBox via API.Market | Same data, different marketplace and key. |
| FlightAware AeroAPI | Looks up by flight number and date (last 10 days and next 2 days only). Gives gate times, runway times, gates, terminals, baggage claim and the last reported position. Each refresh costs one lookup. The flown path (a second lookup) is switched off, see [Re-enabling the AeroAPI flown path](#re-enabling-the-aeroapi-flown-path). |
| AviationStack | Looks up by flight number, airports and date, always over HTTPS. The free plan has a small monthly request quota and may not allow date filters; the app retries without the date filter and matches the date itself. |

Settings holds the provider, the API key, an optional proxy address and the refresh option. Each provider keeps its own key and proxy, so switching providers back and forth does not lose them. Saving after a change of provider, key or proxy clears the stored statuses and looks every flight up again once.

Keys and flights are stored in the browser's local storage (key `flightapp.v1`) and sent only to the provider. Clearing the site's data in the browser removes them.

### If the provider blocks browser requests (CORS)

Some providers or plans do not send CORS headers. The symptom is "Could not reach the provider" with a working key. Deploy `proxy/worker.js` as a Cloudflare Worker (instructions are at the top of the file) and enter its address under Settings > Proxy address.

## How refreshing works

There are two kinds of refresh: the ones you ask for, and the ones the app makes itself.

### What you can trigger

- **Top-bar refresh button:** refreshes every tracked flight at once.
- **Refresh in a card's Details:** refreshes just that flight.
- **Adding a flight:** looks it up straight away (unless its date has not started).
- **Saving a change of provider, key or proxy in Settings:** looks every flight up again.
- Flights waiting for their date make no request, even when you tap refresh. A flight whose lookup is already running is not started twice.

### What the app does by itself

While the app is open and visible, it checks every 30 seconds whether any flight is due. A flight is due when the time since its last attempt (successful or not) is longer than its wait. Flights are started 0.4 seconds apart. The wait depends on the **Refresh during a flight** setting:

| Setting | After the first successful lookup |
|---|---|
| **Only when I tap refresh** (the default) | Never. Calls happen only when you tap, plus the one automatic lookup when a flight is first added or its date starts. |
| Every 2, 5 or 15 minutes | That interval, from 3 hours before departure until 1 hour after arrival. In the 24 hours before that window: every 30 minutes. Earlier than that: every 6 hours. |

In both cases it stops refreshing by itself once the flight has landed, been cancelled or been diverted. Departure and arrival here mean the actual time when there is one, then the estimate, then the schedule.

Changing the setting later does not touch a saved choice: whatever is stored stays until you change it in Settings.

### When nothing is sent

- The tab is hidden or the device is offline. When you come back to the tab, or the connection returns, the app checks straight away.
- The flight is waiting for its date.
- The countdowns, progress arc and "in the air" estimates tick every 20 seconds from data already stored. This is display only and uses no network.

### When a lookup fails

The card keeps its last good data and shows a message that it is the last known status.

| Problem | What happens next |
|---|---|
| Bad or missing key | No automatic retries until you fix the key in Settings. |
| Flight not found, or the plan's rate limit hit | Manual mode: waits for your tap. Otherwise retries after 1 hour. |
| No answer or another error before any status was received | Retries after 10 minutes. |

This keeps usage low on metered plans.

## Flight maps

Flights that are in the air or have landed get a **Map** section on the card, open by default while the flight is airborne. The map is drawn by the app itself, with a built-in coastline, so it works offline and needs no map service.

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
3. In `sw.js`, change the cache name (for example `flightapp-shell-v9` to `v10`) so installed copies pick up the new script, and update the FlightAware row in the provider table above.

The track lookup is only made once the flight has `actual_off` or `actual_out`, so flights still at the gate or in the future are not affected. Track points are thinned to at most 250 before they are saved. If the track request fails, the status still shows and the map falls back to the planned route.

## Files

- `index.html`, `styles.css`: page and styling
- `guide.html`: the user guide (shares `styles.css`)
- `js/app.js`: dashboard, forms, refresh scheduling
- `js/providers.js`: provider adapters that map each API to one flight shape, plus the demo provider
- `js/airports.js`, `js/util.js`: airport table (names, cities, time zones, locations); time zone helpers
- `js/map.js`, `js/land.js`: flight map drawing and the simplified coastline (Natural Earth, public domain)
- `sw.js`, `manifest.webmanifest`, `icons/`, `fonts/`: offline shell and install metadata
- `proxy/worker.js`: optional CORS proxy
