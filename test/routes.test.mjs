import assert from "node:assert/strict";
import test from "node:test";
import { normalizeModelKey } from "../src/routes.mjs";
import { modelCredentials, modelLoginPrompts } from "../src/login-result.mjs";

test("model keys are opaque and accept non-sk prefixes and common token alphabets", () => {
  for (const key of ["krill-synthetic-key", "syntheticKeyWithoutPrefix", "synthetic.opaque/token+with=padding", "sk-still-compatible"]) {
    assert.equal(normalizeModelKey(`  ${key}  `), key);
    assert.equal(normalizeModelKey(`Bearer ${key}`), key);
  }
});

test("model key validation rejects unsafe headers without echoing the credential", () => {
  for (const key of [undefined, 42, "", "has space", "synthetic\r\nx-header: injected", "synthetic\u0000key", "x".repeat(4097)]) {
    assert.throws(() => normalizeModelKey(key));
  }
});

test("login permits omitted or blank model keys and validates only supplied credentials", () => {
  const prompt = modelLoginPrompts().find((p) => p.key === "modelKey");
  for (const modelKey of [undefined, "", "   "]) {
    const credentials = modelCredentials({ modelKey });
    assert.deepEqual(credentials, { route: "domestic" });
    if (modelKey !== undefined) assert.equal(prompt.validate(modelKey), undefined);
  }
  assert.equal(prompt.validate("krill-synthetic-key"), undefined);
  assert.deepEqual(modelCredentials({ modelKey: "krill-synthetic-key", route: "cdn" }), { modelKey: "krill-synthetic-key", route: "cdn" });
  assert.throws(() => modelCredentials({ modelKey: "synthetic\r\ninvalid" }), { code: "LOGIN_INPUT" });
});
