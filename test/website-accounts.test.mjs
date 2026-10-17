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

test("no cached website account yields a clear native error without asking for a second password or making requests", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Unexpected network"); });
  const accounts = createWebsiteAccounts(), method = linkedLoginMethod(1000, accounts);
  assert.equal(method.prompts.some(prompt => ["email", "password"].includes(prompt.key)), false);
  assert.ok(method.prompts.every(prompt => !prompt.condition({})));
  const result = await (await method.authorize({ modelKey: auth.modelKey })).callback();
  assert.equal(result.type, "failed");
  assert.match(result.error, /Krill · 套餐/);
  assert.equal(calls, 0);
});

test("account selection requires a known identity and verifies only the model Key, without website login requests", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(url);
    assert.equal(url, "https://api.krill-code.net/v1/models");
    assert.equal(init.headers.authorization, `Bearer ${auth.modelKey}`);
    return jsonResponse({ data: [{ id: "gpt-6-astra" }] });
  });
  const accounts = createWebsiteAccounts(), method = linkedLoginMethod(1000, accounts);
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
  const result = await (await linkedLoginMethod(1000, accounts).authorize({ modelKey: auth.modelKey, route: "direct" })).callback();
  assert.equal(result.type, "failed");
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
