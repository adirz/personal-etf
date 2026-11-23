import { GLOBES_PREFIX } from '../providers/globes.js';
import type { SearchHit } from '../providers/types.js';
import type { BrokerPosition } from './broker.js';

export const MANUAL = 'manual';

/** What the app knows for certain about securities, kept between imports. */
export interface SecurityIds {
  confirmed: Record<string, string>;     // broker security number → ticker
  tradeNames: Record<string, string[]>;  // normalised name from trade history → tickers
}
export const emptySecurityIds = (): SecurityIds => ({ confirmed: {}, tradeNames: {} });

export type Resolution = { symbol?: string; via: 'confirmed' | 'isin' | 'globes' | 'trades' | 'directory' | 'none' };

/** ISIN of a security registered in Israel: IL + 9-digit TASE number + Luhn check digit. */
export function israeliIsin(securityNumber: string): string | undefined {
  if (!/^\d{1,9}$/.test(securityNumber)) return undefined;
  const body = `IL${securityNumber.padStart(9, '0')}`;
  const digits = [...body].map(c => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55))).join('');
  let sum = 0, double = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    double = !double;
  }
  return body + String((10 - (sum % 10)) % 10);
}

const NOT_IDENTIFYING = new Set(['INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED', 'PLC', 'THE',
  'COMMON', 'STOCK', 'SHARES', 'SHARE', 'CLASS', 'CL', 'A', 'ORDINARY', 'DEPOSITARY', 'AMERICAN', 'ADS', 'ADR', 'SP']);

/** Same name apart from punctuation, legal form and share class. Words are never expanded or approximated. */
export function normalizeName(name: string) {
  return name.toUpperCase().split(' - ')[0].replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/).filter(w => w && !NOT_IDENTIFYING.has(w)).join(' ');
}

/** Parse Nasdaq Trader's nasdaqlisted.txt / otherlisted.txt into normalised name → tickers. */
export function parseSymbolDirectory(text: string, into = new Map<string, Set<string>>()) {
  const lines = text.split(/\r?\n/);
  const head = lines[0].split('|');
  const symbol = head.includes('NASDAQ Symbol') ? head.indexOf('NASDAQ Symbol') : head.indexOf('Symbol');
  const name = head.indexOf('Security Name'), test = head.indexOf('Test Issue');
  if (symbol < 0 || name < 0 || test < 0) return into;
  for (const line of lines.slice(1)) {
    const p = line.split('|');
    if (p.length <= test || p[test] !== 'N') continue;
    const key = normalizeName(p[name]);
    if (!into.has(key)) into.set(key, new Set());
    into.get(key)!.add(p[symbol]);
  }
  return into;
}

export interface ResolveDeps {
  ids: SecurityIds;
  directory: Map<string, Set<string>>;
  searchIsin(isin: string): Promise<SearchHit[]>;
  globesHas(securityNumber: string): Promise<boolean>;
}

/** Identify a broker row from identifiers or an exact, unique name. If that fails it stays unresolved. */
export async function resolvePosition(p: BrokerPosition, deps: ResolveDeps): Promise<Resolution> {
  const confirmed = deps.ids.confirmed[p.id];
  if (confirmed && confirmed !== MANUAL) return { symbol: confirmed, via: 'confirmed' };

  if (p.listedInIls) {
    const isin = israeliIsin(p.id);
    if (!isin) return { via: 'none' };
    const hits = (await deps.searchIsin(isin).catch(() => [] as SearchHit[])).filter(h => h.symbol.endsWith('.TA'));
    if (hits.length === 1) return { symbol: hits[0].symbol, via: 'isin' };
    return (await deps.globesHas(p.id).catch(() => false)) ? { symbol: `${GLOBES_PREFIX}${p.id}`, via: 'globes' } : { via: 'none' };
  }

  const key = normalizeName(p.name);
  const traded = deps.ids.tradeNames[key];
  if (traded?.length === 1) return { symbol: traded[0], via: 'trades' };
  if (traded?.length) return { via: 'none' };
  const listed = deps.directory.get(key);
  return listed?.size === 1 ? { symbol: [...listed][0], via: 'directory' } : { via: 'none' };
}
