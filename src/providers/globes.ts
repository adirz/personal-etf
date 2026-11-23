import type { ExposureSpec, Series } from '../core/types.js';
import type { Provider } from './types.js';
import { dedupe } from './yahoo.js';

const BASE = 'https://www.globes.co.il';
const USER_AGENT = 'personal-etf/0.1';
const REQUEST_GAP_MS = 300;
const TIMEOUT_MS = 20_000;
const AGOROT = 100;
const STOCK_LIST_TTL_MS = 24 * 3600_000;

export const GLOBES_PREFIX = 'globes:';

export interface GlobesFundInfo { category: string; stockBand: string; fxBand: string }
export interface GlobesSecurity { number: string; instrumentId: string; typeId: string; name: string; englishName: string; fund?: GlobesFundInfo }

/** Israeli funds publish an exposure ceiling. Only bands up to 50% are read, since higher ones can be leveraged. */
const EXPOSURE_CEILING: Record<string, number> = { 0: 0, 1: 0.1, 2: 0.3, 3: 0.5, A: 0.1, B: 0.3, C: 0.5 };

/** Classify a bond fund from its official category. Other categories are left for the user. */
export function classifyGlobesFund(f: GlobesFundInfo): ExposureSpec | null {
  const stock = EXPOSURE_CEILING[f.stockBand], fx = EXPOSURE_CEILING[f.fxBand];
  if (stock === undefined || fx === undefined || !f.category.startsWith('אג"ח')) return null;
  const region: Record<string, Record<string, number>> = f.category.includes('בארץ') ? { region: { Israel: 1 } } : {};
  const government = f.category.includes('מדינה');
  const corporate = f.category.includes('חברות') || f.category.includes('קונצרני');
  const bondDims: Record<string, Record<string, number>> = {
    ...region,
    ...(government ? { bondType: { government: 1 }, credit: { government: 1 } } : corporate ? { bondType: { corporate: 1 } } : {}),
  };
  const classes: ExposureSpec['classes'] = { bond: { weight: 1 - stock, dims: bondDims } };
  if (stock > 0) classes.equity = { weight: stock, dims: { ...region } };
  return { classes, dims: { currency: fx > 0 ? { ILS: 1 - fx, other: fx } : { ILS: 1 } }, source: 'globes:category' };
}
export type GlobesProvider = Provider & { lookup(securityNumber: string): Promise<GlobesSecurity | null> };

const decode = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();

