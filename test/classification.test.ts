import { describe, expect, it } from 'vitest';
import { needsClassification, simpleFromSpec, specFromSimple } from '../src/core/classification.js';
import { atoms, share } from '../src/core/exposure.js';
import { regionOf } from '../src/providers/classify.js';
import { classifyGlobesFund } from '../src/providers/globes.js';

describe('classifyGlobesFund', () => {
  it('reads an Israeli government bond fund', () => {
    const s = classifyGlobesFund({ category: 'אג"ח בארץ - מדינה - מחקות', stockBand: '0', fxBand: '0' })!;
    expect(s.classes).toEqual({ bond: { weight: 1, dims: { region: { Israel: 1 }, bondType: { government: 1 }, credit: { government: 1 } } } });
    expect(s.dims?.currency).toEqual({ ILS: 1 });
  });
  it('splits a fund by its stock and currency exposure bands', () => {
    const s = classifyGlobesFund({ category: 'אג"ח בארץ - כללי', stockBand: '1', fxBand: 'B' })!;
    expect(s.classes.bond.weight).toBeCloseTo(0.9);
    expect(s.classes.equity.weight).toBeCloseTo(0.1);
    expect(s.dims?.currency.other).toBeCloseTo(0.3);
  });
  it('leaves other categories and leveraged bands to the user', () => {
    expect(classifyGlobesFund({ category: 'מניות בארץ - כללי', stockBand: '4', fxBand: '0' })).toBeNull();
    expect(classifyGlobesFund({ category: 'אג"ח בארץ - כללי', stockBand: '5', fxBand: '0' })).toBeNull();
  });
});

describe('single-country and regional funds', () => {
  it('recognises Switzerland, Pacific and Poland', () => {
    expect(regionOf({ name: 'iShares MSCI Switzerland ETF' })).toEqual({ developed_ex_us: 1 });
    expect(regionOf({ name: 'Vanguard FTSE Pacific Index Fund ETF Shares' })).toEqual({ developed_ex_us: 1 });
    expect(regionOf({ name: 'iShares MSCI Poland ETF' })).toEqual({ emerging: 1 });
    expect(regionOf({ category: 'Pacific/Asia ex-Japan Stk', name: 'Some Fund' })).toEqual({ emerging: 1 });
  });
});

describe('classification prompt', () => {
  it('flags unknown holdings and stocks or bonds without a region', () => {
    expect(needsClassification({ classes: { unclassified: { weight: 1 } } })).toBe(true);
    expect(needsClassification({ classes: { equity: { weight: 1, dims: { sector: { energy: 1 } } } } })).toBe(true);
    expect(needsClassification({ classes: { equity: { weight: 1, dims: { region: { US: 1 } } } } })).toBe(false);
    expect(needsClassification({ classes: { precious_metals: { weight: 1 } } })).toBe(false);
  });
  it('builds a spec the engine can use', () => {
    const a = atoms(specFromSimple({ assetClass: 'equity', region: 'Israel', sector: 'energy' }), 'ILS');
    expect(share(a, { assetClass: 'equity', region: 'Israel' }, 'sector', 'energy')).toBe(1);
  });
  it('expands a global region and ignores fields that do not apply', () => {
    const g = specFromSimple({ assetClass: 'equity', region: 'global' });
    expect(g.classes.equity.dims?.region.US).toBeCloseTo(0.63);
    expect(specFromSimple({ assetClass: 'precious_metals', region: 'US', sector: 'energy' }).classes.precious_metals.dims).toBeUndefined();
  });
  it('prefills what is already known', () => {
    expect(simpleFromSpec({ classes: { equity: { weight: 1, dims: { sector: { energy: 1 } } } } })).toMatchObject({ assetClass: 'equity', sector: 'energy' });
    expect(simpleFromSpec({ classes: { unclassified: { weight: 1 } } })).toEqual({});
  });
});
