import assert from "node:assert/strict";
import test from "node:test";
import { catalogModels, createModelFetcher } from "../src/models.mjs";
import { jsonResponse } from "./fixtures.mjs";

const baseURL = "https://api.krill-code.net/v1";
const sol = "gpt-6.1-sol", astra = "gpt-6-astra";
const catalog = { data: [{ id: "codex-auto-review" }, { id: sol }, { id: astra }] };
const price = (model_name, input = 2, output = 10) => ({
  model_name, enabled: true, model_type: "text", billing_mode: "token",
  input_token_price: String(input), output_token_price: String(output),
  context_window: 1050000, max_output_tokens: 128000, modalities: "text,image",
  route_multipliers: { 直连: "0.2", 均衡: "0.23", cdn: "0.21" },
});
const prices = [price(sol), price(`${sol}-fast`, 5, 25), price(`${sol}-ultrafast`, 16, 80),
  price(astra, 10, 50), price(`${astra}-fast`, 25, 125), price(`${astra}-ultrafast`, 80, 400)];
const auth = { type: "oauth", connection: "model-only", modelKey: "synthetic-speed-key", route: "direct" };

test("speed price rows declare tiers on base models without expanding the model picker", () => {
  const original = structuredClone({ catalog, prices });
  const models = catalogModels(catalog, prices, baseURL);
  assert.deepEqual(Object.keys(models), ["codex-auto-review", sol, astra]);
  for (const p of prices.filter(p => [sol, astra].includes(p.model_name))) {
    const m = models[p.model_name];
    assert.equal(m.id, p.model_name); assert.equal(m.api.id, p.model_name);
    assert.equal(m.api.npm, "@ai-sdk/openai");
    assert.equal(m.cost.input, Number((Number(p.input_token_price) * 0.2).toPrecision(12)));
    assert.equal(m.cost.output, Number((Number(p.output_token_price) * 0.2).toPrecision(12)));
    assert.deepEqual(m.limit, { context: 1050000, output: 128000 });
    assert.deepEqual(Object.keys(m.variants), ["low", "medium", "high", "xhigh"]);
    assert.equal(m.capabilities.input.image, true);
    assert.equal(m.fast, true);
    assert.deepEqual(m.serviceTiers, ["priority", "ultrafast"]);
  }
  assert.equal(models["codex-auto-review"].fast, undefined);
  assert.equal(models[`${sol}-fast`], undefined);
  assert.deepEqual({ catalog, prices }, original, "Catalog and price inputs remain unchanged");
});

test("tier capability requires enabled text/token metadata for a known base and never imports other IDs", () => {
  const candidates = [
    price(`${sol}-fast`), { ...price(`${sol}-ultrafast`), enabled: false },
    price(`${astra}-fast`), price("gpt-7-unknown-fast"), price("codex-auto-review-fast"),
    price(`${sol}-fast-fast`), price("__proto__-fast"),
  ];
  const onlySol = { data: [{ id: sol }, { id: "gpt-7-unknown" }, { id: "codex-auto-review" }, { id: "__proto__" }] };
  const models = catalogModels(onlySol, candidates, baseURL);
  assert.deepEqual(Object.keys(models), [sol, "gpt-7-unknown", "codex-auto-review", "__proto__"]);
  assert.deepEqual(models[sol].serviceTiers, ["priority"]);
  assert.equal(models["gpt-7-unknown"].fast, undefined);
  assert.equal(models["codex-auto-review"].fast, undefined);
  for (const invalid of [
    { enabled: undefined }, { enabled: "true" }, { model_type: "image" },
    { model_type: undefined }, { billing_mode: "request" }, { billing_mode: undefined },
  ]) {
    const invalidModels = catalogModels({ data: [{ id: sol }] }, [{ ...price(`${sol}-fast`), ...invalid }], baseURL);
    assert.deepEqual(Object.keys(invalidModels), [sol]);
    assert.equal(invalidModels[sol].fast, undefined);
    assert.equal(invalidModels[sol].serviceTiers, undefined);
  }
  assert.equal(catalogModels({ data: [{ id: sol }] }, [price(`${sol}-fast`), { ...price(sol), enabled: false }], baseURL)[sol].fast, undefined);
  assert.deepEqual(Object.keys(catalogModels({ data: [{ id: `${sol}-fast` }] }, prices, baseURL)), [`${sol}-fast`]);
  assert.deepEqual(Object.keys(catalogModels({ data: [{ id: sol }] }, [], baseURL)), [sol]);
});

