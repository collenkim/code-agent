import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { beforeEach, afterEach, test } from "node:test";
import { allCursors, branchCursorFile, checkoutBranch, currentCursor } from "../agent/branchCursor";
import { loadActive, saveActive, clearActive, type ActiveWork } from "../agent/layout";
import { decide } from "../agent/hook";
import { codexHook } from "../agent/codexHook";
import { docsBegin, docsEnd } from "../agent/docsCommands";
import { loadWork } from "../agent/work";
import { readLease, leaseGuard, releaseLease, type Lease } from "../agent/lease";
import { busyReasons } from "../agent/runtimeApply";
import { busyMarker } from "../agent/runtimeSelect";
import { workInProgress } from "../agent/models";
import { stateView } from "../agent/stateView";
import { init } from "../agent/init";
import { setupProject } from "../agent/setup";
import { requestBegin, clearRequestSession } from "../agent/request";
import { abort } from "../agent/commands";

let root: string;
const a: ActiveWork = { id: "A", target: "src", spec: "doc/work/A/requirement.md", phase: "implement", stage: "test", task: "T2", branch: "fix/A" };
const b: ActiveWork = { ...a, id: "B", branch: "feature/B" };
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
const shell = (command: string) => decide({ cwd: root, host: "codex", tool_name: "PowerShell", tool_input: { command } });
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-branch-")));
  git("init", "-q", "-b", "fix/A");
  git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "initial");
  mkdirSync(join(root, ".code-agent"));
  writeFileSync(join(root, ".code-agent/active.json"), JSON.stringify(a)); // 기존 설치의 커서
});
afterEach(() => {
  assert.ok(resolve(root).startsWith(realpathSync.native(tmpdir()) + sep + "ca-branch-"));
  rmSync(root, { recursive: true, force: true });
});

test("다른 브랜치에서는 설정 없는 기존 작업을 읽지 않고 hook·도입·접수가 동작한다", () => {
  const before = readFileSync(join(root, ".code-agent/active.json"), "utf8");
  git("switch", "-qc", "feature/B");
  assert.equal(loadWork(root), undefined);
  assert.equal(shell("code-agent.cmd docs begin"), undefined);
  assert.equal(shell("git status --short"), undefined);
  assert.deepEqual(codexHook({ cwd: root, hook_event_name: "PreToolUse", tool_name: "exec_command", tool_input: { cmd: "code-agent.cmd docs begin" } }), {});
  init(root, { host: "codex" });
  assert.equal(existsSync(join(root, "code-agent.json")), false);
  docsBegin(root);
  setupProject(root, "node");
  docsEnd(root);
  assert.ok(existsSync(join(root, "code-agent.json")));
  assert.doesNotThrow(() => requestBegin(root, "B", "feature"));
  clearRequestSession(root);
  assert.equal(readFileSync(join(root, ".code-agent/active.json"), "utf8"), before);
  assert.equal(allCursors(root)[0].id, "A");
});

test("같은 브랜치의 설정 누락·손상은 계속 차단하고 상태를 무시하지 않는다", () => {
  assert.match(shell("git status") ?? "", /code-agent.json/);
  assert.equal(shell("code-agent read code-agent.json"), undefined);
  writeFileSync(join(root, "code-agent.json"), "{broken");
  assert.match(shell("git status") ?? "", /읽지 못/);
  assert.throws(() => docsBegin(root), /작업이 진행 중/);
});

test("새 브랜치 저장 뒤 양쪽으로 복귀하면 각 Task·단계를 보존하고 현재 브랜치만 종료한다", () => {
  git("switch", "-qc", "feature/B");
  saveActive(root, b);
  assert.deepEqual(loadActive(root), b);
  git("switch", "fix/A");
  assert.deepEqual(loadActive(root), a);
  assert.equal(currentCursor(root)?.file, branchCursorFile("fix/A"));
  saveActive(root, { ...a, phase: "review" });
  git("switch", "feature/B");
  assert.deepEqual(loadActive(root), b);
  assert.match(abort(root), /B/);
  assert.equal(loadActive(root), undefined);
  git("switch", "fix/A");
  assert.equal(loadActive(root)?.phase, "review");
  clearActive(root);
  assert.deepEqual(allCursors(root), []);
});

