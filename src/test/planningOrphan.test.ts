import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import "./consentFixture";
import { next, submitPlan } from "../agent/commands";
import { cancelPlanning, grantPlanningRetry, planningBudget, preparePlanning, planningStatus, repairPlanning } from "../agent/planning";
import { codexHook, runCodexHook } from "../agent/codexHook";
import { runPlanningHook } from "../agent/planningHook";
import { loadPlanning } from "../agent/planningState";
import { planRuleProblems } from "../agent/planningValidation";
import { planFormatFor } from "../core/plan";
import { acquireLock } from "../agent/lock";
import { orphanState } from "../agent/retryPolicy";
import { loadWork } from "../agent/work";
import { deadPid } from "./deadPid";
import { ID, REQUIREMENTS, DESIGN, FUNCTIONAL, TESTS, PLAN, root, advance, dispatch, finish, analysis, throughDesign, malformed, planningJson, editPlanning, ago, quiet, quietAsync, captured, startAgent, stopEvent, completed, toDesign, DUPLICATED_AC, DIR, SPEC } from "./planningFixture";



test("시작이 관찰되지 않은 채 10분이 지난 배정은 stale 로 보이고 cancel 목록을 낸다", async () => {
  (await advance());
  editPlanning((state) => { state.tasks[0].attempts[0].at = ago(11); });
  const reply = (await advance());
  assert.equal(reply.action, "stale");
  assert.deepEqual(reply.cancel, ["analysis"]);
  assert.equal(reply.stale[0].observedStart, false);
  assert.equal(reply.stale[0].reason, "담당 시작이 관찰되지 않았습니다(배정 11분 전)");
  assert.throws(() => dispatch("analysis"), /담당 시작이 관찰되지 않았습니다\(배정 11분 전\)[\s\S]*planning cancel analysis/);
  cancelPlanning(root, "analysis");
  assert.equal((await advance()).action, "dispatch");
});

test("시작이 관찰된 담당이 60분 넘게 끝나지 않으면 stale 이다", async () => {
  const item = (await advance()).assignments[0];
  startAgent(item, "slow");
  editPlanning((state) => { state.tasks[0].attempts[0].at = ago(62); state.agents[0].startedAt = ago(61); });
  const reply = (await advance());
  assert.equal(reply.action, "stale");
  assert.equal(reply.stale[0].observedStart, true);
  assert.equal(reply.stale[0].reason, "담당이 61분째 끝나지 않았습니다");
});

test("시작 미관찰 기한은 배정 뒤 마지막 담당 활동부터 잰다 — 차례로 실행하는 호스트의 다음 배정은 stale 이 아니다", async () => {
  analysis();
  const base = { role: "explore", title: "영역", requirements: ["R1"], inputs: [SPEC], outputs: [], dependsOn: ["analysis"] };
  preparePlanning(root, { tasks: [{ ...base, id: "left", scopes: ["src"] }, { ...base, id: "right", scopes: ["other"] }] });
  const left = dispatch("left"); dispatch("right");
  finish(left);
  editPlanning((state) => {
    for (const record of state.tasks.filter((item) => item.task.role === "explore")) record.attempts.at(-1)!.at = ago(13);
    // analysis 담당은 조사 배정보다 먼저 끝났다
    for (const agent of state.agents.slice(0, -1)) { agent.startedAt = ago(20); agent.endedAt = ago(19); }
    const agent = state.agents.at(-1)!;
    agent.dispatchId = left.resultShape.dispatchId; agent.startedAt = ago(12); agent.endedAt = ago(2);
  });
  const waiting = (await advance());
  assert.ok(waiting.waiting.includes("right"), JSON.stringify(waiting));
  assert.equal(waiting.stale, undefined);
  editPlanning((state) => { state.agents.at(-1)!.endedAt = ago(11); });
  const stale = (await advance());
  assert.equal(stale.action, "stale");
  assert.equal(stale.stale[0].id, "right");
  assert.equal(stale.stale[0].reason, "담당 시작이 관찰되지 않았습니다(배정 13분 전, 마지막 담당 활동 11분 전)");
});

