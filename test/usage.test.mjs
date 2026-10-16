import assert from "node:assert/strict";
import test from "node:test";
import { subscriptionUsage } from "../src/usage.mjs";
import { payload, subscription } from "./fixtures.mjs";

test("converts remaining quota to USED percentage, balance and server timestamps", () => {
  const result = subscriptionUsage(payload());
  assert.equal(result.plan, "轻享月卡");
  assert.equal(result.balance, "$123.45");
  assert.equal(result.until, "2030-02-01T00:00:00.000Z");
  assert.deepEqual(result.windows, [{
    name: "轻享月卡",
    used: 60,
    display: "剩余 $240.00 / $600.00",
    amount: 360, limit: 600, unit: "USD",
    resetsAt: "2030-01-08T00:00:00.000Z",
    aside: true,
  }]);
  assert.equal(result.windows[0].span, undefined, "Do not infer a reset period from a plan's duration");
});

test("preserves server order for active plans and chooses the first spendable plan as the headline", () => {
  const result = subscriptionUsage(payload([
    subscription({ name: "已冻结", status: "frozen" }),
    subscription({ name: "A", remaining: "0" }),
    subscription({ name: "B", remaining: "12.5", limit: "50" }),
    subscription({ name: "已过期", status: "expired" }),
  ]));
  assert.equal(result.plan, "B 等 2 个有效套餐");
  assert.deepEqual(result.windows.map((window) => [window.name, window.used]), [["A", 100], ["B", 75]]);
  assert.ok(result.windows.every((window) => window.aside), "One exhausted plan must not disable other allowances");
});

test("retains zero quota and overuse; does not clamp usage at 100%", () => {
  assert.equal(subscriptionUsage(payload([subscription({ remaining: "0" })])).windows[0].used, 100);
  assert.equal(subscriptionUsage(payload([subscription({ remaining: "-60" })])).windows[0].used, 110);
  assert.equal(subscriptionUsage(payload([subscription({ remaining: "700" })])).windows[0].used, 0);
});

test("shows account balance when there are no active subscriptions", () => {
  for (const subscriptions of [[], [subscription({ status: "expired" })], [subscription({ status: "frozen" })]]) {
    assert.deepEqual(subscriptionUsage(payload(subscriptions, "0")), {
      plan: "无有效订阅套餐", balance: "$0.00", windows: [],
    });
  }
});

test("keeps balance when every active plan is exhausted", () => {
  const result = subscriptionUsage(payload([subscription({ remaining: "0" })], "5.75"));
  assert.equal(result.balance, "$5.75");
  assert.equal(result.windows[0].used, 100);
});

test("does not invent balance, reset or expiry when fields are missing or invalid", () => {
  const sub = subscription();
  sub.subscription_end_at = "invalid";
  sub.quota.window_reset_at = "invalid";
  const result = subscriptionUsage(payload([sub], null));
  assert.equal(result.balance, undefined);
  assert.equal(result.until, undefined);
  assert.equal(result.windows[0].resetsAt, undefined);
  assert.equal(result.windows[0].display, "剩余 $240.00 / $600.00");
});

test("incomplete quota fails explicitly instead of rendering a false 0%", () => {
  for (const remaining of [null, undefined, "", " ", true, {}, "NaN", "Infinity"]) {
    const sub = subscription();
    sub.quota.remaining_usd = remaining;
    const result = subscriptionUsage(payload([sub]));
    assert.match(result.error, /不完整/); assert.deepEqual(result.windows, []); assert.equal(result.balance, "$123.45");
  }
  for (const limit of [null, "", true, "0", "-1", "Infinity"]) {
    const result = subscriptionUsage(payload([subscription({ limit })]));
    assert.match(result.error, /不完整/); assert.deepEqual(result.windows, []);
  }
});

test("rejects changed envelopes, malformed subscription lists and unbounded lists", () => {
  for (const json of [null, [], {}, { ...payload(), success: false }, { ...payload(), code: 1 }, { ...payload(), data: [] }, payload(null), payload(new Array(501).fill(subscription()))]) {
    assert.throws(() => subscriptionUsage(json), { code: "INVALID_RESPONSE", signIn: "kept" });
  }
});

