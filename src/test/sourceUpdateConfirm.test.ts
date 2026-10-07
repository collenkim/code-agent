import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { updateFromSourceConfirmed } from "../agent/sourceUpdate";

// LRN-5 — 직접 CLI 소스 업데이트는 미리보기를 보여 주고 터미널 확인을 받은 뒤에만 fetch 한다.
// 이 저장소를 소스로 쓰지 않도록 임시 upstream·설치본을 만든다(sourceUpdate.test.ts 와 같은 꼴, npm 은 부르지 않는다).
let root: string, remote: string, seed: string, source: string, target: string;
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
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("T-L5-2 비TTY 의 직접 소스 업데이트는 확인 단계에서 멈추고 fetch 하지 않는다", { skip: !!process.stdin.isTTY }, () => {
  let npm = 0;
  assert.throws(() => updateFromSourceConfirmed(target, { sourceRoot: source, runNpm: () => { npm++; } }), /터미널에서 받습니다/);
  assert.equal(existsSync(join(source, ".git/FETCH_HEAD")), false, "git fetch 가 돌지 않았다");
  assert.equal(npm, 0);
});
