export const IDENTITY_REGISTRY_ABI = [
  {
    name: 'resolveByUsername',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'usernameHash', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'isBlacklisted',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'IdentityRegistered',
    inputs: [
      { name: 'phoneHash', type: 'bytes32', indexed: true },
      { name: 'usernameHash', type: 'bytes32', indexed: true },
      { name: 'wallet', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'BlacklistStatusChanged',
    inputs: [
      { name: 'wallet', type: 'address', indexed: true },
      { name: 'status', type: 'bool', indexed: false },
    ],
  },
] as const;
