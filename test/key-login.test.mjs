import assert from "node:assert/strict";
import test from "node:test";
import { keyLoginMethod } from "../src/key-login.mjs";
import { KrillUsagePlugin } from "../index.mjs";
import { websiteToken } from "../src/routes.mjs";
import { jsonResponse } from "./fixtures.mjs";

const key = "synthetic.opaque/key+suffix=";
const catalog = { data: [{ id: "gpt-6.1-sol" }] };

test("standalone key login verifies only the selected model endpoint and stores no website credential", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { calls.push({ url, init }); return jsonResponse(catalog); });
  const method = keyLoginMethod(12000);
  assert.deepEqual(method.prompts.map((p) => p.key), ["modelKey", "route"]);
  assert.ok(method.prompts[0].validate(""));
  assert.equal(method.prompts[0].validate(key), undefined);
  const flow = await method.authorize({ modelKey: `Bearer ${key}`, route: "cdn", password: "synthetic-ignored-password" });
  const saved = await flow.callback();
  assert.equal(flow.url, "");
  assert.equal(flow.method, "auto");
  assert.equal(saved.type, "success");
  assert.equal(saved.connection, "model-only");
  assert.equal(saved.modelKey, key);
  assert.equal(saved.route, "cdn");
  assert.equal(saved.access, "");
  assert.equal(saved.refresh, "");
  assert.equal(saved.expires, 0);
  assert.ok(!saved.accountId.includes(key));
  assert.match(saved.accountId, /^Krill Key [a-f0-9]{12} · /);
  assert.equal(JSON.stringify(saved).includes("synthetic-ignored-password"), false);
  assert.equal(websiteToken(saved), undefined);
  assert.equal(websiteToken({ ...saved, access: key }), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.cdn-krill-ai.com/v1/models");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${key}`);
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.redirect, "manual");
});

test("standalone connections distinguish rotated keys and routes without revealing the key in account names", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse(catalog));
  const method = keyLoginMethod(12000);
  const login = async (modelKey, route) => (await method.authorize({ modelKey, route })).callback();
  const a = await login(key, "direct");
  assert.equal((await login(key, "direct")).accountId, a.accountId);
  assert.notEqual((await login(key, "domestic")).accountId, a.accountId);
  assert.notEqual((await login("synthetic-new-key", "direct")).accountId, a.accountId);
});

test("missing, unsafe keys and invalid routes cannot make network requests", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return jsonResponse(catalog); });
  for (const inputs of [{}, { modelKey: "" }, { modelKey: "synthetic\r\ninvalid" }, { modelKey: key, route: "https://other.example" }]) {
    const result = await (await keyLoginMethod(12000).authorize(inputs)).callback();
    assert.equal(result.type, "failed");
    assert.ok(result.error);
    assert.equal(result.modelKey, undefined);
    assert.equal(result.error.includes(key), false);
  }
  assert.equal(calls, 0);
});

test("rejected or malformed model responses never save a key or expose raw errors", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response(key, { status: 401 }));
  for (const fetch of [
    async () => new Response(key, { status: 401 }),
    async () => jsonResponse({ data: [{ id: null }] }),
    async () => { throw new Error(key); },
  ]) {
    mock.mock.mockImplementation(fetch);
    const result = await (await keyLoginMethod(12000).authorize({ modelKey: key })).callback();
    assert.equal(result.type, "failed");
    assert.equal(result.error.includes(key), false);
    assert.equal(result.modelKey, undefined);
  }
});

test("standalone connections can list and call models while quota reports its unconnected state without network", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/models")) return jsonResponse(catalog);
    if (String(url).endsWith("/model-pricing")) return jsonResponse({ success: true, code: 0, data: [] });
    if (String(url).endsWith("/responses")) return new Response("data: synthetic\n\n", { headers: { "content-type": "text/event-stream" } });
    throw new Error("Unexpected website request");
  });
  const hooks = await KrillUsagePlugin({});
  const saved = await (await hooks.auth.methods[1].authorize({ modelKey: key, route: "direct" })).callback();
  const auth = { ...saved, type: "oauth" };
  calls.length = 0;
  const quota = await hooks.auth.usage(async () => auth);
  assert.equal(quota.signIn, "kept");
  assert.equal(quota.error, undefined);
  assert.ok(quota.plan.includes("未连接"));
  assert.deepEqual(quota.windows, []);
  assert.equal(calls.length, 0);
  const models = await hooks.provider.models(null, { auth });
  assert.deepEqual(Object.keys(models["gpt-6.1-sol"].variants), ["low", "medium", "high", "xhigh"]);
  const loader = await hooks.auth.loader(async () => auth);
  const response = await loader.fetch("https://api.krill-code.net/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-6.1-sol", reasoning: { effort: "high" } }) });
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes("synthetic"));
  assert.equal(calls.at(-1).init.headers.get("authorization"), `Bearer ${key}`);
  assert.equal(calls.some(({url}) => /\/api\/(?:auth|subscription)/.test(url)), false);
});