/** Security number → Globes instrument id, from the TASE stock table. */
export function parseStockTable(html: string) {
  const out = new Map<string, { instrumentId: string; name: string }>();
  for (const m of html.matchAll(/data-symbol="(\d+)">\s*<td[^>]*class="qName"[^>]*>\s*<a[^>]*instrumentid=(\d+)"[^>]*title="([^"]*)"/g)) {
    out.set(m[1], { instrumentId: m[2], name: decode(m[3]) });
  }
  return out;
}

/** Read an instrument page. Returns null unless the page states this exact security number. */
export function parseInstrumentPage(html: string, securityNumber: string) {
  if (html.match(/id="symbol">\s*([^<]*?)\s*</)?.[1] !== securityNumber) return null;
  return {
    typeId: html.match(/id="instypeid"[^>]*value="([^"]*)"/)?.[1] ?? '',
    englishName: decode(html.match(/enName secName">([^<]*)/)?.[1] ?? ''),
  };
}

const israelDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Graph rows are [time, open, high, low, close, volume], quoted in agorot, with times at Israeli midnight. */
export function parseGraph(json: { data?: number[][] | null }, from: string): Series {
  const series: Series = (json.data ?? [])
    .filter(r => Number.isFinite(r[4]) && r[4] > 0)
    .map(r => [israelDate.format(new Date(r[0])), r[4] / AGOROT] as [string, number])
    .filter(([d]) => d >= from);
  return dedupe(series);
}

export function globesProvider(): GlobesProvider {
  const known = new Map<string, GlobesSecurity | null>();
  let stocks: { at: number; table: ReturnType<typeof parseStockTable> } | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  /** One request at a time, spaced out, so the site isn't loaded by a refresh. */
  const request = (path: string, body?: string) => {
    const run = async () => {
      const r = await fetch(`${BASE}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'user-agent': USER_AGENT, ...(body ? { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}) },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`Globes returned ${r.status}`);
      const text = await r.text();
      await new Promise(done => setTimeout(done, REQUEST_GAP_MS));
      return text;
    };
    const result = queue.then(run, run);
    queue = result.catch(() => undefined);
    return result;
  };

  const fundBySymbol = async (n: string) => {
    const q = new URLSearchParams({ fid: '4006', action: 'fundsearch', mode: 'base', fundname: '', symbol: n, managerid: '0', fundValueMin: '0', fundValueMax: 'max', fundTax: 'all', KoteretAlId: '0', KoteretMainId: '0', KoteretMishnitId: '0', Hasifa: '66', HasifaStock: '6', HasifaMatah: '6' });
    const j = JSON.parse(await request(`/portal/funds/fundscontrols/getfundssearchresultsjson.ashx?${q}`)) as { fundsList?: { symbol: string; instrumentID: string; fundName: string; KoteretAlName: string; hasifaStock: string; hasifaMatah: string }[] };
    const exact = (j.fundsList ?? []).filter(f => f.symbol === n);
    if (exact.length !== 1) return undefined;
    const f = exact[0];
    return { instrumentId: f.instrumentID, name: decode(f.fundName), fund: { category: decode(f.KoteretAlName), stockBand: f.hasifaStock, fxBand: f.hasifaMatah } };
  };
  const stockByNumber = async (n: string) => {
    if (!stocks || Date.now() - stocks.at > STOCK_LIST_TTL_MS) stocks = { at: Date.now(), table: parseStockTable(await request('/portal/quotes/stocks/?showAll=true')) };
    return stocks.table.get(n);
  };

  const lookup: GlobesProvider['lookup'] = async n => {
    if (!/^\d{5,9}$/.test(n)) return null;
    if (known.get(n)) return known.get(n)!;
    try {
      const hit: { instrumentId: string; name: string; fund?: GlobesFundInfo } | undefined = (await stockByNumber(n)) ?? (await fundBySymbol(n));
      const page = hit ? parseInstrumentPage(await request(`/portal/instrument.aspx?instrumentid=${hit.instrumentId}`), n) : null;
      const found = hit && page?.typeId ? { number: n, instrumentId: hit.instrumentId, typeId: page.typeId, name: hit.name, englishName: page.englishName, fund: hit.fund } : null;
      if (found) known.set(n, found);
      return found;
    } catch { return null; }
  };

  return {
    id: 'globes',
    label: 'Globes (TASE stocks and Israeli mutual funds, by security number)',
    kinds: ['security'],
    lookup,
    async describe(n) {
      const s = await lookup(n);
      if (!s) throw new Error(`Globes has no security ${n}`);
      return { name: s.name, currency: 'ILS', kind: 'security', fractional: true, tradable: true };
    },
    async history(n, from) {
      const s = await lookup(n);
      if (!s) throw new Error(`Globes has no security ${n}`);
      const body = new URLSearchParams({ symbol: `${s.instrumentId}|0|${n}`, instrumentId: n, feeder: '0', isRealTime: '0', f: '0', start: '0', end: String(Date.now()), top: '', resolution: '', source: '2', type: 'all', instrumentTypeId: s.typeId, userId: '0', secret: '' });
      return { currency: 'ILS', series: parseGraph(JSON.parse(await request('/portal/Handlers/GTOGraph.ashx', body.toString())), from) };
    },
    async exposure(n) {
      const s = await lookup(n);
      return s?.fund ? classifyGlobesFund(s.fund) : null;
    },
  };
}
