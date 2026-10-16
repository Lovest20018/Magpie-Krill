import { UsageError } from "./errors.mjs";
import { normalizeModelKey, routeURL } from "./routes.mjs";
import { modelErrorResponse } from "./model-errors.mjs";

export function inferenceLoader(getAuth) {
  return {
    // Host fills an empty key with the account's website JWT. Use a
    // placeholder instead; the fetch below always selects the model key.
    apiKey: "krill-model-key-managed-by-plugin",
    async fetch(input, init = {}) {
      const auth = await getAuth();
      if (auth?.type !== "oauth" || !auth.modelKey) throw new UsageError("QUOTA_ONLY", "当前账号仅查询额度。需要调用模型时，请重新登录并填写模型 API Key，或添加 API Key 连接。");
      let key, base;
      try { key = normalizeModelKey(auth.modelKey); base = new URL(routeURL(auth.route)); }
      catch { throw new UsageError("MODEL_CONFIG", "Krill 模型凭据或线路无效，请重新登录。"); }
      let url;
      try { url = new URL(input instanceof Request ? input.url : String(input)); }
      catch { throw new UsageError("MODEL_DESTINATION", "模型请求的地址无效，已停止发送。"); }
      if (url.origin !== base.origin || url.username || url.password || !["/v1/messages", "/v1/responses", "/v1/chat/completions"].includes(url.pathname)) {
        throw new UsageError("MODEL_DESTINATION", "模型请求的地址不属于所选 Krill 线路，已停止发送。");
      }
      const inherited = input instanceof Request ? { method: input.method, body: input.body, signal: input.signal, duplex: "half" } : {};
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init.headers).forEach((value, name) => headers.set(name, value));
      for (const name of ["authorization", "x-api-key", "x-goog-api-key", "cookie"]) headers.delete(name);
      if (url.pathname === "/v1/messages") {
        headers.set("x-api-key", key);
        if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
      } else headers.set("authorization", `Bearer ${key}`);
      let response;
      try {
        response = await globalThis.fetch(url, { ...inherited, ...init, headers, redirect: "manual" });
      } catch (error) {
        if (init.signal?.aborted || inherited.signal?.aborted) throw new DOMException("模型请求已取消。", "AbortError");
        throw new UsageError("MODEL_NETWORK", "无法连接 Krill 模型接口，请检查接入线路、网络或代理。");
      }
      // Return the original stream so tokens, tool calls, status, and abort
      // handling remain under Magpie's control. No body buffering here.
      return modelErrorResponse(response);
    },
  };
}
