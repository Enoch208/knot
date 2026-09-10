import assert from "node:assert/strict"
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto"
import { test } from "node:test"
import { keccak256 } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { KeystoreError, decryptKeystore, type KeystoreV3 } from "../../packages/authority/src/keystore.ts"

const PASSWORD = "correct horse battery staple"

function buildKeystore(privateKey: Buffer, password: string): KeystoreV3 {
  const salt = randomBytes(32)
  const iv = randomBytes(16)
  const derived = pbkdf2Sync(password, salt, 4096, 32, "sha256")
  const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv)
  const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final()])
  const mac = keccak256(
    Buffer.concat([derived.subarray(16, 32), ciphertext]) as unknown as Uint8Array,
  )
  return {
    version: 3,
    crypto: {
      cipher: "aes-128-ctr",
      ciphertext: ciphertext.toString("hex"),
      cipherparams: { iv: iv.toString("hex") },
      kdf: "pbkdf2",
      kdfparams: { dklen: 32, c: 4096, prf: "hmac-sha256", salt: salt.toString("hex") },
      mac: mac.slice(2),
    },
  }
}

const refusal = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof KeystoreError, `expected KeystoreError, got ${String(error)}`)
    return error.code
  }
  return assert.fail("expected a refusal")
}

test("a correct password recovers the exact private key", () => {
  const privateKey = randomBytes(32)
  const keystore = buildKeystore(privateKey, PASSWORD)
  const recovered = decryptKeystore(keystore, PASSWORD)
  assert.equal(recovered, `0x${privateKey.toString("hex")}`)
  assert.match(privateKeyToAccount(recovered).address, /^0x[0-9a-fA-F]{40}$/)
})

test("a wrong password is refused by the MAC rather than returning noise", () => {
  const keystore = buildKeystore(randomBytes(32), PASSWORD)
  assert.equal(refusal(() => decryptKeystore(keystore, "wrong password")), "PASSWORD_INCORRECT")
})

test("an empty password is refused before any derivation work", () => {
  const keystore = buildKeystore(randomBytes(32), PASSWORD)
  assert.equal(refusal(() => decryptKeystore(keystore, "")), "PASSWORD_EMPTY")
})

test("a tampered ciphertext fails the MAC", () => {
  const keystore = buildKeystore(randomBytes(32), PASSWORD)
  const crypto = keystore.crypto
  assert.ok(crypto)
  crypto.ciphertext = `${crypto.ciphertext.slice(0, -2)}ff`
  assert.equal(refusal(() => decryptKeystore(keystore, PASSWORD)), "PASSWORD_INCORRECT")
})

test("a non-V3 keystore is refused rather than parsed optimistically", () => {
  const keystore = buildKeystore(randomBytes(32), PASSWORD)
  assert.equal(refusal(() => decryptKeystore({ ...keystore, version: 4 }, PASSWORD)), "VERSION_UNSUPPORTED")
})

test("an unsupported cipher or kdf is refused", () => {
  const withCipher = buildKeystore(randomBytes(32), PASSWORD)
  assert.ok(withCipher.crypto)
  withCipher.crypto.cipher = "aes-256-cbc"
  assert.equal(refusal(() => decryptKeystore(withCipher, PASSWORD)), "CIPHER_UNSUPPORTED")

  const withKdf = buildKeystore(randomBytes(32), PASSWORD)
  assert.ok(withKdf.crypto)
  withKdf.crypto.kdf = "argon2"
  assert.equal(refusal(() => decryptKeystore(withKdf, PASSWORD)), "KDF_UNSUPPORTED")
})

test("a keystore without a crypto section is refused", () => {
  assert.equal(refusal(() => decryptKeystore({ version: 3 }, PASSWORD)), "MALFORMED")
})
