import { describe, expect, it } from 'vitest';
import { replay } from '../src/core/ledger.js';
import { DEFAULT_SETTINGS, type Instrument } from '../src/core/types.js';
import { parseCsv, parseTradeHistory, tradeHistoryLedger, yahooTicker } from '../src/import/ibkr.js';

const H = 'Transaction History,Header,Date,Account,Description,Transaction Type,Symbol,Quantity,Price,Price Currency,Gross Amount ,Commission,Net Amount';
const row = (date: string, desc: string, type: string, sym: string, qty: string, price: string, ccy: string, comm: string, net: string) =>
  `Transaction History,Data,${date},ACCT123,"${desc}",${type},${sym},${qty},${price},${ccy},${net},${comm},${net}`;
const FILE = [
  'Statement,Header,Field Name,Field Value', 'Summary,Header,Field Name,Field Value',
  'Summary,Data,Base Currency,USD', 'Summary,Data,Starting Cash,-100', 'Summary,Data,Ending Cash,-250.5', H,
  row('2026-03-01', 'ACME INC', 'Sell', 'ACME', '-5.0', '20', 'USD', '-1.0', '99'),
  row('2026-02-01', 'ACME INC', 'Buy', 'ACME', '2.0', '10', 'USD', '-1.0', '-21'),
  row('2026-02-02', 'BP PLC', 'Sell', 'BP.', '-10.0', '4', 'GBP', '-1.0', '50'),
  row('2026-02-03', 'ACME(US0000000001) Cash Dividend USD 1 per Share', 'Dividend', 'ACME', '-', '-', '-', '-', '2'),
  row('2026-02-03', 'ACME(US0000000001) Cash Dividend USD 1 per Share - US Tax', 'Foreign Tax Withholding', 'ACME', '-', '-', '-', '-', '-0.5'),
  row('2026-02-04', 'FER(US0000000002) Payment in Lieu', 'Payment in Lieu', 'FERl', '-', '-', '-', '-', '3'),
  row('2026-02-05', 'FER INC', 'Buy', 'FER', '1.0', '5', 'USD', '-', '-5'),
  row('2026-02-06', 'FER(US0000000002) Cash Dividend', 'Dividend', 'FER', '-', '-', '-', '-', '1'),
  row('2026-02-07', 'USD Debit Interest', 'Debit Interest', '-', '-', '-', '-', '-', '-4'),
  row('2026-02-08', 'Cash Transfer', 'Deposit', '-', '-', '-', '-', '-', '40'),
  row('2026-02-09', 'Mystery', 'Something New', '-', '-', '-', '-', '-', '1'),
].join('\n');

describe('parseTradeHistory', () => {
  const h = parseTradeHistory(FILE);
  it('reads the statement and never keeps the account', () => {
    expect(h).toMatchObject({ baseCurrency: 'USD', startingCash: -100, endingCash: -250.5, from: '2026-02-01', to: '2026-03-01' });
    expect(JSON.stringify(h)).not.toContain('ACCT123');
  });
  it('warns about unsupported rows instead of dropping them silently', () => {
    expect(h.warnings[0]).toContain('Something New');
  });
  it('builds exchange-specific tickers', () => {
    expect(yahooTicker('BP.', 'GBP')).toBe('BP.L');
    expect(yahooTicker('ZGLD', 'CHF')).toBe('ZGLD.SW');
    expect(yahooTicker('BRK B', 'USD')).toBe('BRK-B');
    expect(h.securities.map(s => s.ticker).sort()).toEqual(['ACME', 'BP.L', 'FER']);
  });
  it('merges two exchange symbols with the same ISIN', () => {
    expect(h.rows.filter(r => r.description.startsWith('FER(')).every(r => r.symbol === 'FER')).toBe(true);
  });
  it('rejects other files', () => {
    expect(() => parseTradeHistory('a,b\n1,2')).toThrow(/transaction history/);
  });
  it('parses quoted commas', () => {
    expect(parseCsv('"a,b",c\r\nd,"e""f"')).toEqual([['a,b', 'c'], ['d', 'e"f']]);
  });
});

describe('tradeHistoryLedger', () => {
  const h = parseTradeHistory(FILE);
  const idOf = (s: string) => (s === 'BP.' ? 'BP.L' : s);
  const instruments: Instrument[] = [{ id: 'ACME', kind: 'security', currency: 'USD' }, { id: 'BP.L', kind: 'security', currency: 'GBP' }, { id: 'FER', kind: 'security', currency: 'USD' }];
  const ledger = tradeHistoryLedger(h, 'x', idOf);
  const state = replay({ transactions: ledger, instruments, settings: DEFAULT_SETTINGS });
  it('adds an opening position for shares sold but bought earlier', () => {
    expect(ledger.find(t => t.id === 'ib-open-ACME')).toMatchObject({ type: 'open', qty: 3, date: '2026-01-31' });
    expect(ledger.find(t => t.id === 'ib-open-BP.L')).toMatchObject({ qty: 10 });
  });
  it('never leaves a short position or a warning', () => {
    expect(state.warnings).toEqual([]);
    expect(state.positions.map(p => [p.instrument, p.qty])).toEqual([['FER', 1]]);
  });
  it('ends with exactly the statement cash', () => {
    expect(state.cash.x.USD).toBeCloseTo(-250.5, 8);
    expect(state.cash.x.GBP).toBeUndefined();
  });
  it('is identical when imported again', () => {
    expect(tradeHistoryLedger(h, 'x', idOf, ledger).map(t => t.id).sort()).toEqual(ledger.map(t => t.id).sort());
  });
  it('keeps two identical rows as two transactions', () => {
    const dup = row('2026-02-01', 'ACME INC', 'Buy', 'ACME', '2.0', '10', 'USD', '-1.0', '-21');
    const out = tradeHistoryLedger(parseTradeHistory(`${FILE}\n${dup}`), 'x', idOf);
    expect(out.filter(t => t.type === 'buy' && t.instrument === 'ACME')).toHaveLength(2);
  });
});
