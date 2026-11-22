// ───────────────────────── Primitives ─────────────────────────
export type ISODate = string;          // "YYYY-MM-DD"
export type Ccy = string;              // ISO 4217 ("USD", "ILS", ...)

// ───────────────────────── Accounts ─────────────────────────
export type TaxStatus = 'taxable' | 'exempt' | 'deferred';

export interface Account {
  id: string;
  name: string;
  currency: Ccy;                 // currency that cash from trades settles into
  taxStatus: TaxStatus;          // exempt/deferred → zero realized-gain cost in rebalancer
  taxRate?: number;              // overrides settings.tax.rate for this account
}

// ───────────────────────── Instruments ─────────────────────────
export type InstrumentKind = 'security' | 'crypto' | 'cash' | 'debt' | 'manual';

export interface Instrument {
  id: string;                    // unique key used in transactions ("SPY", "BTC", "LOAN-MORTGAGE")
  name?: string;
  kind: InstrumentKind;
  currency: Ccy;                 // currency the price is quoted in
  source?: { provider: string; symbol: string };   // which plugin prices/classifies it
  exposureOverride?: ExposureSpec;                 // user override of auto-classification
  excluded?: boolean;            // part of the "exception to calculations" sleeve
  tradable?: boolean;            // default: security/crypto true, others false
  fractional?: boolean;          // default: crypto/manual true, security false
  accounts?: string[];           // where the rebalancer may buy it (default: where held, else all)
}

/**
 * How an instrument is exposed. Asset-class split at the top; each class carries marginal
 * distributions over any number of dimensions. Joint exposure is built assuming independence
 * of dimensions *within* a class (e.g. sector ⟂ region inside SPY's equity sleeve).
 */
export interface ExposureSpec {
  classes: Record<string, { weight: number; dims?: Record<string, Record<string, number>> }>;
  dims?: Record<string, Record<string, number>>;   // applied to every class (e.g. currency)
  source?: string;               // provenance ("yahoo:topHoldings", "manual", ...)
  asOf?: ISODate;
}

/** One cell of the joint exposure: weight + full attribute assignment. */
export interface Atom { w: number; attrs: Record<string, string> }

// ───────────────────────── Transactions ─────────────────────────
export type TxType =
  | 'buy' | 'sell'               // qty, price (instrument ccy), fees (instrument ccy)
  | 'deposit' | 'withdraw'       // external cash flow: amount, currency
  | 'dividend' | 'interest' | 'fee'   // internal cash: amount, currency (fee = outflow)
  | 'split'                      // ratio (2 = 2-for-1)
  | 'fx'                         // amount of currency → toAmount of toCurrency
  | 'open'                       // opening position w/o cash effect: qty, price = cost basis; counts as external inflow
  | 'borrow' | 'repay'           // debt instrument: amount (instrument ccy); cash moves in the account
  | 'debt_interest'              // accrued interest added to debt principal: amount
  | 'valuation'                  // manual price point: price (for manual instruments)
  | 'adjust';                    // set a balance directly: instrument+qty (price = new avg cost, optional) or currency+amount

export interface Tx {
  id: string;
  date: ISODate;
  type: TxType;
  account: string;
  instrument?: string;
  qty?: number;
  price?: number;
  fees?: number;
  amount?: number;
  currency?: Ccy;
  toAmount?: number;
  toCurrency?: Ccy;
  ratio?: number;
  lots?: string[];               // sell: specific lot ids (only honored with lotMethod 'specific')
  acquired?: ISODate;            // adjust: purchase date of the resulting lot (drives tax FX)
  flowPrice?: number;            // adjust: market price used to value the change as an external flow
  note?: string;
}

// ───────────────────────── Targets ─────────────────────────
/**
 * A target is a set of scoped rules. Each rule says: "within the slice of the portfolio matching
 * `scope`, split value along `dimension` as `weights`". The user's nested tree is just rules with
 * deeper scopes; cross-cutting targets (region AND sector inside equities) are parallel rules.
 */
export interface TargetRule {
  id: string;
  scope: Record<string, string | string[]>;  // {} = whole (non-excluded) portfolio
  dimension: string;
  weights: Record<string, number>;           // percent; must sum to 100. Unlisted values target 0.
  band?: Band;
  importance?: number;                       // multiplier on drift penalty (default 1)
}
export interface Band { abs?: number; rel?: number }   // abs: pp of scope; rel: fraction of target weight

export interface Targets {
  rules: TargetRule[];           // percentages are of the non-excluded ("investable") portfolio
  defaultBand: Band;
  excludedPct?: number;          // target size of the exception sleeve, % of (investable + sleeve); report-only
}

// ───────────────────────── Settings ─────────────────────────
export type LotMethod = 'fifo' | 'specific' | 'average';

export interface Settings {
  baseCurrency: Ccy;
  tax: {
    rate: number;                // e.g. 0.25
    currency: Ccy;               // currency gains are computed in (ILS for Israeli residents)
    lotMethod: LotMethod;
    lossCredit: boolean;         // treat realized losses as worth rate×loss (offsets other gains)
  };
  trading: {
    feeBps: number;              // proportional fee per trade
    fxBps: number;               // conversion cost when trade ccy ≠ account ccy
    minTrade: number;            // in base ccy; smaller trades are dropped
    minCashPct: number;          // cash reserve kept (fraction of investable value)
  };
  debtInTargets: boolean;        // if false, debt counts toward net worth but not target math
  riskFreeRate: number;          // annual, for Sharpe/Sortino
  benchmark?: string;            // instrument id or provider symbol for beta
}

export const DEFAULT_SETTINGS: Settings = {
  baseCurrency: 'ILS',
  tax: { rate: 0.25, currency: 'ILS', lotMethod: 'fifo', lossCredit: false },
  trading: { feeBps: 10, fxBps: 20, minTrade: 200, minCashPct: 0 },
  debtInTargets: false,
  riskFreeRate: 0.04,
};

// ───────────────────────── Market data ─────────────────────────
export type Series = Array<[ISODate, number]>;   // sorted ascending

export interface MarketSnapshot {
  prices: Record<string, { currency: Ccy; series: Series }>;   // by instrument id
  fx: Record<string, Series>;                                  // "USD/ILS" → units of ILS per 1 USD
  exposures: Record<string, ExposureSpec>;                     // by instrument id (auto)
}

// ───────────────────────── Portfolio state (derived) ─────────────────────────
export interface Lot { id: string; date: ISODate; qty: number; cost: number /* per unit, instrument ccy */ }

export interface Position {
  account: string;
  instrument: string;
  qty: number;
  lots: Lot[];
}

export interface PortfolioState {
  positions: Position[];                         // securities, crypto, manual, debt (debt qty = principal)
  cash: Record<string, Record<Ccy, number>>;     // account → ccy → amount
  flows: Array<{ date: ISODate; amount: number; currency: Ccy }>;  // external flows (+in / −out)
  realized: Array<{ date: ISODate; account: string; instrument: string; qty: number; proceeds: number; cost: number; currency: Ccy; buyDate: ISODate }>;
  warnings: string[];
}

export interface Data {
  accounts: Account[];
  instruments: Instrument[];
  transactions: Tx[];
  targets: Targets;
  settings: Settings;
}
