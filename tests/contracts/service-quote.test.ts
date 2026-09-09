import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { NegotiationHandler } from "@bnbagent/sdk/erc8183"
import { hashMessage, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  ServiceQuoteVerificationError,
  recheckOwnedSellerQuoteIntegrity,
  verifyOwnedSellerQuote,
  type OwnedSellerQuoteExpectation,
  type VerifyOwnedSellerQuoteInput,
} from "../../packages/contracts/src/service-quote.ts"

const NOW = 2_000_000_000
const PRICE = "100000000000000000"
const TOKEN = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565"
const COMMERCE = "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE"
const OTHER = "0x1111111111111111111111111111111111111111"
const REQUEST_ID = "knot-request-0000000001"
const account = privateKeyToAccount(`0x${"12".repeat(32)}`)

const terms = {
  deliverables: "One deterministic KNOT analysis artifact.",
  quality_standards: "Closed schema, pinned inputs, and fail-closed output.",
  success_criteria: ["The task identifier and input commitment match."],
}

interface FixtureOptions {
  taskDescription?: string
  requestTerms?: typeof terms
  requestId?: string | null
  contextUrls?: string[]
  price?: string
  currency?: string
  chainId?: number | null
  verifyingContract?: string | null
  ttl?: number
}

const makeFixture = async (options: FixtureOptions = {}): Promise<VerifyOwnedSellerQuoteInput> => {
  const requestTerms = structuredClone(options.requestTerms ?? terms)
  const sentRequest: Record<string, unknown> = {
    task_description: options.taskDescription ?? "knot-json-base64url/1:ZXhhY3QtcmVxdWVzdA",
    terms: requestTerms,
  }
  if (options.requestId !== null) sentRequest.request_id = options.requestId ?? REQUEST_ID
  if (options.contextUrls !== undefined) sentRequest.context_urls = options.contextUrls
  const handler = new NegotiationHandler({
    servicePrice: options.price ?? PRICE,
    currency: options.currency ?? TOKEN,
    estimatedCompletionSeconds: 600,
    quoteTtlSeconds: options.ttl ?? 900,
    chainId: options.chainId === undefined ? 97 : options.chainId,
    verifyingContract: options.verifyingContract === undefined ? COMMERCE : options.verifyingContract,
    now: () => NOW,
    walletProvider: {
      address: account.address,
      signMessage: async (message: string) => ({ signature: await account.signMessage({ message }) }),
    },
  })
  const quote = (await handler.negotiate(sentRequest)).toDict()
  const expected: OwnedSellerQuoteExpectation = {
    provider: account.address,
    providerKind: "eoa",
    chainId: 97,
    verifyingContract: COMMERCE,
    currency: TOKEN,
    maxPriceUnits: PRICE,
    taskDescription: sentRequest.task_description as string,
    terms: structuredClone(sentRequest.terms as typeof terms),
    requestId: (sentRequest.request_id ?? REQUEST_ID) as string,
  }
  return { sentRequest, quote, expected, nowUnix: NOW + 1, maxFutureSkewSeconds: 30 }
}

const expectCode = async (
  input: VerifyOwnedSellerQuoteInput,
  code: ServiceQuoteVerificationError["code"],
): Promise<void> => {
  await assert.rejects(
    () => verifyOwnedSellerQuote(input),
    (error: unknown) => error instanceof ServiceQuoteVerificationError && error.code === code,
  )
}

const cloned = <T>(value: T): T => structuredClone(value)

test("verifies an exact BSC testnet owned-seller EIP-191 quote", async () => {
  const input = await makeFixture()
  const result = await verifyOwnedSellerQuote(input)
  assert.equal(result.status, "VERIFIED_EOA")
  assert.equal(result.provider, account.address.toLowerCase())
  assert.equal(result.chainId, 97)
  assert.equal(result.verifyingContract, COMMERCE.toLowerCase())
  assert.equal(result.currency, TOKEN.toLowerCase())
  assert.equal(result.priceUnits, PRICE)
  assert.equal(result.requestId, REQUEST_ID)
  assert.ok(Buffer.byteLength(result.canonicalJobDescription, "utf8") <= 4096)
  assert.equal(JSON.parse(result.canonicalJobDescription).negotiation_hash, result.negotiationHash)
  assert.deepEqual(result.quote, input.quote)
  assert.notStrictEqual(result.quote, input.quote)
})

