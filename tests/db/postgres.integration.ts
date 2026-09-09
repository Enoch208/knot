import assert from "node:assert/strict"
import { after, before, describe, it, test } from "node:test"
import { randomUUID } from "node:crypto"
import {
  ChainActionRepository,
  IdempotencyConflictError,
  JobRepository,
  LeaseRejectedError,
  OutboxRepository,
  createDatabasePool,
  migrateDatabase,
} from "../../packages/db/src/index.ts"

const connectionString = process.env.KNOT_TEST_DATABASE_URL?.trim()
const address = "0x1111111111111111111111111111111111111111"
const digest = `0x${"1".repeat(64)}`

if (!connectionString) {
  test("PostgreSQL persistence", { skip: "KNOT_TEST_DATABASE_URL is required" }, () => undefined)
}

const integration = connectionString ? describe : describe.skip

integration("PostgreSQL persistence", () => {
  const pool = createDatabasePool(connectionString as string, { max: 4 })
  const jobs = new JobRepository(pool)
  const actions = new ChainActionRepository(pool)
  const outbox = new OutboxRepository(pool)
  const taskId = randomUUID()
  const quoteId = randomUUID()
  const sessionId = randomUUID()
  const agentId = randomUUID()
  const quoteDomain = `${randomUUID()}.health.knot`
  const actionNonce = BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString()

  before(async () => {
    await migrateDatabase(pool)
    await pool.query(
      "INSERT INTO agents (id, chain_id, registry, agent_id, owner_address, operator_relation, metadata_hash, status) VALUES ($1, 97, $2, $3, $2, 'KNOT_OPERATED', $4, 'HIREABLE')",
      [agentId, address, actionNonce, digest],
    )
    await pool.query(
      "INSERT INTO tasks (id, buyer, schema_version, category, capability, identity_chain_id, data_chain_id, payment_chain_id, execution_chain_id, input_hash, task_spec, access_scope, deadline_at) VALUES ($1, $2, 'knot.task/1', 'health', 'analysis', 97, 56, 97, NULL, $3, '{}'::jsonb, '{}'::jsonb, now() + interval '1 hour')",
      [taskId, address, digest],
    )
    await pool.query(
      "INSERT INTO quotes (id, task_id, provider_agent_id, issuer_domain, quote_nonce, task_hash, chain_id, token, amount_units, token_decimals, binding, expires_at) VALUES ($1, $2, $3, $4, 'nonce-1', $5, 97, $6, 1, 18, '{}'::jsonb, now() + interval '1 hour')",
      [quoteId, taskId, agentId, quoteDomain, digest, address],
    )
    await pool.query(
      "INSERT INTO sessions (id, owner_address, chain_id, permissions, secret_reference, epoch, expires_at) VALUES ($1, $2, 97, '{}'::jsonb, 'test-secret', 0, now() + interval '1 hour')",
      [sessionId, address],
    )
  })

  after(async () => {
    await pool.end()
  })

  it("binds an idempotency key and atomically creates event and outbox records", async () => {
    const jobId = randomUUID()
    const input = {
      id: jobId,
      buyer: address,
      endpoint: "/api/hires/observe",
      idempotencyKey: randomUUID(),
      taskId,
      quoteId,
      workState: "DRAFT" as const,
      financialState: "UNFUNDED" as const,
    }
    const created = await jobs.create(input)
    const retried = await jobs.create(input)
    assert.equal(retried.id, created.id)
    await assert.rejects(() => jobs.create({ ...input, id: randomUUID() }), IdempotencyConflictError)
    const records = await pool.query(
      "SELECT (SELECT count(*) FROM job_events WHERE job_id = $1) AS events, (SELECT count(*) FROM outbox WHERE aggregate_id = $1) AS outbox",
      [jobId],
    )
    assert.deepEqual(records.rows[0], { events: "1", outbox: "1" })
  })

  it("fences an expired worker while allowing the current worker to advance independent states", async () => {
    const jobId = randomUUID()
    await jobs.create({
      id: jobId,
      buyer: address,
      endpoint: "/api/jobs",
      idempotencyKey: randomUUID(),
      taskId,
      quoteId,
      workState: "DRAFT",
      financialState: "UNFUNDED",
    })
    const first = await jobs.claim(jobId, "worker-1", 10_000)
    assert.ok(first)
    assert.equal(await jobs.claim(jobId, "worker-1", 10_000), null)
    const renewed = await jobs.renew(first.lease, first.job.version, 20_000)
    assert.equal(renewed.job.version, first.job.version + 1)
    await pool.query(
      "UPDATE jobs SET lease_expires_at = now() - interval '1 second', version = version + 1 WHERE id = $1",
      [jobId],
    )
    const second = await jobs.claim(jobId, "worker-2", 10_000)
    assert.ok(second)
    await assert.rejects(
      () =>
        jobs.transition({
          jobId,
          expectedVersion: first.job.version,
          lease: first.lease,
          workState: "QUOTED",
          financialState: "UNFUNDED",
          protocolState: {},
          eventType: "job.quoted",
          eventPayload: {},
        }),
      LeaseRejectedError,
    )
    const updated = await jobs.transition({
      jobId,
      expectedVersion: second.job.version,
      lease: second.lease,
      workState: "QUOTED",
      financialState: "UNFUNDED",
      protocolState: { observed: true },
      eventType: "job.quoted",
      eventPayload: { observed: true },
    })
    assert.equal(updated.workState, "QUOTED")
    assert.equal(updated.financialState, "UNFUNDED")
  })

  it("journals a chain action before submission and reconciles an unknown result", async () => {
    const jobId = randomUUID()
    await jobs.create({
      id: jobId,
      buyer: address,
      endpoint: "/api/actions",
      idempotencyKey: randomUUID(),
      taskId,
      quoteId,
      workState: "PAYMENT_OBSERVED",
      financialState: "ESCROWED",
    })
    const claim = await jobs.claim(jobId, "chain-worker", 10_000)
    assert.ok(claim)
    const bound = await jobs.transition({
      jobId,
      expectedVersion: claim.job.version,
      lease: claim.lease,
      workState: "PAYMENT_OBSERVED",
      financialState: "ESCROWED",
      protocolState: { chainJobObserved: true },
      eventType: "job.payment_observed",
      eventPayload: {},
      chainBinding: { chainId: 97, commerce: address, chainJobId: actionNonce },
    })
    assert.equal(bound.chainJobId, actionNonce)
    const prepared = await actions.prepare({
      id: randomUUID(),
      lease: claim.lease,
      sessionId,
      taskId,
      actionSequence: 0,
      semanticAction: "deliver",
      signerAddress: address,
      accountAddress: address,
      chainId: 97,
      nonce: actionNonce,
      relayIntentId: null,
      requestHash: digest,
    })
    assert.equal(prepared.state, "PREPARED")
    const txHash = `0x${"2".repeat(64)}`
    const submitted = await actions.transition(prepared.id, 0, "SUBMITTED", txHash, {}, claim.lease)
    const unknown = await actions.transition(submitted.id, 1, "UNKNOWN", null, { reason: "timeout" }, claim.lease)
    const confirmed = await actions.transition(unknown.id, 2, "CONFIRMED", null, { receiptBlock: "9" }, claim.lease)
    assert.equal(confirmed.transactionHash, txHash)
    assert.equal(confirmed.state, "CONFIRMED")
  })

  it("settles money after checked work without rewriting the final work state", async () => {
    const jobId = randomUUID()
    await jobs.create({
      id: jobId,
      buyer: address,
      endpoint: "/api/settlement",
      idempotencyKey: randomUUID(),
      taskId,
      quoteId,
      workState: "OUTPUT_CHECKED",
      financialState: "ESCROWED",
    })
    const claim = await jobs.claim(jobId, "settlement-worker", 10_000)
    assert.ok(claim)
    const settled = await jobs.transition({
      jobId,
      expectedVersion: claim.job.version,
      lease: claim.lease,
      workState: "OUTPUT_CHECKED",
      financialState: "PAID",
      protocolState: { settlementObserved: true },
      eventType: "job.settled",
      eventPayload: {},
    })
    assert.equal(settled.workState, "OUTPUT_CHECKED")
    assert.equal(settled.financialState, "PAID")
  })

  it("prevents a stale outbox publisher from acknowledging a reclaimed event", async () => {
    const first = await outbox.claim("publisher-1", 1, 10_000)
    assert.equal(first.length, 1)
    const event = first[0]
    assert.ok(event)
    await pool.query("UPDATE outbox SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [event.id])
    const second = await outbox.claim("publisher-2", 1, 10_000)
    assert.equal(second.length, 1)
    const reclaimed = second[0]
    assert.ok(reclaimed)
    await assert.rejects(
      () => outbox.markPublished(event.id, "publisher-1", event.fencingToken),
      LeaseRejectedError,
    )
    await outbox.markPublished(reclaimed.id, "publisher-2", reclaimed.fencingToken)
  })
})
