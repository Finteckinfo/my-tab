# MyTab Gas Profile

*This document captures the gas consumption of core MyTab operations. These metrics are critical for estimating Pimlico paymaster runway and keeper operational costs.*

## Summary of Core Operations

| Operation | Typical Gas | USD Cost Est. (Base @ 0.05 gwei, ETH $3000) |
|-----------|-------------|--------------------------------------------|
| `PledgeLedger.createPledge` | TBD | TBD |
| `PledgeLedger.confirmPledge` (Voluntary) | TBD | TBD |
| `SettlementRouter.confirmPledge` (Enforced - includes approve) | TBD | TBD |
| `SettlementRouter.settleOnChain` | TBD | TBD |
| `SettlementRouter.executeDirectDebit` | TBD | TBD |
| `SettlementRouter.autoApproveOffChainSettlement` | TBD | TBD |
| `ReputationEngine.lenderRespond` | TBD | TBD |

## Operational Cost Analysis

### Paymaster Runway Calculation
Assume 1,000 new pledges per day (50% voluntary, 50% enforced), with 100% confirmation rate and 80% on-chain settlement.

- **Create Pledge**: 1000 * `createPledge` gas
- **Confirm**: 500 * `confirmPledge` (Voluntary) + 500 * batched approve+confirm (Enforced)
- **Settle**: 800 * `settleOnChain`

*Detailed analysis will be populated after the gas profile is merged into this document.*

### Keeper Wallet Runway
Assume 500 direct debits attempted per day.

- **Direct Debit**: 500 * `executeDirectDebit` gas

*Detailed analysis will be populated after the gas profile is merged into this document.*

## Raw Forge Gas Report

*(To be appended via `forge test --gas-report`)*
