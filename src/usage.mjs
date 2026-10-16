import { UsageError } from "./errors.mjs";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function invalidResponse() {
  return new UsageError("INVALID_RESPONSE", "Krill 额度接口返回结构无法识别，接口可能已变更，请稍后重试。");
}

function number(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function date(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function money(value) {
  const parsed = number(value);
  return parsed === null ? "未知" : `$${parsed.toFixed(2)}`;
}

const expiryFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function expirySuffix(until) {
  // Magpie separates a window's count and percentage at " · ". Keep
  // multi-plan expiry inside the count so it cannot hide the percentage.
  return until ? `（${expiryFormat.format(new Date(until))} 到期）` : "";
}

function incompleteQuota() {
  return new UsageError("INCOMPLETE_QUOTA", "Krill 返回的有效套餐额度不完整，无法计算使用比例，请稍后重试。");
}

function percent(remaining, limit) {
  const used = Math.max(0, (1 - remaining / limit) * 100);
  if (!Number.isFinite(used)) throw invalidResponse();
  return Math.round(used * 10_000) / 10_000;
}

function amountFields(remaining, limit, unit, until) {
  // Magpie ignores display when limit is supplied, and clamps amounts at
  // zero. Keep explicit text where that would hide a plan's expiry,
  // negative remaining allowance, or extra credits above the limit.
  if (until || remaining < 0 || remaining > limit) return {};
  return { amount: Number((limit - remaining).toPrecision(15)), limit, unit };
}

function dollarWindow(name, remaining, limit, until, reset, start) {
  if (remaining === null || limit === null || limit <= 0) throw incompleteQuota();
  const span = start && reset ? (Date.parse(reset) - Date.parse(start)) / 1000 : 0;
  return {
    name, used: percent(remaining, limit),
    display: `剩余 ${money(remaining)} / ${money(limit)}${expirySuffix(until)}`,
    ...amountFields(remaining, limit, "USD", until),
    ...(reset ? { resetsAt: reset } : {}),
    ...(span > 0 ? { span } : {}),
    aside: true,
  };
}

function remainingFromUsed(limit, used, fallback) {
  // Krill's window remaining can include rollover credits. Its dashboard
  // uses the window's own limit minus used for the current week's bar.
  if (used == null) return number(fallback);
  const parsed = number(used);
  if (limit === null || parsed === null || parsed < 0) throw incompleteQuota();
  return limit - parsed;
}

export function subscriptionUsage(json) {
  if (!isRecord(json) || json.success !== true || json.code !== 0 || !isRecord(json.data)) {
    throw invalidResponse();
  }
  const { subscriptions, credit_balance_usd: balance } = json.data;
  if (!Array.isArray(subscriptions) || subscriptions.length > 500) {
    throw invalidResponse();
  }
  let incomplete = subscriptions.some((sub) => !isRecord(sub));
  const active = subscriptions.filter((sub) => isRecord(sub) && sub.status === "active");
  const primary = active.find((sub) => number(sub.quota?.remaining_usd) > 0) ?? active[0];
  const planName = (sub) => typeof sub.plan?.name === "string" && sub.plan.name.trim()
    ? sub.plan.name.trim().slice(0, 120)
    : "Krill 套餐";

  const windows = [];
  // Isolate independently meaningful windows. Missing `used` would be shown
  // as 0% by Magpie, so omit the invalid bar and retain an explicit warning.
  const add = (read) => {
    try {
      const window = read();
      if (window) windows.push(window);
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      incomplete = true;
    }
  };
  for (const sub of active.filter((sub) => sub.plan?.billing_type !== "request_count")) {
    const quota = isRecord(sub.quota) ? sub.quota : {};
    const limit = number(quota.daily_limit_usd);
    const until = date(sub.subscription_end_at);
    // A single plan's expiry is already in Magpie's card heading. With
    // multiple plans, keep each plan's expiry alongside its allowance.
    const displayUntil = active.length > 1 ? until : undefined;
    const reset = date(quota.window_reset_at);
    const type = sub.plan?.billing_type;
    if (sub.plan?.total_credits != null || quota.limit_credits != null) {
      add(() => {
        const credits = number(quota.limit_credits), remaining = number(quota.remaining_credits);
        if (credits === null || credits <= 0 || remaining === null) throw incompleteQuota();
        return { name: `${planName(sub)} · 积分`, used: percent(remaining, credits), display: `剩余 ${remaining} / ${credits} 积分${expirySuffix(displayUntil)}`,
          ...amountFields(remaining, credits, "积分", displayUntil), aside: true, ...(reset ? { resetsAt: reset } : {}) };
      });
      continue;
    }
    if (type != null && !["usd_weekly", "usd_monthly", "usd_daily"].includes(type)) {
      incomplete = true;
      continue;
    }
    const label = type === "usd_weekly" ? "本周" : type ? "套餐总额" : "";
    add(() => {
      // Krill's dashboard uses subscription totals for usd_daily, and the
      // quota fields for usd_monthly. Both are displayed as total allowance.
      const daily = type === "usd_daily";
      const currentLimit = daily ? number(sub.total_limit_usd) : limit;
      const remaining = daily ? remainingFromUsed(currentLimit, sub.total_used_usd, sub.total_remaining_usd) : remainingFromUsed(limit, quota.used_usd, quota.remaining_usd);
      return dollarWindow(`${planName(sub)}${label ? ` · ${label}` : ""}`, remaining, currentLimit, displayUntil,
        !type || type === "usd_weekly" ? reset : undefined, !type || type === "usd_weekly" ? date(quota.window_start_at) : undefined);
    });
    if (type === "usd_weekly" && ["total_limit_usd", "total_remaining_usd", "total_used_usd"].some((key) => sub[key] != null)) {
      add(() => {
        const totalLimit = number(sub.total_limit_usd);
        const totalRemaining = sub.total_remaining_usd != null ? number(sub.total_remaining_usd) : remainingFromUsed(totalLimit, sub.total_used_usd);
        // Use reported totals; duration_days only decides whether an equal
        // total describes another window, never multiplies a weekly limit.
        const total = dollarWindow(`${planName(sub)} · 套餐总额`, totalRemaining, totalLimit, displayUntil);
        if (totalLimit !== limit || number(sub.plan?.duration_days) > 7) return total;
      });
    }
    // Keep the primary pair together in Magpie's two-column card.
    const forwardedLimit = number(quota.forwarded_limit_usd);
    if (type === "usd_weekly" && (quota.forwarded_limit_usd != null || quota.forwarded_used_usd != null)) add(() => {
      if (forwardedLimit === 0 && [null, 0].includes(number(quota.forwarded_used_usd))) return;
      return dollarWindow(`${planName(sub)} · 结转额度`, remainingFromUsed(forwardedLimit, quota.forwarded_used_usd), forwardedLimit, displayUntil);
    });
  }

  if (active.some((sub) => sub.plan?.billing_type === "request_count")) {
    const quota = isRecord(json.data.request_count_quota) ? json.data.request_count_quota : {};
    // The endpoint returns one account-wide pool shared by count plans.
    // cycle_end is not a weekly reset timestamp, so do not reuse it here.
    for (const [key, label] of [["5h", "5 小时"], ["weekly", "本周"], ["monthly", "本月"]]) {
      add(() => {
        const limit = number(quota[`limit_${key}`]);
        const used = number(quota[`used_${key}`]);
        if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(used) || used < 0) throw incompleteQuota();
        if (limit === 0) return;
        return { name: `请求次数 · ${label}`, used: percent(limit - used, limit), display: `已用 ${used} / ${limit} 次`,
          ...amountFields(limit - used, limit, "次"), aside: true };
      });
    }
  }

  const plan = primary ? `${planName(primary)}${active.length > 1 ? ` 等 ${active.length} 个有效套餐` : ""}` : "无有效订阅套餐";
  return {
    // A top-level error makes Magpie hide all windows. Keep a visible
    // warning in the plan summary when some windows are still readable;
    // no synthetic "unknown" bar or percentage is added.
    plan: incomplete && windows.length ? `${plan}（部分额度未知）` : plan,
    ...(date(primary?.subscription_end_at) ? { until: date(primary.subscription_end_at) } : {}),
    ...(number(balance) !== null ? { balance: money(balance) } : {}),
    ...(incomplete ? { signIn: "kept", ...(!windows.length ? { error: "套餐额度暂不可读：数据不完整或类型未识别，请刷新重试。" } : {}) } : {}),
    windows,
  };
}
