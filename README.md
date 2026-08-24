# MyTab

MyTab is a decentralized application for tracking and settling informal pledges and debts. It leverages Account Abstraction (ERC-4337) to provide a seamless user experience, including gasless transactions and counterfactual smart account deployment.

## Project Structure

This repository is organized into two main workspaces:

- **[`mytab-backend/`](./mytab-backend)**: A NestJS backend service that handles user registration, off-chain tracking, reputation indexing, and acts as a relayer for interacting with the smart contracts. It uses Prisma + PostgreSQL and BullMQ for background job processing (indexer and relayer).
- **[`mytab-contracts/`](./mytab-contracts)**: A Foundry project containing the core smart contracts for the MyTab protocol, including the Identity Registry, Reputation Engine, Pledge Ledger, Account Factory, and a custom Paymaster.

## Tech Stack

- **Smart Contracts**: Solidity, Foundry, ERC-4337 (Account Abstraction)
- **Backend**: NestJS, TypeScript, PostgreSQL (Prisma), Redis (BullMQ), Viem
- **Network**: Base Sepolia

## Architecture Overview

1. **Identity & Wallets**: Users register with a phone number (hashed) and are assigned a counterfactual smart account address computed deterministically via `MyTabAccountFactory`. The account is deployed lazily upon their first on-chain action.
2. **Account Abstraction**: Transactions are submitted as UserOperations. A custom paymaster (`MyTabPaymaster`) sponsors gas fees for onboarding and specific protocol interactions.
3. **Pledges**: Users can create, confirm, and settle pledges. The backend indexes events from the blockchain to keep a fast, read-optimized relational database cache of the ledger state.
4. **Reputation**: User reputation is tracked on-chain based on their history of fulfilling or defaulting on pledges. The backend aggregates this into tiers (e.g., green, amber, red) for quick UI display.

## Getting Started

### Smart Contracts

Navigate to `mytab-contracts/` to build and test the smart contracts.

```bash
cd mytab-contracts
forge build
forge test
```

### Backend

Navigate to `mytab-backend/` to run the backend service.

```bash
cd mytab-backend
npm install
npm run start:dev
```

*Note: The backend requires PostgreSQL and Redis. Ensure your `.env` is configured correctly.*

## License

MIT
