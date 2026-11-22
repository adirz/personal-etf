import { replay } from './ledger.js';
import type { Market } from './market.js';
import { valuate, type Line } from './portfolio.js';
import type { Data, ISODate } from './types.js';

const DAYS = 252;
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / (x.length || 1);
const std = (x: number[]) => { const m = mean(x); return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, x.length - 1)); };
const yearsBetween = (a: ISODate, b: ISODate) => (Date.parse(b) - Date.parse(a)) / (365.25 * 864e5);

/** Daily net-worth series (base ccy) and external flows, from the ledger + market data. */
export function valueSeries(data: Data, mkt: Market, from?: ISODate, to?: ISODate) {
  const txs = [...data.transactions].sort((a, b) => a.date.localeCompare(b.date));
  if (!txs.length) return { points: [] as { date: ISODate; value: number; flow: number }[] };
  const start = from ?? txs[0].date, end = to ?? new Date().toISOString().slice(0, 10);
  const dates = mkt.dates(start, end);
  const base = data.settings.baseCurrency;
  const points: { date: ISODate; value: number; flow: number }[] = [];
  let prev = '';
  for (const d of dates) {
    const st = replay(data, d);
    const v = valuate(data, st, mkt, d);
    // gross assets (incl. the excluded sleeve, excl. debt); borrow/repay are external flows (see ledger)
    const value = v.lines.filter(l => l.kind !== 'debt').reduce((s, l) => s + l.value, 0);
    const flow = st.flows.filter(f => f.date > prev && f.date <= d).reduce((s, f) => s + f.amount * mkt.fx(f.currency, base, f.date), 0);
    points.push({ date: d, value, flow });
    prev = d;
  }
  return { points };
}

/** Time-weighted return: flows assumed at start of day. */
export function twr(points: { value: number; flow: number }[]) {
  const rets: number[] = [];
  let idx = 1;
  const index: number[] = [1];
  for (let i = 1; i < points.length; i++) {
    const denom = points[i - 1].value + points[i].flow;
    const r = denom > 1e-9 ? points[i].value / denom - 1 : 0;
    rets.push(r);
    idx *= 1 + r;
    index.push(idx);
  }
  return { rets, index, total: idx - 1 };
}

/** XIRR on external flows (investor perspective: deposits negative) + terminal value. */
export function xirr(flows: { date: ISODate; amount: number }[]): number | undefined {
  if (flows.length < 2) return undefined;
  const t0 = Date.parse(flows[0].date);
  const f = (r: number) => flows.reduce((s, x) => s + x.amount / (1 + r) ** ((Date.parse(x.date) - t0) / (365.25 * 864e5)), 0);
  let lo = -0.9999, hi = 10;
  let flo = f(lo), fhi = f(hi);
  if (flo * fhi > 0) return undefined;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = f(mid);
    if (Math.abs(fm) < 1e-7) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

export function maxDrawdown(index: number[]) {
  let peak = -Infinity, mdd = 0;
  for (const v of index) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
  return mdd;
}

export function riskStats(rets: number[], years: number, rf: number) {
  const vol = std(rets) * Math.sqrt(DAYS);
  const total = rets.reduce((a, r) => a * (1 + r), 1) - 1;
  const cagr = years > 0 ? (1 + total) ** (1 / years) - 1 : 0;
  const rfd = (1 + rf) ** (1 / DAYS) - 1;
  const downside = Math.sqrt(mean(rets.map(r => Math.min(0, r - rfd) ** 2))) * Math.sqrt(DAYS);
  return { vol, cagr, sharpe: vol ? (cagr - rf) / vol : undefined, sortino: downside ? (cagr - rf) / downside : undefined };
}

/** Daily log returns in base ccy per instrument over a lookback window (intersection of dates). */
export function returnMatrix(data: Data, mkt: Market, ids: string[], from: ISODate, to: ISODate) {
  const base = data.settings.baseCurrency;
  const inst = new Map(data.instruments.map(i => [i.id, i]));
  const dates = mkt.dates(from, to).filter(d => ids.every(id => (mkt.snap.prices[id]?.series ?? []).some(([x]) => x === d)));
  const R: Record<string, number[]> = {};
  for (const id of ids) {
    const ccy = inst.get(id)!.currency;
    const px = dates.map(d => mkt.price(id, d)! * mkt.fx(ccy, base, d));
    R[id] = px.slice(1).map((p, i) => Math.log(p / px[i]));
  }
  return { dates: dates.slice(1), R };
}

export function correlation(R: Record<string, number[]>) {
  const ids = Object.keys(R);
  const m: number[][] = ids.map(a => ids.map(b => corr(R[a], R[b])));
  return { ids, m };
}
function corr(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return sab / Math.sqrt(saa * sbb);
}
function cov(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length), ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let s = 0; for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / Math.max(1, n - 1);
}

