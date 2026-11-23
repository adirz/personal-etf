import type { Data, Tx, Instrument, ExposureSpec } from '../../src/core/types';
import type { Report } from '../../src/core/report';
import type { RebalanceOptions, RebalanceResult } from '../../src/core/rebalance';

export type { Data, Tx, Instrument, ExposureSpec, Report, RebalanceOptions, RebalanceResult };

export type BulkResult = { symbol: string; status: 'added' | 'exists' | 'invalid' | 'failed'; name?: string };

export type ImportRow = { id: string; name: string; qty: number; price: number; cost: number; valueIls: number; listedInIls: boolean; symbol: string | null; via: string; instrumentId: string | null };
export type ImportPreview = { asOf?: string; totalIls: number; unlistedIls?: number; warnings: string[]; knownTickers: string[]; rows: ImportRow[] };
export type ImportResult = { created: number; updated: number; unchanged: number; removed: number; instrumentsAdded: number; manual: number; autoBackup: string; priceNotices: string[] };
export type TradesPreview = { from: string; to: string; baseCurrency: string; startingCash: number | null; endingCash: number | null; warnings: string[]; trades: number; dividends: number; taxes: number; interest: number; deposits: number; tickers: string[] };
export type TradesResult = { transactions: number; instrumentsAdded: number; openings: number; unavailable: string[]; endingCash: number | null; baseCurrency: string; autoBackup: string };

export type LinkItem = { id: string; name: string; qty: number; currency: string; price: number | null; suggestion: { ticker: string; name: string; price: number | null } | null };
export type ClassificationItem = { id: string; name: string; value: number; current: { assetClass?: string; region?: string; sector?: string; bondType?: string } };
export type ClassificationReview = { items: ClassificationItem[]; waitingForTicker: number };
export type LinkReview = { items: LinkItem[]; options: { ticker: string; name: string }[] };

const cfg = () => ({ base: localStorage.getItem('petf.server') ?? '', token: localStorage.getItem('petf.token') ?? '' });
export const setServer = (base: string, token: string) => { localStorage.setItem('petf.server', base.replace(/\/$/, '')); localStorage.setItem('petf.token', token); };
export const getServer = cfg;

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { base, token } = cfg();
  const r = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `${r.status}`);
  return j as T;
}

export const api = {
  data: () => req<Data>('GET', '/data'),
  put: (c: keyof Data, v: unknown) => req('PUT', `/data/${c}`, v),
  addTx: (t: Partial<Tx> | Partial<Tx>[]) => req<Tx[]>('POST', '/transactions', t),
  delTx: (id: string) => req('DELETE', `/transactions/${encodeURIComponent(id)}`),
  setHolding: (b: { account: string; instrument?: string; qty?: number; cost?: number; acquired?: string; price?: number; currency?: string; amount?: number }) => req<Tx[]>('POST', '/holdings', b),
  saveFile: () => req<{ savedAt: string }>('GET', '/backup'),
  loadFile: (backup: unknown) => req<{ autoBackup: string }>('POST', '/backup', backup),
  search: (q: string) => req<{ provider: string; symbol: string; name: string; exchange?: string; type?: string }[]>('GET', `/search?q=${encodeURIComponent(q)}`),
  addInstrument: (b: Partial<Instrument> & { provider?: string; symbol?: string }) => req<Instrument>('POST', '/instruments', b),
  addInstruments: (symbols: string) => req<BulkResult[]>('POST', '/instruments/bulk', { symbols }),
  delInstrument: (id: string) => req<{ removedTransactions: number }>('DELETE', `/instruments/${encodeURIComponent(id)}`),
  priceDate: (instrument: string, price: number) => req<{ date: string | null }>('GET', `/price-date?instrument=${encodeURIComponent(instrument)}&price=${price}`),
  importPreview: (file: string) => req<ImportPreview>('POST', '/import/preview', { file }),
  importApply: (b: { file: string; symbols: Record<string, string>; accounts: { foreign: string; local: string }; removeMissing: boolean }) => req<ImportResult>('POST', '/import/apply', b),
  tradesPreview: (file: string) => req<TradesPreview>('POST', '/import/trades/preview', { file }),
  tradesApply: (file: string, account: string) => req<TradesResult>('POST', '/import/trades/apply', { file, account }),
  clearAll: (keepTickers: boolean) => req<{ autoBackup: string }>('POST', '/reset', { keepTickers }),
  classificationReview: () => req<ClassificationReview>('GET', '/classification/review'),
  linkReview: () => req<LinkReview>('GET', '/links/review'),
  applyLinks: (links: Record<string, string>) => req<{ linked: number; autoBackup: string }>('POST', '/links/apply', { links }),
  previousTargets: () => req<{ targets: Data['targets'] | null }>('GET', '/targets/previous'),
  applyProfile: (profile: string, tilt: string) => req<{ autoBackup: string }>('POST', '/targets/profile', { profile, tilt }),
  uploadPrices: (id: string, csv: string) => req<{ points: number }>('POST', `/instruments/${encodeURIComponent(id)}/prices`, { csv }),
  exposure: (id: string) => req<ExposureSpec | null>('GET', `/exposure/${encodeURIComponent(id)}`),
  refresh: (force = false) => req<{ item: string; ok: boolean; msg: string }[]>('POST', '/refresh', { force }),
  report: () => req<Report>('GET', '/report'),
  rebalance: (o: RebalanceOptions) => req<RebalanceResult>('POST', '/rebalance', o),
};

export const fmtMoney = (v: number, ccy: string, compact = false) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, maximumFractionDigits: compact || Math.abs(v) >= 1000 ? 0 : 2, notation: compact ? 'compact' : 'standard' }).format(v);
export const pct = (v: number | undefined, d = 1) => (v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(d)}%`);
export const num = (v: number | undefined, d = 2) => (v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));
export const label = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
