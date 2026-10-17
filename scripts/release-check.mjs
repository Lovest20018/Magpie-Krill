import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const npmCli = [
  process.env.npm_execpath,
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
].find((path) => path && existsSync(path));
assert.ok(npmCli, "Run this check through npm, or install npm alongside Node.js.");

assert.equal(pkg.main, "./index.mjs");
assert.equal(pkg.type, "module");
assert.equal(pkg.license, "MIT");
assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
for (const kind of ["dependencies", "optionalDependencies", "devDependencies"]) {
  assert.equal(Object.keys(pkg[kind] ?? {}).length, 0, `Unexpected ${kind}; review the zero-dependency release policy.`);
}
assert.equal(Object.keys(pkg.scripts ?? {}).some((key) => /^(?:preinstall|install|postinstall|prepack|prepare)$/.test(key)), false,
  "Installation and packing must not run lifecycle scripts.");

// npm's actual pack list is authoritative, rather than only checking `files`.
const cache = mkdtempSync(join(tmpdir(), "krill-release-check-"));
let manifest;
try {
  const result = spawnSync(process.execPath, [npmCli, "pack", "--dry-run", "--ignore-scripts", "--json", "--cache", cache], {
    cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `npm pack dry run failed: ${result.stderr || result.error?.message || "unknown error"}`);
  const packs = JSON.parse(result.stdout);
  assert.equal(packs.length, 1);
  [manifest] = packs;
} finally {
  assert.equal(dirname(resolve(cache)), resolve(tmpdir()), "Only remove the temporary directory created for this release check.");
  assert.ok(basename(cache).startsWith("krill-release-check-"));
  rmSync(cache, { recursive: true, force: true });
}

const documents = new Set(["package.json", "index.mjs", "README.md", "PRIVACY.md", "RELEASE.md", "LICENSE", "NOTICE"]);
const runtime = new Set([
  "api", "errors", "http", "inference", "key-login", "login", "login-result",
  "model-capabilities", "model-errors", "models", "pricing", "routes", "token", "usage",
].map(name => `src/${name}.mjs`));
const paths = new Set();
for (const file of manifest.files) {
  const path = file.path.replaceAll("\\", "/");
  assert.equal(paths.has(path), false, `Duplicate package entry: ${path}`);
  paths.add(path);
  assert.ok(documents.has(path) || runtime.has(path) || path === "assets/krill.png",
    `Unexpected packed file: ${path}`);
  assert.ok(!path.split("/").some((part) => [".", "..", ".sandbox", ".git", "test", "node_modules"].includes(part)),
    `Unsafe package path: ${path}`);
  assert.ok(file.size < 1024 * 1024, `Unexpectedly large packed file: ${path}`);
  const text = readFileSync(join(root, path), "utf8");
  assert.ok(!/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text), `Private key found in ${path}`);
  assert.ok(!/Bearer\s+eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text), `JWT bearer literal found in ${path}`);
}
for (const path of documents) assert.ok(paths.has(path), `Missing release file: ${path}`);
for (const path of runtime) assert.ok(paths.has(path), `Missing runtime module: ${path}`);
assert.ok(paths.has("assets/krill.png"), "Missing provider icon asset");
assert.equal(manifest.name, pkg.name);
assert.equal(manifest.version, pkg.version);

const icon = readFileSync(join(root, "assets/krill.png"));
assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "The provider icon must be a PNG.");
assert.ok(icon.length <= 128 * 1024, "Unexpectedly large provider icon.");
assert.equal(icon.subarray(12, 16).toString("ascii"), "IHDR");
assert.equal(icon.readUInt32BE(16), 160); assert.equal(icon.readUInt32BE(20), 160);
assert.match(pkg.magpie?.icon ?? "", /^data:image\/png;base64,/);
assert.deepEqual(Buffer.from(pkg.magpie.icon.split(",")[1], "base64"), icon,
  "The packaged icon metadata must match assets/krill.png.");

const entry = await import(pathToFileURL(join(root, "index.mjs")));
assert.equal(Object.keys(entry).length, 1, "The entry must expose exactly one plugin export.");
assert.equal(typeof Object.values(entry)[0], "function");
const hooks = await Object.values(entry)[0]({});
assert.equal(hooks.auth.provider, "krill");
assert.equal(hooks.provider.id, "krill");
assert.equal(typeof hooks.auth.loader, "function");
assert.equal(typeof hooks.auth.usage, "function");
assert.equal(typeof hooks.provider.models, "function");
assert.equal(typeof hooks.config, "function");
assert.equal(hooks.auth.methods.length, 2, "Only password/TOTP and API key sign-in belong in the release.");

assert.equal(pkg.repository?.url, "git+https://github.com/Lovest20018/Magpie-Krill.git");
console.log(`Release boundary passed: ${pkg.name}@${pkg.version}, ${paths.size} packed files, one plugin export, no runtime dependencies. No credentials or live service were used.`);
