// Synthetic values only. These are not credentials from a real account.
export const TOKEN_A = "syntheticA.payload.signature";
export const TOKEN_B = "syntheticB.payload.signature";

export function subscription({ id = 1, name = "轻享月卡", status = "active", remaining = "240.000000", limit = "600.000000" } = {}) {
  return {
    subscription_id: id,
    status,
    plan: { name, duration_days: 30 },
    subscription_end_at: "2030-02-01T00:00:00Z",
    quota: {
      remaining_usd: remaining,
      daily_limit_usd: limit,
      window_reset_at: "2030-01-08T00:00:00Z",
    },
  };
}

export function payload(subscriptions = [subscription()], balance = "123.450000") {
  return {
    success: true,
    code: 0,
    data: { credit_balance_usd: balance, subscriptions },
  };
}

export const jsonResponse = (body = payload(), init = {}) => new Response(JSON.stringify(body), {
  ...init,
  headers: { "content-type": "application/json", ...init.headers },
});
