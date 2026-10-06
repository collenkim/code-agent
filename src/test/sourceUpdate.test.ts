import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { previewSourceUpdate, sourceUpdateSnapshot, updateFromSource, type SourceUpdateOptions } from "../agent/update";

let root: string;
let remote: string;
let seed: string;
let source: string;
let target: string;
let calls: string[][];

function write(base: string, file: string, value: string): void {
  mkdirSync(dirname(join(base, file)), { recursive: true });
  writeFileSync(join(base, file), value);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "no-global-config") },
  }).trim();
}

function identity(cwd: string): void {
  git(cwd, "config", "user.name", "Source Update Test");
  git(cwd, "config", "user.email", "source-update@example.invalid");
  git(cwd, "config", "commit.gpgsign", "false");
  git(cwd, "config", "core.autocrlf", "false");
}

function commit(cwd: string, message: string): void {
  git(cwd, "add", "--all");
  git(cwd, "commit", "-m", message);
}

// A tiny independently built CLI makes stale-module execution observable. Git,
// builds and child invocations are real; only dependency installation is faked.
function cli(version: string, doctorExit = 0): string {
  return `const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync('child-invocations.jsonl', JSON.stringify({args, pid: process.pid, version: ${JSON.stringify(version)}}) + '\\n');
if (args[0] === 'update') {
  if (args[1] !== '--templates-only') throw new Error('recursive source update');
  fs.writeFileSync('installed-template', fs.readFileSync(path.join(__dirname, '../../template/value')));
  fs.writeFileSync('installed-version', ${JSON.stringify(version)});
  console.log('templates ${version} applied');
} else if (args[0] === 'doctor') {
  console.log('doctor ${version}: ${doctorExit ? "failed" : "ok"}');
  process.exitCode = ${doctorExit};
} else throw new Error('unexpected command');
`;
}

function publish(version: string, doctorExit = 0): void {
  write(seed, "cli-entry.js", cli(version, doctorExit));
  write(seed, "template/value", `template ${version}`);
  commit(seed, version);
  git(seed, "push", "origin", "main");
}

