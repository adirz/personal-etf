import type { Data, Lot, PortfolioState, Position, Tx, Ccy, Instrument } from './types.js';

const EPS = 1e-9;

/** Replay the ledger up to and including `asOf` (default: everything). Pure. */
export function replay(data: Pick<Data, 'transactions' | 'instruments' | 'settings'>, asOf?: string): PortfolioState {
  const inst = new Map(data.instruments.map(i => [i.id, i]));
  const method = data.settings.tax.lotMethod;
  const txs = [...data.transactions]
    .filter(t => !asOf || t.date <= asOf)
    .sort((a, b) => a.date.localeCompare(b.date) || order(a) - order(b));

  const pos = new Map<string, Position>();
  const sameDayEdits = new Map<string, { before: number; flow?: PortfolioState['flows'][number] }>();
  const st: PortfolioState = { positions: [], cash: {}, flows: [], realized: [], warnings: [] };
  const cash = (acct: string, ccy: Ccy, d: number) => {
    (st.cash[acct] ??= {});
    st.cash[acct][ccy] = (st.cash[acct][ccy] ?? 0) + d;
  };
  const getPos = (acct: string, id: string) => {
    const k = `${acct}|${id}`;
    let p = pos.get(k);
    if (!p) { p = { account: acct, instrument: id, qty: 0, lots: [] }; pos.set(k, p); }
    return p;
  };
  const need = (t: Tx, ...f: (keyof Tx)[]) => {
    for (const k of f) if (t[k] === undefined) throw new Error(`tx ${t.id} (${t.type}) missing ${String(k)}`);
  };
  const instOf = (t: Tx): Instrument => {
    const i = inst.get(t.instrument!);
    if (!i) throw new Error(`tx ${t.id}: unknown instrument ${t.instrument}`);
    return i;
  };

  for (const t of txs) {
    switch (t.type) {
      case 'buy': case 'open': {
        need(t, 'instrument', 'qty', 'price');
        const i = instOf(t);
        const p = getPos(t.account, i.id);
        const fees = t.fees ?? 0;
        p.lots.push({ id: t.id, date: t.date, qty: t.qty!, cost: t.price! + fees / t.qty! });
        p.qty += t.qty!;
        if (t.type === 'buy') cash(t.account, i.currency, -(t.qty! * t.price! + fees));
        else st.flows.push({ date: t.date, amount: t.qty! * t.price!, currency: i.currency });
        if (method === 'average') averageLots(p);
        break;
      }
      case 'sell': {
        need(t, 'instrument', 'qty', 'price');
        const i = instOf(t);
        const p = getPos(t.account, i.id);
        if (t.qty! > p.qty + EPS) st.warnings.push(`tx ${t.id}: selling ${t.qty} ${i.id} but only ${p.qty} held`);
        const fees = t.fees ?? 0;
        const consumed = consumeLots(p, t.qty!, method === 'specific' ? t.lots : undefined);
        const netPerUnit = t.price! - fees / t.qty!;
        for (const c of consumed)
          st.realized.push({ date: t.date, account: t.account, instrument: i.id, qty: c.qty, proceeds: c.qty * netPerUnit, cost: c.qty * c.cost, currency: i.currency, buyDate: c.date });
        p.qty -= t.qty!;
        cash(t.account, i.currency, t.qty! * t.price! - fees);
        break;
      }
      case 'deposit': case 'withdraw': {
        need(t, 'amount', 'currency');
        const s = t.type === 'deposit' ? 1 : -1;
        cash(t.account, t.currency!, s * t.amount!);
        st.flows.push({ date: t.date, amount: s * t.amount!, currency: t.currency! });
        break;
      }
      case 'dividend': case 'interest': need(t, 'amount', 'currency'); cash(t.account, t.currency!, t.amount!); break;
      case 'fee': need(t, 'amount', 'currency'); cash(t.account, t.currency!, -t.amount!); break;
      case 'fx': {
        need(t, 'amount', 'currency', 'toAmount', 'toCurrency');
        cash(t.account, t.currency!, -t.amount!);
        cash(t.account, t.toCurrency!, t.toAmount!);
        break;
      }
      case 'split': {
        need(t, 'instrument', 'ratio');
        for (const p of pos.values()) if (p.instrument === t.instrument) {
          p.qty *= t.ratio!;
          for (const l of p.lots) { l.qty *= t.ratio!; l.cost /= t.ratio!; }
        }
        break;
      }
      case 'borrow': case 'repay': case 'debt_interest': {
        need(t, 'instrument', 'amount');
        const i = instOf(t);
        if (i.kind !== 'debt') throw new Error(`tx ${t.id}: ${t.type} on non-debt instrument ${i.id}`);
        const p = getPos(t.account, i.id);
        const d = t.type === 'repay' ? -t.amount! : t.amount!;
        p.qty += d;
        p.lots = [{ id: i.id, date: t.date, qty: p.qty, cost: 1 }];
        // From the asset side, borrowed money is an external inflow and repayment an outflow.
        if (t.type === 'borrow') { cash(t.account, i.currency, t.amount!); st.flows.push({ date: t.date, amount: t.amount!, currency: i.currency }); }
        if (t.type === 'repay') { cash(t.account, i.currency, -t.amount!); st.flows.push({ date: t.date, amount: -t.amount!, currency: i.currency }); }
        break;
      }
      case 'valuation': break;   // consumed by market data (manual prices), no position effect
      case 'adjust': {
        // The change is an external flow at market value, so a correction never looks like a gain or loss.
        if (!t.instrument) {
          need(t, 'amount', 'currency');
          const delta = t.amount! - (st.cash[t.account]?.[t.currency!] ?? 0);
          cash(t.account, t.currency!, delta);
          if (delta) st.flows.push({ date: t.date, amount: delta, currency: t.currency! });
          break;
        }
        need(t, 'qty');
        const i = instOf(t);
        const p = getPos(t.account, i.id);
        const delta = t.qty! - p.qty;
        const avg = p.qty > EPS ? p.lots.reduce((s, l) => s + l.qty * l.cost, 0) / p.qty : undefined;
        if (i.kind === 'debt') p.lots = [{ id: i.id, date: t.date, qty: t.qty!, cost: 1 }];
        else if (t.price !== undefined) p.lots = t.qty! > EPS ? [{ id: t.id, date: t.acquired ?? t.date, qty: t.qty!, cost: t.price }] : [];
        else if (delta < 0) consumeLots(p, -delta);
        else if (delta > 0) p.lots.push({ id: t.id, date: t.acquired ?? t.date, qty: delta, cost: avg ?? t.flowPrice ?? 0 });
        p.qty = t.qty!;
        if (method === 'average') averageLots(p);
        // Several edits on one day are one correction: the latest replaces the earlier flow.
        const editKey = `${t.date}|${t.account}|${i.id}`;
        const earlier = sameDayEdits.get(editKey);
        if (earlier?.flow) st.flows.splice(st.flows.indexOf(earlier.flow), 1);
        const before = earlier?.before ?? t.qty! - delta;
        const change = t.qty! - before;
        const flow = i.kind !== 'debt' && change ? { date: t.date, amount: change * (t.flowPrice ?? t.price ?? avg ?? 0), currency: i.currency } : undefined;
        if (flow) st.flows.push(flow);
        sameDayEdits.set(editKey, { before, flow });
        break;
      }
      default: st.warnings.push(`tx ${t.id}: unknown type ${(t as Tx).type}`);
    }
  }
  st.positions = [...pos.values()].filter(p => Math.abs(p.qty) > EPS);
  for (const [a, m] of Object.entries(st.cash)) for (const c of Object.keys(m)) if (Math.abs(m[c]) < 1e-6) delete m[c];
  return st;
}

