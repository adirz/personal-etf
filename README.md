# Personal ETF

Manage your portfolio like your own ETF: log what you hold and how it moved, declare a target
allocation across **several dimensions at once** (asset class, region, sector, credit, currency, …),
see risk/return analytics, and get a **tax-aware trade list** that brings you back to target.

Mobile-first PWA + small Node server. TypeScript end to end; the core engine is pure and runs anywhere.

```
npm install
npm test                       # engine + classifier tests
npm run build                  # builds the PWA into app/dist (served by the server)
PETF_TOKEN=<long-random> npm run server        # http://localhost:8787
# offline demo with synthetic prices:
PETF_DATA=./demo-data npx tsx scripts/demo.ts && PETF_DATA=./demo-data npm run server
```
Open it on your phone → "Add to Home Screen". Put it behind HTTPS (Caddy/nginx/Cloudflare Tunnel) and
always set `PETF_TOKEN` before exposing it; the app asks for the token once (gear → Server & token).
Env: `PORT`, `PETF_DATA` (data dir, default `./data`), `COINGECKO_API_KEY` (optional).

**Save & load:** Settings → Save to file downloads the whole portfolio (data, manual prices, cached market data) as one
unencrypted JSON file. Load from file validates it, keeps the current data in `<data dir>/backups/` (last 10), then replaces it.

## Model

| File (`data/`) | What |
|---|---|
| `accounts.json` | brokerage/bank/pension accounts: currency, `taxStatus` (`taxable`/`exempt`/`deferred`) |
| `instruments.json` | anything you hold: securities, crypto, manual (Israeli funds, property), debt |
| `transactions.json` | the ledger — the **only** source of truth for positions, lots, cash, flows |
| `targets.json` | scoped allocation rules (below) |
| `settings.json` | base currency, tax rate/currency/lot method, fees, risk-free rate, benchmark |

Everything else (holdings, cost basis, cash, debt) is derived by replaying the ledger.
Transaction types: `buy sell open deposit withdraw dividend interest fee fx split borrow repay debt_interest valuation adjust`.
`adjust` is what Holdings → Add/Edit writes: it sets a balance directly, so an existing portfolio can be entered as it stands
today. The change counts as an external flow at market value, so it doesn't affect returns.
Cash is per account per currency; **debt** is an instrument with negative value (counted in net worth;
in targets only if `debtInTargets`).

### Targets = scoped rules (not a tree)
Each rule: *within the slice matching `scope`, split by `dimension` as `weights`*.
```json
{ "id": "top",       "scope": {},                                   "dimension": "assetClass", "weights": {"equity":63,"bond":21,"commodity":11,"precious_metals":5} }
{ "id": "eq-region", "scope": {"assetClass":"equity"},              "dimension": "region",     "weights": {"US":75,"emerging":25} }
{ "id": "us-sector", "scope": {"assetClass":"equity","region":"US"},"dimension": "sector",     "weights": {"technology":20,"real_estate":20, "...": 0} }
{ "id": "eq-ccy",    "scope": {"assetClass":"equity"},              "dimension": "currency",   "weights": {"USD":70,"ILS":30} }
```
Your nested example is rules with deeper scopes; cross-cutting targets (region *and* sector *and*
currency inside equities) are just parallel rules. Bands: `min(abs pp, rel × target)` (default 5/25).
`excludedPct` sizes the **exception sleeve** (instruments flagged `excluded`); its contents are free and
never traded. Rule weights are % of the non-excluded portfolio.

### Look-through (automatic)
Each instrument gets an exposure spec: asset-class split, each class carrying per-dimension weights.
The engine expands it into joint "atoms" (independence within a class — the only thing derivable from
fund-level data), so SPY counts as ~33% US-tech without you typing anything.

| Source | What it gives |
|---|---|
| Yahoo `topHoldings` | stock/bond/cash split, sector weights, bond credit ratings (→ `credit`, `bondType`) |
| Yahoo `fundProfile.categoryName` + name | region (US / developed_ex_us / emerging / Israel; "global" funds split 63/26/11), gold/commodity/crypto/money-market detection |
| Yahoo `assetProfile` | single stocks: sector, country → region |
| Name heuristics (EN + **Hebrew**) | Israeli funds with no structured data: `מחקה ת"א 125`, `אג"ח ממשלתי שקלי`, `כספית`, `מגודר`… |

Currency exposure follows region (hedged funds → listing currency). Override any instrument from
Holdings → Edit exposure override. Classifications refresh weekly.

## Rebalancer
A linear program (HiGHS, WASM) over buy amounts and per-lot sell amounts:
minimize `λ·(deviation outside bands) + ε·(deviation) + fees + realized tax + small turnover penalty`,
subject to per-account cash. Consequences:
* nothing trades while everything is in-band (except new money/idle cash finding a home);
* sells come from **exempt accounts and low-gain/loss lots first**; tax = rate × gain computed in
  `tax.currency` (ILS) using FX at buy and sell dates;
* `fifo` with non-monotone lot costs is enforced exactly (MILP); `specific` picks lots; `average` supported;
* cash cannot move between accounts (a pension's cash stays in the pension);
* whole shares for securities, fractional for crypto/manual; trades below `minTrade` dropped.
Where can it buy? `instrument.accounts` if set; else where you've traded it; else accounts trading the
same provider or with no history. "Record as executed" writes the orders into the ledger.

## Analytics
TWR (flows at start of day), XIRR, CAGR, volatility, Sharpe, Sortino, max drawdown, beta vs benchmark,
1-year correlation matrix and **risk contribution** per holding (`wᵢ(Σw)ᵢ / wᵀΣw`), all in base currency.
Returns are on gross assets; borrowing/repaying are external flows, so a mortgage doesn't distort them.

## Adding a data source
Implement `Provider` (`src/providers/types.ts`: any of `search`, `describe`, `history`, `exposure`),
register it in `src/providers/registry.ts`, set `instrument.source.provider` to its id. Same for FX
(`FxProvider`). Natural next ones: TASE Data Hub / Maya (Israeli funds), Bank of Israel FX (official
rates), issuer holdings files (full look-through instead of category-based region), an LLM classifier.
Until then, Israeli mutual funds work as `manual` instruments: upload a `date,price` CSV (dd/mm/yyyy and
`;` accepted) or record `valuation` transactions.

## Known simplifications
* Israeli tax is modelled as a flat rate on nominal gains in ILS. Inflation adjustment, the real/nominal
  election for foreign assets, loss carry-forward and surtax are not modelled. Not tax advice.
* Look-through region for funds comes from category/name, not holdings; "global" uses a fixed split.
* Fixed per-trade fees aren't modelled (only bps); min-trade filter compensates.
* Data sources were tested against recorded payloads, not live (the build environment had no network).
