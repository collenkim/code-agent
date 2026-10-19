import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createStageRepo, removeStageRepo, repo, toCheck } from "./stageFixture";
import { initialize } from "../agent/init";
import { execution } from "../agent/executionCommands";
import { executionPolicy } from "../agent/executionMode";
import { handoffView } from "../agent/executionHandoff";
import { CODEX_MARKERS } from "../agent/crossEnv";
import { withInteraction } from "../agent/tty";
import { loadWork } from "../agent/work";
import { leaseGuard, readLease, releaseLease } from "../agent/lease";
import { questionsFile } from "../agent/layout";
import { synchronizeInteractions } from "../agent/interactionSources";
import { writeRunRecord } from "../agent/master/store";
import { hostProfileOf } from "../agent/master/protocol";
import { PublishInteraction } from "../agent/interactionSchema";
import { publishInteraction, interactionContext, currentInteractions, mutateInteractions, bumpInteraction } from "../agent/interactions";
import { prepareConsent } from "../agent/consent";
import { crossEnabled } from "../agent/hosts";
let saved: NodeJS.ProcessEnv;
beforeEach(() => { saved = { ...process.env }; delete process.env.CLAUDECODE; for (const key of CODEX_MARKERS) delete process.env[key]; createStageRepo("ca-handoff-"); initialize(repo); execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" }); execFileSync("git", ["commit", "-qm", "test installation"], { cwd: repo, stdio: "ignore" }); });
afterEach(() => { process.env = saved; removeStageRepo(); });
const tty = <T>(fn: () => T, confirm = () => {}) => withInteraction({ confirm: () => { confirm(); return { channel: "tty", verified: true, detail: "fixture" }; }, ask: () => "" }, fn);
const publish = (key = "q") => publishInteraction(repo, PublishInteraction.parse({ key, stage: "implementation", title: "선택할 조건", questions: [{ questionId: "q", title: "조건", mode: "text", input: { required: true, minLength: 1, maxLength: 100, description: "조건 입력" }, recommendationReason: "사용자가 조건을 정합니다" }] }), interactionContext(repo, "old-session", "claude"));

test("인계는 기존 작업·종류·계획을 유지하고 미응답만 닫아 임대를 넘긴다", () => {
  toCheck();
  const before = loadWork(repo)!; leaseGuard(before, "claude", "old-session"); const question = publish();
  const snapshot = handoffView(repo);
  assert.equal(snapshot.workId, before.active.id); assert.equal(snapshot.kind, before.order.kind);
  assert.throws(() => tty(() => execution(repo, "codex")), /--handoff/);
  const result = tty(() => execution(repo, "codex", { handoff: true }));
  assert.match(result, /인계 완료/); assert.ok(readLease(repo)?.released);
  assert.equal(currentInteractions(repo).requests.find(r => r.requestId === question.requestId)?.status, "cancelled");
  const after = loadWork(repo)!; assert.deepEqual(after.active, before.active); assert.deepEqual(after.plan, before.plan); assert.equal(after.order.kind, before.order.kind);
  assert.equal(leaseGuard(after, "codex", "new-session"), undefined); assert.equal(readLease(repo)?.session, "new-session");
  assert.match(leaseGuard(after, "claude", "old-session")!, /진행/);
});
test("미소비 답과 열린 동의는 인계를 막고 원장을 유지한다", () => {
  const q = publish();
  mutateInteractions(repo, state => { const r = state.requests[q.requestId]; r.status = "responded"; r.response = { receiptId: "fixture", commandId: "fixture", channel: "codex-elicitation", at: new Date().toISOString(), submission: { intent: "submit", explicit: true, answers: [] } }; bumpInteraction(state, r); });
  assert.throws(() => tty(() => execution(repo, "codex", { handoff: true })), /소비·적용/);
  assert.equal(currentInteractions(repo).requests[0].status, "responded"); assert.equal(executionPolicy(repo)?.mode, "auto");
  const consent = JSON.parse(prepareConsent(repo, { action: "docs" }, { binding: { id: "old-session", host: "claude" } }));
  assert.ok(handoffView(repo).blockers.some(line => line.includes(consent.id)));
});
test("확인 중 도착한 질문·실행 상태 변경은 인계하지 않는다", () => {
  publish();
  assert.throws(() => tty(() => execution(repo, "codex", { handoff: true }), () => { publish("late"); }), /상태가 바뀌었습니다/);
  assert.equal(executionPolicy(repo)?.mode, "auto"); assert.equal(currentInteractions(repo).requests.filter(r => r.status === "pending").length, 2);
});
test("교차 검증은 유지하면서 관리 실행의 주 호스트를 선택한다", () => {
  tty(() => execution(repo, "both", { main: "codex", handoff: true }));
  assert.deepEqual(executionPolicy(repo), { version: 1, mode: "both", main: "codex" }); assert.equal(crossEnabled(repo), true);
  assert.equal(JSON.parse(execution(repo, undefined, { json: true })).policy.main, "codex");
  assert.throws(() => execution(repo, "claude", { main: "codex" }));
  writeFileSync(join(repo, ".code-agent/execution.json"), JSON.stringify({ version: 1, mode: "both", main: "invalid" })); assert.throws(() => executionPolicy(repo));
});

test("인계 뒤 질문 문서는 해제된 임대나 미확인 thread에 묶이지 않는다", () => {
  toCheck();
  const work = loadWork(repo)!; leaseGuard(work, "claude", "old-session"); releaseLease(repo);
  writeFileSync(join(repo, questionsFile(work.active.id)), "# 질문\n\n## Q1 조건\n[Answer]:\n[Status]: open\n");
  synchronizeInteractions(repo); assert.equal(currentInteractions(repo).requests.length, 0);
  const at = new Date().toISOString();
  const run = { version: 1 as const, runId: "run-new", commandId: "cmd-new", controller: "fixture", generation: 1, mode: "start" as const, links: {}, state: "running" as const,
    acceptedAt: at, updatedAt: at, sessionId: "alias", sessionConfirmed: false, hostProfile: hostProfileOf({ kind: "codex" }), promptHash: "fixture", timeoutMs: 60000,
    workId: work.active.id, baseHead: null, baseStateVersion: "fixture", history: [] };
  writeRunRecord(repo, run); synchronizeInteractions(repo); assert.equal(currentInteractions(repo).requests.length, 0);
  writeRunRecord(repo, { ...run, sessionId: "confirmed-thread", sessionConfirmed: true }); synchronizeInteractions(repo);
  const questions = currentInteractions(repo).requests; assert.equal(questions.length, 1);
  assert.equal(questions[0].context.host, "codex"); assert.equal(questions[0].context.sessionId, "confirmed-thread"); assert.equal(questions[0].context.runId, run.runId);
});