test("synchronously rechecks strict payload integrity without claiming signature verification", async () => {
  const input = await makeFixture()
  const result = recheckOwnedSellerQuoteIntegrity(input.quote)
  assert.equal(result.status, "INTEGRITY_CHECKED_NOT_SIGNATURE_VERIFIED")
  assert.equal(result.requestHash, (input.quote as { request_hash: string }).request_hash)
  assert.equal(result.responseHash, (input.quote as { response_hash: string }).response_hash)
  assert.equal(result.negotiationHash, (input.quote as { negotiation_hash: string }).negotiation_hash)
  assert.deepEqual(result.quote, input.quote)
})

test("rejects unknown keys at every quote and sent-request layer", async (context) => {
  const mutations: Array<[string, (input: VerifyOwnedSellerQuoteInput) => void, ServiceQuoteVerificationError["code"]]> = [
    ["sent request", (input) => { (input.sentRequest as Record<string, unknown>).extra = true }, "INVALID_SENT_REQUEST"],
    ["sent terms", (input) => { ((input.sentRequest as { terms: Record<string, unknown> }).terms).extra = true }, "INVALID_SENT_REQUEST"],
    ["quote envelope", (input) => { (input.quote as Record<string, unknown>).extra = true }, "INVALID_QUOTE"],
    ["quote request", (input) => { ((input.quote as { request: Record<string, unknown> }).request).extra = true }, "INVALID_QUOTE"],
    ["quote request terms", (input) => { ((input.quote as { request: { terms: Record<string, unknown> } }).request.terms).extra = true }, "INVALID_QUOTE"],
    ["quote response", (input) => { ((input.quote as { response: Record<string, unknown> }).response).extra = true }, "INVALID_QUOTE"],
    ["quote response terms", (input) => { ((input.quote as { response: { terms: Record<string, unknown> } }).response.terms).extra = true }, "INVALID_QUOTE"],
  ]
  for (const [name, mutate, code] of mutations) {
    await context.test(name, async () => {
      const input = await makeFixture()
      mutate(input)
      await expectCode(input, code)
    })
  }
})

test("rejects context URLs and missing or mismatched replay nonce request IDs", async (context) => {
  await context.test("context URLs", async () => {
    await expectCode(await makeFixture({ contextUrls: ["https://example.com/context"] }), "CONTEXT_URLS_FORBIDDEN")
  })
  await context.test("missing request ID", async () => {
    await expectCode(await makeFixture({ requestId: null }), "INVALID_SENT_REQUEST")
  })
  await context.test("unexpected request ID", async () => {
    const input = await makeFixture()
    input.expected = { ...input.expected, requestId: "knot-request-9999999999" }
    await expectCode(input, "REQUEST_BINDING_MISMATCH")
  })
  await context.test("quote from another request ID", async () => {
    const original = await makeFixture()
    const replay = await makeFixture({ requestId: "knot-request-0000000002" })
    original.quote = replay.quote
    await expectCode(original, "REQUEST_BINDING_MISMATCH")
  })
})

test("rejects task-description and requested-term substitution", async (context) => {
  await context.test("expected task", async () => {
    const input = await makeFixture()
    input.expected = { ...input.expected, taskDescription: `${input.expected.taskDescription}changed` }
    await expectCode(input, "REQUEST_BINDING_MISMATCH")
  })
  await context.test("quoted task", async () => {
    const input = await makeFixture()
    ;(input.quote as { request: { task_description: string } }).request.task_description += "changed"
    await expectCode(input, "REQUEST_BINDING_MISMATCH")
  })
  for (const field of ["deliverables", "quality_standards"] as const) {
    await context.test(field, async () => {
      const input = await makeFixture()
      input.expected = { ...input.expected, terms: { ...input.expected.terms, [field]: `${input.expected.terms[field]} changed` } }
      await expectCode(input, "REQUEST_BINDING_MISMATCH")
    })
  }
  await context.test("success criteria", async () => {
    const input = await makeFixture()
    input.expected = { ...input.expected, terms: { ...input.expected.terms, success_criteria: ["different"] } }
    await expectCode(input, "REQUEST_BINDING_MISMATCH")
  })
})

