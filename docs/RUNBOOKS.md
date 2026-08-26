# MyTab Runbooks

## 1. Relayer Out of Gas
**Symptom**: `autoApproveOffChainSettlement` transactions are failing with `out of gas` or reverting at the mempool level.
**Impact**: Auto-clear 14-day window events won't fire, leaving pledges in `SettlementClaimed` status indefinitely.
**Action**:
1. Check the balance of the relayer wallet (`RELAYER_PRIVATE_KEY` address) on Base Sepolia.
2. If balance < 0.01 ETH, fund the wallet.
3. The BullMQ job will automatically retry on its next hourly schedule.

## 2. Keeper Out of Gas
**Symptom**: `executeDirectDebit` transactions failing.
**Impact**: Direct debits for `Enforced` pledges will not execute on their due date.
**Action**:
1. Check the balance of the keeper wallet (`KEEPER_PRIVATE_KEY` address) on Base Sepolia.
2. If balance < 0.01 ETH, fund the wallet.
3. The BullMQ job will automatically retry on its next 15-minute schedule.

## 3. Paymaster Out of Funds
**Symptom**: UserOps are rejected by the bundler with `paymaster balance too low` or similar.
**Impact**: Users cannot perform any sponsored actions (creating pledges, confirming, etc.). The app will appear broken to all end-users.
**Action**:
1. Log into the Pimlico Dashboard.
2. Check the balance of the Verifying Paymaster for Base Sepolia.
3. Top up the Paymaster balance via the Pimlico dashboard.

## 4. Indexer Stalled
**Symptom**: Users report that pledges they created or confirmed are not updating in the UI.
**Impact**: Backend `PledgeMirror` is out of sync with the blockchain.
**Action**:
1. Check backend logs for the `IndexerService` worker.
2. Look for RPC errors (e.g. rate limits or connection refused).
3. If the RPC is down, update `RPC_URL` in the environment to a fallback provider (e.g. Alchemy -> Infura) and restart the backend.
4. The indexer will resume from `lastIndexedBlock` in the `IndexerCursor` table.

## 5. Fiat Bridge Mismatches
**Symptom**: The daily reconciliation job logs a mismatch (e.g. `Reconciliation found X mismatches`).
**Impact**: Users' funds have left their M-Pesa account but have not been credited as stablecoins, or vice-versa.
**Action**:
1. Look up the `providerTxId` (CheckoutRequestID or ConversationID) in the Safaricom Daraja Portal.
2. Check the status in Daraja.
3. If Daraja shows success but our DB shows `processing`, manually credit/debit the user via admin tooling and update the `SettlementTransaction` status to `completed`.
4. If Daraja shows failed but our DB shows `processing`, update the `SettlementTransaction` status to `failed` and restore locks if it was an offramp.
