// Optional Cloudflare Worker that forwards requests to a flight-data API and adds CORS headers.
// Use it when your provider does not allow calls made directly from a browser. FlightAware AeroAPI always needs it.
//
// 1. Create a Worker and paste this file in.
// 2. Add a variable UPSTREAM with the address for your provider (no trailing slash):
//      FlightAware AeroAPI       https://aeroapi.flightaware.com/aeroapi
//      AeroDataBox via RapidAPI  https://aerodatabox.p.rapidapi.com
//      AeroDataBox via API.Market https://prod.api.market/api/v1/aedbx/aerodatabox
//      AviationStack             https://api.aviationstack.com/v1
// 3. Add a variable ALLOW_ORIGIN with the address you host Flightapp at, for example https://flights.example.com
//    (use http://localhost:8080 when testing locally, with the port you use). Without it, any site may use the Worker.
// 4. Deploy, then put the Worker's address (for example https://flightapp-proxy.yourname.workers.dev, no trailing
//    slash) in Flightapp > Settings > Proxy address, with that provider selected.
//
// Your API key is still entered in Flightapp and passed through in the request headers. The Worker does not store it.
export default {
  async fetch(request, env) {
    // Use just the origin of ALLOW_ORIGIN, so a trailing slash or path cannot break the match.
    let allow = '*';
    if (env.ALLOW_ORIGIN) { try { allow = new URL(env.ALLOW_ORIGIN).origin; } catch { allow = env.ALLOW_ORIGIN; } }
    const cors = {
      'Access-Control-Allow-Origin': allow,
      'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };
    // Errors are sent back with the CORS headers too, so the app can show what went wrong.
    const fail = (status, message) => new Response(JSON.stringify({ message }), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return fail(405, 'Method not allowed.');
    if (!env.UPSTREAM) return fail(500, 'The Worker has no UPSTREAM variable. Add it, as described at the top of worker.js.');

    const url = new URL(request.url);
    let upstream;
    try { upstream = new URL(env.UPSTREAM.replace(/\/+$/, '') + url.pathname + url.search); } catch { return fail(500, 'The UPSTREAM variable is not a valid address.'); }
    const headers = new Headers(request.headers);
    headers.delete('origin'); // the provider should see an ordinary server request
    headers.delete('referer');
    let res;
    try { res = await fetch(upstream, { headers }); } catch (e) { return fail(502, `The Worker could not reach the provider: ${e.message}`); }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
