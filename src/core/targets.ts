import { share } from './exposure.js';
import type { Line } from './portfolio.js';
import type { Band, TargetRule, Targets } from './types.js';

export function validateTargets(t: Targets): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const r of t.rules) {
    if (ids.has(r.id)) errs.push(`duplicate rule id ${r.id}`);
    ids.add(r.id);
    const s = Object.values(r.weights).reduce((a, b) => a + b, 0);
    if (Math.abs(s - 100) > 0.01) errs.push(`rule ${r.id}: weights sum to ${s}, expected 100`);
    if (Object.keys(r.scope).includes(r.dimension)) errs.push(`rule ${r.id}: dimension ${r.dimension} is also in its scope`);
  }
  return errs;
}

/** Band half-width in percentage points for a given target weight (pp). Classic "5/25": min(abs, rel×target). */
export function bandPP(target: number, b: Band): number {
  const abs = b.abs ?? Infinity, rel = b.rel !== undefined ? b.rel * target : Infinity;
  const w = Math.min(abs, rel);
  return Number.isFinite(w) ? w : 0;
}

/**
 * Set one weight and rescale the non-held weights proportionally so the rule still sums to 100.
 * Returns the weights unchanged in value when nothing is free to absorb the difference.
 */
export function setWeight(weights: Record<string, number>, key: string, value: number, held: string[] = [], step = 0.5): Record<string, number> {
  const free = Object.keys(weights).filter(k => k !== key && !held.includes(k));
  if (!free.length) return { ...weights };
  const heldSum = held.filter(k => k !== key).reduce((s, k) => s + (weights[k] ?? 0), 0);
  const room = Math.max(0, 100 - heldSum);
  const v = Math.min(room, Math.max(0, Math.round(value / step) * step));
  const freeSum = free.reduce((s, k) => s + weights[k], 0);
  const units = Math.round((room - v) / step);
  const raw = free.map(k => units * (freeSum > 0 ? weights[k] / freeSum : 1 / free.length));
  const whole = raw.map(Math.floor);
  const byRemainder = raw.map((x, i) => [x - whole[i], i]).sort((a, b) => b[0] - a[0]);
  for (let n = units - whole.reduce((s, x) => s + x, 0), j = 0; n > 0; n--, j++) whole[byRemainder[j][1]]++;
  const out: Record<string, number> = { ...weights, [key]: v };
  free.forEach((k, i) => { out[k] = whole[i] * step; });
  // Held weights may not sit on the step grid; the largest free weight absorbs any residue.
  const residue = 100 - Object.values(out).reduce((s, x) => s + x, 0);
  const largest = free.reduce((a, b) => (out[b] > out[a] ? b : a));
  out[largest] = +(out[largest] + residue).toFixed(6);
  return out;
}

export interface DriftRow {
  value: string;           // dimension value
  target: number;          // pp of scope
  actual: number;          // pp of scope
  valueAmt: number;        // base ccy
  targetAmt: number;
  dev: number;             // valueAmt − targetAmt
  band: number;            // pp
  out: boolean;
}
export interface RuleDrift { rule: TargetRule; scopeValue: number; scopeShareOfTotal: number; rows: DriftRow[]; maxOut: number }

export function drift(lines: Line[], targets: Targets): RuleDrift[] {
  const live = lines.filter(l => l.inTargets);
  const total = live.reduce((s, l) => s + l.value, 0);
  return targets.rules.map(rule => {
    const scopeValue = live.reduce((s, l) => s + l.value * share(l.atoms, rule.scope), 0);
    const present = new Set<string>(Object.keys(rule.weights));
    for (const l of live) for (const a of l.atoms) if (share([a], rule.scope) > 0) present.add(a.attrs[rule.dimension] ?? 'unclassified');
    const b = rule.band ?? targets.defaultBand;
    const rows: DriftRow[] = [...present].map(v => {
      const valueAmt = live.reduce((s, l) => s + l.value * share(l.atoms, rule.scope, rule.dimension, v), 0);
      const target = rule.weights[v] ?? 0;
      const actual = scopeValue ? (100 * valueAmt) / scopeValue : 0;
      const band = bandPP(target, b);
      return { value: v, target, actual, valueAmt, targetAmt: (target / 100) * scopeValue, dev: valueAmt - (target / 100) * scopeValue, band, out: Math.abs(actual - target) > band + 1e-9 };
    }).filter(r => r.value in rule.weights || Math.abs(r.valueAmt) > 0.005)   // a listed 0% stays visible so it can be raised again
      .sort((a, b) => b.target - a.target || b.valueAmt - a.valueAmt);
    const maxOut = Math.max(0, ...rows.map(r => Math.abs(r.actual - r.target) - r.band));
    return { rule, scopeValue, scopeShareOfTotal: total ? scopeValue / total : 0, rows, maxOut };
  });
}
