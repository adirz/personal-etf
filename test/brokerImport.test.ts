import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { lastDateAtPrice } from '../src/core/priceDate.js';
import type { Series } from '../src/core/types.js';
import { inferCurrency, parseBrokerExport, type BrokerPosition } from '../src/import/broker.js';
import { emptySecurityIds, israeliIsin, normalizeName, parseSymbolDirectory, resolvePosition, type ResolveDeps } from '../src/import/resolve.js';
import { readFirstSheet } from '../src/import/xlsx.js';

const HEADER = ['שם נייר', 'מספר נייר', 'שער אחרון', 'כמות בתיק', 'שווי אחזקה (₪)', 'שווי במטבע', 'שינוי יומי %', 'שינוי יומי במטבע', 'שער עלות', 'שינוי מעלות %', 'שינוי מעלות במטבע', 'שינוי מעלות (₪)', 'נתח מהתיק', 'כמות מושאלת'];
const row = (name: string, id: string, price: number, qty: number, ils: number, value: number, cost: number, share: number) =>
  [name, id, String(price), String(qty), String(ils), String(value), '0', '0', String(cost), '0', '0', '0', String(share), '0'];
const sheet = (...rows: string[][]) => [
  ['יתרות מקוונות'], ['חשבון: 000-000000'], ['תאריך נכונות הנתונים: 05/03/2026, בשעה 00:13'], [], HEADER, ...rows,
];
const USD = row('TEST FUND ETF', '111', 100, 10, 3350, 1000, 80, 50);
const ILS = row('טבע', '222', 5000, 20, 1000, 1000, 4000, 15);
const CHF = row('SWISS GOLD SW', '333', 500, 1, 2000, 500, 400, 35);

describe('parseBrokerExport', () => {
  const r = parseBrokerExport(sheet(USD, ILS, CHF));
  it('reads the data date and every position', () => {
    expect(r.asOf).toBe('2026-03-05');
    expect(r.positions.map(p => p.id)).toEqual(['111', '222', '333']);
  });
  it('converts agorot to shekels for price and cost', () => {
    expect(r.positions[1]).toMatchObject({ price: 50, cost: 40, listedInIls: true, fxToIls: 1 });
  });
  it('keeps foreign prices and derives the FX rate', () => {
    expect(r.positions[0]).toMatchObject({ price: 100, cost: 80, listedInIls: false, fxToIls: 3.35 });
    expect(r.positions[2].fxToIls).toBe(4);
  });
  it('never carries the account number', () => {
    expect(JSON.stringify(r)).not.toContain('000-000000');
  });
  it('reports value implied by the share column but not listed', () => {
    const over = parseBrokerExport(sheet(row('A', '1', 10, 10, 104, 100, 9, 104)));
    expect(over.unlistedIls).toBeCloseTo(-4, 6);
    expect(parseBrokerExport(sheet(row('A', '1', 10, 10, 100, 100, 9, 100))).unlistedIls).toBeUndefined();
  });
  it('skips zero quantities and warns about inconsistent rows', () => {
    const x = parseBrokerExport(sheet(USD, row('ZERO', '4', 10, 0, 0, 0, 10, 0), row('BROKEN', '5', 10, 10, 777, 777, 9, 1)));
    expect(x.positions).toHaveLength(1);
    expect(x.warnings[0]).toContain('BROKEN');
  });
  it('rejects a file without the holdings table', () => {
    expect(() => parseBrokerExport([['hello']])).toThrow(/holdings table/);
  });
});

describe('readFirstSheet', () => {
  const xlsx = (rowsXml: string, shared: string[]) => zipSync({
    'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="h" sheetId="1" state="hidden" r:id="rId2"/><sheet name="v" sheetId="2" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${rowsXml}</sheetData></worksheet>`),
    'xl/worksheets/sheet2.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1"><v>hidden</v></c></row></sheetData></worksheet>'),
    'xl/sharedStrings.xml': strToU8(`<sst>${shared.map(s => `<si><t>${s}</t></si>`).join('')}<si><r><t>ri</t></r><r><t>ch</t></r></si></sst>`),
  });
  it('reads shared, rich, inline and numeric cells, keeping column positions', () => {
    const bytes = xlsx('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>1.5</v></c></row><row r="2"><c r="B2" t="inlineStr"><is><t>in</t></is></c><c r="C2" t="s"><v>1</v></c></row>', ['שלום']);
    expect(readFirstSheet(bytes)).toEqual([['שלום', '', '1.5'], ['', 'in', 'rich']]);
  });
  it('rejects a file that is not an xlsx', () => {
    expect(() => readFirstSheet(strToU8('not a zip'))).toThrow(/Excel/);
  });
});

