import assert from "node:assert/strict";
import { test } from "node:test";
import { root, request, send } from "./dashboardFixture";
import { writeFixture } from "./consentFixture";
import { publishHostInteraction, synchronizeInteractions } from "../agent/interactionSources";
import { readInteractions } from "../agent/interactions";
import { interactionSummary } from "../agent/interactionSummary";
import { drainInteraction } from "../agent/interactionService";

function setup() {
  writeFixture(root, ".code-agent/request-session.json", JSON.stringify({ id: "TASK-1", kind: "feature", startedAt: new Date().toISOString() }));
  writeFixture(root, "doc/work/TASK-1/questions.md", "# 질문\n\n## Q1 규칙\n[Answer]:\n[Status]: open\n");
  writeFixture(root, ".code-agent/work/TASK-1/answers.jsonl", JSON.stringify({ type: "start", version: 1, at: new Date().toISOString(), intake: [] }) + "\n");
  return publishHostInteraction(root, { key: "doc-q", stage: "planning", source: "questions", title: "업무 규칙", questions: [{ questionId: "Q1", title: "규칙", mode: "text", input: { required: true, minLength: 1, maxLength: 2000, description: "업무 규칙" }, recommendationReason: "업무 판단 필요" }] }, { command: "publish", sessionId: "owner", host: "claude", at: Date.now() });
}
test("원래 문서에서 답한 질문의 낡은 미응답 화면은 닫고 승인·대시보드 답을 만들지 않는다", () => {
  const r = setup();
  writeFixture(root, "doc/work/TASK-1/questions.md", "# 질문\n\n## Q1 규칙\n[Answer]: 원래 채널의 답\n[Source]: 대화\n");
  synchronizeInteractions(root);
  const after = readInteractions(root)!.requests[r.requestId];
  assert.equal(after.status, "superseded"); assert.equal(after.response, undefined); assert.equal(after.application, undefined);
  assert.deepEqual(interactionSummary(root).pending, []);
});
test("이미 수신한 서명 답은 문서 변경으로 폐기하지 않고 적용의 문맥 검사에서 막는다", () => {
  const r = setup();
  assert.equal(send(request(r, { intent: "submit", explicit: true, answers: [{ questionId: "Q1", text: "서명 답" }] })).ok, true);
  const response = readInteractions(root)!.requests[r.requestId].response;
  writeFixture(root, "doc/work/TASK-1/questions.md", "# 질문\n\n## Q1 규칙\n[Answer]: 다른 답\n[Source]: 대화\n");
  synchronizeInteractions(root);
  assert.equal(readInteractions(root)!.requests[r.requestId].status, "responded");
  drainInteraction(root, r.requestId);
  const after = readInteractions(root)!.requests[r.requestId];
  assert.equal(after.status, "failed"); assert.deepEqual(after.response, response); assert.match(after.application!.error!, /문서가 바뀌었습니다/);
});
test("문서에서 질문을 지우거나 출처 미확인 답을 쓰는 것으로 미응답 대기를 없애지 못한다", () => {
  const r = setup();
  for (const text of ["# 질문\n", "# 질문\n\n## Q1 규칙\n[Answer]: 출처 없는 답\n"]) {
    writeFixture(root, "doc/work/TASK-1/questions.md", text); synchronizeInteractions(root);
    assert.equal(readInteractions(root)!.requests[r.requestId].status, "pending");
    assert.ok(interactionSummary(root).pending.includes(r.requestId));
  }
});
