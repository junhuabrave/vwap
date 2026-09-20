# vwap

Plan and cost long-horizon accumulation — non-custodially.

`vwap` helps you buy a basket of tokens on a schedule, for years, and tells you
honestly what that will cost. It resolves tokens by mint address, audits them
for the risks that matter over a multi-year hold, measures live price impact
against real quotes, and decides whether splitting an order is worth the fees.

It never holds your keys or your funds. It plans; you sign.

## Why

Most "DCA bots" are a cron job with a hot private key and a market-impact model
somebody guessed. Both are avoidable:

- **Scheduling is already solved on-chain.** Jupiter's Trigger V2 on Solana and
  CoW Protocol's programmatic orders on EVM both execute on a schedule via their
  own decentralised keepers. There is no reason to run a keeper, hold a key, or
  keep a laptop awake on the 1st of the month.
- **Impact should be measured, not modelled.** Routing across a dozen venues
  makes any closed-form curve a guess. The router's own quotes are ground truth,
  and they cost nothing to ask for.

## Quick start

Requires Node 23.6+ (runs TypeScript natively; no build step, no runtime deps).

```bash
node src/cli/index.ts check JUP SOL MET --per-buy 100 --total 4800
```

```bash
node src/cli/index.ts plan --legs "JUP=1,SOL=1,MET=1" --budget 300 --periods 48
```

`check` audits token identity and liquidity. `plan` builds the full schedule,
probes the live impact curve, and prints the total expected cost.

## What it refuses to do

**Resolve a ticker to a mint by guessing.** Buying the wrong token is the most
common way retail loses money on Solana, and it never looks like a hack — it
looks like a ticker that matched:

```
$ vwap check BP
ambiguous "BP" matches 2 tokens. Specify the mint address:
    BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy  BP  Backpack
    3B1ijcocM5EDga6XxQ7JLW7weocQPWWjuhBYG8Vepump  BP  Barking Puppy
```

**Ignore the exit.** A long horizon changes which risks matter. A live mint
authority is survivable for a day trade and disqualifying for a four-year
position; shallow liquidity barely affects a $100 entry and dominates the
eventual exit:

```
$ vwap check LIT --per-buy 100 --total 4800
  LIT      BLOCKED  Lighter
    BLOCK 1 other token also trades as LIT. Confirm the mint, not the ticker.
    HIGH  Mint authority is still active. Supply can be increased at any time.
    WARN  The finished position ($5K) would be 2.72% of today's $176K
          liquidity. Entering is cheap; selling this back is the hard part.
```

**Slice an order just because you asked for VWAP.** Splitting a trade helps only
when impact is convex in size *and* the book refills between slices. At retail
size neither usually holds, so the planner measures and then declines:

```
slicing none -- impact at this size is 0.021%, already negligible
slicing none -- impact is concave in size (exponent 0.11), so splitting saves nothing
slicing none -- impact curve fits poorly (R2 0.31) -- the measurement is
                routing noise, not a shape worth trading on
```

This is the tool disagreeing with its own name, on purpose. Dollar-cost
averaging over months reduces the variance of your entry price — a real benefit
that has nothing to do with market impact. Slicing a single period's buy is
purely an execution-cost question, and at $100 the answer is almost always no.

## Findings from the live market

Measured against Jupiter, September 2026:

- At $100 per buy, price impact on liquid Solana tokens runs 0.01%–0.08%. Total
  cost of a 4-year, $400/month plan across JUP/SOL/MET/BP came to **0.13% of
  deployed capital**, of which the venue fee is the larger half.
- Even at **$40,000 per order**, the measured impact exponent stayed near 1.0 —
  Jupiter's router already fans large orders across venues, flattening the curve
  spatially. Temporal slicing adds less than people assume.
- **Ethereum mainnet is hostile to retail DCA.** CoW's minimum part size is
  $5,000 there versus $5 on L2s, and at ~$4 of gas per fill the cost model
  refuses to slice a $100 order. The same order on Solana, same curve, slices
  happily — per-fill cost is the whole difference.

## Architecture

```
src/core/      chain-agnostic: money, schedule, impact, planner
src/venues/    per-chain adapters (Jupiter today)
src/cli/       read-only command line
```

- **`core/money.ts`** — all token amounts are `bigint` base units. No float ever
  touches an amount: 2^53 is smaller than many token supplies, and splits are
  apportioned so they sum *exactly* to the total rather than stranding dust.
- **`core/impact.ts`** — probes the aggregator at sizes bracketing the order and
  fits a power law. The exponent is the whole decision: `a ≈ 1` means splitting
  within a block saves nothing.
- **`core/planner.ts`** — nets impact saved against per-fill cost, which is what
  makes the slicing decision chain-dependent.
- **`venues/jupiter/safety.ts`** — the token audit.

Adding a chain means adding an adapter, not a branch.

```bash
npm test          # 28 tests, no network
npm run typecheck
```

## Status and limits

Working today: Solana via Jupiter, token audit, impact measurement, slicing
decision, schedule generation, cost estimate.

Not built yet: placing the orders, EVM adapters via CoW, and VWAP schedules
synthesised from overlapping uniform tranches — neither Jupiter's DCA orders nor
CoW TWAP can express a non-uniform schedule directly.

Order placement targets **Trigger V2**, which now covers DCA alongside price
orders. Jupiter's older Recurring API is unmaintained, so anything written
against it would need rewriting.

Impact is measured at today's liquidity and will drift over a multi-year plan;
the estimate is a snapshot, not a forecast. Costs exclude network fees and any
spread already reflected in the router's quote.

## Scope

This is execution tooling. It does not recommend assets, and nothing it prints
is financial advice. If you operate it for other people, keep it non-custodial —
holding other people's funds or keys is a regulated activity in most
jurisdictions, and that is a question for a lawyer, not a README.

## Licence

MIT
