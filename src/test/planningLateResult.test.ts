import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import "./consentFixture";

import { handoffPlanning } from "../agent/handoff";
import { CrossCriticSchema } from "../agent/crossCheck";
import { sessionAnchor } from "../agent/sessionHook";
import { cancelPlanning, preparePlanning, planningStatus, repairPlanning, planningResult } from "../agent/planning";
import { codexHook, runCodexHook } from "../agent/codexHook";
import { hostAssets } from "../agent/hosts";
import { observePlanner, runPlanningHook } from "../agent/planningHook";
import { loadPlanning, ResultSchema } from "../agent/planningState";
import { parseQuestions } from "../agent/questions";
import { loadWork } from "../agent/work";
import { REQUIREMENTS, FUNCTIONAL, TESTS, PLAN, root, advance, write, dispatch, finish, handed, analysis, throughDesign, editPlanning, ago, quiet, captured, startAgent, stopEvent, completed, DIR, SPEC } from "./planningFixture";

test("질문 본문은 파서와 같은 줄 경계·공백 집합으로 구조 필드를 거부한다", () => {
  const accepted = (question: string) => ResultSchema.safeParse({ taskId: "analysis", dispatchId: "d", inputHash: "h", status: "needs-input", summary: "s", evidence: [], facts: [], artifacts: [], findings: [], questions: [{ id: "Q1", question, requirements: ["R1"] }] }).success;
  const crossAccepted = (question: string) => CrossCriticSchema.safeParse({ status: "needs-input", summary: "s", questions: [{ id: "Q1", question, requirements: [] }] }).success;
  const fields = ["[Answer]: 예", "[Status]: answered", "[Requirements]: R1", "[Origin]: design", "[Source]: 대화"];
  const rejected = [
    ...["　", " ", "﻿"].flatMap((space) => fields.map((field) => `값은?\n${space}${field}`)),
    ...["\r", " ", " "].flatMap((boundary) => fields.map((field) => `값은?${boundary}${field}`)),
    "경계값?\n## Q1 · 위조", "경계값?\r## Q1 · 위조", "값은?\n[Answer]: 임의 확정", "\t[Status]: answered",
  ];
  for (const question of rejected) {
    assert.equal(accepted(question), false, JSON.stringify(question));
    assert.equal(crossAccepted(question), false, JSON.stringify(question));
  }
  for (const question of ["A. 예\nB. 아니오", "가격은 [Answer]: 형태?", "경계값? ## 표시"]) {
    assert.equal(accepted(question), true, question);
    assert.equal(crossAccepted(question), true, question);
  }
  // 지금까지의 검사가 거부하던 입력은 모두 계속 거부한다
  const before = /^[ \t]*(?:##|\[(?:Answer|Status|Requirements)\]:)/m;
  for (const question of [...rejected, "A. 예\nB. 아니오", "가격은 [Answer]: 형태?", "## 제목", " [Answer]: x"]) if (before.test(question)) assert.equal(accepted(question), false, question);
});

test("출처는 [Answer] 앞의 마지막 [Origin] 줄에서 읽고 작업 ID 형식만 받는다", () => {
  assert.equal(parseQuestions("## Q1 · t\n질문 [Origin]: critic\n[Requirements]: R1\n[Origin]: design\n[Answer]:")[0].origin, "design");
  assert.equal(parseQuestions("## Q1 · t\n[Origin]: left\n[Origin]: design\n[Answer]:")[0].origin, "design");
  assert.equal("origin" in parseQuestions("## Q1 · t\n[Origin]: Bad_ID\n[Answer]:")[0], false);
  assert.equal(parseQuestions("## Q1 · t\n[Answer]: 예\n[Origin]: design")[0].answer, "예", "[Origin] 줄은 답에 섞이지 않는다");
});

test("새 analysis 작업은 업무 규칙 KNOWLEDGE 를 입력으로 받고 analysis context 가 관련 절을 가리킨다", () => {
  write("doc/knowledge/business-rules.md", "# 업무 규칙\n## 반환 규칙\n- BR-1: 값을 반환한다 — 숫자로 돌려준다\n");
  const cli = join(__dirname, "../agent/cli.js");
  const [summary] = JSON.parse(execFileSync(process.execPath, [cli, "planning", "advance"], { cwd: root, encoding: "utf8" })).assignments;
  const item = handed(summary);
  assert.ok(item.task.inputs.includes("doc/knowledge/business-rules.md"), JSON.stringify(item.task.inputs));
  const text = readFileSync(join(root, summary.assignmentFile), "utf8");
  assert.match(text, /업무 규칙 KNOWLEDGE[^\n]*doc\/knowledge\/business-rules\.md/);
  assert.match(text, /## 참고 문서 \([\s\S]*doc\/knowledge\/business-rules\.md L\d+-L\d+ · ## 반환 규칙/);
  finish(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }, { evidence: [{ path: SPEC, line: 1 }, { path: "doc/knowledge/business-rules.md", line: 3 }] });
  assert.equal(JSON.parse(planningResult(root, "analysis")).current, true, "업무 규칙 근거는 배정 범위 안이다");
});

test("이미 준비한 작업의 inputs 는 그대로 둔다 — 진행 중 작업의 해시를 바꾸지 않는다", async () => {
  preparePlanning(root);
  write("doc/knowledge/business-rules.md", "# 업무 규칙\n## 반환 규칙\n- BR-1: 값을 반환한다\n");
  assert.deepEqual((await advance()).assignments[0].task.inputs, [SPEC]);
});

test("대화가 새로 열리면 실행 중으로 기록된 계획 배정과 취소 명령을 붙인다", async () => {
  (await advance());
  const cleared = sessionAnchor(root, "clear");
  assert.match(cleared, /실행 중으로 기록된 계획 배정: analysis\(ca-analyst, 담당 시작 미관찰, 0분 전\)/);
  assert.match(cleared, /code-agent planning cancel analysis/);
  const compacted = sessionAnchor(root, "compact");
  assert.match(compacted, /stale·cancel 안내/);
  assert.doesNotMatch(compacted, /planning cancel analysis/);
});

test("planning status 는 실행 관찰·낡은 이유·재시도 예산을 보인다", async () => {
  const item = (await advance()).assignments[0];
  startAgent(item, "watch");
  let status = JSON.parse(planningStatus(root)).tasks[0];
  assert.equal(status.run.observedStart, true);
  assert.equal(status.run.orphan, "running");
  assert.match(status.budget.taskTotal.epoch, /^실행 회차 1 · 요구 항목 [0-9a-f]{8}$/);
  assert.deepEqual(status.budget, { sameInput: { used: 0, limit: 3 }, taskTotal: { used: 1, limit: 6, epoch: status.budget.taskTotal.epoch } });
  observePlanner(JSON.parse(stopEvent(item, "watch", completed(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }))));
  write("doc/conventions.md", `${readFileSync(join(root, "doc/conventions.md"), "utf8")}\n- 추가 규칙\n`);
  status = JSON.parse(planningStatus(root)).tasks[0];
  assert.equal(status.state, "stale");
  assert.ok(status.staleBecause.includes("입력 파일: doc/conventions.md"), JSON.stringify(status.staleBecause));
});