function weekly() {
  const sub = subscription({ name: "轻享月卡", remaining: "440", limit: "600" });
  Object.assign(sub.plan, { billing_type: "usd_weekly", duration_days: 30 });
  Object.assign(sub.quota, { used_usd: "160", window_start_at: "2030-01-01T00:00:00Z" });
  Object.assign(sub, { total_limit_usd: "2400", total_remaining_usd: "1840" });
  return sub;
}

test("weekly-billed month plans expose the actual weekly window and separate subscription total", () => {
  const result = subscriptionUsage(payload([weekly()]));
  assert.equal(result.plan, "轻享月卡");
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0].name, "轻享月卡 · 本周");
  assert.equal(result.windows[0].used, 26.6667);
  assert.match(result.windows[0].display, /剩余 \$440\.00 \/ \$600\.00/);
  assert.equal(result.windows[0].resetsAt, "2030-01-08T00:00:00.000Z");
  assert.equal(result.windows[0].span, 7 * 86400);
  assert.equal(result.windows[1].name, "轻享月卡 · 套餐总额");
  assert.equal(result.windows[1].used, 23.3333);
  assert.match(result.windows[1].display, /剩余 \$1840\.00 \/ \$2400\.00/);
  assert.equal(result.windows[1].resetsAt, undefined, "Expiry is not a reset");
  assert.equal(result.windows[1].span, undefined);
  assert.ok(result.windows.every((window) => window.aside), "Individual limits must not disable the whole account");
});

test("weekly usage excludes separately reported rollover and uses server totals rather than a duration multiple", () => {
  const sub = weekly();
  sub.quota.remaining_usd = "490";
  sub.quota.forwarded_limit_usd = "100"; sub.quota.forwarded_used_usd = "50";
  sub.total_limit_usd = "1800"; sub.total_remaining_usd = "1200";
  const result = subscriptionUsage(payload([sub]));
  assert.deepEqual(result.windows.map((window) => window.name), ["轻享月卡 · 本周", "轻享月卡 · 套餐总额", "轻享月卡 · 结转额度"]);
  assert.equal(result.windows[2].used, 50);
  assert.match(result.windows[0].display, /剩余 \$440\.00/);
  assert.match(result.windows[1].display, /剩余 \$1200\.00 \/ \$1800\.00/);
});

test("missing weekly totals and dates are not fabricated, and the final week may be shorter than seven days", () => {
  const sub = weekly();
  delete sub.total_limit_usd; delete sub.total_remaining_usd;
  sub.quota.window_start_at = "2030-01-06T00:00:00Z";
  const result = subscriptionUsage(payload([sub]));
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].span, 2 * 86400);
  delete sub.quota.window_start_at; delete sub.quota.window_reset_at;
  assert.equal(subscriptionUsage(payload([sub])).windows[0].resetsAt, undefined);
  assert.equal(subscriptionUsage(payload([sub])).windows[0].span, undefined);
  assert.equal(subscriptionUsage(payload([subscription({ name: "月卡周限套餐" })])).windows[0].name, "月卡周限套餐", "Do not infer billing type from the name");
});

test("weekly totals can use reported used amounts, reject partial metadata and preserve overuse", () => {
  const sub = weekly(); delete sub.total_remaining_usd; sub.total_used_usd = "300";
  assert.match(subscriptionUsage(payload([sub])).windows[1].display, /剩余 \$2100\.00 \/ \$2400\.00/);
  sub.quota.used_usd = "660";
  assert.equal(subscriptionUsage(payload([sub])).windows[0].used, 110);
  for (const bad of [null, "", "not-a-number", 0]) {
    const invalid = weekly(); invalid.total_limit_usd = bad;
    const result = subscriptionUsage(payload([invalid]));
    assert.equal(result.error, undefined); assert.match(result.plan, /部分额度未知/); assert.equal(result.windows.length, 1); assert.match(result.windows[0].name, /本周/);
  }
  sub.quota.used_usd = "bad";
  const result = subscriptionUsage(payload([sub]));
  assert.equal(result.error, undefined); assert.match(result.plan, /部分额度未知/); assert.equal(result.windows.length, 1); assert.match(result.windows[0].name, /套餐总额/);
});

