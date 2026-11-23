import type { TargetRule } from './types.js';

type Weights = Record<string, number>;

/** The app's original detailed targets. Always available as a profile. */
export const DEFAULT_RULES: TargetRule[] = [
  { id: 'asset-class', scope: {}, dimension: 'assetClass', weights: { equity: 63, bond: 21, commodity: 11, precious_metals: 5 } },
  { id: 'equity-region', scope: { assetClass: 'equity' }, dimension: 'region', weights: { US: 75, emerging: 25 } },
  { id: 'us-equity-sector', scope: { assetClass: 'equity', region: 'US' }, dimension: 'sector', weights: { technology: 20, real_estate: 20, financial_services: 15, healthcare: 15, industrials: 10, consumer_cyclical: 10, communication_services: 10 } },
  { id: 'bond-type', scope: { assetClass: 'bond' }, dimension: 'credit', weights: { government: 50, A: 30, AA: 10, AAA: 10 } },
];

const SECTORS = {
  market: { technology: 30, financial_services: 13, healthcare: 11, consumer_cyclical: 10, communication_services: 9, industrials: 9, consumer_defensive: 6, energy: 4, utilities: 3, real_estate: 3, basic_materials: 2 },
  defensive: { healthcare: 20, consumer_defensive: 16, technology: 15, financial_services: 14, utilities: 10, industrials: 7, communication_services: 5, energy: 5, real_estate: 4, consumer_cyclical: 2, basic_materials: 2 },
  growth: { technology: 38, communication_services: 13, consumer_cyclical: 12, financial_services: 11, healthcare: 10, industrials: 8, energy: 2, consumer_defensive: 2, basic_materials: 2, real_estate: 1, utilities: 1 },
  realAssets: { technology: 16, energy: 14, basic_materials: 12, real_estate: 12, industrials: 12, financial_services: 8, healthcare: 8, utilities: 8, consumer_defensive: 5, consumer_cyclical: 3, communication_services: 2 },
} satisfies Record<string, Weights>;

const CREDIT = {
  safe: { government: 80, AAA: 10, AA: 10 },
  core: { government: 60, AAA: 10, AA: 15, A: 15 },
  income: { government: 40, AAA: 10, AA: 15, A: 25, BBB: 10 },
} satisfies Record<string, Weights>;

export interface PortfolioProfile {
  id: string;
  name: string;
  summary: string;
  risk: 1 | 2 | 3 | 4 | 5;
  assetClass: Weights;
  sectors?: Weights;
  credit?: Weights;
  /** A fixed rule set that ignores the region choice. */
  rules?: TargetRule[];
}

export const DEFAULT_PROFILE: PortfolioProfile = {
  id: 'default', name: 'App default', risk: 3, summary: "The app's original detailed targets. Uses its own regions.",
  assetClass: DEFAULT_RULES[0].weights, rules: DEFAULT_RULES,
};

/** Generic model allocations, ordered from lowest to highest stock exposure. */
export const PROFILES: PortfolioProfile[] = [
  { id: 'preservation', name: 'Capital preservation', risk: 1, summary: 'Mostly high-quality bonds and cash, for money you may need within a few years.', assetClass: { equity: 20, bond: 60, precious_metals: 5, cash: 15 }, sectors: SECTORS.defensive, credit: CREDIT.safe },
  { id: 'conservative', name: 'Conservative', risk: 2, summary: 'Income and stability first, with defensive stocks.', assetClass: { equity: 35, bond: 50, precious_metals: 5, cash: 10 }, sectors: SECTORS.defensive, credit: CREDIT.core },
  { id: 'risk-balanced', name: 'Risk-balanced', risk: 2, summary: 'Spreads risk across stocks, bonds, gold and commodities for different economic conditions.', assetClass: { equity: 30, bond: 55, commodity: 7.5, precious_metals: 7.5 }, sectors: SECTORS.market, credit: CREDIT.core },
  { id: 'balanced', name: 'Balanced', risk: 3, summary: 'The classic mix of growth from stocks and ballast from bonds.', assetClass: { equity: 60, bond: 30, precious_metals: 5, cash: 5 }, sectors: SECTORS.market, credit: CREDIT.core },
  { id: 'real-assets', name: 'Inflation-aware', risk: 3, summary: 'Leans to gold, commodities, energy, materials and real estate, which have tended to hold up better when inflation rises.', assetClass: { equity: 50, bond: 20, commodity: 10, precious_metals: 15, cash: 5 }, sectors: SECTORS.realAssets, credit: CREDIT.core },
  { id: 'growth', name: 'Growth', risk: 4, summary: 'Mostly stocks for a long horizon, tilted to growth sectors.', assetClass: { equity: 80, bond: 15, precious_metals: 5 }, sectors: SECTORS.growth, credit: CREDIT.income },
  { id: 'aggressive', name: 'Aggressive', risk: 5, summary: 'Nearly all stocks. The highest expected swings, for decades-long money.', assetClass: { equity: 95, precious_metals: 5 }, sectors: SECTORS.growth },
];
export const ALL_PROFILES = [DEFAULT_PROFILE, ...PROFILES];

export const EQUITY_TILTS = {
  global: { label: 'Global', detail: 'Stocks roughly by world market size', weights: { US: 63, developed_ex_us: 26, emerging: 11 } as Weights, bonds: { Israel: 50, US: 35, developed_ex_us: 15 } as Weights },
  israel: { label: 'Israel tilt', detail: 'Extra weight on Israel, your home market', weights: { US: 50, developed_ex_us: 20, emerging: 10, Israel: 20 } as Weights, bonds: { Israel: 80, US: 20 } as Weights },
  us: { label: 'US focus', detail: 'Mainly US companies', weights: { US: 85, developed_ex_us: 10, emerging: 5 } as Weights, bonds: { US: 70, Israel: 30 } as Weights },
};
export type EquityTilt = keyof typeof EQUITY_TILTS;

export function profileRules(profileId: string, tilt: EquityTilt): TargetRule[] {
  const p = ALL_PROFILES.find(x => x.id === profileId);
  const t = EQUITY_TILTS[tilt];
  if (!p || !t) throw new Error('Unknown portfolio profile.');
  if (p.rules) return structuredClone(p.rules);
  const rules: TargetRule[] = [
    { id: 'asset-class', scope: {}, dimension: 'assetClass', weights: { ...p.assetClass } },
    { id: 'equity-region', scope: { assetClass: 'equity' }, dimension: 'region', weights: { ...t.weights } },
  ];
  if (p.sectors) rules.push({ id: 'us-equity-sector', scope: { assetClass: 'equity', region: 'US' }, dimension: 'sector', weights: { ...p.sectors } });
  if (p.credit) {
    rules.push({ id: 'bond-region', scope: { assetClass: 'bond' }, dimension: 'region', weights: { ...t.bonds } });
    rules.push({ id: 'bond-credit', scope: { assetClass: 'bond' }, dimension: 'credit', weights: { ...p.credit } });
  }
  return rules;
}

/** Share of the portfolio (percent) that would have to move to reach these weights. */
export function shareToMove(actual: Record<string, number>, total: number, weights: Record<string, number>) {
  if (!(total > 0)) return 0;
  const keys = new Set([...Object.keys(actual), ...Object.keys(weights)]);
  let sum = 0;
  for (const k of keys) sum += Math.abs((100 * (actual[k] ?? 0)) / total - (weights[k] ?? 0));
  return sum / 2;
}
