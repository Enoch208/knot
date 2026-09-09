import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

const TOKEN_AUDIENCE = "knot-yieldscout";
const TOKEN_TTL_SECONDS = 900;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  issuer: string;
  scope: string;
}

interface AccessTokenClaims {
  aud: string;
  exp: number;
  iat: number;
  iss: string;
  scope: string;
  sub: string;
}

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const digest = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

const sameSecret = (left: string, right: string): boolean =>
  timingSafeEqual(digest(left), digest(right));

const signed = (content: string, secret: string): string =>
  createHmac("sha256", secret).update(content, "utf8").digest("base64url");

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const required = (source: NodeJS.ProcessEnv, key: string): string => {
  const value = source[key]?.trim();
  if (!value) throw new Error(`${key} is required when KNOT_AGENT_AUTH=oauth`);
  return value;
};

export function loadOAuthConfig(source: NodeJS.ProcessEnv): OAuthConfig | null {
  const mode = source.KNOT_AGENT_AUTH?.trim().toLowerCase() ?? "none";
  if (mode === "none") return null;
  if (mode !== "oauth") throw new Error("KNOT_AGENT_AUTH must be 'none' or 'oauth'");
  const issuer = required(source, "KNOT_AGENT_OAUTH_ISSUER");
  const parsedIssuer = new URL(issuer);
  if (parsedIssuer.protocol !== "https:" || parsedIssuer.origin !== issuer) {
    throw new Error("KNOT_AGENT_OAUTH_ISSUER must be an HTTPS origin");
  }
  return {
    clientId: required(source, "KNOT_AGENT_OAUTH_CLIENT_ID"),
    clientSecret: required(source, "KNOT_AGENT_OAUTH_CLIENT_SECRET"),
    issuer,
    scope: required(source, "OAUTH_SCOPE"),
  };
}

export function createAccessToken(
  config: OAuthConfig,
  issuedAt = Math.floor(Date.now() / 1000),
): string {
  const header = encode({ alg: "HS256", typ: "JWT" });
  const claims: AccessTokenClaims = {
    aud: TOKEN_AUDIENCE,
    exp: issuedAt + TOKEN_TTL_SECONDS,
    iat: issuedAt,
    iss: config.issuer,
    scope: config.scope,
    sub: config.clientId,
  };
  const content = `${header}.${encode(claims)}`;
  return `${content}.${signed(content, config.clientSecret)}`;
}

export function verifyAccessToken(
  token: string,
  config: OAuthConfig,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [headerPart, claimsPart, signaturePart] = parts;
  if (!headerPart || !claimsPart || !signaturePart) return false;
  const content = `${headerPart}.${claimsPart}`;
  if (!sameSecret(signaturePart, signed(content, config.clientSecret))) return false;
  try {
    const header = asRecord(JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")));
    const claims = asRecord(JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8")));
    return (
      header?.alg === "HS256" &&
      header.typ === "JWT" &&
      claims?.aud === TOKEN_AUDIENCE &&
      claims.iss === config.issuer &&
      claims.sub === config.clientId &&
      claims.scope === config.scope &&
      typeof claims.iat === "number" &&
      claims.iat <= now &&
      typeof claims.exp === "number" &&
      claims.exp > now
    );
  } catch {
    return false;
  }
}

const bodyCredentials = (request: Request): { clientId: string; clientSecret: string } | null => {
  const body = asRecord(request.body);
  const clientId = body?.client_id;
  const clientSecret = body?.client_secret;
  return typeof clientId === "string" && typeof clientSecret === "string"
    ? { clientId, clientSecret }
    : null;
};

const basicCredentials = (request: Request): { clientId: string; clientSecret: string } | null => {
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator > 0
      ? { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1) }
      : null;
  } catch {
    return null;
  }
};

export function oauthTokenHandler(config: OAuthConfig): RequestHandler {
  return (request, response) => {
    response.setHeader("cache-control", "no-store");
    const body = asRecord(request.body);
    const credentials = basicCredentials(request) ?? bodyCredentials(request);
    if (
      body?.grant_type !== "client_credentials" ||
      body.scope !== config.scope ||
      credentials === null ||
      !sameSecret(credentials.clientId, config.clientId) ||
      !sameSecret(credentials.clientSecret, config.clientSecret)
    ) {
      response.status(401).json({ error: "invalid_client" });
      return;
    }
    response.json({
      access_token: createAccessToken(config),
      expires_in: TOKEN_TTL_SECONDS,
      scope: config.scope,
      token_type: "Bearer",
    });
  };
}

const bearer = (request: Request): string => {
  const authorization = request.header("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
};

export function requireOAuth(config: OAuthConfig): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    if (request.method === "GET" || request.method === "HEAD") {
      next();
      return;
    }
    if (verifyAccessToken(bearer(request), config)) {
      next();
      return;
    }
    response
      .status(401)
      .set("www-authenticate", `Bearer scope="${config.scope}"`)
      .json({ error: "invalid_token" });
  };
}
