import type { Data } from '../core/types.js';
import type { Registry } from '../providers/registry.js';
import { mergeSeries, type Store } from './store.js';

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(Date.now() - n * 864e5);
const EXPOSURE_TTL_DAYS = 7;

/** Pull prices, FX and look-through exposures for everything in the portfolio. Never throws per item. */
export async function refresh(store: Store, reg: Registry, data: Data, opts: { force?: boolean } = {}) {
  const log: { item: string; ok: boolean; msg: string }[] = [];
  const firstTx = data.transactions.map(t => t.date).sort()[0] ?? daysAgo(365);
  const start = iso(Math.min(Date.parse(firstTx) - 10 * 864e5, Date.now() - 400 * 864e5)); // ≥ ~1y for risk stats

  const pull = async (id: string, provider: string, symbol: string) => {
    const p = reg.get(provider);
    if (p.history) {
      try {
        const cached = await store.price(id);
        const last = cached?.series.at(-1)?.[0];
        const from = !opts.force && last && cached!.series[0][0] <= start ? iso(Date.parse(last) - 7 * 864e5) : start;
        const h = await p.history(symbol, from);
        await store.putPrice(id, { currency: h.currency, series: mergeSeries(opts.force ? [] : cached?.series ?? [], h.series) });
        log.push({ item: `price ${id}`, ok: true, msg: `${h.series.length} pts from ${from}` });
      } catch (e) { log.push({ item: `price ${id}`, ok: false, msg: String(e) }); }
    }
  };

  for (const i of data.instruments) {
    if (i.kind === 'cash' || i.kind === 'debt') continue;
    const prov = i.source?.provider ?? 'manual';
    if (i.source && prov !== 'manual') await pull(i.id, prov, i.source.symbol);
    // look-through exposure
    const p = reg.providers.get(prov);
    if (!p?.exposure || i.exposureOverride) continue;
    const cached = await store.exposure(i.id);
    const stale = !cached?.asOf || Date.parse(cached.asOf) < Date.now() - EXPOSURE_TTL_DAYS * 864e5;
    if (!opts.force && cached && !stale) continue;
    try {
      const e = await p.exposure(prov === 'manual' ? (i.name ?? i.id) : i.source!.symbol);
      if (e) { e.asOf ??= iso(Date.now()); await store.putExposure(i.id, e); log.push({ item: `exposure ${i.id}`, ok: true, msg: e.source ?? '' }); }
      else log.push({ item: `exposure ${i.id}`, ok: false, msg: 'not classifiable — set an override' });
    } catch (err) { log.push({ item: `exposure ${i.id}`, ok: false, msg: String(err) }); }
  }

  // benchmark (if not itself an instrument)
  const bench = data.settings.benchmark;
  if (bench && !data.instruments.some(i => i.id === bench)) await pull(bench, 'yahoo', bench);

  // FX: every currency we hold or price in, against base and tax currency
  const ccys = new Set<string>();
  for (const i of data.instruments) ccys.add(i.currency);
  for (const t of data.transactions) { if (t.currency) ccys.add(t.currency); if (t.toCurrency) ccys.add(t.toCurrency); }
  for (const a of data.accounts) ccys.add(a.currency);
  const targets = new Set([data.settings.baseCurrency, data.settings.tax.currency]);
  const pairs = new Set<string>();
  for (const c of ccys) for (const q of targets) if (c !== q) pairs.add(`${c}/${q}`);
  for (const pair of pairs) {
    const [b, q] = pair.split('/');
    const fx = reg.fxFor(b, q);
    if (!fx) { log.push({ item: `fx ${pair}`, ok: false, msg: 'no FX provider supports this pair' }); continue; }
    try {
      const cached = (await store.fx(pair)) ?? [];
      const from = !opts.force && cached.length && cached[0][0] <= start ? iso(Date.parse(cached.at(-1)![0]) - 7 * 864e5) : start;
      const s = await fx.history(b, q, from);
      await store.putFx(pair, mergeSeries(cached, s));
      log.push({ item: `fx ${pair}`, ok: true, msg: `${s.length} pts` });
    } catch (e) { log.push({ item: `fx ${pair}`, ok: false, msg: String(e) }); }
  }
  return log;
}