test("orphanState — 역할을 모르면 다른 종류의 미연결 담당도 이 배정의 담당으로 본다", () => {
  const now = Date.now(), attempt = { dispatchId: "D", inputHash: "h", at: new Date(now - 30 * 60_000).toISOString(), status: "running" };
  const agents = [{ id: "w", session: "s", type: "ca-writer", startedAt: new Date(now - 20 * 60_000).toISOString() }];
  assert.equal(orphanState({ attempt, agents, now }), "running", "역할을 모르면 고아로 덜 판정한다");
  assert.equal(orphanState({ attempt, agentType: "ca-explorer", agents, now }), "suspect", "다른 종류의 담당은 이 배정의 담당이 아니다");
});

test("고아 정리는 동시 한도보다 먼저다 — 끝난 담당의 배정이 maxParallel 1 을 차지하지 않는다", () => {
  preparePlanning(root);
  editPlanning((state) => { state.maxParallel = 1; });
  startAgent(dispatch("analysis"), "gone");
  editPlanning((state) => { state.agents[0].finished = true; });
  assert.equal(dispatch("analysis").cached, false);
  assert.deepEqual(loadPlanning(loadWork(root)!).tasks[0].attempts.map((attempt) => attempt.status), ["orphaned", "running"]);
});

test("교정도 고아 정리 뒤에 동시 한도를 센다", () => {
  analysis();
  const base = { role: "explore", title: "영역", requirements: ["R1"], inputs: [SPEC], outputs: [], dependsOn: ["analysis"] };
  preparePlanning(root, { maxParallel: 1, tasks: [{ ...base, id: "left", scopes: ["src"] }, { ...base, id: "right", scopes: ["other"] }] });
  malformed(dispatch("left"));
  startAgent(dispatch("right"), "right-agent");
  editPlanning((state) => { state.agents.find((agent) => agent.id === "right-agent")!.finished = true; });
  assert.equal(JSON.parse(repairPlanning(root, "left")).mode, "correction");
  assert.equal(loadPlanning(loadWork(root)!).tasks.find((record) => record.task.id === "right")!.attempts.at(-1)!.status, "orphaned");
});

test("연결된 담당이 끝났는데 결과가 없는 배정은 advance 가 고아로 표시하고 같은 호출에서 다시 배정한다", async () => {
  startAgent((await advance()).assignments[0], "lost");
  editPlanning((state) => { state.agents[0].finished = true; });
  const reply = (await advance());
  assert.equal(reply.orphaned[0].id, "analysis");
  assert.equal(reply.action, "dispatch");
  const attempts = loadPlanning(loadWork(root)!).tasks[0].attempts;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].status, "orphaned");
  assert.equal(attempts[0].failure!.class, "dispatch-orphan");
});

test("Claude 완료 hook — 식별 불일치는 한 번 되돌리고, 그다음은 고아로 기록해 같은 입력 실패에 세지 않는다", async () => {
  const item = (await advance()).assignments[0];
  startAgent(item, "copy");
  const report = { ...completed(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }), dispatchId: "other" };
  quiet(() => {
    assert.equal(runPlanningHook(stopEvent(item, "copy", report)), 2);
    let state = loadPlanning(loadWork(root)!);
    assert.equal(state.agents[0].returns, 1);
    assert.equal(state.tasks[0].attempts.at(-1)!.status, "running");
    assert.equal(runPlanningHook(stopEvent(item, "copy", report, { stop_hook_active: true })), 0);
    state = loadPlanning(loadWork(root)!);
    assert.equal(state.tasks[0].attempts.at(-1)!.status, "orphaned");
    assert.equal(state.agents[0].failure!.class, "dispatch-orphan");
  });
  assert.equal((await advance()).action, "dispatch");
  assert.equal(JSON.parse(planningStatus(root)).tasks[0].budget.sameInput.used, 0);
});

test("Codex 완료 hook — 식별 불일치는 되돌리지 않고 고아로 기록한 뒤 0 을 낸다", async () => {
  const item = (await advance()).assignments[0];
  const event = { cwd: root, session_id: "s", agent_id: "codex-copy", agent_type: item.hostAgents.codex };
  codexHook({ ...event, hook_event_name: "SubagentStart" });
  const message = JSON.stringify({ ...completed(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }), dispatchId: "other" });
  const result = captured(() => runCodexHook(JSON.stringify({ ...event, hook_event_name: "SubagentStop", last_assistant_message: message })));
  assert.equal(result.value, 0);
  assert.equal(result.out, "{}");
  assert.match(result.err, /현재 배정에 속한 실행 결과가 아닙니다/);
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "orphaned");
});

