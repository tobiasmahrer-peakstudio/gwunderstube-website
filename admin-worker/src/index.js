function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders();

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    if (url.pathname === '/api/bookings' && request.method === 'GET') {
      const data = await env.BOOKINGS.get('ranges');
      return new Response(data || '[]', {
        headers: { 'Content-Type': 'application/json', ...headers },
      });
    }

    if (url.pathname === '/api/bookings' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.replace('Bearer ', '');
      if (token !== env.ADMIN_PASSWORD) {
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
          return new Response(JSON.stringify({ error: 'Invalid range format, expected {start:"YYYY-MM-DD", end:"YYYY-MM-DD"}' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...headers },
          });
        }
      }

      await env.BOOKINGS.put('ranges', JSON.stringify(body));
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
