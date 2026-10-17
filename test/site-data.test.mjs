import assert from "node:assert/strict";
import test from "node:test";
import { createSiteReader, siteUsage, todayRange } from "../src/site-data.mjs";
import { TOKEN_A, TOKEN_B, jsonResponse, payload } from "./fixtures.mjs";

const envelope = data => ({ success: true, code: 0, data });
const auth = { type: "oauth", access: TOKEN_A, email: "synthetic@example.test", modelKey: "synthetic-model-key" };
const response = (url, balance = "12.34") => jsonResponse(url.endsWith("/credits") ? envelope({ balance_usd: balance })
  : url.endsWith("/stats") ? envelope({ total_requests: 12, total_tokens: 12345 })
    : url.endsWith("/quota-summary") ? envelope({ total_credit_cost_usd: "0.1234", total_cost_usd: "999", same_day_quota_charged_usd: "888" }) : payload());

test("today queries match Krill's Beijing wall-clock encoding across midnight and year boundaries", () => {
  assert.deepEqual(todayRange(Date.parse("2026-10-17T15:59:59Z")), { start_time: "2026-10-17T00:00:00", end_time: "2026-10-17T23:59" });
  assert.deepEqual(todayRange(Date.parse("2026-10-17T16:00:00Z")), { start_time: "2026-10-18T00:00:00", end_time: "2026-10-18T00:00" });
  assert.equal(todayRange(Date.parse("2026-12-31T16:00:00Z")).start_time, "2027-01-01T00:00:00");
});

test("balance summaries use actual wallet deductions and label account-wide calls without fabricated quota bars", async () => {
  const calls = [];
  const read = createSiteReader({ now: () => Date.parse("2026-10-17T04:25:59Z"), fetchImpl: async (url, init) => {
    calls.push(url);
    assert.equal(init.headers.authorization, `Bearer ${TOKEN_A}`);
    assert.equal(init.redirect, "manual");
    if (init.method === "POST") assert.deepEqual(JSON.parse(init.body), { start_time: "2026-10-17T00:00:00", end_time: "2026-10-17T12:25" });
    return response(url);
  } });
  const usage = siteUsage(await read(auth, { balance: true }), { balance: true, email: auth.email, modelKey: auth.modelKey });
  assert.equal(usage.balance, "$12.34（账号共享）");
  assert.match(usage.plan, /北京时间.*余额扣费 \$0\.1234.*官网账号全部调用 12 次 \/ 12,345 tokens/);
  assert.doesNotMatch(usage.plan, /999|888/);
  assert.equal(usage.user, auth.email);
  assert.equal(usage.signIn, "kept");
  assert.equal(usage.error, undefined);
  assert.deepEqual(usage.windows, []);
  assert.equal(calls.length, 3);
  assert.equal(calls.some(url => url.endsWith("/subscription") || url.endsWith("/tokens")), false);
});

test("wallet reads are fresh, concurrent identical contexts coalesce, summaries cache for at most 60 seconds", async () => {
  let clock = Date.parse("2026-10-17T04:00:00Z");
  const counts = new Map();
  const read = createSiteReader({ now: () => clock, fetchImpl: async url => { counts.set(url, (counts.get(url) ?? 0) + 1); return response(url); } });
  const options = { balance: true };
  const [a, b] = await Promise.all([read(auth, options), read(auth, options)]);
  a.stats.requests = 999;
  assert.equal(b.stats.requests, 12);
  assert.deepEqual([...counts.values()], [1, 1, 1]);
  clock += 59_999;
  assert.equal((await read(auth, options)).stats.requests, 12);
  assert.deepEqual([...counts.values()], [2, 1, 1]);
  clock++;
  await read(auth, options);
  assert.deepEqual([...counts.values()], [3, 2, 2]);
});

test("a new Beijing day bypasses summaries even within 60 seconds", async () => {
  let clock = Date.parse("2026-10-17T15:59:59Z");
  const ranges = [];
  const read = createSiteReader({ now: () => clock, fetchImpl: async (url, init) => { if (init.body) ranges.push(JSON.parse(init.body).start_time); return response(url); } });
  await read(auth, { balance: true });
  clock += 1000;
  await read(auth, { balance: true });
  assert.deepEqual(ranges, ["2026-10-17T00:00:00", "2026-10-17T00:00:00", "2026-10-18T00:00:00", "2026-10-18T00:00:00"]);
});

