import assert from "node:assert/strict";
import test from "node:test";
import { passwordLoginMethod } from "../src/login.mjs";
import { TOKEN_A, jsonResponse } from "./fixtures.mjs";

const password = "synthetic-private-password";
const modelKey = "krill-synthetic-model-key";
const inputs = { email: "dev@example.test", password, modelKey, route: "direct" };
const envelope = (data) => ({ success: true, code: 0, data });
const loggedIn = { token: TOKEN_A, user: { id: 42, email: "dev@example.test" } };

test("quota-only password login skips route selection", () => {
  const route = passwordLoginMethod(1000).prompts.find(p => p.key === "route");
  for (const modelKey of [undefined, "", "   "]) assert.equal(route.condition({ modelKey }), false);
  assert.equal(route.condition({ modelKey: "opaque-key" }), true);
});

test("direct login uses only the website login endpoint and stores no password or prompt inputs", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(envelope(loggedIn));
  });
  const method = passwordLoginMethod(12000);
  const flow = await method.authorize(inputs);
  assert.equal(flow.url, "");
  assert.equal(flow.method, "auto");
  const saved = await flow.callback();
  assert.deepEqual(saved, { type: "success", refresh: "", access: TOKEN_A, expires: 0, accountId: inputs.email, email: inputs.email, uid: "42", modelKey, route: "direct" });
  assert.ok(!JSON.stringify(saved).includes(password));
  assert.equal(saved.metadata, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://www.krill-code.com/api/auth/login");
  assert.equal(calls[0].init.redirect, "manual");
  assert.deepEqual(JSON.parse(calls[0].init.body), { email: inputs.email, password });
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.ok(!calls[0].init.body.includes(modelKey), "A model API key is not sent to the website login endpoint");
  assert.deepEqual(method.prompts.filter((p) => ["password", "modelKey"].includes(p.key)).map((p) => p.type), ["password", "password"]);
});

test("two-step login exchanges only a pending token and the supplied TOTP code", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return jsonResponse(envelope(url.endsWith("/totp") ? loggedIn : { requires_totp: true, pending_token: "synthetic-pending-token" }));
  });
  const flow = await passwordLoginMethod(12000).authorize(inputs);
  assert.equal(flow.method, "code");
  assert.equal(calls.length, 1);
  const saved = await flow.callback("123456");
  assert.equal(saved.type, "success");
  assert.equal(saved.modelKey, modelKey);
  assert.deepEqual(calls[1], { url: "https://www.krill-code.com/api/auth/login/totp", body: { pending_token: "synthetic-pending-token", totp_code: "123456" } });
  assert.ok(!JSON.stringify(saved).includes("pending"));
  assert.ok(!JSON.stringify(saved).includes("123456"));
});

test("rejects malformed input before any login request", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return jsonResponse(envelope(loggedIn)); });
  for (const change of [{ email: "bad" }, { password: "" }, { modelKey: "synthetic\r\ninvalid" }, { route: "https://other.example" }]) {
    const flow = await passwordLoginMethod(12000).authorize({ ...inputs, ...change });
    assert.equal((await flow.callback()).type, "failed");
  }
  assert.equal(requests, 0);
});

test("failed login and invalid server payloads never persist credentials or echo raw response secrets", async (t) => {
  for (const response of [
    () => new Response(JSON.stringify({ password, token: TOKEN_A }), { status: 401 }),
    () => jsonResponse({ success: false, code: 1, data: { password } }),
    () => jsonResponse(envelope({ user: loggedIn.user })),
    () => jsonResponse(envelope({ token: TOKEN_A })),
  ]) {
    const mock = t.mock.method(globalThis, "fetch", async () => response());
    const flow = await passwordLoginMethod(12000).authorize(inputs);
    const result = await flow.callback();
    assert.equal(result.type, "failed");
    for (const secret of [password, TOKEN_A, modelKey]) assert.ok(!JSON.stringify(result).includes(secret));
    mock.mock.restore();
  }
});

test("invalid TOTP codes are rejected without sending another request", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return jsonResponse(envelope({ requires_totp: true, pending_token: "synthetic-pending" }));
  });
  const flow = await passwordLoginMethod(12000).authorize(inputs);
  assert.equal((await flow.callback("abc")).type, "failed");
  assert.equal(requests, 1);
});

test("unexpected login network errors do not leak password or model API key", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error(`${password} ${modelKey}`); });
  const flow = await passwordLoginMethod(12000).authorize(inputs);
  const result = await flow.callback();
  assert.equal(result.type, "failed");
  assert.ok(result.error.includes("无法连接"));
  assert.ok(!JSON.stringify(result).includes(password));
  assert.ok(!JSON.stringify(result).includes(modelKey));
});

test("password sign-in can omit the model key and stores no empty model credential", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse(envelope(loggedIn)));
  const flow = await passwordLoginMethod(12000).authorize({ ...inputs, modelKey: "" });
  const saved = await flow.callback();
  assert.equal(saved.type, "success");
  assert.equal(saved.access, TOKEN_A);
  assert.equal(Object.hasOwn(saved, "modelKey"), false);
});
