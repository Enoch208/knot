import type { Pool, PoolClient } from "pg"
import { ConcurrentUpdateError, IdempotencyConflictError, LeaseRejectedError } from "./errors.ts"
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
  transactionHash: row.transaction_hash,
  state: row.state,
  reconciliation: row.reconciliation,
  version: row.version,
})

const requireLease = async (client: PoolClient, lease: WorkerLease): Promise<void> => {
  const result = await client.query(
    "SELECT id FROM jobs WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3 AND lease_expires_at > now() FOR UPDATE",
    [lease.jobId, lease.workerId, lease.fencingToken],
  )
  if (result.rowCount !== 1) {
    throw new LeaseRejectedError()
  }
}

export class ChainActionRepository {
  private readonly pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  async prepare(input: PrepareChainActionInput): Promise<ChainActionRecord> {
    return inTransaction(this.pool, async (client) => {
      await requireLease(client, input.lease)
      const inserted = await client.query<ChainActionRow>(
        "INSERT INTO chain_actions (id, job_id, session_id, task_id, action_sequence, semantic_action, signer_address, account_address, chain_id, nonce, relay_intent_id, request_hash, state) VALUES ($1, $2, $3, $4, $5, $6, lower($7), lower($8), $9, $10, $11, $12, 'PREPARED') ON CONFLICT (session_id, task_id, action_sequence) DO NOTHING RETURNING *",
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
          input.requestHash,
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
        throw new ConcurrentUpdateError("chain action")
      }
      if (
        row.id !== input.id ||
        row.job_id !== input.lease.jobId ||
        row.request_hash !== input.requestHash ||
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