test("Codex 담당 시작 이벤트의 판정 실패도 막지 않는다", async () => {
  (await advance());
  writeFileSync(planningJson(), "{broken");
  const result = captured(() => runCodexHook(JSON.stringify({ cwd: root, session_id: "s", agent_id: "a", agent_type: "ca_analyst", hook_event_name: "SubagentStart" })));
  assert.equal(result.value, 0);
  assert.equal(result.out, "{}");
  assert.match(result.err, /code-agent codex-event: /);
});

test("Claude 완료 hook — 형식 오류는 첫 Stop 에서 되돌리고, 이미 막힌 재시도는 교정 대기로 기록한다", async () => {
  const item = (await advance()).assignments[0];
  startAgent(item, "format");
  const broken = { ...item.resultShape, status: "completed", summary: 7, evidence: [{ path: SPEC, line: 1 }] };
  quiet((stderr) => {
    assert.equal(runPlanningHook(stopEvent(item, "format", broken)), 2);
    assert.match(stderr(), /resultShape 형태 JSON 하나로 다시 반환/);
    assert.match(stderr(), /결과 JSON 이 resultShape 와 다릅니다:\n {2}- summary: /, "스키마 오류는 경로: 메시지 줄로 싣는다");
    assert.doesNotMatch(stderr(), /"code":/, "zod 오류 JSON 을 그대로 싣지 않는다");
    assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "running");
    assert.equal(runPlanningHook(stopEvent(item, "format", broken, { stop_hook_active: true })), 0);
  });
  const last = loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!;
  assert.equal(last.status, "needs-correction");
  assert.equal(last.failure!.class, "agent-format-error");
});

test("완료 hook 은 staging 본문에 그 역할의 게이트 검사를 먼저 돌려 한 번 되돌린다", async () => {
  toDesign();
  const item = (await advance()).assignments[0];
  startAgent(item, "designer");
  const design = () => loadPlanning(loadWork(root)!).tasks.find((record) => record.task.id === "design")!.attempts.at(-1)!;
  quiet((stderr) => {
    assert.equal(runPlanningHook(stopEvent(item, "designer", completed(item, { [`${DIR}/03-design.md`]: DESIGN, [`${DIR}/04-functional.md`]: DUPLICATED_AC }))), 2);
    assert.match(stderr(), /수락 기준 id 가 겹칩니다/);
    assert.equal(existsSync(join(root, DIR, "04-functional.md")), false);
    assert.equal(design().status, "running");
    assert.equal(runPlanningHook(stopEvent(item, "designer", completed(item, { [`${DIR}/03-design.md`]: DESIGN, [`${DIR}/04-functional.md`]: FUNCTIONAL }), { stop_hook_active: true })), 0);
  });
  assert.equal(design().status, "completed");
  next(root);
});

test("host 없이 부른 완료 관찰은 문서 검사 실패를 바로 내용 오류로 기록한다", async () => {
  toDesign();
  const item = (await advance()).assignments[0];
  assert.throws(() => finish(item, { [`${DIR}/03-design.md`]: DESIGN, [`${DIR}/04-functional.md`]: DUPLICATED_AC }), /수락 기준 id 가 겹칩니다/);
  const last = loadPlanning(loadWork(root)!).tasks.find((record) => record.task.id === "design")!.attempts.at(-1)!;
  assert.equal(last.status, "failed");
  assert.equal(last.failure!.class, "agent-content-error");
  assert.equal(existsSync(join(root, DIR, "03-design.md")), false);
  assert.equal(existsSync(join(root, DIR, "04-functional.md")), false);
});

test("analysis 결과도 요구 형식·원문 추적 검사를 완료 전에 받는다", async () => {
  await assert.rejects(async () => finish((await advance()).assignments[0], { [`${DIR}/01-requirements.md`]: REQUIREMENTS.replace('근거: "값을 반환한다."', "") }), /근거: 줄이 없는 요구 항목/);
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "failed");
});

