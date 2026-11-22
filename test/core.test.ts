import { describe, expect, it } from 'vitest';
import { replay } from '../src/core/ledger.js';
import { Market } from '../src/core/market.js';
import { atoms } from '../src/core/exposure.js';
import { valuate } from '../src/core/portfolio.js';
import { drift } from '../src/core/targets.js';
import { rebalance } from '../src/core/rebalance.js';
import { buildReport } from '../src/core/report.js';
import { xirr, twr, maxDrawdown } from '../src/core/analytics.js';
import { DEFAULT_SETTINGS, type Data, type MarketSnapshot, type Series } from '../src/core/types.js';

const flat = (v: number, from = '2025-01-01', n = 30): Series =>
  Array.from({ length: n }, (_, i) => [new Date(Date.parse(from) + i * 864e5).toISOString().slice(0, 10), v * (1 + 0.01 * Math.sin(i))]);

function fixture(): { data: Data; snap: MarketSnapshot } {
  const data: Data = {
    accounts: [
      { id: 'ibkr', name: 'IBKR', currency: 'USD', taxStatus: 'taxable' },
      { id: 'gemel', name: 'Gemel', currency: 'ILS', taxStatus: 'exempt' },
    ],
    instruments: [
      { id: 'SPY', kind: 'security', currency: 'USD', source: { provider: 'yahoo', symbol: 'SPY' } },
      { id: 'BND', kind: 'security', currency: 'USD', source: { provider: 'yahoo', symbol: 'BND' } },
      { id: 'GLD', kind: 'security', currency: 'USD', source: { provider: 'yahoo', symbol: 'GLD' } },
      { id: 'TA125', kind: 'security', currency: 'ILS', source: { provider: 'yahoo', symbol: 'TA125.TA' }, accounts: ['gemel'] },
      { id: 'BTC', kind: 'crypto', currency: 'USD', excluded: true },
      { id: 'MORTGAGE', kind: 'debt', currency: 'ILS' },
    ],
    transactions: [
      { id: 't1', date: '2025-01-01', type: 'deposit', account: 'ibkr', amount: 20000, currency: 'USD' },
      { id: 't2', date: '2025-01-02', type: 'buy', account: 'ibkr', instrument: 'SPY', qty: 20, price: 400, fees: 1 },   // low cost → big gain
      { id: 't3', date: '2025-01-05', type: 'buy', account: 'ibkr', instrument: 'SPY', qty: 10, price: 620 },           // above market → loss lot
      { id: 't4', date: '2025-01-05', type: 'buy', account: 'ibkr', instrument: 'BND', qty: 20, price: 70 },
      { id: 't5', date: '2025-01-03', type: 'open', account: 'gemel', instrument: 'TA125', qty: 1000, price: 20 },
      { id: 't6', date: '2025-01-03', type: 'deposit', account: 'gemel', amount: 1000, currency: 'ILS' },
      { id: 't7', date: '2025-01-04', type: 'buy', account: 'ibkr', instrument: 'BTC', qty: 0.01, price: 90000 },
      { id: 't8', date: '2025-01-01', type: 'borrow', account: 'gemel', instrument: 'MORTGAGE', amount: 0 },
      { id: 't9', date: '2025-01-10', type: 'sell', account: 'ibkr', instrument: 'SPY', qty: 5, price: 600 },
    ],
    targets: {
      defaultBand: { abs: 5, rel: 0.25 },
      rules: [
        { id: 'top', scope: {}, dimension: 'assetClass', weights: { equity: 60, bond: 25, precious_metals: 10, cash: 5 } },
        { id: 'eq-region', scope: { assetClass: 'equity' }, dimension: 'region', weights: { US: 70, Israel: 30 } },
        { id: 'us-sector', scope: { assetClass: 'equity', region: 'US' }, dimension: 'sector', weights: { technology: 35, financial_services: 15, other: 50 } },
      ],
    },
    settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD', tax: { ...DEFAULT_SETTINGS.tax, currency: 'ILS' } },
  };
  const snap: MarketSnapshot = {
    prices: {
      SPY: { currency: 'USD', series: flat(600) }, BND: { currency: 'USD', series: flat(72) },
      GLD: { currency: 'USD', series: flat(250) }, TA125: { currency: 'ILS', series: flat(25) }, BTC: { currency: 'USD', series: flat(95000) },
    },
    fx: { 'USD/ILS': flat(3.6) },
    exposures: {
      SPY: { classes: { equity: { weight: 0.99, dims: { region: { US: 1 }, sector: { technology: 0.33, financial_services: 0.13, other: 0.54 } } }, cash: { weight: 0.01 } }, dims: { currency: { USD: 1 } } },
      BND: { classes: { bond: { weight: 1, dims: { region: { US: 1 }, credit: { government: 0.7, AA: 0.3 } } } } },
      GLD: { classes: { precious_metals: { weight: 1 } } },
      TA125: { classes: { equity: { weight: 1, dims: { region: { Israel: 1 }, sector: { financial_services: 0.4, other: 0.6 } } } }, dims: { currency: { ILS: 1 } } },
    },
  };
  return { data, snap };
}

