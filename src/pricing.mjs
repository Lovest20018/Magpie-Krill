import { ROUTES } from "./routes.mjs";

function amount(value) {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function scaled(value, multiplier) {
  const n = amount(value);
  if (n === undefined) return undefined;
  const result = n * multiplier;
  // Keep tiny relay prices while removing binary multiplication noise.
  return Number.isFinite(result) ? Number(result.toPrecision(12)) : undefined;
}

export function krillModelCost(price, baseURL) {
  if (!price || price.enabled === false || price.billing_mode !== "token") return undefined;
  const route = Object.values(ROUTES).find((route) => `${route.url}/v1` === baseURL);
  if (!route) return undefined;
  const multipliers = price.route_multipliers;
  if (multipliers != null && (typeof multipliers !== "object" || Array.isArray(multipliers))) return undefined;
  // Krill's pricing page uses 1 when this route has no override. A supplied
  // but malformed override is unknown, not a reason to assume full price.
  const multiplier = multipliers && Object.hasOwn(multipliers, route.pricingKey)
    ? amount(multipliers[route.pricingKey]) : 1;
  if (multiplier === undefined) return undefined;
  const input = scaled(price.input_token_price, multiplier);
  const output = scaled(price.output_token_price, multiplier);
  if (input === undefined || output === undefined) return undefined;
  // These are Krill's USD per MILLION tokens already: do not divide by a
  // million here. No models.dev/maker fallback or account/channel guesses.
  const cost = { input, output };
  const read = scaled(price.cache_read_input_token_price, multiplier);
  const write = scaled(price.cache_creation_5m_token_price ?? price.cache_creation_token_price, multiplier);
  if (read !== undefined || write !== undefined) {
    cost.cache = { ...(read !== undefined ? { read } : {}), ...(write !== undefined ? { write } : {}) };
  }
  return cost;
}
