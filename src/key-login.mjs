import { requestJSON } from "./http.mjs";
import { UsageError } from "./errors.mjs";
import { modelAccountId, modelCredentials, modelLoginPrompts, safeLoginMessage } from "./login-result.mjs";
import { normalizeModelKey, routeURL } from "./routes.mjs";
import { catalogModels } from "./models.mjs";

export async function verifyModelKey({ modelKey, route }, timeoutMs) {
  const base = routeURL(route);
  const catalog = await requestJSON(`${base}/models`, {
    headers: { authorization: `Bearer ${modelKey}` }, timeoutMs, authKind: "model",
  });
  catalogModels(catalog, [], base);
}

export function keyLoginMethod(timeoutMs, { balance = false } = {}) {
  const prompts = modelLoginPrompts({ balance });
  prompts[0] = {
    ...prompts[0], message: "模型 API Key（必填）", placeholder: "不限前缀；填写已有的完整 Key",
    validate(value) { try { normalizeModelKey(value); } catch (error) { return error.message; } },
  };
  return {
    // The OAuth-shaped result stores exactly the fields below; Magpie's
    // plain API method otherwise merges all prompt inputs into metadata.
    type: "oauth", label: "API Key 连接（仅模型）", prompts,
    async authorize(inputs = {}) {
      let result;
      try {
        const { modelKey, route } = modelCredentials(inputs, { balance });
        if (!modelKey) throw new UsageError("LOGIN_INPUT", "请输入完整的 Krill 模型 API Key，不限制前缀。");
        await verifyModelKey({ modelKey, route }, timeoutMs);
        result = {
          type: "success", refresh: "", access: "", expires: 0,
          connection: "model-only", modelKey, route,
          accountId: modelAccountId(modelKey, route),
        };
      } catch (error) { result = { type: "failed", error: safeLoginMessage(error) }; }
      return {
        url: "", method: "auto",
        instructions: "使用所选线路核验模型 Key。需要官网统计时，选择「邮箱密码登录 / 使用已登录账号」。",
        callback: async () => result,
      };
    },
  };
}
