import assert from "node:assert/strict";
import test from "node:test";
import {
  createAccessToken,
  loadOAuthConfig,
  verifyAccessToken,
  type OAuthConfig,
} from "../src/oauth.js";

const config: OAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret-with-enough-entropy",
  issuer: "https://knot-yield.example.com",
  scope: "knot:yieldscout:invoke",
};

test("accepts an unexpired access token with the exact scope", () => {
  const token = createAccessToken(config, 1_000);
  assert.equal(verifyAccessToken(token, config, 1_899), true);
});

test("rejects expired, tampered, and wrong-scope tokens", () => {
  const token = createAccessToken(config, 1_000);
  const changed = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.equal(verifyAccessToken(token, config, 1_900), false);
  assert.equal(verifyAccessToken(changed, config, 1_001), false);
  assert.equal(
    verifyAccessToken(token, { ...config, scope: "knot:other:invoke" }, 1_001),
    false,
  );
});

test("requires a complete HTTPS OAuth configuration", () => {
  assert.equal(loadOAuthConfig({ KNOT_AGENT_AUTH: "none" }), null);
  assert.throws(
    () => loadOAuthConfig({ KNOT_AGENT_AUTH: "oauth" }),
    /KNOT_AGENT_OAUTH_ISSUER/,
  );
  assert.throws(
    () =>
      loadOAuthConfig({
        KNOT_AGENT_AUTH: "oauth",
        KNOT_AGENT_OAUTH_ISSUER: "http://localhost:9000",
        KNOT_AGENT_OAUTH_CLIENT_ID: "id",
        KNOT_AGENT_OAUTH_CLIENT_SECRET: "secret",
        OAUTH_SCOPE: "scope",
      }),
    /HTTPS origin/,
  );
  assert.deepEqual(
    loadOAuthConfig({
      KNOT_AGENT_AUTH: "oauth",
      KNOT_AGENT_OAUTH_ISSUER: config.issuer,
      KNOT_AGENT_OAUTH_CLIENT_ID: config.clientId,
      KNOT_AGENT_OAUTH_CLIENT_SECRET: config.clientSecret,
      OAUTH_SCOPE: config.scope,
    }),
    config,
  );
});
