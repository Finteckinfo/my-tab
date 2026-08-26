import { z } from 'zod';

const hexAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid checksummed hex address');

export const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
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
  SETTLEMENT_ROUTER_ADDRESS: hexAddress.optional().default('0x545A57F8076E7a7B50215bC53FC3038b8dD5897b'),
  // Fiat bridge (sandbox only)
  FIAT_ENABLED: z.string().optional().default('false'),
  MPESA_CONSUMER_KEY: z.string().optional().default('sandbox-key'),
  MPESA_CONSUMER_SECRET: z.string().optional().default('sandbox-secret'),
  MPESA_SHORTCODE: z.string().optional().default('174379'),
  MPESA_PASSKEY: z.string().optional().default('bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919'),
  MPESA_INITIATOR: z.string().optional().default('testapi'),
  MPESA_SECURITY_CREDENTIAL: z.string().optional().default('sandbox-credential'),
  MPESA_CALLBACK_URL: z.string().optional().default('https://localhost:3000/fiat/webhook/onramp'),
  MPESA_B2C_RESULT_URL: z.string().optional().default('https://localhost:3000/fiat/webhook/offramp'),
  MPESA_TIMEOUT_URL: z.string().optional().default('https://localhost:3000/fiat/webhook/timeout'),
});

export type Config = z.infer<typeof configSchema>;