test("plan 결과도 plan.json 의 요구 커버리지를 완료 전에 받는다", () => {
  throughDesign(); preparePlanning(root);
  const uncovered = { ...PLAN, files: PLAN.files.map((file) => ({ ...file, requirements: ["R2"] })) };
  assert.throws(() => finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(uncovered), [`${DIR}/07-test-spec.md`]: TESTS }), /어떤 파일에도 닿지 않는 요구 항목/);
  assert.equal(existsSync(join(root, DIR, "plan.json")), false);
  const last = loadPlanning(loadWork(root)!).tasks.find((record) => record.task.id === "plan")!.attempts.at(-1)!;
  assert.equal(last.status, "failed");
  assert.equal(last.failure!.class, "agent-content-error");
});

test("plan 완료 hook 은 제출 규칙(순서·경로)을 plan submit 과 같은 함수로 먼저 본다 — hook 을 지난 초안은 제출에서 같은 규칙으로 걸리지 않는다", () => {
  throughDesign(); preparePlanning(root);
  // 단계 위치 밖 파일과 이유 없는 순서 — 스키마·커버리지(planShapeProblems)는 지나고 제출 규칙에서만 걸리는 초안
  const outside = { ...PLAN, files: PLAN.files.map((file) => file.path === "src/b.ts" ? { ...file, path: "lib/b.ts" } : file),
    tasks: PLAN.tasks.map((task) => task.id === "T2" ? { ...task, files: ["lib/b.ts"] } : task), sequence: [{ step: "app", why: " " }, { step: "test", why: "검증" }] };
  const work = loadWork(root)!;
  const expected = planRuleProblems(work, planFormatFor("feature").toPlan(planFormatFor("feature").schema.parse(outside)));
  assert.ok(expected.some((problem) => /lib\/b\.ts/.test(problem)) && expected.some((problem) => /순서의 이유/.test(problem)), expected.join("\n"));
  assert.throws(() => finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(outside), [`${DIR}/07-test-spec.md`]: TESTS }),
    (error: Error) => expected.every((problem) => error.message.includes(problem)));
  assert.equal(existsSync(join(root, DIR, "plan.json")), false, "정식 문서로 옮기지 않는다");
  // 같은 규칙을 지킨 초안은 hook·critic 을 지나 제출된다 — 제출의 최종 재검사도 같은 함수다
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  finish(dispatch("critic"));
  assert.match(submitPlan(root, join(root, DIR, "plan.json")), /계획을 제출하고/);
  // 제출 전에 사람이 매니페스트 단계 위치를 바꾸면(상태 변화) 최종 재검사가 막는다 — 입력이 바뀌어 게이트부터 낡는다
  const manifest = JSON.parse(readFileSync(join(root, "code-agent.json"), "utf8"));
  manifest.stages[0].outputDirs = ["lib"];
  writeFileSync(join(root, "code-agent.json"), JSON.stringify(manifest));
  assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /낡았|src\/a\.ts/);
});

test("교정 시도의 문서 검사 실패는 되돌리지 않고 실패로 기록한다", async () => {
  const item = (await advance()).assignments[0];
  const bad = REQUIREMENTS.replace('근거: "값을 반환한다."', "");
  malformed(item, { raw: JSON.stringify({ ...item.resultShape, status: "completed", summary: 123, evidence: [{ path: SPEC, line: 1 }], artifacts: [{ path: `${DIR}/01-requirements.md`, content: bad }] }) });
  const repaired = (await advance()).assignments[0];
  assert.equal(repaired.mode, "correction");
  startAgent(repaired, "corrector");
  quiet(() => assert.equal(runPlanningHook(stopEvent(repaired, "corrector", completed(repaired, { [`${DIR}/01-requirements.md`]: bad }))), 0));
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "failed");
});

test("같은 입력으로 세 번 실패하면 명시 배정도 거부하고 advance 는 한도 원인을 낸다", async () => {
  preparePlanning(root);
  for (let index = 0; index < 3; index++) {
    assert.throws(() => finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS }, { evidence: [{ path: "outside.ts", line: 1 }] }), /범위 밖/);
  }
  assert.throws(() => dispatch("analysis"), /3번 실패/);
  const blocked = (await advance()).blocked[0];
  assert.equal(blocked.class, "same-input-repeat");
  assert.deepEqual(blocked.counter, { key: "sameInput", used: 3, limit: 3 });
});

