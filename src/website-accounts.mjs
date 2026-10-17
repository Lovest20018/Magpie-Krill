import { createHash } from "node:crypto";
import { UsageError } from "./errors.mjs";
import { normalizeToken } from "./token.mjs";
import { websiteToken } from "./routes.mjs";

const MAX_ACCOUNTS = 50;
const emailOf = auth => typeof auth?.email === "string" ? auth.email.trim() : "";
const uidOf = auth => typeof auth?.uid === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(auth.uid) ? auth.uid : "";

function identity(auth) {
  const email = emailOf(auth);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return undefined;
  const uid = uidOf(auth);
  // This identifies a website account, independently of its model Keys.
  return createHash("sha256").update(JSON.stringify([email.toLowerCase(), uid])).digest("hex");
}

export function createWebsiteAccounts({ now = Date.now } = {}) {
  const accounts = new Map();
  // Native prompts retain this array. Update it in place as Magpie hands
  // account snapshots to hooks; no credentials appear in select options.
  const options = [];
  const updateOptions = () => options.splice(0, options.length, ...[...accounts.entries()]
    .filter(([, session]) => !session.expired)
    .map(([value, session]) => ({ value, label: session.email, hint: "共用官网余额、套餐和统计；模型 Key 单独配置" })));

  function observe(auth, provider = "krill") {
    // Legacy API-shaped website credentials can still query quota, but must
    // not be rewritten into the current OAuth shape or offered for linking.
    if (auth?.type !== "oauth") return undefined;
    const id = identity(auth);
    if (!id || !websiteToken(auth)) return undefined;
    let access;
    try { access = normalizeToken(websiteToken(auth)); } catch { return undefined; }
    const stamp = auth.websiteSignedInAt;
    const signedInAt = Number.isSafeInteger(stamp) && stamp > 0 ? stamp : 0;
    const before = accounts.get(id);
    const priority = provider === "krill" ? 2 : 1;
    if (!before || signedInAt > before.signedInAt || (signedInAt === before.signedInAt && priority >= before.priority && access !== before.access)) {
      accounts.delete(id);
      // Retain only website fields, never model Keys, routes or passwords.
      const uid = uidOf(auth);
      accounts.set(id, { access, email: emailOf(auth), ...(uid ? { uid } : {}), signedInAt, priority, expired: false });
      while (accounts.size > MAX_ACCOUNTS) accounts.delete(accounts.keys().next().value);
      updateOptions();
    }
    return id;
  }

  return {
    options,
    observe,
    signedIn(result, provider = "krill") {
      if (result?.type !== "success") return result;
      const id = identity(result);
      const websiteSignedInAt = Math.max(now(), (accounts.get(id)?.signedInAt ?? 0) + 1);
      const saved = { ...result, websiteSignedInAt };
      observe({ ...saved, type: "oauth" }, provider);
      return saved;
    },
    select(id) {
      const session = accounts.get(id);
      if (!session || session.expired) throw new UsageError("WEBSITE_ACCOUNT", "所选 Krill 官网账号不可用，请重新选择或使用邮箱密码登录。已有连接可先刷新供应商列表。");
      return { access: session.access, email: session.email, ...(session.uid ? { uid: session.uid } : {}), websiteSignedInAt: session.signedInAt };
    },
    async resolve(auth, { provider, save } = {}) {
      const id = observe(auth, provider);
      const session = accounts.get(id);
      if (!session || session.expired || !websiteToken(auth)) return auth;
      const update = session.access !== auth.access || session.signedInAt > (auth.websiteSignedInAt ?? 0);
      if (!update) return auth;
      const effective = { ...auth, access: session.access, email: session.email,
        ...(session.uid ? { uid: session.uid } : {}), websiteSignedInAt: session.signedInAt };
      // auth.set is scoped by Magpie to the account executing this hook.
      // Never address another provider's default slot or enumerate files.
      if (save) await save(effective);
      return effective;
    },
    rejected(auth) {
      const session = accounts.get(identity(auth));
      if (session?.access === websiteToken(auth)) { session.expired = true; updateOptions(); }
    },
  };
}

export const websiteAccounts = createWebsiteAccounts();
