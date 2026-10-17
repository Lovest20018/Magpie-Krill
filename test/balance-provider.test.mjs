import assert from "node:assert/strict";
import test from "node:test";
import { KrillUsagePlugin, KrillBalancePlugin } from "../index.mjs";
import { TOKEN_A, jsonResponse } from "./fixtures.mjs";
import { catalogModels, createModelFetcher } from "../src/models.mjs";
import { websiteAccounts } from "../src/website-accounts.mjs";

const key = "synthetic-balance-key";
const envelope = data => ({ success: true, code: 0, data });
const inputs = { email: "synthetic@example.test", password: "synthetic-password", modelKey: key, route: "direct" };
const prices = [
  { model_name: "claude-sonnet-4-5", model_type: "text", is_balance_available: true },
  { model_name: "plan-only", model_type: "text", is_balance_available: false },
  { model_name: "image-only", model_type: "image", is_balance_available: true },
  { model_name: "not-permitted-by-key", model_type: "text", is_balance_available: true },
];
const catalog = { data: ["claude-sonnet-4-5", "plan-only", "image-only", "unclassified"].map(id => ({ id })) };

test("one plugin registers distinct native subscription and balance providers without changing existing config", async () => {
  const config = {};
  for (const [plugin, id, name] of [[KrillUsagePlugin, "krill", "Krill · 套餐"], [KrillBalancePlugin, "krill-balance", "Krill · 余额"]]) {
    const hooks = await plugin({});
    await hooks.config(config);
    assert.equal(hooks.auth.provider, id);
    assert.equal(hooks.provider.id, id);
    assert.equal(config.provider[id].name, name);
    assert.equal(hooks.auth.methods.length, 2);
    assert.deepEqual(await hooks.provider.models(), {});
    const custom = { provider: { [id]: { name: "Synthetic custom name" } } };
    await hooks.config(custom);
    assert.equal(custom.provider[id].name, "Synthetic custom name");
  }
  assert.deepEqual(Object.keys(config.provider), ["krill", "krill-balance"]);
});

test("one website login serves both providers and balance linking requires only its own model Key", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async url => { calls++; return jsonResponse(url.endsWith("/models") ? catalog : envelope({ token: TOKEN_A, user: { email: inputs.email, id: 7 } })); });
  const balance = await KrillBalancePlugin({}), subscription = await KrillUsagePlugin({});
  assert.equal(balance.auth.methods[0].label, subscription.auth.methods[0].label);
  const required = balance.auth.methods[0].prompts.find(p => p.key === "modelKey");
  assert.ok(required.validate(""));
  assert.equal(subscription.auth.methods[0].prompts.find(p => p.key === "modelKey").validate(""), undefined);
  const fail = await (await balance.auth.methods[0].authorize({ ...inputs, modelKey: "" })).callback();
  assert.equal(fail.type, "failed");
  assert.equal(calls, 0);
  const website = await (await subscription.auth.methods[0].authorize({ ...inputs, websiteAccount: "new-account", modelKey: "" })).callback();
  const websiteAccount = websiteAccounts.observe({ ...website, type: "oauth" });
  const saved = await (await balance.auth.methods[0].authorize({ modelKey: key, route: "direct", websiteAccount })).callback();
  assert.equal(saved.type, "success");
  assert.equal(calls, 2);
  assert.equal(saved.email, inputs.email);
  assert.equal(saved.access, website.access);
  assert.equal(saved.websiteShared, true);
  assert.match(saved.accountId, /^Krill Key [a-f0-9]{12} · 海外线路$/);
  assert.equal(JSON.stringify(saved).includes(inputs.password), false);
});

test("multiple Keys and routes of the same email stay distinct; switching login method retains the Key identity", async t => {
  t.mock.method(globalThis, "fetch", async url => jsonResponse(url.endsWith("/models") ? catalog : envelope({ token: TOKEN_A, user: { email: inputs.email, id: 7 } })));
  const hooks = await KrillBalancePlugin({});
  const primary = await KrillUsagePlugin({});
  const website = await (await primary.auth.methods[0].authorize({ ...inputs, websiteAccount: "new-account", modelKey: "" })).callback();
  const websiteAccount = websiteAccounts.observe({ ...website, type: "oauth" });
  const login = async (method, changes = {}) => (await hooks.auth.methods[method].authorize({ modelKey: key, route: "direct", websiteAccount, ...changes })).callback();
  const web = await login(0), standalone = await login(1);
  assert.equal(web.accountId, standalone.accountId);
  assert.notEqual((await login(0, { modelKey: "synthetic-second-key" })).accountId, web.accountId);
  assert.notEqual((await login(0, { route: "cdn" })).accountId, web.accountId);
  assert.equal((await login(0)).accountId, web.accountId);
});

