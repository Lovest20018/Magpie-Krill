import assert from "node:assert/strict";
import test from "node:test";
import { createWebsiteAccounts } from "../src/website-accounts.mjs";
import { linkedLoginMethod } from "../src/linked-login.mjs";
import { TOKEN_A, TOKEN_B, jsonResponse } from "./fixtures.mjs";

const auth = { type: "oauth", access: TOKEN_A, uid: "7", email: "synthetic@example.test", accountId: "synthetic-key-slot", modelKey: "synthetic-model-key", route: "direct" };

test("shared website sessions retain account fields only and select options never contain credentials", () => {
  const accounts = createWebsiteAccounts();
  const id = accounts.observe(auth);
  assert.equal(accounts.options[0].label, auth.email);
  assert.equal(accounts.options[0].value, id);
  for (const secret of [TOKEN_A, auth.modelKey]) assert.equal(JSON.stringify(accounts.options).includes(secret), false);
  const session = accounts.select(id);
  assert.equal(session.access, TOKEN_A);
  assert.equal(session.modelKey, undefined);
  assert.equal(session.route, undefined);
  assert.equal(session.accountId, undefined);
});

test("reloading from host-provided snapshots restores sharing without any filesystem access", () => {
  const old = createWebsiteAccounts();
  const signed = old.signedIn({ ...auth, type: "success" });
  const fresh = createWebsiteAccounts();
  const linked = { ...signed, type: "oauth", modelKey: "synthetic-balance-key", websiteShared: true };
  const id = fresh.observe(linked, "krill-balance");
  assert.equal(fresh.select(id).email, auth.email);
  assert.equal(fresh.select(id).access, signed.access);
});

test("relogin propagates only website credentials, preserving every linked connection's Key, route and identity", async () => {
  const accounts = createWebsiteAccounts({ now: () => 100 });
  const initial = accounts.signedIn({ ...auth, type: "success" });
  const linked = { ...initial, type: "oauth", accountId: "balance-key-slot", modelKey: "synthetic-balance-key", route: "cdn", websiteShared: true };
  const next = accounts.signedIn({ ...auth, type: "success", access: TOKEN_B });
  assert.ok(next.websiteSignedInAt > initial.websiteSignedInAt);
  const writes = [];
  const resolved = await accounts.resolve(linked, { provider: "krill-balance", save: async value => writes.push(value) });
  assert.equal(resolved.access, TOKEN_B);
  assert.equal(resolved.modelKey, linked.modelKey);
  assert.equal(resolved.route, linked.route);
  assert.equal(resolved.accountId, linked.accountId);
  assert.equal(resolved.websiteShared, true);
  assert.equal(writes.length, 1);
  await accounts.resolve(resolved, { provider: "krill-balance", save: async value => writes.push(value) });
  assert.equal(writes.length, 1);
});

test("older linked snapshots cannot replace a newer shared login, including after reconstruction", async () => {
  const accounts = createWebsiteAccounts();
  accounts.observe({ ...auth, access: TOKEN_B, websiteSignedInAt: 200 }, "krill");
  accounts.observe({ ...auth, websiteSignedInAt: 100 }, "krill-balance");
  const resolved = await accounts.resolve({ ...auth, websiteSignedInAt: 100 }, { provider: "krill-balance" });
  assert.equal(resolved.access, TOKEN_B);
  assert.equal(resolved.websiteSignedInAt, 200);
});

test("different website accounts cannot share credentials and Key-only connections are not implicitly linked", async () => {
  const accounts = createWebsiteAccounts();
  const a = accounts.observe(auth);
  const b = accounts.observe({ ...auth, email: "other@example.test", uid: "8", access: TOKEN_B });
  assert.notEqual(a, b);
  assert.equal(accounts.select(a).access, TOKEN_A);
  assert.equal(accounts.select(b).access, TOKEN_B);
  const standalone = { ...auth, connection: "model-only", access: "" };
  assert.equal(await accounts.resolve(standalone), standalone);
  assert.equal(accounts.observe(standalone), undefined);
  const legacy = { type: "api", key: TOKEN_A, email: auth.email, uid: auth.uid };
  assert.equal(await accounts.resolve(legacy), legacy);
  assert.equal(accounts.observe(legacy), undefined);
});

test("a known rejected token is not offered or revived by an old snapshot; a new login restores the account", () => {
  const accounts = createWebsiteAccounts();
  const id = accounts.observe(auth);
  accounts.rejected(auth);
  assert.deepEqual(accounts.options, []);
  accounts.observe(auth);
  assert.throws(() => accounts.select(id), { code: "WEBSITE_ACCOUNT" });
  accounts.signedIn({ ...auth, type: "success", access: TOKEN_B });
  assert.equal(accounts.select(id).access, TOKEN_B);
});

const nextPrompt = (method, inputs = {}) => method.prompts.find(prompt => !(prompt.key in inputs) && (!prompt.condition || prompt.condition(inputs)));

