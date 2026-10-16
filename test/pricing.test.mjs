import assert from "node:assert/strict";
import test from "node:test";
import { krillModelCost } from "../src/pricing.mjs";
import { routeURL } from "../src/routes.mjs";

const price = {
  model_name: "synthetic-model", billing_mode: "token", enabled: true,
  input_token_price: "2.0000000000", output_token_price: "10.0000000000",
  cache_read_input_token_price: "0.2000000000", cache_creation_token_price: "2.5000000000",
  route_multipliers: { 均衡: "0.2300000000", 直连: "0.2000000000", cdn: "0.2100000000" },
};

test("Krill prices stay in USD per million tokens and use the selected route's multiplier", () => {
  assert.deepEqual(krillModelCost(price, routeURL("domestic")), { input: 0.46, output: 2.3, cache: { read: 0.046, write: 0.575 } });
  assert.deepEqual(krillModelCost(price, routeURL("direct")), { input: 0.4, output: 2, cache: { read: 0.04, write: 0.5 } });
  assert.deepEqual(krillModelCost(price, routeURL("cdn")), { input: 0.42, output: 2.1, cache: { read: 0.042, write: 0.525 } });
});

test("routes without overrides use the Krill base price and 5-minute cache writes take priority", () => {
  const noOverride = { ...price, route_multipliers: {}, cache_creation_5m_token_price: "3" };
  assert.deepEqual(krillModelCost(noOverride, routeURL()), { input: 2, output: 10, cache: { read: 0.2, write: 3 } });
  assert.equal(krillModelCost({ ...price, route_multipliers: undefined }, routeURL()).input, 2);
});

test("zero and tiny valid prices survive without being replaced by vendor defaults", () => {
  assert.deepEqual(krillModelCost({ ...price, route_multipliers: { 直连: 0 } }, routeURL("direct")), {
    input: 0, output: 0, cache: { read: 0, write: 0 },
  });
  const tiny = krillModelCost({ ...price, input_token_price: "0.0000000001", route_multipliers: { 直连: "0.001" } }, routeURL("direct"));
  assert.equal(tiny.input, 1e-13);
});

test("missing or malformed token prices and route factors are unknown, not zero or official prices", () => {
  for (const invalid of [undefined, null, "", " ", true, false, -1, "-2", "NaN", Infinity, {}, "0x10"]) {
    assert.equal(krillModelCost({ ...price, input_token_price: invalid }, routeURL()), undefined);
    assert.equal(krillModelCost({ ...price, output_token_price: invalid }, routeURL()), undefined);
    assert.equal(krillModelCost({ ...price, route_multipliers: { 直连: invalid } }, routeURL("direct")), undefined);
  }
  assert.equal(krillModelCost({ ...price, route_multipliers: [] }, routeURL()), undefined);
  assert.equal(krillModelCost({ ...price, route_multipliers: "0.2" }, routeURL()), undefined);
  assert.equal(krillModelCost({ ...price, input_token_price: Number.MAX_VALUE, route_multipliers: { 直连: 2 } }, routeURL("direct")), undefined);
  assert.deepEqual(krillModelCost({ ...price, cache_read_input_token_price: null, cache_creation_token_price: null }, routeURL("direct")), { input: 0.4, output: 2 });
});

test("request billing and unknown routes cannot masquerade as per-token prices", () => {
  for (const billing_mode of [undefined, "request", "duration", "unknown"]) {
    assert.equal(krillModelCost({ ...price, billing_mode, request_price_usd: "0.3" }, routeURL()), undefined);
  }
  assert.equal(krillModelCost({ ...price, enabled: false }, routeURL()), undefined);
  assert.equal(krillModelCost(price, "https://other.example/v1"), undefined);
});

test("flat model-list estimates use standard rates rather than silently applying conditional discounts", () => {
  const conditional = {
    ...price,
    high_context_rule: { enabled: true, input_tokens_threshold: 272000, input_token_price: "4", output_token_price: "15" },
    time_window_rules: [{ enabled: true, start_minute: 0, end_minute: 1439, input_token_price: "1", output_token_price: "5" }],
  };
  assert.deepEqual(krillModelCost(conditional, routeURL("direct")), krillModelCost(price, routeURL("direct")));
});
