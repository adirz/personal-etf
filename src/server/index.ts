import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay } from '../core/ledger.js';
import { Market, today } from '../core/market.js';
import { valuate } from '../core/portfolio.js';
import { rebalance, type RebalanceOptions } from '../core/rebalance.js';
import { buildReport } from '../core/report.js';
import { parseSymbols } from '../core/symbols.js';
import type { Instrument, Tx } from '../core/types.js';
import { parsePriceCsv } from '../providers/others.js';
import { defaultRegistry } from '../providers/registry.js';
import { brokerImportRoutes } from './brokerImport.js';
import { linkReviewRoutes } from './linkReview.js';
import { refresh } from './refresh.js';
import { COLLECTIONS, Store, type Collection } from './store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const store = new Store(process.env.PETF_DATA ?? path.join(root, 'data'));
const reg = defaultRegistry();
const TOKEN = process.env.PETF_TOKEN;
const BULK_LIMIT = 100;
type BulkResult = { symbol: string; status: 'added' | 'exists' | 'invalid' | 'failed'; name?: string };

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 10 * 1024 * 1024 });

app.addHook('onRequest', async (req, rep) => {
  if (!req.url.startsWith('/api')) return;
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return rep.code(401).send({ error: 'unauthorized' });
});
app.setErrorHandler((err, _req, rep) => { rep.code((err as { statusCode?: number }).statusCode ?? 400).send({ error: (err as Error).message }); });

const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

app.get('/api/data', async () => store.data());
app.put<{ Params: { c: string } }>('/api/data/:c', async (req) => {
  if (!COLLECTIONS.includes(req.params.c as Collection)) throw new Error(`unknown collection ${req.params.c}`);
  await store.put(req.params.c as Collection, req.body);
  return { ok: true };
});

app.post<{ Body: Tx | Tx[] }>('/api/transactions', async (req) => {
  const d = await store.data();
  const add = (Array.isArray(req.body) ? req.body : [req.body]).map(t => ({ ...t, id: t.id || uid('t') }));
  const next = [...d.transactions, ...add];
  replay({ ...d, transactions: next });          // throws on malformed tx → 400
  await store.put('transactions', next);
  return add;
});
app.delete<{ Params: { id: string } }>('/api/transactions/:id', async (req) => {
  const d = await store.data();
  await store.put('transactions', d.transactions.filter(t => t.id !== req.params.id));
  return { ok: true };
});

/** Set a holding or cash balance directly, without reconstructing its history. */
interface HoldingEdit { account: string; instrument?: string; qty?: number; cost?: number; acquired?: string; price?: number; currency?: string; amount?: number }
app.post<{ Body: HoldingEdit }>('/api/holdings', async (req) => {
  const d = await store.data();
  const b = req.body;
  const date = today();
  if (!d.accounts.some(a => a.id === b.account)) throw new Error(`unknown account ${b.account}`);
  for (const k of ['qty', 'cost', 'price', 'amount'] as const) {
    const v = b[k];
    if (v !== undefined && (!Number.isFinite(v) || v < 0)) throw new Error(`${k} must be a non-negative number`);
  }
  if (b.acquired && (!/^\d{4}-\d{2}-\d{2}$/.test(b.acquired) || b.acquired > date)) throw new Error('purchase date must be a valid date, not in the future');
  const add: Tx[] = [];
  if (!b.instrument) {
    if (!b.currency || b.amount === undefined) throw new Error('cash balance needs currency and amount');
    add.push({ id: uid('t'), date, type: 'adjust', account: b.account, currency: b.currency.toUpperCase(), amount: b.amount });
  } else {
    const inst = d.instruments.find(i => i.id === b.instrument);
    if (!inst) throw new Error(`unknown instrument ${b.instrument}`);
    if (b.qty === undefined) throw new Error('quantity is required');
    const held = replay(d).positions.some(p => p.account === b.account && p.instrument === inst.id);
    if (!held && b.qty > 0 && b.cost === undefined && inst.kind !== 'debt') throw new Error('average cost is required for a new holding');
    const manual = inst.kind === 'manual' || inst.source?.provider === 'manual';
    if (manual && b.price !== undefined) add.push({ id: uid('t'), date, type: 'valuation', account: b.account, instrument: inst.id, price: b.price });
    const market = new Market(await store.snapshot(d), d.instruments, d.transactions).price(inst.id, date);
    const flowPrice = (manual ? b.price : undefined) ?? market ?? b.cost;
    add.push({
      id: uid('t'), date, type: 'adjust', account: b.account, instrument: inst.id, qty: b.qty,
      ...(b.cost !== undefined && { price: b.cost }), ...(b.acquired && { acquired: b.acquired }), ...(flowPrice !== undefined && { flowPrice }),
    });
  }
  // A currency with no FX rate would make every report fail, so never save an edit that can't be valued.
  const next = { ...d, transactions: [...d.transactions, ...add] };
  const check = async () => buildReport(next, await store.snapshot(next), date, false);
  try { await check(); } catch {
    const only = d.instruments.filter(i => i.id === b.instrument);
    await refresh(store, reg, { ...next, instruments: only, transactions: add, accounts: [], settings: { ...d.settings, benchmark: undefined } }).catch(() => []);
    try { await check(); } catch (e) { throw new Error(`Not saved: ${(e as Error).message}. Check the currency code and your connection.`); }
  }
  await store.put('transactions', next.transactions);
  return add;
});

