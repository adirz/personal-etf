/**
 * Tax-aware rebalancer.
 *
 * Decision variables (all in base-currency value):
 *   b_j  ≥ 0          buy of candidate (account, instrument) j
 *   s_jk ∈ [0, lot]   sale from lot-segment k of held line j
 * Everything downstream is linear in these:
 *   cash_a' = cash_a + contrib_a + Σ(1−f)s − Σ(1+f)b
 *   V'(S)   = V(S) + Σ_j share_j(S)·(b_j − Σs_jk) + share_cash_a(S)·Δcash_a
 *   d_rk    = V'(S_r ∧ k) − w_rk·V'(S_r)                 (deviation from target, per rule/category)
 * Objective:  Σ imp_r·(λ·max(0,|d_rk| − band_rk) + ε·|d_rk|) + Σ fees + Σ tax_k·s_jk + τ·Σ s
 * Tax per lot segment = rate_account × (gain/value in tax currency) — so the solver naturally sells
 * loss / low-gain lots and tax-exempt accounts first. FIFO with non-monotone lot costs is enforced
 * with binaries (fill segment k only if k−1 is full) → MILP; otherwise plain LP.
 */
import highsLoader from 'highs';
import { atoms, share, specFor, UNCLASSIFIED } from './exposure.js';
import type { Market } from './market.js';
import { cashId, type Line } from './portfolio.js';
import { bandPP, drift, type RuleDrift } from './targets.js';
import type { Account, Atom, Data, ISODate } from './types.js';

export interface RebalanceOptions {
  mode: 'cashflow' | 'full';                  // cashflow: buys only (new money + idle cash)
  contributions?: Record<string, number>;     // account → amount in base ccy (negative = withdrawal)
  driftWeight?: number;                       // λ: cost per unit of out-of-band deviation (default 1)
  epsilon?: number;                           // ε: pull toward target inside bands (default 0.003)
  turnoverPenalty?: number;                   // τ: per unit sold (default 0.003)
  accounts?: string[];                        // restrict trading to these accounts
}

export interface Order {
  account: string; instrument: string; side: 'buy' | 'sell';
  units: number; value: number; price: number; ccy: string;
  fee: number; tax: number; gain: number;    // base ccy; gain realized in tax ccy converted to base
  lots?: { id: string; units: number }[];
}

export interface RebalanceResult {
  status: string;
  orders: Order[];
  totals: { buy: number; sell: number; fees: number; tax: number; cashLeft: Record<string, number> };
  before: RuleDrift[];
  after: RuleDrift[];
  notes: string[];
}

type Expr = Map<string, number>;
const add = (e: Expr, v: string, c: number) => { if (c) e.set(v, (e.get(v) ?? 0) + c); };

interface Cand {
  var: string; account: string; instrument: string; price: number; ccy: string; fx: number;
  atoms: Atom[]; fBuy: number; fSell: number; fractional: boolean; line?: Line;
  segs: { var: string; cap: number; tax: number; gainBase: number; lotId: string; units: number }[];
}

let highsP: ReturnType<typeof highsLoader> | undefined;
export const setHighsLoader = (p: ReturnType<typeof highsLoader>) => { highsP = p; };

