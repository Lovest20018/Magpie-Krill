import { createHash } from "node:crypto";
import { UsageError } from "./errors.mjs";
import { normalizeToken } from "./token.mjs";
import { normalizeModelKey, routeURL, ROUTES } from "./routes.mjs";

export const safeLoginMessage = (error) => error instanceof UsageError ? error.message : "Krill 登录失败，请检查输入或稍后重试。";

export function modelAccountId(modelKey, route) {
  const fingerprint = createHash("sha256").update(modelKey).digest("hex").slice(0, 12);
  return `Krill Key ${fingerprint} · ${ROUTES[route].label}`;
}

export function modelLoginPrompts({ balance = false } = {}) {
  return [
    { type: "password", key: "modelKey", message: balance ? "余额模型 API Key（必填）" : "模型 API Key（选填，留空仅查额度）", placeholder: "重新登录需重填，不保留旧 Key；不限前缀", validate: (value) => { if (!balance && typeof value === "string" && !value.trim()) return; try { normalizeModelKey(value); } catch (error) { return error.message; } } },
    { type: "select", key: "route", message: "模型接入线路", condition: (inputs) => Boolean(inputs.modelKey?.trim()), options: Object.entries(ROUTES).map(([value, route]) => ({ value, label: route.label, hint: `${route.url} · ${balance ? "以余额 Key 权限和线路可用性为准" : "需在套餐和 Key 中可用"}` })) },
  ];
}

export function modelCredentials(inputs = {}, { balance = false } = {}) {
  try {
    const empty = inputs.modelKey == null || (typeof inputs.modelKey === "string" && !inputs.modelKey.trim());
    const modelKey = empty ? undefined : normalizeModelKey(inputs.modelKey);
    if (balance && !modelKey) throw new Error("Missing model key");
    const route = inputs.route ?? "domestic";
    routeURL(route);
    return { ...(modelKey ? { modelKey } : {}), route };
  } catch {
    throw new UsageError("LOGIN_INPUT", balance ? "余额连接需要完整的模型 API Key 和有效接入线路，Key 不限制前缀。" : "模型 Key 可留空；填写时请使用完整 Key，不要包含空格或换行，并选择有效的接入线路。");
  }
}

export function finishLogin(data, { modelKey, route }, { balance = false } = {}) {
  try {
    const access = normalizeToken(data?.token);
    const email = typeof data?.user?.email === "string" ? data.user.email.trim() : "";
    const rawID = data?.user?.id;
    const uid = (typeof rawID === "string" || typeof rawID === "number") && /^[A-Za-z0-9_-]{1,128}$/.test(String(rawID)) ? String(rawID) : undefined;
    if (!email) throw new UsageError("LOGIN_RESPONSE", "Krill 登录结果缺少账户信息，请重新登录。");
    return {
      type: "success", refresh: "", access, expires: 0,
      accountId: balance ? modelAccountId(modelKey, route) : email, email,
      ...(uid ? { uid } : {}),
      ...(modelKey ? { modelKey } : {}), route,
    };
  } catch (error) { return { type: "failed", error: safeLoginMessage(error) }; }
}
