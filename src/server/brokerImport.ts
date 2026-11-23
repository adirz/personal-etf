import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { replay } from '../core/ledger.js';
import { Market, today } from '../core/market.js';
import { lastDateAtPrice } from '../core/priceDate.js';
import { buildReport } from '../core/report.js';
import type { Account, Data, Instrument, Series, Tx } from '../core/types.js';
import { inferCurrency, parseBrokerExport, type BrokerPosition } from '../import/broker.js';
import { isTradeHistoryTx, parseTradeHistory, tradeHistoryLedger } from '../import/ibkr.js';
import { MANUAL, normalizeName, parseSymbolDirectory, resolvePosition, type Resolution } from '../import/resolve.js';
import { readFirstSheet } from '../import/xlsx.js';
import { GLOBES_PREFIX, type GlobesProvider } from '../providers/globes.js';
import type { Registry } from '../providers/registry.js';
import { refresh } from './refresh.js';
import type { Store } from './store.js';

const NEW_ACCOUNT = '__new';
const IMPORT_BODY_LIMIT = 16 * 1024 * 1024;
const PRICE_NOTICE = 0.05;
const CONCURRENCY = 4;
const HISTORY_FROM = '2000-01-01';
const FX_CANDIDATES = ['USD', 'EUR', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY'];
const DIRECTORY_URLS = ['https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt', 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt'];

interface ApplyBody {
  file: string;
  symbols: Record<string, string>;
  accounts: { foreign: string; local: string };
  removeMissing?: boolean;
}

async function mapLimit<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}
const parseFile = (base64: unknown) => {
  if (typeof base64 !== 'string' || !base64) throw new Error('No file was received.');
  return parseBrokerExport(readFirstSheet(new Uint8Array(Buffer.from(base64, 'base64'))));
};
const parseHistoryFile = (base64: unknown) => {
  if (typeof base64 !== 'string' || !base64) throw new Error('No file was received.');
  return parseTradeHistory(Buffer.from(base64, 'base64').toString('utf8'));
};
const uid = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const avgCost = (lots: { qty: number; cost: number }[]) => { const q = lots.reduce((s, l) => s + l.qty, 0); return q > 0 ? lots.reduce((s, l) => s + l.qty * l.cost, 0) / q : undefined; };
const yahooInstrument = (list: Instrument[], symbol: string) => list.find(i => i.source?.provider === 'yahoo' && i.source.symbol === symbol);
const globesNumber = (symbol: string) => (symbol.toLowerCase().startsWith(GLOBES_PREFIX) ? symbol.slice(GLOBES_PREFIX.length) : undefined);
const linkedInstrument = (list: Instrument[], symbol: string) => {
  const n = globesNumber(symbol);
  return n ? list.find(i => i.source?.provider === 'globes' && i.source.symbol === n) : yahooInstrument(list, symbol);
};

export function brokerImportRoutes(app: FastifyInstance, store: Store, reg: Registry) {
  const yahoo = reg.get('yahoo');
  const globes = reg.get('globes') as GlobesProvider;
  const dayCache = <V>() => { const m = new Map<string, { day: string; v: V }>(); return {
    get: (k: string) => { const e = m.get(k); return e?.day === today() ? e.v : undefined; },
    set: (k: string, v: V) => { m.set(k, { day: today(), v }); return v; },
  }; };
  const recent = dayCache<number | null>();
  const histories = dayCache<Series>();
  const resolutions = dayCache<Record<string, Resolution>>();
  const directories = dayCache<Map<string, Set<string>>>();

  const livePrice = async (symbol: string) => {
    const hit = recent.get(symbol);
    if (hit !== undefined) return hit ?? undefined;
    const from = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
    const last = await yahoo.history!(symbol, from).then(h => h.series.at(-1)?.[1]).catch(() => undefined);
    recent.set(symbol, last ?? null);
    return last;
  };
  /** The full public list is downloaded, so holdings are never sent to look a name up. */
  const symbolDirectory = async () => {
    const hit = directories.get('us');
    if (hit) return hit;
    const map = new Map<string, Set<string>>();
    try {
      for (const url of DIRECTORY_URLS) {
        const r = await fetch(url);
        if (!r.ok) throw new Error(String(r.status));
        parseSymbolDirectory(await r.text(), map);
      }
    } catch { return new Map<string, Set<string>>(); }
    return directories.set('us', map);
  };
  const fullHistory = async (provider: string, symbol: string): Promise<Series> => {
    const key = `${provider}|${symbol}`;
    const hit = histories.get(key);
    if (hit) return hit;
    const p = reg.get(provider);
    return histories.set(key, p.history ? await p.history(symbol, HISTORY_FROM).then(h => h.series).catch(() => []) : []);
  };
  const seriesFor = async (inst: Instrument): Promise<Series> => {
    const provider = inst.source?.provider ?? 'manual';
    if (provider !== 'manual') return fullHistory(provider, inst.source!.symbol);
    return (await store.manualPrice(inst.id))?.series ?? [];
  };
  const ilsRates = async () => {
    const fx = reg.fxFor('USD', 'ILS');
    if (!fx) return {} as Record<string, number>;
    const from = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
    const pairs = await Promise.all(FX_CANDIDATES.map(c => fx.history(c, 'ILS', from).then(s => [c, s.at(-1)?.[1]] as const).catch(() => [c, undefined] as const)));
    return Object.fromEntries(pairs.filter((x): x is readonly [string, number] => x[1] !== undefined));
  };

  /** Latest date the asset traded at this price, used as the default "Bought on". */
  app.get<{ Querystring: { instrument: string; price: string } }>('/api/price-date', async (req) => {
    const price = Number(req.query.price);
    const inst = (await store.data()).instruments.find(i => i.id === req.query.instrument);
    if (!inst || !(price > 0)) return { date: null };
    return { date: lastDateAtPrice(await seriesFor(inst), price) ?? null };
  });

  app.post('/api/reset', async (req) => {
    const keepTickers = (req.body as { keepTickers?: boolean } | undefined)?.keepTickers !== false;
    return { autoBackup: await store.reset(keepTickers) };
  });

  // ── Trade history (Interactive Brokers CSV) ──
  app.post<{ Body: { file: string } }>('/api/import/trades/preview', { bodyLimit: IMPORT_BODY_LIMIT }, async (req) => {
    const h = parseHistoryFile(req.body?.file);
    const count = (...types: string[]) => h.rows.filter(r => types.includes(r.type)).length;
    return {
      from: h.from, to: h.to, baseCurrency: h.baseCurrency, startingCash: h.startingCash ?? null, endingCash: h.endingCash ?? null, warnings: h.warnings,
      trades: count('Buy', 'Sell'), dividends: count('Dividend', 'Payment in Lieu'), taxes: count('Foreign Tax Withholding'), interest: count('Debit Interest', 'Credit Interest'), deposits: count('Deposit', 'Withdrawal'),
      tickers: h.securities.map(s => s.ticker).sort(),
    };
  });

  app.post<{ Body: { file: string; account: string } }>('/api/import/trades/apply', { bodyLimit: IMPORT_BODY_LIMIT }, async (req) => {
    const h = parseHistoryFile(req.body?.file);
    const d = await store.data();
    const accounts: Account[] = [...d.accounts];
    let account = req.body.account;
    if (!account || account === NEW_ACCOUNT) {
      account = 'broker-global';
      if (!accounts.some(a => a.id === account)) accounts.push({ id: account, name: 'Broker global', currency: h.baseCurrency, taxStatus: 'taxable' });
    } else if (!accounts.some(a => a.id === account)) throw new Error(`Unknown account ${account}.`);

    const instruments = [...d.instruments];
    const idOf = new Map<string, string>();
    const missing = h.securities.filter(s => !yahooInstrument(instruments, s.ticker));
    const described = await mapLimit(missing, s => yahoo.describe!(s.ticker).catch(() => null));
    let added = 0;
    const unavailable: string[] = [];
    h.securities.forEach(s => {
      let inst = yahooInstrument(instruments, s.ticker);
      if (!inst) {
        const meta = described[missing.indexOf(s)];
        if (!meta) unavailable.push(s.ticker);
        const id = instruments.some(i => i.id === s.ticker) ? `${s.ticker}.yahoo` : s.ticker;
        inst = { name: s.name ?? s.ticker, kind: 'security', currency: s.currency, ...meta, id, source: { provider: 'yahoo', symbol: s.ticker } } as Instrument;
        instruments.push(inst);
        added++;
      }
      idOf.set(s.symbol, inst.id);
    });

    const ledger = tradeHistoryLedger(h, account, s => idOf.get(s)!, d.transactions);
    const others = d.transactions.filter(t => !(t.account === account && isTradeHistoryTx(t)));
    const next: Data = { ...d, accounts, instruments, transactions: [...others, ...ledger] };
    replay(next);
    const autoBackup = await store.keepBackup('before-import');
    try {
      await store.put('accounts', accounts);
      await store.put('instruments', instruments);
      await refresh(store, reg, { ...next, settings: { ...d.settings, benchmark: undefined } }).catch(() => []);
      try { buildReport(next, await store.snapshot(next), today(), false); }
      catch (e) { throw new Error(`Import stopped, nothing was changed: ${(e as Error).message}`); }
      await store.put('transactions', next.transactions);
      const ids = await store.securityIds();
      const names = new Map<string, Set<string>>(Object.entries(ids.tradeNames).map(([k, v]) => [k, new Set(v)]));
      for (const s of h.securities) {
        if (!s.name) continue;
        const key = normalizeName(s.name);
        if (!names.has(key)) names.set(key, new Set());
        names.get(key)!.add(s.ticker);
      }
      await store.putSecurityIds({ ...ids, tradeNames: Object.fromEntries([...names].map(([k, v]) => [k, [...v]])) });
    } catch (e) { await store.put('accounts', d.accounts); await store.put('instruments', d.instruments); throw e; }
    return { transactions: ledger.length, instrumentsAdded: added, openings: ledger.filter(t => t.type === 'open').length, unavailable, endingCash: h.endingCash ?? null, baseCurrency: h.baseCurrency, autoBackup };
  });

  // ── Holdings snapshot (Excel) ──
  app.post<{ Body: { file: string } }>('/api/import/preview', { bodyLimit: IMPORT_BODY_LIMIT }, async (req) => {
    const parsed = parseFile(req.body?.file);
    const d = await store.data();
    const ids = await store.securityIds();
    const directory = await symbolDirectory();
    const found = await mapLimit(parsed.positions, p => resolvePosition(p, { ids, directory, searchIsin: q => yahoo.search!(q), globesHas: async n => !!(await globes.lookup(n)) }));
    resolutions.set(createHash('sha256').update(req.body.file).digest('hex'), Object.fromEntries(parsed.positions.map((p, i) => [p.id, found[i]])));
    return {
      asOf: parsed.asOf, totalIls: parsed.totalIls, unlistedIls: parsed.unlistedIls, warnings: parsed.warnings,
      knownTickers: d.instruments.filter(i => i.source?.provider === 'yahoo').map(i => i.source!.symbol).sort(),
      rows: parsed.positions.map((p, i) => ({
        id: p.id, name: p.name, qty: p.qty, price: p.price, cost: p.cost, valueIls: p.valueIls, listedInIls: p.listedInIls,
        symbol: found[i].symbol ?? null, via: found[i].via,
        instrumentId: (found[i].symbol ? linkedInstrument(d.instruments, found[i].symbol!) : d.instruments.find(x => x.id === p.id))?.id ?? null,
      })),
    };
  });

  app.post<{ Body: ApplyBody }>('/api/import/apply', { bodyLimit: IMPORT_BODY_LIMIT }, async (req) => {
    const b = req.body;
    const parsed = parseFile(b?.file);
    const date = parsed.asOf && parsed.asOf <= today() ? parsed.asOf : today();
    const d = await store.data();
    const known = resolutions.get(createHash('sha256').update(b.file).digest('hex')) ?? {};

    // A chosen ticker must exist. A large price gap is reported, never used to pick or reject a security.
    const choices = await mapLimit(parsed.positions, async p => {
      const raw = String(b.symbols?.[p.id] ?? MANUAL).trim();
      if (!raw || raw.toLowerCase() === MANUAL) return { p, symbol: undefined as string | undefined, error: undefined as string | undefined, notice: undefined as string | undefined };
      const number = globesNumber(raw);
      if (number !== undefined) {
        const ok = number === p.id && !!(await globes.lookup(number));
        return { p, symbol: `${GLOBES_PREFIX}${number}`, error: ok ? undefined : `${p.name}: Globes has no security ${number}.`, notice: undefined };
      }
      const symbol = raw.toUpperCase();
      const live = await livePrice(symbol);
      if (live === undefined && known[p.id]?.symbol !== symbol && !yahooInstrument(d.instruments, symbol)) return { p, symbol, error: `${p.name}: ticker ${symbol} was not found.`, notice: undefined };
      const notice = live !== undefined && Math.abs(live / p.price - 1) > PRICE_NOTICE ? `${p.name}: ${symbol} trades at ${live.toFixed(2)}, the broker file says ${p.price.toFixed(2)}.` : undefined;
      return { p, symbol, error: undefined, notice };
    });
    const problems = choices.flatMap(c => (c.error ? [c.error] : []));
    const picked = choices.flatMap(c => (c.symbol ? [c.symbol] : []));
    for (const s of new Set(picked.filter((x, i) => picked.indexOf(x) !== i))) problems.push(`${s} is assigned to more than one holding.`);
    if (problems.length) throw new Error(problems.join(' '));

    const accounts: Account[] = [...d.accounts];
    const account = (choice: string | undefined, id: string, name: string, currency: string) => {
      if (choice && choice !== NEW_ACCOUNT) {
        if (!accounts.some(a => a.id === choice)) throw new Error(`Unknown account ${choice}.`);
        return choice;
      }
      if (!accounts.some(a => a.id === id)) accounts.push({ id, name, currency, taxStatus: 'taxable' });
      return id;
    };
    const localAccount = account(b.accounts?.local, 'broker-il', 'Broker Israel', 'ILS');
    const foreignAccount = account(b.accounts?.foreign, 'broker-global', 'Broker global', 'USD');

    const unresolvedForeign = choices.some(c => !c.symbol && !c.p.listedInIls);
    const rates = unresolvedForeign ? await ilsRates() : {};
    const instruments: Instrument[] = [...d.instruments];
    const addedInstruments: Instrument[] = [];
    const byPosition = new Map<string, Instrument>();
    const described = await mapLimit(choices, async c => (c.symbol && !globesNumber(c.symbol) && !yahooInstrument(instruments, c.symbol) ? yahoo.describe!(c.symbol).catch(() => null) : null));
    choices.forEach((c, n) => {
      const existing = c.symbol ? linkedInstrument(instruments, c.symbol) : instruments.find(i => i.id === c.p.id);
      if (existing) { byPosition.set(c.p.id, existing); return; }
      let inst: Instrument;
      const number = c.symbol ? globesNumber(c.symbol) : undefined;
      if (number) {
        const id = instruments.some(i => i.id === number) ? `${number}.globes` : number;
        inst = { id, name: c.p.name, kind: 'security', currency: 'ILS', fractional: true, tradable: true, source: { provider: 'globes', symbol: number } };
      } else if (c.symbol) {
        const meta = described[n];
        if (!meta) throw new Error(`${c.p.name}: could not read ${c.symbol} from Yahoo. Try again.`);
        const id = instruments.some(i => i.id === c.symbol) ? `${c.symbol}.yahoo` : c.symbol;
        inst = { kind: 'security', currency: c.p.listedInIls ? 'ILS' : 'USD', ...meta, id, source: { provider: 'yahoo', symbol: c.symbol } } as Instrument;
      } else {
        const currency = c.p.listedInIls ? 'ILS' : inferCurrency(c.p.fxToIls, rates);
        if (!currency) throw new Error(`${c.p.name}: couldn't tell its currency. Enter its ticker instead.`);
        inst = { id: c.p.id, name: c.p.name, kind: 'manual', currency, tradable: true, source: { provider: 'manual', symbol: c.p.id } };
      }
      instruments.push(inst); addedInstruments.push(inst); byPosition.set(c.p.id, inst);
    });

    const autoBackup = await store.keepBackup('before-import');
    const restore = async () => { await store.put('accounts', d.accounts); await store.put('instruments', d.instruments); };
    try {
      await store.put('accounts', accounts);
      await store.put('instruments', instruments);

      const state = replay(d);
      const previous = new Market(await store.snapshot(d), instruments, d.transactions);
      const positionOf = (acct: string, id: string) => state.positions.find(p => p.account === acct && p.instrument === id);
      const plan: { p?: BrokerPosition; inst: Instrument; account: string; tx: Tx }[] = [];
      const valuations: Tx[] = [];
      let created = 0, updated = 0, unchanged = 0, removed = 0;

      const dates = await mapLimit(parsed.positions, async p => {
        const inst = byPosition.get(p.id)!;
        const held = positionOf(p.listedInIls ? localAccount : foreignAccount, inst.id);
        const heldCost = held ? avgCost(held.lots) : undefined;
        if (held && heldCost !== undefined && Math.abs(heldCost / p.cost - 1) < 0.001) return undefined;
        return lastDateAtPrice(await seriesFor(inst), p.cost);
      });
      parsed.positions.forEach((p, n) => {
        const inst = byPosition.get(p.id)!;
        const acct = p.listedInIls ? localAccount : foreignAccount;
        const held = positionOf(acct, inst.id);
        const heldCost = held ? avgCost(held.lots) : undefined;
        const sameQty = !!held && Math.abs(held.qty - p.qty) < 1e-6;
        const sameCost = heldCost !== undefined && Math.abs(heldCost / p.cost - 1) < 0.001;
        const isManual = inst.kind === 'manual' || inst.source?.provider === 'manual';
        if (isManual && previous.price(inst.id, date) !== p.price) valuations.push({ id: uid(), date, type: 'valuation', account: acct, instrument: inst.id, price: p.price });
        // A holding that was unlinked before and now has a ticker moves to it.
        if (!isManual) {
          const old = positionOf(acct, p.id);
          if (old && instruments.find(i => i.id === p.id)?.kind === 'manual') plan.push({ inst: instruments.find(i => i.id === p.id)!, account: acct, tx: { id: uid(), date, type: 'adjust', account: acct, instrument: p.id, qty: 0 } });
        }
        if (sameQty && sameCost) { unchanged++; return; }
        if (held) updated++; else created++;
        plan.push({ p, inst, account: acct, tx: {
          id: uid(), date, type: 'adjust', account: acct, instrument: inst.id, qty: p.qty,
          ...(sameCost ? {} : { price: p.cost, acquired: dates[n] && dates[n]! <= date ? dates[n] : date }),
        } });
      });
      // The holdings file is the full account. A position known only from trade history is either closed or is
      // one of the file's unidentified rows, so keeping it would count the same holding twice.
      const fromHistory = new Set(d.transactions.filter(t => isTradeHistoryTx(t) && t.instrument).map(t => `${t.account}|${t.instrument}`));
      const imported = new Set([...byPosition.values()].map(i => i.id));
      for (const pos of state.positions) {
        const inst = instruments.find(i => i.id === pos.instrument);
        const historyOnly = fromHistory.has(`${pos.account}|${pos.instrument}`);
        if (!b.removeMissing && !historyOnly) continue;
        if (!inst || inst.kind === 'debt' || imported.has(pos.instrument) || (pos.account !== localAccount && pos.account !== foreignAccount)) continue;
        if (plan.some(x => x.account === pos.account && x.inst.id === inst.id)) continue;
        removed++;
        plan.push({ inst, account: pos.account, tx: { id: uid(), date, type: 'adjust', account: pos.account, instrument: inst.id, qty: 0 } });
      }

      // Fetch prices and FX back to the earliest purchase date, so tax and cost use the right rates.
      const draft: Data = { ...d, accounts, instruments, transactions: [...d.transactions, ...valuations, ...plan.map(x => x.tx)] };
      await refresh(store, reg, { ...draft, settings: { ...d.settings, benchmark: undefined } }).catch(() => []);
      const market = new Market(await store.snapshot(draft), instruments, draft.transactions);
      for (const x of plan) {
        const px = market.price(x.inst.id, date) ?? x.p?.price;
        if (px !== undefined) x.tx.flowPrice = px;
      }
      const next: Data = { ...draft, transactions: [...d.transactions, ...valuations, ...plan.map(x => x.tx)] };
      try { buildReport(next, await store.snapshot(next), today(), false); }
      catch (e) { throw new Error(`Import stopped, nothing was changed: ${(e as Error).message}`); }

      await store.put('transactions', next.transactions);
      const ids = await store.securityIds();
      for (const c of choices) if (c.symbol) ids.confirmed[c.p.id] = c.symbol;
      await store.putSecurityIds(ids);
      return {
        created, updated, unchanged, removed, autoBackup,
        instrumentsAdded: addedInstruments.length,
        manual: choices.filter(c => !c.symbol).length,
        priceNotices: choices.flatMap(c => (c.notice ? [c.notice] : [])),
      };
    } catch (e) { await restore(); throw e; }
  });
}
