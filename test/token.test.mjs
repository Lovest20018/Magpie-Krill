import assert from "node:assert/strict";
import test from "node:test";
import { normalizeToken } from "../src/token.mjs";
import { TOKEN_A } from "./fixtures.mjs";

test("accepts JWT values copied with whitespace, Bearer prefixes and quotes", () => {
  for (const value of [TOKEN_A, ` ${TOKEN_A}\n`, `Bearer ${TOKEN_A}`, `"${TOKEN_A}"`, `'${TOKEN_A}'`, `"Bearer ${TOKEN_A}"`, `bearer '${TOKEN_A}'`]) {
    assert.equal(normalizeToken(value), TOKEN_A);
  }
});

test("rejects empty, malformed and header-injecting credentials without exposing their content", () => {
  for (const value of [null, undefined, 123, "", "Bearer", "sk-wrong-token", "a.b", "a.b.c.d", "a.b.c\r\nAuthorization: secret", `${"x".repeat(16_385)}.b.c`]) {
    assert.throws(() => normalizeToken(value), (error) => {
      assert.equal(error.signIn, "expired");
      assert.ok(["NO_AUTH", "INVALID_TOKEN"].includes(error.code));
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  }
});
