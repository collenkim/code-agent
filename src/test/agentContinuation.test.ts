/**
 * 담당 완료 뒤 이어가기 — 담당 실행 장부(agentRuns)·구현 담당 hook(agent-event)·Stop hook 의 이어가기(continuation)·진행 명령의 소비.
 * 임시 git 저장소의 스테이지 픽스처에 hook 진입점(cli.js 자식 프로세스)과 판정 함수를 그대로 부른다.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { consumeCompletion, noteAgentFinished, noteAgentStarted, pendingCompletion, settleAgent, AGENT_RUNS_FILE } from "../agent/agentRuns";
import { next, requireValidatable, submitPlan } from "../agent/commands";
import { codexHook } from "../agent/codexHook";
import { CONSENT_INDEX } from "../agent/consentState";
import { CLAUDE_HOOKS, init } from "../agent/init";
import { loadActive } from "../agent/layout";
import { openRound } from "../agent/review";
import { observeReviewer, RecordedFailure } from "../agent/reviewHook";
import { hookFailureExit, hookFailureInput } from "../agent/retryPolicy";
import { sessionAnchor } from "../agent/sessionHook";
import { decideStop } from "../agent/stopHook";
import { withNotation } from "../agent/hostText";
import { readTimeline } from "../agent/timeline";
import { start } from "./confirmedStart";
import {
  approve, createStageRepo, DESIGN, FUNCTIONAL, IMPACT, PLAN, removeStageRepo, repo, REQUIREMENTS, TEST_SPEC, toReview, write,
} from "./stageFixture";

beforeEach(() => createStageRepo("ca-continue-"));
afterEach(() => removeStageRepo());

/** 격리 호스트 — 이 빌드의 CLI 진입점을 자식 프로세스로 부른다 */
function cli(args: string[], stdin?: object): { status: number | null; stdout: string; stderr: string } {
  const { NODE_TEST_CONTEXT: _parent, ...env } = process.env;
  const result = spawnSync(process.execPath, [join(__dirname, "..", "agent", "cli.js"), ...args], {
    cwd: repo, encoding: "utf8", windowsHide: true, input: stdin ? JSON.stringify(stdin) : "",
    env: { ...env, CLAUDE_PROJECT_DIR: repo, CODE_AGENT_HOST: "claude" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const stop = (session: string, extra: object = {}): string => {
  const out = cli(["stop"], { cwd: repo, session_id: session, hook_event_name: "Stop", last_assistant_message: "구현 담당이 끝났습니다.", ...extra }).stdout.trim();
  return out ? (JSON.parse(out) as { reason: string }).reason : "";
};
const implementer = (event: "SubagentStart" | "SubagentStop", agent = "impl-1", type = "ca-implementer") =>
  cli(["agent-event"], { cwd: repo, session_id: "s1", agent_id: agent, agent_type: type, hook_event_name: event });

/** 승인된 계획의 첫 구현 Task 에 세운다 */
function toImplement(): void {
  start(repo, join(repo, "doc/work/ORD-1.md"));
  write("doc/work/ORD-1/01-requirements.md", REQUIREMENTS);
  write("doc/work/ORD-1/02-analysis.md", IMPACT);
  write("doc/work/ORD-1/03-design.md", DESIGN);
  write("doc/work/ORD-1/04-functional.md", FUNCTIONAL);
  write("doc/work/ORD-1/07-test-spec.md", TEST_SPEC);
  next(repo);
  next(repo);
  next(repo);
  write("doc/work/ORD-1/plan.json", JSON.stringify(PLAN));
  submitPlan(repo, join(repo, "doc/work/ORD-1/plan.json"));
  approve();
  next(repo);
  assert.equal(loadActive(repo)!.phase, "implement");
}

describe("구현 담당 완료 뒤 이어가기", () => {
  test("완료 뒤 끝나는 턴을 한 번 이어 다음 명령을 알린다 — 실행 중·이어 붙인 턴·같은 완료의 두 번째 턴 끝은 막지 않고, 조회는 소비하지 않으며 진행 명령은 소비한다", () => {
    toImplement();
    assert.equal(implementer("SubagentStart").status, 0);
    assert.equal(stop("s1"), "", "담당이 실행 중이면 그 결과를 기다린다");
    assert.equal(implementer("SubagentStop").status, 0);
    const reason = stop("s1");
    assert.match(reason, /담당 완료가 기록됐습니다\(ca-implementer · completed · /);
    assert.match(reason, /\/ca-implement 절차의 담당 호출 다음 항목\(`code-agent next`/);
    assert.equal(stop("s1", { stop_hook_active: true }), "", "이어 붙인 턴은 놓아 준다");
    assert.equal(stop("s1"), "", "같은 완료로 같은 세션을 다시 막지 않는다");
    assert.match(stop("s2"), /담당 완료가 기록됐습니다/, "재시작한 세션은 처리하지 않은 완료를 한 번 잇는다");
    // 조회는 다음 행동이 아니다 — 완료를 지우지 않는다
    assert.equal(cli(["status"]).status, 0);
    assert.ok(pendingCompletion(repo, "ORD-1"));
    // 진행 명령은 결과(거부 포함)와 상관없이 완료를 처리한 것으로 본다
    cli(["next"]);
    assert.equal(pendingCompletion(repo, "ORD-1"), undefined);
    assert.equal(stop("s3"), "");
    const task = loadActive(repo)!.stage;
    assert.equal(task, "entity");
    const events = readTimeline(repo).filter((event) => event.type === "agent.started" || event.type === "agent.finished");
    assert.deepEqual(events.map((event) => [event.type, event.phase, event.taskId, event.agent, event.detail?.agentType]),
      [["agent.started", "implement", task, "impl-1", "ca-implementer"], ["agent.finished", "implement", task, "impl-1", "ca-implementer"]]);
  });

  test("병렬 담당은 모두 끝나야 잇고, 새 담당 시작은 앞 완료를 처리한 것으로 본다", () => {
    toImplement();
    implementer("SubagentStart", "impl-1");
    implementer("SubagentStart", "impl-2", "ca-tester");
    implementer("SubagentStop", "impl-1");
    assert.equal(pendingCompletion(repo, "ORD-1")?.running, 1);
    assert.equal(decideStop({ cwd: repo, session_id: "s1" }), undefined, "다른 담당이 실행 중이면 기다린다");
    implementer("SubagentStop", "impl-2", "ca-tester");
    assert.match(decideStop({ cwd: repo, session_id: "s1" }) ?? "", /ca-tester · completed/);
    implementer("SubagentStart", "impl-3");
    assert.equal(pendingCompletion(repo, "ORD-1"), undefined);
  });

  test("Codex 담당 이벤트도 장부에 남고 Codex Stop 이 Codex 표기로 잇는다", () => {
    toImplement();
    const event = { cwd: repo, session_id: "cs", agent_id: "c-1", agent_type: "ca_implementer" };
    codexHook({ ...event, hook_event_name: "SubagentStart" });
    codexHook({ ...event, hook_event_name: "SubagentStop", last_assistant_message: "끝" });
    assert.equal(pendingCompletion(repo, "ORD-1")?.completion.host, "codex");
    const out = withNotation("codex", () => codexHook({ cwd: repo, session_id: "cs", hook_event_name: "Stop" } as Parameters<typeof codexHook>[0])) as { decision?: string; reason?: string };
    assert.equal(out.decision, "block");
    assert.match(out.reason ?? "", /ca_implementer · completed/);
    assert.match(out.reason ?? "", /\$ca-implement 절차/);
  });
});

describe("사람 판단 자리", () => {
  const finish = (status: string) => noteAgentFinished(repo, "ORD-1", `a-${status}`, { source: "planning", type: "ca-analyst", status, phase: "analysis", advance: true });

  test("계획 담당 완료는 planning advance 로 잇고, 앞서 있던 답 없는 질문·열린 동의가 있으면 막지 않는다. 담당이 낸 질문(needs-input)은 잇는다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    finish("completed");
    assert.match(decideStop({ cwd: repo, session_id: "s1" }) ?? "", /`code-agent planning advance`/);
    write("doc/work/ORD-1/questions.md", "## Q1 · 범위\n어디까지 볼까?\n[Answer]:\n");
    assert.equal(decideStop({ cwd: repo, session_id: "s1" }), undefined, "사람의 답을 기다리는 자리");
    finish("needs-input");
    assert.match(decideStop({ cwd: repo, session_id: "s1" }) ?? "", /ca-analyst · needs-input/, "담당이 낸 질문은 advance 가 묻게 한다");
    mkdirSync(join(repo, CONSENT_INDEX, ".."), { recursive: true });
    writeFileSync(join(repo, CONSENT_INDEX), JSON.stringify({ version: 1, open: { "c-1": { action: "plan", status: "pending", createdAt: new Date().toISOString() } }, recent: {} }));
    assert.equal(decideStop({ cwd: repo, session_id: "s1" }), undefined, "응답·적용을 기다리는 동의");
  });

  test("세션 시작 요약이 처리하지 않은 완료를 알린다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    finish("completed");
    assert.match(sessionAnchor(repo, "startup", "s9"), /담당 완료가 기록돼 있고 다음 명령은 아직 실행하지 않았다\(ca-analyst · completed · /);
  });
});

describe("장부", () => {
  test("다음 행동이 없는 종료는 완료로 남기지 않고, 끝을 관찰하지 못한 오래된 실행은 세지 않으며, hook 실패 정리는 한 번만 한다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    noteAgentStarted(repo, "ORD-1", "a1", { source: "planning", type: "ca-analyst", phase: "analysis" });
    noteAgentFinished(repo, "ORD-1", "a1", { source: "planning", type: "ca-analyst", status: "cancelled", phase: "analysis", advance: false });
    assert.equal(pendingCompletion(repo, "ORD-1"), undefined, "늦은 결과·중복 알림");
    noteAgentStarted(repo, "ORD-1", "a2", { source: "planning", type: "ca-analyst", phase: "analysis" });
    settleAgent(repo, "a2", "hook-failure");
    const settled = pendingCompletion(repo, "ORD-1")!;
    assert.equal(settled.completion.status, "hook-failure");
    settleAgent(repo, "a2", "hook-failure");
    assert.equal(pendingCompletion(repo, "ORD-1")!.completion.eventId, settled.completion.eventId);
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
    writeFileSync(join(repo, AGENT_RUNS_FILE), JSON.stringify({ version: 1, works: { "ORD-1": { running: { gone: { source: "planning", type: "ca-analyst", phase: "analysis", startedAt: old } }, completed: settled.completion } } }));
    assert.equal(pendingCompletion(repo, "ORD-1")!.running, 0);
  });

  test("hook 실패 표 — agent-event 는 언제나 막지 않는다. init 이 구현·테스트 담당 matcher 로 설치한다", () => {
    for (const stdin of ["not json", "{\"hook_event_name\":\"SubagentStart\"}", "{\"hook_event_name\":\"SubagentStop\"}"]) {
      assert.equal(hookFailureExit(hookFailureInput("agent-event", stdin)).code, 0, stdin);
    }
    assert.equal(cli(["agent-event"], undefined).status, 0);
    init(repo);
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8")) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    for (const event of ["SubagentStart", "SubagentStop"]) {
      assert.ok(settings.hooks[event].some((entry) => entry.matcher === "ca-implementer|ca-tester" && entry.hooks.some((hook) => hook.command.endsWith("agent-event"))), event);
    }
    assert.ok(CLAUDE_HOOKS.some(([event, sub]) => event === "SubagentStop" && sub === "agent-event"));
  });
});

describe("리뷰어 완료 뒤 이어가기", () => {
  test("기록한 리뷰 결과는 4-1 부터 잇고, 이미 기록한 결과의 재알림은 완료로 남기지 않는다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    const event = { cwd: repo, session_id: "s1", agent_id: "rev-1", agent_type: "ca-reviewer" };
    observeReviewer({ ...event, hook_event_name: "SubagentStart" });
    assert.equal(pendingCompletion(repo, "ORD-1"), undefined);
    observeReviewer({ ...event, hook_event_name: "SubagentStop", last_assistant_message: "- 없음" });
    assert.match(decideStop({ cwd: repo, session_id: "s1" }) ?? "", /\/ca-review 절차 4-1부터/);
    consumeCompletion(repo);
    assert.equal(pendingCompletion(repo, "ORD-1"), undefined);
    assert.throws(() => observeReviewer({ ...event, hook_event_name: "SubagentStop", last_assistant_message: "- 없음" }), RecordedFailure);
    assert.equal(pendingCompletion(repo, "ORD-1"), undefined, "이미 기록한 결과의 재알림");
  });
});
