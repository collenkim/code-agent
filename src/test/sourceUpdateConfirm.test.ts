import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { CODEX_MARKERS } from "../agent/crossEnv";
import { HOST_SHELL_UPDATE, updateFromSourceConfirmed, updateConfirmationFile, sourceUpdateSnapshot } from "../agent/sourceUpdate";
import { withInteraction } from "../agent/tty";

// LRN-5 — 직접 CLI 소스 업데이트는 미리보기를 보여 주고 터미널 확인을 받은 뒤에만 fetch 한다.
// 이 저장소를 소스로 쓰지 않도록 임시 upstream·설치본을 만든다(sourceUpdate.test.ts 와 같은 꼴, npm 은 부르지 않는다).
let root: string, remote: string, seed: string, source: string, target: string;
let savedEnv: Record<string, string | undefined>;
function write(base: string, file: string, value: string): void {
  mkdirSync(dirname(join(base, file)), { recursive: true });
  writeFileSync(join(base, file), value);
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "no-global-config") } }).trim();
}
function identity(cwd: string): void {
  for (const [key, value] of [["user.name", "t"], ["user.email", "t@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git(cwd, "config", key, value);
}
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-update-confirm-")));
  savedEnv = Object.fromEntries(["CODE_AGENT_HOME", "CODE_AGENT_RELEASE_HOME", "CLAUDECODE", ...CODEX_MARKERS].map(key => [key, process.env[key]]));
  for (const key of Object.keys(savedEnv)) delete process.env[key];
  process.env.CODE_AGENT_HOME = join(root, "pc-store");
  process.env.CODE_AGENT_RELEASE_HOME = join(root, "releases");
  remote = join(root, "upstream.git"); seed = join(root, "publisher"); source = join(root, "source"); target = join(root, "project");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "clone", remote, seed);
  identity(seed);
  write(seed, ".gitignore", "node_modules/\ndist/\n");
  write(seed, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { build: "node build.js" } }));
  write(seed, "package-lock.json", JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0" } } }));
  write(seed, "build.js", "");
  git(seed, "add", "--all"); git(seed, "commit", "-m", "old"); git(seed, "push", "origin", "main");
  git(root, "clone", remote, source);
  identity(source);
  mkdirSync(target);
  git(target, "init", "--initial-branch=main");
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
});

test("터미널 확인 기록은 tty·확인자·확인한 해시를 설치 전에 남긴다", () => {
  const shownHash = `sha256:${sourceUpdateSnapshot(target, { sourceRoot: source })}`;
  withInteraction({ confirm(shown, word) {
    assert.equal(word, "update");
    assert.ok(shown.includes(shownHash.slice(7)));
    return { channel: "tty", verified: true, detail: "test terminal" };
  }, ask() { throw new Error("unexpected ask"); } }, () => {
    assert.throws(() => updateFromSourceConfirmed(target, { sourceRoot: source, runNpm() { throw new Error("fixture install stop"); } }), /fixture install stop/);
  });
  const record = JSON.parse(readFileSync(updateConfirmationFile(), "utf8"));
  assert.equal(record.createdBy.channel, "tty");
  assert.equal(record.createdBy.shownHash, shownHash);
  assert.equal(typeof record.createdBy.actor, "string");
});

test("터미널 확인 중 upstream이 바뀌면 확인 기록도 fetch도 남기지 않는다", () => {
  withInteraction({ confirm() {
    git(source, "remote", "set-url", "origin", join(root, "different.git"));
    return { channel: "tty", verified: true, detail: "test terminal" };
  }, ask() { throw new Error("unexpected ask"); } }, () => {
    assert.throws(() => updateFromSourceConfirmed(target, { sourceRoot: source }), /stale-state/);
  });
  assert.equal(existsSync(updateConfirmationFile()), false);
  assert.equal(existsSync(join(source, ".git/FETCH_HEAD")), false);
});

test("T-L5-2 비TTY 의 직접 소스 업데이트는 확인 단계에서 멈추고 fetch 하지 않는다", { skip: !!process.stdin.isTTY }, () => {
  let npm = 0;
  // 사람의 터미널(호스트 표지 없음)에서 부른 것으로 둔다 — 이 시험을 호스트 안에서 돌려도 확인 단계까지 간다
  const saved = Object.fromEntries(["CLAUDECODE", ...CODEX_MARKERS].map((key) => [key, process.env[key]]));
  for (const key of Object.keys(saved)) delete process.env[key];
  try {
    assert.throws(() => updateFromSourceConfirmed(target, { sourceRoot: source, runNpm: () => { npm++; } }), /터미널에서 받습니다/);
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  }
  assert.equal(existsSync(join(source, ".git/FETCH_HEAD")), false, "git fetch 가 돌지 않았다");
  assert.equal(npm, 0);
});

test("검토 #14 호스트 셸(표지 있음)의 직접 소스 업데이트는 TTY 여부와 관계없이 거부하고 fetch 하지 않는다", () => {
  const saved = process.env.CLAUDECODE;
  process.env.CLAUDECODE = "1";
  let npm = 0;
  try {
    assert.throws(() => updateFromSourceConfirmed(target, { sourceRoot: source, runNpm: () => { npm++; } }), (error: Error) => error.message === HOST_SHELL_UPDATE);
  } finally {
    if (saved === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = saved;
  }
  assert.equal(existsSync(join(source, ".git/FETCH_HEAD")), false);
  assert.equal(npm, 0);
});
