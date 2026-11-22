import type { Ccy, ExposureSpec, ISODate, Instrument, Series } from '../core/types.js';

export interface SearchHit { provider: string; symbol: string; name: string; exchange?: string; type?: string; currency?: Ccy }

/**
 * A data source plugin. Implement any subset; the registry routes by `instrument.source.provider`.
 * To add a source: implement this interface in src/providers/<name>.ts and register it in registry.ts.
 */
export interface Provider {
  id: string;
  label: string;
  kinds: Instrument['kind'][];                                   // what it can price
  search?(q: string): Promise<SearchHit[]>;
  describe?(symbol: string): Promise<Partial<Instrument>>;      // name, currency, kind
  history?(symbol: string, from: ISODate): Promise<{ currency: Ccy; series: Series }>;
  exposure?(symbol: string): Promise<ExposureSpec | null>;      // look-through classification
}

export interface FxProvider {
  id: string;
  /** Units of `quote` per 1 `base`, daily from `from`. */
  history(base: Ccy, quote: Ccy, from: ISODate): Promise<Series>;
  supports(ccy: Ccy): boolean;
}

export async function getJSON<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(url, { headers: { accept: 'application/json', ...headers } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} ← ${url}`);
  return r.json() as Promise<T>;
}
