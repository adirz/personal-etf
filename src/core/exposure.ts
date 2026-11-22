import type { Atom, ExposureSpec, Instrument } from './types.js';

export const UNCLASSIFIED = 'unclassified';

/** Resolve the effective exposure spec: user override > provider auto > kind default. */
export function specFor(i: Instrument, auto?: ExposureSpec): ExposureSpec {
  if (i.exposureOverride) return i.exposureOverride;
  if (i.kind === 'cash') return { classes: { cash: { weight: 1 } }, dims: { currency: { [i.currency]: 1 } } };
  if (i.kind === 'debt') return { classes: { debt: { weight: 1 } }, dims: { currency: { [i.currency]: 1 } } };
  if (auto) return auto;
  if (i.kind === 'crypto') return { classes: { crypto: { weight: 1 } }, dims: { currency: { crypto: 1 } } };
  return { classes: { [UNCLASSIFIED]: { weight: 1 } } };
}

/**
 * Expand a spec into joint atoms. Within each asset class, dimensions are combined as a product of
 * marginals (independence assumption — the only thing derivable from per-dimension fund data).
 * Missing mass in any marginal becomes `unclassified`. If no currency dimension is provided,
 * the listing currency is used.
 */
export function atoms(spec: ExposureSpec, listingCcy: string): Atom[] {
  const out: Atom[] = [];
  const classTotal = Object.values(spec.classes).reduce((s, c) => s + c.weight, 0) || 1;
  for (const [cls, c] of Object.entries(spec.classes)) {
    const dims: Record<string, Record<string, number>> = { ...(spec.dims ?? {}), ...(c.dims ?? {}) };
    if (!dims.currency) dims.currency = { [listingCcy]: 1 };
    let cells: Atom[] = [{ w: c.weight / classTotal, attrs: { assetClass: cls } }];
    for (const [dim, marg] of Object.entries(dims)) {
      const m = normalize(marg);
      const next: Atom[] = [];
      for (const cell of cells) for (const [v, w] of Object.entries(m)) if (w > 0)
        next.push({ w: cell.w * w, attrs: { ...cell.attrs, [dim]: v } });
      cells = next;
    }
    out.push(...cells);
  }
  return out;
}

function normalize(m: Record<string, number>): Record<string, number> {
  const s = Object.values(m).reduce((a, b) => a + Math.max(0, b), 0);
  if (s <= 0) return { [UNCLASSIFIED]: 1 };
  if (s > 1.0001) return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.max(0, v) / s]));
  const r: Record<string, number> = { ...m };
  if (s < 0.9999) r[UNCLASSIFIED] = (r[UNCLASSIFIED] ?? 0) + (1 - s);
  return r;
}

export function matches(attrs: Record<string, string>, scope: Record<string, string | string[]>): boolean {
  for (const [k, v] of Object.entries(scope)) {
    const a = attrs[k] ?? UNCLASSIFIED;
    if (Array.isArray(v) ? !v.includes(a) : a !== v) return false;
  }
  return true;
}

/** Fraction of an instrument's value that lies in scope ∧ (dim = value). */
export function share(at: Atom[], scope: Record<string, string | string[]>, dim?: string, value?: string): number {
  let s = 0;
  for (const a of at) if (matches(a.attrs, scope) && (!dim || (a.attrs[dim] ?? UNCLASSIFIED) === value)) s += a.w;
  return s;
}
