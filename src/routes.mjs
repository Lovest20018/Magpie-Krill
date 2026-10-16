export const ROUTES = {
  domestic: { label: "国内极速", url: "https://api-slb.krill-code.net", pricingKey: "均衡" },
  direct: { label: "海外线路", url: "https://api.krill-code.net", pricingKey: "直连" },
  cdn: { label: "三网优化 CDN", url: "https://api.cdn-krill-ai.com", pricingKey: "cdn" },
};

export function routeURL(route = "domestic") {
  if (!Object.hasOwn(ROUTES, route)) throw new Error("Krill 接入线路无效，请重新登录并选择网站提供的线路。");
  return `${ROUTES[route].url}/v1`;
}

export function normalizeModelKey(value) {
  if (typeof value !== "string") throw new Error("请填写已有的 Krill 模型 API Key。");
  const key = value.trim().replace(/^Bearer\s+/i, "").trim();
  // Keys are opaque credentials. Validate header safety, not a vendor
  // prefix or guessed token alphabet.
  if (!key || key.length > 4096 || /[^\x21-\x7E]/.test(key)) {
    throw new Error("请填写完整的 Krill 模型 API Key，不要包含空格或换行。");
  }
  return key;
}

export function websiteToken(auth) {
  if (auth?.connection === "model-only") return undefined;
  return auth?.type === "oauth" ? auth.access : auth?.type === "api" ? auth.key : undefined;
}
