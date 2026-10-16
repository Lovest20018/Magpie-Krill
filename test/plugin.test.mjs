import assert from "node:assert/strict";
import test from "node:test";
import { KrillUsagePlugin } from "../index.mjs";
import { TOKEN_A, TOKEN_B, payload, subscription, jsonResponse } from "./fixtures.mjs";

test("registers the quota provider without overriding user config or exposing models", async () => {
  const hooks = await KrillUsagePlugin({});
  const config = {};
  await hooks.config(config);
  assert.equal(hooks.auth.provider, "krill-usage");
  assert.equal(config.provider[hooks.auth.provider].name, "Krill");
  assert.deepEqual(config.provider[hooks.auth.provider].models, {});
  const userConfig = { provider: { "krill-usage": { name: "My Krill" } } };
  await hooks.config(userConfig);
  assert.equal(userConfig.provider[hooks.auth.provider].name, "My Krill");
  assert.deepEqual(await hooks.provider.models({ models: { unexpected: {} } }), {});
});

test("never sends a model request, even if the provider is accidentally selected", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return jsonResponse(); });
  const hooks = await KrillUsagePlugin({});
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: TOKEN_A }));
  assert.equal(loader.apiKey, "krill-model-key-managed-by-plugin");
  await assert.rejects(loader.fetch("https://other.example/", {}), /仅查询额度/);
  assert.equal(requests, 0);
});

test("uses the latest auth on each refresh and keeps concurrent accounts separate", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    seen.push(init.headers.authorization);
    return init.headers.authorization === `Bearer ${TOKEN_A}`
      ? jsonResponse(payload([subscription({ name: "账号 A", remaining: "240" })], "12"))
      : jsonResponse(payload([subscription({ name: "账号 B", remaining: "300" })], "34"));
  });
  const hooks = await KrillUsagePlugin({});
  const getA = async () => ({ type: "api", key: TOKEN_A });
  const getB = async () => ({ type: "api", key: TOKEN_B });
  const [a, b] = await Promise.all([hooks.auth.usage(getA), hooks.auth.usage(getB)]);
  assert.equal(a.plan, "账号 A");
  assert.equal(a.balance, "$12.00");
  assert.equal(a.windows[0].used, 60);
  assert.equal(b.plan, "账号 B");
  assert.equal(b.balance, "$34.00");
  assert.equal(b.windows[0].used, 50);
  let current = TOKEN_A;
  const getCurrent = async () => ({ type: "api", key: current });
  assert.equal((await hooks.auth.usage(getCurrent)).plan, "账号 A");
  current = TOKEN_B;
  assert.equal((await hooks.auth.usage(getCurrent)).plan, "账号 B");
  assert.deepEqual(seen, [TOKEN_A, TOKEN_B, TOKEN_A, TOKEN_B].map((token) => `Bearer ${token}`));
});

test("a failed refresh returns an explicit error and no cached allowance", async (t) => {
  let succeeds = true;
  t.mock.method(globalThis, "fetch", async () => {
    if (!succeeds) throw new Error(`unexpected ${TOKEN_A}`);
    return jsonResponse();
  });
  const hooks = await KrillUsagePlugin({});
  const getAuth = async () => ({ type: "api", key: TOKEN_A });
  assert.equal((await hooks.auth.usage(getAuth)).windows.length, 1);
  succeeds = false;
  const result = await hooks.auth.usage(getAuth);
  assert.ok(result.error.includes("无法连接"));
  assert.equal(result.signIn, "kept");
  assert.deepEqual(result.windows, []);
  assert.equal(result.balance, undefined);
  assert.ok(!JSON.stringify(result).includes(TOKEN_A));
});

test("missing auth and rejected JWT tell Magpie to request login again", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 401 }));
  const hooks = await KrillUsagePlugin({});
  for (const auth of [undefined, { type: "oauth" }, { type: "api", key: TOKEN_A }]) {
    const result = await hooks.auth.usage(async () => auth);
    assert.equal(result.signIn, "expired");
    assert.ok(result.error);
    assert.deepEqual(result.windows, []);
  }
});

test("a malformed active quota produces an error, not an unused quota window", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse(payload([subscription({ remaining: null })])));
  const hooks = await KrillUsagePlugin({});
  const result = await hooks.auth.usage(async () => ({ type: "api", key: TOKEN_A }));
  assert.ok(result.error.includes("不完整"));
  assert.equal(result.signIn, "kept");
  assert.deepEqual(result.windows, []);
});

test("unexpected auth errors do not expose credential contents", async () => {
  const hooks = await KrillUsagePlugin({});
  const result = await hooks.auth.usage(async () => { throw new Error(TOKEN_A); });
  assert.equal(result.error, "Krill 额度查询失败，请稍后重试。");
  assert.ok(!JSON.stringify(result).includes(TOKEN_A));
});

test("validates the request timeout option", async () => {
  for (const timeoutMs of [0, 999, 30_001, "12000", NaN]) {
    await assert.rejects(KrillUsagePlugin({}, { timeoutMs }), /timeoutMs/);
  }
  await KrillUsagePlugin({}, { timeoutMs: 1_000 });
  await KrillUsagePlugin({}, { timeoutMs: 30_000 });
});

