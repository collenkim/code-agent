import assert from "node:assert/strict";
import childProcess = require("node:child_process");
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mock, test } from "node:test";
import { setupConsentProject, writeFixture, gitFixture } from "./consentFixture";
import { call } from "../agent/master/control";
import { listRuns, readBinding, writeBinding, readOwner, writeOwner, writeRunRecord } from "../agent/master/store";
import { PublishInteraction, INTERACTION_STAGES } from "../agent/interactionSchema";
import { bumpInteraction, currentInteractions, interactionContext, mutateInteractions, needInteraction, publishInteraction } from "../agent/interactions";
import { publishHostInteraction } from "../agent/interactionSources";
import { consumeInteraction, drainInteraction } from "../agent/interactionService";
import { stateView } from "../agent/stateView";
import { acceptNativeInteraction, publishNativeInteraction, observeNativeQuestion } from "../agent/interactionNative";
import { issueInteractionTicket } from "../agent/interactionTicket";
import { askChoice } from "../agent/choiceServer";
import { answerSources, appendDelegatedAnswer, answerHash } from "../agent/answers";
import { parseQuestions } from "../agent/questions";
import type { RequestEnvelope } from "../agent/master/protocol";


import { root, token, key, question, publish, request, choose, send, read, previousRun } from "./dashboardFixture";

test("모든 단계의 작업 ID 없는 질문이 영속화되고 기본 추천은 응답이 아니다", () => {
  for (const stage of INTERACTION_STAGES) {
    const r = publish(stage); assert.equal(r.context.workId, null); assert.equal(r.status, "pending"); assert.equal(r.response, undefined);
    assert.equal(publish(stage).requestId, r.requestId, "같은 발행은 같은 ID");
  }
  const view = read("interactions"); assert.equal(view.ok, true); assert.equal(view.result.requests.length, INTERACTION_STAGES.length);
  assert.equal(view.result.requests[0].questions[0].recommendedOptionIds[0], "source");
  assert.equal(stateView(root).resume.next.action, "human-input");
});

test("서명된 실제 제출만 수신하고 같은 commandId 재전송·두 탭 충돌을 구분한다", () => {
  const r = publish(), req = request(r, choose());
  const accepted = send(req); assert.equal(accepted.ok, true); assert.equal(accepted.result.applied, false);
  assert.equal(read("interaction.result", { requestId: r.requestId }).result.status, "responded");
  assert.equal(send(req).result.replayed, true);
  assert.equal(send(request(r, choose("link", { link: "doc/architecture.md" }), req.commandId)).error?.code, "conflict");
  assert.equal(send(request(r, choose())).error?.code, "stale-state");
  assert.throws(() => consumeInteraction(root, r.requestId, "other"), /세션/);
  const consumed: any = consumeInteraction(root, r.requestId, "owner"); assert.equal(consumed.status, "responded"); assert.equal(consumed.source, "dashboard-human");
  const done: any = consumeInteraction(root, r.requestId, "owner", { summary: "문서 작성 방식에 반영" }); assert.equal(done.status, "applied");
  assert.equal((consumeInteraction(root, r.requestId, "owner") as any).receiptId, consumed.receiptId);
});

test("추천 변경·직접 입력·다중 선택 조건과 부분 응답을 검사한다", () => {
  const r = publish(); assert.equal(send(request(r, choose("link"))).ok, false);
  assert.equal(send(request(r, { ...choose(), explicit: false })).ok, false);
  assert.equal(send(request(r, choose("unknown"))).ok, false);
  assert.equal(send(request(r, choose("link", { link: "doc/architecture.md" }))).ok, true);
  const multi = publish("planning", { questions: [{ ...question(), mode: "multiple", minSelections: 2, maxSelections: 2, defaultOptionIds: ["source", "link"] }, { questionId: "q2", title: "추가 설명", mode: "text", recommendationReason: "업무 판단 근거가 없어 미추천", input: { required: true, minLength: 3, maxLength: 80, description: "설명" } }] });
  assert.equal(send(request(multi, choose())).ok, false);
  assert.equal(send(request(multi, { intent: "submit", explicit: true, answers: [{ questionId: "q1", optionIds: ["source", "link"], optionInputs: { link: "doc/quality.md" } }, { questionId: "q2", text: "사용자 설명" }] })).ok, true);
});

