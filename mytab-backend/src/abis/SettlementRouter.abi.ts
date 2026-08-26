export const SETTLEMENT_ROUTER_ABI = [
  {
    type: 'function',
    name: 'settleOnChain',
    inputs: [{ name: 'pledgeId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'lenderRespond',
    inputs: [
      { name: 'pledgeId', type: 'uint256' },
      { name: 'approved', type: 'bool' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'executeDirectDebit',
    inputs: [{ name: 'pledgeId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'autoApproveOffChainSettlement',
    inputs: [{ name: 'pledgeId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'PledgeSettled',
    inputs: [
      { name: 'pledgeId', type: 'uint256', indexed: true },
      { name: 'debtor', type: 'address', indexed: true },
      { name: 'lender', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'token', type: 'address', indexed: false },
      { name: 'method', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'OffChainClaimDisputed',
    inputs: [
      { name: 'pledgeId', type: 'uint256', indexed: true },
      { name: 'debtor', type: 'address', indexed: true },
      { name: 'lender', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'DirectDebitFailed',
    inputs: [
      { name: 'pledgeId', type: 'uint256', indexed: true },
      { name: 'debtor', type: 'address', indexed: true },
      { name: 'reason', type: 'string', indexed: false },
    ],
  },
] as const;
