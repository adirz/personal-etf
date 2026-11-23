import { describe, expect, it } from 'vitest';
import { replay } from '../src/core/ledger.js';
import { EQUITY_TILTS, PROFILES, profileRules, shareToMove, type EquityTilt } from '../src/core/profiles.js';
import { validateTargets } from '../src/core/targets.js';
import { DEFAULT_SETTINGS, type Instrument, type Tx } from '../src/core/types.js';
import { nameScore, relinkTransactions, suggestLinks } from '../src/import/suggest.js';

describe('suggestLinks', () => {
  const c = (ticker: string, ...names: string[]) => ({ ticker, names });
  it('expands broker abbreviations', () => {
    const out = suggestLinks([{ id: '1', name: 'VANGUARD TOT WORLD STK INDEX' }], [c('VT', 'Vanguard Total World Stock Index Fund ETF Shares'), c('VXUS', 'Vanguard Total International Stock Index Fund ETF Shares')]);
    expect(out.get('1')).toBe('VT');
  });
  it('does not treat a shared fund brand as a match', () => {
    expect(nameScore('ISHARES DJ US AEROSPACE & DF', 'iShares Gold Trust')).toBe(0);
    expect(suggestLinks([{ id: '1', name: 'MARKET VECTORS GOLD MINERS' }], [c('SIVR', 'abrdn Physical Silver Shares ETF')]).size).toBe(0);
  });
  it('gives no suggestion when two candidates are equally likely', () => {
    expect(suggestLinks([{ id: '1', name: 'ACME FUND ALPHA' }], [c('A1', 'Acme Alpha'), c('A2', 'Acme Alpha')]).size).toBe(0);
  });
  it('never proposes one ticker for two holdings', () => {
    const out = suggestLinks([{ id: '1', name: 'WAL-MART' }, { id: '2', name: 'WALMART STORES' }], [c('WMT', 'Walmart Inc.')]);
    expect([...out.values()]).toEqual(['WMT']);
  });
});

describe('relinkTransactions', () => {
  const instruments: Instrument[] = [{ id: '111', kind: 'manual', currency: 'USD' }, { id: 'ABC', kind: 'security', currency: 'USD' }];
  const txs: Tx[] = [
    { id: 'b', date: '2025-01-01', type: 'buy', account: 'x', instrument: 'ABC', qty: 5, price: 10 },
    { id: 'v', date: '2026-01-01', type: 'valuation', account: 'x', instrument: '111', price: 20 },
    { id: 'm', date: '2026-01-01', type: 'adjust', account: 'x', instrument: '111', qty: 8, price: 12, acquired: '2026-01-01', flowPrice: 20 },
    { id: 'z', date: '2026-01-01', type: 'adjust', account: 'x', instrument: 'ABC', qty: 0, flowPrice: 20 },
  ];
  const out = relinkTransactions(txs, '111', 'ABC', () => '2024-06-01');
  it('moves the holding, keeps its quantity and cost, and sets the purchase date', () => {
    const s = replay({ transactions: out, instruments: [instruments[1]], settings: DEFAULT_SETTINGS });
    expect(s.positions).toHaveLength(1);
    expect(s.positions[0]).toMatchObject({ instrument: 'ABC', qty: 8 });
    expect(s.positions[0].lots).toEqual([{ id: 'm', date: '2024-06-01', qty: 8, cost: 12 }]);
  });
  it('drops the manual price and the closing entry', () => {
    expect(out.map(t => t.id)).toEqual(['b', 'm']);
  });
  it('keeps a purchase date the user set', () => {
    const own = txs.map(t => (t.id === 'm' ? { ...t, acquired: '2023-03-03' } : t));
    expect(relinkTransactions(own, '111', 'ABC', () => '2024-06-01').find(t => t.id === 'm')!.acquired).toBe('2023-03-03');
  });
});

describe('profiles', () => {
  it('every profile and region option is a valid target set', () => {
    for (const p of PROFILES) for (const t of Object.keys(EQUITY_TILTS) as EquityTilt[]) {
      expect(validateTargets({ rules: profileRules(p.id, t), defaultBand: { abs: 5, rel: 0.25 } })).toEqual([]);
    }
  });
  it('keep the original default available unchanged', () => {
    const rules = profileRules('default', 'israel');
    expect(rules.map(r => r.id)).toEqual(['asset-class', 'equity-region', 'us-equity-sector', 'bond-type']);
    expect(rules[1].weights).toEqual({ US: 75, emerging: 25 });
    rules[0].weights.equity = 1;
    expect(profileRules('default', 'global')[0].weights.equity).toBe(63);
  });
  it('have sector, bond-region and credit breakdowns', () => {
    for (const p of PROFILES) {
      const dims = profileRules(p.id, 'global').map(r => r.dimension);
      expect(dims).toContain('sector');
      if ((p.assetClass.bond ?? 0) > 0) expect(dims.filter(d => d === 'region')).toHaveLength(2), expect(dims).toContain('credit');
    }
  });
  it('are ordered by rising stock exposure within risk levels', () => {
    const risks = PROFILES.map(p => p.risk);
    expect(risks).toEqual([...risks].sort((a, b) => a - b));
  });
  it('rejects an unknown profile', () => {
    expect(() => profileRules('nope', 'global')).toThrow();
  });
  it('measures how much must move', () => {
    expect(shareToMove({ equity: 80, bond: 20 }, 100, { equity: 60, bond: 40 })).toBe(20);
    expect(shareToMove({ equity: 60, bond: 40 }, 100, { equity: 60, bond: 40 })).toBe(0);
    expect(shareToMove({}, 0, { equity: 100 })).toBe(0);
  });
});