describe('ledger', () => {
  it('replays FIFO lots, cash, realized gains', () => {
    const { data } = fixture();
    const st = replay(data);
    const spy = st.positions.find(p => p.instrument === 'SPY')!;
    expect(spy.qty).toBe(25);
    expect(spy.lots[0].qty).toBe(15);             // FIFO consumed 5 from the first lot
    expect(st.realized[0].cost).toBeCloseTo(5 * (400 + 1 / 20));
    expect(st.cash.ibkr.USD).toBeCloseTo(20000 - 8001 - 6200 - 1400 - 900 + 3000);
    expect(st.flows.length).toBe(4);              // 2 deposits + 1 open + 1 borrow (debt is an external flow to the asset side)
  });
});

describe('exposure', () => {
  it('expands marginals into joint atoms summing to 1', () => {
    const a = atoms(fixture().snap.exposures.SPY, 'USD');
    expect(a.reduce((s, x) => s + x.w, 0)).toBeCloseTo(1);
    expect(a.find(x => x.attrs.sector === 'technology')!.w).toBeCloseTo(0.99 * 0.33);
  });
});

describe('drift + rebalance', () => {
  it('cash-flow mode only buys, and fills the most underweight class', async () => {
    const { data, snap } = fixture();
    const mkt = new Market(snap, data.instruments, data.transactions);
    const v = valuate(data, replay(data), mkt, '2025-01-20');
    const d = drift(v.lines, data.targets);
    expect(d[0].rows.find(r => r.value === 'precious_metals')!.actual).toBe(0);
    const res = await rebalance(data, v.lines, mkt, '2025-01-20', { mode: 'cashflow', contributions: { ibkr: 5000 } });
    expect(res.status).toBe('Optimal');
    expect(res.orders.every(o => o.side === 'buy')).toBe(true);
    expect(res.orders.some(o => o.instrument === 'GLD')).toBe(true);
    expect(Object.values(res.totals.cashLeft).every(c => c >= -0.01)).toBe(true);
    expect(res.after[0].maxOut).toBeLessThan(res.before[0].maxOut);
  });

  it('full mode prefers the tax-exempt account and the loss lot', async () => {
    const { data, snap } = fixture();
    // make equities heavily overweight
    data.targets.rules[0].weights = { equity: 30, bond: 50, precious_metals: 15, cash: 5 };
    const mkt = new Market(snap, data.instruments, data.transactions);
    const v = valuate(data, replay(data), mkt, '2025-01-20');
    data.settings.tax.lotMethod = 'specific';
    const res = await rebalance(data, v.lines, mkt, '2025-01-20', { mode: 'full' });
    expect(res.status).toBe('Optimal');
    const sells = res.orders.filter(o => o.side === 'sell');
    expect(sells.length).toBeGreaterThan(0);
    const spySell = sells.find(o => o.instrument === 'SPY');
    if (spySell) expect(spySell.lots![0].id).toBe('t3');   // loss lot first
    expect(sells.some(o => o.account === 'gemel')).toBe(true);
  });

  it('FIFO with non-monotone lot costs solves as MILP', async () => {
    const { data, snap } = fixture();
    data.targets.rules[0].weights = { equity: 30, bond: 50, precious_metals: 15, cash: 5 };
    const mkt = new Market(snap, data.instruments, data.transactions);
    const v = valuate(data, replay(data), mkt, '2025-01-20');
    const res = await rebalance(data, v.lines, mkt, '2025-01-20', { mode: 'full', accounts: ['ibkr'] });
    expect(res.status).toBe('Optimal');
    const spySell = res.orders.find(o => o.instrument === 'SPY' && o.side === 'sell');
    if (spySell) expect(spySell.lots![0].id).toBe('t2');   // FIFO: oldest lot first, even though it's the high-gain one
  });
});

describe('analytics', () => {
  it('xirr / twr / mdd sanity', () => {
    expect(xirr([{ date: '2024-01-01', amount: -100 }, { date: '2025-01-01', amount: 110 }])!).toBeCloseTo(0.0997, 2);
    const t = twr([{ value: 100, flow: 0 }, { value: 210, flow: 100 }, { value: 189, flow: 0 }]);
    expect(t.total).toBeCloseTo(1.05 * 0.9 - 1);
    expect(maxDrawdown([1, 1.2, 0.9, 1.1])).toBeCloseTo(-0.25);
  });
  it('full report builds', () => {
    const { data, snap } = fixture();
    const r = buildReport(data, snap, '2025-01-25');
    expect(r.netWorth).toBeGreaterThan(0);
    expect(r.targetErrors).toEqual([]);
    expect(r.analytics!.correlation.ids.length).toBeGreaterThan(0);
    expect(r.breakdowns.currency.ILS).toBeGreaterThan(0);
  });
});