brokerImportRoutes(app, store, reg);
linkReviewRoutes(app, store, reg);

app.get('/api/backup', async () => store.exportAll());
app.post('/api/backup', { bodyLimit: 64 * 1024 * 1024 }, async (req) => store.importAll(req.body));

app.get('/api/providers', async () => [...reg.providers.values()].map(p => ({ id: p.id, label: p.label, kinds: p.kinds, search: !!p.search })));
app.get<{ Querystring: { q: string; provider?: string } }>('/api/search', async (req) => {
  const ps = [...reg.providers.values()].filter(p => p.search && (!req.query.provider || p.id === req.query.provider));
  const res = await Promise.allSettled(ps.map(p => p.search!(req.query.q)));
  return res.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
});

/** Add an instrument from a provider symbol (auto name/currency/kind), or a manual one. */
app.post<{ Body: Partial<Instrument> & { provider?: string; symbol?: string } }>('/api/instruments', async (req) => {
  const d = await store.data();
  const b = req.body;
  const same = d.instruments.find(i => b.provider && i.source?.provider === b.provider && i.source.symbol === b.symbol);
  if (same && b.provider !== 'manual') return same;   // adding twice is a no-op, not an error
  let inst: Instrument;
  if (b.provider && b.provider !== 'manual' && b.symbol) {
    const meta = (await reg.get(b.provider).describe?.(b.symbol)) ?? {};
    inst = { id: b.id || b.symbol, kind: 'security', currency: 'USD', ...meta, ...stripUndef(b), source: { provider: b.provider, symbol: b.symbol } } as Instrument;
  } else {
    if (!b.id || !b.kind || !b.currency) throw new Error('manual instrument needs id, kind, currency');
    inst = { ...(b as Instrument), source: b.kind === 'manual' ? { provider: 'manual', symbol: b.id } : b.source };
  }
  delete (inst as { provider?: string }).provider; delete (inst as { symbol?: string }).symbol;
  if (d.instruments.some(i => i.id === inst.id)) throw new Error(`instrument ${inst.id} exists`);
  await store.put('instruments', [...d.instruments, inst]);
  await refresh(store, reg, { ...d, instruments: [inst] }).catch(() => []);
  return inst;
});

