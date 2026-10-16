import assert from "node:assert/strict";
import test from "node:test";
import { inferenceLoader } from "../src/inference.mjs";
import { TOKEN_A, TOKEN_B } from "./fixtures.mjs";

const modelKey = "synthetic.opaque/key+with=padding";
const auth = { type: "oauth", access: TOKEN_A, modelKey, route: "direct" };
const base = "https://api.krill-code.net/v1";

test("routes each supported model protocol with the model key and forwards the original stream", async (t) => {
  const calls = [];
  const upstreams = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), init });
    const response = new Response("data: synthetic streaming answer\n\n", { headers: { "content-type": "text/event-stream" } });
    upstreams.push(response);
    return response;
  });
  const loader = inferenceLoader(async () => auth);
  for (const path of ["messages", "responses", "chat/completions"]) {
    const signal = new AbortController().signal;
    const body = JSON.stringify({ model: "test", stream: true });
    const response = await loader.fetch(`${base}/${path}`, { method: "POST", body, signal, headers: { authorization: `Bearer ${TOKEN_A}`, "x-api-key": TOKEN_A, cookie: "secret", "content-type": "application/json" } });
    assert.equal(response, upstreams.at(-1));
    const call = calls.at(-1);
    assert.equal(call.init.body, body);
    assert.equal(call.init.signal, signal);
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.headers.get("cookie"), null);
    if (path === "messages") {
      assert.equal(call.init.headers.get("x-api-key"), modelKey);
      assert.equal(call.init.headers.get("authorization"), null);
      assert.equal(call.init.headers.get("anthropic-version"), "2023-06-01");
    } else {
      assert.equal(call.init.headers.get("authorization"), `Bearer ${modelKey}`);
      assert.equal(call.init.headers.get("x-api-key"), null);
    }
    assert.ok(!JSON.stringify([...call.init.headers]).includes(TOKEN_A));
  }
});

test("rejects other hosts, routes and website endpoints before network access", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return new Response("ok"); });
  const loader = inferenceLoader(async () => auth);
  for (const url of ["invalid URL", "https://other.example/v1/responses", "https://www.krill-code.com/api/auth/me", "https://api-slb.krill-code.net/v1/responses", "https://api.krill-code.net/api/tokens", "https://user:password@api.krill-code.net/v1/responses"]) {
    await assert.rejects(loader.fetch(url), { code: "MODEL_DESTINATION" });
  }
  assert.equal(requests, 0);
});

test("a rejected model key keeps website login and returns a safe API error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(`${TOKEN_A} ${modelKey}`, { status: 401 }));
  const response = await inferenceLoader(async () => auth).fetch(`${base}/responses`);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("X-Magpie-Sign-In"), "kept");
  const text = await response.text();
  assert.ok(text.includes("API Key"));
  assert.ok(!text.includes(TOKEN_A));
  assert.ok(!text.includes(modelKey));
});

test("model requests do not follow redirects and preserve upstream failure statuses", async (t) => {
  let redirect;
  t.mock.method(globalThis, "fetch", async (_url, init) => { redirect = init.redirect; return new Response("redirect", { status: 307, headers: { location: "https://other.example/" } }); });
  const response = await inferenceLoader(async () => auth).fetch(`${base}/responses`);
  assert.equal(response.status, 307);
  assert.equal(redirect, "manual");
});

test("account changes use the latest API key, not a captured credential", async (t) => {
  const keys = [];
  let current = auth;
  t.mock.method(globalThis, "fetch", async (_url, init) => { keys.push(init.headers.get("authorization")); return new Response("ok"); });
  const loader = inferenceLoader(async () => current);
  await loader.fetch(`${base}/responses`);
  current = { ...auth, access: TOKEN_B, modelKey: "sk-synthetic-account-b" };
  await loader.fetch(`${base}/responses`);
  assert.deepEqual(keys, [`Bearer ${modelKey}`, "Bearer sk-synthetic-account-b"]);
});

