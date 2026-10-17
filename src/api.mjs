import { normalizeToken } from "./token.mjs";
import { requestJSON } from "./http.mjs";
export { MAX_RESPONSE_BYTES } from "./http.mjs";

export const SUBSCRIPTION_URL = "https://www.krill-code.com/api/subscription";
const ACCOUNT_URLS = Object.freeze({
  subscription: SUBSCRIPTION_URL,
  credits: "https://www.krill-code.com/api/credits",
  stats: "https://www.krill-code.com/api/request-logs/stats",
  deduction: "https://www.krill-code.com/api/request-logs/quota-summary",
});

export async function fetchAccountData(kind, value, { body, timeoutMs = 12_000, fetchImpl = globalThis.fetch } = {}) {
  if (!Object.hasOwn(ACCOUNT_URLS, kind)) throw new Error("Unknown Krill account data endpoint");
  const token = normalizeToken(value);
  return requestJSON(ACCOUNT_URLS[kind], {
    headers: { authorization: `Bearer ${token}` }, body, timeoutMs, fetchImpl,
  });
}

export async function fetchSubscription(value, { timeoutMs = 12_000, fetchImpl = globalThis.fetch } = {}) {
  return fetchAccountData("subscription", value, { timeoutMs, fetchImpl });
}