for (const via of ["claude", "direct"] as const) test(`실행 중 입력이 바뀐 완료는 취소로 기록하고 되돌리지 않는다: ${via}`, () => {
  analysis(); preparePlanning(root);
  const item = dispatch("explore");
  startAgent(item, "explorer");
  write("src/current.ts", "export const current = 5;\n");
  const report = completed(item, {}, { evidence: [{ path: "src/current.ts", line: 1 }] });
  if (via === "claude") quiet(() => assert.equal(runPlanningHook(stopEvent(item, "explorer", report)), 0));
  else assert.throws(() => observePlanner(JSON.parse(stopEvent(item, "explorer", report))), /입력이 바뀌/);
  const last = loadPlanning(loadWork(root)!).tasks.find((record) => record.task.id === "explore")!.attempts.at(-1)!;
  assert.equal(last.status, "cancelled");
  assert.equal(last.failure!.class, "dispatch-orphan");
});

test("Codex 사본 — staging 문장은 그대로(쓰기 도구만 apply_patch)이고 계획 루프의 새 문장이 그대로 있다", () => {
  const assets = hostAssets("codex");
  for (const name of ["ca-analyze", "ca-impact", "ca-design", "ca-plan"]) {
    const text = assets.get(`.agents/skills/${name}/SKILL.md`)!;
    assert.ok(text.includes(".agents/skills/ca-plan/contract.md"), name);
  }
  const contract = assets.get(".agents/skills/ca-plan/contract.md")!;
  assert.ok(contract.includes("담당은 출력 문서를 staging에 쓰고 결과 JSON에는 경로만 넣는다."));
  for (const phrase of ["`next` 줄이 싣는 행동의 요지는 그 줄이 원천이다", "`cancel` 목록", "rewind.auto", "feedback"]) assert.ok(contract.includes(phrase), phrase);
  const analyst = assets.get(".codex/agents/ca-analyst.toml")!;
  // staging 쓰기 규칙은 배정 instructions(쓰기 도구는 editVia — Codex 는 apply_patch)에 있다. 에이전트 본문은 그것을 따르라고만 한다
  assert.ok(analyst.includes("입력 범위·staging·결과 파일 쓰기·근거·질문 규칙은 `instructions`에 있다"));
  assert.ok(!analyst.includes("Write로"), "Claude 쓰기 도구 이름이 남지 않는다");
  // 요구 분석 전용 형식은 analysis 배정의 문서 기준(ca-analyze/criteria.md)에만 있다 — design·plan 배정 때 담당 본문으로 싣지 않는다
  assert.ok(!analyst.includes("돌려줄 것:"));
  assert.match(assets.get(".agents/skills/ca-analyze/criteria.md")!, /^## 요구 분석 담당\r?$/m);
  assert.ok(assets.get(".codex/agents/ca-explorer.toml")!.includes("문서는 staging에 쓰고 artifacts에는 경로만 넣는다. 그 밖의 파일을 쓰거나"));
});

test("수정 재배정은 담당 시작 때 현행 문서를 그 배정의 staging 에 미리 둔다 — 처음 배정에는 두지 않는다", () => {
  throughDesign(); preparePlanning(root);
  const stagedOf = (item: any, file: string) => join(root, DIR, ".staging", item.resultShape.dispatchId, file);
  const first = dispatch("plan");
  startAgent(first, "planner-1");
  assert.equal(existsSync(stagedOf(first, "plan.json")), false, "처음 배정에는 현행 문서가 없다");
  observePlanner(JSON.parse(stopEvent(first, "planner-1", completed(first, { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS }))));
  write(`${DIR}/feedback.md`, "07 에 경계값 TC 를 더한다\n");
  const planTask = loadPlanning(loadWork(root)!).tasks.find((record) => record.task.role === "plan")!.task;
  preparePlanning(root, { tasks: [{ ...planTask, inputs: [...planTask.inputs, `${DIR}/feedback.md`] }] });
  const again = dispatch("plan");
  assert.match(again.instructions, /수정 재배정이면 그 자리에 현행 문서\(직전 시도의 초안이 있으면 그 초안\)가 미리 들어 있습니다 — 고칠 곳만 고치고/);
  startAgent(again, "planner-2");
  for (const file of ["plan.json", "07-test-spec.md"]) assert.equal(readFileSync(stagedOf(again, file), "utf8"), readFileSync(join(root, DIR, file), "utf8"), file);
});

test("차단 지적은 인용 문서를 낸 작업만 후보로 보이고 자동으로 되감지 않는다", async () => {
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  const line = FUNCTIONAL.split("\n").findIndex((row) => row.startsWith("- AC-R1-1")) + 1;
  finish(dispatch("critic"), {}, { findings: [{ id: "F1", severity: "blocking", detail: "AC-R1-1 경계값 TC 없음", source: { path: `${DIR}/04-functional.md`, line } }] });
  const reply = (await advance());
  assert.notEqual(reply.action, "rewind-required");
  assert.equal(reply.feedback[0].from, "critic");
  assert.equal(reply.feedback[0].citedTask, "design");
  assert.equal(reply.feedback[0].citedPhase, "design");
  assert.match(reply.feedback[0].note, /근거 문서가 앞 단계\(design\) 출력입니다/);
  assert.equal("command" in reply.feedback[0], false);
});

for (const via of ["claude", "codex"] as const) test(`크기 한도를 넘은 결과는 원본을 보존하지 않으므로 교정 대기 대신 실패로 기록하고 교정을 받지 않는다: ${via}`, async () => {
  const item = (await advance()).assignments[0];
  const huge = "x".repeat(500_001);
  if (via === "codex") {
    const event = { cwd: root, session_id: "s", agent_id: "codex-large", agent_type: item.hostAgents.codex };
    codexHook({ ...event, hook_event_name: "SubagentStart" });
    const result = captured(() => runCodexHook(JSON.stringify({ ...event, hook_event_name: "SubagentStop", last_assistant_message: huge })));
    assert.equal(result.value, 0);
    assert.equal(result.out, "{}");
    assert.match(result.err, /크기 한도[\s\S]*형식 교정 대상이 아닙니다/);
  } else {
    startAgent(item, "large");
    quiet((stderr) => {
      assert.equal(runPlanningHook(stopEvent(item, "large", huge)), 2, "첫 Stop 은 같은 담당에게 되돌린다");
      assert.match(stderr(), /크기 한도/);
      assert.equal(runPlanningHook(stopEvent(item, "large", huge, { stop_hook_active: true })), 0);
    });
  }
  const last = loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!;
  assert.equal(last.status, "failed");
  assert.equal(last.failure!.class, "agent-format-error");
  assert.equal(last.correction, undefined, "원본이 없는 교정 대기를 만들지 않는다");
  assert.throws(() => repairPlanning(root, "analysis"), /교정할 관찰 결과가 없거나/);
  assert.equal((await advance()).blocked[0].class, "agent-format-error");
});

test("연결하지 못한 담당이 취소·교체된 배정의 결과를 늦게 내면 되돌리지 않고 늦은 결과로만 기록한다", () => {
  analysis();
  const base = { role: "explore", title: "영역", requirements: ["R1"], inputs: [SPEC], outputs: [], dependsOn: ["analysis"] };
  preparePlanning(root, { tasks: [{ ...base, id: "left", scopes: ["src"] }, { ...base, id: "right", scopes: ["other"] }] });
  const oldLeft = dispatch("left"); dispatch("right");
  startAgent(oldLeft, "old-left");
  assert.equal(loadPlanning(loadWork(root)!).agents.find((agent) => agent.id === "old-left")!.dispatchId, undefined, "후보가 둘이라 연결하지 않는다");
  cancelPlanning(root, "left");
  const newLeft = dispatch("left");
  quiet((stderr) => {
    assert.equal(runPlanningHook(stopEvent(oldLeft, "old-left", completed(oldLeft, {}, { evidence: [{ path: "src/current.ts", line: 1 }] }))), 0);
    assert.match(stderr(), /현재 배정에 속한 실행 결과가 아닙니다/);
  });
  const state = loadPlanning(loadWork(root)!);
  const agent = state.agents.find((item) => item.id === "old-left")!;
  assert.equal(agent.failure!.detail, "취소·교체된 배정의 늦은 결과");
  assert.equal(agent.returns, undefined, "식별 복사 오류로 되돌리지 않는다");
  const left = state.tasks.find((record) => record.task.id === "left")!;
  assert.deepEqual(left.attempts.map((attempt) => attempt.status), ["cancelled", "running"]);
  assert.equal(left.attempts.at(-1)!.dispatchId, newLeft.resultShape.dispatchId);
});

test("취소된 배정의 담당이 재배정 뒤 늦게 시작해 새 배정에 연결돼도 그 늦은 결과는 새 배정을 고아로 만들지 않는다", async () => {
  const first = (await advance()).assignments[0];
  editPlanning((state) => { state.tasks[0].attempts[0].at = ago(11); });
  assert.equal((await advance()).action, "stale");
  cancelPlanning(root, "analysis");
  const second = (await advance()).assignments[0];
  // 옛 배정 파일로 부른 담당이 늦게 시작했다 — 후보가 하나라 새 배정에 연결된다
  startAgent(first, "late-old");
  startAgent(second, "current");
  assert.deepEqual(loadPlanning(loadWork(root)!).agents.map((agent) => agent.dispatchId), [second.resultShape.dispatchId, second.resultShape.dispatchId]);
  quiet(() => assert.equal(runPlanningHook(stopEvent(first, "late-old", completed(first, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }))), 0, "늦은 결과는 되돌리지 않는다"));
  let state = loadPlanning(loadWork(root)!);
  assert.equal(state.tasks[0].attempts.at(-1)!.status, "running", "새 배정은 고아가 아니다");
  assert.equal(state.agents[0].dispatchId, first.resultShape.dispatchId, "늦은 담당의 연결은 보고한 배정으로 옮긴다");
  quiet(() => assert.equal(runPlanningHook(stopEvent(second, "current", completed(second, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }))), 0));
  state = loadPlanning(loadWork(root)!);
  assert.deepEqual(state.tasks[0].attempts.map((attempt) => attempt.status), ["cancelled", "completed"]);
});

