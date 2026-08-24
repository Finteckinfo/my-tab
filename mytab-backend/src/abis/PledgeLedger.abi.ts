export const PLEDGE_LEDGER_ABI = [
  {
    name: 'createPledge',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'debtor',       type: 'address' },
      { name: 'amount',       type: 'uint128' },
      { name: 'token',        type: 'address' },
      { name: 'dueTimestamp', type: 'uint64' },
      { name: 'track',        type: 'uint8' },   // 0 = Voluntary, 1 = Enforced
    ],
    outputs: [{ name: 'pledgeId', type: 'uint256' }],
  },
  {
    name: 'PledgeCreated',
    type: 'event',
    inputs: [
      { name: 'pledgeId',     type: 'uint256', indexed: true },
      { name: 'lender',       type: 'address', indexed: true },
      { name: 'debtor',       type: 'address', indexed: true },
      { name: 'amount',       type: 'uint128', indexed: false },
      { name: 'token',        type: 'address', indexed: false },
      { name: 'dueTimestamp', type: 'uint64',  indexed: false },
      { name: 'track',        type: 'uint8',   indexed: false },
    ],
  },
  {
    name: 'confirmPledge',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'pledgeId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'cancelPledge',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'pledgeId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'markPaidOffChain',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'pledgeId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'event',
    name: 'PledgeConfirmed',
    inputs: [
      { name: 'pledgeId', type: 'uint256', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'PledgeStatusChanged',
    inputs: [
      { name: 'pledgeId', type: 'uint256', indexed: true },
      { name: 'oldStatus', type: 'uint8', indexed: false },
      { name: 'newStatus', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'getPledge',
    inputs: [{ name: 'pledgeId', type: 'uint256' }],
    outputs: [
      {
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'lender', type: 'address' },
          { name: 'debtor', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'token', type: 'address' },
          { name: 'status', type: 'uint8' },
          { name: 'dueTimestamp', type: 'uint256' },
          { name: 'track', type: 'uint8' },
        ],
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
  },
] as const;
