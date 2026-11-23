import { createHash } from 'node:crypto';
import type { ISODate, Tx } from '../core/types.js';

export interface TradeRow {
  date: ISODate;
  type: string;
  symbol?: string;
  description: string;
  qty?: number;
  price?: number;
  currency?: string;
  commission?: number;
  net: number;
}
export interface TradeSecurity { symbol: string; ticker: string; currency: string; name?: string; isin?: string; traded: boolean }
export interface TradeHistory {
  baseCurrency: string;
  startingCash?: number;
  endingCash?: number;
  from: ISODate;
  to: ISODate;
  rows: TradeRow[];
  securities: TradeSecurity[];
  warnings: string[];
}

const TRADE = new Set(['Buy', 'Sell']);
const CASH_TYPES = new Set(['Dividend', 'Payment in Lieu', 'Foreign Tax Withholding', 'Debit Interest', 'Credit Interest', 'Deposit', 'Withdrawal', 'Forex Trade Component', 'Adjustment', 'Other Fee', 'Commission Adjustment']);
export const OPENING_PREFIX = 'ib-open-';
export const CASH_PREFIX = 'ib-cash-';
export const isTradeHistoryTx = (t: Tx) => t.id.startsWith('ib-');

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const value = (s: string | undefined) => { const t = (s ?? '').trim(); return t === '' || t === '-' ? undefined : t; };
const num = (s: string | undefined) => { const t = value(s); if (t === undefined) return undefined; const n = Number(t.replace(/,/g, '')); return Number.isFinite(n) ? n : undefined; };

/** The exchange follows from the trade currency: IBKR's London lines trade in GBP, Swiss lines in CHF. */
export function yahooTicker(symbol: string, currency: string) {
  if (currency === 'GBP') return `${symbol.replace(/\.$/, '').replace(/l$/, '')}.L`;
  if (currency === 'CHF') return `${symbol}.SW`;
  return symbol.replace(/[ .]/g, '-');
}

