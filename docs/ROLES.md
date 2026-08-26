# MyTab Smart Contract Access Control & Roles

The MyTab smart contract system utilizes role-based access control (RBAC) via OpenZeppelin's `AccessControl` and `Ownable2Step` constructs where appropriate.

## 1. DEFAULT_ADMIN_ROLE
**Assigned to**: The MyTab Multisig (e.g., Gnosis Safe).
**Capabilities**:
- Can grant or revoke any role (including `RELAYER_ROLE`, `KEEPER_ROLE`, `UPGRADER_ROLE`).
- Can pause and unpause the `SettlementRouter` or `ReputationEngine`.
- Can manage the blacklist directly in emergencies.

## 2. UPGRADER_ROLE
**Assigned to**: The MyTab Multisig (or a dedicated timelock controller in the future).
**Capabilities**:
- Can authorize upgrades to UUPS proxy contracts (`SettlementRouter`, `ReputationEngine`, `PledgeLedger`).

## 3. RELAYER_ROLE
**Assigned to**: The MyTab Backend relayer wallets (EOAs funded for gas).
**Capabilities**:
- Can call `autoApproveOffChainSettlement` on the `SettlementRouter`.
- Can call relayer-specific methods that facilitate user operations that don't go through the bundler (e.g. system state transitions based on time/inactivity).

## 4. KEEPER_ROLE
**Assigned to**: The MyTab Backend keeper wallets (or Gelato / Chainlink Automation nodes).
**Capabilities**:
- Can call `executeDirectDebit` on the `SettlementRouter`.
- Restricted to automated state-transition functions that require no user input but must run on a schedule.

## 5. SPONSOR_ACCOUNT
**Assigned to**: The backend Paymaster Signer.
**Capabilities**:
- Not an on-chain role, but rather the EOA that signs valid UserOps for the Pimlico VerifyingPaymaster. This account determines which transactions MyTab subsidizes for users.

## 6. Smart Account (Debtor/Lender)
**Assigned to**: End users (via ERC-4337 LightAccount).
**Capabilities**:
- Creating pledges.
- Confirming pledges (debtor only).
- Canceling pledges (lender only, while pending).
- Marking pledges paid off-chain (debtor/lender).
- Settling pledges on-chain (debtor).

## 7. IdentityRegistry / Blacklisting
- A user account marked as blacklisted (either via 5+ disapprovals or manual admin action) is permanently barred from creating or confirming new pledges. They may only settle existing obligations.
- There is no appeal path for a blacklisted user.
