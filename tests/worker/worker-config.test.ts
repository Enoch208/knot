import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseWorkerConfig } from "../../apps/worker/src/worker-config.ts"

const enabled = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: "postgresql://worker:secret@postgres/knot",
  KNOT_CHAIN_RECOVERY_ENABLED: "true",
  KNOT_BSC_MAINNET_RPC_URL: "https://bsc.example/rpc",
  KNOT_BSC_TESTNET_RPC_URL: "https://testnet.example/rpc",
})

describe("worker recovery configuration", () => {
  it("keeps chain observation disabled unless explicitly enabled", () => {
    assert.deepEqual(parseWorkerConfig({ DATABASE_URL: "postgresql://postgres/knot" }), {
      databaseUrl: "postgresql://postgres/knot",
      pollMilliseconds: 10_000,
      chainRecovery: null,
    })
  })

  it("builds a bounded read-only recovery configuration", () => {
    assert.deepEqual(parseWorkerConfig(enabled()).chainRecovery, {
      rpcUrls: { 56: "https://bsc.example/rpc", 97: "https://testnet.example/rpc" },
      confirmationPolicy: { 56: 15, 97: 2 },
      leaseMilliseconds: 30_000,
      observationTimeoutMilliseconds: 10_000,
      scanLimit: 2,
    })
  })

  it("requires both public credential-free HTTPS RPC origins", () => {
    for (const changes of [
      { KNOT_BSC_MAINNET_RPC_URL: undefined },
      { KNOT_BSC_MAINNET_RPC_URL: "http://bsc.example/rpc" },
      { KNOT_BSC_MAINNET_RPC_URL: "https://localhost/rpc" },
      { KNOT_BSC_MAINNET_RPC_URL: "https://user:secret@bsc.example/rpc" },
      { KNOT_BSC_MAINNET_RPC_URL: "https://bsc.example/rpc?key=secret" },
    ]) {
      assert.throws(() => parseWorkerConfig({ ...enabled(), ...changes }))
    }
  })

  it("rejects weak confirmation, lease, timeout, scan, and poll bounds", () => {
    for (const changes of [
      { KNOT_CHAIN_56_CONFIRMATIONS: "14" },
      { KNOT_CHAIN_97_CONFIRMATIONS: "1" },
      { KNOT_CHAIN_RECOVERY_LEASE_MILLISECONDS: "12000", KNOT_CHAIN_OBSERVATION_TIMEOUT_MILLISECONDS: "10000" },
      { KNOT_CHAIN_OBSERVATION_TIMEOUT_MILLISECONDS: "99" },
      { KNOT_CHAIN_RECOVERY_SCAN_LIMIT: "5" },
      { KNOT_WORKER_POLL_MILLISECONDS: "999" },
    ]) {
      assert.throws(() => parseWorkerConfig({ ...enabled(), ...changes }))
    }
  })
})
