import type { ISODate } from '../core/types.js';

export interface BrokerPosition {
  id: string;              // broker / TASE security number
  name: string;
  qty: number;
  price: number;           // per unit, whole currency (agorot already converted to shekels)
  cost: number;            // average cost per unit, same unit as price
  listedInIls: boolean;
  fxToIls: number;         // ILS per 1 unit of the position's currency, as used by the broker
  valueIls: number;
}
export interface BrokerExport {
  asOf?: ISODate;
  positions: BrokerPosition[];
  totalIls: number;
  /** Value the broker's portfolio-share column implies but the file doesn't list (negative = a liability). */
  unlistedIls?: number;
  warnings: string[];
}

const COLUMNS = { name: 'שם נייר', id: 'מספר נייר', price: 'שער אחרון', qty: 'כמות בתיק', valueIls: 'שווי אחזקה (₪)', value: 'שווי במטבע', cost: 'שער עלות', share: 'נתח מהתיק' } as const;
const REQUIRED = ['name', 'id', 'price', 'qty', 'valueIls', 'value', 'cost'] as const;
const UNLISTED_MIN_PP = 1;      // the share column is rounded, so ignore small gaps

const number = (s: string | undefined) => {
  const v = Number(String(s ?? '').replace(/[,%₪\s]/g, ''));
  return s === undefined || s === '' || !Number.isFinite(v) ? undefined : v;
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * Math.max(Math.abs(b), 1e-9);

function dataDate(rows: string[][]): ISODate | undefined {
  for (const row of rows) for (const cell of row) {
    if (!cell.includes('תאריך נכונות')) continue;
    const m = cell.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return undefined;
}

/** Parse the broker's "יתרות מקוונות" holdings export. The account number in the file is deliberately not kept. */
export function parseBrokerExport(rows: string[][]): BrokerExport {
  const headerAt = rows.findIndex(r => r.includes(COLUMNS.name) && r.includes(COLUMNS.qty));
  if (headerAt < 0) throw new Error('Could not find the holdings table. Expected columns like "שם נייר" and "כמות בתיק".');
  const header = rows[headerAt];
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, title]) => [k, header.indexOf(title)])) as Record<keyof typeof COLUMNS, number>;
  const missing = REQUIRED.filter(k => col[k] < 0).map(k => COLUMNS[k]);
  if (missing.length) throw new Error(`The file is missing these columns: ${missing.join(', ')}`);

  const positions: BrokerPosition[] = [];
  const warnings: string[] = [];
  let shareSum = 0, hasShares = false;
  for (const r of rows.slice(headerAt + 1)) {
    const name = r[col.name], id = r[col.id];
    if (!name || !id) continue;
    const [price, qty, valueIls, value, cost] = [col.price, col.qty, col.valueIls, col.value, col.cost].map(i => number(r[i]));
    if (price === undefined || qty === undefined || valueIls === undefined || value === undefined || cost === undefined) {
      warnings.push(`Skipped ${name}: missing numbers.`);
      continue;
    }
    if (qty === 0) continue;
    if (qty < 0 || price <= 0) { warnings.push(`Skipped ${name}: unexpected quantity or price.`); continue; }
    const scale = value / (price * qty);
    let unit: number;
    if (near(scale, 0.01, 0.02)) unit = 0.01;         // quoted in agorot
    else if (near(scale, 1, 0.02)) unit = 1;
    else { warnings.push(`Skipped ${name}: price, quantity and value don't agree.`); continue; }
    const fxToIls = value ? valueIls / value : 1;
    positions.push({
      id, name, qty, price: price * unit, cost: cost * unit,
      listedInIls: unit === 0.01 || near(fxToIls, 1, 0.001), fxToIls, valueIls,
    });
    const share = col.share >= 0 ? number(r[col.share]) : undefined;
    if (share !== undefined) { shareSum += share; hasShares = true; }
  }
  if (!positions.length) throw new Error('No holdings were found in the file.');
  const totalIls = positions.reduce((s, p) => s + p.valueIls, 0);
  const unlistedIls = hasShares && shareSum > 0 && Math.abs(shareSum - 100) >= UNLISTED_MIN_PP ? (totalIls * 100) / shareSum - totalIls : undefined;
  return { asOf: dataDate(rows), positions, totalIls, unlistedIls, warnings };
}

/** Pick the currency whose ILS rate is closest to the broker's rate. */
export function inferCurrency(fxToIls: number, rates: Record<string, number>, tolerance = 0.03): string | undefined {
  let best: string | undefined, gap = tolerance;
  for (const [ccy, rate] of Object.entries(rates)) {
    const d = Math.abs(fxToIls / rate - 1);
    if (d <= gap) { best = ccy; gap = d; }
  }
  return best;
}
