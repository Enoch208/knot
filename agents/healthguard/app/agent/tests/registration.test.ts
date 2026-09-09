import assert from "node:assert/strict";
import test from "node:test";
import { healthGuardRegistration } from "../src/registration.js";

test("binds the permanent domain to the registered BSC testnet agent", () => {
  assert.deepEqual(healthGuardRegistration, {
    registrations: [
      {
        agentId: 2295,
        agentRegistry:
          "eip155:97:0x8004A818BFB912233c491871b3d84c89A494BD9e",
      },
    ],
  });
});