test("다른 브랜치에서 clearActive는 기존 커서를 삭제하지 않는다", () => {
  git("switch", "-qc", "feature/B");
  clearActive(root);
  assert.deepEqual(allCursors(root), [a]);
});

test("보관된 작업만 남아도 버전·모델 변경 관문은 작업을 보호한다", () => {
  git("switch", "-qc", "feature/B"); saveActive(root, b); clearActive(root);
  assert.equal(loadActive(root), undefined);
  assert.ok(busyMarker(root)?.includes("branches/"));
  assert.ok(busyReasons(root).some(line => line.includes("작업 A")));
  assert.equal(workInProgress(root)?.id, "A");
  git("switch", "fix/A");
  assert.equal(stateView(root).files.active, branchCursorFile("fix/A"));
});

test("브랜치 전환 후에도 원래 작업의 세션 임대를 보존한다", () => {
  const lease: Lease = { version: 1, id: "A", target: "src", host: "claude", session: "owner-A", claimedAt: new Date().toISOString(), seenAt: new Date().toISOString() };
  writeFileSync(join(root, ".code-agent/lease.json"), JSON.stringify(lease));
  git("switch", "-qc", "feature/B");
  assert.match(releaseLease(root), /다른 브랜치의 임대는 유지/);
  saveActive(root, b);
  assert.equal(readLease(root), undefined);
  git("switch", "fix/A");
  assert.deepEqual(readLease(root), lease);
  assert.match(leaseGuard({ repoRoot: root, active: a } as Parameters<typeof leaseGuard>[0], "codex", "other") ?? "", /다른 세션/);
  saveActive(root, a);
  assert.deepEqual(readLease(root), lease);
  rmSync(join(root, ".code-agent/lease.json"));
  git("switch", "feature/B"); saveActive(root, b); git("switch", "fix/A");
  assert.equal(readLease(root), undefined, "기본 임대가 없으면 이전 보관 임대를 다시 살리지 않는다");
});

test("손상된 보관 커서·브랜치 불일치는 거부하고 기존 기록을 덮지 않는다", () => {
  git("switch", "-qc", "feature/B"); saveActive(root, b); git("switch", "fix/A");
  const file = join(root, branchCursorFile("fix/A"));
  writeFileSync(file, "{broken");
  assert.throws(() => loadActive(root));
  assert.match(shell("git status") ?? "", /읽지 못/);
  writeFileSync(file, JSON.stringify(b));
  assert.throws(() => loadActive(root), /브랜치가 경로와 다릅니다/);
  assert.throws(() => saveActive(root, b), /현재 브랜치와 다릅니다/);
});

test("브랜치 이름은 해시 경로로 보관하고 개인 상태는 Git 반영에서 제외한다", () => {
  git("switch", "-qc", "feature/B"); saveActive(root, b);
  assert.match(branchCursorFile("fix/A"), /^\.code-agent\/branches\/[a-f0-9]{64}\.json$/);
  assert.equal(git("check-ignore", branchCursorFile("fix/A")), branchCursorFile("fix/A"));
});

test("detached HEAD는 다른 브랜치로 보고 브랜치 오인 저장을 거부한다", () => {
  git("switch", "--detach");
  assert.equal(checkoutBranch(root), "");
  assert.equal(loadActive(root), undefined);
  assert.throws(() => saveActive(root, a), /현재 브랜치와 다릅니다/);
});

test("브랜치 없는 이전 커서는 기존 저장소 단위 동작을 유지한다", () => {
  const legacy = { ...a, branch: undefined };
  writeFileSync(join(root, ".code-agent/active.json"), JSON.stringify(legacy));
  git("switch", "-qc", "feature/B");
  assert.equal(loadActive(root)?.id, "A");
  assert.match(shell("git status") ?? "", /code-agent.json/);
});

test("Git worktree의 gitdir 포인터를 읽고 다른 checkout 상태와 분리한다", () => {
  const other = join(root, "other");
  git("worktree", "add", "-b", "feature/B", other);
  assert.equal(checkoutBranch(other), "feature/B");
  assert.equal(loadActive(other), undefined);
  saveActive(other, b);
  assert.deepEqual(loadActive(other), b);
  assert.deepEqual(loadActive(root), a);
});
