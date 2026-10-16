import assert from "node:assert/strict";
import test from "node:test";
import { fetchSubscription, SUBSCRIPTION_URL, MAX_RESPONSE_BYTES } from "../src/api.mjs";
import { TOKEN_A, payload, jsonResponse } from "./fixtures.mjs";

test("sends a GET to the fixed Krill endpoint with a normalized credential and redirects disabled", async () => {
  let seen;
  const data = await fetchSubscription(`Bearer "${TOKEN_A}"`, {
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return jsonResponse();
    },
  });
  assert.deepEqual(data, payload());
  assert.equal(seen.url, SUBSCRIPTION_URL);
  assert.equal(seen.init.method, "GET");
  assert.equal(seen.init.headers.authorization, `Bearer ${TOKEN_A}`);
  assert.equal(seen.init.redirect, "manual");
  assert.ok(seen.init.signal instanceof AbortSignal);
  assert.equal(seen.init.body, undefined);
});

test("an invalid credential causes no network request", async () => {
  let requests = 0;
  await assert.rejects(fetchSubscription("invalid", {
    fetchImpl: async () => { requests++; return jsonResponse(); },
  }), { code: "INVALID_TOKEN" });
  assert.equal(requests, 0);
});

test("marks only a rejected credential as expired; other HTTP failures preserve login", async () => {
  for (const [status, code, signIn] of [[401, "UNAUTHORIZED", "expired"], [403, "HTTP", "kept"], [429, "RATE_LIMIT", "kept"], [500, "HTTP", "kept"], [302, "REDIRECT", "kept"]]) {
    await assert.rejects(fetchSubscription(TOKEN_A, {
      fetchImpl: async () => new Response(TOKEN_A, { status, headers: { location: "https://other.example/" } }),
    }), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.signIn, signIn);
      assert.ok(!error.message.includes(TOKEN_A));
      return true;
    });
  }
});

test("Cloudflare challenges take priority over the HTTP status", async () => {
  await assert.rejects(fetchSubscription(TOKEN_A, {
    fetchImpl: async () => new Response("challenge", { status: 401, headers: { "cf-mitigated": "challenge" } }),
  }), { code: "CF_CHALLENGE", signIn: "kept" });
});

test("masks raw network exceptions and non-JSON response bodies", async () => {
  for (const [fetchImpl, code] of [
    [async () => { throw new Error(`network leaked ${TOKEN_A}`); }, "NETWORK"],
    [async () => new Response(`<html>${TOKEN_A}</html>`), "INVALID_JSON"],
  ]) {
    await assert.rejects(fetchSubscription(TOKEN_A, { fetchImpl }), (error) => {
      assert.equal(error.code, code);
      assert.ok(!error.message.includes(TOKEN_A));
      return true;
    });
  }
});

test("timeout aborts a pending request", async () => {
  let aborted = false;
  await assert.rejects(fetchSubscription(TOKEN_A, {
    timeoutMs: 20,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
    }),
  }), { code: "TIMEOUT", signIn: "kept" });
  assert.equal(aborted, true);
});

test("timeout also covers body streaming after response headers arrive", async () => {
  await assert.rejects(fetchSubscription(TOKEN_A, {
    timeoutMs: 20,
    fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'));
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    })),
  }), { code: "TIMEOUT" });
});

test("limits both declared and streamed response sizes and cancels oversized bodies", async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    await assert.rejects(fetchSubscription(TOKEN_A, {
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1)); },
        cancel() { cancelled = true; },
      }), { headers: declared ? { "content-length": String(MAX_RESPONSE_BYTES + 1) } : {} }),
    }), { code: "TOO_LARGE" });
    assert.equal(cancelled, true);
  }
});

test("decodes UTF-8 characters split between response chunks", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload()));
  const result = await fetchSubscription(TOKEN_A, {
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    })),
  });
  assert.deepEqual(result, payload());
});
