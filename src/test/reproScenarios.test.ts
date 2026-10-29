import { strict as assert } from "node:assert";
import { test } from "node:test";

import { REQUIREMENTS } from "./planningRepo";
import { runScenario } from "./reproScenarios";

/**
 * 재현 시나리오의 **지금 동작**을 고정한다 — 바라는 계약이 아니라 개선 전 기준선이다. 동작을 고치면 이 시험의 기대값을 그 변경과 함께 바꾸고,
 * 같은 시나리오를 `scripts/repro-baseline.cjs`로 전후 빌드에서 돌려 사실과 시간을 비교한다.
 */
test("요구 변경 재현 — 추가 요구만 든 같은 ID 초안이 확정한 요구를 대체하고, 무효화 원인을 남긴 뒤 다시 확정된다", () => {
  const { facts, timeline } = runScenario("amendment");
  assert.deepEqual(facts.after, facts.submitted);
  assert.equal(facts.keptPrevious, false);
  assert.deepEqual([facts.statusAfterSubmit, facts.warnedChanged, facts.reconfirmed], ["unconfirmed", true, "confirmed"]);
  const [work] = timeline;
  assert.equal(work.workId, "PLAN-1");
  assert.deepEqual(work.causes.map((cause) => [cause.type, cause.reason, cause.phase]), [["invalidated", "확정 뒤 요구사항 재제출 — 다시 확정해야 진행", "analysis"]]);
  assert.equal(work.counts["request.submitted"], 1);
});

test("요구 변경 재현 — 새 요구 ID 가 생겨도 다시 준비한 분석 배정은 옛 요구 ID 만 가진다", () => {
  const { facts } = runScenario("staleIds");
  assert.deepEqual(facts.sourceIds, ["REQ-1", "REQ-2"]);
  assert.deepEqual(facts.assignedAfter, ["REQ-1"]);
  assert.deepEqual(facts.assignedAfter, facts.assignedBefore);
});

test("완료 알림 → 후속 실행 정지 재현 — 격리 호스트에서 Stop 이 턴을 잇지 않아 사람 입력 뒤에야 다음 행동을 실행하고, 그 대기의 사유가 남는다", () => {
  const { facts, timeline, events } = runScenario("completionStall");
  assert.deepEqual(facts, {
    dispatched: "dispatch", stopWhileRunningBlocked: false, subagentStopExit: 0,
    stopAfterCompletionBlocked: false, humanInputNeeded: true, resumedAction: "ready-for-gate", gate: "passed",
  });
  const [work] = timeline;
  assert.equal(work.workId, "PLAN-1");
  const [wait] = work.waits;
  assert.equal(work.waits.length, 1);
  assert.deepEqual([wait.category, wait.reason, wait.taskId, wait.phase, wait.stopped, wait.human, wait.closedBy, wait.open],
    ["host-resume", "담당 완료(completed) 뒤 다음 행동 대기", "analysis", "analysis", true, true, "host.tool", false]);
  assert.match(wait.dispatchId!, /^[0-9a-f-]{36}$/);
  assert.deepEqual([work.categories.agent.count, work.categories["host-resume"].count], [1, 1]);
  // 한 번의 advance 는 다음 행동 하나만 남긴다
  assert.deepEqual(events.filter((event) => event.type === "next.selected").map((event) => event.detail?.action), ["dispatch", "ready-for-gate"]);
  assert.deepEqual(events.filter((event) => event.type === "action.started").map((event) => event.detail?.command), ["planning advance --chain", "planning advance --chain"]);
  assert.deepEqual(events.filter((event) => event.type === "agent.assigned" || event.type === "agent.started" || event.type === "agent.finished")
    .map((event) => [event.type, event.taskId, event.dispatchId]), ["agent.assigned", "agent.started", "agent.finished"].map((type) => [type, "analysis", wait.dispatchId]));
  assert.ok(events.every((event) => event.eventId && event.runtime && event.workId === "PLAN-1"));
  assert.equal(new Set(events.map((event) => event.eventId)).size, events.length);
  // 담당 결과·메인 응답 본문은 기록하지 않는다
  const raw = JSON.stringify(events);
  for (const text of [REQUIREMENTS.split("\n")[0], "재현 담당 완료", "분석 담당이 완료되었습니다", "계속 진행해"]) assert.ok(!raw.includes(text), text);
});
