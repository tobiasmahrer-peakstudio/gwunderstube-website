import { buildBookingDocumentPdf } from './pdf.js';

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
  paymentTermsDays: 30,
  invoicePrefix: '2026-',
  currency: 'CHF',
  vatRate: 0,
};
// Saison-Grenzen: Winter = Dezember-März, Sommer = April-November (deckt das ganze Jahr ab).
const DEFAULT_WEEK_PRICING = {
  winterPrice: 750,
  summerPrice: 650,
  overrides: {},
  shortStay: {
    // Index 0 = 1 Nacht ... Index 5 = 6 Nächte. Nur als Referenz für "Sonderanfragen" (Kurzaufenthalte).
    winter: [215, 305, 395, 485, 575, 665],
    summer: [200, 275, 350, 425, 500, 575],
  },
};

function isWinterMonth(dateStr) {
  const month = parseInt(dateStr.split('-')[1], 10);
  return month === 12 || month === 1 || month === 2 || month === 3;
}

// A week spanning the winter/summer boundary is priced by whichever season covers
// the majority of its 7 nights (always a clear majority since 7 is odd).
function seasonForWeek(weekStart) {
  let winterNights = 0;
  for (let i = 0; i < 7; i++) {
    if (isWinterMonth(addDays(weekStart, i))) winterNights++;
  }
  return winterNights >= 4 ? 'winter' : 'summer';
}

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

function computeWeekPrice(pricing, weekStart) {
  if (pricing.overrides && Object.prototype.hasOwnProperty.call(pricing.overrides, weekStart)) {
    return pricing.overrides[weekStart];
  }
  return seasonForWeek(weekStart) === 'winter' ? pricing.winterPrice : pricing.summerPrice;
}

async function priceForWeek(env, weekStart) {
  const pricing = await readJSON(env, 'weekPricing', DEFAULT_WEEK_PRICING);
  return computeWeekPrice(pricing, weekStart);
}