export async function rebalance(data: Data, lines: Line[], mkt: Market, date: ISODate, opt: RebalanceOptions): Promise<RebalanceResult> {
  const S = data.settings, base = S.baseCurrency;
  const λ = opt.driftWeight ?? 1, ε = opt.epsilon ?? 0.003, τ = opt.turnoverPenalty ?? 0.003;
  const contrib = opt.contributions ?? {};
  const acctMap = new Map(data.accounts.map(a => [a.id, a]));
  const notes: string[] = [];
  const live = lines.filter(l => l.inTargets);
  const canTrade = (a: string) => !opt.accounts || opt.accounts.includes(a);

  // ── candidates ──
  const cands: Cand[] = [];
  const held = new Map<string, Line>();
  for (const l of live) if (l.tradable) held.set(l.key, l);
  let n = 0;
  for (const i of data.instruments) {
    const tradable = i.tradable ?? (i.kind === 'security' || i.kind === 'crypto');
    if (!tradable || i.excluded) continue;
    const heldIn = live.filter(l => l.instrument === i.id && l.tradable).map(l => l.account);
    const everIn = [...new Set(data.transactions.filter(t => t.instrument === i.id).map(t => t.account))];
    // never traded → accounts that trade the same provider, plus accounts with no trading history
    const prov = i.source?.provider ?? 'manual';
    const traded = (a: string) => data.transactions.some(t => t.account === a && (t.type === 'buy' || t.type === 'sell' || t.type === 'open' || (t.type === 'adjust' && !!t.instrument)));
    const sameProv = (a: string) => data.transactions.some(t => t.account === a && t.instrument && (data.instruments.find(x => x.id === t.instrument)?.source?.provider ?? 'manual') === prov && t.type !== 'valuation');
    const allowed = (i.accounts ?? (everIn.length ? everIn : data.accounts.map(a => a.id).filter(a => sameProv(a) || !traded(a)))).filter(canTrade);
    for (const a of new Set([...allowed, ...heldIn.filter(canTrade)])) {
      const acct = acctMap.get(a);
      if (!acct) continue;
      const price = mkt.price(i.id, date);
      if (price === undefined) { notes.push(`skip ${i.id}: no price`); continue; }
      const fx = mkt.fx(i.currency, base, date);
      const conv = i.currency !== acct.currency ? S.trading.fxBps / 1e4 : 0;
      const f = S.trading.feeBps / 1e4 + conv;
      const line = held.get(`${a}|${i.id}`);
      const c: Cand = {
        var: `b${n++}`, account: a, instrument: i.id, price, ccy: i.currency, fx,
        atoms: line?.atoms ?? atoms(specFor(i, mkt.snap.exposures[i.id]), i.currency),
        fBuy: f, fSell: f, fractional: i.fractional ?? i.kind !== 'security', line, segs: [],
      };
      if (line && opt.mode === 'full') c.segs = lotSegments(c, line, acct, data, mkt, date);
      cands.push(c);
    }
  }

  // ── cash atoms per account ──
  const cashAtoms = (a: string): Atom[] => [{ w: 1, attrs: { assetClass: 'cash', currency: acctMap.get(a)!.currency } }];
  const accts = [...new Set([...cands.map(c => c.account), ...Object.keys(contrib)])];

  // Δcash_a as expression
  const dCash = new Map<string, Expr>();
  for (const a of accts) dCash.set(a, new Map());
  for (const c of cands) {
    add(dCash.get(c.account)!, c.var, -(1 + c.fBuy));
    for (const s of c.segs) add(dCash.get(c.account)!, s.var, 1 - c.fSell);
  }

  // ── LP assembly ──
  const obj: Expr = new Map();
  const rows: string[] = [];
  const bounds: string[] = [];
  const binaries: string[] = [];
  let r = 0;
  const lin = (e: Expr) => [...e].filter(([, c]) => Math.abs(c) > 1e-12).map(([v, c]) => `${c < 0 ? '-' : '+'} ${fmt(Math.abs(c))} ${v}`).join(' ') || '0 b_dummy';

  for (const c of cands) {
    add(obj, c.var, c.fBuy);
    for (const s of c.segs) { add(obj, s.var, s.tax + c.fSell + τ); bounds.push(`0 <= ${s.var} <= ${fmt(s.cap)}`); }
  }

  const T0 = live.reduce((s, l) => s + l.value, 0) + Object.values(contrib).reduce((a, b) => a + b, 0);
  const before = drift(lines, data.targets);

  for (const rd of before) {
    const rule = rd.rule;
    const imp = rule.importance ?? 1;
    const cats = new Set([...Object.keys(rule.weights), ...rd.rows.map(x => x.value)]);
    // scope value after contributions (constant) → band size
    const scope0 = rd.scopeValue + Object.entries(contrib).reduce((s, [a, v]) => s + v * share(cashAtoms(a), rule.scope), 0);
    for (const k of cats) {
      if (k === UNCLASSIFIED && !(k in rule.weights)) continue;   // don't trade on classification noise
      const w = (rule.weights[k] ?? 0) / 100;
      const coef = (at: Atom[]) => share(at, rule.scope, rule.dimension, k) - w * share(at, rule.scope);
      const e: Expr = new Map();
      let k0 = 0;
      for (const l of live) k0 += l.value * coef(l.atoms);
      for (const [a, v] of Object.entries(contrib)) k0 += v * coef(cashAtoms(a));
      for (const c of cands) {
        const ci = coef(c.atoms);
        add(e, c.var, ci);
        for (const s of c.segs) add(e, s.var, -ci);
      }
      for (const a of accts) {
        const cc = coef(cashAtoms(a));
        if (cc) for (const [v, x] of dCash.get(a)!) add(e, v, cc * x);
      }
      // d = k0 + e = u − v
      const u = `u${r}`, v = `v${r}`, x = `x${r}`;
      const eq: Expr = new Map(e); add(eq, u, -1); add(eq, v, 1);
      rows.push(`d${r}: ${lin(eq)} = ${fmt(-k0)}`);
      const band = (bandPP(rule.weights[k] ?? 0, rule.band ?? data.targets.defaultBand) / 100) * Math.max(scope0, 0);
      rows.push(`e${r}: ${lin(new Map([[u, 1], [v, 1], [x, -1]]))} <= ${fmt(band)}`);
      add(obj, u, imp * ε); add(obj, v, imp * ε); add(obj, x, imp * λ);
      r++;
    }
  }

  // cash feasibility per account, plus global reserve
  const cash0 = (a: string) => live.filter(l => l.account === a && l.kind === 'cash').reduce((s, l) => s + l.value, 0);
  const total: Expr = new Map(); let totalCash0 = 0;
  for (const a of accts) {
    const have = cash0(a) + (contrib[a] ?? 0);
    totalCash0 += have;
    rows.push(`c_${safe(a)}: ${lin(dCash.get(a)!)} >= ${fmt(Math.min(0, have) - have)}`);
    for (const [v, x] of dCash.get(a)!) add(total, v, x);
  }
  const reserve = S.trading.minCashPct * T0;
  if (reserve > 0) rows.push(`reserve: ${lin(total)} >= ${fmt(Math.min(reserve, totalCash0) - totalCash0)}`);

  // FIFO ordering for non-monotone lot costs
  for (const c of cands) {
    if (S.tax.lotMethod !== 'fifo' || c.segs.length < 2) continue;
    const monotone = c.segs.every((s, i) => i === 0 || s.tax >= c.segs[i - 1].tax - 1e-12);
    if (monotone) continue;
    for (let i = 1; i < c.segs.length; i++) {
      const z = `z_${c.segs[i].var}`;
      binaries.push(z);
      rows.push(`f1_${c.segs[i].var}: ${c.segs[i].var} - ${fmt(c.segs[i].cap)} ${z} <= 0`);
      rows.push(`f2_${c.segs[i].var}: ${c.segs[i - 1].var} - ${fmt(c.segs[i - 1].cap)} ${z} >= 0`);
    }
  }

  const lp = `Minimize\n obj: ${lin(obj)}\nSubject To\n ${rows.join('\n ')}\nBounds\n ${bounds.join('\n ') || ''}\n${binaries.length ? `Binary\n ${binaries.join(' ')}\n` : ''}End\n`;
  const highs = await (highsP ??= highsLoader());
  const sol = highs.solve(lp, binaries.length ? { mip_rel_gap: 1e-4, time_limit: 20 } : {});
  if (sol.Status !== 'Optimal') return { status: sol.Status, orders: [], totals: { buy: 0, sell: 0, fees: 0, tax: 0, cashLeft: {} }, before, after: before, notes: [...notes, 'solver did not reach optimality'] };
  const val = (v: string) => Math.max(0, (sol.Columns as Record<string, { Primal: number }>)[v]?.Primal ?? 0);

  // ── extract & round to tradable units ──
  const orders: Order[] = [];
  for (const c of cands) {
    const unitBase = c.price * c.fx;
    const sold = c.segs.map(s => ({ s, value: val(s.var) })).filter(x => x.value > 1e-6);
    const sellVal = sold.reduce((a, x) => a + x.value, 0);
    const buyVal = val(c.var);
    const net = buyVal - sellVal;   // buy & sell of the same line never both make sense; net them
    if (Math.abs(net) < 1e-6) continue;
    let units = Math.abs(net) / unitBase;
    if (!c.fractional) units = net > 0 ? Math.floor(units + 1e-9) : Math.min(Math.round(units), c.line?.qty ?? 0);
    if (units <= 0) continue;
    const value = units * unitBase;
    if (value < S.trading.minTrade) continue;
    if (net > 0) {
      orders.push({ account: c.account, instrument: c.instrument, side: 'buy', units, value, price: c.price, ccy: c.ccy, fee: value * c.fBuy, tax: 0, gain: 0 });
    } else {
      // allocate units to segments in solver's chosen order
      let left = units, tax = 0, gain = 0;
      const lots: { id: string; units: number }[] = [];
      const ordered = S.tax.lotMethod === 'specific' ? sold.sort((a, b) => a.s.tax - b.s.tax).map(x => x.s) : c.segs;
      for (const s of ordered) {
        if (left <= 1e-9) break;
        const take = Math.min(s.units, left);
        lots.push({ id: s.lotId, units: take });
        tax += s.tax * take * unitBase; gain += (s.gainBase / s.units) * take;
        left -= take;
      }
      orders.push({ account: c.account, instrument: c.instrument, side: 'sell', units, value, price: c.price, ccy: c.ccy, fee: value * c.fSell, tax: Math.max(0, tax), gain, lots: S.tax.lotMethod === 'average' ? undefined : lots });
    }
  }

  // rounding can overspend: trim buys per account until cash ≥ 0
  for (const a of accts) {
    const have = () => cash0(a) + (contrib[a] ?? 0) + orders.filter(o => o.account === a).reduce((s, o) => s + (o.side === 'sell' ? o.value - o.fee : -(o.value + o.fee)), 0);
    let guard = 0;
    while (have() < -0.01 && guard++ < 1000) {
      const b = orders.filter(o => o.account === a && o.side === 'buy').sort((x, y) => y.value - x.value)[0];
      if (!b) break;
      const unit = b.value / b.units;
      const cut = Math.ceil(-have() / (unit * (1 + b.fee / b.value)) - 1e-9);
      const isFrac = cands.find(c => c.account === a && c.instrument === b.instrument)!.fractional;
      const dec = isFrac ? Math.min(b.units, -have() / (unit * (1 + b.fee / b.value))) : Math.min(b.units, Math.max(1, cut));
      b.units -= dec; b.value = b.units * unit; b.fee = b.value * (cands.find(c => c.account === a && c.instrument === b.instrument)!.fBuy);
      if (b.units <= 1e-9) orders.splice(orders.indexOf(b), 1);
    }
  }

  const after = drift(applyOrders(lines, orders, contrib, data.accounts, cands), data.targets);
  const cashLeft: Record<string, number> = {};
  for (const a of accts) cashLeft[a] = cash0(a) + (contrib[a] ?? 0) + orders.filter(o => o.account === a).reduce((s, o) => s + (o.side === 'sell' ? o.value - o.fee : -(o.value + o.fee)), 0);
  if (binaries.length) notes.push(`FIFO enforced with ${binaries.length} binary vars`);
  return {
    status: 'Optimal', orders: orders.sort((a, b) => (a.side === b.side ? b.value - a.value : a.side === 'sell' ? -1 : 1)),
    totals: {
      buy: sum(orders.filter(o => o.side === 'buy').map(o => o.value)), sell: sum(orders.filter(o => o.side === 'sell').map(o => o.value)),
      fees: sum(orders.map(o => o.fee)), tax: sum(orders.map(o => o.tax)), cashLeft,
    },
    before, after, notes,
  };
}

