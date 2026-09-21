# Multi-chain support

Status: design note, September 2026. Nothing here is built.

## Decision

**Do not block on GUM.** Build a capability model now and let GUM become one
adapter among several if and when it ships.

Jupiter's Giant Unified Market promises one API covering swaps, cross-chain
spot, perps and deposits — which would collapse most of the adapter layer this
document describes. It is also the reason not to over-invest in any single EVM
integration. But it was announced in **May 2024**, is still closed beta, and
every `gum/*` endpoint returns 404. Waiting has no delivery date attached.

The cost of being wrong is bounded: `core/` is already venue-agnostic (verified
— nothing under `src/core/` imports a venue), so GUM arriving would replace
adapters, not the engine.

## What actually varies between venues

The current code assumes Jupiter's shape in the CLI. Those assumptions are not
universal, and naming them is most of the design work:

| Dimension | Why it matters |
|---|---|
| **Native scheduling** | If absent, there is nothing to place and the whole non-custodial premise collapses |
| **Escrow model** | Jupiter locks the full deposit up front; CoW pulls per-part via allowance. Completely different capital commitment |
| **Minimum order size** | Decides how many legs a budget can split into |
| **Slice uniformity** | Both known venues are uniform-only, which is why VWAP needs synthesising |
| **Wallet requirement** | CoW TWAP needs a Safe; Jupiter takes any keypair |
| **Interval semantics** | Fixed seconds (Jupiter) vs. wall-clock scheduling. Decides whether "the 1st" is expressible |
| **Fee model** | Proportional fees cancel out of slicing maths; fixed per-fill costs do not |

## Verified venue matrix

Probed live, September 2026. Unverified cells are marked.

| | Jupiter (Solana) | CoW (Base/Arbitrum) | CoW (mainnet) | 1inch LOP (EVM) |
|---|---|---|---|---|
| Native scheduling | yes (`recurring/v1`) | yes (programmatic orders) | yes | via predicates — **unverified** |
| Escrow | full deposit up front | per-part allowance | per-part allowance | per-order allowance |
| Min order | **$50** | **$5** | **$5,000** | unknown |
| Wallet | any keypair | **Safe required** | **Safe required** | EOA (EIP-712) |
| Interval | fixed 30-day seconds | duration ÷ parts | same | predicate-defined |
| Fee | 0.1% | solver-competed, gas in sell token | same | resolver-competed |
| Per-fill cost | ~$0.005 | ~$0.02–0.05 | ~$4 | ~$0.02–0.05 |

## The Safe problem

**CoW TWAP requires a Safe wallet. Plain EOAs are not supported** — confirmed in
CoW's docs and by an open PR adding UI copy that says so.

This is the single biggest obstacle to the EVM path, and it is a product problem
rather than a technical one. Scheduled orders need a contract to produce them
over time, which means ERC-1271 signatures, which means a smart contract wallet.
Asking a retail user to deploy and fund a Safe before their first $100 buy is a
real drop-off cliff.

Three ways out, in rough order of preference:

1. **Spike 1inch Limit Order Protocol with timestamp predicates.** 1inch orders
   are EIP-712 signed by an EOA and support arbitrary predicates. If a
   "not before timestamp" predicate is expressible, a user could pre-sign 48
   orders, each gated to its own month, with no Safe and no keeper. This is the
   most promising EOA-native route and the highest-value unknown in this
   document. **It is unverified** — the predicate semantics, resolver
   willingness to fill dated orders, and cancellation story all need checking
   before anything is designed around it.
2. **Support Safe, and be honest about it.** Gate the EVM path behind a Safe
   with clear setup guidance. Correct, non-custodial, works today, and excludes
   most casual users.
3. **Manual monthly signing.** Build the transaction, notify the user, they sign.
   No Safe, no automation. A fallback, not a product.

Note that plain pre-signed CoW orders do *not* work as a substitute: CoW orders
carry `validTo` but no "valid from", so a pre-signed order can be filled
immediately. Scheduling on CoW genuinely requires the programmatic order
framework, and therefore a Safe.

## Funding across chains

Out of scope. The user funds each chain themselves.

Bridging introduces custody questions, bridge risk, and failure modes that have
nothing to do with execution quality — and the LIT investigation already showed
how badly a bridged asset can misrepresent itself. If cross-chain funding is
wanted later it belongs behind its own adapter, not smuggled into the planner.

## What changes in the code

`core/` stays as it is. The work is in two places:

1. **Introduce an explicit `VenueAdapter` with a capability descriptor.** Today
   the CLI imports `MIN_ORDER_USD`, `INTERVAL_SECONDS` and `DCA_FEE_BPS`
   directly from `venues/jupiter/`. Those become fields on a descriptor the CLI
   reads without knowing which venue it is talking to:

   ```
   interface VenueCapabilities {
     minOrderUsd: number;
     escrow: 'upfront' | 'per-part';
     walletRequirement: 'any' | 'smart-contract';
     intervalSemantics: 'fixed-seconds' | 'wall-clock';
     proportionalFeeBps: number;
     fixedCostPerFillUsd: number;
     uniformSlicesOnly: boolean;
   }
   ```

2. **Move `FILL_COST_USD` out of `planner.ts`.** It is currently a hardcoded
   per-chain table inside the planner — the one real venue assumption left in
   `core/`. It should arrive from the capability descriptor instead.

This refactor is worth doing **regardless of which venue comes next**, and it is
behaviour-preserving, so it can land on its own with the existing tests as the
safety net.

## Non-uniform schedules (the VWAP part)

Cross-cutting and still unsolved. Neither Jupiter nor CoW can express a
non-uniform schedule: both are equal-size, equal-interval, which is TWAP.

The approach worth trying is **superposition** — express a volume-weighted
profile as the sum of several uniform tranches with different sizes and start
offsets. It keeps everything non-custodial and needs no new venue primitive.

Worth remembering how little this is likely to buy. Measured impact at $100 was
0.01%–0.08%, and even at **$40,000 per order** the fitted exponent stayed near
1.0 because Jupiter's router already fans large orders across venues. Non-uniform
scheduling is an institutional-size feature. It should be built when someone has
a position large enough to need it, not because the project is called `vwap`.

## Sequencing

1. **Extract the capability model.** Behaviour-preserving, useful regardless,
   unblocks everything else.
2. **Spike 1inch predicates.** Highest-value unknown. If EOA scheduling works,
   the EVM path stops needing a Safe and the product gets dramatically simpler.
3. **CoW adapter**, Safe-gated, if the spike fails or as the institutional path.
4. **GUM adapter** if and when it ships publicly.

Steps 1 and 2 are cheap and independent. Step 3 is the expensive one and the one
GUM could obsolete — which is an argument for doing 2 first and deciding 3 with
better information.

## Open questions

- Can 1inch limit orders express "not valid before timestamp T", and will
  resolvers fill an order dated months out? **Blocks step 2.**
- Does CoW's minimum part size vary by chain beyond the $5 / $5,000 split?
- What does cancelling a partially-executed programmatic order return, and when?
- Is GUM's API going to be public and permissionless, or partner-gated? A
  partner-gated GUM is not an option for an open tool, and would settle the
  question above by removing it.