test("취소된 배정의 늦은 결과가 형식까지 틀려도 되돌리지 않고 늦은 결과로만 기록한다", async () => {
  const first = (await advance()).assignments[0];
  cancelPlanning(root, "analysis");
  const second = (await advance()).assignments[0];
  startAgent(first, "late-broken");
  quiet(() => assert.equal(runPlanningHook(stopEvent(first, "late-broken", { ...first.resultShape, status: "completed", summary: 7 })), 0));
  const state = loadPlanning(loadWork(root)!);
  assert.equal(state.agents[0].failure!.detail, "취소·교체된 배정의 늦은 결과");
  assert.equal(state.agents[0].dispatchId, first.resultShape.dispatchId, "연결을 보고한 배정으로 옮긴다");
  assert.equal(state.tasks[0].attempts.at(-1)!.status, "running");
  assert.equal(state.tasks[0].attempts.at(-1)!.dispatchId, second.resultShape.dispatchId);
});

test("늦은 결과의 담당만 새 배정에 연결됐으면 새 배정은 담당을 기다리고, 다른 담당이 일하는 배정은 식별 오류로 고아가 되지 않는다", async () => {
  const first = (await advance()).assignments[0];
  cancelPlanning(root, "analysis");
  const second = (await advance()).assignments[0];
  startAgent(first, "late-only");
  quiet(() => runPlanningHook(stopEvent(first, "late-only", completed(first, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }))));
  const waiting = (await advance());
  assert.equal(waiting.action, "wait", JSON.stringify(waiting));
  assert.equal(waiting.orphaned, undefined, "늦은 담당의 종료로 새 배정을 고아로 판정하지 않는다");
  // 같은 배정에 두 담당이 연결됐다 — 한 담당의 식별 복사 오류가 다른 담당이 일하는 배정을 고아로 만들지 않는다
  startAgent(second, "duplicate"); startAgent(second, "worker");
  const copy = { ...completed(second, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }), dispatchId: "other" };
  quiet(() => {
    assert.equal(runPlanningHook(stopEvent(second, "duplicate", copy)), 2);
    assert.equal(runPlanningHook(stopEvent(second, "duplicate", copy, { stop_hook_active: true })), 0);
  });
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "running");
  quiet(() => assert.equal(runPlanningHook(stopEvent(second, "worker", completed(second, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }))), 0));
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "completed");
});

