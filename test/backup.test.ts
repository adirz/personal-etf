import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, type Backup } from '../src/server/store.js';

let dir: string;
const inDir = (name: string) => new Store(path.join(dir, name));

async function seeded(name: string, qty: number) {
  const s = inDir(name);
  await s.put('accounts', [{ id: 'x', name: 'X', currency: 'USD', taxStatus: 'taxable' }]);
  await s.put('instruments', [{ id: 'FUND', kind: 'manual', currency: 'USD' }]);
  await s.put('transactions', [{ id: 't', date: '2025-01-01', type: 'open', account: 'x', instrument: 'FUND', qty, price: 10 }]);
  await s.put('settings', { baseCurrency: 'USD' });
  await s.putManualPrice('FUND', { currency: 'USD', series: [['2025-01-01', 10]] });
  await s.putPrice('FUND', { currency: 'USD', series: [['2025-01-02', 11]] });
  await s.putFx('USD/ILS', [['2025-01-01', 3.6]]);
  await s.putExposure('FUND', { classes: { equity: { weight: 1 } } });
  return s;
}
const entries = async (s: Store) => (await fs.readdir(s.dir)).sort();

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'petf-backup-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('save and load', () => {
  it('round-trips data and market files into an empty store', async () => {
    const saved = await (await seeded('a', 5)).exportAll();
    const target = inDir('b');
    await target.importAll(JSON.parse(JSON.stringify(saved)));
    const { savedAt: _a, ...want } = saved;
    const { savedAt: _b, ...got } = await target.exportAll();
    expect(got).toEqual(want);
  });

  it('replaces existing data, removes stale market files, and keeps a backup', async () => {
    const saved = await (await seeded('a', 5)).exportAll();
    const target = await seeded('b', 99);
    await target.putManualPrice('STALE', { currency: 'USD', series: [['2025-01-01', 1]] });
    const { autoBackup } = await target.importAll(saved);
    expect((await target.data()).transactions[0].qty).toBe(5);
    expect(await target.manualPrice('STALE')).toBeNull();
    const kept = JSON.parse(await fs.readFile(path.join(target.dir, 'backups', autoBackup), 'utf8')) as Backup;
    expect(kept.data.transactions[0].qty).toBe(99);
    expect(kept.manualPrices.STALE).toBeDefined();
  });

  it('a save made after a load does not contain the auto-backups', async () => {
    const saved = await (await seeded('a', 5)).exportAll();
    const target = await seeded('b', 9);
    await target.importAll(saved);
    expect(JSON.stringify(await target.exportAll())).not.toContain('before-load');
  });

  it.each([
    ['not a save file', { hello: 1 }],
    ['wrong version', { format: 'personal-etf-backup', version: 2 }],
    ['missing sections', { format: 'personal-etf-backup', version: 1, data: {} }],
  ])('rejects %s and changes nothing', async (_n, bad) => {
    const target = await seeded('b', 7);
    const before = await target.exportAll();
    await expect(target.importAll(bad)).rejects.toThrow();
    expect((await target.exportAll()).data).toEqual(before.data);
    expect((await entries(target)).some(n => n.startsWith('.load-') || n === 'backups')).toBe(false);
  });

  it('rejects a file whose ledger cannot be valued and changes nothing', async () => {
    const saved = await (await seeded('a', 5)).exportAll();
    saved.data.transactions[0].instrument = 'MISSING';
    const target = await seeded('b', 7);
    await expect(target.importAll(saved)).rejects.toThrow(/could not be loaded/);
    expect((await target.data()).transactions[0].instrument).toBe('FUND');
    expect((await entries(target)).some(n => n.startsWith('.load-'))).toBe(false);
  });

  it('keeps only the last 10 automatic backups', async () => {
    const saved = await (await seeded('a', 5)).exportAll();
    const target = await seeded('b', 7);
    const backups = path.join(target.dir, 'backups');
    await fs.mkdir(backups);
    for (let i = 10; i < 22; i++) await fs.writeFile(path.join(backups, `before-load-2020-01-${i}.json`), '{}');
    await target.importAll(saved);
    expect(await fs.readdir(backups)).toHaveLength(10);
  });
});
