import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
function checkDirectory(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", ".sandbox"].includes(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) checkDirectory(path);
    else if (entry.name.endsWith(".mjs")) {
      const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" });
      assert.equal(result.status, 0, `Syntax check failed: ${path}`);
    }
  }
}
checkDirectory(root);

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const mod = await import(new URL(`../${pkg.main}`, import.meta.url));
const plugins = Object.values(mod).filter((value) => typeof value === "function");
assert.equal(plugins.length, 1, "The entry must export exactly one plugin function");
const hooks = await plugins[0]({});
assert.equal(hooks.auth.provider, "krill-usage");
assert.equal(typeof hooks.auth.loader, "function");
assert.equal(typeof hooks.auth.usage, "function");
assert.equal(hooks.auth.methods.length, 2);
for (const method of hooks.auth.methods) {
  assert.equal(method.type, "oauth");
  assert.equal(typeof method.authorize, "function");
}
assert.deepEqual(hooks.auth.methods[0].prompts.map((prompt) => prompt.key), ["email", "password", "modelKey", "route"]);
assert.deepEqual(hooks.auth.methods[1].prompts.map((prompt) => prompt.key), ["modelKey", "route"]);
const config = {};
await hooks.config(config);
assert.deepEqual(config.provider[hooks.auth.provider].models, {});
assert.deepEqual(await hooks.provider.models(), {});
console.log("Syntax and Magpie provider plugin contract checks passed.");
