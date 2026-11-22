import { analyze } from './analytics.js';
import { replay } from './ledger.js';
import { Market, today } from './market.js';
import { breakdown, valuate } from './portfolio.js';
import { bandPP, drift, validateTargets } from './targets.js';
import type { Data, ISODate, MarketSnapshot } from './types.js';

export const STANDARD_DIMS = ['assetClass', 'region', 'sector', 'credit', 'currency'];

export function buildReport(data: Data, snap: MarketSnapshot, asOf: ISODate = today(), withAnalytics = true) {
  const mkt = new Market(snap, data.instruments, data.transactions);
  const st = replay(data, asOf);
  const v = valuate(data, st, mkt, asOf);
  const dims = new Set(STANDARD_DIMS);
  for (const r of data.targets.rules) { dims.add(r.dimension); Object.keys(r.scope).forEach(k => dims.add(k)); }
  const breakdowns = Object.fromEntries([...dims].map(d => [d, breakdown(v.lines, d)]));
  const acct = new Map(data.accounts.map(a => [a.id, a]));
  const tc = data.settings.tax.currency;
  const holdings = v.lines.map(l => {
    const a = acct.get(l.account);
    const rate = a?.taxStatus === 'taxable' ? (a.taxRate ?? data.settings.tax.rate) : 0;
    const gainTax = l.kind === 'cash' || l.kind === 'debt' ? 0
      : l.lots.reduce((s, lot) => s + lot.qty * (l.price * mkt.fx(l.ccy, tc, asOf) - lot.cost * mkt.fx(l.ccy, tc, lot.date)), 0);
    return { ...l, atoms: undefined, unrealizedBase: l.costBase !== undefined ? l.value - l.costBase : undefined, deferredTaxBase: Math.max(0, gainTax) * rate * mkt.fx(tc, v.base, asOf) };
  });
  return {
    asOf, base: v.base,
    netWorth: v.netWorth, investable: v.investable,
    excludedValue: v.lines.filter(l => l.excluded).reduce((s, l) => s + l.value, 0),
    debt: v.lines.filter(l => l.kind === 'debt').reduce((s, l) => s + l.value, 0),
    holdings,
    breakdowns,
    drift: drift(v.lines, data.targets),
    sleeve: (() => {
      const ex = v.lines.filter(l => l.excluded).reduce((s, l) => s + l.value, 0);
      const tot = ex + v.investable;
      const target = data.targets.excludedPct ?? 0;
      const actual = tot ? (100 * ex) / tot : 0;
      return { value: ex, target, actual, out: Math.abs(actual - target) > bandPP(target, data.targets.defaultBand) };
    })(),
    targetErrors: validateTargets(data.targets),
    deferredTax: holdings.reduce((s, h) => s + h.deferredTaxBase, 0),
    analytics: withAnalytics ? analyze(data, mkt, v.lines, asOf) : undefined,
    warnings: [...st.warnings, ...v.warnings],
  };
}
export type Report = ReturnType<typeof buildReport>;