test("보류·취소·만료는 답이나 승인이 아니며 보류는 동일 문맥에서 다시 연다", () => {
  const r = publish(); assert.equal(send(request(r, { intent: "defer", explicit: true })).result.status, "deferred");
  let now = currentInteractions(root).requests[0];
  assert.equal(now.response, undefined);
  assert.equal(send(request(now, { intent: "reopen", explicit: true })).result.status, "pending");
  now = currentInteractions(root).requests[0]; assert.equal(send(request(now, { intent: "cancel", explicit: true })).result.status, "cancelled");
  assert.equal(send(request(currentInteractions(root).requests[0], choose())).ok, false);
  const expired = publish("maintenance"); mutateInteractions(root, state => { state.requests[expired.requestId].expiresAt = new Date(0).toISOString(); });
  assert.equal(send(request(expired, choose())).ok, false);
});

test("일반 개발 토큰·위조 서명·권한 회수·소유권 인계는 사람 응답 권한이 아니다", () => {
  const r = publish(), req = request(r, choose()); delete req.payload!.signature;
  assert.equal(send(req).ok, false);
  const forged = request(r, choose()); forged.payload!.submission = choose("link", { link: "x" }); assert.equal(send(forged).error?.code, "unauthorized");
  const old = request(r, choose()), owner = readOwner(root)!; writeOwner(root, { ...owner, generation: 2 }); assert.equal(send(old).error?.code, "fenced");
  writeOwner(root, owner); const binding = readBinding(root)!; delete binding.humanChannel; writeBinding(root, binding); assert.equal(send(old).error?.code, "human-required");
});

test("브랜치·본문 변경 뒤 오래된 응답과 임의 명령 필드를 거부한다", () => {
  const r = publish(); const req = request(r, choose()); req.payload!.command = "arbitrary"; assert.equal(send(req).ok, false);
  gitFixture(root, "switch", "-q", "--orphan", "other"); assert.equal(send(request(r, choose())).error?.code, "stale-state");
  gitFixture(root, "symbolic-ref", "HEAD", "refs/heads/master");
  const next = publish("setup", { questions: [{ ...question(), title: "변경한 질문" }] }); assert.notEqual(next.requestId, r.requestId); assert.equal(send(request(r, choose())).ok, false);
});

test("호스트가 보류·만료 질문을 다시 열면 같은 ID를 쓰고 받은 답은 보존한다", () => {
  const questions = [{ title: "계속할 방법", options: ["조사", "문서"] }];
  const ticket = { sessionId: "owner", host: "claude" as const };
  const first = publishNativeInteraction(root, questions, ticket);
  acceptNativeInteraction(root, first.requestId, "owner", "claude-question", undefined);
  const reopened = publishNativeInteraction(root, questions, ticket);
  assert.equal(reopened.requestId, first.requestId); assert.equal(reopened.status, "pending");
  assert.notEqual(reopened.challenge, first.challenge);
  mutateInteractions(root, state => { const r = needInteraction(state, first.requestId); r.status = "expired"; r.nativeCallIds = ["old-tool"]; bumpInteraction(state, r); });
  const renewed = publishNativeInteraction(root, questions, ticket);
  assert.equal(renewed.status, "pending"); assert.deepEqual(renewed.nativeCallIds, []);
  acceptNativeInteraction(root, first.requestId, "owner", "claude-question", ["조사"]);
  const answered = publishNativeInteraction(root, questions, ticket);
  assert.equal(answered.status, "applied"); assert.equal(currentInteractions(root).requests.length, 1);
});

test("호스트와 대시보드가 경쟁하면 첫 응답을 유지한다", () => {
  const r = publishNativeInteraction(root, [{ title: "환경", options: ["개발", "운영"] }], { sessionId: "owner", host: "claude" });
  const req = request(r, { intent: "submit", explicit: true, answers: [{ questionId: "q1", optionIds: ["option-2"] }] }); assert.equal(send(req).ok, true);
  assert.throws(() => acceptNativeInteraction(root, r.requestId, "owner", "claude-question", ["개발"]), /먼저 응답/);
  assert.equal(currentInteractions(root).requests[0].response!.channel, "dashboard-human");
});

