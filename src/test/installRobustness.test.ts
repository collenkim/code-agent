import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { writeIfChanged } from "../core/atomic";
import { init, codexWindowsCommand } from "../agent/init";
import { installPackageRelease } from "../agent/releaseStore";
import { applyTemplates } from "../agent/runtimeApply";
import { applyBeforeOpening, versionView } from "../agent/runtimeGate";
import { STATE_SCHEMA } from "../agent/runtimeSelect";
import { previewReleaseApply } from "../agent/sourceUpdate";
import { withCaller } from "./reviewFixture";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ca-install-robust-")); });
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
function installed() { execFileSync("git", ["init", "-q"], { cwd: root }); init(root, { host: "claude" }); }

test("2-10 설정 교체는 일시적 rename 실패 중에도 기존 완결된 내용을 보존한다", () => {
  const file = join(root, "settings.json"), old = '{"old":true}', next = '{"new":true}'; write(file, old);
  const fs = require("fs") as typeof import("fs"), rename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (from, to) => {
    assert.equal(readFileSync(file, "utf8"), old);
    if (++attempts < 3) throw Object.assign(new Error("held"), { code: "EPERM" });
    rename(from, to);
  };
  try { assert.equal(writeIfChanged(file, Buffer.from(next)), true); }
  finally { fs.renameSync = rename; }
  assert.equal(attempts, 3); assert.equal(readFileSync(file, "utf8"), next);
  assert.equal(writeIfChanged(file, next), false);
});

test("2-10 런타임 기록 실패는 앞서 적용한 호스트 설정도 되돌린다", () => {
  installed();
  const settings = join(root, ".claude/settings.json"), before = readFileSync(settings, "utf8"), runtime = join(root, ".code-agent/runtime.json");
  const fs = require("fs") as typeof import("fs"), rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (resolve(String(to)) === resolve(runtime)) throw Object.assign(new Error("runtime fixture failure"), { code: "ENOSPC" });
    rename(from, to);
  };
  try {
    assert.throws(() => applyTemplates(root, { host: "claude", cli: join(root, "changed-cli.js"), runtime: { schema: 1, stateSchema: STATE_SCHEMA } }), /runtime fixture failure/);
    assert.equal(readFileSync(settings, "utf8"), before); assert.equal(existsSync(runtime), false);
  } finally { fs.renameSync = rename; }
});

test("2-10 PowerShell hook의 달러·백틱·작은따옴표 경로를 그대로 실행한다", { skip: process.platform !== "win32" }, () => {
  const cli = join(root, "cli $value` 'quoted'.js"); write(cli, "console.log(JSON.stringify(process.argv.slice(2)));");
  const shell = join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const output = execFileSync(shell, ["-NoProfile", "-Command", codexWindowsCommand("PreToolUse", cli)], { encoding: "utf8", windowsHide: true });
  assert.deepEqual(JSON.parse(output.trim()), ["codex-event"]);
});

test("2-10 npm 사본은 직접 의존성과 중첩된 다른 버전 및 그 전이 의존성을 보존한다", () => {
  const pkg = join(root, "package"), modules = join(pkg, "node_modules"), home = join(root, "releases");
  write(join(pkg, "package.json"), JSON.stringify({ name: "code-agent", version: "1.0.0", dependencies: { a: "1", b: "1" } }));
  write(join(pkg, "dist/agent/cli.js"), "console.log('code-agent fixture');");
  write(join(pkg, "dist/agent/check.js"), "if(require('a')!=='2-C'||require('b')!=='1')throw Error('nested versions lost');");
  for (const [path, dependencies, content] of [
    ["a", { b: "2" }, "module.exports=require('b');"],
    ["b", {}, "module.exports='1';"],
    ["a/node_modules/b", { c: "1" }, "module.exports='2-'+require('c');"],
    ["c", {}, "module.exports='C';"],
  ] as const) {
    write(join(modules, path, "package.json"), JSON.stringify({ name: path.split("/").at(-1), version: path.includes("node_modules") ? "2.0.0" : "1.0.0", main: "index.js", dependencies }));
    write(join(modules, path, "index.js"), content);
  }
  const result = installPackageRelease(pkg, home);
  assert.equal(require(join(result.dir, "node_modules/a")), "2-C");
  assert.equal(require(join(result.dir, "node_modules/b")), "1");
});

test("2-10 버전 조회와 선택은 프로젝트에 기록된 다른 릴리스 저장소도 찾는다", () => {
  const home = join(root, "other-releases"), id = "1.0.0-123456789abc", dir = join(home, id);
  write(join(dir, "dist/agent/cli.js"), "");
  write(join(dir, "release.json"), JSON.stringify({ schema: 1, id, version: "1.0.0", stateSchema: STATE_SCHEMA, installedAt: new Date().toISOString(), source: { kind: "package", contentHash: "hash" }, contentHash: "hash" }));
  write(join(root, ".code-agent/runtime.json"), JSON.stringify({ schema: 1, applied: id, home, stateSchema: STATE_SCHEMA }));
  const view = versionView(root).store as { releases: { id: string; home: string }[] };
  assert.ok(view.releases.some(release => release.id === id && release.home === home));
  assert.equal(withCaller(undefined, () => previewReleaseApply(root, id)).store, home);
});

test("2-10 여는 명령의 hook은 npm 패키지 전체를 해시하거나 복사하지 않는다", () => {
  installed();
  const pkg = join(root, "node_modules/code-agent"), entry = join(pkg, "dist/agent/cli.js");
  write(entry, ""); write(join(pkg, "package.json"), '{"version":"1.0.0"}');
  const store = require("../agent/releaseStore") as typeof import("../agent/releaseStore"), original = store.packageRelease, saved = process.env.CODE_AGENT_ENTRY;
  let reads = 0;
  store.packageRelease = () => { reads += 1; throw new Error("unexpected package hash"); };
  process.env.CODE_AGENT_ENTRY = entry;
  try { applyBeforeOpening(root); assert.equal(reads, 0); }
  finally { store.packageRelease = original; if (saved === undefined) delete process.env.CODE_AGENT_ENTRY; else process.env.CODE_AGENT_ENTRY = saved; }
});
