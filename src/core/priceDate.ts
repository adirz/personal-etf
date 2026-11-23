import type { ISODate, Series } from './types.js';

/**
 * The most recent date the asset traded at `price`: the latest point where the close equals it or
 * crosses it between two days (taking the closer day). If it never got there, the day it came closest.
 */
export function lastDateAtPrice(series: Series, price: number): ISODate | undefined {
  if (!series.length || !(price > 0)) return undefined;
  for (let i = series.length - 1; i >= 0; i--) {
    const [date, close] = series[i];
    if (close === price) return date;
    if (i === 0) break;
    const [prevDate, prev] = series[i - 1];
    if ((prev - price) * (close - price) < 0) return Math.abs(prev - price) < Math.abs(close - price) ? prevDate : date;
  }
  let best = series[series.length - 1];
  for (let i = series.length - 1; i >= 0; i--) if (Math.abs(series[i][1] - price) < Math.abs(best[1] - price)) best = series[i];
  return best[0];
}