/** Lot segments for a held line, in the order the lot method would consume them. */
function lotSegments(c: Cand, line: Line, acct: Account, data: Data, mkt: Market, date: ISODate): Cand['segs'] {
  const S = data.settings;
  const rate = acct.taxStatus === 'taxable' ? (acct.taxRate ?? S.tax.rate) : 0;
  const tc = S.tax.currency;
  const pxTax = c.price * mkt.fx(c.ccy, tc, date);
  const lots = S.tax.lotMethod === 'average'
    ? [{ id: line.lots[0]?.id ?? 'avg', date: line.lots[0]?.date ?? date, qty: line.qty, cost: line.lots.reduce((s, l) => s + l.qty * l.cost, 0) / line.qty }]
    : [...line.lots];
  const segs = lots.map((l, k) => {
    const costTax = l.cost * mkt.fx(c.ccy, tc, l.date);
    const gainFrac = (pxTax - costTax) / pxTax;
    const t = rate * (S.tax.lossCredit ? gainFrac : Math.max(0, gainFrac));
    const valueBase = l.qty * c.price * c.fx;
    return { var: `${c.var}s${k}`, cap: valueBase, tax: t, gainBase: gainFrac * valueBase, lotId: l.id, units: l.qty };
  });
  if (S.tax.lotMethod === 'specific') segs.sort((a, b) => a.tax - b.tax);
  return segs;
}

