// ─────────────────────────────────────────────────────────────
// Calibration engine — verbatim port of Vastos_ARC's
// src/boq/engine/calibration.ts. Pure: variance history → damped
// waste-factor + rate corrections. Median resists outliers; damping (alpha)
// prevents one project from swinging the catalogue.
//
// Kept identical to the frontend original (constants, math, rounding) rather
// than "improved" — this is a numerical policy the two copies must agree on
// bit-for-bit, not a data-access detail. If the frontend's copy changes,
// update this one to match.
// ─────────────────────────────────────────────────────────────

export const ALPHA = 0.3; // damping: move 30% toward target each run
export const WASTE_MIN = 0.02;
export const WASTE_MAX = 0.25;
export const DRIFT_THRESHOLD = 0.15; // |mean variance| above this → flag

export interface VarianceRow {
  estimated_qty: number | null;
  actual_qty: number | null;
  estimated_rate: number | null;
  actual_rate: number | null;
  estimated_cost: number | null;
  actual_cost: number | null;
}

export interface Calibration {
  sample_size: number;
  q_ratio: number; // median actual/estimated quantity
  r_ratio: number; // median actual/estimated rate
  mean_variance_pct: number; // mean cost variance (0.06 = +6%)
  waste_old: number;
  waste_target: number;
  waste_new: number;
  rate_multiplier: number; // apply to the current rate card
  drift: boolean;
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(Math.max(n, lo), hi);
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function median(xs: number[]): number {
  if (xs.length === 0) return 1;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function computeCalibration(
  rows: VarianceRow[],
  wasteOld: number,
): Calibration | null {
  if (!rows || rows.length === 0) return null;
  const qRatios: number[] = [];
  const rRatios: number[] = [];
  const variances: number[] = [];
  for (const r of rows) {
    if (r.estimated_qty && r.actual_qty && r.estimated_qty > 0) {
      qRatios.push(r.actual_qty / r.estimated_qty);
    }
    if (r.estimated_rate && r.actual_rate && r.estimated_rate > 0) {
      rRatios.push(r.actual_rate / r.estimated_rate);
    }
    if (r.estimated_cost && r.actual_cost && r.estimated_cost > 0) {
      variances.push((r.actual_cost - r.estimated_cost) / r.estimated_cost);
    }
  }
  const qRatio = median(qRatios);
  const rRatio = median(rRatios);
  const meanVar = variances.length
    ? variances.reduce((a, b) => a + b, 0) / variances.length
    : 0;

  const wasteTarget = (1 + wasteOld) * qRatio - 1;
  const wasteNew = clamp(
    wasteOld + ALPHA * (wasteTarget - wasteOld),
    WASTE_MIN,
    WASTE_MAX,
  );
  const rateMultiplier = 1 + ALPHA * (rRatio - 1);

  return {
    sample_size: rows.length,
    q_ratio: r4(qRatio),
    r_ratio: r4(rRatio),
    mean_variance_pct: r4(meanVar),
    waste_old: r4(wasteOld),
    waste_target: r4(wasteTarget),
    waste_new: r4(wasteNew),
    rate_multiplier: r4(rateMultiplier),
    drift: Math.abs(meanVar) > DRIFT_THRESHOLD,
  };
}

/** Overall estimate accuracy across all variance rows: 1 − mean(|variance|). */
export function overallAccuracy(rows: VarianceRow[]): number {
  const v = rows
    .filter((r) => r.estimated_cost && r.actual_cost && r.estimated_cost > 0)
    .map((r) =>
      Math.abs((r.actual_cost! - r.estimated_cost!) / r.estimated_cost!),
    );
  if (v.length === 0) return 1;
  const mae = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.max(0, 1 - mae);
}
