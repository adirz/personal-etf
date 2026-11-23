import type { FastifyInstance } from 'fastify';
import { needsClassification, simpleFromSpec } from '../core/classification.js';
import { specFor } from '../core/exposure.js';
import { replay } from '../core/ledger.js';
import { Market, today } from '../core/market.js';
import { lastDateAtPrice } from '../core/priceDate.js';
import { EQUITY_TILTS, profileRules, type EquityTilt } from '../core/profiles.js';
import { buildReport } from '../core/report.js';
import type { Data, Instrument, Series } from '../core/types.js';
import { relinkTransactions, suggestLinks } from '../import/suggest.js';
import type { Registry } from '../providers/registry.js';
import { refresh } from './refresh.js';
import type { Store } from './store.js';

const HISTORY_FROM = '2000-01-01';
const isUnlinked = (i: Instrument) => i.kind === 'manual' && /^\d+$/.test(i.id);
const yahooOf = (list: Instrument[], symbol: string) => list.find(i => i.source?.provider === 'yahoo' && i.source.symbol === symbol);

export function linkReviewRoutes(app: FastifyInstance, store: Store, reg: Registry) {
  const yahoo = reg.get('yahoo');
  const lastPrice = async (id: string) => (await store.price(id))?.series.at(-1)?.[1] ?? null;

  const pendingLinks = async (d: Data) => {
    const ids = await store.securityIds();
    const state = replay(d);
    const held = new Set(state.positions.map(p => p.instrument));
    const unlinked = d.instruments.filter(i => isUnlinked(i) && held.has(i.id));
    const free = d.instruments.filter(i => i.source?.provider === 'yahoo' && !held.has(i.id));
    const candidates = free.map(i => ({
      ticker: i.source!.symbol,
      names: [i.name ?? i.id, ...Object.entries(ids.tradeNames).filter(([, v]) => v.includes(i.source!.symbol)).map(([k]) => k)],
    }));
    return { state, unlinked, free, suggested: suggestLinks(unlinked.map(i => ({ id: i.id, name: i.name ?? i.id })), candidates) };
  };

  /** Holdings the app can't classify. Those about to get a ticker are skipped, since linking classifies them. */
  app.get('/api/classification/review', async () => {
    const d = await store.data();
    const snap = await store.snapshot(d);
    const { suggested } = await pendingLinks(d);
    const report = buildReport(d, snap, today(), false);
    const items = report.holdings.flatMap(h => {
      const inst = d.instruments.find(i => i.id === h.instrument);
      if (!inst || h.kind === 'cash' || h.kind === 'debt' || suggested.has(inst.id)) return [];
      const spec = specFor(inst, snap.exposures[inst.id]);
      if (!needsClassification(spec)) return [];
      return [{ id: inst.id, name: h.name, value: h.value, current: simpleFromSpec(spec) }];
    }).sort((a, b) => b.value - a.value);
    return { items, waitingForTicker: suggested.size };
  });

  app.get('/api/links/review', async () => {
    const d = await store.data();
    const { state, unlinked, free, suggested } = await pendingLinks(d);
    const market = new Market(await store.snapshot(d), d.instruments, d.transactions);
    const items = await Promise.all(unlinked.map(async i => {
      const pos = state.positions.find(p => p.instrument === i.id)!;
      const ticker = suggested.get(i.id);
      const target = ticker ? yahooOf(d.instruments, ticker) : undefined;
      return {
        id: i.id, name: i.name ?? i.id, qty: pos.qty, currency: i.currency, price: market.price(i.id, today()) ?? null,
        suggestion: target ? { ticker: ticker!, name: target.name ?? ticker!, price: await lastPrice(target.id) } : null,
      };
    }));
    return { items, options: free.map(i => ({ ticker: i.source!.symbol, name: i.name ?? i.id })) };
  });

  app.post<{ Body: { links: Record<string, string> } }>('/api/links/apply', async (req) => {
    const links = Object.entries(req.body?.links ?? {}).map(([id, s]) => [id, String(s).trim().toUpperCase()] as const).filter(([, s]) => s);
    if (!links.length) throw new Error('Approve at least one holding.');
    const d = await store.data();
    const state = replay(d);
    const instruments = [...d.instruments];
    const problems: string[] = [];
    const pairs: { from: Instrument; to: Instrument }[] = [];
    for (const [id, symbol] of links) {
      const from = d.instruments.find(i => i.id === id);
      if (!from || !isUnlinked(from)) { problems.push(`${id} is not an unlinked holding.`); continue; }
      let to = yahooOf(instruments, symbol);
      if (!to) {
        const meta = await yahoo.describe!(symbol).catch(() => null);
        if (!meta) { problems.push(`${from.name}: ticker ${symbol} was not found.`); continue; }
        to = { kind: 'security', currency: from.currency, ...meta, id: instruments.some(i => i.id === symbol) ? `${symbol}.yahoo` : symbol, source: { provider: 'yahoo', symbol } } as Instrument;
        instruments.push(to);
      }
      if (to.currency !== from.currency) problems.push(`${from.name} is in ${from.currency}, but ${symbol} trades in ${to.currency}.`);
      if (state.positions.some(p => p.instrument === to!.id)) problems.push(`${symbol} is already one of your holdings.`);
      if (pairs.some(p => p.to.id === to!.id)) problems.push(`${symbol} is assigned to more than one holding.`);
      pairs.push({ from, to });
    }
    if (problems.length) throw new Error(problems.join(' '));

    const histories = new Map<string, Series>();
    await Promise.all(pairs.map(async p => histories.set(p.to.id, await yahoo.history!(p.to.source!.symbol, HISTORY_FROM).then(h => h.series).catch(() => []))));
    let transactions = d.transactions;
    for (const p of pairs) transactions = relinkTransactions(transactions, p.from.id, p.to.id, cost => lastDateAtPrice(histories.get(p.to.id) ?? [], cost));

    const autoBackup = await store.keepBackup('before-link');
    const gone = new Set(pairs.map(p => p.from.id));
    const finalInstruments = instruments.filter(i => !gone.has(i.id));
    try {
      await store.put('instruments', [...instruments]);
      const draft: Data = { ...d, instruments: finalInstruments, transactions };
      await refresh(store, reg, { ...draft, instruments: pairs.map(p => p.to), settings: { ...d.settings, benchmark: undefined } }).catch(() => []);
      const market = new Market(await store.snapshot(draft), finalInstruments, transactions);
      const movedTo = new Set(pairs.map(p => p.to.id));
      const priced = transactions.map(t => {
        if (t.type !== 'adjust' || !t.instrument || !movedTo.has(t.instrument)) return t;
        const px = market.price(t.instrument, t.date);
        return px === undefined ? t : { ...t, flowPrice: px };
      });
      const next: Data = { ...draft, transactions: priced };
      try { buildReport(next, await store.snapshot(next), today(), false); }
      catch (e) { throw new Error(`Nothing was linked: ${(e as Error).message}`); }
      await store.put('transactions', priced);
      await store.put('instruments', finalInstruments);
      for (const id of gone) await store.removeInstrumentFiles(id);
      const ids = await store.securityIds();
      for (const p of pairs) ids.confirmed[p.from.id] = p.to.source!.symbol;
      await store.putSecurityIds(ids);
    } catch (e) { await store.put('instruments', d.instruments); await store.put('transactions', d.transactions); throw e; }
    return { linked: pairs.length, autoBackup };
  });

  app.get('/api/targets/previous', async () => ({ targets: await store.previousTargets() }));

  app.post<{ Body: { profile: string; tilt: string } }>('/api/targets/profile', async (req) => {
    const tilt = req.body?.tilt as EquityTilt;
    if (!(tilt in EQUITY_TILTS)) throw new Error('Unknown stock region option.');
    let rules;
    if (req.body?.profile === 'previous') {
      rules = (await store.previousTargets())?.rules;
      if (!rules) throw new Error('There are no previous targets to restore.');
    } else rules = profileRules(req.body?.profile, tilt);
    const autoBackup = await store.keepBackup('before-profile');
    const d = await store.data();
    await store.put('targets', { ...d.targets, rules });
    return { autoBackup };
  });
}
