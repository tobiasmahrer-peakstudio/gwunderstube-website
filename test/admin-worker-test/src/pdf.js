import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// Gwunderstübli-Farbpalette (siehe index.html --root Variablen)
const COLORS = {
  cream: rgb(0.965, 0.945, 0.906),
  cream2: rgb(0.937, 0.902, 0.831),
  walnut: rgb(0.239, 0.169, 0.125),
  walnut2: rgb(0.353, 0.259, 0.188),
  bark: rgb(0.173, 0.122, 0.090),
  moss: rgb(0.357, 0.435, 0.310),
  gold: rgb(0.722, 0.525, 0.247),
  goldLight: rgb(0.890, 0.725, 0.408),
  red: rgb(0.639, 0.290, 0.208),
  white: rgb(1, 1, 1),
};

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 44;
const CONTENT_W = PAGE_W - MARGIN * 2;

function fmtDate(d) {
  const [y, m, day] = d.split('-');
  return `${day}.${m}.${y}`;
}
function fmtMoney(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}
function addDaysStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
// Due 30 days (or configured term) after the invoice date — but if the stay starts
// sooner than that, the amount must be settled before arrival instead.
function computePaymentDeadline(stay, settings) {
  const today = new Date().toISOString().slice(0, 10);
  const termDate = addDaysStr(today, settings.paymentTermsDays || 30);
  const dayBeforeArrival = addDaysStr(stay.arrival, -1);
  let deadline = termDate < dayBeforeArrival ? termDate : dayBeforeArrival;
  if (deadline < today) deadline = today;
  return deadline;
}