test("identical email with different JWTs never shares wallet or statistics", async () => {
  const calls = [];
  const read = createSiteReader({ fetchImpl: async (url, init) => { calls.push(init.headers.authorization); return response(url, init.headers.authorization.endsWith(TOKEN_A) ? "10" : "20"); } });
  const [a, b] = await Promise.all([read(auth, { balance: true }), read({ ...auth, access: TOKEN_B }, { balance: true })]);
  assert.equal(a.credits, 10);
  assert.equal(b.credits, 20);
  assert.equal(calls.filter(value => value.endsWith(TOKEN_A)).length, 3);
  assert.equal(calls.filter(value => value.endsWith(TOKEN_B)).length, 3);
});

test("an aggregate request finishing after Beijing midnight cannot display yesterday as today", async () => {
  let clock = Date.parse("2026-10-17T15:59:59Z");
  const read = createSiteReader({ now: () => clock, fetchImpl: async url => {
    clock = Date.parse("2026-10-17T16:00:00Z");
    return response(url);
  } });
  const usage = siteUsage(await read(auth, { balance: true }), { balance: true });
  assert.equal(usage.balance, "$12.34（账号共享）");
  assert.match(usage.plan, /日期已切换/);
  assert.match(usage.plan, /扣费 未知.*未知 次 \/ 未知 tokens/);
  assert.equal(usage.error, undefined);
  assert.match(siteUsage(await read(auth, { balance: true }), { balance: true }).plan, /12,345 tokens/);
});

test("subscription and balance providers can coalesce a shared JWT wallet read without adding its amount", async () => {
  let credits = 0;
  const read = createSiteReader({ fetchImpl: async url => { if (url.endsWith("/credits")) credits++; return response(url); } });
  const [a, b] = await Promise.all([read(auth), read(auth, { balance: true })]);
  assert.equal(credits, 1);
  assert.equal(siteUsage(a).balance, "$12.34（账号共享）");
  assert.equal(siteUsage(b, { balance: true }).balance, "$12.34（账号共享）");
  assert.equal(a.subscription.windows[0].used, 60);
});

test("partial failures preserve the fresh wallet and known statistics, never infer missing values as zero", async () => {
  const read = createSiteReader({ fetchImpl: async url => {
    if (url.endsWith("/stats")) return jsonResponse(envelope({ total_requests: "7" }));
    if (url.endsWith("/quota-summary")) throw new Error(TOKEN_A);
    return response(url);
  } });
  const usage = siteUsage(await read(auth, { balance: true }), { balance: true, modelKey: auth.modelKey });
  assert.equal(usage.balance, "$12.34（账号共享）");
  assert.match(usage.plan, /余额扣费 未知.*7 次 \/ 未知 tokens/);
  assert.match(usage.plan, /部分未知.*暂不可读/);
  assert.equal(usage.error, undefined);
  assert.deepEqual(usage.windows, []);
  assert.equal(JSON.stringify(usage).includes(TOKEN_A), false);
});

test("zero and negative wallets and true zero statistics are valid without progress bars", async () => {
  for (const balance of ["0", "-2.50"]) {
    const read = createSiteReader({ fetchImpl: async url => jsonResponse(envelope(url.endsWith("/credits") ? { balance_usd: balance }
      : url.endsWith("/stats") ? { total_requests: 0, total_tokens: 0 } : { total_credit_cost_usd: "0" })) });
    const usage = siteUsage(await read(auth, { balance: true }), { balance: true });
    assert.equal(usage.balance, `$${Number(balance).toFixed(2)}（账号共享）`);
    assert.match(usage.plan, /扣费 \$0.00.*0 次 \/ 0 tokens/);
    assert.equal(usage.error, undefined);
    assert.deepEqual(usage.windows, []);
  }
});

