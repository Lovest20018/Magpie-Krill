import { UsageError } from "./errors.mjs";
import { keyLoginMethod } from "./key-login.mjs";
import { websiteToken } from "./routes.mjs";
import { createModelFetcher } from "./models.mjs";
import { inferenceLoader } from "./inference.mjs";
import { createSiteReader, siteUsage } from "./site-data.mjs";
import { websiteAccounts } from "./website-accounts.mjs";
import { linkedLoginMethod } from "./linked-login.mjs";

// Shared by both providers. No background jobs or persistent stats cache.
const readSite = createSiteReader();

export async function createProvider(id, options = {}, input = {}) {
  const balance = id === "krill-balance";
  const timeoutMs = options?.timeoutMs ?? 12_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new Error("Krill Usage：timeoutMs 必须是 1000–30000 之间的整数（毫秒）。");
  }
  const maxConcurrency = options?.maxConcurrency;
  if (maxConcurrency !== undefined && (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 1000)) throw new Error("Krill Usage：maxConcurrency 必须是 1–1000 之间的整数。");
  const fetchModels = createModelFetcher({ timeoutMs, balance });
  const siteLogin = linkedLoginMethod(timeoutMs, websiteAccounts, { balance });
  const save = async auth => {
    try {
      if (typeof input?.client?.auth?.set === "function") await input.client.auth.set({ path: { id }, body: auth });
    }
    catch { throw new UsageError("WEBSITE_SYNC", "Krill 共用官网登录状态保存失败，请刷新或重新连接；模型 Key 保留。"); }
  };
  return {
    async config(config) {
      config.provider ??= {};
      config.provider[id] ??= { name: balance ? "Krill · 余额" : "Krill · 套餐", npm: "@ai-sdk/openai-compatible", models: {} };
    },
    auth: {
      provider: id,
      ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
      methods: [siteLogin, keyLoginMethod(timeoutMs, { balance })],
      async loader(getAuth) {
        return inferenceLoader(async () => { const auth = await getAuth(); websiteAccounts.observe(auth, id); return auth; }, { balance });
      },
      async usage(getAuth) {
        let auth;
        try {
          auth = await getAuth();
          if (auth?.type === "oauth" && auth.connection === "model-only") {
            return { plan: "仅模型 · 未连接官网统计", signIn: "kept", windows: [] };
          }
          if (!websiteToken(auth)) throw new UsageError("NO_AUTH", "请使用 Krill 邮箱密码登录后查询官网统计。", "expired");
          auth = await websiteAccounts.resolve(auth, { provider: id, save });
          const data = await readSite(auth, { timeoutMs, balance });
          if (data.expired) websiteAccounts.rejected(auth);
          return siteUsage(data, { balance, modelKey: auth?.modelKey, email: auth?.email });
        } catch (error) {
          const expired = error instanceof UsageError && error.signIn === "expired";
          const independentModelKey = auth?.type === "oauth" && Boolean(auth.modelKey);
          return {
            error: expired && independentModelKey ? "官网登录已失效，请重新登录；模型 Key 仍可使用。"
              : error instanceof UsageError ? error.message : "Krill 官网查询失败，请稍后重试。",
            signIn: expired && independentModelKey ? "kept" : error instanceof UsageError ? error.signIn : "kept",
            windows: [],
          };
        }
      },
    },
    provider: {
      id,
      async models(_provider, { auth } = {}) { websiteAccounts.observe(auth, id); return fetchModels(auth); },
    },
  };
}
