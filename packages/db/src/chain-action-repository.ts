import type { Pool, PoolClient } from "pg"
import {
  canonicalEvmTransactionIntentJson,
  hashEvmTransactionIntent,
  parseEvmTransactionIntent,
  type EvmTransactionIntent,
} from "../../chain/src/transaction-intent.ts"
import { requireChainActionAuthority } from "./chain-action-authority.ts"
import {
  ChainActionIntegrityError,
  ConcurrentUpdateError,
  IdempotencyConflictError,
  LeaseRejectedError,
} from "./errors.ts"
import { assertChainActionTransition } from "./state-machine.ts"
import { inTransaction } from "./transaction.ts"
import type { ChainActionState, WorkerLease } from "./types.ts"

export interface ChainActionRecord {
  id: string
  jobId: string
  sessionId: string
  taskId: string
  actionSequence: number
  semanticAction: string
  signerAddress: string
  accountAddress: string
  chainId: 56 | 97
  nonce: string | null
  relayIntentId: string | null
  requestHash: string
  transactionIntent: EvmTransactionIntent | null
  transactionHash: string | null
  state: ChainActionState
  reconciliation: unknown
  version: number
}

interface ChainActionRow {
  id: string
  job_id: string
  session_id: string
  task_id: string
  action_sequence: number
  semantic_action: string
  signer_address: string
  account_address: string
  chain_id: 56 | 97
  nonce: string | null
  relay_intent_id: string | null
  request_hash: string
  transaction_intent: unknown | null
  transaction_hash: string | null
  state: ChainActionState
  reconciliation: unknown
  version: number
}

export interface PrepareChainActionInput {
  id: string
  lease: WorkerLease
  sessionId: string
  taskId: string
  actionSequence: number
  semanticAction: string
  signerAddress: string
  accountAddress: string
  chainId: 56 | 97
  nonce: string | null
  relayIntentId: string | null
  requestHash: string
  transactionIntent: unknown
}

const parseTransactionIntent = (input: unknown): EvmTransactionIntent => {
  try {
    return parseEvmTransactionIntent(input)
  } catch {
    throw new ChainActionIntegrityError("chain action transaction intent is invalid")
  }
}

const mapAction = (row: ChainActionRow): ChainActionRecord => ({
  id: row.id,
  jobId: row.job_id,
  sessionId: row.session_id,
  taskId: row.task_id,
  actionSequence: row.action_sequence,
  semanticAction: row.semantic_action,
  signerAddress: row.signer_address,
  accountAddress: row.account_address,
  chainId: row.chain_id,
  nonce: row.nonce,
  relayIntentId: row.relay_intent_id,
  requestHash: row.request_hash,
  transactionIntent: row.transaction_intent === null ? null : parseTransactionIntent(row.transaction_intent),
  transactionHash: row.transaction_hash,
  state: row.state,
  reconciliation: row.reconciliation,
  version: row.version,
})

const requireLease = async (client: PoolClient, lease: WorkerLease): Promise<void> => {
  const locked = await client.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [lease.jobId])
  if (locked.rowCount !== 1) {
    throw new LeaseRejectedError()
  }
  const current = await client.query(
    "SELECT id FROM jobs WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3 AND lease_expires_at > clock_timestamp()",
    [lease.jobId, lease.workerId, lease.fencingToken],
  )
  if (current.rowCount !== 1) {
    throw new LeaseRejectedError()
  }
}

export class ChainActionRepository {
  private readonly pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  async nextActiveForJob(lease: WorkerLease): Promise<ChainActionRecord | null> {
    return inTransaction(this.pool, async (client) => {
      await requireLease(client, lease)
      const result = await client.query<ChainActionRow>(
        "SELECT chain_actions.* FROM chain_actions LEFT JOIN chain_action_recovery_attempts ON chain_action_recovery_attempts.action_id = chain_actions.id WHERE chain_actions.job_id = $1 AND chain_actions.state IN ('PREPARED', 'SUBMITTED', 'UNKNOWN') AND chain_actions.nonce IS NOT NULL AND chain_actions.relay_intent_id IS NULL AND chain_actions.transaction_intent IS NOT NULL AND (chain_actions.state <> 'SUBMITTED' OR chain_actions.transaction_hash IS NOT NULL) ORDER BY coalesce(chain_action_recovery_attempts.attempted_at, chain_actions.updated_at), chain_actions.action_sequence, chain_actions.id LIMIT 1 FOR UPDATE OF chain_actions",
        [lease.jobId],
      )
      const row = result.rows[0]
      if (!row) return null
      await client.query(
        "INSERT INTO chain_action_recovery_attempts (action_id, attempted_at, attempts) VALUES ($1, now(), 1) ON CONFLICT (action_id) DO UPDATE SET attempted_at = now(), attempts = chain_action_recovery_attempts.attempts + 1",
        [row.id],
      )
      return mapAction(row)
    })
  }