export async function buildBookingDocumentPdf(stay, settings) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H;

  function newPage() {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H;
    drawHeaderBand();
    y -= 40;
  }
  function ensureSpace(needed) {
    if (y - needed < 60) newPage();
  }
  function text(str, x, yy, opts = {}) {
    page.drawText(String(str), {
      x, y: yy,
      size: opts.size || 10,
      font: opts.font || font,
      color: opts.color || COLORS.walnut,
    });
  }
  function textR(str, xRight, yy, opts = {}) {
    const f = opts.font || font;
    const size = opts.size || 10;
    const w = f.widthOfTextAtSize(String(str), size);
    text(str, xRight - w, yy, opts);
  }
  function rule(yy, color = COLORS.cream2, thickness = 1) {
    page.drawLine({ start: { x: MARGIN, y: yy }, end: { x: PAGE_W - MARGIN, y: yy }, thickness, color });
  }
  function box(x, yTop, w, h, fillColor = COLORS.cream) {
    page.drawRectangle({ x, y: yTop - h, width: w, height: h, color: fillColor });
  }
  function drawHeaderBand() {
    page.drawRectangle({ x: 0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: COLORS.gold });
  }

  drawHeaderBand();
  y -= 40;

  // --- Header / Wordmark ---
  text(settings.companyName || 'Gwunderstübli', MARGIN, y, { font: bold, size: 22, color: COLORS.gold });
  y -= 18;
  text(settings.companyAddress || '', MARGIN, y, { size: 9.5, color: COLORS.walnut2 });
  y -= 22;
  rule(y, COLORS.goldLight, 1.5);
  y -= 32;

  // --- Title ---
  text('Buchungsbestätigung & Rechnung', MARGIN, y, { font: bold, size: 18, color: COLORS.bark });
  y -= 30;

  // --- Meta box: invoice number / date / due date ---
  const deadline = computePaymentDeadline(stay, settings);
  box(MARGIN, y + 10, CONTENT_W, 50, COLORS.cream2);
  const metaColW = CONTENT_W / 3;
  const labelY = y - 6;
  const metaY = y - 24;
  text('RECHNUNGSNUMMER', MARGIN + 14, labelY, { size: 7, font: bold, color: COLORS.walnut2 });
  text(stay.invoiceNumber || '–', MARGIN + 14, metaY, { size: 12, font: bold, color: COLORS.bark });
  text('RECHNUNGSDATUM', MARGIN + metaColW + 14, labelY, { size: 7, font: bold, color: COLORS.walnut2 });
  text(fmtDate(new Date().toISOString().slice(0, 10)), MARGIN + metaColW + 14, metaY, { size: 12, color: COLORS.bark });
  text('ZAHLBAR BIS', MARGIN + metaColW * 2 + 14, labelY, { size: 7, font: bold, color: COLORS.walnut2 });
  text(fmtDate(deadline), MARGIN + metaColW * 2 + 14, metaY, { size: 12, color: COLORS.bark });
  y -= 66;

  // --- Two columns: Gast / Aufenthalt ---
  const colW = CONTENT_W / 2 - 10;
  const col2X = MARGIN + colW + 20;
  const topY = y;
  text('GAST', MARGIN, y, { size: 8, font: bold, color: COLORS.moss });
  text('AUFENTHALT', col2X, y, { size: 8, font: bold, color: COLORS.moss });
  y -= 16;
  text(stay.guestName || '', MARGIN, y, { size: 10.5, font: bold });
  text(`Anreise ${fmtDate(stay.arrival)}, ab 15:00 Uhr`, col2X, y, { size: 10.5 });
  y -= 14;
  const addrLines = (stay.address || '').split('\n');
  text(addrLines[0] || '', MARGIN, y, { size: 10 });
  text(`Abreise ${fmtDate(stay.departure)}, bis 10:00 Uhr`, col2X, y, { size: 10.5 });
  y -= 14;
  text(addrLines.slice(1).join(', '), MARGIN, y, { size: 10 });
  text(`${stay.numPeople} ${stay.numPeople === 1 ? 'Person' : 'Personen'}`, col2X, y, { size: 10.5 });
  y -= 14;
  text(stay.email || '', MARGIN, y, { size: 10 });
  y = Math.min(y, topY - 56) - 14;

  // --- Kostenübersicht ---
  text('Kostenübersicht', MARGIN, y, { font: bold, size: 13, color: COLORS.bark });
  y -= 20;
  box(MARGIN, y + 6, CONTENT_W, 20, COLORS.cream2);
  text('Position', MARGIN + 10, y - 6, { size: 8.5, font: bold, color: COLORS.walnut2 });
  textR('Betrag (CHF)', PAGE_W - MARGIN - 10, y - 6, { size: 8.5, font: bold, color: COLORS.walnut2 });
  y -= 26;

  text(`Miete Gwunderstübli (${fmtDate(stay.arrival)} – ${fmtDate(stay.departure)})`, MARGIN + 10, y, { size: 10 });
  textR(fmtMoney(stay.weeklyPrice), PAGE_W - MARGIN - 10, y, { size: 10 });
  y -= 18;

  (stay.extraCosts || []).forEach((c) => {
    ensureSpace(30);
    text(c.label, MARGIN + 10, y, { size: 10 });
    textR(fmtMoney(c.amount), PAGE_W - MARGIN - 10, y, { size: 10 });
    y -= 18;
  });

  y -= 4;
  rule(y);
  y -= 22;

  const vat = settings.vatRate ? stay.total * (settings.vatRate / 100) : 0;
  if (vat > 0) {
    text('Zwischentotal', MARGIN + 10, y, { size: 10 });
    textR(fmtMoney(stay.total), PAGE_W - MARGIN - 10, y, { size: 10 });
    y -= 16;
    text(`MWST ${settings.vatRate}%`, MARGIN + 10, y, { size: 10 });
    textR(fmtMoney(vat), PAGE_W - MARGIN - 10, y, { size: 10 });
    y -= 20;
  }
  text('Total', MARGIN + 10, y, { size: 13, font: bold, color: COLORS.bark });
  textR(`CHF ${fmtMoney(stay.total + vat)}`, PAGE_W - MARGIN - 10, y, { size: 13, font: bold, color: COLORS.gold });
  y -= 26;

  // --- Zahlungsinformationen box ---
  ensureSpace(80);
  box(MARGIN, y + 10, CONTENT_W, 70, COLORS.cream);
  text('ZAHLUNGSINFORMATIONEN', MARGIN + 14, y - 4, { size: 8, font: bold, color: COLORS.moss });
  text(`Kontoinhaber: ${settings.accountHolder || ''}`, MARGIN + 14, y - 20, { size: 10 });
  text(`IBAN: ${settings.iban || ''}`, MARGIN + 14, y - 36, { size: 10 });
  text(`Währung: ${settings.currency || 'CHF'}`, MARGIN + 14, y - 52, { size: 10 });
  y -= 72;

  // --- Legal / booking terms ---
  ensureSpace(30);
  text('Bedingungen', MARGIN, y, { font: bold, size: 13, color: COLORS.bark });
  y -= 22;

  const clauses = [
    ['Mietobjekt', 'Gwunderstübli, Rawilstrasse 27, 3775 Lenk (Ferienstudio für 2 Personen). Anreise ab 15:00 Uhr, Abreise bis 10:00 Uhr.'],
    ['Zahlungsbedingungen',
      `Der Mietzins ist innert ${settings.paymentTermsDays || 30} Tagen ab Rechnungsdatum zu begleichen. ` +
      'Beginnt der Aufenthalt innerhalb dieser Frist, ist der Betrag spätestens vor der Anreise zu begleichen ' +
      '(siehe „Zahlbar bis" oben).'],
    ['Rücktritt / Stornierung',
      'Bei einer Stornierung durch den Gast vor der Anreise ist folgender Anteil des Mietzinses geschuldet: ' +
      'mehr als 3 Monate (90 Tage) vorher kostenlos, 30–90 Tage vorher 50%, weniger als 30 Tage vorher 100%. ' +
      'Kann das Objekt anderweitig vermietet werden, reduziert sich der geschuldete Betrag entsprechend.'],
    ['Hausordnung und Haftung',
      'Der Gast verpflichtet sich, das Mietobjekt sorgfältig zu behandeln und die Hausordnung einzuhalten. ' +
      'Für Schäden, die während der Mietdauer entstehen, haftet der Gast.'],
    ['Anwendbares Recht', 'Es gilt schweizerisches Recht. Gerichtsstand ist Lenk im Simmental.'],
  ];

  function wrapText(str, f, size, maxWidth) {
    const words = str.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (f.widthOfTextAtSize(test, size) > maxWidth && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  clauses.forEach(([title, body]) => {
    const bodyLines = wrapText(body, font, 9.5, CONTENT_W);
    ensureSpace(18 + bodyLines.length * 13);
    text(title, MARGIN, y, { size: 10.5, font: bold, color: COLORS.walnut2 });
    y -= 15;
    bodyLines.forEach((line) => {
      text(line, MARGIN, y, { size: 9.5, color: COLORS.walnut2 });
      y -= 13;
    });
    y -= 4;
  });

  // --- Vertragsschluss ---
  // Bookings made through the online request form recorded an AGB-acceptance timestamp;
  // bookings entered directly by the Vermieterin (phone/in person) did not, so they get
  // a neutral line instead of a claim that a request/AGB flow happened.
  const agbText = stay.agbAcceptedAt
    ? `Der Gast hat am ${fmtDate(stay.agbAcceptedAt.slice(0, 10))} mit dem Absenden der Buchungsanfrage die Allgemeinen Geschäftsbedingungen (AGB) akzeptiert und den oben genannten Zeitraum verbindlich angefragt. Mit der Bestätigung durch die Vermieterin ist der Mietvertrag zu den hier aufgeführten Bedingungen zustande gekommen. Eine separate Unterschrift ist nicht erforderlich.`
    : `Diese Buchung wurde direkt mit der Vermieterin vereinbart. Es gelten die oben aufgeführten Bedingungen.`;
  const agbLines = wrapText(agbText, font, 9.5, CONTENT_W);
  ensureSpace(18 + agbLines.length * 13);
  text('Vertragsschluss', MARGIN, y, { size: 10.5, font: bold, color: COLORS.walnut2 });
  y -= 15;
  agbLines.forEach((line) => {
    text(line, MARGIN, y, { size: 9.5, color: COLORS.walnut2 });
    y -= 13;
  });

  // --- Footer ---
  // Nothing follows this line, so it only needs to clear the page edge, not the
  // full ensureSpace() reserve meant for content with more sections after it.
  y -= 10;
  if (y < 20) newPage();
  text(`Automatisch erstellt am ${fmtDate(new Date().toISOString().slice(0, 10))}.`, MARGIN, y, { size: 8, color: COLORS.walnut2, font: italic });

  return doc.save();
}
