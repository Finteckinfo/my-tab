# MyTab V1 Audit Scope

## Focus Areas
The following smart contracts comprise the v1.0.0 audit scope.

### In Scope
| Contract | Path | Description |
|----------|------|-------------|
| `SettlementRouter.sol` | `src/SettlementRouter.sol` | Central entry point for fund movement, off-chain settlement auto-clearing, and keeper-driven direct debits. |
| `PledgeLedger.sol` | `src/PledgeLedger.sol` | Core state machine for pledges. Non-upgradable, holds no funds. |
| `ReputationEngine.sol` | `src/ReputationEngine.sol` | Tracks disapproval counts, calculates reputation tiers, and manages the blacklist. |
| `IdentityRegistry.sol` | `src/IdentityRegistry.sol` | Maps usernames to addresses and handles signature-based delegation. |

### Out of Scope
- Backend infrastructure (NestJS, Prisma, BullMQ, Redis).
- M-Pesa Fiat Bridge (Sandbox only, off-chain).
- Third-party contracts deployed by Pimlico (Entrypoint, LightAccount, VerifyingPaymaster).
- OpenZeppelin dependencies.

## Key Risk Vectors Identified
1. **Funds extraction**: The `SettlementRouter` holds user allowances. Can a malicious actor drain funds via `executeDirectDebit` or `settleOnChain`?
2. **State machine bypass**: Can a pledge move to `Active` without the debtor's explicit confirmation?
3. **Reputation gaming**: Can a user artificially inflate their reputation or evade blacklisting?
4. **Denial of Service**: Can a user intentionally revert a keeper transaction to block direct debits?

## Required Tooling Results
- **Foundry Invariants**: Full system invariants covering Conservation, Authorization, State Machine, and Reputation must pass.
- **Slither**: Static analysis report attached.
- **Mythril**: Symbolic execution report attached.
- **Gas Profile**: Foundry gas snapshot attached.
