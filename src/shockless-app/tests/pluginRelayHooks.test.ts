import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decidePluginRelayPacket,
  defaultSensitiveClientHeaders,
  emptyPluginRelayPolicy,
  isSensitivePluginRelayPacket,
  normalizePluginRelayPolicy,
  type PluginRelayPolicy,
} from "../src/shared/pluginRelayHooks";

test("plugin relay policy defaults deny plugin hooks without blocking packet flow", () => {
  const decision = decidePluginRelayPacket(emptyPluginRelayPolicy(), { direction: "server", header: 29 });

  assert.equal(decision.allowed, true);
  assert.equal(decision.sensitive, false);
  assert.deepEqual(decision.readPluginIds, []);
  assert.deepEqual(decision.interceptPluginIds, []);
  assert.deepEqual(decision.injectPluginIds, []);
});

test("plugin relay policy filters sensitive client packets unless explicitly granted", () => {
  const policy: PluginRelayPolicy = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sensitiveClientHeaders: defaultSensitiveClientHeaders(),
    grants: [
      { pluginId: "reader", permissions: ["packet.read", "packet.intercept"] },
      { pluginId: "sensitive-reader", permissions: ["packet.read", "packet.intercept.sensitive"] },
    ],
  };

  const loginDecision = decidePluginRelayPacket(policy, { direction: "client", header: 4 });
  assert.equal(loginDecision.allowed, true);
  assert.equal(loginDecision.sensitive, true);
  assert.deepEqual(loginDecision.readPluginIds, ["sensitive-reader"]);
  assert.deepEqual(loginDecision.interceptPluginIds, []);
  assert.match(loginDecision.reason ?? "", /Sensitive packet/i);

  const roomDecision = decidePluginRelayPacket(policy, { direction: "client", header: 59 });
  assert.equal(roomDecision.sensitive, false);
  assert.deepEqual(roomDecision.readPluginIds, ["reader", "sensitive-reader"]);
  assert.deepEqual(roomDecision.interceptPluginIds, ["reader"]);
});

test("plugin relay policy normalization drops malformed grants", () => {
  const policy = normalizePluginRelayPolicy({
    version: 99,
    generatedAt: "",
    sensitiveClientHeaders: [4, "6", -1, 4],
    grants: [
      { pluginId: "valid", permissions: ["packet.read", "bad.permission"] },
      { pluginId: "", permissions: ["packet.read"] },
      null,
    ],
  });

  assert.equal(policy.version, 1);
  assert.deepEqual(policy.sensitiveClientHeaders, [4, 6]);
  assert.deepEqual(policy.grants, [{ pluginId: "valid", permissions: ["packet.read"] }]);
  assert.equal(isSensitivePluginRelayPacket({ direction: "client", header: 6 }, policy.sensitiveClientHeaders), true);
  assert.equal(isSensitivePluginRelayPacket({ direction: "server", header: 6 }, policy.sensitiveClientHeaders), false);
});