test("TOTP is completed once in the shared website login and is not requested again by balance linking", async t => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.endsWith("/models")) return jsonResponse(catalog);
    bodies.push(JSON.parse(init.body));
    assert.equal(init.body.includes(key), false);
    return jsonResponse(envelope(url.endsWith("/totp") ? { token: TOKEN_A, user: { email: inputs.email } } : { requires_totp: true, pending_token: "synthetic-pending" }));
  });
  const primary = await KrillUsagePlugin({});
  const flow = await primary.auth.methods[0].authorize({ ...inputs, websiteAccount: "new-account", modelKey: "" });
  assert.equal(flow.method, "code");
  const website = await flow.callback("123456");
  const websiteAccount = websiteAccounts.observe({ ...website, type: "oauth" });
  const hooks = await KrillBalancePlugin({});
  const saved = await (await hooks.auth.methods[0].authorize({ modelKey: key, route: "direct", websiteAccount })).callback();
  assert.equal(saved.type, "success");
  assert.equal(saved.modelKey, key);
  assert.deepEqual(bodies[1], { pending_token: "synthetic-pending", totp_code: "123456" });
  assert.match(saved.accountId, /^Krill Key /);
  assert.equal(bodies.length, 2);
});

test("Key-only balance usage has no website requests and its independent inference credential still works", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls++;
    assert.equal(String(url), "https://api.krill-code.net/v1/responses");
    assert.equal(init.headers.get("authorization"), `Bearer ${key}`);
    return new Response("data: synthetic\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const hooks = await KrillBalancePlugin({});
  const auth = { type: "oauth", connection: "model-only", access: "", modelKey: key, route: "direct" };
  const usage = await hooks.auth.usage(async () => auth);
  assert.match(usage.plan, /未连接官网统计/);
  assert.equal(usage.balance, undefined);
  assert.deepEqual(usage.windows, []);
  assert.equal(calls, 0);
  const loader = await hooks.auth.loader(async () => auth);
  assert.match(await (await loader.fetch("https://api.krill-code.net/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-6-astra", service_tier: "ultrafast" }) })).text(), /synthetic/);
  assert.equal(calls, 1);
});

test("an image-only Key connects and its full image group reaches the native model hook", async t => {
  const ids = ["gpt-image-2", "private-group-image"];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.endsWith("/models")) {
      assert.equal(init.headers.authorization, `Bearer ${key}`);
      return jsonResponse({ data: ids.map(id => ({ id, model_type: "image" })) });
    }
    assert.equal(url, "https://www.krill-code.com/api/public/model-pricing");
    assert.equal(init.headers.authorization, undefined);
    return jsonResponse(envelope([{ model_name: "gpt-image-2", model_type: "image", is_balance_available: false }]));
  });
  const hooks = await KrillBalancePlugin({});
  const result = await (await hooks.auth.methods[1].authorize({ modelKey: key, route: "direct" })).callback();
  assert.equal(result.type, "success");
  const models = await hooks.provider.models(null, { auth: { ...result, type: "oauth" } });
  assert.deepEqual(Object.keys(models), ids);
  assert.ok(Object.values(models).every(model => model.capabilities.output.image === true));
});

