/**
 * Automatic look-through classification. Pure functions over provider metadata, so they are
 * testable offline and reusable by any provider that can supply the same fields.
 */
import type { ExposureSpec } from '../core/types.js';

export interface FundMeta {
  quoteType?: string;           // ETF | EQUITY | MUTUALFUND | CRYPTOCURRENCY | ...
  name?: string;
  category?: string | null;     // Morningstar category, e.g. "Large Blend"
  exchange?: string;            // e.g. "TLV"
  listingCurrency?: string;
  stockPosition?: number; bondPosition?: number; cashPosition?: number; otherPosition?: number;
  preferredPosition?: number; convertiblePosition?: number;
  sectorWeightings?: Record<string, number>[];
  bondRatings?: Record<string, number>[];
  sector?: string;              // single stock
  country?: string;             // single stock
}

/** Rough cap-weighted split of a "global" fund, used when only the label is known. Tunable. */
export const GLOBAL_SPLIT = { US: 0.63, developed_ex_us: 0.26, emerging: 0.11 };
const REGION_CCY: Record<string, string> = { US: 'USD', Israel: 'ILS', developed_ex_us: 'other_developed', emerging: 'emerging' };

const SECTOR_KEYS: Record<string, string> = {
  realestate: 'real_estate', real_estate: 'real_estate', 'real estate': 'real_estate',
  consumer_cyclical: 'consumer_cyclical', 'consumer cyclical': 'consumer_cyclical',
  basic_materials: 'basic_materials', 'basic materials': 'basic_materials',
  consumer_defensive: 'consumer_defensive', 'consumer defensive': 'consumer_defensive',
  technology: 'technology', communication_services: 'communication_services', 'communication services': 'communication_services',
  financial_services: 'financial_services', 'financial services': 'financial_services', financial: 'financial_services',
  utilities: 'utilities', industrials: 'industrials', energy: 'energy', healthcare: 'healthcare',
};
const CREDIT_KEYS: Record<string, string> = {
  us_government: 'government', aaa: 'AAA', aa: 'AA', a: 'A', bbb: 'BBB', bb: 'BB', b: 'B', below_b: 'below_B', other: 'not_rated',
};

const flat = (arr?: Record<string, number>[]) => Object.assign({}, ...(arr ?? []).map(o => Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'number'))));
const remap = (m: Record<string, number>, keys: Record<string, string>) => {
  const o: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) { const kk = keys[k.toLowerCase()] ?? k.toLowerCase(); o[kk] = (o[kk] ?? 0) + v; }
  return o;
};

const COUNTRY_REGION = (c?: string): string | undefined => {
  if (!c) return undefined;
  if (/united states|usa/i.test(c)) return 'US';
  if (/israel/i.test(c)) return 'Israel';
  if (/china|india|brazil|taiwan|korea|mexico|indonesia|south africa|saudi|thailand|malaysia|turkey|poland|chile|philippines|vietnam|argentina|colombia|peru|egypt|qatar|uae|united arab/i.test(c)) return 'emerging';
  return 'developed_ex_us';
};

