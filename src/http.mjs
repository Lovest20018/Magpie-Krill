import { UsageError } from "./errors.mjs";

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function cancelBody(response) {
  response?.body?.cancel().catch(() => {});
}

async function readBody(response) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    cancelBody(response);
    throw new UsageError("TOO_LARGE", "Krill 返回的数据过大，请稍后重试。");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        return text + decoder.decode();
      }
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new UsageError("TOO_LARGE", "Krill 返回的数据过大，请稍后重试。");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    if (!completed) reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function requestJSON(url, {
  headers = {}, body, timeoutMs = 12_000, fetchImpl = globalThis.fetch,
  authKind = "website",
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.headers.get("cf-mitigated")?.toLowerCase() === "challenge") {
      cancelBody(response);
      throw new UsageError("CF_CHALLENGE", "Krill 返回了 Cloudflare 验证，请在浏览器中完成验证后重试。");
    }
    if (response.status === 401) {
      cancelBody(response);
      if (authKind === "model") throw new UsageError("MODEL_KEY", "Krill 模型 API Key 无效或已撤销，请重新登录并更新 API Key。");
      if (authKind === "login") throw new UsageError("LOGIN", "Krill 登录失败，请检查邮箱、密码或验证码。");
      throw new UsageError("UNAUTHORIZED", "krill_jwt 无效或已过期，请重新登录 Krill 并更新凭据。", "expired");
    }
    if (response.status >= 300 && response.status < 400) {
      cancelBody(response);
      throw new UsageError("REDIRECT", "Krill 接口返回了重定向，请检查网站登录状态或接口是否变更。");
    }
    if (response.status === 429) {
      cancelBody(response);
      throw new UsageError("RATE_LIMIT", "Krill 请求过于频繁，请稍后重试。");
    }
    if (!response.ok) {
      cancelBody(response);
      throw new UsageError("HTTP", `Krill 请求失败（HTTP ${response.status}），请检查输入或稍后重试。`);
    }
    const text = await readBody(response);
    try { return JSON.parse(text); }
    catch { throw new UsageError("INVALID_JSON", "Krill 返回了无法解析的数据，请检查网站是否需要验证后重试。"); }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if (controller.signal.aborted) throw new UsageError("TIMEOUT", "Krill 请求超时，请检查网络或代理设置后重试。");
    throw new UsageError("NETWORK", "无法连接 Krill，请检查网络或 Magpie 的代理设置后重试。");
  } finally {
    clearTimeout(timer);
  }
}

export function unwrap(json) {
  if (!json || json.success !== true || json.code !== 0 || !Object.hasOwn(json, "data")) {
    throw new UsageError("INVALID_RESPONSE", "Krill 接口返回结构无法识别或请求被拒绝，请检查输入后重试。");
  }
  return json.data;
}
