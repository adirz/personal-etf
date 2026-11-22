import { describe, expect, it } from 'vitest';
import { twr } from '../src/core/analytics.js';
import { replay } from '../src/core/ledger.js';
import { drift, setWeight } from '../src/core/targets.js';
import { DEFAULT_SETTINGS, type Instrument, type Tx } from '../src/core/types.js';

const instruments: Instrument[] = [
  { id: 'SPY', kind: 'security', currency: 'USD' },
  { id: 'LOAN', kind: 'debt', currency: 'ILS' },
];
const state = (transactions: Tx[]) => replay({ transactions, instruments, settings: DEFAULT_SETTINGS });
const total = (w: Record<string, number>) => Object.values(w).reduce((a, b) => a + b, 0);
const lots: Tx[] = [
  { id: 'a', date: '2025-01-01', type: 'open', account: 'x', instrument: 'SPY', qty: 10, price: 100 },
  { id: 'b', date: '2025-02-01', type: 'open', account: 'x', instrument: 'SPY', qty: 10, price: 200 },
];

describe('setWeight', () => {
  it('keeps the sum at 100 and rescales the others proportionally', () => {
    const w = setWeight({ a: 50, b: 30, c: 20 }, 'a', 60);
    expect(w).toEqual({ a: 60, b: 24, c: 16 });
  });
  it('leaves held weights alone and caps at the available room', () => {
    const w = setWeight({ a: 50, b: 30, c: 20 }, 'a', 95, ['b']);
    expect(w).toEqual({ a: 70, b: 30, c: 0 });
  });
  it('does nothing when no other weight is free', () => {
    expect(setWeight({ a: 60, b: 40 }, 'a', 80, ['b'])).toEqual({ a: 60, b: 40 });
  });
  it('stays at exactly 100 with off-grid held weights', () => {
    expect(total(setWeight({ a: 33.3, b: 33.3, c: 33.4 }, 'a', 41.2, ['b']))).toBeCloseTo(100, 6);
  });
  it('can add a value that had no target', () => {
    const w = setWeight({ a: 100 }, 'cash', 10);
    expect(w).toEqual({ a: 90, cash: 10 });
  });
});

describe('drift rows', () => {
  it('keeps a listed 0% value so it can be raised again', () => {
    const [d] = drift([], { defaultBand: { abs: 5 }, rules: [{ id: 'r', scope: {}, dimension: 'assetClass', weights: { equity: 100, bond: 0 } }] });
    expect(d.rows.map(r => r.value)).toContain('bond');
  });
});

describe('adjust transactions', () => {
  it('creates a holding with cost and purchase date, without touching cash', () => {
    const s = state([{ id: 'h', date: '2026-01-10', type: 'adjust', account: 'x', instrument: 'SPY', qty: 5, price: 300, acquired: '2020-03-01', flowPrice: 500 }]);
    expect(s.positions[0].lots).toEqual([{ id: 'h', date: '2020-03-01', qty: 5, cost: 300 }]);
    expect(s.cash).toEqual({});
    expect(s.flows).toEqual([{ date: '2026-01-10', amount: 2500, currency: 'USD' }]);
  });
  it('reducing quantity without a new cost keeps the remaining lots (FIFO)', () => {
    const s = state([...lots, { id: 'c', date: '2026-01-01', type: 'adjust', account: 'x', instrument: 'SPY', qty: 15, flowPrice: 300 }]);
    expect(s.positions[0].lots.map(l => [l.id, l.qty, l.cost])).toEqual([['a', 5, 100], ['b', 10, 200]]);
    expect(s.flows.at(-1)!.amount).toBe(-1500);
  });
  it('changing only the cost records no flow', () => {
    const s = state([...lots, { id: 'c', date: '2026-01-01', type: 'adjust', account: 'x', instrument: 'SPY', qty: 20, price: 120, flowPrice: 300 }]);
    expect(s.positions[0].lots).toHaveLength(1);
    expect(s.flows).toHaveLength(2);
  });
  it('quantity 0 removes the position', () => {
    expect(state([...lots, { id: 'c', date: '2026-01-01', type: 'adjust', account: 'x', instrument: 'SPY', qty: 0, flowPrice: 300 }]).positions).toEqual([]);
  });
  it('sets a cash balance', () => {
    const s = state([
      { id: 'd', date: '2025-01-01', type: 'deposit', account: 'x', amount: 1000, currency: 'USD' },
      { id: 'c', date: '2026-01-01', type: 'adjust', account: 'x', amount: 400, currency: 'USD' },
    ]);
    expect(s.cash.x.USD).toBe(400);
    expect(s.flows.at(-1)!.amount).toBe(-600);
  });
  it('sets a debt balance with no cash or return effect', () => {
    const s = state([{ id: 'c', date: '2026-01-01', type: 'adjust', account: 'x', instrument: 'LOAN', qty: 5000 }]);
    expect(s.positions[0].qty).toBe(5000);
    expect(s.cash).toEqual({});
    expect(s.flows).toEqual([]);
  });
  it('a same-day price correction replaces the earlier flow', () => {
    const s = state([
      { id: 'c1', date: '2026-01-01', type: 'adjust', account: 'x', instrument: 'SPY', qty: 200, price: 3.75, flowPrice: 2.775 },
      { id: 'c2', date: '2026-01-01', type: 'adjust', account: 'x', instrument: 'SPY', qty: 200, price: 37.55, flowPrice: 27.75 },
    ]);
    expect(s.flows).toEqual([{ date: '2026-01-01', amount: 5550, currency: 'USD' }]);
  });
  it('same-day edits net against the opening quantity', () => {
    const s = state([...lots,
      { id: 'c1', date: '2026-01-01', type: 'adjust', account: 'x', instrument: 'SPY', qty: 30, flowPrice: 300 },
      { id: 'c2', date: '2026-01-01', type: 'adjust', account: 'x', instrument: 'SPY', qty: 25, flowPrice: 300 },
    ]);
    expect(s.flows.slice(2)).toEqual([{ date: '2026-01-01', amount: 1500, currency: 'USD' }]);
  });
  it('edits on different days stay separate', () => {
    const s = state([
      { id: 'c1', date: '2026-01-01', type: 'adjust', account: 'x', instrument: 'SPY', qty: 10, price: 100, flowPrice: 100 },
      { id: 'c2', date: '2026-01-02', type: 'adjust', account: 'x', instrument: 'SPY', qty: 15, flowPrice: 120 },
    ]);
    expect(s.flows.map(f => f.amount)).toEqual([1000, 600]);
  });
  it('a correction at market value does not create a return', () => {
    // 10 units at 100, corrected to 15 at the same market price.
    expect(twr([{ value: 1000, flow: 0 }, { value: 1500, flow: 500 }]).total).toBeCloseTo(0, 10);
  });
});
