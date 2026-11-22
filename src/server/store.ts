import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, type Data, type ExposureSpec, type MarketSnapshot, type Series, type Targets } from '../core/types.js';

export const COLLECTIONS = ['accounts', 'instruments', 'transactions', 'targets', 'settings'] as const;
export type Collection = typeof COLLECTIONS[number];

const DEFAULT_TARGETS: Targets = {
  defaultBand: { abs: 5, rel: 0.25 },
  excludedPct: 5,
  rules: [
    { id: 'asset-class', scope: {}, dimension: 'assetClass', weights: { equity: 63, bond: 21, commodity: 11, precious_metals: 5 } },
    { id: 'equity-region', scope: { assetClass: 'equity' }, dimension: 'region', weights: { US: 75, emerging: 25 } },
    { id: 'us-equity-sector', scope: { assetClass: 'equity', region: 'US' }, dimension: 'sector', weights: { technology: 20, real_estate: 20, financial_services: 15, healthcare: 15, industrials: 10, consumer_cyclical: 10, communication_services: 10 } },
    { id: 'bond-type', scope: { assetClass: 'bond' }, dimension: 'credit', weights: { government: 50, A: 30, AA: 10, AAA: 10 } },
  ],
};

/** Plain-JSON file store. Small, diffable, hand-editable; writes are atomic (tmp + rename). */
export class Store {
  constructor(public dir: string) {}

  private f(...p: string[]) { return path.join(this.dir, ...p); }
  private async read<T>(file: string, fallback: T): Promise<T> {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch { return fallback; }
  }
  private async write(file: string, v: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(v, null, 2));
    await fs.rename(tmp, file);
  }

  async data(): Promise<Data> {
    const [accounts, instruments, transactions, targets, settings] = await Promise.all([
      this.read(this.f('accounts.json'), [] as Data['accounts']),
      this.read(this.f('instruments.json'), [] as Data['instruments']),
      this.read(this.f('transactions.json'), [] as Data['transactions']),
      this.read(this.f('targets.json'), DEFAULT_TARGETS),
      this.read(this.f('settings.json'), DEFAULT_SETTINGS),
    ]);
    return { accounts, instruments, transactions, targets, settings: { ...DEFAULT_SETTINGS, ...settings, tax: { ...DEFAULT_SETTINGS.tax, ...settings.tax }, trading: { ...DEFAULT_SETTINGS.trading, ...settings.trading } } };
  }
  async put(c: Collection, v: unknown) { await this.write(this.f(`${c}.json`), v); }

  // ── market cache ──
  price(id: string) { return this.read<{ currency: string; series: Series } | null>(this.f('cache', 'prices', `${enc(id)}.json`), null); }
  putPrice(id: string, v: { currency: string; series: Series }) { return this.write(this.f('cache', 'prices', `${enc(id)}.json`), v); }
  manualPrice(id: string) { return this.read<{ currency: string; series: Series } | null>(this.f('manual-prices', `${enc(id)}.json`), null); }
  putManualPrice(id: string, v: { currency: string; series: Series }) { return this.write(this.f('manual-prices', `${enc(id)}.json`), v); }
  fx(pair: string) { return this.read<Series | null>(this.f('cache', 'fx', `${enc(pair)}.json`), null); }
  putFx(pair: string, s: Series) { return this.write(this.f('cache', 'fx', `${enc(pair)}.json`), s); }
  exposure(id: string) { return this.read<ExposureSpec | null>(this.f('cache', 'exposure', `${enc(id)}.json`), null); }
  putExposure(id: string, e: ExposureSpec) { return this.write(this.f('cache', 'exposure', `${enc(id)}.json`), e); }

  async snapshot(data: Data, extraPriceIds: string[] = []): Promise<MarketSnapshot> {
    const snap: MarketSnapshot = { prices: {}, fx: {}, exposures: {} };
    for (const id of [...data.instruments.map(i => i.id), ...extraPriceIds]) {
      const live = await this.price(id), man = await this.manualPrice(id);
      const merged = mergeSeries(live?.series ?? [], man?.series ?? []);
      if (merged.length) snap.prices[id] = { currency: live?.currency ?? man!.currency, series: merged };
      const e = await this.exposure(id);
      if (e) snap.exposures[id] = e;
    }
    try {
      for (const f of await fs.readdir(this.f('cache', 'fx'))) if (f.endsWith('.json')) {
        const pair = decodeURIComponent(f.slice(0, -5));
        snap.fx[pair] = (await this.fx(pair)) ?? [];
      }
    } catch { /* no fx yet */ }
    return snap;
  }
}

const enc = (s: string) => encodeURIComponent(s);
export function mergeSeries(a: Series, b: Series): Series {
  const m = new Map<string, number>(a);
  for (const [d, v] of b) m.set(d, v);
  return [...m].sort((x, y) => x[0].localeCompare(y[0]));
}
