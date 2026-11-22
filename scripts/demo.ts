/**
 * Seed a demo data dir with synthetic prices (offline). Usage:
 *   PETF_DATA=./demo-data npx tsx scripts/demo.ts && PETF_DATA=./demo-data npm run server
 */
import path from 'node:path';
import { classify } from '../src/providers/classify.js';
import { Store } from '../src/server/store.js';
import { DEFAULT_SETTINGS, type Data, type Series } from '../src/core/types.js';

const dir = process.env.PETF_DATA ?? path.resolve('demo-data');
const store = new Store(dir);
const start = Date.parse('2025-06-02');
const days = Math.floor((Date.now() - start) / 864e5);
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
const iso = (i: number) => new Date(start + i * 864e5).toISOString().slice(0, 10);

/** correlated GBM: common market factor + idiosyncratic */
const market = Array.from({ length: days }, gauss);
function gbm(p0: number, mu: number, vol: number, beta: number, weekends = false): Series {
  const s: Series = []; let p = p0;
  for (let i = 0; i < days; i++) {
    const dow = new Date(start + i * 864e5).getUTCDay();
    if (!weekends && (dow === 0 || dow === 6)) continue;
    p *= Math.exp(mu / 252 - vol ** 2 / 504 + (vol / Math.sqrt(252)) * (beta * market[i] + Math.sqrt(1 - beta ** 2) * gauss()));
    s.push([iso(i), +p.toFixed(4)]);
  }
  return s;
}

const data: Data = {
  accounts: [
    { id: 'ibkr', name: 'Interactive Brokers', currency: 'USD', taxStatus: 'taxable' },
    { id: 'leumi', name: 'Leumi Trade', currency: 'ILS', taxStatus: 'taxable' },
    { id: 'hishtalmut', name: 'Keren Hishtalmut', currency: 'ILS', taxStatus: 'exempt' },
    { id: 'wallet', name: 'Crypto wallet', currency: 'USD', taxStatus: 'taxable' },
  ],
  instruments: [
    { id: 'VOO', name: 'Vanguard S&P 500 ETF', kind: 'security', currency: 'USD', source: { provider: 'yahoo', symbol: 'VOO' } },
    { id: 'VWO', name: 'Vanguard FTSE Emerging Markets ETF', kind: 'security', currency: 'USD', source: { provider: 'yahoo', symbol: 'VWO' } },
    { id: 'BND', name: 'Vanguard Total Bond Market ETF', kind: 'security', currency: 'USD', source: { provider: 'yahoo', symbol: 'BND' } },
    { id: 'GLD', name: 'SPDR Gold Shares', kind: 'security', currency: 'USD', source: { provider: 'yahoo', symbol: 'GLD' } },
    { id: 'DBC', name: 'Invesco DB Commodity Index', kind: 'security', currency: 'USD', source: { provider: 'yahoo', symbol: 'DBC' } },
    { id: 'TA125', name: 'קסם מחקה ת"א 125', kind: 'manual', currency: 'ILS', source: { provider: 'manual', symbol: 'TA125' }, tradable: true },
    { id: 'GOVIL', name: 'אג"ח ממשלתי שקלי', kind: 'manual', currency: 'ILS', source: { provider: 'manual', symbol: 'GOVIL' }, tradable: true },
    { id: 'BTC', name: 'Bitcoin', kind: 'crypto', currency: 'USD', source: { provider: 'coingecko', symbol: 'bitcoin' }, excluded: true },
    { id: 'MORTGAGE', name: 'Mortgage', kind: 'debt', currency: 'ILS' },
  ],
  transactions: [
    { id: 'd1', date: '2025-06-02', type: 'deposit', account: 'ibkr', amount: 90000, currency: 'USD' },
    { id: 'b1', date: '2025-06-03', type: 'buy', account: 'ibkr', instrument: 'VOO', qty: 80, price: 0, fees: 1 },
    { id: 'b2', date: '2025-06-03', type: 'buy', account: 'ibkr', instrument: 'VWO', qty: 300, price: 0, fees: 1 },
    { id: 'b3', date: '2025-06-03', type: 'buy', account: 'ibkr', instrument: 'BND', qty: 150, price: 0, fees: 1 },
    { id: 'b4', date: '2025-06-03', type: 'buy', account: 'ibkr', instrument: 'GLD', qty: 12, price: 0, fees: 1 },
    { id: 'b5', date: '2026-02-10', type: 'buy', account: 'ibkr', instrument: 'VOO', qty: 20, price: 0, fees: 1 },
    { id: 'o1', date: '2025-06-02', type: 'open', account: 'hishtalmut', instrument: 'TA125', qty: 600, price: 0 },
    { id: 'o2', date: '2025-06-02', type: 'open', account: 'hishtalmut', instrument: 'GOVIL', qty: 400, price: 0 },
    { id: 'd2', date: '2025-06-02', type: 'deposit', account: 'leumi', amount: 15000, currency: 'ILS' },
    { id: 'd3', date: '2025-07-01', type: 'deposit', account: 'wallet', amount: 6000, currency: 'USD' },
    { id: 'c1', date: '2025-07-01', type: 'buy', account: 'wallet', instrument: 'BTC', qty: 0.05, price: 0 },
    { id: 'm1', date: '2025-06-02', type: 'borrow', account: 'leumi', instrument: 'MORTGAGE', amount: 400000 },
    { id: 'm1x', date: '2025-06-02', type: 'withdraw', account: 'leumi', amount: 400000, currency: 'ILS', note: 'house purchase' },
    { id: 'dv1', date: '2025-12-20', type: 'dividend', account: 'ibkr', instrument: 'VOO', amount: 280, currency: 'USD' },
  ],
  targets: (await store.data()).targets,
  settings: { ...DEFAULT_SETTINGS, benchmark: 'VOO' },
};

