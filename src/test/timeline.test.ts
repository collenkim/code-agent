import { strict as assert } from "node:assert";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { readTimeline, recordEvent, runtimeLabel, summarizeByWork, summarizeTimeline, TIMELINE_LOG, type HostMark, type TimelineEvent } from "../agent/timeline";
import { usage } from "../agent/usage";

/** 실행 타임라인 — 덧붙이기 기록과 구간 요약(분류·겹침·대기 사유). 재현 시나리오의 실제 hook·CLI 기록은 reproScenarios.test 가 본다 */
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const at = (second: number) => new Date(T0 + second * 1000).toISOString();
let serial = 0;
function ev(type: TimelineEvent["type"], second: number, extra: Partial<TimelineEvent> = {}): TimelineEvent {
  return { v: 1, eventId: `e${++serial}`, at: at(second), type, runtime: "test", workId: "W-1", phase: "analysis", ...extra };
}
const mark = (type: HostMark["type"], second: number, status?: string): HostMark => ({ at: at(second), type, ...(status ? { status } : {}) });
const SEC = 1000;

describe("구간 요약", () => {
  test("겹친 구간은 분류별 합집합과 우선순위 귀속으로 따로 세고, 귀속 합과 그 밖이 경과와 같다", () => {
    const summary = summarizeTimeline([
      ev("verify.started", 0, { detail: { run: "a", kind: "build", round: 1, logFile: "a.log" } }),
      ev("agent.started", 5, { session: "s", agent: "x", detail: { agentType: "ca-analyst" } }),
      ev("verify.ended", 10, { detail: { run: "a", outcome: "passed", durationMs: 10 * SEC, logFile: "a.log" } }),
      ev("agent.finished", 20, { session: "s", agent: "x", taskId: "analysis", dispatchId: "d-1", detail: { status: "completed" } }),
      ev("host.stopped", 22, { detail: { blocked: true } }),
      ev("host.stopped", 25, { detail: { blocked: false } }),
      ev("consent.requested", 30, { detail: { consent: "c1", action: "plan-approval" } }),
      ev("consent.answered", 45, { detail: { consent: "c1" } }),
    ], [mark("host.notified", 21, "completed"), mark("human.input", 40), mark("host.tool", 50)]);
    assert.equal(summary.wallMs, 50 * SEC);
    const ms = Object.fromEntries(Object.entries(summary.categories).map(([key, value]) => [key, [value.ms / SEC, value.exclusiveMs / SEC]]));
    assert.deepEqual(ms, { "build-test": [10, 10], agent: [15, 10], human: [15, 15], external: [0, 0], "host-resume": [30, 15] });
    const exclusive = Object.values(summary.categories).reduce((sum, value) => sum + value.exclusiveMs, 0);
    assert.equal(exclusive + summary.otherMs, summary.wallMs, "겹친 시간을 전체 소요에 두 번 넣지 않는다");
    const resume = summary.waits.find((wait) => wait.category === "host-resume")!;
    assert.deepEqual([resume.reason, resume.taskId, resume.dispatchId, resume.stopped, resume.human, resume.closedBy, resume.durationMs],
      ["담당 완료(completed) 뒤 다음 행동 대기", "analysis", "d-1", true, true, "host.tool", 30 * SEC]);
    assert.deepEqual(summary.waits.find((wait) => wait.category === "human")!.reason, "동의 응답 대기: plan-approval");
    assert.deepEqual(summary.runs.map((run) => [run.run, run.outcome, run.durationMs]), [["a", "passed", 10 * SEC]]);
  });

  test("담당이 도는 동안 끝난 턴은 대기가 아니다 — 완료 뒤 대기가 턴 종료 상태로 시작한다", () => {
    const summary = summarizeTimeline([
      ev("agent.started", 0, { session: "s", agent: "x" }),
      ev("host.stopped", 1, { detail: { blocked: false } }),
      ev("agent.finished", 10, { session: "s", agent: "x", detail: { status: "completed" } }),
      ev("action.started", 15, { detail: { command: "planning advance" } }),
    ]);
    assert.deepEqual(summary.waits.map((wait) => [wait.category, wait.startedAt, wait.durationMs, wait.stopped, wait.closedBy]),
      [["host-resume", at(10), 5 * SEC, true, "action.started"]]);
    assert.equal(summary.categories.agent.ms, 10 * SEC);
  });

  test("사람이 터미널에서 친 명령은 대기를 닫지 않고 사람 개입으로 표시한다. 끝까지 열린 대기는 열림으로 센다", () => {
    const summary = summarizeTimeline([
      ev("agent.finished", 0, { detail: { status: "completed" } }),
      ev("action.started", 5, { detail: { command: "status", terminal: true } }),
      ev("action.ended", 8, { detail: { command: "status", exit: 0 } }),
    ]);
    const [wait] = summary.waits;
    assert.deepEqual([wait.open, wait.human, wait.durationMs], [true, true, 8 * SEC]);
    assert.equal(summary.categories["host-resume"].open, 1);
  });

  test("흐름의 사람 판단·외부 대기는 그 사유로 남고 다음 선택에서 닫힌다. 완료(done) 뒤 턴 종료는 대기가 아니다", () => {
    const summary = summarizeTimeline([
      ev("next.selected", 0, { detail: { source: "flow", kind: "human", action: "approve-plan" } }),
      ev("request.decided", 10),
      ev("next.selected", 10, { reason: "외부 리뷰 결과 대기", detail: { source: "flow", kind: "wait", action: "await-cross" } }),
      ev("next.selected", 30, { detail: { source: "flow", kind: "done", action: "done" } }),
      ev("host.stopped", 31, { detail: { blocked: false } }),
    ]);
    assert.deepEqual(summary.waits.map((wait) => [wait.category, wait.reason, wait.durationMs]),
      [["human", "사람 판단 대기: approve-plan", 10 * SEC], ["external", "외부 리뷰 결과 대기", 20 * SEC]]);
  });

  test("중복 완료는 구간을 바꾸지 않고, 무효화·재시도 사유를 순서대로 모은다. 작업마다 따로 요약한다", () => {
    const [first, second] = summarizeByWork([
      ev("agent.started", 0, { session: "s", agent: "x" }),
      ev("agent.finished", 10, { session: "s", agent: "x", detail: { status: "completed" } }),
      ev("agent.finished", 12, { session: "s", agent: "x", detail: { status: "duplicate", duplicate: true } }),
      ev("retry.used", 13, { taskId: "analysis", reason: "직전 시도 failed(agent-failure): 시간 초과" }),
      ev("invalidated", 14, { taskId: "analysis", reason: "입력 변경: 지시서" }),
      ev("request.received", 20, { workId: "W-2", runtime: "r2" }),
    ]);
    assert.deepEqual([first.workId, first.categories.agent.count, first.waits.length], ["W-1", 1, 1]);
    assert.deepEqual(first.causes.map((cause) => [cause.type, cause.reason]), [["retry.used", "직전 시도 failed(agent-failure): 시간 초과"], ["invalidated", "입력 변경: 지시서"]]);
    assert.deepEqual([second.workId, second.runtimes], ["W-2", ["r2"]]);
  });
});

