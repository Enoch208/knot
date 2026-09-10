import { createDecipheriv, pbkdf2Sync, scryptSync } from "node:crypto"
import { keccak256, type Hex } from "viem"

export class KeystoreError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "KeystoreError"
    this.code = code
  }
}

interface ScryptParams {
  dklen: number
  n: number
  r: number
  p: number
  salt: string
}

interface Pbkdf2Params {
  dklen: number
  c: number
  prf: string
  salt: string
}

interface KeystoreCrypto {
  cipher: string
  ciphertext: string
  cipherparams: { iv: string }
  kdf: string
  kdfparams: ScryptParams | Pbkdf2Params
  mac: string
}

export interface KeystoreV3 {
  version: number
  address?: string
  crypto?: KeystoreCrypto
  Crypto?: KeystoreCrypto
}

const SCRYPT_MAX_MEMORY = 1024 * 1024 * 1024

function deriveKey(crypto: KeystoreCrypto, password: string): Buffer {
  const salt = Buffer.from(crypto.kdfparams.salt, "hex")
  if (crypto.kdf === "scrypt") {
    const params = crypto.kdfparams as ScryptParams
    return scryptSync(password, salt, params.dklen, {
      N: params.n,
      r: params.r,
      p: params.p,
      maxmem: SCRYPT_MAX_MEMORY,
    })
  }
  if (crypto.kdf === "pbkdf2") {
    const params = crypto.kdfparams as Pbkdf2Params
    if (params.prf !== "hmac-sha256") {
      throw new KeystoreError("KDF_UNSUPPORTED", `unsupported pbkdf2 prf ${params.prf}`)
    }
    return pbkdf2Sync(password, salt, params.c, params.dklen, "sha256")
  }
  throw new KeystoreError("KDF_UNSUPPORTED", `unsupported kdf ${crypto.kdf}`)
}

export function decryptKeystore(keystore: KeystoreV3, password: string): Hex {
  const crypto = keystore.crypto ?? keystore.Crypto
  if (!crypto) throw new KeystoreError("MALFORMED", "keystore has no crypto section")
  if (keystore.version !== 3) {
    throw new KeystoreError("VERSION_UNSUPPORTED", `only V3 keystores are supported, got ${keystore.version}`)
  }
  if (crypto.cipher !== "aes-128-ctr") {
    throw new KeystoreError("CIPHER_UNSUPPORTED", `unsupported cipher ${crypto.cipher}`)
  }
  if (password.length === 0) {
    throw new KeystoreError("PASSWORD_EMPTY", "a keystore password is required")
  }

  const derived = deriveKey(crypto, password)
  const ciphertext = Buffer.from(crypto.ciphertext, "hex")
  const mac = keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext]) as unknown as Uint8Array)

  if (mac.slice(2).toLowerCase() !== crypto.mac.replace(/^0x/, "").toLowerCase()) {
    throw new KeystoreError("PASSWORD_INCORRECT", "the keystore password is incorrect")
  }

  const decipher = createDecipheriv(
    "aes-128-ctr",
    derived.subarray(0, 16),
    Buffer.from(crypto.cipherparams.iv, "hex"),
  )
  const privateKey = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  if (privateKey.length !== 32) {
    throw new KeystoreError("KEY_LENGTH_INVALID", "decrypted key is not 32 bytes")
  }
  return `0x${privateKey.toString("hex")}`
}
