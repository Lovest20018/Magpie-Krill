import { requestJSON, unwrap } from "./http.mjs";
import { UsageError } from "./errors.mjs";
import { modelLoginPrompts, modelCredentials, finishLogin, safeLoginMessage } from "./login-result.mjs";
import { verifyModelKey } from "./key-login.mjs";

const WEBSITE = "https://www.krill-code.com";

export function passwordLoginMethod(timeoutMs, { balance = false, onLogin } = {}) {
  return {
    type: "oauth",
    label: "邮箱密码登录",
    prompts: [
      { type: "text", key: "email", message: "Krill 账号邮箱", placeholder: "在 Krill 注册的邮箱", validate: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value?.trim() ?? "") ? undefined : "请输入有效的账号邮箱。" },
      { type: "password", key: "password", message: "Krill 网站密码", placeholder: "仅用于本次登录，不保存", validate: (value) => typeof value === "string" && value.length > 0 ? undefined : "请输入 Krill 网站密码。" },
      ...modelLoginPrompts({ balance }),
    ],
    async authorize(inputs = {}) {
      let response;
      let loginError;
      let modelKey;
      let route;
      try {
        const email = inputs.email?.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? "") || typeof inputs.password !== "string" || !inputs.password) {
          throw new UsageError("LOGIN_INPUT", "请输入有效的邮箱和登录密码。");
        }
        ({ modelKey, route } = modelCredentials(inputs, { balance }));
        if (balance) await verifyModelKey({ modelKey, route }, timeoutMs);
        response = unwrap(await requestJSON(`${WEBSITE}/api/auth/login`, {
          body: { email, password: inputs.password }, timeoutMs, authKind: "login",
        }));
      } catch (error) {
        loginError = safeLoginMessage(error);
      }
      // These callbacks deliberately capture no input object or password.
      // OAuth-shaped storage avoids Magpie merging prompt inputs into API
      // key metadata. It is a credential exchange, not a browser OAuth flow.
      if (loginError) return { url: "", method: "auto", callback: async () => ({ type: "failed", error: loginError }) };
      const pending = response?.requires_totp === true ? response.pending_token : undefined;
      const finish = (data) => {
        const result = finishLogin(data, { modelKey, route }, { balance });
        return result.type === "success" && onLogin ? onLogin(result) : result;
      };
      if (response?.requires_totp === true) {
        if (typeof pending !== "string" || !pending) return { url: "", method: "auto", callback: async () => ({ type: "failed", error: "Krill 未返回有效的两步验证会话，请重新登录。" }) };
        return {
          url: "", method: "code", instructions: "请输入身份验证器中的 6 位验证码。验证码错误或过期后，请重新开始登录。",
          async callback(code) {
            if (!/^\d{6}$/.test(code?.trim() ?? "")) return { type: "failed", error: "请输入 6 位两步验证码。" };
            try {
              const data = unwrap(await requestJSON(`${WEBSITE}/api/auth/login/totp`, {
                body: { pending_token: pending, totp_code: code.trim() }, timeoutMs, authKind: "login",
              }));
              return finish(data);
            } catch (error) { return { type: "failed", error: safeLoginMessage(error) }; }
          },
        };
      }
      return { url: "", method: "auto", instructions: "正在完成 Krill 账号登录。密码不会保存。", callback: async () => finish(response) };
    },
  };
}