test("retry 기록이 없는 옛 계획 기록은 이행 시각 이후의 배정만 센다", async () => {
  preparePlanning(root);
  editPlanning((state) => {
    delete state.retry;
    state.tasks[0].attempts = Array.from({ length: 5 }, (_, index) => ({ dispatchId: `old-${index}`, inputHash: "old", at: "2026-01-01T00:00:00.000Z", status: "cancelled" as const }));
  });
  assert.equal((await advance()).action, "dispatch");
  const state = loadPlanning(loadWork(root)!);
  assert.ok(state.retry && Date.parse(state.retry.since) > Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(JSON.parse(planningStatus(root)).tasks[0].budget.taskTotal.used, 1);
});

test("사람 허용은 소진된 카운터에만 기록하고 그 범위의 한도를 늘린다", () => {
  preparePlanning(root);
  for (let index = 0; index < 6; index++) { dispatch("analysis"); cancelPlanning(root, "analysis"); }
  assert.throws(() => dispatch("analysis"), /총 6회/);
  assert.deepEqual({ ...planningBudget(root, "analysis").taskTotal }, { key: "taskTotal", used: 6, limit: 6, left: 0, exhausted: true });
  assert.throws(() => grantPlanningRetry(root, "sameInput", "analysis", "consent-1", "사유"), /한도가 남아 있어/);
  assert.match(grantPlanningRetry(root, "taskTotal", "analysis", "consent-2", "사람 판단"), /^작업 analysis의 작업 총 배정 한도를 6→9회로 늘렸습니다\(실행 회차 1 · 요구 항목 [0-9a-f]{8} 안에서만, 사람 판단, 동의 consent-2\)$/);
  assert.match(loadPlanning(loadWork(root)!).retry!.grants[0].scope, /^planning:analysis@c1-[0-9a-f]{12}$/);
  assert.equal(planningBudget(root, "analysis").taskTotal.limit, 9);
  assert.doesNotThrow(() => dispatch("analysis"));
});

test("계획 기록 잠금 — 죽은 주인·오래된 빈 잠금은 회수하고, 살아 있거나 다른 PC·주인 불명이면 사람에게 넘긴다", async () => {
  preparePlanning(root);
  const lock = `${planningJson()}.lock`, display = `.code-agent/work/${ID}/value.planning.json.lock`;
  const dead = deadPid();
  writeFileSync(lock, JSON.stringify({ pid: dead, host: hostname(), at: new Date().toISOString() }));
  await quietAsync(async (stderr) => { await assert.doesNotReject(async () => (await advance())); assert.match(stderr(), /계획 기록 잠금을 회수했습니다 — pid \d+ 종료/); });
  writeFileSync(lock, "");
  const old = new Date(Date.now() - 11 * 60_000);
  utimesSync(lock, old, old);
  await quietAsync(async (stderr) => { await assert.doesNotReject(async () => (await advance())); assert.match(stderr(), /주인 기록 없음, 1\d분 경과/); });
  writeFileSync(lock, "");
  let started = Date.now();
  await assert.rejects(async () => (await advance()), (error: Error) => error.message.includes(display) && /10분/.test(error.message));
  assert.ok(Date.now() - started < 1000, "주인 불명은 기다리지 않는다");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
  started = Date.now();
  await assert.rejects(async () => (await advance()), /pid \d+[\s\S]*다시 실행/);
  assert.ok(Date.now() - started >= 1500, "살아 있는 주인은 기다린 뒤 멈춘다");
  writeFileSync(lock, JSON.stringify({ pid: 1, host: "other-pc", at: new Date().toISOString() }));
  started = Date.now();
  await assert.rejects(async () => (await advance()), /다른 PC\(other-pc/);
  assert.ok(Date.now() - started < 1000);
  rmSync(lock);
  mkdirSync(join(root, "x"), { recursive: true });
  writeFileSync(join(root, "x/apply.lock"), "");
  assert.throws(() => acquireLock(join(root, "x/apply.lock"), { waitMs: 0, ageReclaim: false, label: "동의 적용", messages: { unknown: () => "지정한 문구" } }), (error: Error) => error.message === "지정한 문구");
  assert.throws(() => acquireLock(join(root, "x/apply.lock"), { waitMs: 0, ageReclaim: false, label: "동의 적용" }), (error: Error) => /apply\.lock 을 지운 뒤/.test(error.message) && !/10분/.test(error.message));
});
