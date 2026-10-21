import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
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
import { listRuns, readRun, readWorkBinding, writeRunRecord, writeWorkBinding } from "../agent/master/store";
import { hostProfileOf, TERMINAL_RUN_STATES } from "../agent/master/protocol";
import { masterEnable } from "../agent/master/admin";
import { call } from "../agent/master/control";
import { liveness, killVerified } from "../agent/master/processes";
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
test("master 가 실행 방식을 고른 작업은 사람의 인계가 그 작업의 선택을 바꾼다", () => {
  toCheck();
  const work = loadWork(repo)!;
  writeWorkBinding(repo, { workId: work.active.id, links: {}, boundAt: "2026-10-21T00:00:00Z", runId: "run-chosen", controller: "m", runs: ["run-chosen"], execution: { mode: "both", main: "claude" } });
  assert.equal(crossEnabled(repo), true);
  tty(() => execution(repo, "codex", { handoff: true }));
  assert.deepEqual(readWorkBinding(repo, work.active.id)?.execution, { mode: "codex" }); assert.equal(crossEnabled(repo), false);
  assert.match(tty(() => execution(repo)), /master 요청에서 고른 실행 방식을 따릅니다: codex/);
});
test("이미 연 작업의 새 실행은 요청의 실행 방식 대신 작업에 고정된 방식으로 돌고 쓰지 않을 호스트의 준비는 보지 않는다", async () => {
  toCheck();
  const work = loadWork(repo)!, dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-handoff-master-")));
  // Codex 는 신뢰 기록이 없는 빈 CODEX_HOME — 이 작업이 Codex 준비를 보면 접수가 막힌다
  process.env.CODEX_HOME = dir;
  try {
    const hostFile = join(dir, "host.json"), tokenFile = join(dir, "token");
    writeFileSync(hostFile, JSON.stringify({ kind: "claude", command: [process.execPath, join(__dirname, "masterFakeHost.js")] }));
    tty(() => masterEnable(repo, { controller: "m", host: hostFile, tokenOut: tokenFile }));
    writeWorkBinding(repo, { workId: work.active.id, links: {}, boundAt: "2026-10-21T00:00:00Z", runId: "run-chosen", controller: "m", runs: ["run-chosen"], execution: { mode: "claude" } });
    const token = readFileSync(tokenFile, "utf8").trim();
    const accepted = call(repo, JSON.stringify({ protocol: "code-agent.master", version: 1, type: "submit", controller: "m", generation: 1, token, commandId: randomUUID(),
      payload: { prompt: "MODE=complete", execution: { mode: "codex" } } })) as { ok: boolean; result?: { runId: string; hostKind: string; execution: unknown; workId: string } };
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(accepted.result!.hostKind, "claude"); assert.deepEqual(accepted.result!.execution, { mode: "claude" }); assert.equal(accepted.result!.workId, work.active.id);
    const until = Date.now() + 30000;
    while (Date.now() < until && !(TERMINAL_RUN_STATES as readonly string[]).includes(readRun(repo, accepted.result!.runId)?.state ?? "accepted")) await new Promise(r => setTimeout(r, 100));
    const run = readRun(repo, accepted.result!.runId)!;
    assert.equal(run.state, "completed", JSON.stringify(run.outcome)); assert.equal(run.hostProfile?.kind, "claude"); assert.deepEqual(run.execution, { mode: "claude" });
    assert.deepEqual(readWorkBinding(repo, work.active.id)?.execution, { mode: "claude" }); assert.equal(executionPolicy(repo)?.mode, "auto");
  } finally {
    for (const run of listRuns(repo)) for (const p of [run.host, run.supervisor]) if (p && liveness(p.pid, p.marker) === "alive") killVerified(p.pid, p.marker);
    rmSync(dir, { recursive: true, force: true });
  }
});
