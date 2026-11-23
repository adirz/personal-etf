import type { ISODate, Tx } from '../core/types.js';

/**
 * Suggestions for the review screen only. A suggestion is never linked until the user approves it.
 */
const ABBREVIATIONS: Record<string, string> = {
  TOT: 'TOTAL', STK: 'STOCK', INTL: 'INTERNATIONAL', INT: 'INTERNATIONAL', DIV: 'DIVIDEND', APP: 'APPRECIATION',
  INDX: 'INDEX', DF: 'DEFENSE', DEF: 'DEFENSE', SEC: 'SECTOR', WHOLESLE: 'WHOLESALE', T: 'TECH',
};
const IGNORED = new Set(['INC', 'CORP', 'CORPORATION', 'CO', 'LTD', 'PLC', 'THE', 'OF', 'AND', 'ETF', 'ET', 'FD', 'FUND', 'TRUST', 'SHARES', 'INDEX',
  'CLASS', 'CL', 'A', 'SP', 'ADR', 'EA', 'CHF', 'USD', 'US', 'U', 'S', 'P', 'X', 'DJ', 'SW', 'VIPERS', '20']);
const BRANDS = new Set(['ISHARES', 'VANGUARD', 'SPDR', 'SS', 'STATE', 'STREET', 'GLOBAL', 'VANECK', 'ABRDN', 'MSCI', 'FTSE', 'GRANITESHARES', 'SWC', 'ZKB']);
const BRAND_WEIGHT = 0.25;
const MIN_SCORE = 0.45;
const MIN_LEAD = 0.05;

const tokens = (name: string) => [...new Set(name.toUpperCase().replace(/WAL-MART/g, 'WALMART').split(/[^A-Z0-9]+/)
  .map(w => ABBREVIATIONS[w] ?? w).filter(w => w && !IGNORED.has(w)))];
const weight = (w: string) => (BRANDS.has(w) ? BRAND_WEIGHT : 1);
const same = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

export function nameScore(broker: string, candidate: string) {
  const a = tokens(broker), b = tokens(candidate);
  const hits = a.filter(x => b.some(y => same(x, y)));
  if (!hits.some(w => !BRANDS.has(w))) return 0;
  const total = (l: string[]) => l.reduce((s, w) => s + weight(w), 0);
  return (2 * total(hits)) / (total(a) + total(b));
}

export interface LinkCandidate { ticker: string; names: string[] }

/** Propose at most one candidate per holding, and never one candidate for two holdings. Close calls get none. */
export function suggestLinks(holdings: { id: string; name: string }[], candidates: LinkCandidate[]) {
  const pairs: { id: string; ticker: string; score: number }[] = [];
  const unclear = new Set<string>();
  for (const h of holdings) {
    const scored = candidates.map(c => ({ ticker: c.ticker, score: Math.max(0, ...c.names.map(n => nameScore(h.name, n))) })).sort((x, y) => y.score - x.score);
    if (!scored.length || scored[0].score < MIN_SCORE) continue;
    if (scored[1] && scored[0].score - scored[1].score < MIN_LEAD) { unclear.add(h.id); continue; }
    pairs.push({ id: h.id, ticker: scored[0].ticker, score: scored[0].score });
  }
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const p of pairs.sort((x, y) => y.score - x.score)) {
    if (used.has(p.ticker) || unclear.has(p.id)) continue;
    used.add(p.ticker);
    out.set(p.id, p.ticker);
  }
  return out;
}

/**
 * Move an unlinked holding's entries onto its approved instrument. The "closed" entry the holdings import wrote
 * for that instrument is dropped, because the holding it closed is this one.
 */
export function relinkTransactions(txs: Tx[], fromId: string, toId: string, acquiredFor?: (cost: number, date: ISODate) => ISODate | undefined): Tx[] {
  const moved = txs.filter(t => t.instrument === fromId && t.type === 'adjust');
  const isClosure = (t: Tx) => t.instrument === toId && t.type === 'adjust' && t.qty === 0 && t.price === undefined
    && moved.some(m => m.account === t.account && m.date === t.date);
  return txs
    .filter(t => !(t.instrument === fromId && t.type === 'valuation') && !isClosure(t))
    .map(t => {
      if (t.instrument !== fromId) return t;
      const next: Tx = { ...t, instrument: toId };
      // Without price history the purchase date defaulted to the import date, so it can be worked out now.
      if (t.type === 'adjust' && t.price !== undefined && t.acquired === t.date) {
        const found = acquiredFor?.(t.price, t.date);
        if (found && found <= t.date) next.acquired = found;
      }
      return next;
    });
}