test("출처 검증 실패로 고아가 된 배정은 다시 배정할 때 직전 실패를 보이고, 두 번 이어지면 자동으로 다시 배정하지 않는다", async () => {
  const outside = mkdtempSync(join(tmpdir(), "ca-transcript-"));
  try {
    const run = (item: any, agent: string) => {
      const event = { cwd: root, session_id: "s", agent_id: agent, agent_type: item.agent, transcript_path: join(outside, "s.jsonl") };
      observePlanner({ ...event, hook_event_name: "SubagentStart" });
      const elsewhere = join(outside, `${agent}.jsonl`);
      writeFileSync(elsewhere, "");
      quiet(() => assert.equal(runPlanningHook(JSON.stringify({ ...event, hook_event_name: "SubagentStop", agent_transcript_path: elsewhere,
        last_assistant_message: JSON.stringify(completed(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS })) })), 0));
    };
    run((await advance()).assignments[0], "first");
    const again = (await advance());
    assert.equal(again.action, "dispatch");
    const previous = again.assignments[0].previous;
    assert.deepEqual({ status: previous.status, class: previous.class }, { status: "orphaned", class: "dispatch-orphan" });
    assert.match(previous.detail, /하위 에이전트 기록이 아닙니다/);
    assert.deepEqual(JSON.parse(handoffPlanning(root, JSON.stringify(again))).assignments[0].previous, previous, "CLI 요약에도 남는다");
    run(again.assignments[0], "second");
    const stopped = (await advance());
    assert.equal(stopped.assignments.length, 0);
    assert.equal(stopped.action, "blocked");
    assert.equal(stopped.blocked[0].class, "hook-failure");
    assert.match(stopped.blocked[0].reasons.join("\n"), /두 번 이어서[\s\S]*planning dispatch analysis/);
    assert.equal(dispatch("analysis").cached, false, "명시 배정은 받는다");
  } finally { rmSync(outside, { recursive: true, force: true }); }
});

