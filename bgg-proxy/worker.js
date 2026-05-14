/**
 * Cloudflare Worker — BGG XML API2 CORS proxy
 *
 * Setup:
 *  1. Go to https://dash.cloudflare.com → Workers & Pages → Create Worker
 *  2. Paste this entire file, click Deploy
 *  3. Open the Worker → Settings → Variables → add a Secret:
 *       Name:  BGG_API_KEY
 *       Value: your BGG API key (the UUID from your approval email)
 *  4. Copy your Worker URL (e.g. https://bgg-proxy.YOUR-NAME.workers.dev)
 *  5. Paste it into the "BGG Proxy URL" field in the collection site Settings
 */

const BGG_BASE    = 'https://boardgamegeek.com/xmlapi2';
const ALLOWED     = ['/search', '/thing'];
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Only proxy the two endpoints the app needs
    if (!ALLOWED.includes(url.pathname)) {
      return new Response('Not found', { status: 404, headers: CORS_HEADERS });
    }

    // Inject API key from secret (keeps it off the client)
    const params = new URLSearchParams(url.search);
    if (env.BGG_API_KEY) params.set('apikey', env.BGG_API_KEY);

    const bggUrl = `${BGG_BASE}${url.pathname}?${params}`;

    let bggRes = await fetch(bggUrl, {
      headers: { 'User-Agent': 'game-collection-proxy/1.0' },
    });

    // BGG sometimes queues requests and returns 202 — retry once
    if (bggRes.status === 202) {
      await new Promise(r => setTimeout(r, 2500));
      bggRes = await fetch(bggUrl, {
        headers: { 'User-Agent': 'game-collection-proxy/1.0' },
      });
    }

    const body = await bggRes.text();

    return new Response(body, {
      status: bggRes.status,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  },
};