  async prepare(input: PrepareChainActionInput): Promise<ChainActionRecord> {
    if (input.nonce === null || input.relayIntentId !== null) {
      throw new ChainActionIntegrityError("chain actions require one nonce locator; relay intents are unsupported")
    }
    const transactionIntent = parseTransactionIntent(input.transactionIntent)
    const canonicalTransactionIntent = canonicalEvmTransactionIntentJson(transactionIntent)
    const requestHash = hashEvmTransactionIntent(transactionIntent)
    return inTransaction(this.pool, async (client) => {
      await requireLease(client, input.lease)
      await requireChainActionAuthority(client, { ...input, jobId: input.lease.jobId })
      if (
        requestHash.toLowerCase() !== input.requestHash.toLowerCase() ||
        transactionIntent.taskId !== input.taskId ||
        transactionIntent.actionSequence !== input.actionSequence ||
        transactionIntent.semanticAction !== input.semanticAction ||
        transactionIntent.signerAddress !== input.signerAddress.toLowerCase() ||
        transactionIntent.accountAddress !== input.accountAddress.toLowerCase() ||
        transactionIntent.chainId !== input.chainId ||
        transactionIntent.nonce !== input.nonce
      ) {
        throw new ChainActionIntegrityError("chain action transaction intent does not match its authority envelope")
      }
      const inserted = await client.query<ChainActionRow>(
        "INSERT INTO chain_actions (id, job_id, session_id, task_id, action_sequence, semantic_action, signer_address, account_address, chain_id, nonce, relay_intent_id, request_hash, transaction_intent, state) SELECT $1, $2, $3, $4, $5, $6, lower($7), lower($8), $9, $10, $11, $12, $13::jsonb, 'PREPARED' FROM sessions WHERE sessions.id = $3 AND sessions.revoked_at IS NULL AND sessions.expires_at > clock_timestamp() ON CONFLICT (session_id, task_id, action_sequence) DO NOTHING RETURNING *",
        [
          input.id,
          input.lease.jobId,
          input.sessionId,
          input.taskId,
          input.actionSequence,
          input.semanticAction,
          input.signerAddress,
          input.accountAddress,
          input.chainId,
          input.nonce,
          input.relayIntentId,
          requestHash,
          canonicalTransactionIntent,
        ],
      )
      if (inserted.rows[0]) {
        return mapAction(inserted.rows[0])
      }
      const existing = await client.query<ChainActionRow>(
        "SELECT * FROM chain_actions WHERE session_id = $1 AND task_id = $2 AND action_sequence = $3",
        [input.sessionId, input.taskId, input.actionSequence],
      )
      const row = existing.rows[0]
      if (!row) {
        await requireChainActionAuthority(client, { ...input, jobId: input.lease.jobId })
        throw new ConcurrentUpdateError("chain action")
      }
      if (
        row.id !== input.id ||
        row.job_id !== input.lease.jobId ||
        row.request_hash.toLowerCase() !== requestHash.toLowerCase() ||
        row.transaction_intent === null ||
        canonicalEvmTransactionIntentJson(row.transaction_intent) !== canonicalTransactionIntent ||
        row.semantic_action !== input.semanticAction ||
        row.signer_address !== input.signerAddress.toLowerCase() ||
        row.account_address !== input.accountAddress.toLowerCase() ||
        row.chain_id !== input.chainId ||
        row.nonce !== input.nonce ||
        row.relay_intent_id !== input.relayIntentId
      ) {
        throw new IdempotencyConflictError()
      }
      return mapAction(row)
    })
  }

  async transition(
    actionId: string,
    expectedVersion: number,
    nextState: ChainActionState,
    transactionHash: string | null,
    reconciliation: Readonly<Record<string, unknown>>,
    lease: WorkerLease,
  ): Promise<ChainActionRecord> {
    return inTransaction(this.pool, async (client) => {
      await requireLease(client, lease)
      const current = await client.query<ChainActionRow>("SELECT * FROM chain_actions WHERE id = $1 FOR UPDATE", [
        actionId,
      ])
      const row = current.rows[0]
      if (!row || row.version !== expectedVersion || row.job_id !== lease.jobId) {
        throw new ConcurrentUpdateError("chain action")
      }
      assertChainActionTransition(row.state, nextState)
      const resultingTransactionHash = row.transaction_hash ?? transactionHash
      if (
        row.transaction_hash !== null &&
        transactionHash !== null &&
        row.transaction_hash.toLowerCase() !== transactionHash.toLowerCase()
      ) {
        throw new ChainActionIntegrityError("chain action transaction hash conflicts with the journaled hash")
      }
      if ((nextState === "SUBMITTED" || nextState === "CONFIRMED") && resultingTransactionHash === null) {
        throw new ChainActionIntegrityError(`${nextState.toLowerCase()} chain action requires a transaction hash`)
      }
      const updated = await client.query<ChainActionRow>(
        "UPDATE chain_actions SET state = $2, transaction_hash = CASE WHEN transaction_hash IS NULL THEN $3 ELSE transaction_hash END, reconciliation = $4::jsonb, version = version + 1 WHERE id = $1 AND version = $5 RETURNING *",
        [actionId, nextState, transactionHash, JSON.stringify(reconciliation), expectedVersion],
      )
      const updatedRow = updated.rows[0]
      if (!updatedRow) {
        throw new ConcurrentUpdateError("chain action")
      }
      return mapAction(updatedRow)
    })
  }
}
