import { buildInvoicePdf, buildContractPdf } from './pdf.js';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const json = (data, extra = {}, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...extra },
  });
const err = (message, status = 400) => json({ error: message }, {}, status);

function isAuthorized(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  return token === env.ADMIN_PASSWORD;
}

async function readJSON(env, key, fallback) {
  const data = await env.BOOKINGS.get(key);
  return data ? JSON.parse(data) : fallback;
}
async function writeJSON(env, key, value) {
  await env.BOOKINGS.put(key, JSON.stringify(value));
}

const DEFAULT_SETTINGS = {
  companyName: 'Gwunderstübli',
  companyAddress: 'Rawilstrasse 27, 3775 Lenk',
  accountHolder: '',
  iban: '',
  paymentTermsDays: 14,
  invoicePrefix: '2026-',
  currency: 'CHF',
  vatRate: 0,
};
const DEFAULT_WEEK_PRICING = { defaultPrice: 700, overrides: {} };

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Next Saturday on/after `from` (YYYY-MM-DD). JS getUTCDay(): 0=Sun..6=Sat.
function nextSaturday(fromStr) {
  const [y, m, d] = fromStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();
  const diff = (6 - day + 7) % 7;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().slice(0, 10);
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

async function getOccupiedSpans(env) {
  const ranges = await readJSON(env, 'ranges', []);
  const stays = await readJSON(env, 'stays', []);
  const booked = ranges.map((r) => ({ start: r.start, end: addDays(r.end, 1) })); // ranges end is inclusive
  const pending = stays
    .filter((s) => s.status === 'pending')
    .map((s) => ({ start: s.arrival, end: s.departure }));
  return { booked, pending };
}

function isOccupied(start, end, spans) {
  return spans.some((s) => rangesOverlap(start, end, s.start, s.end));
}

async function priceForWeek(env, weekStart) {
  const pricing = await readJSON(env, 'weekPricing', DEFAULT_WEEK_PRICING);
  if (pricing.overrides && Object.prototype.hasOwnProperty.call(pricing.overrides, weekStart)) {
    return pricing.overrides[weekStart];
  }
  return pricing.defaultPrice;
}

async function handleWeeks(request, env) {
  const url = new URL(request.url);
  const count = Math.min(parseInt(url.searchParams.get('weeks') || '52', 10) || 52, 104);
  const today = new Date().toISOString().slice(0, 10);
  let cursor = nextSaturday(today);
  const { booked, pending } = await getOccupiedSpans(env);
  const pricing = await readJSON(env, 'weekPricing', DEFAULT_WEEK_PRICING);

  const weeks = [];
  for (let i = 0; i < count; i++) {
    const start = cursor;
    const end = addDays(start, 7);
    const price = pricing.overrides?.[start] ?? pricing.defaultPrice;
    let status = 'free';
    if (isOccupied(start, end, booked)) status = 'booked';
    else if (isOccupied(start, end, pending)) status = 'requested';
    weeks.push({ start, end, price, status });
    cursor = end;
  }
  return json(weeks);
}

async function handleCreateRequest(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err('Invalid JSON');
  }

  // Honeypot: bots that fill this hidden field get a fake success, nothing is stored.
  if (body.website) {
    return json({ ok: true });
  }

  const guestName = String(body.guestName || '').trim().slice(0, 200);
  const address = String(body.address || '').trim().slice(0, 500);
  const email = String(body.email || '').trim().slice(0, 200);
  const numPeople = Math.max(1, Math.min(20, parseInt(body.numPeople, 10) || 1));
  const message = String(body.message || '').trim().slice(0, 2000);

  if (!guestName || !email || !address) {
    return err('Name, Adresse und E-Mail sind erforderlich.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return err('Ungültige E-Mail-Adresse.');
  }

  const isCustom = body.type === 'custom';
  const arrival = body.arrival;
  const departure = body.departure;
  if (!DATE_RE.test(arrival) || !DATE_RE.test(departure) || arrival >= departure) {
    return err('Ungültiger Zeitraum.');
  }

  let weeklyPrice = null;
  if (!isCustom) {
    // Validate it's a whole number of Sat-to-Sat weeks and not already taken.
    const { booked, pending } = await getOccupiedSpans(env);
    if (isOccupied(arrival, departure, booked) || isOccupied(arrival, departure, pending)) {
      return err('Dieser Zeitraum ist leider nicht mehr verfügbar.');
    }
    let cursor = arrival;
    let total = 0;
    let weeks = 0;
    while (cursor < departure) {
      if (nextSaturday(cursor) !== cursor) {
        return err('Standard-Anfragen müssen jeweils Samstag bis Samstag laufen.');
      }
      total += await priceForWeek(env, cursor);
      cursor = addDays(cursor, 7);
      weeks++;
    }
    if (cursor !== departure || weeks < 1) {
      return err('Standard-Anfragen müssen jeweils Samstag bis Samstag laufen.');
    }
    weeklyPrice = total;
  }

  const stay = {
    id: crypto.randomUUID(),
    status: 'pending',
    guestName,
    address,
    email,
    arrival,
    departure,
    numPeople,
    isCustomRequest: isCustom,
    weeklyPrice,
    extraCosts: [],
    total: weeklyPrice,
    invoiceNumber: null,
    message,
    createdAt: new Date().toISOString(),
    decidedAt: null,
  };

  const stays = await readJSON(env, 'stays', []);
  stays.push(stay);
  await writeJSON(env, 'stays', stays);

  return json({ ok: true, id: stay.id });
}

async function handleDecision(request, env, id) {
  if (!isAuthorized(request, env)) return err('Unauthorized', 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return err('Invalid JSON');
  }

  const stays = await readJSON(env, 'stays', []);
  const stay = stays.find((s) => s.id === id);
  if (!stay) return err('Nicht gefunden', 404);
  if (stay.status !== 'pending') return err('Diese Anfrage wurde bereits bearbeitet.');

  if (body.action === 'reject') {
    stay.status = 'rejected';
    stay.decidedAt = new Date().toISOString();
    await writeJSON(env, 'stays', stays);
    return json({ ok: true });
  }

  if (body.action !== 'approve') return err('Unbekannte Aktion.');

  const weeklyPrice = typeof body.weeklyPrice === 'number' ? body.weeklyPrice : stay.weeklyPrice;
  const extraCosts = Array.isArray(body.extraCosts)
    ? body.extraCosts
        .filter((c) => c && typeof c.label === 'string' && typeof c.amount === 'number')
        .map((c) => ({ label: c.label.slice(0, 200), amount: c.amount }))
    : [];
  if (typeof weeklyPrice !== 'number' || weeklyPrice < 0) {
    return err('Bitte einen gültigen Preis angeben.');
  }

  const total = weeklyPrice + extraCosts.reduce((sum, c) => sum + c.amount, 0);

  const counter = (await readJSON(env, 'invoiceCounter', 0)) + 1;
  await writeJSON(env, 'invoiceCounter', counter);
  const settings = await readJSON(env, 'settings', DEFAULT_SETTINGS);
  const invoiceNumber = `${settings.invoicePrefix || ''}${String(counter).padStart(4, '0')}`;

  stay.status = 'confirmed';
  stay.weeklyPrice = weeklyPrice;
  stay.extraCosts = extraCosts;
  stay.total = total;
  stay.invoiceNumber = invoiceNumber;
  stay.decidedAt = new Date().toISOString();
  await writeJSON(env, 'stays', stays);

  // Reuses the exact same storage the manual admin range-entry writes to.
  const ranges = await readJSON(env, 'ranges', []);
  ranges.push({ start: stay.arrival, end: addDays(stay.departure, -1), name: stay.guestName });
  await writeJSON(env, 'ranges', ranges);

  const invoiceBytes = await buildInvoicePdf(stay, settings);
  const contractBytes = await buildContractPdf(stay, settings);
  await env.BOOKINGS.put(`pdf:invoice:${stay.id}`, invoiceBytes);
  await env.BOOKINGS.put(`pdf:contract:${stay.id}`, contractBytes);

  return json({ ok: true, invoiceNumber });
}

async function handlePdf(env, id, kind) {
  const bytes = await env.BOOKINGS.get(`pdf:${kind}:${id}`, 'arrayBuffer');
  if (!bytes) return err('PDF nicht gefunden', 404);
  return new Response(bytes, {
    headers: { 'Content-Type': 'application/pdf', ...corsHeaders() },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const headers = corsHeaders();

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    // --- Legacy manual-range endpoints (identical to production) ---
    if (path === '/api/bookings' && request.method === 'GET') {
      const ranges = await readJSON(env, 'ranges', []);
      return json(ranges.map((r) => ({ start: r.start, end: r.end })));
    }
    if (path === '/api/bookings/full' && request.method === 'GET') {
      if (!isAuthorized(request, env)) return err('Unauthorized', 401);
      return json(await readJSON(env, 'ranges', []));
    }
    if (path === '/api/bookings' && request.method === 'POST') {
      if (!isAuthorized(request, env)) return err('Unauthorized', 401);
      let body;
      try {
        body = await request.json();
      } catch {
        return err('Invalid JSON');
      }
      if (!Array.isArray(body)) return err('Expected an array');
      for (const r of body) {
        if (!r || typeof r.start !== 'string' || typeof r.end !== 'string' || !DATE_RE.test(r.start) || !DATE_RE.test(r.end)) {
          return err('Invalid range format, expected {start, end, name?}');
        }
      }
      const cleaned = body.map((r) => ({ start: r.start, end: r.end, name: (r.name || '').slice(0, 200) }));
      await writeJSON(env, 'ranges', cleaned);
      return json({ ok: true });
    }
    if (path === '/api/login' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        body = {};
      }
      const ok = typeof body.password === 'string' && body.password === env.ADMIN_PASSWORD;
      return json({ ok }, {}, ok ? 200 : 401);
    }

    // --- New: week pricing ---
    if (path === '/api/weeks' && request.method === 'GET') {
      return handleWeeks(request, env);
    }
    if (path === '/api/weekpricing' && request.method === 'GET') {
      if (!isAuthorized(request, env)) return err('Unauthorized', 401);
      return json(await readJSON(env, 'weekPricing', DEFAULT_WEEK_PRICING));
    }
    if (path === '/api/weekpricing' && request.method === 'PUT') {
      if (!isAuthorized(request, env)) return err('Unauthorized', 401);
      let body;
      try {
        body = await request.json();
      } catch {
        return err('Invalid JSON');
      }
      if (typeof body.defaultPrice !== 'number' || typeof body.overrides !== 'object') {
        return err('Invalid pricing payload');
      }
      await writeJSON(env, 'weekPricing', { defaultPrice: body.defaultPrice, overrides: body.overrides });
      return json({ ok: true });
    }

    // --- New: settings ---
    if (path === '/api/settings' && request.method === 'GET') {
      if (!isAuthorized(request, env)) return err('Unauthorized', 401);
      return json(await readJSON(env, 'settings', DEFAULT_SETTINGS));
    }
    if (path === '/api/settings' && request.method === 'PUT') {
      if (!isAuthorized(request, env)) return err('Unauthorized', 401);
      let body;
      try {
        body = await request.json();
      } catch {
        return err('Invalid JSON');
      }
      await writeJSON(env, 'settings', { ...DEFAULT_SETTINGS, ...body });
      return json({ ok: true });
    }

    // --- New: guest requests & stays ---
    if (path === '/api/requests' && request.method === 'POST') {
      return handleCreateRequest(request, env);
    }
    if (path === '/api/stays/full' && request.method === 'GET') {
      if (!isAuthorized(request, env)) return err('Unauthorized', 401);
      return json(await readJSON(env, 'stays', []));
    }
    const decisionMatch = path.match(/^\/api\/stays\/([a-f0-9-]+)\/decision$/);
    if (decisionMatch && request.method === 'POST') {
      return handleDecision(request, env, decisionMatch[1]);
    }
    const pdfMatch = path.match(/^\/api\/stays\/([a-f0-9-]+)\/(invoice|contract)\.pdf$/);
    if (pdfMatch && request.method === 'GET') {
      if (!isAuthorized(request, env)) return err('Unauthorized', 401);
      return handlePdf(env, pdfMatch[1], pdfMatch[2]);
    }

    return new Response('Not found', { status: 404, headers });
  },
};