describe("기록", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ca-timeline-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("code-agent 저장소에서만 덧붙인다 — 덮어쓰지 않고, 줄마다 eventId·런타임을 싣고, 사유는 한 줄로 자른다", () => {
    recordEvent(root, { type: "request.received" });
    assert.deepEqual(readTimeline(root), []);
    mkdirSync(join(root, ".code-agent"));
    recordEvent(root, { type: "request.received", workId: "W-1" });
    recordEvent(root, { type: "invalidated", workId: "W-1", reason: `첫 줄\n${"가".repeat(400)}` });
    appendFileSync(join(root, TIMELINE_LOG), "{\"v\":1,\"반쯤\n");
    recordEvent(root, { type: "retry.used", workId: "W-1", reason: "다음" });
    const events = readTimeline(root);
    assert.deepEqual(events.map((event) => event.type), ["request.received", "invalidated", "retry.used"]);
    assert.equal(new Set(events.map((event) => event.eventId)).size, 3);
    assert.ok(events.every((event) => event.runtime === runtimeLabel()));
    assert.equal(events[1].reason!.length, 300);
    assert.ok(!events[1].reason!.includes("\n"));
    assert.equal(readFileSync(join(root, TIMELINE_LOG), "utf8").split("\n").filter(Boolean).length, 4, "깨진 줄도 지우지 않는다");
  });

  test("usage 는 작업별 분류 시간과 긴 대기의 사유를 싣는다", () => {
    mkdirSync(join(root, ".code-agent"));
    recordEvent(root, { type: "agent.finished", workId: "W-1", phase: "analysis", taskId: "analysis", at: at(0), detail: { status: "completed" } });
    recordEvent(root, { type: "host.stopped", workId: "W-1", at: at(60), detail: { blocked: false } });
    recordEvent(root, { type: "action.started", workId: "W-1", at: at(1800), detail: { command: "planning advance" } });
    const text = usage(root);
    assert.match(text, /^실행 타임라인 /m);
    assert.match(text, /^ {2}W-1 · .* · 경과 30분 0초 · 런타임 /m);
    assert.match(text, /호스트 재개 대기 30분 0초\(30분 0초\)/);
    assert.match(text, /^ {6}- 호스트 재개 대기 30분 0초 · 담당 완료\(completed\) 뒤 다음 행동 대기 · 호스트 턴 종료 \[analysis · analysis\]/m);
  });
});
