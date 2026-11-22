import { atoms, specFor } from './exposure.js';
import type { Market } from './market.js';
import type { Atom, Data, ISODate, Instrument, Lot, PortfolioState } from './types.js';

export interface Line {
  key: string;               // account|instrument
  account: string;
  instrument: string;
  name: string;
  kind: Instrument['kind'];
  qty: number;
  price: number;             // instrument ccy
  ccy: string;
  value: number;             // base ccy (negative for debt)
  atoms: Atom[];
  excluded: boolean;         // in the exception sleeve
  inTargets: boolean;        // participates in target/drift math
  tradable: boolean;
  fractional: boolean;
  lots: Lot[];
  costBase?: number;         // total cost in base ccy at historical FX
}

export const cashId = (ccy: string) => `CASH:${ccy}`;

export function cashInstrument(ccy: string): Instrument {
  return { id: cashId(ccy), name: `Cash ${ccy}`, kind: 'cash', currency: ccy, tradable: false };
}

export function valuate(data: Data, st: PortfolioState, mkt: Market, date: ISODate) {
  const base = data.settings.baseCurrency;
  const inst = new Map(data.instruments.map(i => [i.id, i]));
  const lines: Line[] = [];
  const warnings: string[] = [];

  for (const p of st.positions) {
    const i = inst.get(p.instrument)!;
    const px = mkt.price(i.id, date);
    if (px === undefined) warnings.push(`no price for ${i.id} on ${date}; valued at last cost`);
    const price = px ?? (p.lots.at(-1)?.cost ?? 0);
    const sign = i.kind === 'debt' ? -1 : 1;
    const fx = mkt.fx(i.currency, base, date);
    const excluded = !!i.excluded;
    lines.push({
      key: `${p.account}|${i.id}`, account: p.account, instrument: i.id, name: i.name ?? i.id, kind: i.kind,
      qty: p.qty, price, ccy: i.currency, value: sign * p.qty * price * fx,
      atoms: atoms(specFor(i, mkt.snap.exposures[i.id]), i.currency),
      excluded, inTargets: !excluded && (i.kind !== 'debt' || data.settings.debtInTargets),
      tradable: i.tradable ?? (i.kind === 'security' || i.kind === 'crypto'),
      fractional: i.fractional ?? i.kind !== 'security',
      lots: p.lots,
      costBase: i.kind === 'debt' ? undefined : p.lots.reduce((s, l) => s + l.qty * l.cost * mkt.fx(i.currency, base, l.date), 0),
    });
  }
  for (const [acct, m] of Object.entries(st.cash)) for (const [ccy, amt] of Object.entries(m)) {
    const ci = cashInstrument(ccy);
    lines.push({
      key: `${acct}|${ci.id}`, account: acct, instrument: ci.id, name: ci.name!, kind: 'cash', qty: amt, price: 1, ccy,
      value: amt * mkt.fx(ccy, base, date), atoms: atoms(specFor(ci), ccy),
      excluded: false, inTargets: true, tradable: false, fractional: true, lots: [],
    });
    if (amt < -0.01) warnings.push(`negative cash ${amt.toFixed(2)} ${ccy} in ${acct} — missing deposit?`);
  }
  const netWorth = lines.reduce((s, l) => s + l.value, 0);
  const investable = lines.filter(l => l.inTargets).reduce((s, l) => s + l.value, 0);
  return { date, base, lines, netWorth, investable, warnings };
}

/** Breakdown of the in-target portfolio along any dimension, e.g. "sector" or "currency". */
export function breakdown(lines: Line[], dim: string, scope: Record<string, string | string[]> = {}, includeExcluded = false) {
  const out: Record<string, number> = {};
  for (const l of lines) {
    if (!includeExcluded && !l.inTargets) continue;
    for (const a of l.atoms) {
      let ok = true;
      for (const [k, v] of Object.entries(scope)) { const x = a.attrs[k] ?? 'unclassified'; if (Array.isArray(v) ? !v.includes(x) : x !== v) { ok = false; break; } }
      if (!ok) continue;
      const k = a.attrs[dim] ?? 'unclassified';
      out[k] = (out[k] ?? 0) + a.w * l.value;
    }
  }
  return out;
}
