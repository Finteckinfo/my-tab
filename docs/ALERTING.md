# MyTab Alerting Thresholds & Monitoring

This document outlines the core alerting thresholds for the MyTab production environment.

## 1. High Priority Alerts (PagerDuty - Wake Up)

| Alert Name | Condition | Rationale | Runbook |
|------------|-----------|-----------|---------|
| **Paymaster Depleted** | Pimlico Paymaster balance < 0.1 ETH | Users cannot transact. Total system halt for new actions. | Runbook 3 |
| **Relayer Wallet Low** | Relayer wallet balance < 0.05 ETH | Auto-clear rules will stop executing. | Runbook 1 |
| **Keeper Wallet Low** | Keeper wallet balance < 0.05 ETH | Direct debits will not execute. | Runbook 2 |
| **Indexer Stalled** | No blocks indexed in > 10 minutes | UI will show stale data to users. | Runbook 4 |
| **Fiat Reconciliation Mismatch** | `reconciliation_mismatches_total > 0` | Funds are missing or stuck in transit between Daraja and our system. | Runbook 5 |

## 2. Warning Alerts (Slack - Business Hours)

| Alert Name | Condition | Rationale |
|------------|-----------|-----------|
| **High Direct Debit Failure Rate** | `direct_debit_failures / total_direct_debits > 10%` over 1 hour | Many users don't have sufficient allowance or balance for enforced pledges. Could indicate a systemic issue with token approvals. |
| **High RPC Error Rate** | `rpc_errors_total > 50` over 5 minutes | The backend is struggling to communicate with Base Sepolia. Might need to cycle RPC providers. |
| **Queue Backlog** | `bullmq_waiting_jobs > 100` | Workers are falling behind schedule. |

## 3. Metrics to Monitor

- **Pledges Created**: Rate of new pledges.
- **Settlement Volume**: Total stablecoins settled on-chain per day.
- **Disapproval Rate**: Percentage of pledges ending in a disapproval, leading to reputation hits.
- **Gas Sponsored**: Total ETH spent via the Pimlico paymaster per day.