const series: Record<string, [Series, string]> = {
  VOO: [gbm(540, 0.09, 0.16, 0.95), 'USD'], VWO: [gbm(46, 0.06, 0.19, 0.7), 'USD'], BND: [gbm(72, 0.03, 0.06, 0.1), 'USD'],
  GLD: [gbm(300, 0.12, 0.15, 0.05), 'USD'], DBC: [gbm(22, 0.02, 0.18, 0.3), 'USD'], TA125: [gbm(25, 0.1, 0.17, 0.5), 'ILS'],
  GOVIL: [gbm(100, 0.035, 0.04, 0.05), 'ILS'], BTC: [gbm(105000, 0.2, 0.55, 0.3, true), 'USD'],
};
// set trade prices from the synthetic series
for (const t of data.transactions) if (t.price === 0) {
  const s = series[t.instrument!][0];
  t.price = (s.find(([d]) => d >= t.date) ?? s[0])[1];
}

const metas: Record<string, Parameters<typeof classify>[0]> = {
  VOO: { quoteType: 'ETF', name: 'Vanguard S&P 500 ETF', category: 'Large Blend', stockPosition: 0.996, cashPosition: 0.004, sectorWeightings: [{ technology: 0.33 }, { financial_services: 0.13 }, { healthcare: 0.1 }, { consumer_cyclical: 0.105 }, { communication_services: 0.095 }, { industrials: 0.08 }, { consumer_defensive: 0.055 }, { energy: 0.03 }, { realestate: 0.022 }, { utilities: 0.024 }, { basic_materials: 0.019 }] },
  VWO: { quoteType: 'ETF', name: 'Vanguard FTSE Emerging Markets ETF', category: 'Diversified Emerging Mkts', stockPosition: 0.98, cashPosition: 0.02, sectorWeightings: [{ technology: 0.24 }, { financial_services: 0.22 }, { consumer_cyclical: 0.13 }, { communication_services: 0.09 }, { industrials: 0.08 }, { basic_materials: 0.07 }, { energy: 0.05 }, { healthcare: 0.04 }] },
  BND: { quoteType: 'ETF', name: 'Vanguard Total Bond Market ETF', category: 'Intermediate Core Bond', bondPosition: 0.99, cashPosition: 0.01, bondRatings: [{ us_government: 0.69 }, { aaa: 0.04 }, { aa: 0.03 }, { a: 0.12 }, { bbb: 0.12 }] },
  GLD: { quoteType: 'ETF', name: 'SPDR Gold Shares', category: 'Commodities Focused', otherPosition: 1 },
  DBC: { quoteType: 'ETF', name: 'Invesco DB Commodity Index Tracking Fund', category: 'Commodities Broad Basket', otherPosition: 1 },
  TA125: { name: 'קסם מחקה ת"א 125' }, GOVIL: { name: 'אג"ח ממשלתי שקלי' }, BTC: { quoteType: 'CRYPTOCURRENCY' },
};

for (const c of ['accounts', 'instruments', 'transactions', 'targets', 'settings'] as const) await store.put(c, data[c]);
for (const [id, [s, ccy]] of Object.entries(series)) {
  if (data.instruments.find(i => i.id === id)?.kind === 'manual') await store.putManualPrice(id, { currency: ccy, series: s });
  else await store.putPrice(id, { currency: ccy, series: s });
  const e = classify(metas[id]);
  if (e) await store.putExposure(id, { ...e, asOf: new Date().toISOString().slice(0, 10) });
}
let fx = 3.7; const usdils: Series = [];
for (let i = 0; i < days; i++) { fx *= Math.exp(0.006 * gauss()); usdils.push([iso(i), +fx.toFixed(4)]); }
await store.putFx('USD/ILS', usdils);
console.log(`demo data written to ${dir}`);