for (const via of ["text", "handback"] as const) test(`되돌린 뒤의 완료는 되돌릴 때 판정한 SubagentHandback 을 다시 읽지 않는다: ${via}`, async () => {
  const item = (await advance()).assignments[0];
  const outside = mkdtempSync(join(tmpdir(), "ca-transcript-"));
  try {
    const event = { cwd: root, session_id: "s", agent_id: "handback", agent_type: item.agent, transcript_path: join(outside, "s.jsonl") };
    observePlanner({ ...event, hook_event_name: "SubagentStart" });
    const transcript = join(outside, "s", "subagents", "agent-handback.jsonl");
    mkdirSync(dirname(transcript), { recursive: true });
    // 기록 시각에 기대지 않는다 — 옛 보고의 시각이 되돌린 시각보다 늦어도 순서로 나눈다
    const handback = (message: unknown) => appendFileSync(transcript, `${JSON.stringify({ timestamp: new Date(Date.now() + 60_000).toISOString(), type: "assistant", message: { content: [{ type: "tool_use", name: "SubagentHandback", input: { message: JSON.stringify(message) } }] } })}\n`);
    const good = completed(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
    handback({ ...good, dispatchId: "wrong-copy" });
    const stop = (message: string, extra: object = {}) => runPlanningHook(JSON.stringify({ ...event, hook_event_name: "SubagentStop", agent_transcript_path: transcript, last_assistant_message: message, ...extra }));
    quiet(() => {
      assert.equal(stop(""), 2);
      if (via === "handback") handback(good);
      // 고친 결과를 최종 응답(text)이나 새 보고(handback)로 냈다 — 되돌린 옛 보고는 다시 판정하지 않는다
      assert.equal(stop(via === "text" ? JSON.stringify(good) : "끝", { stop_hook_active: true }), 0);
    });
    assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "completed");
  } finally { rmSync(outside, { recursive: true, force: true }); }
});
