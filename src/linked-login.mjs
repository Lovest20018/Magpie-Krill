import { UsageError } from "./errors.mjs";
import { finishLogin, modelCredentials, modelLoginPrompts, safeLoginMessage } from "./login-result.mjs";
import { verifyModelKey } from "./key-login.mjs";

export function linkedLoginMethod(timeoutMs, accounts) {
  const available = () => accounts.options.length > 0;
  const modelPrompts = modelLoginPrompts({ balance: true }).map(prompt => ({
    ...prompt, condition: inputs => available() && (!prompt.condition || prompt.condition(inputs)),
  }));
  return {
    type: "oauth", label: "使用已登录的 Krill 账号",
    prompts: [
      { type: "select", key: "websiteAccount", message: "Krill 官网账号（套餐、余额共用）", options: accounts.options, condition: () => accounts.options.length > 1 },
      ...modelPrompts,
    ],
    async authorize(inputs = {}) {
      let result;
      try {
        if (!available()) throw new UsageError("WEBSITE_ACCOUNT", "请先在「Krill · 套餐」使用邮箱密码登录 Krill 账号，再回来连接余额 Key。已有连接可先刷新供应商列表。");
        // With one site account no second identity choice is needed.
        const selected = inputs.websiteAccount ?? (accounts.options.length === 1 ? accounts.options[0].value : undefined);
        const session = accounts.select(selected);
        const credentials = modelCredentials(inputs, { balance: true });
        await verifyModelKey(credentials, timeoutMs);
        result = finishLogin({ token: session.access, user: { email: session.email, id: session.uid } }, credentials, { balance: true });
        if (result.type === "success") Object.assign(result, { websiteSignedInAt: session.websiteSignedInAt, websiteShared: true });
      } catch (error) { result = { type: "failed", error: safeLoginMessage(error) }; }
      return { url: "", method: "auto", instructions: "复用所选 Krill 官网账号，不再次输入邮箱密码或 TOTP。余额模型 Key 和线路单独保存。", callback: async () => result };
    },
  };
}
