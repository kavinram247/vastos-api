// Purchase Management — pure helpers ported from Vastos_ARC's
// src/purchase/logic.ts (document numbering, UOM mapping, PO totals). No
// NestJS wiring here on purpose, same as boq/calibration-engine.ts.

export function formatDocNumber(prefix: string, seq: number): string {
  return `${prefix}-${new Date().getFullYear()}-${String(seq).padStart(3, '0')}`;
}

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// Matches Vastos_ARC's src/purchase/types.ts UOMS — the DB `uom` enum for PO
// line items.
const UOMS = new Set([
  'nos', 'sqft', 'sqm', 'rft', 'rmt', 'sheet', 'set', 'pair',
  'litre', 'kg', 'box', 'bag', 'point', 'day', 'hour', 'lumpsum', 'cum',
]);
const UOM_ALIASES: Record<string, string> = {
  no: 'nos', number: 'nos', mtr: 'rmt', meter: 'rmt', metre: 'rmt', m: 'rmt',
  ltr: 'litre', l: 'litre', length: 'rmt', roll: 'nos',
};
export function uomToEnum(value?: string | null): string {
  const v = (value || '').trim().toLowerCase();
  if (UOMS.has(v)) return v;
  return UOM_ALIASES[v] || 'nos';
}

export interface PoTotals { subtotal: number; gst: number; freight: number; total: number }
export function computePoTotals(
  lines: { quantity: number; rate: number }[],
  gstRatePct: number,
  gstType: 'inclusive' | 'exclusive',
  freight: number,
): PoTotals {
  const round = (n: number) => Math.round(n * 100) / 100;
  const subtotal = round(lines.reduce((a, l) => a + (l.quantity || 0) * (l.rate || 0), 0));
  const f = freight || 0;
  const rate = (gstRatePct || 0) / 100;
  if (gstType === 'inclusive') {
    const gst = round((subtotal * rate) / (1 + rate));
    return { subtotal, gst, freight: f, total: round(subtotal + f) };
  }
  const gst = round(subtotal * rate);
  return { subtotal, gst, freight: f, total: round(subtotal + gst + f) };
}

export function paymentStatusFor(total: number, paid: number): 'outstanding' | 'partial' | 'paid' {
  if (paid <= 0) return 'outstanding';
  if (paid + 0.01 >= total) return 'paid';
  return 'partial';
}
