// Optional Cloudflare Worker that forwards requests to a flight-data API and adds CORS headers.
// Use it only if your provider blocks calls made directly from a browser.
//
// 1. Create a Worker and paste this file in.
// 2. Add a variable UPSTREAM, for example https://aerodatabox.p.rapidapi.com
// 3. Add a variable ALLOW_ORIGIN with the address you host Flightapp at, for example https://flights.example.com
// 4. Put the Worker's address in Flightapp > Settings > Proxy address.
//
// Your API key is still entered in Flightapp and passed through in the request headers.
export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });
    const url = new URL(request.url);
    const upstream = new URL(env.UPSTREAM.replace(/\/+$/, '') + url.pathname + url.search);
    const res = await fetch(upstream, { headers: request.headers });
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