/** Region from Morningstar category, then from name keywords (English + Hebrew). */
export function regionOf(m: FundMeta): Record<string, number> | undefined {
  const cat = m.category ?? '', name = m.name ?? '';
  const t = `${cat} | ${name}`;
  if (/israel|tel[- ]aviv|\bTA[- ]?(35|90|125)\b|ת"?א|תל[- ]אביב|ישראל|שקל/i.test(t)) return { Israel: 1 };
  if (/emerging|china|india|latin america|pacific\/asia ex-japan|diversified emerging|EM\b|שווקים מתעוררים/i.test(t)) return { emerging: 1 };
  if (/foreign|international|developed|EAFE|ex[- ]us|europe|japan|אירופה|יפן/i.test(t)) return { developed_ex_us: 1 };
  if (/world|global|all[- ]world|ACWI|total international|עולמי|MSCI World/i.test(t)) return { ...GLOBAL_SPLIT };
  if (/s&p|nasdaq|נאסד"?ק|russell|dow|total (stock )?market|\bUS\b|U\.S\.|large (blend|growth|value)|mid-cap|small (blend|growth|value)|intermediate|long government|short government|short-term bond|ultrashort|high yield|corporate bond|inflation-protected|muni|technology|health|financial|real estate|communications|consumer|industrials|utilities|equity energy|natural resources|ארה"?ב/i.test(t)) return { US: 1 };
  if (m.exchange && /TLV|TASE/i.test(m.exchange)) return { Israel: 1 };
  return COUNTRY_REGION(m.country) ? { [COUNTRY_REGION(m.country)!]: 1 } : undefined;
}

function currencyOf(region: Record<string, number> | undefined, m: FundMeta): Record<string, number> {
  if (/hedged|מגודר/i.test(m.name ?? '') && m.listingCurrency) return { [m.listingCurrency]: 1 };
  if (!region) return m.listingCurrency ? { [m.listingCurrency]: 1 } : {};
  const o: Record<string, number> = {};
  for (const [r, w] of Object.entries(region)) { const c = REGION_CCY[r] ?? 'other'; o[c] = (o[c] ?? 0) + w; }
  return o;
}

/** Special asset classes recognised from category/name before position-based splitting. */
function specialClass(m: FundMeta): string | undefined {
  const t = `${m.category ?? ''} | ${m.name ?? ''}`;
  if (/digital assets|bitcoin|ethereum|crypto|ביטקוין|קריפטו/i.test(t)) return 'crypto';
  if (/gold|silver|platinum|palladium|precious metals|זהב|כסף|מתכות יקרות/i.test(t) && !/miners|equity precious/i.test(t)) return 'precious_metals';
  if (/commodit|oil fund|natural gas fund|סחורות/i.test(t)) return 'commodity';
  if (/money market|כספית/i.test(t)) return 'cash';
  return undefined;
}

/** Hebrew/English heuristics for funds with no structured data (e.g. Israeli mutual funds). */
function heuristicFund(m: FundMeta): ExposureSpec | null {
  const t = m.name ?? '';
  const region = regionOf(m);
  const isBond = /bond|treasury|אג"?ח|אגרות חוב|מק"?מ|ממשלתי|קונצרני/i.test(t);
  const isEq = /stock|equity|מניות|מחקה|S&P|נאסד"?ק|ת"?א[- ]?(35|90|125)/i.test(t);
  if (!isBond && !isEq) return null;
  const dims: Record<string, Record<string, number>> = {};
  if (region) dims.region = region;
  if (isBond) {
    const gov = /ממשלתי|treasury|government|מק"?מ/i.test(t);
    dims.bondType = gov ? { government: 1 } : /קונצרני|corporate|חברות/i.test(t) ? { corporate: 1 } : {};
    if (gov) dims.credit = { government: 1 };
  }
  return { classes: { [isBond ? 'bond' : 'equity']: { weight: 1, dims } }, dims: { currency: currencyOf(region, m) }, source: 'heuristic:name' };
}

export function classify(m: FundMeta): ExposureSpec | null {
  const qt = (m.quoteType ?? '').toUpperCase();
  if (qt === 'CRYPTOCURRENCY') return { classes: { crypto: { weight: 1 } }, dims: { currency: { crypto: 1 } }, source: 'classify:crypto' };

  if (qt === 'EQUITY') {
    const region = COUNTRY_REGION(m.country) ?? (m.exchange && /TLV|TASE/i.test(m.exchange) ? 'Israel' : undefined);
    const sector = m.sector ? (SECTOR_KEYS[m.sector.toLowerCase()] ?? m.sector.toLowerCase().replace(/\s+/g, '_')) : undefined;
    const dims: Record<string, Record<string, number>> = {};
    if (region) dims.region = { [region]: 1 };
    if (sector) dims.sector = { [sector]: 1 };
    return { classes: { equity: { weight: 1, dims } }, dims: { currency: currencyOf(region ? { [region]: 1 } : undefined, m) }, source: 'classify:equity' };
  }

  const special = specialClass(m);
  const region = regionOf(m);
  if (special) return { classes: { [special]: { weight: 1, dims: region && special === 'cash' ? { region } : undefined } }, dims: { currency: special === 'crypto' ? { crypto: 1 } : special === 'cash' ? currencyOf(region, m) : { USD: 1 } }, source: 'classify:category' };

  const pos = {
    equity: m.stockPosition ?? 0,
    bond: (m.bondPosition ?? 0) + (m.preferredPosition ?? 0) + (m.convertiblePosition ?? 0),
    cash: m.cashPosition ?? 0,
    other: m.otherPosition ?? 0,
  };
  const tot = pos.equity + pos.bond + pos.cash + pos.other;
  if (tot < 0.05) return heuristicFund(m);   // no structured data → name heuristics

  const sectors = remap(flat(m.sectorWeightings), SECTOR_KEYS);
  const ratings = remap(flat(m.bondRatings), CREDIT_KEYS);
  const gov = ratings.government ?? 0;
  const classes: ExposureSpec['classes'] = {};
  if (pos.equity > 0) classes.equity = { weight: pos.equity, dims: { ...(region ? { region } : {}), ...(Object.keys(sectors).length ? { sector: sectors } : {}) } };
  if (pos.bond > 0) classes.bond = {
    weight: pos.bond,
    dims: {
      ...(region ? { region } : {}),
      ...(Object.keys(ratings).length ? { credit: ratings, bondType: { government: gov, corporate: Math.max(0, 1 - gov) } } : {}),
    },
  };
  if (pos.cash > 0) classes.cash = { weight: pos.cash };
  if (pos.other > 0.005) classes.other = { weight: pos.other };
  return { classes, dims: { currency: currencyOf(region, m) }, source: 'classify:holdings' };
}