function applyOrders(lines: Line[], orders: Order[], contrib: Record<string, number>, accounts: Account[], cands: Cand[]): Line[] {
  const out = lines.map(l => ({ ...l }));
  const acct = new Map(accounts.map(a => [a.id, a]));
  const cashLine = (a: string) => {
    const ccy = acct.get(a)!.currency;
    let l = out.find(x => x.account === a && x.instrument === cashId(ccy));
    if (!l) {
      l = { key: `${a}|${cashId(ccy)}`, account: a, instrument: cashId(ccy), name: `Cash ${ccy}`, kind: 'cash', qty: 0, price: 1, ccy, value: 0, atoms: [{ w: 1, attrs: { assetClass: 'cash', currency: ccy } }], excluded: false, inTargets: true, tradable: false, fractional: true, lots: [] };
      out.push(l);
    }
    return l;
  };
  for (const [a, v] of Object.entries(contrib)) cashLine(a).value += v;
  for (const o of orders) {
    let l = out.find(x => x.account === o.account && x.instrument === o.instrument);
    if (!l) {
      const c = cands.find(x => x.account === o.account && x.instrument === o.instrument)!;
      l = { key: `${o.account}|${o.instrument}`, account: o.account, instrument: o.instrument, name: o.instrument, kind: 'security', qty: 0, price: o.price, ccy: o.ccy, value: 0, atoms: c.atoms, excluded: false, inTargets: true, tradable: true, fractional: c.fractional, lots: [] };
      out.push(l);
    }
    const s = o.side === 'buy' ? 1 : -1;
    l.value += s * o.value;
    l.qty += s * o.units;
    cashLine(o.account).value += o.side === 'buy' ? -(o.value + o.fee) : o.value - o.fee;
  }
  return out;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const safe = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
function fmt(x: number): string {
  if (!Number.isFinite(x)) throw new Error('non-finite LP coefficient');
  const s = Math.abs(x) < 1e-12 ? '0' : x.toPrecision(12);
  return s.includes('e') ? x.toFixed(12).replace(/0+$/, '').replace(/\.$/, '') : s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
