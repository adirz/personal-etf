import { promises as fs } from 'node:fs';
import path from 'node:path';
import { today } from '../core/market.js';
import { buildReport } from '../core/report.js';
import { DEFAULT_SETTINGS, type Data, type ExposureSpec, type MarketSnapshot, type Series, type Targets } from '../core/types.js';

export const COLLECTIONS = ['accounts', 'instruments', 'transactions', 'targets', 'settings'] as const;
export type Collection = typeof COLLECTIONS[number];

type PriceFile = { currency: string; series: Series };
/** Everything needed to restore a portfolio, including market data so it works offline right after loading. */
export interface Backup {
  format: 'personal-etf-backup';
  version: 1;
  savedAt: string;
  data: Data;
  manualPrices: Record<string, PriceFile>;
  cache: { prices: Record<string, PriceFile>; fx: Record<string, Series>; exposure: Record<string, ExposureSpec> };
}
const AUTO_BACKUPS_KEPT = 10;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseBackup(raw: unknown): Backup {
  if (!isRecord(raw) || raw.format !== 'personal-etf-backup') throw new Error('This is not a Personal ETF save file.');
  if (raw.version !== 1) throw new Error(`Unsupported save file version ${String(raw.version)}.`);
  const d = raw.data, c = raw.cache;
  const valid = isRecord(d) && Array.isArray(d.accounts) && Array.isArray(d.instruments) && Array.isArray(d.transactions)
    && isRecord(d.targets) && Array.isArray(d.targets.rules) && isRecord(d.settings)
    && isRecord(raw.manualPrices) && isRecord(c) && isRecord(c.prices) && isRecord(c.fx) && isRecord(c.exposure);
  if (!valid) throw new Error('The save file is incomplete or damaged.');
  return raw as unknown as Backup;
}

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

  async removeInstrumentFiles(id: string) {
    const name = `${enc(id)}.json`;
    await Promise.all([this.f('manual-prices', name), this.f('cache', 'prices', name), this.f('cache', 'exposure', name)].map(f => fs.rm(f, { force: true })));
  }

  // ── save / load ──
  private async readAll<T>(...sub: string[]): Promise<Record<string, T>> {
    const out: Record<string, T> = {};
    const names = await fs.readdir(this.f(...sub)).catch(() => [] as string[]);
    for (const n of names) if (n.endsWith('.json')) {
      const v = await this.read<T | null>(this.f(...sub, n), null);
      if (v !== null) out[decodeURIComponent(n.slice(0, -5))] = v;
    }
    return out;
  }

  async exportAll(): Promise<Backup> {
    const [data, manualPrices, prices, fx, exposure] = await Promise.all([
      this.data(), this.readAll<PriceFile>('manual-prices'), this.readAll<PriceFile>('cache', 'prices'),
      this.readAll<Series>('cache', 'fx'), this.readAll<ExposureSpec>('cache', 'exposure'),
    ]);
    return { format: 'personal-etf-backup', version: 1, savedAt: new Date().toISOString(), data, manualPrices, cache: { prices, fx, exposure } };
  }

  /**
   * Replace all data with a save file. The file is written to a staging folder and fully valued first,
   * so a bad file changes nothing. The current data is kept in backups/ before the swap.
   */
  async importAll(raw: unknown): Promise<{ autoBackup: string }> {
    const b = parseBackup(raw);
    const stagingDir = this.f(`.load-${process.pid}-${Date.now()}`);
    const staging = new Store(stagingDir);
    try {
      for (const c of COLLECTIONS) await staging.put(c, b.data[c]);
      await fs.mkdir(path.join(stagingDir, 'manual-prices'), { recursive: true });
      await fs.mkdir(path.join(stagingDir, 'cache'), { recursive: true });
      for (const [id, v] of Object.entries(b.manualPrices)) await staging.putManualPrice(id, v);
      for (const [id, v] of Object.entries(b.cache.prices)) await staging.putPrice(id, v);
      for (const [pair, v] of Object.entries(b.cache.fx)) await staging.putFx(pair, v);
      for (const [id, v] of Object.entries(b.cache.exposure)) await staging.putExposure(id, v);
      try {
        const d = await staging.data();
        buildReport(d, await staging.snapshot(d, d.settings.benchmark ? [d.settings.benchmark] : []), today(), false);
      } catch (e) { throw new Error(`The save file could not be loaded: ${(e as Error).message}`); }

      const autoBackup = `before-load-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      await this.write(this.f('backups', autoBackup), await this.exportAll());
      const kept = (await fs.readdir(this.f('backups'))).filter(n => n.startsWith('before-load-')).sort();
      for (const old of kept.slice(0, -AUTO_BACKUPS_KEPT)) await fs.rm(this.f('backups', old), { force: true });

      for (const sub of ['manual-prices', 'cache']) {
        await fs.rm(this.f(sub), { recursive: true, force: true });
        await fs.rename(path.join(stagingDir, sub), this.f(sub));
      }
      for (const c of COLLECTIONS) await fs.rename(path.join(stagingDir, `${c}.json`), this.f(`${c}.json`));
      return { autoBackup };
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  }

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
