import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { pendingBaselineFiles, setupBaseline } from "../agent/bootstrap";
import { confirmDoc, docsBegin, docsEnd } from "../agent/docsCommands";
import { outsideChanges } from "../agent/evidence";
import { init } from "../agent/init";
import { loadActive } from "../agent/layout";
import { setupProject } from "../agent/setup";
import * as tty from "../agent/tty";
import { loadWork } from "../agent/work";
import { start } from "./confirmedStart";

let root: string;
function git(...args: string[]): string { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim(); }
function write(file: string, text: string): void { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); }
const spec = "doc/work/ADOPT-1/requirement.md";
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-adoption-")));
  git("init", "-q", "-b", "master"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.invalid");
  write(".gitignore", "doc/\n"); git("add", ".gitignore"); git("commit", "-qm", "existing repository");
  init(root, { host: "both" });
  docsBegin(root); setupProject(root, "node"); docsEnd(root);
  mock.method(tty, "confirmOnTerminal", () => ({ channel: "tty", verified: true, detail: "automated fixture" }));
  confirmDoc(root, "all");
  write(spec, "---\nkind: feature\nid: ADOPT-1\ntitle: 도입 검증\ntarget: value\n---\n값을 반환한다.\n");
});
afterEach(() => {
  mock.restoreAll();
  const target = resolve(root), temporary = realpathSync.native(tmpdir());
  assert.ok(target.startsWith(temporary + sep) && target.slice(temporary.length + 1).startsWith("ca-adoption-"));
  rmSync(target, { recursive: true, force: true });
});

test("H1: 기존 저장소의 미커밋 도입은 시작 전에 안내하고 준비 커밋 뒤 양쪽 호스트 파일을 기준으로 삼는다", () => {
  const original = git("rev-parse", "HEAD");
  assert.throws(() => start(root, join(root, spec)), /도입 파일.*준비 커밋/);
  assert.equal(git("branch", "--show-current"), "master");
  assert.equal(loadActive(root), undefined);
  write("src/unrelated.js", "do not commit\n");
  assert.match(setupBaseline(root), /도입 커밋/);
  assert.equal(git("rev-parse", "HEAD^"), original);
  assert.equal(git("ls-tree", "--name-only", "HEAD", "src/unrelated.js", spec), "");
  for (const file of ["code-agent.json", ".claude/settings.json", ".codex/hooks.json", "AGENTS.md", "doc/architecture.md"]) {
    assert.ok(git("ls-tree", "--name-only", "HEAD", file).includes(file));
  }
  assert.deepEqual(pendingBaselineFiles(root), []);
  start(root, join(root, spec));
  assert.deepEqual(outsideChanges(loadWork(root)!).map(change => change.path), ["src/unrelated.js"]);
  // 도입 파일을 영구 예외로 두지 않는다. 시작 뒤 변경은 계속 계획 밖으로 검출한다.
  write(".claude/settings.json", readFileSync(join(root, ".claude/settings.json"), "utf8") + "\n");
  assert.ok(outsideChanges(loadWork(root)!).some(change => change.path === ".claude/settings.json"));
});

test("H1: 도입 커밋 없는 기준/기존 작업 브랜치로 전환하지 않고 명시한 도입 브랜치에서는 시작한다", () => {
  git("switch", "-q", "-c", "adoption");
  setupBaseline(root);
  const head = git("rev-parse", "HEAD"), config = readFileSync(join(root, "code-agent.json"));
  assert.throws(() => start(root, join(root, spec)), /start --base/);
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(git("branch", "--show-current"), "adoption");
  assert.deepEqual(readFileSync(join(root, "code-agent.json")), config);
  assert.ok(existsSync(join(root, ".claude/settings.json")));
  start(root, join(root, spec), { base: "adoption" });
  assert.equal(git("branch", "--show-current"), "feature/ADOPT-1");
  assert.deepEqual(outsideChanges(loadWork(root)!), []);
});

test("H1: 기존 작업 브랜치에 도입 파일이 없으면 기준에 있어도 전환 전에 멈춘다", () => {
  git("branch", "feature/ADOPT-1");
  setupBaseline(root);
  assert.throws(() => start(root, join(root, spec)), /작업 브랜치.*반영되지/);
  assert.equal(git("branch", "--show-current"), "master");
  assert.ok(existsSync(join(root, "code-agent.json")));
});

test("H1: 준비 확인 중 브랜치가 바뀌면 기존 저장소에도 커밋하지 않는다", () => {
  mock.method(tty, "confirmOnTerminal", () => {
    git("switch", "-q", "-c", "other");
    return { channel: "tty", verified: true, detail: "fixture" };
  });
  assert.throws(() => setupBaseline(root), /확인 중 Git 상태/);
  assert.equal(git("rev-list", "--count", "HEAD"), "1");
  assert.equal(git("diff", "--cached", "--name-only"), "");
});