test("balance preserves every Key model regardless of type or public availability flags, without adding price-only models", () => {
  const balance = catalogModels(catalog, prices, "https://api.krill-code.net/v1", prices, { balance: true });
  assert.deepEqual(Object.keys(balance), catalog.data.map(item => item.id));
  assert.equal(balance["claude-sonnet-4-5"].api.npm, "@ai-sdk/anthropic");
  assert.deepEqual(balance["image-only"].capabilities.output, { image: true });
  assert.equal(balance["image-only"].capabilities.reasoning, false);
  assert.equal(balance.unclassified.capabilities.reasoning, false);
  assert.equal(balance.unclassified.capabilities.toolcall, false);
  assert.equal(balance.unclassified.serviceTiers, undefined);
  assert.deepEqual(Object.keys(catalogModels(catalog, prices, "https://api.krill-code.net/v1")), ["claude-sonnet-4-5", "plan-only", "unclassified"]);
  assert.deepEqual(catalogModels({ data: [{ id: "known-image", model_type: "image" }] }, [], "https://api.krill-code.net/v1"), {});
  const diverse = { data: ["image", "video", "audio", "embedding", "private-unknown"].map(model_type => ({ id: `private-${model_type}`, model_type })) };
  const all = catalogModels(diverse, [], "https://api.krill-code.net/v1", [], { balance: true });
  assert.deepEqual(Object.keys(all), diverse.data.map(item => item.id));
  assert.deepEqual(all["private-video"].capabilities.output, { video: true });
  assert.deepEqual(all["private-audio"].capabilities.output, { audio: true });
  assert.deepEqual(all["private-embedding"].capabilities.output, {});
});

test("an optional metadata outage keeps all balance models and their known media types without stale prices", async t => {
  let clock = 0, offline = false;
  t.mock.method(globalThis, "fetch", async url => {
    if (url.endsWith("/models")) return jsonResponse(catalog);
    if (offline) throw new Error("Synthetic metadata outage");
    return jsonResponse(envelope(prices));
  });
  const fetchModels = createModelFetcher({ balance: true, now: () => clock });
  const auth = { type: "oauth", modelKey: key, route: "direct" };
  assert.deepEqual(Object.keys(await fetchModels(auth)), catalog.data.map(item => item.id));
  offline = true; clock += 300_000;
  const result = await fetchModels(auth);
  assert.deepEqual(Object.keys(result), catalog.data.map(item => item.id));
  assert.deepEqual(result["image-only"].capabilities.output, { image: true });
  assert.equal(result["image-only"].cost, undefined);
});

test("catalog caches stay isolated by provider even for the same Key and website identity", async t => {
  let catalogs = 0;
  t.mock.method(globalThis, "fetch", async url => {
    if (url.endsWith("/models")) { catalogs++; return jsonResponse(catalog); }
    return jsonResponse(envelope(prices));
  });
  const subscription = await KrillUsagePlugin({}), balance = await KrillBalancePlugin({});
  const auth = { type: "oauth", access: TOKEN_A, modelKey: key, accountId: inputs.email, route: "direct" };
  const [a, b] = await Promise.all([subscription.provider.models(null, { auth }), balance.provider.models(null, { auth })]);
  assert.ok(a["plan-only"]);
  assert.ok(b["plan-only"]);
  assert.deepEqual(b["image-only"].capabilities.output, { image: true });
  assert.equal(a["image-only"], undefined);
  assert.equal(catalogs, 2);
  await balance.provider.models(null, { auth });
  assert.equal(catalogs, 2);
});

test("two balance Keys of the same website account list their own group models, including text models absent from public prices", async t => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (!url.endsWith("/models")) return jsonResponse(envelope(prices));
    const credential = init.headers.authorization;
    seen.push(credential);
    const ids = credential === `Bearer ${key}` ? ["claude-sonnet-4-5", "private-group-text"] : ["gemini-group-text"];
    return jsonResponse({ data: ids.map(id => ({ id })) });
  });
  const hooks = await KrillBalancePlugin({});
  const auth = { type: "oauth", access: TOKEN_A, email: inputs.email, modelKey: key, route: "direct" };
  const first = await hooks.provider.models(null, { auth });
  const second = await hooks.provider.models(null, { auth: { ...auth, modelKey: "synthetic-second-group-key" } });
  assert.deepEqual(Object.keys(first), ["claude-sonnet-4-5", "private-group-text"]);
  assert.deepEqual(Object.keys(second), ["gemini-group-text"]);
  assert.deepEqual(Object.keys(await hooks.provider.models(null, { auth })), Object.keys(first));
  assert.deepEqual(seen, [`Bearer ${key}`, "Bearer synthetic-second-group-key"]);
  assert.equal(first["private-group-text"].cost, undefined);
});
