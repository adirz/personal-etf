import YahooFinance from 'yahoo-finance2';
import type { Series } from '../core/types.js';
import { classify } from './classify.js';
import type { Provider } from './types.js';

/** Sub-unit currencies Yahoo uses: TASE quotes in agorot (ILA), LSE in pence (GBp), JSE in cents (ZAc). */
const SUBUNIT: Record<string, [string, number]> = { ILA: ['ILS', 100], GBp: ['GBP', 100], GBX: ['GBP', 100], ZAc: ['ZAR', 100] };
export const normCcy = (c?: string): [string, number] => (c && SUBUNIT[c]) || [c ?? 'USD', 1];

export function yahooProvider(): Provider {
  const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] } as never);
  return {
    id: 'yahoo',
    label: 'Yahoo Finance (stocks, ETFs, funds, TASE via .TA, indices, crypto-USD)',
    kinds: ['security', 'crypto'],

    async search(q) {
      const r = await yf.search(q, { quotesCount: 12, newsCount: 0 } as never) as { quotes: Record<string, unknown>[] };
      return r.quotes.filter(x => x.isYahooFinance).map(x => ({
        provider: 'yahoo', symbol: String(x.symbol), name: String(x.longname ?? x.shortname ?? x.symbol),
        exchange: String(x.exchDisp ?? x.exchange ?? ''), type: String(x.quoteType ?? ''),
      }));
    },

    async describe(symbol) {
      const s = await yf.quoteSummary(symbol, { modules: ['price', 'quoteType'] }) as { price?: Record<string, unknown>; quoteType?: Record<string, unknown> };
      const [ccy] = normCcy(String(s.price?.currency ?? 'USD'));
      const qt = String(s.quoteType?.quoteType ?? '');
      return { name: String(s.price?.longName ?? s.price?.shortName ?? symbol), currency: ccy, kind: qt === 'CRYPTOCURRENCY' ? 'crypto' : 'security' };
    },

    async history(symbol, from) {
      const r = await yf.chart(symbol, { period1: from, interval: '1d' }) as { meta: { currency: string }; quotes: { date: Date; close: number | null }[] };
      const [ccy, div] = normCcy(r.meta.currency);
      // raw close (not adjusted): dividends are booked as cash transactions in the ledger
      const series: Series = r.quotes.filter(q => q.close != null).map(q => [q.date.toISOString().slice(0, 10), q.close! / div]);
      return { currency: ccy, series: dedupe(series) };
    },

    async exposure(symbol) {
      const s = await yf.quoteSummary(symbol, {
        modules: ['quoteType', 'price', 'fundProfile', 'topHoldings', 'assetProfile'],
      }).catch(() => null) as Record<string, Record<string, unknown> | undefined> | null;
      if (!s) return null;
      const th = s.topHoldings ?? {};
      const [ccy] = normCcy(String(s.price?.currency ?? ''));
      const spec = classify({
        quoteType: String(s.quoteType?.quoteType ?? ''),
        name: String(s.price?.longName ?? s.quoteType?.longName ?? ''),
        category: (s.fundProfile?.categoryName as string) ?? null,
        exchange: String(s.price?.exchange ?? s.quoteType?.exchange ?? ''),
        listingCurrency: ccy,
        stockPosition: th.stockPosition as number, bondPosition: th.bondPosition as number,
        cashPosition: th.cashPosition as number, otherPosition: th.otherPosition as number,
        preferredPosition: th.preferredPosition as number, convertiblePosition: th.convertiblePosition as number,
        sectorWeightings: th.sectorWeightings as Record<string, number>[],
        bondRatings: th.bondRatings as Record<string, number>[],
        sector: s.assetProfile?.sector as string, country: s.assetProfile?.country as string,
      });
      if (spec) { spec.source = `yahoo/${spec.source}`; spec.asOf = new Date().toISOString().slice(0, 10); }
      return spec;
    },
  };
}

export function dedupe(s: Series): Series {
  const m = new Map<string, number>();
  for (const [d, v] of s) m.set(d, v);
  return [...m].sort((a, b) => a[0].localeCompare(b[0]));
}
