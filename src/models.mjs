import { requestJSON, unwrap } from "./http.mjs";
import { UsageError } from "./errors.mjs";
import { normalizeModelKey, routeURL } from "./routes.mjs";
import { krillModelCost } from "./pricing.mjs";
import { krillSpeedBase, modelCapabilities } from "./model-capabilities.mjs";

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function catalogModels(catalog, prices = [], baseURL) {
  if (!Array.isArray(catalog?.data) || catalog.data.length > 5000 || !catalog.data.every((m) => m && typeof m.id === "string" && m.id.trim() && m.id.length <= 200)) {
    throw new UsageError("MODEL_RESPONSE", "Krill 模型列表格式无法识别，请稍后重新获取模型。");
  }
  const metadata = new Map((Array.isArray(prices) ? prices : []).filter((p) => p?.model_name).map((p) => [p.model_name, p]));
  const result = {};
  for (const item of catalog.data) {
    const id = item.id;
    const price = metadata.get(id);
    if (price?.model_type && price.model_type !== "text") continue;
    // Model APIs follow the published Krill setup guide: Claude uses
    // Messages, OpenAI reasoning models use Responses, others use Chat.
    const claude = /^claude[-.]/i.test(id);
    const openai = /^(gpt[-.]|o[1-9](?:[-.]|$)|codex[-.])/i.test(id);
    const npm = claude ? "@ai-sdk/anthropic" : openai ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible";
    const cost = krillModelCost(price, baseURL);
    // Krill documents service_tier="priority" / "ultrafast" on the base
    // model. Suffixed price rows describe the tiers, not extra picker
    // entries. Keep IDs actually listed by the API for compatibility.
    const serviceTiers = krillSpeedBase(`${id}-fast`) === id && price?.enabled !== false
      ? [["priority", "fast"], ["ultrafast", "ultrafast"]].filter(([, suffix]) => {
        const tier = metadata.get(`${id}-${suffix}`);
        return tier?.enabled === true && tier.model_type === "text" && tier.billing_mode === "token";
      }).map(([tier]) => tier) : [];
    Object.defineProperty(result, id, { enumerable: true, configurable: true, writable: true, value: {
      id, name: item.name ?? id,
      api: { id, url: baseURL, npm },
      limit: { context: finitePositive(price?.context_window), output: finitePositive(price?.max_output_tokens) },
      ...(cost ? { cost } : {}),
      ...modelCapabilities(id, price),
      // serviceTiers is consumed by the companion Magpie native-tier
      // adaptation. The unmodified v0.1.1267 host drops this extension;
      // `fast` alone does not publish Krill's native three-tier picker.
      ...(serviceTiers.length ? { fast: serviceTiers.includes("priority"), serviceTiers } : {}),
    } });
  }
  return result;
}

const MODEL_CACHE_MS = 60_000;
const PRICING_CACHE_MS = 5 * 60_000;
const MAX_CACHED_ACCOUNTS = 50;

export function createModelFetcher({ timeoutMs = 12_000, now = Date.now } = {}) {
  // Magpie asks this hook before inference as well as in the model picker.
  // Cache only models, in memory; quota and inference remain uncached.
  const accounts = new Map();
  let pricing;
  let pricingUntil = 0;
  let pricingPending;

  function publicPrices() {
    if (pricing && now() < pricingUntil) return Promise.resolve({ data: pricing, until: pricingUntil });
    if (pricingPending) return pricingPending;
    pricingPending = (async () => {
      try {
        const data = unwrap(await requestJSON("https://www.krill-code.com/api/public/model-pricing", {
          timeoutMs: Math.min(timeoutMs, 1_500),
        }));
        if (!Array.isArray(data)) throw new Error("Invalid optional metadata");
        pricing = data;
        pricingUntil = now() + PRICING_CACHE_MS;
      } catch {
        // Metadata is optional. Keep initial discovery responsive and try
        // again on the next catalog refresh instead of failing inference.
        pricing = [];
        pricingUntil = now() + MODEL_CACHE_MS;
      }
      return { data: pricing, until: pricingUntil };
    })().finally(() => { pricingPending = undefined; });
    return pricingPending;
  }

  return async function fetchModels(auth) {
    if (auth?.type !== "oauth" || !auth.modelKey) return {};
    let key, baseURL;
    try { key = normalizeModelKey(auth.modelKey); baseURL = routeURL(auth.route); }
    catch { throw new UsageError("MODEL_CONFIG", "Krill 模型凭据或线路无效，请重新登录并填写模型 API Key、选择接入线路。"); }
    // Never persist or log this key. Rotating a key or changing the account
    // or route immediately bypasses any earlier account's model catalog.
    // Website tokens and retired association fields do not affect the
    // model catalog or public route prices, and are not retained here.
    const cacheKey = JSON.stringify([auth.accountId ?? auth.uid ?? auth.email ?? "", key, baseURL]);
    const cached = accounts.get(cacheKey);
    if (cached && (cached.pending || now() < cached.until)) {
      accounts.delete(cacheKey);
      accounts.set(cacheKey, cached);
      if (cached.pending) await cached.pending;
      return structuredClone(cached.models);
    }
    accounts.delete(cacheKey);
    const entry = {};
    accounts.set(cacheKey, entry);
    while (accounts.size > MAX_CACHED_ACCOUNTS) accounts.delete(accounts.keys().next().value);
    entry.pending = (async () => {
      const [catalog, publicRead] = await Promise.all([
        requestJSON(`${baseURL}/models`, { headers: { authorization: `Bearer ${key}` }, timeoutMs, authKind: "model" }),
        publicPrices(),
      ]);
      entry.models = catalogModels(catalog, publicRead.data, baseURL);
      // A recently read model list must not prolong an older price past
      // the pricing cache's expiry.
      entry.until = Math.min(now() + MODEL_CACHE_MS, publicRead.until);
      return entry.models;
    })();
    try {
      await entry.pending;
      return structuredClone(entry.models);
    } catch (error) {
      // A rejected refresh must not become a successful stale listing.
      if (accounts.get(cacheKey) === entry) accounts.delete(cacheKey);
      throw error;
    } finally {
      entry.pending = undefined;
    }
  };
}
