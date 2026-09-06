import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

function fmtDate(d) {
  const [y, m, day] = d.split('-');
  return `${day}.${m}.${y}`;
}
function fmtMoney(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

async function newPage(doc) {
  const page = doc.addPage([595.28, 841.89]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { page, font, bold };
}

function drawText(page, text, x, y, font, size = 10, color = rgb(0.18, 0.16, 0.15)) {
  page.drawText(String(text), { x, y, size, font, color });
}

export async function buildInvoicePdf(stay, settings) {
  const doc = await PDFDocument.create();
  const { page, font, bold } = await newPage(doc);
  const gold = rgb(0.72, 0.53, 0.25);
  let y = 800;

  drawText(page, settings.companyName || 'Gwunderstübli', 40, y, bold, 16, gold);
  y -= 18;
  drawText(page, settings.companyAddress || '', 40, y, font, 10);
  y -= 40;

  drawText(page, 'RECHNUNG', 40, y, bold, 20);
  y -= 30;
  drawText(page, `Rechnungsnummer: ${stay.invoiceNumber}`, 40, y, font, 10);
  y -= 14;
  drawText(page, `Rechnungsdatum: ${fmtDate(new Date().toISOString().slice(0, 10))}`, 40, y, font, 10);
  y -= 14;
  const deadline = new Date();
  deadline.setDate(deadline.getDate() + (settings.paymentTermsDays || 14));
  drawText(page, `Zahlbar bis: ${fmtDate(deadline.toISOString().slice(0, 10))}`, 40, y, font, 10);
  y -= 30;

  drawText(page, 'Rechnung an:', 40, y, bold, 11);
  y -= 16;
  drawText(page, stay.guestName || '', 40, y, font, 10);
  y -= 14;
  (stay.address || '').split('\n').forEach((line) => {
    drawText(page, line, 40, y, font, 10);
    y -= 14;
  });
  drawText(page, stay.email || '', 40, y, font, 10);
  y -= 30;

  drawText(page, `Aufenthalt: ${fmtDate(stay.arrival)} – ${fmtDate(stay.departure)}`, 40, y, font, 10);
  y -= 14;
  drawText(page, `Anzahl Personen: ${stay.numPeople}`, 40, y, font, 10);
  y -= 30;

  // Line items table
  drawText(page, 'Position', 40, y, bold, 10);
  drawText(page, 'Betrag', 480, y, bold, 10);
  y -= 8;
  page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
  y -= 16;

  drawText(page, `Miete Gwunderstübli (${fmtDate(stay.arrival)} – ${fmtDate(stay.departure)})`, 40, y, font, 10);
  drawText(page, `CHF ${fmtMoney(stay.weeklyPrice)}`, 480, y, font, 10);
  y -= 18;

  (stay.extraCosts || []).forEach((c) => {
    drawText(page, c.label, 40, y, font, 10);
    drawText(page, `CHF ${fmtMoney(c.amount)}`, 480, y, font, 10);
    y -= 18;
  });

  y -= 6;
  page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
  y -= 20;

  const vat = settings.vatRate ? stay.total * (settings.vatRate / 100) : 0;
  if (vat > 0) {
    drawText(page, `Zwischentotal`, 40, y, font, 10);
    drawText(page, `CHF ${fmtMoney(stay.total)}`, 480, y, font, 10);
    y -= 16;
    drawText(page, `MWST ${settings.vatRate}%`, 40, y, font, 10);
    drawText(page, `CHF ${fmtMoney(vat)}`, 480, y, font, 10);
    y -= 16;
  }
  drawText(page, 'Total', 40, y, bold, 12);
  drawText(page, `CHF ${fmtMoney(stay.total + vat)}`, 480, y, bold, 12);
  y -= 40;

  drawText(page, 'Zahlungsinformationen', 40, y, bold, 11);
  y -= 16;
  drawText(page, `Kontoinhaber: ${settings.accountHolder || ''}`, 40, y, font, 10);
  y -= 14;
  drawText(page, `IBAN: ${settings.iban || ''}`, 40, y, font, 10);
  y -= 14;
  drawText(page, `Währung: ${settings.currency || 'CHF'}`, 40, y, font, 10);

  return doc.save();
}

export async function buildContractPdf(stay, settings) {
  const doc = await PDFDocument.create();
  let { page, font, bold } = await newPage(doc);
  const red = rgb(0.64, 0.29, 0.2);
  let y = 800;

  drawText(page, 'ENTWURF – vor Verwendung juristisch prüfen lassen', 40, y, bold, 9, red);
  y -= 24;
  drawText(page, 'MIETVERTRAG FÜR FERIENWOHNUNG', 40, y, bold, 16);
  y -= 30;

  const lines = [
    ['1. Vertragsparteien', true],
    [`Vermieterin: ${settings.companyName || 'Gwunderstübli'}, ${settings.companyAddress || ''}`, false],
    [`Mieter/in: ${stay.guestName || ''}, ${stay.address || ''}, ${stay.email || ''}`, false],
    ['', false],
    ['2. Mietobjekt', true],
    ['Gwunderstübli, Rawilstrasse 27, 3775 Lenk (Ferienstudio für 2 Personen)', false],
    ['', false],
    ['3. Mietdauer', true],
    [`Anreise: ${fmtDate(stay.arrival)}, Abreise: ${fmtDate(stay.departure)}`, false],
    [`Anzahl Personen: ${stay.numPeople}`, false],
    ['', false],
    ['4. Mietzins und Zahlungsbedingungen', true],
    [`Der Mietzins beträgt CHF ${fmtMoney(stay.total)} und ist gemäss beiliegender Rechnung`, false],
    [`innert ${settings.paymentTermsDays || 14} Tagen ab Rechnungsdatum zu begleichen.`, false],
    ['', false],
    ['5. Rücktritt / Stornierung', true],
    ['Ein Rücktritt vom Vertrag ist bis 14 Tage vor Anreise kostenlos möglich. Bei späterem', false],
    ['Rücktritt oder Nichtantritt bleibt der vereinbarte Mietzins geschuldet, sofern das Objekt', false],
    ['nicht anderweitig vermietet werden kann.', false],
    ['', false],
    ['6. Hausordnung und Haftung', true],
    ['Der/die Mieter/in verpflichtet sich, das Mietobjekt sorgfältig zu behandeln und die', false],
    ['Hausordnung einzuhalten. Für Schäden, die während der Mietdauer entstehen, haftet', false],
    ['der/die Mieter/in.', false],
    ['', false],
    ['7. Anwendbares Recht', true],
    ['Es gilt schweizerisches Recht. Gerichtsstand ist Lenk im Simmental.', false],
  ];

  for (const [text, isHeading] of lines) {
    if (y < 80) {
      const next = await newPage(doc);
      page = next.page; font = next.font; bold = next.bold;
      y = 800;
    }
    if (text === '') { y -= 10; continue; }
    drawText(page, text, 40, y, isHeading ? bold : font, isHeading ? 12 : 10);
    y -= isHeading ? 20 : 15;
  }

  y -= 30;
  if (y < 100) {
    const next = await newPage(doc);
    page = next.page; font = next.font; bold = next.bold;
    y = 800;
  }
  drawText(page, `Ort/Datum: Lenk, ${fmtDate(new Date().toISOString().slice(0, 10))}`, 40, y, font, 10);
  y -= 40;
  drawText(page, 'Unterschrift Vermieterin: ____________________', 40, y, font, 10);
  y -= 30;
  drawText(page, 'Unterschrift Mieter/in: ____________________', 40, y, font, 10);

  return doc.save();
}