for (const balance of [false, true]) {
  const provider = balance ? "balance" : "subscription";
  test(`${provider} starts email/password login without a pre-existing account and shares it with the other provider`, async t => {
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      calls.push(url);
      if (url.endsWith("/models")) {
        assert.equal(init.headers.authorization, `Bearer ${auth.modelKey}`);
        return jsonResponse({ data: [{ id: "private-image", model_type: "image" }] });
      }
      assert.equal(url, "https://www.krill-code.com/api/auth/login");
      assert.deepEqual(JSON.parse(init.body), { email: auth.email, password: "synthetic-password" });
      assert.equal(init.headers.authorization, undefined);
      return jsonResponse({ success: true, code: 0, data: { token: TOKEN_A, user: { email: auth.email, id: auth.uid } } });
    });
    const accounts = createWebsiteAccounts({ now: () => 100 });
    const method = linkedLoginMethod(1000, accounts, { balance });
    const other = linkedLoginMethod(1000, accounts, { balance: !balance });
    assert.equal(nextPrompt(method).key, "email");
    assert.equal(nextPrompt(other).key, "email");
    assert.equal(nextPrompt(method, { email: auth.email }).key, "password");
    const input = { email: auth.email, password: "synthetic-password", modelKey: auth.modelKey, route: "direct" };
    const saved = await (await method.authorize(input)).callback();
    assert.equal(saved.type, "success");
    assert.equal(saved.websiteSignedInAt, 100);
    assert.equal(saved.password, undefined);
    if (balance) assert.match(saved.accountId, /^Krill Key /);
    else assert.equal(saved.accountId, auth.email);
    const choose = nextPrompt(other);
    assert.equal(choose.key, "websiteAccount");
    assert.deepEqual(choose.options.map(option => option.label), [auth.email, "登录其他账号"]);
    const websiteAccount = choose.options[0].value;
    assert.equal(nextPrompt(other, { websiteAccount }).key, "modelKey");
    // A subscription can reuse website statistics without any model Key.
    const linked = await (await other.authorize({ websiteAccount, modelKey: balance ? "" : auth.modelKey, route: "direct" })).callback();
    assert.equal(linked.type, "success");
    assert.equal(linked.access, saved.access);
    assert.equal(linked.websiteSignedInAt, saved.websiteSignedInAt);
    assert.equal(linked.websiteShared, true);
    assert.equal(linked.modelKey, balance ? undefined : auth.modelKey);
    assert.equal(calls.filter(url => url.endsWith("/login")).length, 1);
  });
}

test("either provider can choose another account while an existing session is available", async t => {
  const accounts = createWebsiteAccounts();
  const id = accounts.observe(auth);
  t.mock.method(globalThis, "fetch", async url => jsonResponse(url.endsWith("/models") ? { data: [] }
    : { success: true, code: 0, data: { token: TOKEN_B, user: { email: "other@example.test", id: "8" } } }));
  for (const balance of [false, true]) {
    const method = linkedLoginMethod(1000, accounts, { balance });
    const websiteAccount = nextPrompt(method).options.find(option => option.label === "登录其他账号").value;
    assert.equal(nextPrompt(method, { websiteAccount }).key, "email");
    assert.equal(nextPrompt(method, { websiteAccount, email: "other@example.test" }).key, "password");
    const saved = await (await method.authorize({ websiteAccount, email: "other@example.test", password: "synthetic-other-password", modelKey: auth.modelKey })).callback();
    assert.equal(saved.type, "success");
    assert.equal(saved.email, "other@example.test");
    assert.equal(saved.access, TOKEN_B);
    assert.equal(accounts.select(id).access, TOKEN_A);
  }
});

test("a first login keeps asking for its password when another session arrives midway", () => {
  const accounts = createWebsiteAccounts();
  const method = linkedLoginMethod(1000, accounts, { balance: true });
  assert.equal(nextPrompt(method).key, "email");
  accounts.observe(auth);
  assert.equal(nextPrompt(method, { email: "other@example.test" }).key, "password");
});

test("balance-first TOTP login is completed once and a subscription then reuses the session", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(url);
    if (url.endsWith("/models")) {
      assert.equal(init.headers.authorization, `Bearer ${auth.modelKey}`);
      return jsonResponse({ data: [{ id: "private-image", model_type: "image" }] });
    }
    assert.equal(init.headers.authorization, undefined);
    assert.equal(init.body.includes(auth.modelKey), false);
    const data = url.endsWith("/totp") ? { token: TOKEN_A, user: { email: auth.email, id: auth.uid } }
      : { requires_totp: true, pending_token: "synthetic-pending" };
    if (url.endsWith("/totp")) assert.deepEqual(JSON.parse(init.body), { pending_token: "synthetic-pending", totp_code: "123456" });
    return jsonResponse({ success: true, code: 0, data });
  });
  const accounts = createWebsiteAccounts();
  const method = linkedLoginMethod(1000, accounts, { balance: true });
  const flow = await method.authorize({ email: auth.email, password: "synthetic-password", modelKey: auth.modelKey, route: "direct" });
  assert.equal(flow.method, "code");
  assert.equal(accounts.options.length, 0);
  const saved = await flow.callback("123456");
  assert.equal(saved.type, "success");
  const other = linkedLoginMethod(1000, accounts);
  const websiteAccount = nextPrompt(other).options[0].value;
  const linked = await (await other.authorize({ websiteAccount, modelKey: "" })).callback();
  assert.equal(linked.type, "success");
  assert.equal(linked.access, saved.access);
  assert.deepEqual(calls, ["https://api.krill-code.net/v1/models", "https://www.krill-code.com/api/auth/login", "https://www.krill-code.com/api/auth/login/totp"]);
  for (const secret of ["synthetic-password", "123456", "synthetic-pending"]) {
    assert.equal(JSON.stringify(saved).includes(secret), false);
    assert.equal(JSON.stringify(linked).includes(secret), false);
  }
});

