import { strict as assert } from "node:assert";
import { test } from "node:test";

import { REQUIREMENTS } from "./planningRepo";
import { runScenario } from "./reproScenarios";

/**
 * 재현 시나리오의 **지금 동작**을 고정한다 — 고친 시나리오는 바라는 계약을, 아직 고치지 않은 시나리오는 개선 전 동작을 본다. 동작을 고치면 이 시험의 기대값을 그 변경과 함께 바꾸고,
 * 같은 시나리오를 `scripts/repro-baseline.cjs`로 전후 빌드에서 돌려 사실과 시간을 비교한다.
 */
test("요구 변경 재현 — 추가 요구만 든 전체 목록 초안은 확정 요구를 지우지 않고 거부하고, 변경안은 기존 요구를 보존한 새 개정으로 확정된다", () => {
  const { facts, timeline } = runScenario("amendment");
  assert.equal(facts.fullDraftRefused, true);
  assert.equal(facts.keptAfterRefusal, true);
  assert.deepEqual(facts.after, [...(facts.before as string[]), ...(facts.submitted as string[])]);
  assert.equal(facts.keptPrevious, true);
  assert.equal(facts.revision, (facts.parent as number) + 1);
  assert.deepEqual([facts.statusAfterSubmit, facts.proposalShown, facts.reconfirmed], ["unconfirmed", true, "confirmed"]);
  const [work] = timeline;
  assert.equal(work.workId, "PLAN-1");
  // 시드의 이전 형식 재확정과 변경안 확정은 분석 중이라 흐름을 되감지 않고 그 개정을 따른다
  assert.deepEqual(work.causes.map((cause) => [cause.type, cause.reason, cause.phase]), [
    ["revision.applied", "바뀐 요구 확정 — 분석 중 반영", "analysis"],
    ["invalidated", `요구 변경안 개정 ${facts.revision} 제출 — 확정해야 진행`, "analysis"],
    ["revision.applied", `요구 개정 ${facts.revision} 확정 — 분석 중 반영`, "analysis"],
  ]);
  assert.equal(work.counts["request.submitted"], 1);
});

test("요구 변경 재현 — 확정 요구에 새 요구 ID 가 생기면 다시 준비한 분석 배정이 지금 요구 ID 전부를 가진다", () => {
  const { facts } = runScenario("staleIds");
  assert.deepEqual(facts.sourceIds, ["REQ-1", "REQ-2"]);
  assert.deepEqual(facts.assignedBefore, ["REQ-1"]);
  assert.deepEqual(facts.assignedAfter, facts.sourceIds);
});

/** 격리 호스트에서 담당 완료 기록 → 다음 진행 명령 시작의 상한 — 자식 프로세스 셋(Stop 둘·advance 하나)의 기동 시간이다. 사람 입력을 기다리면 넘는다 */
const CONTINUATION_BOUND_MS = 20_000;

test("완료 알림 → 후속 실행 재현 — 격리 호스트에서 완료 뒤 끝나는 턴을 Stop 이 한 번 이어 사람 입력 없이 다음 행동을 실행하고, 중복 알림·재시작은 다시 막지 않는다", () => {
  const { facts, timeline, events } = runScenario("completionStall");
  assert.deepEqual(facts, {
    dispatched: "dispatch", stopWhileRunningBlocked: false, subagentStopExit: 0,
    stopAfterCompletionBlocked: true, nextNamed: true, continuedTurnBlocked: false, humanInputNeeded: false, resumedAction: "ready-for-gate", gate: "passed",
    duplicateStopExit: 0, stopAfterDuplicateBlocked: false, restartedStopBlocked: false,
  });
  const [work] = timeline;
  assert.equal(work.workId, "PLAN-1");
  // 완료 뒤 대기는 Stop 이 이은 턴의 다음 도구 호출이 닫는다 — 사람 입력이 아니다. 마지막 대기는 시나리오가 끝난 자리(게이트 통과 뒤)다
  const [wait, last] = work.waits;
  assert.equal(work.waits.length, 2);
  assert.deepEqual([wait.category, wait.reason, wait.taskId, wait.phase, wait.stopped, wait.human, wait.closedBy, wait.open],
    ["host-resume", "담당 완료(completed) 뒤 다음 행동 대기", "analysis", "analysis", true, undefined, "host.tool", false]);
  assert.deepEqual([last.reason, last.phase, last.open], ["호스트 턴 종료 뒤 재개 대기", "impact", true]);
  assert.ok(work.waits.every((item) => !item.human));
  assert.match(wait.dispatchId!, /^[0-9a-f-]{36}$/);
  assert.equal(events.filter((event) => event.type === "human.input").length, 0);
  // 완료 기록 → 다음 진행 명령 시작의 상한, 그 사이 막은 턴 끝은 하나
  const finishedAt = Date.parse(events.find((event) => event.type === "agent.finished")!.at);
  const resumed = events.filter((event) => event.type === "action.started")[1];
  assert.ok(Date.parse(resumed.at) - finishedAt <= CONTINUATION_BOUND_MS, `${Date.parse(resumed.at) - finishedAt}ms`);
  assert.equal(events.filter((event) => event.type === "host.stopped" && event.detail?.blocked === true && Date.parse(event.at) < Date.parse(resumed.at)).length, 1);
  // 한 번의 advance 는 다음 행동 하나만 남긴다. 중복 완료 알림은 다음 행동을 부르지 않는다
  assert.deepEqual(events.filter((event) => event.type === "next.selected").map((event) => event.detail?.action), ["dispatch", "ready-for-gate"]);
  assert.deepEqual(events.filter((event) => event.type === "action.started").map((event) => event.detail?.command), ["planning advance --chain", "planning advance --chain"]);
  assert.deepEqual(events.filter((event) => event.type === "agent.assigned" || event.type === "agent.started" || event.type === "agent.finished")
    .map((event) => [event.type, event.taskId, event.dispatchId, event.detail?.status]),
    [["agent.assigned", "analysis", wait.dispatchId, undefined], ["agent.started", "analysis", wait.dispatchId, undefined], ["agent.finished", "analysis", wait.dispatchId, "completed"], ["agent.finished", "analysis", wait.dispatchId, "duplicate"]]);
  assert.ok(events.every((event) => event.eventId && event.runtime && event.workId === "PLAN-1"));
  assert.equal(new Set(events.map((event) => event.eventId)).size, events.length);
  // 담당 결과·메인 응답 본문은 기록하지 않는다
  const raw = JSON.stringify(events);
  for (const text of [REQUIREMENTS.split("\n")[0], "재현 담당 완료", "분석 담당이 완료되었습니다", "계속 진행해"]) assert.ok(!raw.includes(text), text);
});
