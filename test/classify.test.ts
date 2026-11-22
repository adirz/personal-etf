import { describe, expect, it } from 'vitest';
import { classify, type FundMeta } from '../src/providers/classify.js';
import { parsePriceCsv } from '../src/providers/others.js';
import { normCcy } from '../src/providers/yahoo.js';
import { atoms } from '../src/core/exposure.js';

// Shapes mirror yahoo-finance2 quoteSummary output (topHoldings / fundProfile / assetProfile).
const SPY: FundMeta = {
  quoteType: 'ETF', name: 'SPDR S&P 500 ETF Trust', category: 'Large Blend', listingCurrency: 'USD',
  stockPosition: 0.9988, bondPosition: 0, cashPosition: 0.0012, otherPosition: 0,
  sectorWeightings: [{ realestate: 0.022 }, { consumer_cyclical: 0.105 }, { basic_materials: 0.018 }, { consumer_defensive: 0.055 }, { technology: 0.335 }, { communication_services: 0.098 }, { financial_services: 0.13 }, { utilities: 0.024 }, { industrials: 0.072 }, { energy: 0.03 }, { healthcare: 0.1 }],
};
const BND: FundMeta = {
  quoteType: 'ETF', name: 'Vanguard Total Bond Market Index Fund ETF', category: 'Intermediate Core Bond', listingCurrency: 'USD',
  stockPosition: 0, bondPosition: 0.993, cashPosition: 0.007,
  bondRatings: [{ bb: 0 }, { aa: 0.03 }, { bbb: 0.12 }, { below_b: 0 }, { other: 0 }, { b: 0 }, { a: 0.12 }, { aaa: 0.04 }, { us_government: 0.69 }],
};

describe('classify', () => {
  it('SPY → US equity with sector look-through', () => {
    const e = classify(SPY)!;
    expect(Object.keys(e.classes)).toEqual(['equity', 'cash']);
    expect(e.classes.equity.dims!.region).toEqual({ US: 1 });
    expect(e.classes.equity.dims!.sector.technology).toBeCloseTo(0.335);
    expect(e.dims!.currency).toEqual({ USD: 1 });
  });
  it('BND → bonds with credit + government/corporate split', () => {
    const e = classify(BND)!;
    expect(e.classes.bond.dims!.credit.government).toBeCloseTo(0.69);
    expect(e.classes.bond.dims!.bondType.corporate).toBeCloseTo(0.31);
  });
  it('global fund splits regions and currencies', () => {
    const e = classify({ quoteType: 'ETF', name: 'Vanguard Total World Stock ETF', category: 'Global Large-Stock Blend', stockPosition: 1 })!;
    expect(e.classes.equity.dims!.region.US).toBeCloseTo(0.63);
    expect(e.dims!.currency.USD).toBeCloseTo(0.63);
  });
  it('GLD → precious metals; GDX (miners) stays equity', () => {
    expect(Object.keys(classify({ quoteType: 'ETF', name: 'SPDR Gold Shares', category: 'Commodities Focused', otherPosition: 1 })!.classes)).toEqual(['precious_metals']);
    expect(Object.keys(classify({ quoteType: 'ETF', name: 'VanEck Gold Miners ETF', category: 'Equity Precious Metals', stockPosition: 1 })!.classes)).toEqual(['equity']);
  });
  it('TASE single stock → Israel / ILS', () => {
    const e = classify({ quoteType: 'EQUITY', name: 'Bank Leumi', exchange: 'TLV', country: 'Israel', sector: 'Financial Services', listingCurrency: 'ILS' })!;
    expect(e.classes.equity.dims).toEqual({ region: { Israel: 1 }, sector: { financial_services: 1 } });
    expect(e.dims!.currency).toEqual({ ILS: 1 });
  });
  it('Hebrew fund names (no structured data)', () => {
    const a = classify({ name: 'קסם KTF מחקה ת"א 125' })!;
    expect(Object.keys(a.classes)).toEqual(['equity']);
    expect(a.classes.equity.dims!.region).toEqual({ Israel: 1 });
    const b = classify({ name: 'מור אג"ח ממשלתי שקלי' })!;
    expect(b.classes.bond.dims!.bondType).toEqual({ government: 1 });
    const c = classify({ name: 'הראל מחקה S&P 500 מנוטרלת מט"ח מגודר', listingCurrency: 'ILS' })!;
    expect(c.classes.equity.dims!.region).toEqual({ US: 1 });
    expect(c.dims!.currency).toEqual({ ILS: 1 });   // hedged
    expect(classify({ name: 'קרן כספית שקלית' })!.classes.cash).toBeDefined();
  });
  it('atoms from a classified fund sum to 1', () => {
    const a = atoms(classify(SPY)!, 'USD');
    expect(a.reduce((s, x) => s + x.w, 0)).toBeCloseTo(1);
  });
});

describe('provider utils', () => {
  it('TASE agorot → ILS', () => { expect(normCcy('ILA')).toEqual(['ILS', 100]); });
  it('parses Israeli-style CSV', () => {
    expect(parsePriceCsv('תאריך;מחיר\n05/11/2026;123.4\n2026-11-06,"1,124.5"')).toEqual([['2026-11-05', 123.4], ['2026-11-06', 1124.5]]);
  });
});