function counted() {
  const sub = subscription({ name: "次数套餐" }); sub.plan.billing_type = "request_count"; delete sub.quota;
  const json = payload([sub]);
  json.data.request_count_quota = { used_5h: 2, limit_5h: 10, used_weekly: 35, limit_weekly: 100, used_monthly: 80, limit_monthly: 400, cycle_end: "2030-02-01" };
  return json;
}

test("count plans display shared 5-hour, weekly and monthly request limits without inventing weekly reset times", () => {
  const json = counted(); json.data.subscriptions.push({ ...json.data.subscriptions[0], subscription_id: 2 });
  const result = subscriptionUsage(json);
  assert.equal(result.windows.length, 3, "The endpoint's shared pool is not duplicated for each count plan");
  assert.deepEqual(result.windows.map((window) => [window.name, window.used, window.display]), [
    ["请求次数 · 5 小时", 20, "已用 2 / 10 次"],
    ["请求次数 · 本周", 35, "已用 35 / 100 次"],
    ["请求次数 · 本月", 20, "已用 80 / 400 次"],
  ]);
  assert.ok(result.windows.every((window) => window.resetsAt === undefined && window.aside));
});

test("missing or invalid count usage cannot appear as zero, and zero limits do not make fake quota bars", () => {
  const noQuota = counted(); delete noQuota.data.request_count_quota;
  assert.match(subscriptionUsage(noQuota).error, /不完整/); assert.deepEqual(subscriptionUsage(noQuota).windows, []);
  for (const used of [undefined, null, "", -1, 1.5, true]) {
    const json = counted(); json.data.request_count_quota.used_weekly = used;
    const result = subscriptionUsage(json); assert.equal(result.error, undefined); assert.match(result.plan, /部分额度未知/);
    assert.deepEqual(result.windows.map(w => w.name), ["请求次数 · 5 小时", "请求次数 · 本月"]);
  }
  const zero = counted(); zero.data.request_count_quota.limit_5h = 0;
  assert.equal(subscriptionUsage(zero).windows.length, 2);
  zero.data.request_count_quota.used_weekly = 110;
  assert.equal(subscriptionUsage(zero).windows[0].used, 110);
});

test("daily and monthly plans match dashboard total semantics, without a false daily reset", () => {
  const daily = subscription(); daily.plan.billing_type = "usd_daily";
  Object.assign(daily, { total_limit_usd: "1800", total_used_usd: "600" });
  let result = subscriptionUsage(payload([daily]));
  assert.equal(result.windows[0].used, 33.3333); assert.match(result.windows[0].display, /\$1200.00 \/ \$1800.00/);
  assert.match(result.windows[0].name, /套餐总额/); assert.equal(result.windows[0].resetsAt, undefined);
  daily.plan.billing_type = "usd_monthly";
  result = subscriptionUsage(payload([daily])); assert.equal(result.windows[0].used, 60); assert.match(result.windows[0].display, /\$240.00 \/ \$600.00/);
});

test("invalid subscriptions, unknown billing and malformed rollover do not hide valid quota or balance", () => {
  const bad = weekly(); bad.quota.forwarded_limit_usd = "bad";
  const unknown = subscription(); unknown.plan.billing_type = "future-type";
  const result = subscriptionUsage(payload([null, { status: "active" }, unknown, bad, subscription({ name: "正常" })]));
  assert.equal(result.windows.length, 3); assert.equal(result.windows[2].name, "正常");
  assert.equal(result.balance, "$123.45"); assert.equal(result.signIn, "kept"); assert.equal(result.error, undefined); assert.match(result.plan, /部分额度未知/);
});