describe('lastDateAtPrice', () => {
  const s: Series = [['2024-01-01', 10], ['2024-01-02', 20], ['2024-01-03', 30], ['2024-01-04', 21], ['2024-01-05', 40]];
  it('finds the most recent crossing, taking the closer day', () => {
    expect(lastDateAtPrice(s, 22)).toBe('2024-01-04');
    expect(lastDateAtPrice(s, 38)).toBe('2024-01-05');
  });
  it('finds an exact price', () => {
    expect(lastDateAtPrice(s, 40)).toBe('2024-01-05');
    expect(lastDateAtPrice([['2024-01-01', 10], ['2024-01-02', 30], ['2024-01-03', 20]], 30)).toBe('2024-01-02');
  });
  it('prefers a later crossing over an earlier exact price', () => {
    expect(lastDateAtPrice(s, 30)).toBe('2024-01-04');
  });
  it('uses the closest day when the price was never reached', () => {
    expect(lastDateAtPrice(s, 5)).toBe('2024-01-01');
    expect(lastDateAtPrice(s, 99)).toBe('2024-01-05');
  });
  it('handles no history', () => {
    expect(lastDateAtPrice([], 10)).toBeUndefined();
  });
});

describe('resolvePosition', () => {
  const pos = (over: Partial<BrokerPosition>): BrokerPosition => ({ id: '1', name: 'ACME CORP', qty: 1, price: 100, cost: 90, listedInIls: false, fxToIls: 3.4, valueIls: 340, ...over });
  const deps = (over: Partial<ResolveDeps> = {}): ResolveDeps => ({ ids: emptySecurityIds(), directory: new Map(), searchIsin: async () => [], globesHas: async () => false, ...over });
  const hit = (symbol: string) => ({ provider: 'yahoo', symbol, name: symbol, type: 'EQUITY' });

  it('uses a confirmed ticker first', async () => {
    expect(await resolvePosition(pos({}), deps({ ids: { confirmed: { 1: 'ACME' }, tradeNames: {} } }))).toEqual({ symbol: 'ACME', via: 'confirmed' });
  });
  it('computes valid Israeli ISINs', () => {
    expect(israeliIsin('629014')).toBe('IL0006290147');
    expect(israeliIsin('604611')).toBe('IL0006046119');
    expect(israeliIsin('abc')).toBeUndefined();
  });
  it('accepts an ISIN lookup only with exactly one TASE result', async () => {
    const p = pos({ id: '629014', name: 'טבע', listedInIls: true });
    expect(await resolvePosition(p, deps({ searchIsin: async () => [hit('TEVA.TA')] }))).toEqual({ symbol: 'TEVA.TA', via: 'isin' });
    expect((await resolvePosition(p, deps({ searchIsin: async () => [hit('A.TA'), hit('B.TA')] }))).via).toBe('none');
    expect((await resolvePosition(p, deps({ searchIsin: async () => [hit('TEVA')] }))).via).toBe('none');
  });
  it('falls back to Globes by exact security number', async () => {
    const p = pos({ id: '5118054', name: 'קרן', listedInIls: true });
    expect(await resolvePosition(p, deps({ globesHas: async n => n === '5118054' }))).toEqual({ symbol: 'globes:5118054', via: 'globes' });
    expect((await resolvePosition(p, deps({ globesHas: async () => { throw new Error('down'); } }))).via).toBe('none');
  });
  it('identifies a foreign holding by its exact trade-history name', async () => {
    const ids = { confirmed: {}, tradeNames: { [normalizeName('META PLATFORMS INC-CLASS A')]: ['META'] } };
    expect(await resolvePosition(pos({ name: 'META PLATFORMS INC' }), deps({ ids }))).toEqual({ symbol: 'META', via: 'trades' });
  });
  it('never accepts an abbreviated or similar name', async () => {
    const ids = { confirmed: {}, tradeNames: { [normalizeName('VANGUARD TOT WORLD STK ETF')]: ['VT'] } };
    expect((await resolvePosition(pos({ name: 'VANGUARD TOT WORLD STK INDEX' }), deps({ ids }))).via).toBe('none');
  });
  it('uses the official directory only for a unique exact name', async () => {
    const directory = parseSymbolDirectory('Symbol|Security Name|Market Category|Test Issue\nACME|Acme Corp - Common Stock|Q|N\nDUP|Dup Inc|Q|N\nDUPP|Dup Inc - Preferred|Q|N\nTST|Test Co|Q|Y');
    expect(await resolvePosition(pos({}), deps({ directory }))).toEqual({ symbol: 'ACME', via: 'directory' });
    expect((await resolvePosition(pos({ name: 'DUP INC' }), deps({ directory }))).via).toBe('none');
    expect((await resolvePosition(pos({ name: 'TEST CO' }), deps({ directory }))).via).toBe('none');
  });
});

describe('inferCurrency', () => {
  it('picks the nearest rate and refuses a poor match', () => {
    const rates = { USD: 3.36, CHF: 3.95, EUR: 3.65 };
    expect(inferCurrency(3.355, rates)).toBe('USD');
    expect(inferCurrency(3.9477, rates)).toBe('CHF');
    expect(inferCurrency(9, rates)).toBeUndefined();
  });
});
