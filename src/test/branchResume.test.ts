import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, afterEach, test } from "node:test";
import { createStageRepo, removeStageRepo, repo, toCheck, git } from "./stageFixture";
import { loadActive, saveActive } from "../agent/layout";
import { approvalOf, loadWork } from "../agent/work";
import { branchCursorFile } from "../agent/branchCursor";
import { next, start } from "../agent/commands";
import { consentSnapshot } from "../agent/consent";
import { stateView } from "../agent/stateView";
const ABORT = { action: "abort", decision: "accept", sendsCode: false } as const;

beforeEach(() => createStageRepo("ca-branch-resume-"));
afterEach(() => removeStageRepo());

test("승인된 작업 복귀는 승인·Task를 보존하고 기존 검증 게이트를 그대로 적용한다", () => {
  toCheck();
  const active = loadActive(repo)!;
  assert.equal(approvalOf(loadWork(repo)!).status, "approved");
  const consent = consentSnapshot(repo, ABORT);
  git("switch", "-c", "feature/other");
  assert.equal(loadWork(repo), undefined);
  assert.notEqual(consentSnapshot(repo, ABORT), consent, "같은 커밋이어도 브랜치가 바뀌면 동의 대상은 달라진다");
  saveActive(repo, { ...active, id: "OTHER", branch: "feature/other", phase: "analysis" });
  git("switch", active.branch!);
  assert.deepEqual(loadActive(repo), active);
  assert.equal(approvalOf(loadWork(repo)!).status, "approved");
  assert.throws(() => next(repo), /check|검증|통과/);
  assert.deepEqual(loadActive(repo), active);
  assert.equal(stateView(repo).files.active, branchCursorFile(active.branch!));
});

test("보관 커서는 동의 스냅샷에 포함하고 임대 갱신만 제외한다", () => {
  toCheck(); const active = loadActive(repo)!;
  git("switch", "-c", "feature/other");
  saveActive(repo, { ...active, id: "OTHER", branch: "feature/other" });
  git("switch", active.branch!);
  const file = join(repo, branchCursorFile(active.branch!));
  const before = consentSnapshot(repo, ABORT);
  writeFileSync(file.replace(/\.json$/, ".lease.json"), "{}");
  assert.equal(consentSnapshot(repo, ABORT), before);
  const original = readFileSync(file, "utf8");
  writeFileSync(file, JSON.stringify({ ...active, phase: "review" }));
  assert.notEqual(consentSnapshot(repo, ABORT), before);
  writeFileSync(file, original);
});

test("다른 브랜치에서 start로 기존 작업의 진행 단계를 초기화하지 않는다", () => {
  toCheck(); const active = loadActive(repo)!;
  git("switch", "-c", "feature/other");
  assert.throws(() => start(repo, join(repo, active.spec)), /보관되어 있습니다/);
  assert.equal(git("branch", "--show-current"), "feature/other");
  git("switch", active.branch!);
  assert.deepEqual(loadActive(repo), active);
});