test("IDs actually returned by the model API retain their name and price for compatibility", () => {
  const native = { data: [{ id: sol }, { id: `${sol}-fast`, name: "Upstream Fast name" }] };
  const models = catalogModels(native, prices, baseURL);
  assert.equal(models[`${sol}-fast`].name, "Upstream Fast name");
  assert.equal(models[`${sol}-fast`].fast, undefined);
  assert.equal(models[`${sol}-fast`].serviceTiers, undefined);
  assert.equal(Object.keys(models).filter(id => id === `${sol}-fast`).length, 1);
  for (const metadata of [[], [{ ...price(`${sol}-fast`), enabled: false }]]) {
    const result = catalogModels(native, metadata, baseURL);
    assert.equal(result[`${sol}-fast`].name, "Upstream Fast name");
    assert.equal(Object.hasOwn(result[`${sol}-fast`], "cost"), false);
  }
});

test("metadata refreshes update tier declarations while keeping the model catalog independent", async t => {
  let clock = 1000, currentCatalog = catalog, publicAvailable = true;
  const calls = { models: 0, prices: 0 };
  t.mock.method(globalThis, "fetch", async url => {
    if (url.endsWith("/models")) { calls.models++; return jsonResponse(currentCatalog); }
    calls.prices++; if (!publicAvailable) throw new Error("Synthetic public metadata outage");
    return jsonResponse({ success: true, code: 0, data: prices });
  });
  const fetcher = createModelFetcher({ now: () => clock });
  const first = await fetcher(auth);
  assert.equal(Object.keys(first).length, 3);
  const speed = first[sol];
  assert.equal(speed.fast, true);
  assert.deepEqual(speed.serviceTiers, ["priority", "ultrafast"]);
  assert.deepEqual(speed.cost, { input: 0.4, output: 2 });
  assert.ok(!JSON.stringify(first).includes(auth.modelKey));
  clock += 300_000; publicAvailable = false;
  const outage = await fetcher(auth);
  assert.deepEqual(calls, { models: 2, prices: 2 }); assert.equal(Object.keys(outage).length, 3);
  assert.equal(outage[sol].fast, undefined);
  assert.equal(outage[sol].serviceTiers, undefined);
  assert.equal(outage[sol].cost, undefined);
  publicAvailable = true; clock += 60_000;
  const restored = await fetcher(auth);
  assert.equal(Object.keys(restored).length, 3);
  assert.deepEqual(restored[sol].serviceTiers, ["priority", "ultrafast"]);
  currentCatalog = { data: [{ id: astra }] }; clock += 60_000;
  const removed = await fetcher(auth);
  assert.deepEqual(Object.keys(removed), [astra]);
  assert.deepEqual(calls, { models: 4, prices: 3 });
});

test("base and speed prices stay separate for upgraded accounts with retired price associations", async t => {
  t.mock.method(globalThis, "fetch", async url => url.endsWith("/models")
    ? jsonResponse({ data: [{ id: sol }] }) : jsonResponse({ success: true, code: 0, data: prices }));
  const fetcher = createModelFetcher();
  const account = { ...auth, connection: undefined, access: "synthetic.payload.signature", krillTokenId: 7, pricingChannelId: 10 };
  const models = await fetcher(account);
  assert.deepEqual(models[sol].cost, { input: 0.4, output: 2 });
  assert.equal(models[`${sol}-fast`], undefined);
  assert.equal(models[`${sol}-ultrafast`], undefined);
  assert.deepEqual(models[sol].serviceTiers, ["priority", "ultrafast"]);
});

test("an Ultrafast-only price does not invent Fast support or extra model IDs", () => {
  const models = catalogModels({ data: [{ id: sol }] }, [price(`${sol}-ultrafast`, 16, 80)], baseURL);
  assert.deepEqual(Object.keys(models), [sol]);
  assert.equal(models[sol].fast, false);
  assert.deepEqual(models[sol].serviceTiers, ["ultrafast"]);
});
