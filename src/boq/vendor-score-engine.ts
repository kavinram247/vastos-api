// ─────────────────────────────────────────────────────────────
// Vendor scoring engine — verbatim port of Vastos_ARC's
// src/boq/engine/vendorScore.ts (computeVendorScore only — rankVendors stays
// client-side, it's pure ranking over an already-scored candidate list with
// no DB access).
//
// Kept identical to the frontend original (weights, decay half-life,
// rounding) rather than "improved" — this is a numerical policy the two
// copies must agree on bit-for-bit, not a data-access detail. If the
// frontend's copy changes, update this one to match.
// ─────────────────────────────────────────────────────────────

export interface PerfRow {
  promised_days: number | null;
  actual_days: number | null;
  qty_ordered: number | null;
  qty_defective: number | null;
  price_at_order: number | null;
  market_price: number | null;
  recorded_at: string;
}

export interface VendorScore {
  cost: number;
  delivery: number;
  quality: number;
  reliability: number;
  overall: number;
  samples: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const r1 = (n: number) => Math.round(n * 10) / 10;

// time-decay weight: ~140-day half-life
function decay(recordedAt: string, now = Date.now()): number {
  const ageDays = Math.max(0, (now - new Date(recordedAt).getTime()) / 86400000);
  return Math.exp(-0.005 * ageDays);
}

export function computeVendorScore(rows: PerfRow[]): VendorScore | null {
  if (!rows || rows.length === 0) return null;
  let wSum = 0;
  let deliverySum = 0;
  let costSum = 0;
  let onTime = 0;
  let ordered = 0;
  let defective = 0;
  for (const r of rows) {
    const w = decay(r.recorded_at);
    wSum += w;
    // delivery: promised/actual capped at 1 (early = on-time = 1.0)
    if (r.promised_days && r.actual_days) {
      deliverySum += w * clamp(r.promised_days / r.actual_days, 0, 1);
    }
    // cost: price vs market mapped 0.8→100 … 1.0→50 … 1.2→0
    if (r.price_at_order && r.market_price) {
      const ratio = r.price_at_order / r.market_price;
      costSum += w * clamp(1 - (ratio - 0.8) / 0.4, 0, 1);
    }
    if (r.actual_days != null && r.promised_days != null && r.actual_days <= r.promised_days) {
      onTime += w;
    }
    ordered += Number(r.qty_ordered || 0);
    defective += Number(r.qty_defective || 0);
  }
  const delivery = 100 * (deliverySum / wSum);
  const cost = 100 * (costSum / wSum);
  const quality = 100 * (1 - (ordered > 0 ? defective / ordered : 0));
  const reliability = 100 * (onTime / wSum);
  const overall = 0.3 * cost + 0.25 * delivery + 0.3 * quality + 0.15 * reliability;
  return {
    cost: r1(cost),
    delivery: r1(delivery),
    quality: r1(quality),
    reliability: r1(reliability),
    overall: r1(overall),
    samples: rows.length,
  };
}