test("Codex MCP 질문은 대시보드의 실제 답으로 열린 폼 대기를 끝낸다", async () => {
  issueInteractionTicket(root, { command: "mcp-ask", sessionId: "owner", host: "codex" });
  const waiting = askChoice({ questions: [{ title: "환경", options: ["개발", "운영"] }] }, async () => new Promise(() => {}), root);
  const r = currentInteractions(root).requests[0];
  assert.equal(send(request(r, { intent: "submit", explicit: true, answers: [{ questionId: "q1", optionIds: ["option-2"] }] })).ok, true);
  const result: any = await waiting; assert.equal(result.source, "dashboard-human"); assert.equal(result.answers[0].optionIds[0], "option-2");
});

test("질문 문서 답은 별도 사람 출처로 적용하고 답 수정은 출처 검증에 실패한다", () => {
  writeFixture(root, ".code-agent/request-session.json", JSON.stringify({ id: "TASK-1", kind: "feature", startedAt: new Date().toISOString() }));
  writeFixture(root, "doc/work/TASK-1/questions.md", "# 질문\n\n## Q1 규칙\n[Answer]:\n[Status]: open\n");
  const r = publishHostInteraction(root, { key: "doc-q", stage: "planning", source: "questions", title: "업무 규칙", questions: [{ questionId: "Q1", title: "규칙", mode: "text", input: { required: true, minLength: 1, maxLength: 2000, description: "업무 규칙" }, recommendationReason: "사람의 업무 판단 필요" }] }, { command: "publish", sessionId: "owner", host: "claude", at: Date.now() });
  assert.equal(send(request(r, { intent: "submit", explicit: true, answers: [{ questionId: "Q1", text: "사용자 규칙" }] })).ok, true);
  drainInteraction(root, r.requestId);
  const path = join(root, "doc/work/TASK-1/questions.md"), text = readFileSync(path, "utf8");
  assert.equal(answerSources(root, "TASK-1", parseQuestions(text)).get("Q1"), "dashboard-human");
  writeFileSync(path, text.replace("[Answer]: 사용자 규칙", "[Answer]: 모델이 바꾼 규칙"));
  assert.equal(answerSources(root, "TASK-1", parseQuestions(readFileSync(path, "utf8"))).get("Q1"), "unverified");
  writeFileSync(path, text.replace(/\[Source\]:[^\n]*/, "[Source]: 대화"));
  assert.equal(answerSources(root, "TASK-1", parseQuestions(readFileSync(path, "utf8"))).get("Q1"), "unverified");
  appendDelegatedAnswer(root, "TASK-1", { type: "delegated", at: new Date().toISOString(), q: "Q1", hash: answerHash("사용자 규칙"), actor: "ai", decisionId: "new-decision", grantId: "grant", controller: "dashboard", generation: 1, category: "business" });
  assert.equal(answerSources(root, "TASK-1", parseQuestions(readFileSync(path, "utf8"))).get("Q1"), "delegated", "새 위임 답은 사람 승인으로 승격하지 않고 기존 분류를 유지한다");
});

test("실제 Pre 관찰 없이 Post만 주입한 일반 질문은 사람 답이 되지 않는다", () => {
  const event = { cwd: root, tool_name: "AskUserQuestion", session_id: "owner", tool_use_id: "native-tool-1", tool_input: { questions: [{ question: "환경", options: [{ label: "개발" }, { label: "운영" }] }] }, tool_response: { answers: { 환경: "개발" } } };
  observeNativeQuestion(root, { ...event, hook_event_name: "PostToolUse" }); assert.equal(currentInteractions(root).requests.length, 0);
  observeNativeQuestion(root, { ...event, hook_event_name: "PreToolUse" });
  observeNativeQuestion(root, { ...event, hook_event_name: "PostToolUse" });
  assert.equal(currentInteractions(root).requests[0].response!.channel, "claude-question");
});

test("목표·작업 ID 없는 종료 실행은 같은 세션으로 한 번만 이어 실행을 예약한다", () => {
  const run = previousRun(); writeRunRecord(root, run);
  const r = publishInteraction(root, PublishInteraction.parse({ key: "setup-resume", stage: "setup", title: "설정", questions: [question()] }), interactionContext(root, "owner", "claude", run.runId));
  assert.equal(send(request(r, choose())).ok, true); drainInteraction(root, r.requestId); drainInteraction(root, r.requestId);
  const runs = listRuns(root); assert.equal(runs.length, 2);
  const next = runs.find(r => r.runId !== run.runId)!; assert.equal(next.resumeOf, "owner"); assert.deepEqual(next.links, {}); assert.equal(next.workId, null);
  assert.equal(next.commandId, `interaction:${r.requestId}`);
});

