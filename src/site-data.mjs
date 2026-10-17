import { createHash } from "node:crypto";
import { fetchAccountData } from "./api.mjs";
import { unwrap } from "./http.mjs";
import { UsageError } from "./errors.mjs";
import { normalizeToken } from "./token.mjs";
import { websiteToken } from "./routes.mjs";
import { subscriptionUsage } from "./usage.mjs";

const SUMMARY_CACHE_MS = 60_000;
const MAX_CONTEXTS = 50;
const LABELS = { credits: "共享余额", subscription: "套餐额度", stats: "今日请求/token", deduction: "今日余额扣费" };
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = () => new UsageError("ACCOUNT_RESPONSE", "Krill 官网统计返回结构无法识别，请刷新重试。");
const numeric = value => {
  if (!["number", "string"].includes(typeof value) || (typeof value === "string" && !value.trim())) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};
const count = value => {
  const n = numeric(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
};

// Match the public DateRangePicker: Beijing wall time, to the minute,
// without a timezone suffix, independent of the machine's timezone.
export function todayRange(now = Date.now()) {
  const local = new Date(now + 8 * 60 * 60 * 1000).toISOString();
  return { start_time: `${local.slice(0, 10)}T00:00:00`, end_time: local.slice(0, 16) };
}

function normalize(kind, json) {
  if (kind === "subscription") return subscriptionUsage(json);
  const data = unwrap(json);
  if (!record(data)) throw invalid();
  if (kind === "credits") {
    const balance = numeric(data.balance_usd);
    if (balance === undefined) throw invalid();
    return balance;
  }
  if (kind === "deduction") {
    const cost = numeric(data.total_credit_cost_usd);
    if (cost === undefined || cost < 0) throw invalid();
    return cost;
  }
  const requests = count(data.total_requests), tokens = count(data.total_tokens);
  if (requests === undefined && tokens === undefined) throw invalid();
  return { requests, tokens };
}

export function createSiteReader({ now = Date.now, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  const contexts = new Map();
  return async function readSite(auth, { balance = false, timeoutMs = 12_000 } = {}) {
    const token = normalizeToken(websiteToken(auth));
    // Only the exact same JWT may share account totals, never email alone.
    // Cache keys retain a digest, not website credentials.
    const key = createHash("sha256").update(token).update(`:${timeoutMs}`).digest("hex");
    const context = contexts.get(key) ?? { pending: new Map(), summaries: new Map() };
    contexts.delete(key); contexts.set(key, context);
    while (contexts.size > MAX_CONTEXTS) contexts.delete(contexts.keys().next().value);
    const range = todayRange(now());
    const read = kind => {
      const aggregate = kind === "stats" || kind === "deduction";
      const day = range.start_time;
      const cached = context.summaries.get(kind);
      if (aggregate && cached?.day === day && now() < cached.until) return Promise.resolve(structuredClone(cached.value));
      const pendingKey = aggregate ? `${kind}:${day}` : kind;
      if (context.pending.has(pendingKey)) return context.pending.get(pendingKey);
      const started = now();
      const pending = (async () => {
        const value = normalize(kind, await fetchAccountData(kind, token, {
          ...(aggregate ? { body: range } : {}), timeoutMs, fetchImpl,
        }));
        if (aggregate) context.summaries.set(kind, { value, day, until: started + SUMMARY_CACHE_MS });
        return value;
      })().finally(() => context.pending.delete(pendingKey));
      context.pending.set(pendingKey, pending);
      return pending;
    };
    const kinds = balance ? ["credits", "stats", "deduction"] : ["credits", "subscription"];
    const settled = await Promise.allSettled(kinds.map(read));
    const result = { warnings: [], expired: false };
    settled.forEach((item, i) => {
      const kind = kinds[i];
      if (item.status === "fulfilled") {
        result[kind] = structuredClone(item.value);
        if (kind === "stats" && [item.value.requests, item.value.tokens].includes(undefined)) result.warnings.push(`${LABELS[kind]}部分未知`);
      } else {
        result.warnings.push(`${LABELS[kind]}暂不可读`);
        result.expired ||= item.reason instanceof UsageError && item.reason.signIn === "expired";
        result.error ??= item.reason instanceof UsageError ? item.reason.message : "Krill 官网查询失败，请稍后重试。";
      }
    });
    if (result.expired) {
      // A cached aggregate must not keep appearing current after expiry.
      context.summaries.clear();
      delete result.stats; delete result.deduction;
    }
    if (balance && todayRange(now()).start_time !== range.start_time) {
      // A request begun just before midnight may finish the next day.
      // Do not label yesterday's response as today's account usage.
      delete result.stats; delete result.deduction;
      result.warnings.push("今日统计日期已切换，请刷新");
    }
    return result;
  };
}

const money = value => `$${value.toFixed(2)}`;
const deductionMoney = value => value > 0 && value < 0.000001 ? "<$0.000001"
  : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6, useGrouping: false })}`;
const counts = new Intl.NumberFormat("zh-CN");

export function siteUsage(data, { balance = false, modelKey, email } = {}) {
  const sub = data.subscription;
  const usage = balance ? { windows: [] } : { ...sub, windows: sub?.windows ?? [] };
  const warnings = [...data.warnings];
  // Subscription is an independently fresh fallback for wallet reads.
  // Never add wallets from different Keys.
  if (data.credits !== undefined) usage.balance = `${money(data.credits)}（账号共享）`;
  else if (sub?.balance !== undefined) usage.balance = `${sub.balance}（账号共享）`;
  if (sub?.error) { warnings.push(sub.error); delete usage.error; }
  let plan = balance ? "共享钱包" : sub?.plan ?? "套餐额度暂不可读";
  if (balance && !data.expired) {
    const cost = data.deduction === undefined ? "未知" : deductionMoney(data.deduction);
    const requests = data.stats?.requests === undefined ? "未知" : counts.format(data.stats.requests);
    const tokens = data.stats?.tokens === undefined ? "未知" : counts.format(data.stats.tokens);
    plan += ` · 今日（北京时间）余额扣费 ${cost} · 官网账号全部调用 ${requests} 次 / ${tokens} tokens`;
  }
  const expiry = modelKey ? "官网登录已失效，请重新登录；模型 Key 仍可使用。" : "官网登录已失效，请重新登录。";
  if (data.expired) warnings.unshift(expiry);
  usage.plan = `${plan}${warnings.length ? `（${warnings.join("；")}）` : ""}`;
  usage.signIn = data.expired && !modelKey ? "expired" : "kept";
  if (typeof email === "string" && email) usage.user = email;
  const readable = usage.balance !== undefined || usage.windows.length > 0 || (sub && !sub.error) || (!data.expired && (data.stats !== undefined || data.deduction !== undefined));
  // Magpie hides windows when error is set. Keep partial reads visible;
  // component warnings go in the native plan summary instead.
  if (!readable) usage.error = data.expired ? expiry : sub?.error ?? data.error ?? "Krill 官网数据暂不可读，请稍后重试。";
  return usage;
}
