export const REPUTATION_ENGINE_ABI = [
  {
    name: 'requiresEnforcedTrack',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'ReputationTierChanged',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'oldTier', type: 'uint8', indexed: false },
      { name: 'newTier', type: 'uint8', indexed: false },
      { name: 'disapprovalCount', type: 'uint256', indexed: false },
    ],
  },
] as const;
