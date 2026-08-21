function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isAuthorized(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  return token === env.ADMIN_PASSWORD;
}

async function readRanges(env) {
  const data = await env.BOOKINGS.get('ranges');
  return data ? JSON.parse(data) : [];
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders();

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    // Public: date ranges only, never includes who booked.
    if (url.pathname === '/api/bookings' && request.method === 'GET') {
      const ranges = await readRanges(env);
      const publicRanges = ranges.map(r => ({ start: r.start, end: r.end }));
      return new Response(JSON.stringify(publicRanges), {
        headers: { 'Content-Type': 'application/json', ...headers },
      });
    }

    // Admin-only: full data including the booker's name.
    if (url.pathname === '/api/bookings/full' && request.method === 'GET') {
      if (!isAuthorized(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...headers },
        });
      }
      const ranges = await readRanges(env);
      return new Response(JSON.stringify(ranges), {
        headers: { 'Content-Type': 'application/json', ...headers },
      });
    }

    if (url.pathname === '/api/bookings' && request.method === 'POST') {
      if (!isAuthorized(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...headers },
        });
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...headers },
        });
      }

      if (!Array.isArray(body)) {
        return new Response(JSON.stringify({ error: 'Expected an array' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...headers },
        });
      }
      for (const r of body) {
        if (!r || typeof r.start !== 'string' || typeof r.end !== 'string' || !DATE_RE.test(r.start) || !DATE_RE.test(r.end)) {
          return new Response(JSON.stringify({ error: 'Invalid range format, expected {start:"YYYY-MM-DD", end:"YYYY-MM-DD", name?:"string"}' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...headers },
          });
        }
        if (r.name !== undefined && typeof r.name !== 'string') {
          return new Response(JSON.stringify({ error: 'name must be a string' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...headers },
          });
        }
      }

      const cleaned = body.map(r => ({ start: r.start, end: r.end, name: (r.name || '').slice(0, 200) }));
      await env.BOOKINGS.put('ranges', JSON.stringify(cleaned));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', ...headers },
      });
    }

    if (url.pathname === '/api/login' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        body = {};
      }
      const ok = typeof body.password === 'string' && body.password === env.ADMIN_PASSWORD;
      return new Response(JSON.stringify({ ok }), {
        status: ok ? 200 : 401,
        headers: { 'Content-Type': 'application/json', ...headers },
      });
    }

    return new Response('Not found', { status: 404, headers });
  },
};
