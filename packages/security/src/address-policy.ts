import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { SafeFetchError } from "./errors.ts"

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

export type SafeResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>

export const systemResolver: SafeResolver = async (hostname) => {
  try {
    const results = await lookup(hostname, { all: true, verbatim: true })
    return results.flatMap((result) =>
      result.family === 4 || result.family === 6
        ? [{ address: result.address, family: result.family }]
        : [],
    )
  } catch {
    throw new SafeFetchError("DNS_UNAVAILABLE", "outbound hostname could not be resolved")
  }
}

export function validateSafeUrl(input: string): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new SafeFetchError("INVALID_URL", "outbound URL is invalid")
  }
  if (url.protocol !== "https:") throw new SafeFetchError("HTTPS_REQUIRED", "outbound URL must use HTTPS")
  if (url.username !== "" || url.password !== "") {
    throw new SafeFetchError("EMBEDDED_CREDENTIALS", "outbound URL cannot contain credentials")
  }
  if (url.port !== "" && url.port !== "443") {
    throw new SafeFetchError("UNSAFE_PORT", "outbound HTTPS URL must use port 443")
  }
  const hostname = normalizedHostname(url.hostname)
  if (isPrivateHostname(hostname)) {
    throw new SafeFetchError("PRIVATE_HOSTNAME", "outbound hostname is private or local")
  }
  if (isIP(hostname) !== 0 && !isPublicAddress(hostname)) {
    throw new SafeFetchError("NON_PUBLIC_ADDRESS", "outbound address is not public")
  }
  return url
}

export async function resolvePublicAddresses(url: URL, resolver: SafeResolver): Promise<readonly ResolvedAddress[]> {
  const hostname = normalizedHostname(url.hostname)
  const literalFamily = isIP(hostname)
  const results = literalFamily === 4 || literalFamily === 6
    ? [{ address: hostname, family: literalFamily } as ResolvedAddress]
    : await resolver(hostname)
  if (results.length === 0) throw new SafeFetchError("DNS_UNAVAILABLE", "outbound hostname returned no addresses")
  for (const result of results) {
    if (isIP(result.address) !== result.family || !isPublicAddress(result.address)) {
      throw new SafeFetchError("NON_PUBLIC_ADDRESS", "outbound hostname resolved to a non-public address")
    }
  }
  return results
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPublicIpv4(address)
  if (family === 6) return isPublicIpv6(address)
  return false
}

function normalizedHostname(hostname: string): string {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
  return unwrapped.toLowerCase().replace(/\.$/, "")
}

function isPrivateHostname(hostname: string): boolean {
  if (isIP(hostname) !== 0) return false
  if (!hostname.includes(".")) return true
  return hostname === "localhost" || [".localhost", ".local", ".internal", ".home.arpa", ".onion"].some((suffix) => hostname.endsWith(suffix))
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number)
  const first = octets[0] ?? -1
  const second = octets[1] ?? -1
  const third = octets[2] ?? -1
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false
  if (first === 100 && second >= 64 && second <= 127) return false
  if (first === 169 && second === 254) return false
  if (first === 172 && second >= 16 && second <= 31) return false
  if (first === 192 && (second === 0 || second === 168)) return false
  if (first === 192 && second === 88 && third === 99) return false
  if (first === 198 && (second === 18 || second === 19)) return false
  if (first === 198 && second === 51 && third === 100) return false
  if (first === 203 && second === 0 && third === 113) return false
  return !(first === 192 && second === 0 && third === 2)
}

function isPublicIpv6(address: string): boolean {
  if (address.includes(".")) return false
  const hextets = expandIpv6(address)
  if (!hextets) return false
  const first = hextets[0] ?? 0
  const second = hextets[1] ?? 0
  if (first < 0x2000 || first > 0x3fff) return false
  if (first === 0x2001 && (second < 0x0200 || second === 0x0db8)) return false
  if (first === 0x3fff && (second & 0xf000) === 0) return false
  return first !== 0x2002 && first !== 0x3ffe
}

function expandIpv6(address: string): number[] | null {
  const halves = address.toLowerCase().split("::")
  if (halves.length > 2) return null
  const left = halves[0] === "" ? [] : halves[0]!.split(":")
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":")
  const missing = 8 - left.length - right.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null
  const values = [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((value) => Number.parseInt(value, 16))
  return values.length === 8 && values.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffff) ? values : null
}