test("malformed money and aggregate fields stay unknown and cannot produce false zero values", async () => {
  for (const bad of [null, "", false, {}, "NaN", Infinity]) {
    const read = createSiteReader({ fetchImpl: async url => jsonResponse(envelope(url.endsWith("/credits") ? { balance_usd: bad }
      : url.endsWith("/stats") ? { total_requests: bad, total_tokens: bad } : { total_credit_cost_usd: bad })) });
    const usage = siteUsage(await read(auth, { balance: true }), { balance: true });
    assert.equal(usage.balance, undefined);
    assert.ok(usage.error);
    assert.match(usage.plan, /扣费 未知.*未知 次 \/ 未知 tokens/);
    assert.deepEqual(usage.windows, []);
  }
});

test("negative deductions, fractional or unsafe counts are rejected instead of repaired", async () => {
  const read = createSiteReader({ fetchImpl: async url => jsonResponse(envelope(url.endsWith("/credits") ? { balance_usd: "5" }
    : url.endsWith("/stats") ? { total_requests: 1.5, total_tokens: Number.MAX_SAFE_INTEGER + 1 } : { total_credit_cost_usd: "-1" })) });
  const usage = siteUsage(await read(auth, { balance: true }), { balance: true });
  assert.match(usage.plan, /扣费 未知.*未知 次 \/ 未知 tokens/);
  assert.equal(usage.error, undefined);
});

test("small real deductions do not round to an apparently free request", () => {
  for (const [deduction, expected] of [[0.000123, "$0.000123"], [0.00000001, "<$0.000001"]]) {
    const usage = siteUsage({ credits: 1, deduction, warnings: [], expired: false }, { balance: true });
    assert.ok(usage.plan.includes(`余额扣费 ${expected}`));
    assert.deepEqual(usage.windows, []);
  }
});

test("expired site auth clears cached summaries, preserves model Key and never reuses the old wallet", async () => {
  let expired = false;
  const read = createSiteReader({ fetchImpl: async url => expired ? new Response("", { status: 401 }) : response(url) });
  await read(auth, { balance: true });
  expired = true;
  const result = await read(auth, { balance: true });
  const usage = siteUsage(result, { balance: true, modelKey: auth.modelKey });
  assert.equal(usage.balance, undefined);
  assert.equal(result.stats, undefined);
  assert.equal(result.deduction, undefined);
  assert.equal(usage.signIn, "kept");
  assert.match(usage.error, /登录已失效.*模型 Key 仍可使用/);
  assert.doesNotMatch(usage.plan, /12,345/);
  assert.equal(siteUsage(result, { balance: true }).signIn, "expired");
});

test("failed aggregate refreshes do not return stale success or cache errors", async () => {
  let clock = 0, failed = false;
  const read = createSiteReader({ now: () => clock, fetchImpl: async url => {
    if (failed && url.endsWith("/stats")) throw new Error("synthetic outage");
    return response(url);
  } });
  await read(auth, { balance: true });
  clock += 60_000; failed = true;
  assert.equal((await read(auth, { balance: true })).stats, undefined);
  failed = false;
  assert.equal((await read(auth, { balance: true })).stats.requests, 12);
});

test("subscription wallet fallback and missing plans retain meaningful partial data", async () => {
  const read = createSiteReader({ fetchImpl: async url => url.endsWith("/credits") ? new Response("", { status: 503 }) : jsonResponse(payload([])) });
  const usage = siteUsage(await read(auth));
  assert.equal(usage.balance, "$123.45（账号共享）");
  assert.match(usage.plan, /无有效订阅套餐.*共享余额暂不可读/);
  assert.equal(usage.error, undefined);
  assert.deepEqual(usage.windows, []);
});

test("Key-only and malformed website credentials are rejected before any account request", async () => {
  let calls = 0;
  const read = createSiteReader({ fetchImpl: async () => { calls++; throw new Error("unexpected request"); } });
  for (const value of [{ ...auth, connection: "model-only" }, { ...auth, access: "invalid\r\nvalue" }]) {
    await assert.rejects(read(value, { balance: true }), { signIn: "expired" });
  }
  assert.equal(calls, 0);
});
