import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function install(spec: string): Record<string, unknown> {
  const prefix = mkdtempSync(join(tmpdir(), "pi-herdr-package-"));
  cleanups.push(prefix);
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-package-lock", "--omit=peer", "--prefix", prefix, spec],
    { cwd: root, stdio: "pipe" },
  );
  return JSON.parse(
    readFileSync(join(prefix, "node_modules", "pi-herdr-subagents", "package.json"), "utf8"),
  );
}

function makeGitPackageFixture(): string {
  const fixture = mkdtempSync(join(tmpdir(), "pi-herdr-git-package-"));
  cleanups.push(fixture);
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", fixture], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  execFileSync("tar", ["-xzf", join(fixture, packed.filename), "-C", fixture]);
  const packageRepo = join(fixture, "package");
  execFileSync("git", ["init", "-q"], { cwd: packageRepo });
  execFileSync("git", ["add", "."], { cwd: packageRepo });
  execFileSync(
    "git",
    ["-c", "user.name=Package Test", "-c", "user.email=package@test.invalid", "commit", "-qm", "fixture"],
    { cwd: packageRepo },
  );
  return packageRepo;
}

describe("package", () => {
  it("exports a Pi extension and declares its supported runtimes", async () => {
    const mod = await import("../extensions/herdr-subagents/index.ts");
    assert.equal(typeof mod.default, "function");

    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.deepEqual(pkg.pi.extensions, ["./extensions/herdr-subagents/index.ts"]);
    assert.equal(pkg.engines.node, ">=22");
    assert.deepEqual(pkg.herdr, { version: ">=0.8.2 <0.9", protocol: 20 });
    assert.match(pkg.peerDependencies["@earendil-works/pi-ai"], />=0\.84\.0/);
    assert.match(pkg.peerDependencies["@earendil-works/pi-coding-agent"], />=0\.84\.0/);
    assert.match(pkg.peerDependencies.typebox, />=1\.0\.0/);
    assert.equal(pkg.devDependencies["@mariozechner/pi-coding-agent"], undefined);
    assert.equal(pkg.devDependencies["@sinclair/typebox"], undefined);
  });

  it("packs only runtime files and no bundled role definitions", () => {
    const [packed] = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    const paths = packed.files.map((file: { path: string }) => file.path);
    assert.ok(paths.includes("LICENSE"));
    assert.ok(paths.includes("extensions/herdr-subagents/index.ts"));
    assert.ok(!paths.includes("subagent-done.ts"));
    assert.ok(paths.includes("src/child-runtime.ts"));
    assert.ok(paths.includes("src/child-protocol.ts"));
    assert.ok(paths.some((path: string) => path.startsWith("src/")));
    assert.ok(paths.every((path: string) => !path.startsWith("agents/")));
    assert.ok(paths.every((path: string) => !path.startsWith("test/")));
  });

  it("installs from Pi-compatible local and Git package specs", () => {
    assert.equal(install(root).name, "pi-herdr-subagents");
    assert.equal(install(`git+file://${makeGitPackageFixture()}#HEAD`).name, "pi-herdr-subagents");
  });
});
