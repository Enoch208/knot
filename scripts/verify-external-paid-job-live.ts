import { readFileSync } from "node:fs"
import {
  type JobCreatedEvent,
  type JobFinalisedEvent,
  type JobFundedEvent,
  type JobRegisteredEvent,
  ERC8183Client,
} from "@bnbagent/sdk/erc8183"
import { createPublicClient, decodeEventLog, getAddress, http, isHex, parseAbi, type Hex, type TransactionReceipt } from "viem"
import {
  type ExternalPaidJobFailureEvidence,
  type ExternalPaidJobLiveObservation,
  type ExternalPaidJobLiveReceipt,
  externalPaidJobTransactionNames,
  reverifyExternalPaidJobSignature,
  verifyExternalPaidJobFailureEvidence,
  verifyExternalPaidJobLiveObservation,
} from "../packages/evidence/src/index.ts"

const evidencePath = process.argv[2] ?? "evidence/testnet/external-paid-job-1191.json"
const evidence = verifyExternalPaidJobFailureEvidence(JSON.parse(readFileSync(evidencePath, "utf8")))
const rpcUrl = process.env.KNOT_BSC_TESTNET_RPC ?? "https://bsc-testnet-rpc.publicnode.com"
const policy = evidence.events.registered[0]!.policy
const client = await ERC8183Client.create({
  network: {
    name: "knot-bsc-testnet-evidence",
    chainId: evidence.network.chainId,
    rpcUrl,
    usePaymaster: false,
    registryContract: evidence.network.contracts.registry,
    commerceContract: evidence.network.contracts.commerce,
    routerContract: evidence.network.contracts.router,
    policyContract: policy,
  },
})
const publicClient = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000 }) })
const receipts = {} as ExternalPaidJobLiveObservation["receipts"]

for (const name of externalPaidJobTransactionNames) {
  const receipt = await publicClient.getTransactionReceipt({ hash: asHex(evidence.transactions[name].hash) })
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber })
  receipts[name] = mapReceipt(receipt, block.timestamp)
}

const jobId = BigInt(evidence.lifecycle.jobId)
const [chainId, owner, paymentToken, jobPolicy, job, created, registered, funded, finalised, refundReceipt] = await Promise.all([
  publicClient.getChainId(),
  publicClient.readContract({
    address: getAddress(evidence.network.contracts.registry),
    abi: parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]),
    functionName: "ownerOf",
    args: [BigInt(evidence.identity.agentId)],
  }),
  client.paymentToken(),
  client.router.jobPolicy(jobId),
  client.getJob(jobId),
  client.commerce.getJobCreatedEvents(BigInt(evidence.transactions.create.blockNumber), BigInt(evidence.transactions.create.blockNumber)),
  client.router.getJobRegisteredEvents(BigInt(evidence.transactions.register.blockNumber), BigInt(evidence.transactions.register.blockNumber), evidence.identity.buyer),
  client.commerce.getJobFundedEvents(BigInt(evidence.transactions.fund.blockNumber), BigInt(evidence.transactions.fund.blockNumber), evidence.identity.provider, jobId),
  client.router.getJobFinalisedEvents(BigInt(evidence.transactions.markExpired.blockNumber), BigInt(evidence.transactions.markExpired.blockNumber)),
  publicClient.getTransactionReceipt({ hash: asHex(evidence.transactions.refund.hash) }),
])

const observation: ExternalPaidJobLiveObservation = {
  chainId,
  observedAtUtc: new Date().toISOString(),
  receipts,
  owner,
  paymentToken,
  jobPolicy,
  job: {
    id: job.id.toString(),
    client: job.client,
    provider: job.provider,
    evaluator: job.evaluator,
    description: job.description,
    budget: job.budget.toString(),
    expiredAt: job.expiredAt.toString(),
    status: Number(job.status),
    hook: job.hook,
    deliverable: job.deliverable,
    submittedAt: job.submittedAt.toString(),
  },
  events: {
    created: created.filter((event) => event.jobId === jobId).map(mapCreated),
    registered: registered.filter((event) => event.jobId === jobId).map(mapRegistered),
    funded: funded.filter((event) => event.jobId === jobId).map(mapFunded),
    finalised: finalised.filter((event) => event.jobId === jobId).map(mapFinalised),
    refundTransfers: mapRefundTransfers(refundReceipt, evidence),
  },
}

const result = verifyExternalPaidJobLiveObservation(evidence, observation)
const signatureVerification = await reverifyExternalPaidJobSignature(evidence)
process.stdout.write(`${JSON.stringify({ ...result, signatureVerification }, null, 2)}\n`)

function mapReceipt(receipt: TransactionReceipt, timestamp: bigint): ExternalPaidJobLiveReceipt {
  return {
    transactionHash: receipt.transactionHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    timestamp: timestamp.toString(),
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPriceWei: receipt.effectiveGasPrice.toString(),
    to: receipt.to,
  }
}

function mapCreated(event: JobCreatedEvent): ExternalPaidJobFailureEvidence["events"]["created"][number] {
  return {
    jobId: event.jobId.toString(),
    client: event.client,
    provider: event.provider,
    evaluator: event.evaluator,
    expiredAt: event.expiredAt.toString(),
    blockNumber: required(event.blockNumber, "created block").toString(),
    transactionHash: required(event.transactionHash, "created transaction"),
  }
}

function mapRegistered(event: JobRegisteredEvent): ExternalPaidJobFailureEvidence["events"]["registered"][number] {
  return {
    jobId: event.jobId.toString(),
    policy: event.policy,
    client: event.client,
    blockNumber: required(event.blockNumber, "registered block").toString(),
    transactionHash: required(event.transactionHash, "registered transaction"),
  }
}

function mapFunded(event: JobFundedEvent): ExternalPaidJobFailureEvidence["events"]["funded"][number] {
  return {
    jobId: event.jobId.toString(),
    client: event.client,
    provider: event.provider,
    amount: event.amount.toString(),
    blockNumber: required(event.blockNumber, "funded block").toString(),
    transactionHash: required(event.transactionHash, "funded transaction"),
  }
}

function mapFinalised(event: JobFinalisedEvent): ExternalPaidJobFailureEvidence["events"]["finalised"][number] {
  if (Number(event.status) !== 5) throw new Error("finalised event status is not EXPIRED")
  return {
    jobId: event.jobId.toString(),
    status: 5,
    blockNumber: required(event.blockNumber, "finalised block").toString(),
    transactionHash: required(event.transactionHash, "finalised transaction"),
  }
}

function mapRefundTransfers(
  receipt: TransactionReceipt,
  source: ExternalPaidJobFailureEvidence,
): ExternalPaidJobFailureEvidence["events"]["refundTransfers"] {
  const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"])
  return receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== source.network.contracts.paymentToken.toLowerCase()) return []
    try {
      const decoded = decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics })
      if (decoded.eventName !== "Transfer") return []
      return [{
        from: decoded.args.from,
        to: decoded.args.to,
        value: decoded.args.value.toString(),
        blockNumber: receipt.blockNumber.toString(),
        transactionHash: receipt.transactionHash,
      }]
    } catch {
      return []
    }
  })
}

function required<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`${label} is unavailable from the RPC`)
  return value
}

function asHex(value: string): Hex {
  if (!isHex(value, { strict: true })) throw new Error("transaction hash is not canonical hex")
  return value
}
