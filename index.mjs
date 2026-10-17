import { fetchSubscription } from "./src/api.mjs";
import { UsageError } from "./src/errors.mjs";
import { subscriptionUsage } from "./src/usage.mjs";
import { passwordLoginMethod } from "./src/login.mjs";
import { keyLoginMethod } from "./src/key-login.mjs";
import { websiteToken } from "./src/routes.mjs";
import { createModelFetcher } from "./src/models.mjs";
import { inferenceLoader } from "./src/inference.mjs";

const PROVIDER = "krill";

// Export only the plugin function: Magpie treats every exported function
// in the entry module as a plugin. Helpers live in src/ instead.
export const KrillUsagePlugin = async (_input, options = {}) => {
  const timeoutMs = options?.timeoutMs ?? 12_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new Error("Krill Usage：timeoutMs 必须是 1000–30000 之间的整数（毫秒）。");
  }
  const maxConcurrency = options?.maxConcurrency;
  if (maxConcurrency !== undefined && (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 1000)) throw new Error("Krill Usage：maxConcurrency 必须是 1–1000 之间的整数。");
  const fetchModels = createModelFetcher({ timeoutMs });

  return {
    async config(config) {
      config.provider ??= {};
      config.provider[PROVIDER] ??= {
        name: "Krill",
        npm: "@ai-sdk/openai-compatible",
        models: {},
      };
    },

    auth: {
      provider: PROVIDER,
      ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
      methods: [passwordLoginMethod(timeoutMs), keyLoginMethod(timeoutMs)],

      async loader(getAuth) {
        return inferenceLoader(getAuth);
      },

      async usage(getAuth) {
        let auth;
        try {
          auth = await getAuth();
          if (auth?.type === "oauth" && auth.connection === "model-only") {
            return { plan: "仅模型 · 未连接额度", signIn: "kept", windows: [] };
          }
          if (!websiteToken(auth)) {
            throw new UsageError("NO_AUTH", "请使用 Krill 邮箱密码登录后查询额度。", "expired");
          }
          const usage = subscriptionUsage(await fetchSubscription(websiteToken(auth), { timeoutMs }));
          if (auth?.type === "oauth" && typeof auth.email === "string") usage.user = auth.email;
          return usage;
        } catch (error) {
          // Never include a raw network error or server body: either may
          // contain credentials. Do not substitute old data for a failed read.
          const quotaLoginExpired = error instanceof UsageError && error.signIn === "expired";
          const independentModelKey = auth?.type === "oauth" && Boolean(auth.modelKey);
          return {
            error: quotaLoginExpired && independentModelKey
              ? "额度登录已失效，请重新登录；模型 Key 仍可使用。"
              : error instanceof UsageError ? error.message : "Krill 额度查询失败，请稍后重试。",
            signIn: quotaLoginExpired && independentModelKey ? "kept" : error instanceof UsageError ? error.signIn : "kept",
            windows: [],
          };
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models(_provider, { auth } = {}) {
        return fetchModels(auth);
      },
    },
  };
};