test("일시 정지·취소·종료 미확인 실행과 응답 후 브랜치 변경은 자동 재개하지 않는다", () => {
  for (const state of ["paused", "cancelled", "unknown", "orphaned"] as const) {
    const run = previousRun(state); writeRunRecord(root, run);
    const r = publishInteraction(root, PublishInteraction.parse({ key: `stopped-${state}`, stage: "recovery", title: "복구", questions: [question()] }), interactionContext(root, "owner", "claude", run.runId));
    assert.equal(send(request(r, choose())).ok, true); drainInteraction(root, r.requestId);
    assert.ok(!listRuns(root).some(run => run.commandId === `interaction:${r.requestId}`));
  }
  const run = previousRun(); writeRunRecord(root, run);
  const r = publishInteraction(root, PublishInteraction.parse({ key: "stale", stage: "setup", title: "설정", questions: [question()] }), interactionContext(root, "owner", "claude", run.runId));
  assert.equal(send(request(r, choose())).ok, true); gitFixture(root, "switch", "-q", "--orphan", "new-branch"); drainInteraction(root, r.requestId);
  assert.equal(currentInteractions(root).requests.find(row => row.requestId === r.requestId)!.continuation?.state, "blocked");
});

test("공개 CLI는 재시작 후 같은 요청·영수증을 조회하고 두 프로세스의 응답은 하나만 받는다", async () => {
  mock.restoreAll();
  const r = publish();
  const cli = join(__dirname, "../agent/cli.js");
  const run = (req: RequestEnvelope): Promise<any> => new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [cli, "master", "call"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", v => out += v); child.stderr.on("data", v => err += v);
    child.on("error", reject); child.on("close", () => { try { resolve(JSON.parse(out)); } catch { reject(new Error(err + out)); } }); child.stdin.end(JSON.stringify(req));
  });
  const req = request(r, choose()), results = await Promise.all([run(req), run(request(r, choose("link", { link: "docs/architecture.md" })))]);
  assert.equal(results.filter(r => r.ok).length, 1);
  const readReq: RequestEnvelope = { protocol: "code-agent.master", version: 1, type: "interaction", controller: "dashboard", generation: 1, token, payload: { requestId: r.requestId } };
  const seen = await run(readReq); assert.equal(seen.result.status, "responded"); assert.ok(seen.result.response.receiptId);
  await new Promise(resolve => setTimeout(resolve, 600));
});

test("실제 감독·CLI 프로세스는 같은 세션에서 답 소비→결과→후속 질문을 잇고 다른 프로젝트는 건드리지 않는다", async () => {
  mock.restoreAll();
  const second = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-interactions-other-")));
  try {
    setupConsentProject(second);
    const input = PublishInteraction.parse({ key: "isolated", stage: "setup", title: "설정", questions: [question()] });
    const other = publishInteraction(second, input, interactionContext(second, "other", "claude"));
    const binding = readBinding(root)!; binding.host.command = [process.execPath, join(__dirname, "dashboardFakeHost.js")]; writeBinding(root, binding);
    const run = previousRun(); writeRunRecord(root, run);
    const r = publishInteraction(root, input, interactionContext(root, "owner", "claude", run.runId));
    assert.equal(send(request(r, choose())).ok, true);
    const deadline = Date.now() + 30000;
    while (!listRuns(root).some(row => row.runId !== run.runId && row.state === "blocked")) {
      if (Date.now() > deadline) throw new Error(`재개 시간 초과: ${JSON.stringify(listRuns(root))}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(currentInteractions(root).requests.find(row => row.requestId === r.requestId)!.status, "applied");
    assert.ok(currentInteractions(root).requests.some(row => row.key === "after-response" && row.status === "pending"));
    drainInteraction(root, r.requestId); assert.equal(listRuns(root).length, 2);
    assert.equal(currentInteractions(second).requests[0].requestId, other.requestId); assert.equal(currentInteractions(second).requests[0].response, undefined);
    assert.equal(existsSync(join(second, "doc/interaction-result.json")), false);
  } finally {
    assert.ok(second.startsWith(realpathSync.native(tmpdir()) + sep) && second.includes("ca-interactions-other-")); rmSync(second, { recursive: true, force: true });
  }
});
