import { z } from 'zod';

const hexAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid checksummed hex address');

export const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  AFRICASTALKING_API_KEY: z.string(),
  AFRICASTALKING_USERNAME: z.string(),
  JWT_SECRET: z.string(),
  PROTOCOL_PEPPER: z.string(),
  RELAYER_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a valid hex private key'),
  SPONSOR_SIGNER_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a valid hex private key'),
  PIMLICO_API_KEY: z.string(),
  RPC_URL: z.string().url(),
  // Deployed contract addresses
  IDENTITY_REGISTRY_ADDRESS: hexAddress,
  REPUTATION_ENGINE_ADDRESS: hexAddress,
  PLEDGE_LEDGER_ADDRESS: hexAddress,
});

export type Config = z.infer<typeof configSchema>;
