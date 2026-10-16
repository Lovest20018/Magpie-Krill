import assert from "node:assert/strict";
import test from "node:test";
import { catalogModels, createModelFetcher } from "../src/models.mjs";
import { TOKEN_A, jsonResponse } from "./fixtures.mjs";

const base = "https://api.krill-code.net/v1";
const auth = { type: "oauth", access: TOKEN_A, modelKey: "krill-synthetic-model-key", route: "direct" };
const catalog = { object: "list", data: [{ id: "claude-sonnet-4-5" }, { id: "gpt-5" }, { id: "gemini-pro" }, { id: "image-only" }] };
const prices = [
  {
    model_name: "claude-sonnet-4-5", model_type: "text", context_window: 200000, max_output_tokens: 64000, modalities: "text,image",
    billing_mode: "token", input_token_price: "3", output_token_price: "15",
    cache_read_input_token_price: "0.3", cache_creation_token_price: "3.75",
    route_multipliers: { 均衡: "0.23", 直连: "0.2", cdn: "0.21" },
  },
  { model_name: "image-only", model_type: "image" },
];
const fetchModels = (account, timeoutMs) => createModelFetcher({ timeoutMs })(account);

test("models use the correct upstream API and reported context limits without inventing metadata", () => {
  const models = catalogModels(catalog, prices, base);
  assert.deepEqual(Object.keys(models), ["claude-sonnet-4-5", "gpt-5", "gemini-pro"]);
  assert.equal(models["claude-sonnet-4-5"].api.npm, "@ai-sdk/anthropic");
  assert.deepEqual(models["claude-sonnet-4-5"].limit, { context: 200000, output: 64000 });
  assert.equal(models["claude-sonnet-4-5"].capabilities.input.image, true);
  assert.deepEqual(models["claude-sonnet-4-5"].cost, { input: 0.6, output: 3, cache: { read: 0.06, write: 0.75 } });
  assert.equal(Object.hasOwn(models["gpt-5"], "cost"), false, "An absent Krill price must stay unknown");
  assert.equal(models["gpt-5"].api.npm, "@ai-sdk/openai");
  assert.equal(models["gemini-pro"].api.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(models["gpt-5"].limit, { context: 0, output: 0 });
  assert.ok(Object.values(models).every((m) => m.api.url === base));
});

test("catalog fetching sends only API key to the selected model host; public metadata uses no credential", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    seen.push({ url, init });
    return url.endsWith("/models") ? jsonResponse(catalog) : jsonResponse({ success: true, code: 0, data: prices });
  });
  const models = await fetchModels(auth, 12000);
  assert.equal(Object.keys(models).length, 3);
  assert.equal(models["claude-sonnet-4-5"].cost.output, 3);
  assert.equal(seen[0].url, `${base}/models`);
  assert.equal(seen[0].init.headers.authorization, `Bearer ${auth.modelKey}`);
  assert.equal(seen[1].url, "https://www.krill-code.com/api/public/model-pricing");
  assert.equal(seen[1].init.headers.authorization, undefined);
  assert.ok(!JSON.stringify(seen).includes(TOKEN_A));
});

test("legacy JWT-only accounts expose no models and make no model requests", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return jsonResponse(catalog); });
  assert.deepEqual(await fetchModels({ type: "api", key: TOKEN_A }, 12000), {});
  assert.deepEqual(await fetchModels(undefined, 12000), {});
  assert.equal(requests, 0);
});

test("metadata outages still permit model discovery; catalog failures preserve website login", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/models")) return jsonResponse(catalog);
    throw new Error("synthetic metadata outage");
  });
  const models = await fetchModels(auth, 12000);
  assert.ok(models["gpt-5"]);
  assert.equal(Object.hasOwn(models["claude-sonnet-4-5"], "cost"), false);
  mock.mock.restore();
  t.mock.method(globalThis, "fetch", async (url) => url.endsWith("/models") ? new Response("", { status: 401 }) : jsonResponse({ success: true, code: 0, data: [] }));
  await assert.rejects(fetchModels(auth, 12000), { code: "MODEL_KEY", signIn: "kept" });
});