/** Add many tickers at once. Each symbol reports its own outcome, so one bad ticker never blocks the rest. */
app.post<{ Body: { symbols: string } }>('/api/instruments/bulk', async (req) => {
  const { valid, invalid } = parseSymbols(String(req.body?.symbols ?? ''));
  if (valid.length + invalid.length > BULK_LIMIT) throw new Error(`Add up to ${BULK_LIMIT} tickers at a time.`);
  const known = await store.data();
  const results: BulkResult[] = invalid.map(symbol => ({ symbol, status: 'invalid' }));
  const todo: string[] = [];
  for (const symbol of valid) {
    const hit = known.instruments.find(i => i.source?.provider === 'yahoo' && i.source.symbol === symbol);
    if (hit) results.push({ symbol, status: 'exists', name: hit.name }); else todo.push(symbol);
  }
  const yahoo = reg.get('yahoo');
  const found: { symbol: string; meta: Partial<Instrument> }[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, async () => {
    while (next < todo.length) {
      const symbol = todo[next++];
      try { found.push({ symbol, meta: (await yahoo.describe?.(symbol)) ?? {} }); }
      catch { results.push({ symbol, status: 'failed' }); }
    }
  }));
  // Re-read after the network calls so an edit made meanwhile isn't overwritten.
  const d = await store.data();
  const added: Instrument[] = [];
  for (const symbol of todo) {
    const f = found.find(x => x.symbol === symbol);
    if (!f) continue;
    const taken = [...d.instruments, ...added].some(i => i.id === symbol);
    const inst = { kind: 'security', currency: 'USD', ...f.meta, id: taken ? `${symbol}.yahoo` : symbol, source: { provider: 'yahoo', symbol } } as Instrument;
    added.push(inst);
    results.push({ symbol, status: 'added', name: inst.name });
  }
  if (added.length) {
    await store.put('instruments', [...d.instruments, ...added]);
    await refresh(store, reg, { ...d, instruments: added }).catch(() => []);
  }
  const order = [...valid, ...invalid];
  return results.sort((a, b) => order.indexOf(a.symbol) - order.indexOf(b.symbol));
});

/** Delete an instrument and everything recorded against it. The ledger can't reference a missing instrument. */
app.delete<{ Params: { id: string } }>('/api/instruments/:id', async (req) => {
  const d = await store.data();
  const id = req.params.id;
  if (!d.instruments.some(i => i.id === id)) throw new Error(`unknown instrument ${id}`);
  const transactions = d.transactions.filter(t => t.instrument !== id);
  const instruments = d.instruments.filter(i => i.id !== id);
  replay({ ...d, instruments, transactions });
  await store.put('transactions', transactions);
  await store.put('instruments', instruments);
  await store.removeInstrumentFiles(id);
  return { removedTransactions: d.transactions.length - transactions.length };
});

app.post<{ Params: { id: string }; Body: { csv: string; currency?: string } }>('/api/instruments/:id/prices', async (req) => {
  const d = await store.data();
  const i = d.instruments.find(x => x.id === req.params.id);
  if (!i) throw new Error('unknown instrument');
  const series = parsePriceCsv(req.body.csv);
  if (!series.length) throw new Error('no rows parsed — expected "date,price" lines');
  await store.putManualPrice(i.id, { currency: req.body.currency ?? i.currency, series });
  return { points: series.length, from: series[0][0], to: series.at(-1)![0] };
});

app.get<{ Params: { id: string } }>('/api/exposure/:id', async (req) => store.exposure(req.params.id));

app.post<{ Body: { force?: boolean } }>('/api/refresh', async (req) => refresh(store, reg, await store.data(), { force: req.body?.force }));

app.get<{ Querystring: { asOf?: string; analytics?: string } }>('/api/report', async (req) => {
  const d = await store.data();
  const snap = await store.snapshot(d, d.settings.benchmark ? [d.settings.benchmark] : []);
  return buildReport(d, snap, req.query.asOf ?? today(), req.query.analytics !== '0');
});

app.post<{ Body: RebalanceOptions & { asOf?: string } }>('/api/rebalance', async (req) => {
  const d = await store.data();
  const snap = await store.snapshot(d);
  const date = req.body.asOf ?? today();
  const mkt = new Market(snap, d.instruments, d.transactions);
  const v = valuate(d, replay(d, date), mkt, date);
  return rebalance(d, v.lines, mkt, date, req.body);
});

const dist = path.join(root, 'app', 'dist');
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((req, rep) => (req.url.startsWith('/api') ? rep.code(404).send({ error: 'not found' }) : rep.sendFile('index.html')));
}

function stripUndef<T extends object>(o: T): Partial<T> { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>; }

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
if (!TOKEN) app.log.warn('PETF_TOKEN not set — API is unauthenticated. Set it before exposing this server.');