/** Deterministic intra-day ordering: cash in before trades, splits before trades. */
function order(t: Tx): number {
  return ({ deposit: 0, open: 0, borrow: 0, fx: 1, split: 1, buy: 2, sell: 2, dividend: 3, interest: 3, fee: 3, debt_interest: 3, repay: 4, withdraw: 5, valuation: 6, adjust: 7 } as Record<string, number>)[t.type] ?? 9;
}

function averageLots(p: Position) {
  const q = p.lots.reduce((s, l) => s + l.qty, 0);
  if (q <= EPS) return;
  const c = p.lots.reduce((s, l) => s + l.qty * l.cost, 0) / q;
  p.lots = [{ id: p.lots[0].id, date: p.lots[0].date, qty: q, cost: c }];
}

/** Remove `qty` from lots — FIFO by default, or the given lot ids first. Returns consumed slices. */
export function consumeLots(p: Position, qty: number, ids?: string[]): Lot[] {
  const orderLots = ids?.length
    ? [...p.lots.filter(l => ids.includes(l.id)), ...p.lots.filter(l => !ids.includes(l.id))]
    : [...p.lots];
  const out: Lot[] = [];
  let left = qty;
  for (const l of orderLots) {
    if (left <= EPS) break;
    const take = Math.min(l.qty, left);
    out.push({ ...l, qty: take });
    l.qty -= take;
    left -= take;
  }
  p.lots = p.lots.filter(l => l.qty > EPS);
  return out;
}
