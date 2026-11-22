import type { Data, Tx, Instrument, ExposureSpec } from '../../src/core/types';
import type { Report } from '../../src/core/report';
import type { RebalanceOptions, RebalanceResult } from '../../src/core/rebalance';

export type { Data, Tx, Instrument, ExposureSpec, Report, RebalanceOptions, RebalanceResult };

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
  search: (q: string) => req<{ provider: string; symbol: string; name: string; exchange?: string; type?: string }[]>('GET', `/search?q=${encodeURIComponent(q)}`),
  addInstrument: (b: Partial<Instrument> & { provider?: string; symbol?: string }) => req<Instrument>('POST', '/instruments', b),
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
