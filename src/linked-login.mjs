import { finishLogin, modelCredentials, safeLoginMessage } from "./login-result.mjs";
import { verifyModelKey } from "./key-login.mjs";
import { passwordLoginMethod } from "./login.mjs";

const NEW_ACCOUNT = "new-account";

// Both native providers use the same website flow. Only model credentials
// belong to the connection being created; selecting an account copies no Key.
export function linkedLoginMethod(timeoutMs, accounts, { balance = false } = {}) {
  const available = () => accounts.options.length > 0;
  const password = passwordLoginMethod(timeoutMs, {
    balance, onLogin: result => accounts.signedIn(result, balance ? "krill-balance" : "krill"),
  });
  const signingIn = inputs => inputs.websiteAccount === NEW_ACCOUNT ||
    (inputs.websiteAccount == null && (!available() || Object.hasOwn(inputs, "email")));
  return {
    type: "oauth", label: "邮箱密码登录 / 使用已登录账号",
    prompts: [
      { type: "select", key: "websiteAccount", message: "Krill 官网账号（套餐、余额共用）",
        // The host reads options at each prompt, after existing auth snapshots
        // have been observed. Never freeze this list at plugin initialization.
        get options() { return [...accounts.options, { value: NEW_ACCOUNT, label: "登录其他账号", hint: "使用 Krill 邮箱密码登录" }]; },
        condition: inputs => available() && !Object.hasOwn(inputs, "email"),
      },
      ...password.prompts.map(prompt => ["email", "password"].includes(prompt.key)
        ? { ...prompt, condition: signingIn } : prompt),
    ],
    async authorize(inputs = {}) {
      if (signingIn(inputs)) return password.authorize(inputs);
      let result;
      try {
        // With one site account no second identity choice is needed.
        const selected = inputs.websiteAccount ?? (accounts.options.length === 1 ? accounts.options[0].value : undefined);
        const session = accounts.select(selected);
        const credentials = modelCredentials(inputs, { balance });
        if (credentials.modelKey) await verifyModelKey(credentials, timeoutMs);
        result = finishLogin({ token: session.access, user: { email: session.email, id: session.uid } }, credentials, { balance });
        if (result.type === "success") Object.assign(result, { websiteSignedInAt: session.websiteSignedInAt, websiteShared: true });
      } catch (error) { result = { type: "failed", error: safeLoginMessage(error) }; }
      return { url: "", method: "auto", instructions: "复用所选 Krill 官网账号，当前连接的模型 Key 和线路单独保存。", callback: async () => result };
    },
  };
}
