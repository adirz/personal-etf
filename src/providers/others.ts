import type { Series } from '../core/types.js';
import { classify } from './classify.js';
import { getJSON, type FxProvider, type Provider } from './types.js';
import { dedupe } from './yahoo.js';

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** CoinGecko — crypto. Set COINGECKO_API_KEY for the demo/pro tier (free tier: 365 days of history). */
export function coingeckoProvider(): Provider {
  const key = process.env.COINGECKO_API_KEY;
  const root = process.env.COINGECKO_PRO ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
  const h: Record<string, string> = key ? { [process.env.COINGECKO_PRO ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key']: key } : {};
  return {
    id: 'coingecko', label: 'CoinGecko (crypto)', kinds: ['crypto'],
    async search(q) {
      const r = await getJSON<{ coins: { id: string; name: string; symbol: string }[] }>(`${root}/search?query=${encodeURIComponent(q)}`, h);
      return r.coins.slice(0, 10).map(c => ({ provider: 'coingecko', symbol: c.id, name: `${c.name} (${c.symbol.toUpperCase()})`, type: 'CRYPTOCURRENCY', currency: 'USD' }));
    },
    async describe(symbol) {
      const r = await getJSON<{ name: string; symbol: string }>(`${root}/coins/${symbol}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`, h);
      return { name: r.name, currency: 'USD', kind: 'crypto' };
    },
    async history(symbol, from) {
      const days = Math.min(key ? 3650 : 365, Math.max(2, Math.ceil((Date.now() - Date.parse(from)) / 864e5) + 1));
      const r = await getJSON<{ prices: [number, number][] }>(`${root}/coins/${symbol}/market_chart?vs_currency=usd&days=${days}&interval=daily`, h);
      return { currency: 'USD', series: dedupe(r.prices.map(([t, p]) => [day(t), p] as [string, number])) };
    },
    async exposure() { return classify({ quoteType: 'CRYPTOCURRENCY' }); },
  };
}

/** Manual / CSV instruments (Israeli mutual funds, real estate, private holdings, pensions...).
 *  Prices come from 'valuation' transactions or an uploaded CSV; classification from name heuristics. */
export function manualProvider(): Provider {
  return {
    id: 'manual', label: 'Manual entry / CSV upload', kinds: ['manual', 'security'],
    async exposure(name) { return classify({ name }); },
  };
}

/** Frankfurter (ECB reference rates, includes ILS). Swap for a Bank of Israel provider if you need
 *  the official representative rate for tax filings. */
export function frankfurterFx(): FxProvider {
  const ECB = new Set('AUD BGN BRL CAD CHF CNY CZK DKK EUR GBP HKD HUF IDR ILS INR ISK JPY KRW MXN MYR NOK NZD PHP PLN RON SEK SGD THB TRY USD ZAR'.split(' '));
  return {
    id: 'frankfurter',
    supports: c => ECB.has(c),
    async history(base, quote, from) {
      const r = await getJSON<{ rates: Record<string, Record<string, number>> }>(`https://api.frankfurter.dev/v1/${from}..?base=${base}&symbols=${quote}`);
      const s: Series = Object.entries(r.rates).map(([d, m]) => [d, m[quote]]);
      return dedupe(s);
    },
  };
}

/** Parse "date,price" CSV (also accepts dd/mm/yyyy and ; separators — common in Israeli exports). */
export function parsePriceCsv(text: string): Series {
  const out: Series = [];
  for (const line of text.split(/\r?\n/)) {
    const sep = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ',';
    const parts = (line.match(new RegExp(`("[^"]*"|[^${sep}]+)`, 'g')) ?? []).map(s => s.trim().replace(/^"|"$/g, ''));
    if (parts.length < 2) continue;
    let d = parts[0];
    const m = d.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (m) d = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const v = parseFloat(parts[1].replace(/[^\d.\-]/g, ''));
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(v)) out.push([d, v]);
  }
  return dedupe(out);
}