test("an invalid balance Key prevents sign-in and cannot create a shared session", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async url => { calls.push(url); return new Response("", { status: 401 }); });
  const accounts = createWebsiteAccounts();
  const method = linkedLoginMethod(1000, accounts, { balance: true });
  const failed = await (await method.authorize({ email: auth.email, password: "synthetic-password", modelKey: auth.modelKey, route: "direct" })).callback();
  assert.equal(failed.type, "failed");
  assert.match(failed.error, /模型 API Key/);
  assert.deepEqual(calls, ["https://api.krill-code.net/v1/models"]);
  assert.deepEqual(accounts.options, []);
});

test("account selection requires a known identity and verifies only the model Key, without website login requests", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(url);
    assert.equal(url, "https://api.krill-code.net/v1/models");
    assert.equal(init.headers.authorization, `Bearer ${auth.modelKey}`);
    return jsonResponse({ data: [{ id: "gpt-6-astra" }] });
  });
  const accounts = createWebsiteAccounts(), method = linkedLoginMethod(1000, accounts, { balance: true });
  const id = accounts.observe(auth);
  assert.equal(method.prompts[0].options[0].value, id);
  const result = await (await method.authorize({ websiteAccount: id, modelKey: auth.modelKey, route: "direct" })).callback();
  assert.equal(result.type, "success");
  assert.equal(result.access, TOKEN_A);
  assert.equal(result.modelKey, auth.modelKey);
  assert.equal(result.websiteShared, true);
  assert.equal(calls.length, 1);
  const failed = await (await method.authorize({ websiteAccount: "nonexistent", modelKey: auth.modelKey, route: "direct" })).callback();
  assert.equal(failed.type, "failed");
  assert.equal(calls.length, 1);
});

test("multiple website accounts require explicit selection; no first-account fallback can misattribute balances", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Unexpected network"); });
  const accounts = createWebsiteAccounts();
  accounts.observe(auth);
  accounts.observe({ ...auth, email: "other@example.test", uid: "8", access: TOKEN_B });
  const result = await (await linkedLoginMethod(1000, accounts, { balance: true }).authorize({ modelKey: auth.modelKey, route: "direct" })).callback();
  assert.equal(result.type, "failed");
  assert.equal(calls, 0);
});

test("a balance relogin updates a linked subscription without copying its model credentials", async () => {
  const accounts = createWebsiteAccounts({ now: () => 100 });
  const first = accounts.signedIn({ ...auth, type: "success" }, "krill-balance");
  const subscription = { ...first, type: "oauth", accountId: auth.email, modelKey: "synthetic-plan-key", route: "cdn", websiteShared: true };
  accounts.signedIn({ ...auth, type: "success", access: TOKEN_B }, "krill-balance");
  const writes = [];
  const updated = await accounts.resolve(subscription, { provider: "krill", save: async value => writes.push(value) });
  assert.equal(updated.access, TOKEN_B);
  for (const key of ["modelKey", "route", "accountId"]) assert.equal(updated[key], subscription[key]);
  assert.equal(writes.length, 1);
});

test("an expired selected session offers direct login and never silently uses another account", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Unexpected network"); });
  const accounts = createWebsiteAccounts();
  const id = accounts.observe(auth);
  const method = linkedLoginMethod(1000, accounts, { balance: true });
  accounts.rejected(auth);
  assert.equal(nextPrompt(method).key, "email");
  const failed = await (await method.authorize({ websiteAccount: id, modelKey: auth.modelKey })).callback();
  assert.equal(failed.type, "failed");
  assert.match(failed.error, /邮箱密码登录/);
  assert.equal(calls, 0);
});

test("shared website account memory is bounded and ignores malformed snapshots", () => {
  const accounts = createWebsiteAccounts();
  for (const snapshot of [undefined, { ...auth, email: "invalid" }, { ...auth, access: "not a token" }, { type: "api", key: TOKEN_A }]) assert.equal(accounts.observe(snapshot), undefined);
  const first = accounts.observe(auth);
  for (let i = 0; i < 50; i++) accounts.observe({ ...auth, email: `synthetic-${i}@example.test`, uid: String(i + 100) });
  assert.equal(accounts.options.length, 50);
  assert.throws(() => accounts.select(first), { code: "WEBSITE_ACCOUNT" });
});