test("passes cancellation through and masks other raw network exceptions", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const mock = t.mock.method(globalThis, "fetch", async () => { throw new Error(modelKey); });
  const loader = inferenceLoader(async () => auth);
  await assert.rejects(loader.fetch(`${base}/responses`, { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(loader.fetch(`${base}/responses`), (error) => error.code === "MODEL_NETWORK" && !error.message.includes(modelKey));
  mock.mock.restore();
});

test("base, fast and ultrafast IDs with every documented effort reach Responses unchanged", async (t) => {
  const calls = [];
  const upstreams = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls.push(init.body);
    const response = new Response("data: synthetic reasoning delta\n\n", { headers: { "content-type": "text/event-stream" } });
    upstreams.push(response);
    return response;
  });
  const loader = inferenceLoader(async () => auth);
  for (const model of ["gpt-6.1-sol", "gpt-6.1-sol-fast", "gpt-6.1-sol-ultrafast"]) {
    for (const effort of ["low", "medium", "high", "xhigh"]) {
      const body = JSON.stringify({ model, reasoning: { effort, summary: "auto" }, stream: true });
      const response = await loader.fetch(`${base}/responses`, { method: "POST", body });
      assert.equal(calls.at(-1), body);
      assert.equal(response, upstreams.at(-1));
    }
  }
});

test("Standard, Fast and Ultrafast keep the base model and reasoning effort independent", async (t) => {
  let sent;
  t.mock.method(globalThis, "fetch", async (_url, init) => { sent = init; return new Response("data: synthetic tier reply\n\n", { headers: { "content-type": "text/event-stream" } }); });
  const loader = inferenceLoader(async () => auth);
  for (const serviceTier of [undefined, "default", "priority", "ultrafast"]) {
    for (const effort of ["low", "medium", "high", "xhigh"]) {
      const body = JSON.stringify({ model: "gpt-6.1-sol", ...(serviceTier ? { service_tier: serviceTier } : {}), reasoning: { effort }, stream: true });
      const response = await loader.fetch(`${base}/responses`, { method: "POST", body });
      assert.equal(sent.body, body);
      assert.equal(JSON.parse(sent.body).model, "gpt-6.1-sol");
      assert.equal(JSON.parse(sent.body).service_tier, serviceTier);
      assert.equal(JSON.parse(sent.body).reasoning.effort, effort);
      assert.equal(response.headers.get("content-type"), "text/event-stream");
    }
  }
  const request = new Request(`${base}/responses`, { method: "POST", body: JSON.stringify({ model: "gpt-6-astra", service_tier: "ultrafast" }) });
  await loader.fetch(request);
  assert.equal(sent.body, request.body);
  assert.equal(JSON.parse(await new Response(sent.body).text()).service_tier, "ultrafast");
});

test("limits and payment/access errors preserve HTTP status and safe retry delays without leaking upstream bodies", async (t) => {
  for (const [status, type] of [[401, "authentication_error"], [402, "insufficient_quota"], [403, "permission_error"], [429, "rate_limit_error"], [500, "upstream_error"], [502, "upstream_error"], [503, "upstream_error"], [504, "upstream_error"]]) {
    const mock = t.mock.method(globalThis, "fetch", async () => new Response(`${modelKey} ${TOKEN_A}`, { status, headers: { "retry-after": "30" } }));
    const response = await inferenceLoader(async () => auth).fetch(`${base}/responses`);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("X-Magpie-Sign-In"), "kept");
    assert.equal(response.headers.get("retry-after"), "30");
    const result = await response.json();
    assert.equal(result.error.type, type);
    assert.equal(JSON.stringify(result).includes(modelKey), false);
    assert.equal(JSON.stringify(result).includes(TOKEN_A), false);
    mock.mock.restore();
  }
});

test("Cloudflare challenges have actionable errors and arbitrary Retry-After text is not forwarded", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(modelKey, { status: 403, headers: { "cf-mitigated": "challenge", "retry-after": modelKey } }));
  const response = await inferenceLoader(async () => auth).fetch(`${base}/responses`);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("retry-after"), null);
  assert.ok((await response.json()).error.message.includes("Cloudflare"));
});

test("unknown parameter errors stay available to Magpie and HTTP-date retry instructions survive", async (t) => {
  const upstream = new Response('{"error":{"message":"unsupported effort"}}', { status: 400 });
  const mock = t.mock.method(globalThis, "fetch", async () => upstream);
  const loader = inferenceLoader(async () => auth);
  assert.equal(await loader.fetch(`${base}/responses`), upstream);
  mock.mock.mockImplementation(async () => new Response("busy", { status: 429, headers: { "retry-after": "Thu, 15 Oct 2026 08:00:00 GMT" } }));
  assert.equal((await loader.fetch(`${base}/responses`)).headers.get("retry-after"), "Thu, 15 Oct 2026 08:00:00 GMT");
});