test("credit allowances keep their actual units, including zero and overuse", () => {
  const sub = subscription(); sub.plan.total_credits = 1000;
  Object.assign(sub.quota, { limit_credits: "1000", remaining_credits: "750" });
  const result = subscriptionUsage(payload([sub])); assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].used, 25); assert.match(result.windows[0].display, /750 \/ 1000 积分/);
  sub.quota.remaining_credits = 0; assert.equal(subscriptionUsage(payload([sub])).windows[0].used, 100);
  sub.quota.remaining_credits = -100; assert.equal(subscriptionUsage(payload([sub])).windows[0].used, 110);
  delete sub.quota.limit_credits;
  assert.deepEqual(subscriptionUsage(payload([sub])).windows, [], "Do not substitute dollars for missing credits");
});

test("normal monetary windows expose amounts for native Used/Left switching without changing window names", () => {
  const result = subscriptionUsage(payload([weekly()]));
  assert.deepEqual(result.windows.map(w => [w.name, w.amount, w.limit, w.unit]), [
    ["轻享月卡 · 本周", 160, 600, "USD"], ["轻享月卡 · 套餐总额", 560, 2400, "USD"],
  ]);
  const decimal = subscriptionUsage(payload([subscription({ limit: "0.3", remaining: "0.2" })])).windows[0];
  assert.equal(decimal.amount, 0.1);
  const zero = subscriptionUsage(payload([subscription({ remaining: "0" })])).windows[0];
  assert.equal(zero.amount, 600);
});

test("multiple-plan expiry and exceptional remaining amounts retain explicit text instead of being hidden by the native counter", () => {
  const a = weekly(), b = weekly(); b.plan.name = "另一套餐"; b.subscription_end_at = "2030-03-01T00:00:00Z";
  const result = subscriptionUsage(payload([a, b]));
  assert.equal(result.windows.length, 4);
  for (const w of result.windows) {
    assert.equal(Object.hasOwn(w, "limit"), false);
    assert.match(w.display, /到期/);
  }
  assert.match(result.windows[2].display, /2030\/03\/01/);
  for (const remaining of ["-60", "700"]) {
    const w = subscriptionUsage(payload([subscription({ remaining })])).windows[0];
    assert.equal(Object.hasOwn(w, "limit"), false);
    assert.match(w.display, new RegExp(remaining));
  }
});

test("credits and request-count windows use their own structured units and preserve overuse", () => {
  const credit = subscription(); credit.plan.total_credits = 1000;
  Object.assign(credit.quota, { limit_credits: 1000, remaining_credits: 750 });
  const w = subscriptionUsage(payload([credit])).windows[0];
  assert.deepEqual([w.amount, w.limit, w.unit], [250, 1000, "积分"]);
  const counts = subscriptionUsage(counted()).windows;
  assert.deepEqual(counts.map(w => [w.amount, w.limit, w.unit]), [[2, 10, "次"], [35, 100, "次"], [80, 400, "次"]]);
  const over = counted(); over.data.request_count_quota.used_weekly = 110;
  const exhausted = subscriptionUsage(over).windows[1];
  assert.equal(exhausted.used, 110); assert.match(exhausted.display, /110 \/ 100/); assert.equal(exhausted.limit, undefined);
});

test("partial failures warn in the plan summary while wholly unreadable quotas retain a top-level error", () => {
  const bad = weekly(); bad.quota.used_usd = "bad";
  const partial = subscriptionUsage(payload([bad]));
  assert.equal(partial.error, undefined);
  assert.equal(partial.plan, "轻享月卡（部分额度未知）");
  assert.deepEqual(partial.windows.map(w => w.name), ["轻享月卡 · 套餐总额"]);
  const whole = subscriptionUsage(payload([subscription({ remaining: null })]));
  assert.match(whole.error, /额度暂不可读/); assert.deepEqual(whole.windows, []); assert.equal(whole.balance, "$123.45");
  const healthy = subscriptionUsage(payload([weekly()]));
  assert.doesNotMatch(healthy.plan, /部分额度未知/); assert.equal(healthy.error, undefined);
});