/** Parse an Interactive Brokers "Transaction History" CSV. The account column is deliberately not read. */
export function parseTradeHistory(text: string): TradeHistory {
  const rows = parseCsv(text);
  const headerRow = rows.find(r => r[0] === 'Transaction History' && r[1] === 'Header');
  if (!headerRow) throw new Error('This is not an Interactive Brokers transaction history file.');
  const col = new Map(headerRow.map((c, i) => [c.trim(), i]));
  const needed = ['Date', 'Description', 'Transaction Type', 'Symbol', 'Quantity', 'Price', 'Price Currency', 'Commission', 'Net Amount'];
  const missing = needed.filter(c => !col.has(c));
  if (missing.length) throw new Error(`The file is missing these columns: ${missing.join(', ')}`);
  const cell = (r: string[], c: string) => r[col.get(c)!];
  const summary = (field: string) => rows.find(r => r[0] === 'Summary' && r[1] === 'Data' && r[2] === field)?.[3];

  const warnings: string[] = [];
  const parsed: TradeRow[] = [];
  const unknown = new Set<string>();
  for (const r of rows) {
    if (r[0] !== 'Transaction History' || r[1] !== 'Data') continue;
    const date = cell(r, 'Date'), type = cell(r, 'Transaction Type').trim(), net = num(cell(r, 'Net Amount'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || net === undefined) { warnings.push(`Skipped a row with an unreadable date or amount (${type}).`); continue; }
    if (!TRADE.has(type) && !CASH_TYPES.has(type)) { unknown.add(type); continue; }
    parsed.push({
      date, type, net, description: cell(r, 'Description'), symbol: value(cell(r, 'Symbol')),
      qty: num(cell(r, 'Quantity')), price: num(cell(r, 'Price')), currency: value(cell(r, 'Price Currency')), commission: num(cell(r, 'Commission')),
    });
  }
  for (const t of unknown) warnings.push(`Skipped unsupported transaction type: ${t}.`);
  if (!parsed.length) throw new Error('No transactions were found in the file.');

  // One ISIN is one security, even when IBKR reports it under two exchange symbols.
  const isinOf = new Map<string, string>();
  for (const r of parsed) {
    const m = r.description.match(/^\S+?\(([A-Z]{2}[A-Z0-9]{9}\d)\)/);
    if (m && r.symbol) isinOf.set(r.symbol, m[1]);
  }
  const tradedSymbols = new Set(parsed.filter(r => TRADE.has(r.type) && r.symbol).map(r => r.symbol!));
  const canonical = new Map<string, string>();
  for (const [symbol, isin] of isinOf) {
    if (tradedSymbols.has(symbol)) continue;
    const twin = [...isinOf].find(([s, i]) => i === isin && tradedSymbols.has(s));
    if (twin) canonical.set(symbol, twin[0]);
  }
  const instrumentRow = (r: TradeRow) => r.symbol && (TRADE.has(r.type) || isinOf.has(r.symbol));
  for (const r of parsed) if (r.symbol && instrumentRow(r)) r.symbol = canonical.get(r.symbol) ?? r.symbol;

  const base = value(summary('Base Currency')) ?? 'USD';
  const securities = new Map<string, TradeSecurity>();
  for (const r of parsed) {
    if (!r.symbol || !instrumentRow(r)) continue;
    const isTrade = TRADE.has(r.type);
    const s = securities.get(r.symbol) ?? { symbol: r.symbol, ticker: '', currency: base, traded: false };
    if (isTrade) { s.traded = true; s.currency = r.currency ?? s.currency; s.name ??= r.description; }
    s.isin ??= isinOf.get(r.symbol);
    securities.set(r.symbol, s);
  }
  for (const s of securities.values()) s.ticker = yahooTicker(s.symbol, s.currency);
  const dates = parsed.map(r => r.date).sort();
  return {
    baseCurrency: base, startingCash: num(summary('Starting Cash')), endingCash: num(summary('Ending Cash')),
    from: dates[0], to: dates[dates.length - 1], rows: parsed, securities: [...securities.values()], warnings,
  };
}

const dayBefore = (d: ISODate) => new Date(Date.parse(d) - 864e5).toISOString().slice(0, 10);

/**
 * Turn a history into ledger entries. Ids come from row content, so re-importing or overlapping files don't
 * duplicate anything. Shares sold that were bought before the file starts become an opening position,
 * and cash is set to the statement's ending balance.
 */
export function tradeHistoryLedger(h: TradeHistory, account: string, instrumentOf: (symbol: string) => string, previous: Tx[] = []): Tx[] {
  const seen = new Map<string, number>();
  const fresh: Tx[] = [];
  for (const r of h.rows) {
    const content = [r.date, r.type, r.symbol, r.description, r.qty, r.price, r.commission, r.net].join('|');
    const n = (seen.get(content) ?? 0) + 1;
    seen.set(content, n);
    const id = `ib-${createHash('sha256').update(`${content}|${n}`).digest('hex').slice(0, 20)}`;
    const base = { id, date: r.date, account, note: r.description };
    const security = r.symbol && h.securities.some(s => s.symbol === r.symbol) ? instrumentOf(r.symbol) : undefined;
    if (r.type === 'Buy' || r.type === 'Sell') {
      if (!security || r.qty === undefined || r.price === undefined) continue;
      fresh.push({ ...base, type: r.type === 'Buy' ? 'buy' : 'sell', instrument: security, qty: Math.abs(r.qty), price: r.price, fees: Math.abs(r.commission ?? 0) });
    } else if (r.type === 'Dividend' || r.type === 'Payment in Lieu') {
      fresh.push({ ...base, type: 'dividend', ...(security && { instrument: security }), amount: r.net, currency: h.baseCurrency });
    } else if (r.type === 'Deposit' || r.type === 'Withdrawal') {
      fresh.push({ ...base, type: r.net >= 0 ? 'deposit' : 'withdraw', amount: Math.abs(r.net), currency: h.baseCurrency });
    } else if (r.type === 'Credit Interest') {
      fresh.push({ ...base, type: 'interest', amount: r.net, currency: h.baseCurrency });
    } else {
      fresh.push({ ...base, type: 'fee', amount: -r.net, currency: h.baseCurrency });
    }
  }

  const freshIds = new Set(fresh.map(t => t.id));
  const kept = previous.filter(t => t.account === account && isTradeHistoryTx(t) && !t.id.startsWith(OPENING_PREFIX) && !t.id.startsWith(CASH_PREFIX) && !freshIds.has(t.id));
  const all = [...kept, ...fresh];
  const firstDate = all.map(t => t.date).sort()[0];
  const openDate = dayBefore(firstDate);

  const openings: Tx[] = [];
  const trades = all.filter(t => t.type === 'buy' || t.type === 'sell').sort((a, b) => a.date.localeCompare(b.date) || (a.type === 'buy' ? -1 : 1));
  for (const id of new Set(trades.map(t => t.instrument!))) {
    let held = 0, lowest = 0;
    for (const t of trades) {
      if (t.instrument !== id) continue;
      held += t.type === 'buy' ? t.qty! : -t.qty!;
      lowest = Math.min(lowest, held);
    }
    if (lowest < -1e-9) {
      const firstSale = trades.find(t => t.instrument === id && t.type === 'sell')!;
      openings.push({ id: `${OPENING_PREFIX}${id}`, date: openDate, type: 'open', account, instrument: id, qty: -lowest, price: firstSale.price!, note: 'Held before this history starts. Cost unknown, sale price used.' });
    }
  }

  const cash: Tx[] = [];
  if (h.startingCash !== undefined && h.from === firstDate) cash.push({ id: `${CASH_PREFIX}start`, date: openDate, type: 'adjust', account, currency: h.baseCurrency, amount: h.startingCash });
  if (h.endingCash !== undefined) {
    cash.push({ id: `${CASH_PREFIX}end-${h.baseCurrency}`, date: h.to, type: 'adjust', account, currency: h.baseCurrency, amount: h.endingCash });
    for (const c of new Set(h.securities.map(s => s.currency))) {
      if (c !== h.baseCurrency) cash.push({ id: `${CASH_PREFIX}end-${c}`, date: h.to, type: 'adjust', account, currency: c, amount: 0 });
    }
  }
  return [...openings, ...cash, ...all];
}