function installed(cwd: string): void {
  write(cwd, "node_modules/.package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: {} }));
}

function options(): SourceUpdateOptions {
  return {
    sourceRoot: source,
    runNpm(args, cwd) {
      assert.equal(cwd, source);
      calls.push([...args]);
      if (args[0] === "ci") installed(cwd);
      else execFileSync(process.execPath, ["build.js"], { cwd, windowsHide: true });
      return `ran npm ${args.join(" ")}`;
    },
  };
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca source update ")));
  remote = join(root, "upstream.git");
  seed = join(root, "publisher");
  source = join(root, "source install");
  target = join(root, "user project");
  calls = [];
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "clone", remote, seed);
  identity(seed);
  write(seed, ".gitignore", "node_modules/\ndist/\n.code-agent/\n");
  write(seed, ".npmrc", "audit=false\nfund=false\noffline=true\n");
  write(seed, "package.json", JSON.stringify({ name: "source-update-fixture", version: "1.0.0", scripts: { build: "node build.js", prepare: "node build.js" } }));
  write(seed, "package-lock.json", JSON.stringify({ name: "source-update-fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "source-update-fixture", version: "1.0.0" } } }));
  write(seed, "build.js", "const fs = require('node:fs'); fs.mkdirSync('dist/agent', {recursive: true}); fs.copyFileSync('cli-entry.js', 'dist/agent/cli.js');");
  publish("old");
  git(root, "clone", remote, source);
  identity(source);
  execFileSync(process.execPath, ["build.js"], { cwd: source, windowsHide: true });
  mkdirSync(target);
  git(target, "init", "--initial-branch=main");
  identity(target);
  write(target, "user.txt", "user work stays here");
  commit(target, "user baseline");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("preview audits only the installed source, without fetching or writing", () => {
  publish("new");
  git(source, "remote", "set-url", "origin", join(root, "unreachable.git"));
  const before = git(source, "rev-parse", "HEAD");
  const preview = previewSourceUpdate(target, options());
  assert.match(preview, /설치 유형: git-source/);
  assert.ok(preview.includes(source));
  assert.match(preview, /브랜치: main/);
  assert.match(preview, /remote: origin/);
  assert.match(preview, /upstream: refs\/remotes\/origin\/main/);
  assert.match(preview, /prepare/);
  assert.equal(git(source, "rev-parse", "HEAD"), before);
  assert.equal(existsSync(join(source, ".git/FETCH_HEAD")), false);
  assert.deepEqual(calls, []);
});

test("one shot fast-forwards, installs, builds, applies fresh CLI templates and runs fresh doctor", () => {
  publish("new");
  git(source, "config", "pull.rebase", "true");
  git(source, "config", "merge.autoStash", "true");
  write(target, "user.txt", "uncommitted target change");
  const targetHead = git(target, "rev-parse", "HEAD");
  const report = updateFromSource(target, options());
  assert.equal(git(source, "rev-parse", "HEAD"), git(seed, "rev-parse", "HEAD"));
  assert.equal(git(source, "status", "--porcelain"), "");
  assert.deepEqual(calls, [["ci", "--include=dev"], ["run", "build"]]);
  assert.equal(readFileSync(join(target, "installed-template"), "utf8"), "template new");
  assert.equal(readFileSync(join(target, "installed-version"), "utf8"), "new");
  const children = readFileSync(join(target, "child-invocations.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(children.map(child => child.args), [["update", "--templates-only"], ["doctor"]], "훅 명령은 설치된 꼴을 잇는다 — 이 PC 의 빌드 경로를 공유 설정에 박지 않는다");
  assert.ok(children.every(child => child.pid !== process.pid && child.version === "new"));
  assert.equal(git(target, "rev-parse", "HEAD"), targetHead);
  assert.equal(readFileSync(join(target, "user.txt"), "utf8"), "uncommitted target change");
  assert.match(report, /doctor new: ok/);
});

test("unchanged lock with installed dependencies skips ci, but still builds and honors hook override", () => {
  installed(source);
  publish("new");
  updateFromSource(target, { ...options(), cli: "custom hook.js" });
  assert.deepEqual(calls, [["run", "build"]]);
  const first = JSON.parse(readFileSync(join(target, "child-invocations.jsonl"), "utf8").split("\n")[0]);
  assert.equal(first.args[3], join(target, "custom hook.js"));
});

test("a changed lock or missing dev dependency triggers locked installation", () => {
  installed(source);
  write(seed, "package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/compiler": { version: "2", dev: true } } }));
  publish("new");
  updateFromSource(target, options());
  assert.deepEqual(calls, [["ci", "--include=dev"], ["run", "build"]]);
  calls = [];
  updateFromSource(target, options());
  assert.deepEqual(calls, [["ci", "--include=dev"], ["run", "build"]]);
});

test("untracked, unstaged and staged source changes stop before fetch or build", () => {
  publish("new");
  for (const kind of ["untracked", "unstaged", "staged"]) {
    const before = git(source, "rev-parse", "HEAD");
    const file = kind === "untracked" ? "notes.txt" : "template/value";
    write(source, file, `user ${kind} change`);
    if (kind === "staged") git(source, "add", file);
    assert.throws(() => updateFromSource(target, options()), /미커밋 변경.*커밋/);
    assert.equal(existsSync(join(source, ".git/FETCH_HEAD")), false);
    assert.equal(git(source, "rev-parse", "HEAD"), before);
    assert.equal(readFileSync(join(source, file), "utf8"), `user ${kind} change`);
    assert.deepEqual(calls, []);
    // Keep all dirty variants in place; commit between variants, never reset.
    commit(source, `user ${kind}`);
  }
});

test("source equals target: dirty user work and ignored active work both block", () => {
  write(source, "user-change", "keep me");
  assert.throws(() => updateFromSource(source, options()), /미커밋 변경/);
  commit(source, "save work");
  write(source, ".code-agent/active.json", JSON.stringify({ id: "WORK-1", spec: "doc/spec.md", target: "app", phase: "implement", stage: "domain" }));
  assert.throws(() => updateFromSource(source, options()), /진행 중인 작업/);
  assert.equal(existsSync(join(source, ".git/FETCH_HEAD")), false);
});

test("missing upstream and detached HEAD cannot fetch or build", () => {
  git(source, "branch", "--unset-upstream");
  assert.throws(() => updateFromSource(target, options()), /upstream 이 필요/);
  git(source, "checkout", "--detach");
  assert.throws(() => updateFromSource(target, options()), /detached HEAD/);
  assert.equal(existsSync(join(source, ".git/FETCH_HEAD")), false);
  assert.deepEqual(calls, []);
});

test("consent binding notices source HEAD and remote metadata even with a separate target", () => {
  const expectedSourceSnapshot = sourceUpdateSnapshot(target, options());
  assert.ok(previewSourceUpdate(target, options()).includes(expectedSourceSnapshot));
  write(source, "saved-work", "a local commit after preview");
  commit(source, "new local HEAD");
  assert.throws(() => updateFromSource(target, { ...options(), expectedSourceSnapshot }), /동의 미리보기 이후/);
  const next = sourceUpdateSnapshot(target, options());
  git(source, "remote", "set-url", "origin", join(root, "changed.git"));
  assert.notEqual(sourceUpdateSnapshot(target, options()), next);
  assert.throws(() => updateFromSource(target, { ...options(), expectedSourceSnapshot: next }), /동의 미리보기 이후/);
  assert.equal(existsSync(join(source, ".git/FETCH_HEAD")), false);
  assert.deepEqual(calls, []);
});

test("divergence discovered by fetch does not pull, install or build", () => {
  write(source, "local-commit", "keep this commit");
  commit(source, "local change");
  const before = git(source, "rev-parse", "HEAD");
  publish("new");
  assert.throws(() => updateFromSource(target, options()), /diverged/);
  assert.equal(git(source, "rev-parse", "HEAD"), before);
  assert.equal(readFileSync(join(source, "template/value"), "utf8"), "template old");
  assert.deepEqual(calls, []);
  const fetch = readFileSync(join(source, ".git/FETCH_HEAD"), "utf8");
  assert.throws(() => updateFromSource(target, options()), /diverged/);
  assert.equal(readFileSync(join(source, ".git/FETCH_HEAD"), "utf8"), fetch);
});

test("unsupported installs report their real action and never use a target repository as source", () => {
  assert.match(previewSourceUpdate(target, { packaged: true }), /설치 유형: binary/);
  assert.throws(() => updateFromSource(target, { packaged: true }), /새 실행 파일/);
  const pkg = join(target, "node_modules/code-agent");
  mkdirSync(pkg, { recursive: true });
  const preview = previewSourceUpdate(target, { sourceRoot: pkg });
  assert.match(preview, /설치 유형: npm-package/);
  assert.match(preview, /기존 설치에 사용한 패키지 관리자/);
  assert.throws(() => updateFromSource(target, { sourceRoot: pkg }), /npm 패키지 설치/);
  const archive = join(root, "archive");
  mkdirSync(archive);
  assert.match(previewSourceUpdate(target, { sourceRoot: archive }), /설치 유형: non-git/);
});

test("missing lock and interrupted Git operations stop locally", () => {
  write(source, ".git/MERGE_HEAD", git(source, "rev-parse", "HEAD"));
  assert.throws(() => updateFromSource(target, options()), /진행 중인 Git 작업/);
  rmSync(join(source, ".git/MERGE_HEAD"));
  git(source, "rm", "package-lock.json");
  commit(source, "remove lock");
  assert.throws(() => updateFromSource(target, options()), /잠금 파일/);
  assert.equal(existsSync(join(source, ".git/FETCH_HEAD")), false);
});

test("ci/build failures preserve pulled source and stop before applying templates", () => {
  publish("new");
  for (const step of ["ci", "run"]) {
    calls = [];
    assert.throws(() => updateFromSource(target, {
      ...options(), runNpm(args) {
        calls.push([...args]);
        if (args[0] === step) throw new Error(`${step} failed`);
      },
    }), new RegExp(`${step} failed`));
    assert.equal(git(source, "rev-parse", "HEAD"), git(seed, "rev-parse", "HEAD"));
    assert.equal(existsSync(join(target, "installed-template")), false);
    assert.deepEqual(calls, step === "ci" ? [["ci", "--include=dev"]] : [["ci", "--include=dev"], ["run", "build"]]);
  }
});

test("doctor failure reports that template application already completed", () => {
  publish("new", 1);
  assert.throws(() => updateFromSource(target, options()), /템플릿 적용 완료 후 점검[\s\S]*doctor new: failed/);
  assert.equal(readFileSync(join(target, "installed-version"), "utf8"), "new");
});

test("real npm ci (offline), prepare and build work with paths containing spaces", () => {
  publish("new");
  const report = updateFromSource(target, { sourceRoot: source });
  assert.match(report, /npm ci --include=dev/);
  assert.match(report, /prepare/);
  assert.match(report, /doctor new: ok/);
});

test("Git worktree installations are detected through their own root", () => {
  const worktree = join(root, "linked source");
  git(source, "worktree", "add", "-b", "linked", worktree, "main");
  git(worktree, "branch", "--set-upstream-to=origin/main");
  publish("new");
  updateFromSource(target, { sourceRoot: worktree, runNpm(args, cwd) {
    if (args[0] === "ci") installed(cwd);
    else {
      mkdirSync(join(cwd, "dist/agent"), { recursive: true });
      cpSync(join(cwd, "cli-entry.js"), join(cwd, "dist/agent/cli.js"));
    }
  } });
  assert.equal(git(worktree, "rev-parse", "HEAD"), git(seed, "rev-parse", "HEAD"));
  assert.notEqual(git(source, "rev-parse", "HEAD"), git(seed, "rev-parse", "HEAD"));
});
