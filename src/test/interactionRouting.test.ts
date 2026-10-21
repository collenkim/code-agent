import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { setupConsentProject, writeFixture, gitFixture } from "./consentFixture";
import { observeAnswerEvent } from "../agent/answers";
import { observeNativeQuestion } from "../agent/interactionNative";
import { currentInteractions, mutateInteractions } from "../agent/interactions";
import { nativeAnswerWasObserved, publishHostInteraction, synchronizeInteractions } from "../agent/interactionSources";
import { askChoice } from "../agent/choiceServer";
import { issueInteractionTicket } from "../agent/interactionTicket";
import { interactionSummary } from "../agent/interactionSummary";

let root: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-question-routing-")));
  setupConsentProject(root);
});
afterEach(() => {
  assert.equal(dirname(resolve(root)), realpathSync.native(tmpdir()));
  assert.ok(root.includes("ca-question-routing-"));
  rmSync(root, { recursive: true, force: true });
});
const questions = [{ question: "Q14. 테넌트 형식을 고르세요", options: [{ label: "문자열" }, { label: "숫자" }] }];
const answers = { [questions[0].question]: "문자열" };
const event = () => ({ cwd: root, tool_name: "AskUserQuestion", session_id: "owner", tool_use_id: "tool-14", tool_input: { questions } });
function request() {
  writeFixture(root, ".code-agent/request-session.json", JSON.stringify({ id: "TASK-1", kind: "feature", startedAt: new Date().toISOString() }));
}
function observedLegacy() {
  request();
  observeNativeQuestion(root, { ...event(), hook_event_name: "PreToolUse" });
  observeAnswerEvent({ ...event(), hook_event_name: "PreToolUse" });
  observeAnswerEvent({ ...event(), hook_event_name: "PostToolUse", tool_input: { questions, answers }, tool_response: { questions, answers } });
  return currentInteractions(root).requests[0];
}

test("Claude가 Post input에 채운 답도 같은 Pre 호출의 실제 응답으로 기록한다", () => {
  observeNativeQuestion(root, { ...event(), hook_event_name: "PreToolUse" });
  observeNativeQuestion(root, { ...event(), hook_event_name: "PostToolUse", tool_input: { questions, answers }, tool_response: { questions, answers } });
  const r = currentInteractions(root).requests[0];
  assert.equal(r.status, "applied");
  assert.equal(r.response!.channel, "claude-question");
  assert.deepEqual(r.response!.submission.answers![0].optionIds, ["option-1"]);
  assert.deepEqual(interactionSummary(root).pending, []);
});

test("Pre에 미리 넣은 답·Pre 없는 Post·다른 질문의 Post로 응답을 만들지 않는다", () => {
  assert.throws(() => observeNativeQuestion(root, { ...event(), hook_event_name: "PreToolUse", tool_input: { questions, answers } }), /미리/);
  observeNativeQuestion(root, { ...event(), hook_event_name: "PostToolUse", tool_input: { questions, answers }, tool_response: { questions, answers } });
  assert.equal(currentInteractions(root).requests.length, 0);
  observeNativeQuestion(root, { ...event(), hook_event_name: "PreToolUse" });
  observeNativeQuestion(root, { ...event(), hook_event_name: "PostToolUse", tool_input: { questions: [{ ...questions[0], question: "다른 질문" }], answers }, tool_response: { questions, answers } });
  assert.equal(currentInteractions(root).requests[0].response, undefined);
});

test("Post input의 답만으로 응답을 만들지 않고 취소·빈 응답은 보류한다", () => {
  observeNativeQuestion(root, { ...event(), hook_event_name: "PreToolUse" });
  observeNativeQuestion(root, { ...event(), hook_event_name: "PostToolUse", tool_input: { questions, answers }, tool_response: {} });
  assert.equal(currentInteractions(root).requests[0].status, "deferred");
  assert.equal(currentInteractions(root).requests[0].response, undefined);
});

test("YSIJ-255: HEAD가 바뀌어도 관찰된 호스트 답의 낡은 대기만 닫고 응답·승인을 합성하지 않는다", () => {
  const before = observedLegacy();
  gitFixture(root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "new baseline");
  assert.equal(nativeAnswerWasObserved(root, before), true);
  synchronizeInteractions(root);
  const after = currentInteractions(root).requests[0];
  assert.equal(after.status, "superseded");
  assert.deepEqual(after.context, before.context);
  assert.equal(after.response, undefined); assert.equal(after.application, undefined);
  assert.deepEqual(interactionSummary(root).pending, []);
  const revision = after.revision;
  synchronizeInteractions(root);
  assert.equal(currentInteractions(root).requests[0].revision, revision);
});