test("invalid catalog envelopes fail instead of appearing to be a successful empty listing", () => {
  for (const value of [{}, { data: null }, { data: [null] }, { data: [{ id: "" }] }, { data: new Array(5001).fill({ id: "test" }) }]) {
    assert.throws(() => catalogModels(value, prices, base), { code: "MODEL_RESPONSE" });
  }
  const special = catalogModels({ data: [{ id: "__proto__" }] }, [], base);
  assert.equal(Object.keys(special)[0], "__proto__");
  assert.equal(Object.getPrototypeOf(special), Object.prototype);
});

test("concurrent and repeated requests share a catalog without sharing mutable results", async (t) => {
  let catalogs = 0;
  let metadata = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/models")) { catalogs++; return jsonResponse(catalog); }
    metadata++;
    return jsonResponse({ success: true, code: 0, data: prices });
  });
  const discover = createModelFetcher();
  const [a, b] = await Promise.all([discover(auth), discover(auth)]);
  a["gpt-5"].api.url = "https://other.example";
  assert.equal(b["gpt-5"].api.url, base);
  assert.equal((await discover(auth))["gpt-5"].api.url, base);
  assert.equal(catalogs, 1);
  assert.equal(metadata, 1);
});

test("changing account, API key or route bypasses cached catalogs immediately", async (t) => {
  const calls = [];
  let metadata = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.endsWith("/models")) {
      calls.push({ url, key: init.headers.authorization });
      return jsonResponse(catalog);
    }
    metadata++;
    return jsonResponse({ success: true, code: 0, data: prices });
  });
  const discover = createModelFetcher();
  await discover({ ...auth, accountId: "a" });
  await discover({ ...auth, accountId: "b" });
  await discover({ ...auth, accountId: "b", modelKey: "sk-synthetic-rotated" });
  const domestic = await discover({ ...auth, accountId: "b", modelKey: "sk-synthetic-rotated", route: "domestic" });
  assert.equal(calls.length, 4);
  assert.equal(calls[2].key, "Bearer sk-synthetic-rotated");
  assert.equal(calls[3].url, "https://api-slb.krill-code.net/v1/models");
  assert.equal(domestic["gpt-5"].api.url, "https://api-slb.krill-code.net/v1");
  assert.equal(domestic["claude-sonnet-4-5"].cost.input, 0.69);
  assert.equal(metadata, 1, "Public metadata has no account-specific data");
});

test("catalogs refresh after one minute and public metadata after five minutes", async (t) => {
  let clock = 1_000;
  let catalogs = 0;
  let metadata = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/models")) { catalogs++; return jsonResponse(catalog); }
    metadata++;
    return jsonResponse({ success: true, code: 0, data: prices });
  });
  const discover = createModelFetcher({ now: () => clock });
  await discover(auth);
  clock += 59_999;
  await discover(auth);
  assert.equal(catalogs, 1);
  clock++;
  await discover(auth);
  assert.equal(catalogs, 2);
  assert.equal(metadata, 1);
  clock += 240_000;
  await discover(auth);
  assert.equal(catalogs, 3);
  assert.equal(metadata, 2);
});

test("failed catalog refresh rejects stale success and a later retry reaches the server", async (t) => {
  let clock = 1_000;
  let rejectKey = false;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (!url.endsWith("/models")) return jsonResponse({ success: true, code: 0, data: [] });
    calls++;
    return rejectKey ? new Response("", { status: 401 }) : jsonResponse(catalog);
  });
  const discover = createModelFetcher({ now: () => clock });
  await discover(auth);
  clock += 60_000;
  rejectKey = true;
  await assert.rejects(discover(auth), { code: "MODEL_KEY", signIn: "kept" });
  rejectKey = false;
  assert.ok((await discover(auth))["gpt-5"]);
  assert.equal(calls, 3);
});

