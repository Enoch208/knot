import { stringToHex } from "viem"
import type { Eip1193Provider } from "./wallet.ts"

const signaturePattern = /^0x[0-9a-fA-F]{130}$/
const USER_REJECTED = 4001

export type BuyerIntentSignatureOutcome =
  | { status: "signed"; signature: `0x${string}` }
  | { status: "rejected" }
  | { status: "unavailable"; detail: string }

export async function signBuyerIntent(
  provider: Eip1193Provider,
  buyer: string,
  message: string,
): Promise<BuyerIntentSignatureOutcome> {
  try {
    const value = await provider.request({
      method: "personal_sign",
      params: [stringToHex(message), buyer],
    })
    if (typeof value !== "string" || !signaturePattern.test(value)) {
      return { status: "unavailable", detail: "The wallet returned no usable EOA signature." }
    }
    return { status: "signed", signature: value as `0x${string}` }
  } catch (error) {
    if (errorCode(error) === USER_REJECTED) return { status: "rejected" }
    return { status: "unavailable", detail: errorDetail(error) }
  }
}

const errorCode = (error: unknown): number | null => {
  if (!error || typeof error !== "object") return null
  const code = (error as { code?: unknown }).code
  return typeof code === "number" ? code : null
}

const errorDetail = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message) return message
  }
  return "The wallet returned no explanation."
}
