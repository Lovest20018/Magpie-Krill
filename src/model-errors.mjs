export function modelErrorResponse(response) {
  let type, message;
  if (response.headers.get("cf-mitigated")?.toLowerCase() === "challenge") {
    type = "access_error";
    message = "Krill 模型接口要求 Cloudflare 验证，请检查所选线路，或在浏览器完成验证后重试。";
  } else {
    switch (response.status) {
      case 401:
        type = "authentication_error";
        message = "Krill 模型 API Key 无效或已撤销，请通过 API Key 连接或重新登录更新 Key。";
        break;
      case 402:
        type = "insufficient_quota";
        message = "Krill 拒绝了本次计费请求，请在网站检查套餐、余额和此 Key 的余额回退设置。";
        break;
      case 403:
        type = "permission_error";
        message = "Krill 拒绝访问此模型，请检查 Key 的渠道、模型权限、IP 白名单和所选线路。";
        break;
      case 429:
        type = "rate_limit_error";
        message = "Krill 当前限流或并发已满，请稍后重试，或在 Magpie 降低并发。";
        break;
      case 500: case 502: case 503: case 504:
        type = "upstream_error";
        message = `Krill 模型服务暂时不可用（HTTP ${response.status}），请稍后重试或检查其他可用线路。`;
        break;
      default: return response;
    }
  }
  response.body?.cancel().catch(() => {});
  const headers = new Headers({ "content-type": "application/json", "X-Magpie-Sign-In": "kept" });
  // Retain a standard delay without propagating arbitrary upstream text.
  const delay = response.headers.get("retry-after");
  if (delay && (/^\d{1,10}$/.test(delay) || (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(delay) && Number.isFinite(Date.parse(delay))))) {
    headers.set("retry-after", delay);
  }
  return new Response(JSON.stringify({ error: { type, message } }), { status: response.status, headers });
}