test("optional metadata outages are retried with the next catalog refresh", async (t) => {
  let clock = 1_000;
  let available = false;
  let metadata = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/models")) return jsonResponse(catalog);
    metadata++;
    if (!available) throw new Error("synthetic metadata outage");
    return jsonResponse({ success: true, code: 0, data: prices });
  });
  const discover = createModelFetcher({ now: () => clock });
  assert.equal((await discover(auth))["claude-sonnet-4-5"].limit.context, 0);
  available = true;
  clock += 60_000;
  assert.equal((await discover(auth))["claude-sonnet-4-5"].limit.context, 200000);
  assert.equal(metadata, 2);
});

test("the catalog cache evicts old accounts instead of retaining unbounded credentials", async (t) => {
  let catalogs = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/models")) { catalogs++; return jsonResponse(catalog); }
    return jsonResponse({ success: true, code: 0, data: [] });
  });
  const discover = createModelFetcher();
  for (let i = 0; i < 51; i++) await discover({ ...auth, accountId: `synthetic-${i}` });
  await discover({ ...auth, accountId: "synthetic-0" });
  assert.equal(catalogs, 52);
});

test("Krill price changes refresh after five minutes and failed refreshes do not present stale costs", async (t) => {
  let clock = 1_000;
  let currentInput = "3";
  let available = true;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/models")) return jsonResponse(catalog);
    if (!available) throw new Error("synthetic price outage");
    return jsonResponse({ success: true, code: 0, data: [{ ...prices[0], input_token_price: currentInput }] });
  });
  const discover = createModelFetcher({ now: () => clock });
  const first = await discover(auth);
  assert.equal(first["claude-sonnet-4-5"].cost.input, 0.6);
  first["claude-sonnet-4-5"].cost.input = 999;
  currentInput = "4";
  clock += 60_000;
  assert.equal((await discover(auth))["claude-sonnet-4-5"].cost.input, 0.6);
  clock += 239_999;
  assert.equal((await discover(auth))["claude-sonnet-4-5"].cost.input, 0.6);
  clock++;
  assert.equal((await discover(auth))["claude-sonnet-4-5"].cost.input, 0.8);
  clock += 300_000;
  available = false;
  assert.equal(Object.hasOwn((await discover(auth))["claude-sonnet-4-5"], "cost"), false);
  available = true;
  clock += 60_000;
  assert.equal((await discover(auth))["claude-sonnet-4-5"].cost.input, 0.8);
});

test("retired price associations and website tokens neither override public prices nor trigger authenticated metadata reads", async t => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    seen.push({ url, headers: init.headers });
    if (url === `${base}/models`) return jsonResponse(catalog);
    assert.equal(url, "https://www.krill-code.com/api/public/model-pricing");
    assert.equal(init.headers.authorization, undefined);
    return jsonResponse({ success: true, code: 0, data: prices });
  });
  const discover = createModelFetcher();
  const associated = Object.freeze({ ...auth, krillTokenId: 7, pricingChannelId: 10 });
  const before = structuredClone(associated);
  assert.equal((await discover(associated))["claude-sonnet-4-5"].cost.input, 0.6);
  assert.equal((await discover({ ...associated, access: "synthetic-new-login", krillTokenId: 8, pricingChannelId: 11 }))["claude-sonnet-4-5"].cost.input, 0.6);
  assert.equal(seen.length, 2, "Obsolete fields and website token rotation do not create extra catalog reads");
  assert.deepEqual(associated, before, "Upgrade must not migrate or rewrite existing credentials");
  assert.ok(!JSON.stringify(seen).includes(TOKEN_A));
});

test("malformed optional price rows and envelopes cannot break model discovery or invent prices", async t => {
  for (const data of [null, {}, [null, true, "invalid-row", { ...prices[0], time_window_rules: {} }]]) {
    const mock = t.mock.method(globalThis, "fetch", async url => url.endsWith("/models") ? jsonResponse(catalog) : jsonResponse({ success: true, code: 0, data }));
    const models = await createModelFetcher()(auth);
    assert.ok(models["gpt-5"]);
    assert.equal(models["gpt-5"].cost, undefined);
    assert.equal(models["claude-sonnet-4-5"].cost?.input, Array.isArray(data) ? 0.6 : undefined);
    mock.mock.restore();
  }
});