test("OAuth provider accounts query quota with the website JWT, never the model API key", async (t) => {
  let seen;
  t.mock.method(globalThis, "fetch", async (url, init) => { seen = { url, init }; return jsonResponse(); });
  const hooks = await KrillUsagePlugin({});
  const result = await hooks.auth.usage(async () => ({ type: "oauth", access: TOKEN_A, modelKey: "sk-synthetic-model-key", email: "dev@example.test" }));
  assert.equal(seen.init.headers.authorization, `Bearer ${TOKEN_A}`);
  assert.equal(result.user, "dev@example.test");
  assert.equal(result.windows[0].used, 60);
});

test("website JWT expiry cannot disable independent model credentials", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 401 }));
  const hooks = await KrillUsagePlugin({});
  for (const access of [TOKEN_A, undefined, "invalid token"]) {
    const result = await hooks.auth.usage(async () => ({ type: "oauth", access, modelKey: "sk-synthetic-model-key" }));
    assert.equal(result.signIn, "kept");
    assert.match(result.error, /额度登录已失效/);
    assert.match(result.error, /模型 Key 仍可使用/);
    assert.deepEqual(result.windows, []);
    assert.equal(result.balance, undefined);
  }
  const legacy = await hooks.auth.usage(async () => ({ type: "api", key: TOKEN_A }));
  assert.equal(legacy.signIn, "expired");
});

test("OAuth accounts without a model key can read quota without requesting models", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => { requests.push(String(url)); return jsonResponse(); });
  const hooks = await KrillUsagePlugin({});
  const auth = { type: "oauth", access: TOKEN_A, route: "domestic" };
  assert.equal((await hooks.auth.usage(async () => auth)).windows[0].used, 60);
  assert.deepEqual(await hooks.provider.models(null, { auth }), {});
  const loader = await hooks.auth.loader(async () => auth);
  await assert.rejects(loader.fetch("https://api-slb.krill-code.net/v1/responses"), { code: "QUOTA_ONLY" });
  assert.deepEqual(requests, ["https://www.krill-code.com/api/subscription"]);
});

test("the usage hook forwards weekly and total limits for existing website accounts without another login", async (t) => {
  const sub = subscription({ name: "月卡", remaining: "440", limit: "600" });
  Object.assign(sub.plan, { billing_type: "usd_weekly", duration_days: 30 });
  Object.assign(sub, { total_limit_usd: "2400", total_remaining_usd: "1840" });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { calls.push(url); assert.equal(init.headers.authorization, `Bearer ${TOKEN_A}`); return jsonResponse(payload([sub])); });
  const hooks = await KrillUsagePlugin({});
  for (const auth of [{ type: "api", key: TOKEN_A }, { type: "oauth", access: TOKEN_A, accountId: "krill:42", uid: "42", modelKey: "synthetic-key" }]) {
    const usage = await hooks.auth.usage(async () => auth);
    assert.deepEqual(usage.windows.map((window) => window.name), ["月卡 · 本周", "月卡 · 套餐总额"]);
    assert.equal(usage.error, undefined);
  }
  assert.deepEqual(calls, ["https://www.krill-code.com/api/subscription", "https://www.krill-code.com/api/subscription"]);
});

test("an upgraded account can query quota, discover models and stream inference without a credential write or account-management request", async t => {
  const auth = Object.freeze({ type: "oauth", access: TOKEN_A, email: "synthetic@example.test", modelKey: "synthetic-upgrade-key", route: "direct", krillTokenId: 7, pricingChannelId: 10 });
  const before = structuredClone(auth), calls = [];
  const hooks = await KrillUsagePlugin({ client: new Proxy({}, { get() { throw new Error("The plugin must not use account-management APIs"); } }) });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    url = String(url); calls.push(url);
    if (url === "https://www.krill-code.com/api/subscription") {
      assert.equal(init.headers.authorization, `Bearer ${TOKEN_A}`);
      return jsonResponse(payload());
    }
    if (url === "https://api.krill-code.net/v1/models") {
      assert.equal(init.headers.authorization, `Bearer ${auth.modelKey}`);
      return jsonResponse({ data: [{ id: "gpt-6.1-sol" }] });
    }
    if (url === "https://www.krill-code.com/api/public/model-pricing") {
      assert.equal(init.headers.authorization, undefined);
      return jsonResponse({ success: true, code: 0, data: [{ model_name: "gpt-6.1-sol", billing_mode: "token", input_token_price: "2", output_token_price: "10", route_multipliers: { 直连: "0.2" } }] });
    }
    assert.equal(url, "https://api.krill-code.net/v1/responses");
    assert.equal(init.headers.get("authorization"), `Bearer ${auth.modelKey}`);
    assert.equal(JSON.parse(init.body).service_tier, "ultrafast");
    return new Response("data: synthetic stream\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const usage = await hooks.auth.usage(async () => auth);
  assert.equal(usage.windows[0].used, 60);
  const models = await hooks.provider.models(null, { auth });
  assert.deepEqual(models["gpt-6.1-sol"].cost, { input: 0.4, output: 2 });
  const loader = await hooks.auth.loader(async () => auth);
  const response = await loader.fetch("https://api.krill-code.net/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-6.1-sol", service_tier: "ultrafast", stream: true }) });
  assert.match(await response.text(), /synthetic stream/);
  assert.equal(calls.length, 4);
  assert.deepEqual(auth, before);
});
