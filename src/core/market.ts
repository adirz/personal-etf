import type { Ccy, ISODate, Instrument, MarketSnapshot, Series, Tx } from './types.js';

/** Last value at or before `date` (forward-fill). Returns undefined if date precedes series. */
export function at(series: Series | undefined, date: ISODate): number | undefined {
  if (!series?.length) return undefined;
  let lo = 0, hi = series.length - 1;
  if (series[0][0] > date) return undefined;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid][0] <= date) lo = mid; else hi = mid - 1;
  }
  return series[lo][1];
}

export class Market {
  private manual = new Map<string, Series>();
  private inst: Map<string, Instrument>;

  constructor(public snap: MarketSnapshot, instruments: Instrument[], txs: Tx[]) {
    this.inst = new Map(instruments.map(i => [i.id, i]));
    // Manual price points come from 'valuation' txs and from trade prices of manual instruments.
    for (const t of [...txs].sort((a, b) => a.date.localeCompare(b.date))) {
      const i = t.instrument ? this.inst.get(t.instrument) : undefined;
      if (!i || t.price === undefined) continue;
      if (t.type === 'valuation' || (i.kind === 'manual' && ['buy', 'sell', 'open'].includes(t.type))) {
        const s = this.manual.get(i.id) ?? [];
        if (s.length && s[s.length - 1][0] === t.date) s[s.length - 1][1] = t.price; else s.push([t.date, t.price]);
        this.manual.set(i.id, s);
      }
    }
  }

  /** Price per unit in the instrument's own currency. */
  price(id: string, date: ISODate): number | undefined {
    const i = this.inst.get(id);
    if (!i) return undefined;
    if (i.kind === 'cash' || i.kind === 'debt') return 1;
    const live = at(this.snap.prices[id]?.series, date);
    const man = at(this.manual.get(id), date);
    if (live !== undefined && man !== undefined) {
      // prefer whichever is more recent
      const lt = lastDate(this.snap.prices[id]?.series, date), mt = lastDate(this.manual.get(id), date);
      return (mt ?? '') > (lt ?? '') ? man : live;
    }
    return live ?? man ?? firstValue(this.snap.prices[id]?.series) ?? undefined;
  }

  /** Units of `to` per 1 `from`. Tries direct, inverse, then triangulation via USD/EUR. */
  fx(from: Ccy, to: Ccy, date: ISODate): number {
    if (from === to) return 1;
    const d = this.pair(from, to, date);
    if (d !== undefined) return d;
    for (const via of ['USD', 'EUR']) {
      if (via === from || via === to) continue;
      const a = this.pair(from, via, date), b = this.pair(via, to, date);
      if (a !== undefined && b !== undefined) return a * b;
    }
    throw new Error(`no FX rate ${from}/${to} at ${date}`);
  }

  private pair(from: Ccy, to: Ccy, date: ISODate): number | undefined {
    const s = this.snap.fx[`${from}/${to}`];
    if (s) return at(s, date) ?? s[0]?.[1];
    const inv = this.snap.fx[`${to}/${from}`];
    if (inv) { const v = at(inv, date) ?? inv[0]?.[1]; return v ? 1 / v : undefined; }
    return undefined;
  }

  /** Union of all price dates (for building daily value series). */
  dates(from: ISODate, to: ISODate): ISODate[] {
    const set = new Set<ISODate>();
    for (const p of Object.values(this.snap.prices)) for (const [d] of p.series) if (d >= from && d <= to) set.add(d);
    for (const s of this.manual.values()) for (const [d] of s) if (d >= from && d <= to) set.add(d);
    set.add(from); set.add(to);
    return [...set].sort();
  }
}

function lastDate(s: Series | undefined, date: ISODate) {
  if (!s) return undefined;
  let r: string | undefined;
  for (const [d] of s) { if (d <= date) r = d; else break; }
  return r;
}
function firstValue(s?: Series) { return s?.[0]?.[1]; }

export const today = (): ISODate => new Date().toISOString().slice(0, 10);