/** Percent contribution to portfolio variance: RC_i = w_i(Σw)_i / wᵀΣw. Instruments w/o history are ignored (and reported). */
export function riskContribution(weights: Record<string, number>, R: Record<string, number[]>) {
  const ids = Object.keys(weights).filter(id => R[id]?.length > 2);
  const tot = ids.reduce((s, id) => s + weights[id], 0);
  const w = ids.map(id => weights[id] / (tot || 1));
  const C = ids.map(a => ids.map(b => cov(R[a], R[b])));
  const Cw = C.map(row => row.reduce((s, c, j) => s + c * w[j], 0));
  const varP = w.reduce((s, wi, i) => s + wi * Cw[i], 0);
  const rc: Record<string, number> = {};
  ids.forEach((id, i) => { rc[id] = varP > 0 ? (w[i] * Cw[i]) / varP : 0; });
  return { rc, volAnnual: Math.sqrt(Math.max(0, varP) * DAYS) };
}

export function beta(p: number[], b: number[]) { const v = cov(b, b); return v ? cov(p, b) / v : undefined; }

/** Full analytics bundle. */
export function analyze(data: Data, mkt: Market, lines: Line[], asOf: ISODate, lookbackDays = 365) {
  const { points } = valueSeries(data, mkt, undefined, asOf);
  const t = twr(points);
  const years = points.length > 1 ? yearsBetween(points[0].date, points.at(-1)!.date) : 0;
  const base = data.settings.baseCurrency;
  const st = replay(data, asOf);
  const flows = st.flows.map(f => ({ date: f.date, amount: -f.amount * mkt.fx(f.currency, base, f.date) }));
  if (points.length) flows.push({ date: asOf, amount: points.at(-1)!.value });
  flows.sort((a, b) => a.date.localeCompare(b.date));

  const from = new Date(Date.parse(asOf) - lookbackDays * 864e5).toISOString().slice(0, 10);
  const byInst: Record<string, number> = {};
  for (const l of lines) if (l.inTargets && (l.kind === 'security' || l.kind === 'crypto')) byInst[l.instrument] = (byInst[l.instrument] ?? 0) + l.value;
  const ids = Object.keys(byInst).filter(id => (mkt.snap.prices[id]?.series.length ?? 0) > 20);
  const { R } = returnMatrix(data, mkt, ids, from, asOf);
  const rc = riskContribution(byInst, R);

  let b: number | undefined;
  const bench = data.settings.benchmark;
  if (bench && mkt.snap.prices[bench] && t.rets.length > 20) {
    const bs = mkt.snap.prices[bench].series;
    const pd = points.map(p => p.date);
    const bpx = pd.map(d => { for (let i = bs.length - 1; i >= 0; i--) if (bs[i][0] <= d) return bs[i][1]; return NaN; });
    const br = bpx.slice(1).map((v, i) => v / bpx[i] - 1);
    const ok = br.map((x, i) => Number.isFinite(x) && Number.isFinite(t.rets[i]));
    b = beta(t.rets.filter((_, i) => ok[i]), br.filter((_, i) => ok[i]));
  }

  return {
    series: points.map((p, i) => ({ date: p.date, value: p.value, index: t.index[i] })),
    twr: t.total,
    xirr: xirr(flows),
    maxDrawdown: maxDrawdown(t.index),
    ...riskStats(t.rets, years, data.settings.riskFreeRate),
    beta: b,
    correlation: correlation(R),
    riskContribution: rc.rc,
    exAnteVol: rc.volAnnual,
    unpricedForRisk: Object.keys(byInst).filter(id => !ids.includes(id)),
  };
}