// Best-effort price for an arbitrary arrival/departure span: the short-stay table for
// 1-6 nights, or the sum of week prices for an exact multiple of 7 nights. Anything
// else (an odd span that fits neither pattern) returns null so the admin sets it by hand.
async function computeStayPrice(env, arrival, departure) {
  const nights = Math.round((new Date(departure) - new Date(arrival)) / 86400000);
  if (nights < 1) return null;
  const pricing = await readJSON(env, 'weekPricing', DEFAULT_WEEK_PRICING);
  if (nights <= 6) {
    const season = isWinterMonth(arrival) ? 'winter' : 'summer';
    const table = pricing.shortStay && pricing.shortStay[season];
    return table && table[nights - 1] !== undefined ? table[nights - 1] : null;
  }
  if (nights % 7 === 0) {
    let total = 0;
    let cursor = arrival;
    for (let i = 0; i < nights / 7; i++) {
      total += computeWeekPrice(pricing, cursor);
      cursor = addDays(cursor, 7);
    }
    return total;
  }
  return null;
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
    const price = computeWeekPrice(pricing, start);
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
  if (body.agbAccepted !== true) {
    return err('Die AGB müssen akzeptiert werden.');
  }

  const isCustom = body.type === 'custom';
  const arrival = body.arrival;
  const departure = body.departure;
  if (!DATE_RE.test(arrival) || !DATE_RE.test(departure) || arrival >= departure) {
    return err('Ungültiger Zeitraum.');
  }

  const { booked, pending } = await getOccupiedSpans(env);
  if (isOccupied(arrival, departure, booked) || isOccupied(arrival, departure, pending)) {
    return err('Dieser Zeitraum ist leider nicht mehr verfügbar.');
  }

  let weeklyPrice = null;
  if (!isCustom) {
    // Validate it's a whole number of Sat-to-Sat weeks.
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
    agbAccepted: true,
    agbAcceptedAt: new Date().toISOString(),
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

  const documentBytes = await buildBookingDocumentPdf(stay, settings);
  await env.BOOKINGS.put(`pdf:document:${stay.id}`, documentBytes);

  return json({ ok: true, invoiceNumber });
}

// Arma entering a booking directly (phone/in person) — creates a confirmed stay with
// invoice + document right away, same as approving a guest request, just without the
// pending step. Reuses the same overlap check against existing bookings.
async function handleManualStay(request, env) {
  if (!isAuthorized(request, env)) return err('Unauthorized', 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return err('Invalid JSON');
  }

  const guestName = String(body.guestName || '').trim().slice(0, 200);
  const address = String(body.address || '').trim().slice(0, 500);
  const email = String(body.email || '').trim().slice(0, 200);
  const numPeople = Math.max(1, Math.min(20, parseInt(body.numPeople, 10) || 2));
  const message = String(body.message || '').trim().slice(0, 2000);
  const arrival = body.arrival;
  const departure = body.departure;

  if (!guestName) return err('Bitte einen Namen angeben.');
  if (!DATE_RE.test(arrival) || !DATE_RE.test(departure) || arrival >= departure) {
    return err('Ungültiger Zeitraum.');
  }

  const { booked } = await getOccupiedSpans(env);
  if (isOccupied(arrival, departure, booked)) {
    return err('Dieser Zeitraum ist bereits belegt.');
  }

  let weeklyPrice = typeof body.weeklyPrice === 'number' ? body.weeklyPrice : await computeStayPrice(env, arrival, departure);
  if (typeof weeklyPrice !== 'number' || weeklyPrice < 0) {
    return err('Preis konnte nicht automatisch berechnet werden. Bitte manuell angeben.');
  }
  const extraCosts = Array.isArray(body.extraCosts)
    ? body.extraCosts
        .filter((c) => c && typeof c.label === 'string' && typeof c.amount === 'number')
        .map((c) => ({ label: c.label.slice(0, 200), amount: c.amount }))
    : [];
  const total = weeklyPrice + extraCosts.reduce((sum, c) => sum + c.amount, 0);

  const counter = (await readJSON(env, 'invoiceCounter', 0)) + 1;
  await writeJSON(env, 'invoiceCounter', counter);
  const settings = await readJSON(env, 'settings', DEFAULT_SETTINGS);
  const invoiceNumber = `${settings.invoicePrefix || ''}${String(counter).padStart(4, '0')}`;

  const stay = {
    id: crypto.randomUUID(),
    status: 'confirmed',
    guestName,
    address,
    email,
    arrival,
    departure,
    numPeople,
    isCustomRequest: Math.round((new Date(departure) - new Date(arrival)) / 86400000) <= 6,
    weeklyPrice,
    extraCosts,
    total,
    invoiceNumber,
    message,
    createdAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
  };

  const stays = await readJSON(env, 'stays', []);
  stays.push(stay);
  await writeJSON(env, 'stays', stays);

  const ranges = await readJSON(env, 'ranges', []);
  ranges.push({ start: arrival, end: addDays(departure, -1), name: guestName });
  await writeJSON(env, 'ranges', ranges);

  const documentBytes = await buildBookingDocumentPdf(stay, settings);
  await env.BOOKINGS.put(`pdf:document:${stay.id}`, documentBytes);

  return json({ ok: true, invoiceNumber, weeklyPrice, total });
}

async function handleRegenerate(request, env, id) {
  if (!isAuthorized(request, env)) return err('Unauthorized', 401);
  const stays = await readJSON(env, 'stays', []);
  const stay = stays.find((s) => s.id === id);
  if (!stay) return err('Nicht gefunden', 404);
  if (stay.status !== 'confirmed') return err('Nur bestätigte Aufenthalte haben ein Dokument.');

  const settings = await readJSON(env, 'settings', DEFAULT_SETTINGS);
  const documentBytes = await buildBookingDocumentPdf(stay, settings);
  await env.BOOKINGS.put(`pdf:document:${stay.id}`, documentBytes);
  return json({ ok: true });
}

async function handlePdf(env, id) {
  const bytes = await env.BOOKINGS.get(`pdf:document:${id}`, 'arrayBuffer');
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
      const cleaned = body.map((r) => ({
        start: r.start,
        end: r.end,
        name: (r.name || '').slice(0, 200),
        note: (r.note || '').slice(0, 1000),
      }));
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
      if (typeof body.winterPrice !== 'number' || typeof body.summerPrice !== 'number' || typeof body.overrides !== 'object') {
        return err('Invalid pricing payload');
      }
      const isNumArray6 = (a) => Array.isArray(a) && a.length === 6 && a.every((n) => typeof n === 'number');
      const shortStay = body.shortStay && isNumArray6(body.shortStay.winter) && isNumArray6(body.shortStay.summer)
        ? { winter: body.shortStay.winter, summer: body.shortStay.summer }
        : DEFAULT_WEEK_PRICING.shortStay;
      await writeJSON(env, 'weekPricing', {
        winterPrice: body.winterPrice,
        summerPrice: body.summerPrice,
        overrides: body.overrides,
        shortStay,
      });
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
    if (path === '/api/stays/manual' && request.method === 'POST') {
      return handleManualStay(request, env);
    }
    const decisionMatch = path.match(/^\/api\/stays\/([a-f0-9-]+)\/decision$/);
    if (decisionMatch && request.method === 'POST') {
      return handleDecision(request, env, decisionMatch[1]);
    }
    const pdfMatch = path.match(/^\/api\/stays\/([a-f0-9-]+)\/document\.pdf$/);
    if (pdfMatch && request.method === 'GET') {
      if (!isAuthorized(request, env)) return err('Unauthorized', 401);
      return handlePdf(env, pdfMatch[1]);
    }
    const regenMatch = path.match(/^\/api\/stays\/([a-f0-9-]+)\/regenerate$/);
    if (regenMatch && request.method === 'POST') {
      return handleRegenerate(request, env, regenMatch[1]);
    }

    return new Response('Not found', { status: 404, headers });
  },
};