test("낡은 대기 정리는 세션·호출·질문·선택지·작업과 사전 입력을 모두 대조한다", () => {
  const before = observedLegacy();
  for (const change of [
    (r: typeof before) => { r.context.sessionId = "other"; },
    (r: typeof before) => { r.nativeCallIds = ["other"]; },
    (r: typeof before) => { r.questions[0].title = "다른 질문"; },
    (r: typeof before) => { r.questions[0].options[0].label = "다른 선택지"; },
    (r: typeof before) => { r.context.workId = "OTHER"; },
    (r: typeof before) => { r.context.root = root + "-other"; },
  ]) {
    const altered = structuredClone(before); change(altered);
    assert.equal(nativeAnswerWasObserved(root, altered), false);
  }
  const { readAnswerRows } = require("../agent/answers") as typeof import("../agent/answers");
  const rows = readAnswerRows(root, "TASK-1");
  assert.equal(nativeAnswerWasObserved(root, before, rows.filter(r => r.type !== "answer")), false);
  assert.equal(nativeAnswerWasObserved(root, before, rows.map(r => r.type === "ask" ? { ...r, prefilled: true } : r)), false);
  mutateInteractions(root, state => {
    state.requests[before.requestId].response = { receiptId: "preserved", commandId: "received", at: new Date().toISOString(), channel: "dashboard-human", submission: { intent: "submit", explicit: true } };
  });
  synchronizeInteractions(root);
  assert.equal(currentInteractions(root).requests[0].status, "pending");
  assert.equal(currentInteractions(root).requests[0].response!.receiptId, "preserved");
});

const ask = { questions: [{ title: "Q1. 선택", options: ["첫째", "둘째"] }] };
const structured = { key: "policy", stage: "setup", title: "정책", questions: [{ questionId: "Q1", title: "선택", mode: "text", input: { required: true, minLength: 1, maxLength: 50, description: "답" }, recommendationReason: "사람 결정" }] };
const ticket = () => issueInteractionTicket(root, { sessionId: "owner", host: "codex", command: "mcp-ask" });
test("대시보드 없는 영속 발행은 대기 기록을 만들지 않고 호스트 선택 UI를 안내한다", async () => {
  assert.throws(() => publishHostInteraction(root, structured, { sessionId: "owner", host: "claude", command: "publish", at: Date.now() }), /사람 채널/);
  ticket();
  await assert.rejects(askChoice({ ...ask, interaction: structured }, async () => { assert.fail("대시보드 질문을 임의의 다른 폼으로 바꾸지 않는다"); }, root), /선택 UI/);
  assert.equal(currentInteractions(root).requests.length, 0);
});

test("단독 Codex는 UI를 호출하고 표시 실패 뒤 같은 질문을 재표시해 실제 답을 받는다", async () => {
  ticket();
  await assert.rejects(askChoice(ask, async () => { throw Error("transport"); }, root), /같은 질문/);
  const before = currentInteractions(root).requests[0];
  assert.equal(before.presentation!.state, "failed"); assert.equal(before.response, undefined);
  let shown = 0; ticket();
  const result = await askChoice(ask, async () => { shown++; return { action: "accept", content: { q1: "첫째" } }; }, root) as { status: string };
  assert.equal(shown, 1); assert.equal(result.status, "answered");
  const after = currentInteractions(root).requests[0];
  assert.equal(after.requestId, before.requestId); assert.equal(after.presentation, undefined);
  assert.equal(after.status, "applied");
});

test("미응답 질문 17개는 모든 묶음을 유지하며 반복 조회로 서로 폐기하지 않는다", () => {
  request();
  writeFixture(root, "doc/work/TASK-1/questions.md", "# 질문\n\n" + Array.from({ length: 17 }, (_, i) => `## Q${i + 1} 규칙\n[Answer]:\n\n`).join(""));
  synchronizeInteractions(root);
  const first = currentInteractions(root);
  assert.equal(first.requests.length, 2);
  assert.equal(first.requests.flatMap(r => r.questions).length, 17);
  synchronizeInteractions(root); synchronizeInteractions(root);
  assert.deepEqual(currentInteractions(root), first);
  assert.ok(first.requests.every(r => r.status === "pending"));
  writeFixture(root, "doc/work/TASK-1/questions.md", "# 질문\n\n" + Array.from({ length: 17 }, (_, i) => `## Q${i + 1} 규칙\n[Answer]:${i === 0 ? " 첫 답\n[Source]: 대화" : ""}\n\n`).join(""));
  synchronizeInteractions(root);
  const remaining = currentInteractions(root).requests.filter(r => r.status === "pending");
  assert.equal(remaining.length, 1);
  assert.deepEqual(remaining[0].questions.map(q => q.questionId), Array.from({ length: 16 }, (_, i) => `Q${i + 2}`));
  const refreshed = currentInteractions(root);
  synchronizeInteractions(root); assert.deepEqual(currentInteractions(root), refreshed);
});
