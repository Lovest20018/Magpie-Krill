import { UsageError } from "./errors.mjs";

export function normalizeToken(value) {
  if (typeof value !== "string") {
    throw new UsageError("NO_AUTH", "尚未设置 krill_jwt，请在 Krill 额度供应商中登录。", "expired");
  }
  let token = value.trim();
  // Accept a value copied from a quoted JSON string or Authorization header.
  for (let i = 0; i < 3; i++) {
    token = token.replace(/^Bearer\s+/i, "").trim();
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      token = token.slice(1, -1).trim();
    }
  }
  if (!token || token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new UsageError("INVALID_TOKEN", "krill_jwt 格式不正确，请重新复制网站 Local Storage 中的完整值。", "expired");
  }
  // The server validates its signature and expiry; local shape checks are
  // only to catch copying mistakes and invalid header characters.
  return token;
}