test("rejects strings whose signed claim representation differs", async (context) => {
  await context.test("task description", async () => {
    await expectCode(await makeFixture({ taskDescription: "knot-json-base64url/1:[unsafe]" }), "SANITIZATION_MISMATCH")
  })
  await context.test("deliverables", async () => {
    await expectCode(await makeFixture({ requestTerms: { ...terms, deliverables: "Return [unsafe] output." } }), "SANITIZATION_MISMATCH")
  })
  await context.test("quality standards", async () => {
    await expectCode(await makeFixture({ requestTerms: { ...terms, quality_standards: "No control\u0001characters." } }), "SANITIZATION_MISMATCH")
  })
  await context.test("success criteria", async () => {
    await expectCode(await makeFixture({ requestTerms: { ...terms, success_criteria: ["Match [unsafe] markers."] } }), "SANITIZATION_MISMATCH")
  })
})

test("rejects absent or wrong chain, commerce contract, and payment token", async (context) => {
  await context.test("missing chain", async () => {
    const input = await makeFixture()
    delete (input.quote as { chain_id?: number }).chain_id
    await expectCode(input, "INVALID_QUOTE")
  })
  await context.test("wrong chain", async () => {
    await expectCode(await makeFixture({ chainId: 56 }), "DOMAIN_MISMATCH")
  })
  await context.test("missing commerce", async () => {
    const input = await makeFixture({ verifyingContract: null })
    await expectCode(input, "INVALID_QUOTE")
  })
  await context.test("wrong commerce", async () => {
    await expectCode(await makeFixture({ verifyingContract: OTHER }), "DOMAIN_MISMATCH")
  })
  await context.test("wrong token", async () => {
    await expectCode(await makeFixture({ currency: OTHER }), "DOMAIN_MISMATCH")
  })
})

test("rejects zero, noncanonical, overflowing, and over-cap prices", async (context) => {
  await context.test("zero", async () => {
    await expectCode(await makeFixture({ price: "0" }), "PRICE_INVALID")
  })
  await context.test("leading zero", async () => {
    await expectCode(await makeFixture({ price: "00" }), "INVALID_QUOTE")
  })
  await context.test("uint256 overflow", async () => {
    await expectCode(await makeFixture({ price: (1n << 256n).toString() }), "PRICE_INVALID")
  })
  await context.test("over cap", async () => {
    const input = await makeFixture({ price: "100000000000000001" })
    await expectCode(input, "PRICE_INVALID")
  })
})

test("rejects expired, overlong, and future-dated quotes", async (context) => {
  await context.test("expired", async () => {
    const input = await makeFixture()
    input.nowUnix = NOW + 900
    await expectCode(input, "TIME_INVALID")
  })
  await context.test("TTL over 900", async () => {
    const input = await makeFixture()
    ;(input.quote as { response: { negotiated_at: number } }).response.negotiated_at = NOW - 1
    await expectCode(input, "TIME_INVALID")
  })
  await context.test("future negotiated time", async () => {
    const input = await makeFixture()
    input.nowUnix = NOW - 31
    await expectCode(input, "TIME_INVALID")
  })
})

test("rejects independent tampering of every declared hash", async (context) => {
  for (const field of ["request_hash", "response_hash", "negotiation_hash"] as const) {
    await context.test(field, async () => {
      const input = await makeFixture()
      ;(input.quote as Record<typeof field, string>)[field] = `0x${"00".repeat(32)}`
      await expectCode(input, "HASH_MISMATCH")
    })
  }
})

