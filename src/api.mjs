import { normalizeToken } from "./token.mjs";
import { requestJSON } from "./http.mjs";
export { MAX_RESPONSE_BYTES } from "./http.mjs";

export const SUBSCRIPTION_URL = "https://www.krill-code.com/api/subscription";

export async function fetchSubscription(value, { timeoutMs = 12_000, fetchImpl = globalThis.fetch } = {}) {
  const token = normalizeToken(value);
  return requestJSON(SUBSCRIPTION_URL, {
    headers: { authorization: `Bearer ${token}` }, timeoutMs, fetchImpl,
  });
}
