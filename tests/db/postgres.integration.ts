import assert from "node:assert/strict"
import { after, before, describe, it, test } from "node:test"
import { randomUUID } from "node:crypto"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { NegotiationHandler } from "@bnbagent/sdk/erc8183"
import { privateKeyToAccount } from "viem/accounts"
import { hashEvmTransactionIntent, type EvmTransactionIntent } from "../../packages/chain/src/transaction-intent.ts"
import { prepareServiceRequest, type ServiceRequestEnvelope } from "../../packages/contracts/src/service-request.ts"
import { taskSpec } from "../../packages/contracts/src/task.ts"
import {
  ChainActionAuthorityError,
  ChainActionIntegrityError,
  ChainActionRepository,
  Erc8004IdentityObservationRepository,
  IdempotencyConflictError,
  JobRepository,
  LeaseRejectedError,
  OutboxRepository,
  ServiceRequestRepository,
  VerifiedQuoteRepository,
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
  const serviceRequests = new ServiceRequestRepository(pool)
  const verifiedQuotes = new VerifiedQuoteRepository(pool)
  const identityObservations = new Erc8004IdentityObservationRepository(pool)
  const taskId = randomUUID()
  const quoteId = randomUUID()
  const sessionId = randomUUID()
  const agentId = randomUUID()
  const verifiedQuoteAgentId = randomUUID()
  const verifiedQuoteEndpointObservationId = randomUUID()
  const verifiedQuoteIdentityObservationId = randomUUID()
  const verifiedQuoteIdentityBlockNumber = BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString()
  const verifiedQuoteProvider = privateKeyToAccount(`0x${"34".repeat(32)}`)
  const quoteDomain = `${randomUUID()}.health.knot`
  const actionNonce = BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString()
  const serviceRequestBytes = readFileSync("evidence/advantage/rangepilot-1189/input.json")
  const retainedServiceTask = JSON.parse(readFileSync("evidence/advantage/rangepilot-1189/task.json", "utf8")) as Record<string, unknown>
  const serviceTask = taskSpec.parse({ ...retainedServiceTask, deadlineUtc: "2030-01-01T00:00:00.000Z" })
  const serviceEndpoint = "https://knot-range.truematchx.com/"
  const serviceEnvelope = (transport: "base64url" | "deflate-base64url"): ServiceRequestEnvelope => ({
    schemaVersion: "knot.service-request/1",
    task: serviceTask,
    request: {
      mediaType: "application/json",
      schemaVersion: "knot.rangepilot.request/1",
      bytesBase64url: serviceRequestBytes.toString("base64url"),
    },
    transport,
  })
  const transactionIntent = (
    actionSequence: number,
    semanticAction: string,
    nonce: string,
  ): EvmTransactionIntent => ({
    schemaVersion: "knot.evm-transaction-intent/1",
    taskId,
    actionSequence,
    semanticAction,
    signerAddress: address,
    accountAddress: address,
    chainId: 97,
    nonce,
    destination: address,
    valueUnits: "0",
    calldataHash: digest,
    gasLimit: "21000",
    gasPriceUnits: "1",
  })
  const chainActionFields = (actionSequence: number, semanticAction: string, nonce: string) => {
    const intent = transactionIntent(actionSequence, semanticAction, nonce)
    return {
      taskId,
      actionSequence,
      semanticAction,
      signerAddress: address,
      accountAddress: address,
      chainId: 97 as const,
      nonce,
      relayIntentId: null,
      requestHash: hashEvmTransactionIntent(intent),
      transactionIntent: intent,
    }
  }
  const authorityPermissions = {
    schemaVersion: "knot.chain-action-authority/1",
    actions: [
      [0, "deliver", BigInt(actionNonce)],
      [1, "fund", BigInt(actionNonce) + 1n],
      [2, "fund", BigInt(actionNonce) + 2n],
      [10, "fund", BigInt(actionNonce) + 10n],
      [11, "fund", BigInt(actionNonce) + 11n],
      [20, "fund", BigInt(actionNonce) + 20n],
      [21, "fund", BigInt(actionNonce) + 21n],
      [40, "fund", BigInt(actionNonce) + 40n],
      [41, "fund", BigInt(actionNonce) + 41n],
    ].map(([actionSequence, semanticAction, nonce]) => {
      const fields = chainActionFields(Number(actionSequence), String(semanticAction), String(nonce))
      return {
        taskId: fields.taskId,
        actionSequence: fields.actionSequence,
        semanticAction: fields.semanticAction,
        signerAddress: fields.signerAddress,
        accountAddress: fields.accountAddress,
        chainId: fields.chainId,
        nonce: fields.nonce,
        relayIntentId: fields.relayIntentId,
        requestHash: fields.requestHash,
      }
    }),
  }

  before(async () => {
    await migrateDatabase(pool)
    await pool.query(
      "INSERT INTO agents (id, chain_id, registry, agent_id, owner_address, operator_relation, metadata_hash, status) VALUES ($1, 97, $2, $3, $2, 'KNOT_OPERATED', $4, 'HIREABLE')",
      [agentId, address, actionNonce, digest],
    )
    await pool.query(
      "INSERT INTO agents (id, chain_id, registry, agent_id, owner_address, operator_relation, metadata_hash, status) VALUES ($1, 97, $2, 2297, lower($3), 'KNOT_OPERATED', $4, 'HIREABLE')",
      [verifiedQuoteAgentId, address, verifiedQuoteProvider.address, digest],
    )
    await pool.query(
      "INSERT INTO endpoint_observations (id, agent_id, endpoint, request_type, result, latency_milliseconds, safe_details, observed_at) VALUES ($1, $2, $3, 'negotiate', 'SUCCESS', 100, '{}'::jsonb, now())",
      [verifiedQuoteEndpointObservationId, verifiedQuoteAgentId, serviceEndpoint],
    )
    await identityObservations.append({
      id: verifiedQuoteIdentityObservationId,
      idempotencyKey: verifiedQuoteIdentityObservationId,
      agentRecordId: verifiedQuoteAgentId,
      chainId: 97,
      registry: address,
      agentId: "2297",
      owner: verifiedQuoteProvider.address,
      operatorRelation: "KNOT_OPERATED",
      agentWallet: verifiedQuoteProvider.address,
      tokenUri: "ipfs://verified-quote-provider",
      blockNumber: verifiedQuoteIdentityBlockNumber,
      blockHash: `0x${"5".repeat(64)}`,
      confirmations: 12,
      proxyAddress: address,
      proxyCodeHash: `0x${"6".repeat(64)}`,
      implementationAddress: `0x${"2".repeat(40)}`,
      implementationCodeHash: `0x${"7".repeat(64)}`,
      rpcAgreement: {
        schemaVersion: "knot.rpc-agreement/1",
        status: "AGREED",
        chainId: 97,
        blockNumber: verifiedQuoteIdentityBlockNumber,
        blockHash: `0x${"5".repeat(64)}`,
        minimumHeadBlockNumber: (BigInt(verifiedQuoteIdentityBlockNumber) + 11n).toString(),
        requiredConfirmations: 12,
        providerCount: 2,
        agreementCount: 2,
        providerSetHash: `0x${"8".repeat(64)}`,
      },
      observedAt: new Date(Date.now() - 60_000),
      status: "CONFIRMED",
    })
    await pool.query(
      "INSERT INTO tasks (id, buyer, schema_version, category, capability, identity_chain_id, data_chain_id, payment_chain_id, execution_chain_id, input_hash, task_spec, access_scope, deadline_at) VALUES ($1, $2, 'knot.task/1', 'health', 'analysis', 97, 56, 97, NULL, $3, '{}'::jsonb, '{}'::jsonb, now() + interval '1 hour')",
      [taskId, address, digest],
    )
    await pool.query(
      "INSERT INTO tasks (id, buyer, schema_version, category, capability, identity_chain_id, data_chain_id, payment_chain_id, execution_chain_id, input_hash, task_spec, access_scope, deadline_at) VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, '{\"visibility\":\"PRIVATE\"}'::jsonb, $12)",
      [
        serviceTask.taskId,
        "0x71b1373FcdFfBD669B85D39b2Cfb37fFb9c62930",
        serviceTask.schemaVersion,
        serviceTask.category,
        serviceTask.capability,
        serviceTask.identityChainId,
        serviceTask.dataChainId,
        serviceTask.paymentChainId,
        serviceTask.executionChainId,
        serviceTask.inputHash,
        JSON.stringify(serviceTask),
        serviceTask.deadlineUtc,
      ],
    )
    await pool.query(
      "INSERT INTO quotes (id, task_id, provider_agent_id, issuer_domain, quote_nonce, task_hash, chain_id, token, amount_units, token_decimals, binding, expires_at) VALUES ($1, $2, $3, $4, 'nonce-1', $5, 97, $6, 1, 18, '{}'::jsonb, now() + interval '1 hour')",
      [quoteId, taskId, agentId, quoteDomain, digest, address],
    )
    await pool.query(
      "INSERT INTO sessions (id, owner_address, chain_id, permissions, secret_reference, epoch, expires_at) VALUES ($1, $2, 97, $3::jsonb, 'test-secret', 0, now() + interval '1 hour')",
      [sessionId, address, JSON.stringify(authorityPermissions)],
    )
  })

  it("stores seller request bytes append-only with database-generated hashes and exact task binding", async () => {
    const id = randomUUID()
    const idempotencyKey = randomUUID()
    const input = {
      id,
      buyer: "0x71b1373FcdFfBD669B85D39b2Cfb37fFb9c62930",
      endpoint: serviceEndpoint,
      idempotencyKey,
      envelope: serviceEnvelope("deflate-base64url"),
    }
    const created = await serviceRequests.create(input)
    const retried = await serviceRequests.create(input)
    assert.equal(created.created, true)
    assert.equal(retried.created, false)
    assert.deepEqual(retried.record, created.record)
    assert.deepEqual(created.record.requestBytes, serviceRequestBytes)
    assert.equal(
      created.record.requestSha256,
      `0x${createHash("sha256").update(serviceRequestBytes).digest("hex")}`,
    )
    assert.equal(
      created.record.taskDescriptionSha256,
      `0x${createHash("sha256").update(created.record.taskDescription, "utf8").digest("hex")}`,
    )
    assert.equal(created.record.requestKeccak256, serviceTask.inputHash)
    assert.equal(created.record.inputBinding, "EXACT_REQUEST_BYTES")
    assert.deepEqual(await serviceRequests.get(id, input.buyer.toUpperCase()), created.record)
    await assert.rejects(
      () => serviceRequests.create({ ...input, id: randomUUID() }),
      IdempotencyConflictError,
    )
    const legacyEnvelope = serviceEnvelope("base64url")
    const legacy = prepareServiceRequest(legacyEnvelope, input.buyer, { enforceTaskDescriptionLimit: false })
    const legacyId = randomUUID()
    const legacyEndpoint = `${serviceEndpoint}?legacy`
    await pool.query(
      "INSERT INTO service_requests (id, buyer, endpoint, idempotency_key, task_id, task_spec_binding, category, request_schema_version, transport, request_bytes, request_keccak256, task_description, task_description_sha256, snapshot_id, task_input_hash, input_binding) VALUES ($1, lower($2), $3, $1, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)",
      [
        legacyId,
        input.buyer,
        legacyEndpoint,
        legacy.taskId,
        JSON.stringify(legacy.task),
        legacy.category,
        legacy.requestSchemaVersion,
        legacy.transport,
        serviceRequestBytes,
        legacy.requestKeccak256,
        legacy.taskDescription,
        legacy.taskDescriptionSha256,
        legacy.snapshotId,
        legacy.taskInputHash,
        legacy.inputBinding,
      ],
    )
    const preservedLegacy = await serviceRequests.get(legacyId, input.buyer)
    assert.equal(preservedLegacy?.transport, "base64url")
    assert.equal(preservedLegacy?.taskDescription, legacy.taskDescription)
    const oldImageId = randomUUID()
    await pool.query(
      "INSERT INTO service_requests (id, buyer, endpoint, idempotency_key, task_id, task_spec_binding, category, request_schema_version, transport, request_bytes, request_keccak256, task_description_sha256, snapshot_id, task_input_hash, input_binding) VALUES ($1, lower($2), $3, $1, $4, $5::jsonb, $6, $7, 'base64url', $8, $9, $10, $11, $12, $13)",
      [
        oldImageId,
        input.buyer,
        `${serviceEndpoint}?old-image`,
        legacy.taskId,
        JSON.stringify(legacy.task),
        legacy.category,
        legacy.requestSchemaVersion,
        serviceRequestBytes,
        legacy.requestKeccak256,
        legacy.taskDescriptionSha256,
        legacy.snapshotId,
        legacy.taskInputHash,
        legacy.inputBinding,
      ],
    )
    const preservedOldImageWrite = await serviceRequests.get(oldImageId, input.buyer)
    assert.equal(preservedOldImageWrite?.taskDescription, legacy.taskDescription)
    await assert.rejects(
      () => pool.query("UPDATE service_requests SET endpoint = endpoint WHERE id = $1", [id]),
      /service requests are append-only/,
    )
    await assert.rejects(
      () => pool.query("DELETE FROM service_requests WHERE id = $1", [id]),
      /service requests are append-only/,
    )
    await assert.rejects(
      () => pool.query("TRUNCATE service_requests"),
      /service requests are append-only|cannot truncate a table referenced in a foreign key constraint/,
    )
    await assert.rejects(
      () => pool.query("UPDATE tasks SET access_scope = '{\"visibility\":\"SHARED\"}'::jsonb WHERE id = $1", [serviceTask.taskId]),
      /task with a service request binding is immutable/,
    )
    await assert.rejects(
      () => pool.query(
        "INSERT INTO service_requests (id, buyer, endpoint, idempotency_key, task_id, task_spec_binding, category, request_schema_version, transport, request_bytes, request_keccak256, task_description, task_description_sha256, snapshot_id, task_input_hash, input_binding) SELECT $2, buyer, endpoint || '?copy', $3, task_id, task_spec_binding, category, request_schema_version, transport, request_bytes, request_keccak256, task_description, task_description_sha256, 'wrong-snapshot', task_input_hash, input_binding FROM service_requests WHERE id = $1",
        [id, randomUUID(), randomUUID()],
      ),
      /service request snapshot binding is invalid/,
    )
    const corruptId = randomUUID()
    const corruptDescription = "knot-json-deflate-base64url/1:e30"
    await pool.query(
      "INSERT INTO service_requests (id, buyer, endpoint, idempotency_key, task_id, task_spec_binding, category, request_schema_version, transport, request_bytes, request_keccak256, task_description, task_description_sha256, snapshot_id, task_input_hash, input_binding) SELECT $2, buyer, endpoint || '?corrupt', $3, task_id, task_spec_binding, category, request_schema_version, transport, request_bytes, request_keccak256, $4, $5, snapshot_id, task_input_hash, input_binding FROM service_requests WHERE id = $1",
      [
        id,
        corruptId,
        randomUUID(),
        corruptDescription,
        `0x${createHash("sha256").update(corruptDescription, "utf8").digest("hex")}`,
      ],
    )
    await assert.rejects(
      () => serviceRequests.get(corruptId, input.buyer),
      /stored service request failed integrity validation/,
    )
  })

  it("persists a verified owned-seller quote without creating a job or funding path", async () => {
    const serviceRequestId = randomUUID()
    const quoteRecordId = randomUUID()
    const serviceRequest = await serviceRequests.create({
      id: serviceRequestId,
      buyer: "0x71b1373FcdFfBD669B85D39b2Cfb37fFb9c62930",
      endpoint: serviceEndpoint,
      idempotencyKey: serviceRequestId,
      envelope: serviceEnvelope("deflate-base64url"),
    })
    const requestedTerms = {
      deliverables: "One deterministic RangePilot analysis artifact.",
      quality_standards: "Closed schema, pinned inputs, and fail-closed output.",
      success_criteria: ["The task and input commitment match."],
    }
    const sentRequest = {
      task_description: serviceRequest.record.taskDescription,
      terms: requestedTerms,
      request_id: serviceRequestId,
    }
    const negotiatedAt = Math.floor(Date.now() / 1_000)
    const handler = new NegotiationHandler({
      servicePrice: serviceTask.serviceFeeLimit.units,
      currency: serviceTask.serviceFeeLimit.token,
      estimatedCompletionSeconds: 600,
      quoteTtlSeconds: 900,
      chainId: 97,
      verifyingContract: "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE",
      now: () => negotiatedAt,
      walletProvider: {
        address: verifiedQuoteProvider.address,
        signMessage: async (message: string) => ({ signature: await verifiedQuoteProvider.signMessage({ message }) }),
      },
    })
    const quote = (await handler.negotiate(sentRequest)).toDict()
    const input = {
      id: quoteRecordId,
      buyer: "0x71b1373FcdFfBD669B85D39b2Cfb37fFb9c62930",
      serviceRequestId,
      providerAgentId: verifiedQuoteAgentId,
      endpointObservationId: verifiedQuoteEndpointObservationId,
      identityObservationId: verifiedQuoteIdentityObservationId,
      idempotencyKey: quoteRecordId,
      requestedTerms,
      sentRequest,
      quote,
    }
    const jobsBefore = await pool.query("SELECT count(*)::text AS count FROM jobs")
    const created = await verifiedQuotes.create(input)
    const retried = await verifiedQuotes.create(input)
    const expiredVerifiedQuotes = new VerifiedQuoteRepository(
      pool,
      () => new Date((negotiatedAt + 1_000) * 1_000),
    )
    const expiredRetry = await expiredVerifiedQuotes.create(input)
    const read = await verifiedQuotes.get(quoteRecordId, input.buyer.toUpperCase())
    const jobsAfter = await pool.query("SELECT count(*)::text AS count FROM jobs")
    assert.equal(created.created, true)
    assert.equal(retried.created, false)
    assert.deepEqual(retried.record, created.record)
    assert.equal(expiredRetry.created, false)
    assert.deepEqual(expiredRetry.record, created.record)
    assert.deepEqual(read, created.record)
    assert.equal(created.record.verifierVersion, "knot.owned-seller-quote/2")
    assert.equal(created.record.identityObservationId, verifiedQuoteIdentityObservationId)
    assert.equal(created.record.identityBlockNumber, verifiedQuoteIdentityBlockNumber)
    assert.equal(created.record.identityBlockHash, `0x${"5".repeat(64)}`)
    assert.equal(created.record.fundingPermitted, false)
    assert.deepEqual(jobsAfter.rows[0], jobsBefore.rows[0])
    await assert.rejects(
      () => pool.query("UPDATE verified_quotes SET amount_units = amount_units WHERE id = $1", [quoteRecordId]),
      /verified quotes are append-only/,
    )
    await assert.rejects(
      () => pool.query(
        "INSERT INTO verified_quotes SELECT $2, service_request_id, buyer, task_id, seller_endpoint, provider_agent_id, endpoint_observation_id, endpoint_observed_at, seller_identity_chain_id, seller_registry, seller_agent_id, seller_owner, identity_block_number, identity_block_hash, identity_observed_at, task_description_sha256, quote_payload, canonical_job_description, job_description_sha256, request_hash, response_hash, negotiation_hash, provider_signature, signature_method, signature_verification_basis, signature_verified_block_number, signature_verified_block_hash, 'knot.owned-seller-quote/1', signature_verified_at, chain_id, commerce, token, amount_units, token_decimals, negotiated_at, expires_at, $3, verified_at, created_at, identity_observation_id FROM verified_quotes WHERE id = $1",
        [quoteRecordId, randomUUID(), randomUUID()],
      ),
      /verified_quotes_verifier_identity_pair/,
    )
    await assert.rejects(
      () => pool.query(
        "INSERT INTO verified_quotes SELECT $2, service_request_id, buyer, task_id, seller_endpoint, provider_agent_id, endpoint_observation_id, endpoint_observed_at, seller_identity_chain_id, seller_registry, seller_agent_id, seller_owner, identity_block_number, $4, identity_observed_at, task_description_sha256, quote_payload, canonical_job_description, job_description_sha256, request_hash, response_hash, negotiation_hash, provider_signature, signature_method, signature_verification_basis, signature_verified_block_number, signature_verified_block_hash, verifier_version, signature_verified_at, chain_id, commerce, token, amount_units, token_decimals, negotiated_at, expires_at, $3, verified_at, created_at, identity_observation_id FROM verified_quotes WHERE id = $1",
        [quoteRecordId, randomUUID(), randomUUID(), `0x${"9".repeat(64)}`],
      ),
      /verified quote identity observation binding is invalid/,
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

  it("rechecks a job lease after waiting for its row lock", async () => {
    const transitionJobId = randomUUID()
    await jobs.create({
      id: transitionJobId,
      buyer: address,
      endpoint: "/api/actions/lease-transition",
      idempotencyKey: randomUUID(),
      taskId,
      quoteId,
      workState: "PAYMENT_OBSERVED",
      financialState: "ESCROWED",
    })
    const transitionClaim = await jobs.claim(transitionJobId, "lease-transition-worker", 10_000)
    assert.ok(transitionClaim)
    const prepared = await actions.prepare({
      id: randomUUID(),
      lease: transitionClaim.lease,
      sessionId,
      ...chainActionFields(40, "fund", `${BigInt(actionNonce) + 40n}`),
    })
    await pool.query(
      "UPDATE jobs SET lease_expires_at = clock_timestamp() + interval '150 milliseconds', version = version + 1 WHERE id = $1",
      [transitionJobId],
    )
    const transitionBlocker = await pool.connect()
    let transitionOpen = false
    try {
      await transitionBlocker.query("BEGIN")
      transitionOpen = true
      await transitionBlocker.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [transitionJobId])
      const rejected = assert.rejects(
        actions.transition(prepared.id, prepared.version, "FAILED", null, {}, transitionClaim.lease),
        LeaseRejectedError,
      )
      await new Promise((resolve) => setTimeout(resolve, 250))
      await transitionBlocker.query("COMMIT")
      transitionOpen = false
      await rejected
    } finally {
      if (transitionOpen) await transitionBlocker.query("ROLLBACK")
      transitionBlocker.release()
    }
    const transitionCleanup = await jobs.claim(transitionJobId, "lease-transition-cleanup", 10_000)
    assert.ok(transitionCleanup)
    await actions.transition(prepared.id, prepared.version, "FAILED", null, {}, transitionCleanup.lease)

    const prepareJobId = randomUUID()
    await jobs.create({
      id: prepareJobId,
      buyer: address,
      endpoint: "/api/actions/lease-prepare",
      idempotencyKey: randomUUID(),
      taskId,
      quoteId,
      workState: "PAYMENT_OBSERVED",
      financialState: "ESCROWED",
    })
    const prepareClaim = await jobs.claim(prepareJobId, "lease-prepare-worker", 10_000)
    assert.ok(prepareClaim)
    await pool.query(
      "UPDATE jobs SET lease_expires_at = clock_timestamp() + interval '150 milliseconds', version = version + 1 WHERE id = $1",
      [prepareJobId],
    )
    const prepareBlocker = await pool.connect()
    let prepareOpen = false
    try {
      await prepareBlocker.query("BEGIN")
      prepareOpen = true
      await prepareBlocker.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [prepareJobId])
      const rejected = assert.rejects(
        actions.prepare({
          id: randomUUID(),
          lease: prepareClaim.lease,
          sessionId,
          ...chainActionFields(41, "fund", `${BigInt(actionNonce) + 41n}`),
        }),
        LeaseRejectedError,
      )
      await new Promise((resolve) => setTimeout(resolve, 250))
      await prepareBlocker.query("COMMIT")
      prepareOpen = false
      await rejected
    } finally {
      if (prepareOpen) await prepareBlocker.query("ROLLBACK")
      prepareBlocker.release()
    }
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
    const prepareInput = {
      id: randomUUID(),
      lease: claim.lease,
      sessionId,
      ...chainActionFields(0, "deliver", actionNonce),
    }
    const prepared = await actions.prepare(prepareInput)
    const retried = await actions.prepare(prepareInput)
    assert.equal(retried.id, prepared.id)
    assert.equal(prepared.state, "PREPARED")
    assert.deepEqual(prepared.transactionIntent, transactionIntent(0, "deliver", actionNonce))
    await assert.rejects(
      () => actions.transition(prepared.id, prepared.version, "SUBMITTED", null, {}, claim.lease),
      ChainActionIntegrityError,
    )
    const txHash = `0x${"2".repeat(64)}`
    const submitted = await actions.transition(prepared.id, 0, "SUBMITTED", txHash, {}, claim.lease)
    await assert.rejects(
      () => actions.transition(
        submitted.id,
        submitted.version,
        "CONFIRMED",
        `0x${"3".repeat(64)}`,
        { observedTransactionHash: `0x${"3".repeat(64)}` },
        claim.lease,
      ),
      ChainActionIntegrityError,
    )
    const unknown = await actions.transition(submitted.id, 1, "UNKNOWN", null, { reason: "timeout" }, claim.lease)
    const confirmed = await actions.transition(unknown.id, 2, "CONFIRMED", null, { receiptBlock: "9" }, claim.lease)
    assert.equal(confirmed.transactionHash, txHash)
    assert.equal(confirmed.state, "CONFIRMED")
  })

  it("makes every chain action identity and intent binding immutable in PostgreSQL", async () => {
    const jobId = randomUUID()
    await jobs.create({
      id: jobId,
      buyer: address,
      endpoint: "/api/actions/immutable-binding",
      idempotencyKey: randomUUID(),
      taskId,
      quoteId,
      workState: "PAYMENT_OBSERVED",
      financialState: "ESCROWED",
    })
    const claim = await jobs.claim(jobId, "immutable-binding-worker", 10_000)
    assert.ok(claim)
    const fields = chainActionFields(2, "fund", `${BigInt(actionNonce) + 2n}`)
    const prepared = await actions.prepare({
      id: randomUUID(),
      lease: claim.lease,
      sessionId,
      ...fields,
    })
    const changedIntent = { ...fields.transactionIntent, destination: "0x2222222222222222222222222222222222222222" }
    const mutations: ReadonlyArray<readonly [string, unknown]> = [
      ["id = $2::text", randomUUID()],
      ["job_id = $2::text", randomUUID()],
      ["session_id = $2::text", randomUUID()],
      ["task_id = $2::text", randomUUID()],
      ["action_sequence = $2::integer", 99],
      ["semantic_action = $2::text", "settle"],
      ["signer_address = $2::text", "0x2222222222222222222222222222222222222222"],
      ["account_address = $2::text", "0x2222222222222222222222222222222222222222"],
      ["chain_id = $2::integer", 56],
      ["nonce = $2::numeric", `${BigInt(fields.nonce) + 1n}`],
      ["relay_intent_id = $2::text", "tampered-relay"],
      ["request_hash = $2::text", `0x${"2".repeat(64)}`],
      ["transaction_intent = $2::jsonb", JSON.stringify(changedIntent)],
      ["created_at = $2::timestamptz", "2026-09-08T00:00:00Z"],
    ]
    for (const [assignment, value] of mutations) {
      await assert.rejects(
        () => pool.query(
          `UPDATE chain_actions SET ${assignment}, state = 'UNKNOWN', version = version + 1 WHERE id = $1`,
          [prepared.id, value],
        ),
        /chain action binding is immutable/,
      )
    }
    const unchanged = await pool.query(
      "SELECT state, version, request_hash, transaction_intent FROM chain_actions WHERE id = $1",
      [prepared.id],
    )
    assert.deepEqual(unchanged.rows[0], {
      state: "PREPARED",
      version: 0,
      request_hash: fields.requestHash,
      transaction_intent: fields.transactionIntent,
    })
  })

  it("durably fences a prepared action whose broadcast outcome is unknown", async () => {
    const jobId = randomUUID()
    await jobs.create({
      id: jobId,
      buyer: address,
      endpoint: "/api/actions/recovery",
      idempotencyKey: randomUUID(),
      taskId,
      quoteId,
      workState: "PAYMENT_OBSERVED",
      financialState: "ESCROWED",
    })
    const claim = await jobs.claim(jobId, "recovery-worker", 10_000)
    assert.ok(claim)
    const prepared = await actions.prepare({
      id: randomUUID(),
      lease: claim.lease,
      sessionId,
      ...chainActionFields(1, "fund", `${BigInt(actionNonce) + 1n}`),
    })
    assert.equal(await jobs.claimChainActionRecovery("recovery-worker-2", 10_000), null)
    await pool.query(
      "UPDATE jobs SET lease_expires_at = now() - interval '1 second', version = version + 1 WHERE id = $1",
      [jobId],
    )
    const recoveryClaim = await jobs.claimChainActionRecovery("recovery-worker-2", 10_000)
    assert.ok(recoveryClaim)
    assert.equal(recoveryClaim.job.id, jobId)
    const active = await actions.nextActiveForJob(recoveryClaim.lease)
    assert.equal(active?.id, prepared.id)
    const unknown = await actions.transition(
      prepared.id,
      prepared.version,
      "UNKNOWN",
      null,
      { reason: "prepared_broadcast_unknown" },
      recoveryClaim.lease,
    )
    assert.equal(unknown.state, "UNKNOWN")
    assert.equal(unknown.transactionHash, null)
    await assert.rejects(
      () => pool.query(
        "UPDATE chain_actions SET state = 'SUBMITTED', transaction_hash = $2, version = version + 1 WHERE id = $1",
        [unknown.id, `0x${"3".repeat(64)}`],
      ),
      /invalid chain action transition from UNKNOWN to SUBMITTED/,
    )
    const recoveredHash = `0x${"4".repeat(64)}`
    const confirmed = await actions.transition(
      unknown.id,
      unknown.version,
      "CONFIRMED",
      recoveredHash,
      { receiptBlock: "10" },
      recoveryClaim.lease,
    )
    assert.equal(confirmed.state, "CONFIRMED")
    assert.equal(confirmed.transactionHash, recoveredHash)
  })

  it("rotates unresolved jobs after each recovery lease instead of starving newer work", async () => {
    const prefix = randomUUID()
    const firstJobId = `${prefix}-a`
    const secondJobId = `${prefix}-b`
    for (const [jobId, endpoint] of [
      [firstJobId, "/api/actions/fairness-a"],
      [secondJobId, "/api/actions/fairness-b"],
    ] as const) {
      await jobs.create({
        id: jobId,
        buyer: address,
        endpoint,
        idempotencyKey: randomUUID(),
        taskId,
        quoteId,
        workState: "PAYMENT_OBSERVED",
        financialState: "ESCROWED",
      })
    }
    const firstLease = await jobs.claim(firstJobId, "fairness-setup-a", 10_000)
    assert.ok(firstLease)
    await actions.prepare({
      id: randomUUID(),
      lease: firstLease.lease,
      sessionId,
      ...chainActionFields(10, "fund", `${BigInt(actionNonce) + 10n}`),
    })
    await pool.query(
      "UPDATE jobs SET lease_expires_at = now() - interval '1 second', version = version + 1 WHERE id = $1",
      [firstJobId],
    )
    const secondLease = await jobs.claim(secondJobId, "fairness-setup-b", 10_000)
    assert.ok(secondLease)
    await actions.prepare({
      id: randomUUID(),
      lease: secondLease.lease,
      sessionId,
      ...chainActionFields(11, "fund", `${BigInt(actionNonce) + 11n}`),
    })
    await pool.query(
      "UPDATE jobs SET lease_expires_at = now() - interval '1 second', version = version + 1 WHERE id = $1",
      [secondJobId],
    )
    const firstRecovery = await jobs.claimChainActionRecovery("fairness-worker-a", 10_000)
    assert.ok(firstRecovery)
    assert.equal(firstRecovery.job.id, firstJobId)
    await pool.query(
      "UPDATE jobs SET lease_expires_at = now() - interval '1 second', version = version + 1 WHERE id = $1",
      [firstJobId],
    )
    const secondRecovery = await jobs.claimChainActionRecovery("fairness-worker-b", 10_000)
    assert.ok(secondRecovery)
    assert.equal(secondRecovery.job.id, secondJobId)
  })

  it("releases only the exact fenced job lease and permits immediate reclaim", async () => {
    const jobId = randomUUID()
    await jobs.create({
      id: jobId,
      buyer: address,
      endpoint: "/api/actions/release-recovery-lease",
      idempotencyKey: randomUUID(),
      taskId,
      quoteId,
      workState: "PAYMENT_OBSERVED",
      financialState: "UNKNOWN",
    })
    const first = await jobs.claim(jobId, "release-worker-1", 30_000)
    assert.ok(first)
    assert.equal(await jobs.releaseLease(first.lease), true)
    assert.equal(await jobs.releaseLease(first.lease), false)
    const second = await jobs.claim(jobId, "release-worker-2", 30_000)
    assert.ok(second)
    assert.notEqual(second.lease.fencingToken, first.lease.fencingToken)
    assert.equal(await jobs.releaseChainActionRecovery(first.lease), false)
    const current = await jobs.get(jobId)
    assert.equal(current?.leaseOwner, second.lease.workerId)
    assert.equal(current?.fencingToken, second.lease.fencingToken)
  })

  it("rotates an attempted unknown action behind later unresolved actions in the same job", async () => {
    const jobId = randomUUID()
    await jobs.create({
      id: jobId,
      buyer: address,
      endpoint: "/api/actions/action-fairness",
      idempotencyKey: randomUUID(),
      taskId,
      quoteId,
      workState: "PAYMENT_OBSERVED",
      financialState: "UNKNOWN",
    })
    const setup = await jobs.claim(jobId, "action-fairness-setup", 10_000)
    assert.ok(setup)
    const actionIds: string[] = []
    for (const sequence of [20, 21] as const) {
      const prepared = await actions.prepare({
        id: randomUUID(),
        lease: setup.lease,
        sessionId,
        ...chainActionFields(sequence, "fund", `${BigInt(actionNonce) + BigInt(sequence)}`),
      })
      actionIds.push(prepared.id)
    }
    const first = await actions.nextActiveForJob(setup.lease)
    const second = await actions.nextActiveForJob(setup.lease)
    assert.equal(first?.id, actionIds[0])
    assert.equal(second?.id, actionIds[1])
    const attempts = await pool.query(
      "SELECT action_id, attempts FROM chain_action_recovery_attempts WHERE action_id = ANY($1::text[]) ORDER BY action_id",
      [actionIds],
    )
    assert.deepEqual(attempts.rows.map((row) => row.attempts), [1, 1])
  })

  it("upgrades legacy relay, hashless, and intentless rows into an auditable unvalidated quarantine", async () => {
    const jobId = randomUUID()
    const relayActionId = randomUUID()
    const hashlessActionId = randomUUID()
    const intentlessActionId = randomUUID()
    await jobs.create({
      id: jobId,
      buyer: address,
      endpoint: "/api/actions/legacy-upgrade",
      idempotencyKey: randomUUID(),
      taskId,
      quoteId,
      workState: "PAYMENT_OBSERVED",
      financialState: "UNKNOWN",
    })
    const client = await pool.connect()
    let transactionOpen = false
    try {
      await client.query("BEGIN")
      transactionOpen = true
      await client.query("ALTER TABLE chain_actions DROP CONSTRAINT chain_actions_transaction_hash_required")
      await client.query("ALTER TABLE chain_actions DROP CONSTRAINT chain_actions_nonce_locator")
      await client.query("ALTER TABLE chain_actions DROP CONSTRAINT chain_actions_transaction_intent_required")
      await client.query(
        "INSERT INTO chain_actions (id, job_id, session_id, task_id, action_sequence, semantic_action, signer_address, account_address, chain_id, nonce, relay_intent_id, request_hash, transaction_hash, state) VALUES ($1, $4, $5, $6, 30, 'legacy-relay', $7, $7, 97, NULL, 'legacy-relay-id', $8, NULL, 'PREPARED'), ($2, $4, $5, $6, 31, 'legacy-hashless', $7, $7, 97, $9, NULL, $8, NULL, 'SUBMITTED'), ($3, $4, $5, $6, 32, 'legacy-intentless', $7, $7, 97, $10, NULL, $8, NULL, 'PREPARED')",
        [
          relayActionId,
          hashlessActionId,
          intentlessActionId,
          jobId,
          sessionId,
          taskId,
          address,
          digest,
          `${BigInt(actionNonce) + 31n}`,
          `${BigInt(actionNonce) + 32n}`,
        ],
      )
      await client.query("ALTER TABLE chain_actions ADD CONSTRAINT chain_actions_transaction_hash_required CHECK (state NOT IN ('SUBMITTED', 'CONFIRMED') OR transaction_hash IS NOT NULL) NOT VALID")
      await client.query("ALTER TABLE chain_actions ADD CONSTRAINT chain_actions_nonce_locator CHECK (nonce IS NOT NULL AND relay_intent_id IS NULL) NOT VALID")
      await client.query("ALTER TABLE chain_actions ADD CONSTRAINT chain_actions_transaction_intent_required CHECK (transaction_intent IS NOT NULL) NOT VALID")
      const violations = await client.query(
        "SELECT id FROM chain_action_legacy_violations WHERE id = ANY($1::text[]) ORDER BY id",
        [[relayActionId, hashlessActionId, intentlessActionId]],
      )
      assert.equal(violations.rowCount, 3)
      await client.query("SAVEPOINT new_rows_are_enforced")
      await assert.rejects(
        () => client.query(
          "INSERT INTO chain_actions (id, job_id, session_id, task_id, action_sequence, semantic_action, signer_address, account_address, chain_id, nonce, relay_intent_id, request_hash, transaction_intent, state) VALUES ($1, $2, $3, $4, 33, 'new-relay', $5, $5, 97, NULL, 'new-relay-id', $6, $7::jsonb, 'PREPARED')",
          [randomUUID(), jobId, sessionId, taskId, address, digest, JSON.stringify(transactionIntent(33, "new-relay", "33"))],
        ),
        /chain_actions_nonce_locator/,
      )
      await client.query("ROLLBACK TO SAVEPOINT new_rows_are_enforced")
      await client.query("SAVEPOINT transaction_intent_is_enforced")
      await assert.rejects(
        () => client.query(
          "INSERT INTO chain_actions (id, job_id, session_id, task_id, action_sequence, semantic_action, signer_address, account_address, chain_id, nonce, relay_intent_id, request_hash, state) VALUES ($1, $2, $3, $4, 34, 'new-intentless', $5, $5, 97, $6, NULL, $7, 'PREPARED')",
          [randomUUID(), jobId, sessionId, taskId, address, `${BigInt(actionNonce) + 34n}`, digest],
        ),
        /chain_actions_transaction_intent_required/,
      )
      await client.query("ROLLBACK TO SAVEPOINT transaction_intent_is_enforced")
      await client.query("COMMIT")
      transactionOpen = false
    } finally {
      if (transactionOpen) await client.query("ROLLBACK")
      client.release()
    }

    const explicitClaim = await jobs.claim(jobId, "legacy-audit-worker", 10_000)
    assert.ok(explicitClaim)
    assert.equal(await actions.nextActiveForJob(explicitClaim.lease), null)
    const priorLeases = await pool.query<{ id: string; lease_expires_at: Date | null }>(
      "SELECT id, lease_expires_at FROM jobs WHERE id <> $1 AND lease_owner IS NOT NULL",
      [jobId],
    )
    await pool.query(
      "UPDATE jobs SET lease_expires_at = clock_timestamp() + interval '1 hour', version = version + 1 WHERE id <> $1 AND lease_owner IS NOT NULL",
      [jobId],
    )
    try {
      await pool.query(
        "UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second', version = version + 1 WHERE id = $1",
        [jobId],
      )
      assert.equal(await jobs.claimChainActionRecovery("legacy-recovery-worker", 10_000), null)
    } finally {
      for (const row of priorLeases.rows) {
        await pool.query("UPDATE jobs SET lease_expires_at = $2, version = version + 1 WHERE id = $1", [
          row.id,
          row.lease_expires_at,
        ])
      }
    }
  })

  it("rejects actions detached from the job task or a current authority session", async () => {
    const jobId = randomUUID()
    await jobs.create({
      id: jobId,
      buyer: address,
      endpoint: "/api/actions/authority",
      idempotencyKey: randomUUID(),
      taskId,
      quoteId,
      workState: "PAYMENT_OBSERVED",
      financialState: "ESCROWED",
    })
    const claim = await jobs.claim(jobId, "authority-worker", 10_000)
    assert.ok(claim)
    const expiredSessionId = randomUUID()
    const revokedSessionId = randomUUID()
    const wrongChainSessionId = randomUUID()
    const wrongOwnerSessionId = randomUUID()
    const emptyPermissionSessionId = randomUUID()
    await pool.query(
      "INSERT INTO sessions (id, owner_address, chain_id, permissions, secret_reference, epoch, expires_at, revoked_at) VALUES ($1, $6, 97, $7::jsonb, 'expired', 0, now() - interval '1 second', NULL), ($2, $6, 97, $7::jsonb, 'revoked', 0, now() + interval '1 hour', now()), ($3, $6, 56, $7::jsonb, 'wrong-chain', 0, now() + interval '1 hour', NULL), ($4, $8, 97, $7::jsonb, 'wrong-owner', 0, now() + interval '1 hour', NULL), ($5, $6, 97, '{}'::jsonb, 'empty-permission', 0, now() + interval '1 hour', NULL)",
      [
        expiredSessionId,
        revokedSessionId,
        wrongChainSessionId,
        wrongOwnerSessionId,
        emptyPermissionSessionId,
        address,
        JSON.stringify(authorityPermissions),
        "0x2222222222222222222222222222222222222222",
      ],
    )
    const input = {
      id: randomUUID(),
      lease: claim.lease,
      sessionId,
      ...chainActionFields(2, "fund", `${BigInt(actionNonce) + 2n}`),
    }
    await assert.rejects(() => actions.prepare({ ...input, taskId: randomUUID() }), ChainActionAuthorityError)
    await assert.rejects(() => actions.prepare({ ...input, sessionId: expiredSessionId }), ChainActionAuthorityError)
    await assert.rejects(() => actions.prepare({ ...input, sessionId: revokedSessionId }), ChainActionAuthorityError)
    await assert.rejects(() => actions.prepare({ ...input, sessionId: wrongChainSessionId }), ChainActionAuthorityError)
    await assert.rejects(() => actions.prepare({ ...input, sessionId: wrongOwnerSessionId }), ChainActionAuthorityError)
    await assert.rejects(() => actions.prepare({ ...input, sessionId: emptyPermissionSessionId }), ChainActionAuthorityError)
    await assert.rejects(() => actions.prepare({ ...input, semanticAction: "settle" }), ChainActionAuthorityError)
    await assert.rejects(
      () => actions.prepare({ ...input, accountAddress: "0x2222222222222222222222222222222222222222" }),
      ChainActionAuthorityError,
    )
    await assert.rejects(() => actions.prepare({ ...input, nonce: `${BigInt(input.nonce) + 1n}` }), ChainActionAuthorityError)
    await assert.rejects(() => actions.prepare({ ...input, requestHash: `0x${"2".repeat(64)}` }), ChainActionAuthorityError)
    await assert.rejects(
      () => actions.prepare({
        ...input,
        transactionIntent: {
          ...input.transactionIntent,
          destination: "0x2222222222222222222222222222222222222222",
        },
      }),
      ChainActionIntegrityError,
    )
    await assert.rejects(
      () => actions.prepare({ ...input, nonce: null, relayIntentId: "unsupported-relay-intent" }),
      ChainActionIntegrityError,
    )
  })

  it("serializes session revocation before action authorization", async () => {
    const jobId = randomUUID()
    const racingSessionId = randomUUID()
    await jobs.create({
      id: jobId,
      buyer: address,
      endpoint: "/api/actions/revocation-race",
      idempotencyKey: randomUUID(),
      taskId,
      quoteId,
      workState: "PAYMENT_OBSERVED",
      financialState: "ESCROWED",
    })
    const claim = await jobs.claim(jobId, "revocation-race-worker", 10_000)
    assert.ok(claim)
    await pool.query(
      "INSERT INTO sessions (id, owner_address, chain_id, permissions, secret_reference, epoch, expires_at) VALUES ($1, $2, 97, $3::jsonb, 'revocation-race', 0, now() + interval '1 hour')",
      [racingSessionId, address, JSON.stringify(authorityPermissions)],
    )
    const revoker = await pool.connect()
    let transactionOpen = true
    try {
      await revoker.query("BEGIN")
      await revoker.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [racingSessionId])
      const preparing = actions.prepare({
        id: randomUUID(),
        lease: claim.lease,
        sessionId: racingSessionId,
        ...chainActionFields(2, "fund", `${BigInt(actionNonce) + 2n}`),
      })
      const state = await Promise.race([
        preparing.then(() => "settled", () => "settled"),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 25)),
      ])
      assert.equal(state, "blocked")
      await revoker.query("COMMIT")
      transactionOpen = false
      await assert.rejects(preparing, ChainActionAuthorityError)
    } finally {
      if (transactionOpen) await revoker.query("ROLLBACK")
      revoker.release()
    }
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

  it("releases only the exact fenced outbox lease and permits immediate reclaim", async () => {
    const first = await outbox.claim("release-publisher-1", 1, 10_000)
    assert.equal(first.length, 1)
    const event = first[0]
    assert.ok(event)
    assert.equal(await outbox.releaseLease(event), true)
    assert.equal(await outbox.releaseLease(event), false)
    const second = await outbox.claim("release-publisher-2", 1, 10_000)
    assert.equal(second.length, 1)
    const reclaimed = second[0]
    assert.ok(reclaimed)
    assert.equal(reclaimed.id, event.id)
    assert.notEqual(reclaimed.fencingToken, event.fencingToken)
    assert.equal(await outbox.releaseLease(event), false)
    await outbox.markPublished(reclaimed.id, reclaimed.leaseOwner, reclaimed.fencingToken)
  })
})