test("rejects signatures that do not recover to the independently expected provider", async (context) => {
  await context.test("wrong expected provider", async () => {
    const input = await makeFixture()
    input.expected = { ...input.expected, provider: OTHER }
    await expectCode(input, "SIGNER_MISMATCH")
  })
  await context.test("tampered signature", async () => {
    const input = await makeFixture()
    const quote = input.quote as { provider_sig: string }
    quote.provider_sig = `0x00${quote.provider_sig.slice(4)}`
    await expectCode(input, "SIGNER_MISMATCH")
  })
})

test("rejects an oversized final on-chain description", async () => {
  const input = await makeFixture()
  const quote = input.quote as { provider_sig: string }
  quote.provider_sig = `0x${"11".repeat(4096)}`
  await expectCode(input, "DESCRIPTION_INVALID")
})

test("returns ERC-1271 as unresolved without claiming offline verification", async () => {
  const input = await makeFixture()
  input.expected = { ...input.expected, provider: OTHER, providerKind: "erc1271" }
  const result = await verifyOwnedSellerQuote(input)
  assert.equal(result.status, "ERC1271_UNRESOLVED")
  if (result.status !== "ERC1271_UNRESOLVED") assert.fail("expected unresolved ERC-1271 result")
  const quote = input.quote as { negotiation_hash: Hex; provider_sig: Hex }
  assert.deepEqual(result.challenge, {
    contract: OTHER,
    digest: hashMessage(quote.negotiation_hash),
    signature: quote.provider_sig,
    chainId: 97,
    caller: COMMERCE.toLowerCase(),
  })
})

test("rejects all retained owned EOA captures that predate request-ID replay binding", async (context) => {
  const rawCaptures = [
    {
      name: "GridQuant 1187",
      path: "evidence/advantage/gridquant-1187/agent-negotiate-observation.json",
      provider: "0x3D5355A97352f4D078016342AD117a5E88D5C74f",
    },
    {
      name: "YieldScout 1188",
      path: "evidence/advantage/yieldscout-1188/agent-negotiate-observation.json",
      provider: "0x6fD04720c7FcCB6dCEBf6cF08dD6f5C764c7D8E3",
    },
  ] as const
  for (const capture of rawCaptures) {
    await context.test(capture.name, async () => {
      const observed = JSON.parse(await readFile(capture.path, "utf8")) as {
        request: { params: { message: { parts: Array<{ data: Record<string, unknown> }> } } }
        response: { result: { parts: Array<{ data: Record<string, unknown> }> } }
      }
      const data = observed.request.params.message.parts[0]?.data
      const quote = observed.response.result.parts[0]?.data
      assert.ok(data)
      assert.ok(quote)
      const sentRequest = { ...data }
      delete sentRequest.skill
      const requestTerms = sentRequest.terms as typeof terms
      const expected: OwnedSellerQuoteExpectation = {
        provider: capture.provider,
        providerKind: "eoa",
        chainId: 97,
        verifyingContract: COMMERCE,
        currency: TOKEN,
        maxPriceUnits: PRICE,
        taskDescription: sentRequest.task_description as string,
        terms: requestTerms,
        requestId: `${capture.name.toLowerCase().replaceAll(" ", "-")}-legacy`,
      }
      await expectCode({ sentRequest, quote, expected, nowUnix: NOW }, "INVALID_SENT_REQUEST")
    })
  }
  await context.test("RangePilot 1189", async () => {
    const description = JSON.parse(await readFile("evidence/advantage/rangepilot-1189/signed-job-description.json", "utf8")) as {
      task: string
      terms: typeof terms
    }
    const negotiation = JSON.parse(await readFile("evidence/advantage/rangepilot-1189/signed-negotiation.json", "utf8")) as {
      identity: { seller: string }
    }
    const sentRequest = { task_description: description.task, terms: description.terms }
    const expected: OwnedSellerQuoteExpectation = {
      provider: negotiation.identity.seller,
      providerKind: "eoa",
      chainId: 97,
      verifyingContract: COMMERCE,
      currency: TOKEN,
      maxPriceUnits: PRICE,
      taskDescription: description.task,
      terms: description.terms,
      requestId: "rangepilot-1189-legacy",
    }
    await expectCode({ sentRequest, quote: description, expected, nowUnix: NOW }, "INVALID_SENT_REQUEST")
  })
})
