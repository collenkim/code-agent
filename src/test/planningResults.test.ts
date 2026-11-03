import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { confirmForTest } from "./confirmedStart";
import { next, submitPlan, decide as approveCommand } from "../agent/commands";
import { decide as hook } from "../agent/hook";
import { withCaller } from "./reviewFixture";
import { loadActive } from "../agent/layout";
import { init } from "../agent/init";
import { cancelPlanning, preparePlanning, planningStatus, repairPlanning, planningResult } from "../agent/planning";
import { codexHook } from "../agent/codexHook";
import { withNotation } from "../agent/hostText";
import { observePlanner } from "../agent/planningHook";
import { loadPlanning, planningProblems } from "../agent/planningState";
import { approvalDocsHash, approvalOf, loadWork } from "../agent/work";
import { recordDecision } from "../core/approval";
import { REQUIREMENTS, IMPACT, DESIGN, FUNCTIONAL, TESTS, PLAN, root, advance, write, phase, dispatch, finish, handed, analysis, throughDesign, throughPlan, malformed, DIR, SPEC } from "./planningFixture";

test("형식 교정은 관찰 원본과 같은 입력을 재사용하고 늦은 결과·무관찰 완료를 막는다", async () => {
  const item = (await advance()).assignments[0], original = malformed(item);
  assert.equal(existsSync(join(root, DIR, "01-requirements.md")), false);
  assert.equal(JSON.parse(planningStatus(root)).tasks[0].state, "needs-correction");
  assert.throws(() => dispatch("analysis"), /교정/);
  const repaired = (await advance()).assignments[0];
  assert.equal(repaired.mode, "correction");
  assert.equal(JSON.parse(repaired.originalResponse).summary, 123);
  assert.notEqual(repaired.resultShape.dispatchId, item.resultShape.dispatchId);
  assert.equal(repaired.resultShape.inputHash, item.resultShape.inputHash);
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.length, 1);
  assert.throws(() => observePlanner({ ...original.event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify({ ...original.value, summary: "교정" }) }), /이미 처리/);
  observePlanner({ cwd: root, session_id: "forged", agent_id: "forged", agent_type: item.agent, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify({ ...repaired.resultShape, status: "completed" }) });
  assert.equal(existsSync(join(root, DIR, "01-requirements.md")), false);
  finish(repaired, { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
  assert.equal((await advance()).action, "ready-for-gate");
  assert.equal(JSON.parse(planningResult(root, "analysis")).last.correction.used, true);
});

test("Codex 관찰에서도 교정은 한 번만 허용하며 CLI 상세 조회에 원본 오류를 노출하지 않는다", async () => {
  const item = (await advance()).assignments[0]; malformed(item, { codex: true });
  const repaired = JSON.parse(repairPlanning(root, "analysis"));
  malformed(repaired, { codex: true });
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "failed");
  assert.throws(() => repairPlanning(root, "analysis"), /한 번/);
  assert.equal((await advance()).action, "blocked");
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.length, 1);
  const detail = JSON.parse(planningResult(root, "analysis"));
  assert.equal(detail.last.correction.raw, undefined);
});

test("형식 교정이 유효한 차단 지적과 문서 내용을 조용히 바꾸지 못한다", async () => {
  const item = (await advance()).assignments[0];
  const findings = [{ id: "F1", severity: "blocking", detail: "확인할 위험", source: { path: SPEC, line: 1 } }];
  malformed(item, { raw: JSON.stringify({ ...item.resultShape, status: "completed", summary: 123, findings, artifacts: [{ path: `${DIR}/01-requirements.md`, content: REQUIREMENTS }] }) });
  const repaired = (await advance()).assignments[0];
  assert.throws(() => finish(repaired, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }), /유효한 원본 findings/);
  assert.equal(existsSync(join(root, DIR, "01-requirements.md")), false);
});

test("교정도 입력 변경·취소·의미상 근거 오류를 우회하지 못한다", async () => {
  const item = (await advance()).assignments[0]; malformed(item);
  write(SPEC, readFileSync(join(root, SPEC), "utf8") + "\n추가 요구\n");
  assert.throws(() => repairPlanning(root, "analysis"), /입력이 바뀌/);
  cancelPlanning(root, "analysis");
  // 바뀐 지시서는 사람이 다시 확정해야 다시 배정한다
  await assert.rejects(advance(), /요구사항이 확정 뒤 바뀌었습니다/);
  confirmForTest(root, join(root, SPEC));
  assert.throws(() => repairPlanning(root, "analysis"), /교정할/);
  const second = (await advance()).assignments[0]; malformed(second);
  const repaired = JSON.parse(repairPlanning(root, "analysis"));
  assert.throws(() => finish(repaired, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }, { evidence: [{ path: "outside.ts", line: 1 }] }), /범위 밖/);
  assert.equal(existsSync(join(root, DIR, "01-requirements.md")), false);
});

test("깨진 JSON은 시작 때 배정이 유일한 경우만 교정하며 위조 식별자는 거부한다", async () => {
  const item = (await advance()).assignments[0]; malformed(item, { raw: "{broken" });
  assert.equal((await advance()).assignments[0].mode, "correction");
  cancelPlanning(root, "analysis");
  const second = (await advance()).assignments[0];
  const event = { cwd: root, session_id: "s", agent_id: "wrong-identity", agent_type: second.agent };
  observePlanner({ ...event, hook_event_name: "SubagentStart" });
  assert.throws(() => observePlanner({ ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify({ ...second.resultShape, dispatchId: "forged", summary: 1 }) }), /현재 배정/);
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.correction, undefined);
});

test("계획 CLI와 호스트 허용 명령은 진행·교정·상세 조회 계약을 공유한다", () => {
  const cli = join(__dirname, "../agent/cli.js");
  const reply = JSON.parse(execFileSync(process.execPath, [cli, "planning", "advance"], { cwd: root, encoding: "utf8" }));
  assert.equal(reply.action, "dispatch");
  malformed(handed(reply.assignments[0]));
  const repaired = handed(JSON.parse(execFileSync(process.execPath, [cli, "planning", "repair", "analysis"], { cwd: root, encoding: "utf8" })));
  assert.equal(repaired.mode, "correction");
  finish(repaired, { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
  const detail = JSON.parse(execFileSync(process.execPath, [cli, "planning", "result", "analysis"], { cwd: root, encoding: "utf8" }));
  assert.equal(detail.current, true);
  for (const command of ["advance", "repair analysis", "result analysis"]) assert.equal(hook({ cwd: root, tool_name: "Bash", tool_input: { command: `code-agent planning ${command}` } }), undefined);
});

for (const host of ["claude", "codex"] as const) test(`${host}: 설치된 절차로 형식 교정부터 독립 검토·승인 게이트까지 같은 기능을 제공한다`, async () => {
  init(root, { host });
  const skills = host === "claude" ? ".claude/skills" : ".agents/skills";
  const contract = readFileSync(join(root, skills, "ca-plan/contract.md"), "utf8");
  assert.match(contract, /mode:correction/);
  assert.match(contract, /planning result/); assert.match(contract, /ready-for-gate/);
  for (const name of ["ca-analyze", "ca-impact", "ca-design", "ca-plan"]) {
    const instructions = readFileSync(join(root, skills, name, "SKILL.md"), "utf8");
    assert.match(instructions, /planning advance/);
    assert.ok(instructions.includes(`${skills}/ca-plan/contract.md`), `${name}: 공통 계약 참조`);
  }
  const initial = (await advance()).assignments[0];
  malformed(initial, { codex: host === "codex" });
  finish((await advance()).assignments[0], { [`${DIR}/01-requirements.md`]: REQUIREMENTS }, {}, host);
  assert.equal((await advance()).action, "ready-for-gate"); next(root);
  finish((await advance()).assignments[0], { [`${DIR}/02-analysis.md`]: IMPACT }, { evidence: [{ path: "src/current.ts", line: 1 }] }, host);
  assert.equal((await advance()).action, "ready-for-gate"); next(root);
  finish((await advance()).assignments[0], { [`${DIR}/03-design.md`]: DESIGN, [`${DIR}/04-functional.md`]: FUNCTIONAL }, {}, host);
  assert.equal((await advance()).action, "ready-for-gate"); next(root);
  finish((await advance()).assignments[0], { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS }, {}, host);
  assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /critic/);
  finish((await advance()).assignments[0], {}, {}, host);
  assert.equal((await advance()).action, "ready-for-gate");
  submitPlan(root, join(root, DIR, "plan.json"));
  assert.throws(() => next(root), /승인/);
  assert.equal(loadActive(root)!.phase, "plan");
  const state = loadPlanning(loadWork(root)!);
  assert.deepEqual(state.tasks.map(item => item.task.role), ["analysis", "impact", "design", "plan", "critic"]);
  assert.ok(state.tasks.every(item => item.attempts.length === 1));
  assert.equal(JSON.parse(planningResult(root, "plan")).current, true);
});

test("병렬 실행의 식별자 없는 깨진 결과를 임의 작업의 교정으로 연결하지 않는다", async () => {
  analysis();
  const base = { role: "explore", title: "영역", requirements: ["R1"], inputs: [SPEC], scopes: ["src"], outputs: [], dependsOn: ["analysis"] };
  preparePlanning(root, { tasks: [{ ...base, id: "left" }, { ...base, id: "right" }] });
  const batch = (await advance()); assert.equal(batch.assignments.length, 2);
  const event = { cwd: root, session_id: "s", agent_id: "ambiguous", agent_type: "ca-explorer" };
  observePlanner({ ...event, hook_event_name: "SubagentStart" });
  assert.throws(() => observePlanner({ ...event, hook_event_name: "SubagentStop", last_assistant_message: "{broken" }), /현재 배정/);
  assert.ok(loadPlanning(loadWork(root)!).tasks.every(item => !item.attempts.at(-1)?.correction));
});

test("신규 시작은 관찰 결과 없이 다음 단계로 넘어갈 수 없다", () => {
  assert.equal(loadActive(root)?.planningVersion, 1);
  write(`${DIR}/01-requirements.md`, REQUIREMENTS);
  assert.throws(() => next(root), /관찰된/);
  assert.match(hook({ cwd: root, tool_name: "Write", tool_input: { file_path: join(root, DIR, "01-requirements.md") } })!, /관찰된/);
  assert.match(hook({ cwd: root, tool_name: "Bash", tool_input: { command: "code-agent planning-event" } })!, /hook/);
});

test("관찰된 전체 계획 → 승인 → 같은 단계의 독립 Task 구현", () => {
  throughPlan();
  const work = loadWork(root)!;
  recordDecision(root, { order: work.order, target: work.active.target, plan: work.plan!, manifest: work.manifest, decision: "approved", approver: "test", docsHash: approvalDocsHash(work), presence: { channel: "tty", verified: true, detail: "테스트" } });
  next(root); assert.equal(loadActive(root)?.task, "T1");
  assert.match(hook({ cwd: root, tool_name: "Write", tool_input: { file_path: join(root, "src/b.ts") } })!, /현재 Task/);
  assert.equal(hook({ cwd: root, tool_name: "Write", tool_input: { file_path: join(root, "src/a.ts") } }), undefined);
  assert.throws(() => next(root), /Task T1: 계획에 있는데 없는 파일: src\/a\.ts/);
  write("src/a.ts", "export const a = 1;"); next(root); assert.equal(loadActive(root)?.task, "T2");
  write("src/b.ts", "export const b = 1;"); next(root); assert.equal(loadActive(root)?.task, "T3");
  write("test/value.test.ts", "// TC-1\n"); next(root); assert.equal(loadActive(root)?.phase, "check");
  assert.equal(approvalOf(loadWork(root)!).status, "approved", "계획에 따른 구현은 승인 무효 사유가 아니다");
});

test("PVR-19 Task 의 계획 파일이 모두 기준 커밋과 같으면 다음 Task 로 넘기지 않는다 — 고치면 넘어가고 새 파일은 만들면 넘어간다", () => {
  const plan = { ...PLAN,
    files: [{ stage: "app", path: "src/current.ts", purpose: "기존 진입점", requirements: ["R1"] }, ...PLAN.files.slice(1)],
    tasks: [{ ...PLAN.tasks[0], files: ["src/current.ts"] }, ...PLAN.tasks.slice(1)] };
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(plan), [`${DIR}/07-test-spec.md`]: TESTS });
  finish(dispatch("critic"));
  submitPlan(root, join(root, DIR, "plan.json"));
  const work = loadWork(root)!;
  recordDecision(root, { order: work.order, target: work.active.target, plan: work.plan!, manifest: work.manifest, decision: "approved", approver: "test", docsHash: approvalDocsHash(work), presence: { channel: "tty", verified: true, detail: "테스트" } });
  next(root); assert.equal(loadActive(root)?.task, "T1");
  assert.throws(() => next(root), /Task T1의 계획 파일이 기준 커밋과 같습니다\(바뀐 파일 없음\): src\/current\.ts/);
  assert.equal(loadActive(root)?.task, "T1", "커서는 그대로다");
  write("src/current.ts", "export const current = 2;\n");
  next(root); assert.equal(loadActive(root)?.task, "T2");
  // T2 는 새 파일 — 만들면 넘어간다(새 파일은 판단하지 않는다)
  write("src/b.ts", "export const b = 1;"); next(root); assert.equal(loadActive(root)?.task, "T3");
});

test("계획 검토 누락·차단 지적·초안 변조는 제출과 승인을 막는다", () => {
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /critic/);
  finish(dispatch("critic"), {}, { findings: [{ id: "F1", severity: "blocking", detail: "요구 누락", source: { path: SPEC, line: 1 } }] });
  assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /차단 지적/);
});

test("검토 완료 뒤 문서·소스 변경으로 결과가 오래되면 승인하지 않는다", () => {
  throughPlan();
  write("src/current.ts", "export const current = 2;");
  assert.throws(() => approveCommand(root, "approved"), /관찰된|오래/);
  write(`${DIR}/plan.json`, JSON.stringify({ ...PLAN, reasoning: "바꿈" }));
  assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /관찰된|오래/);
});

test("영역별 병렬 배정·합류와 같은 입력 결과 재사용", () => {
  analysis();
  const base = { role: "explore", title: "영역 조사", requirements: ["R1"], inputs: [SPEC], outputs: [], dependsOn: ["analysis"] };
  preparePlanning(root, { maxParallel: 2, tasks: [{ ...base, id: "left", scopes: ["src"] }, { ...base, id: "right", scopes: ["other"] }, { id: "synthesis", role: "synthesis", title: "합성", requirements: ["R1"], inputs: [SPEC], outputs: [`${DIR}/02-analysis.md`], dependsOn: ["left", "right"] }] });
  const left = dispatch("left"), right = dispatch("right");
  assert.ok(left.inputs.includes("src/current.ts")); assert.ok(!left.inputs.includes("other/current.ts"));
  assert.throws(() => dispatch("synthesis"), /선행/);
  finish(right); finish(left);
  assert.equal(dispatch("left").cached, true);
  write("other/current.ts", "export const other = 2;");
  assert.equal(dispatch("left").cached, true);
  assert.throws(() => dispatch("synthesis"), /선행/);
  finish(dispatch("right"));
  finish(dispatch("synthesis"), { [`${DIR}/02-analysis.md`]: IMPACT });
  assert.deepEqual(planningProblems(loadWork(root)!, "impact"), []);
});

test("상충하는 영역 사실은 조용히 합쳐지지 않는다", () => {
  analysis();
  const base = { role: "explore", title: "영역", requirements: ["R1"], inputs: [SPEC], scopes: ["src"], outputs: [], dependsOn: ["analysis"] };
  preparePlanning(root, { tasks: [{ ...base, id: "left" }, { ...base, id: "right" }, { id: "synthesis", role: "synthesis", title: "합성", requirements: ["R1"], inputs: [SPEC], outputs: [`${DIR}/02-analysis.md`], dependsOn: ["left", "right"] }] });
  for (const [id, value] of [["left", "1"], ["right", "2"]]) finish(dispatch(id), {}, { facts: [{ key: "반환값", value, source: { path: "src/current.ts", line: 1 } }] });
  assert.throws(() => dispatch("synthesis"), /충돌/);
});

test("취소·중복 완료·잘못된 근거 및 실행 도중 변경은 완료로 받아들이지 않는다", () => {
  preparePlanning(root); const old = dispatch("analysis");
  const event = { cwd: root, session_id: "old", agent_id: "cancelled", agent_type: old.agent };
  observePlanner({ ...event, hook_event_name: "SubagentStart" }); cancelPlanning(root, "analysis");
  assert.throws(() => observePlanner({ ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify({ ...old.resultShape, status: "completed", artifacts: [{ path: `${DIR}/01-requirements.md`, content: REQUIREMENTS }] }) }), /현재 배정/);
  const current = dispatch("analysis");
  const completed = finish(current, { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
  assert.throws(() => observePlanner({ ...completed.event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify(completed.result) }), /이미 처리/);
  phase("impact"); preparePlanning(root);
  assert.throws(() => finish(dispatch("explore"), {}, { evidence: [{ path: "src/current.ts", line: 999 }] }), /범위/);
  const rerun = dispatch("explore"); write("src/current.ts", "export const current=3;");
  assert.throws(() => finish(rerun), /입력이 바뀌/);
  const last = loadPlanning(loadWork(root)!).tasks.find((record) => record.task.id === "explore")!.attempts.at(-1)!;
  assert.equal(last.status, "cancelled", "실행 중 입력이 바뀐 배정은 취소한다 — 새 입력으로 다시 배정한다");
  assert.equal(last.failure?.class, "dispatch-orphan");
});

test("Codex 담당의 배정 계약도 staging 이다 — 두 호스트 설치·Codex 단일 설치, 어느 쪽이 불러도 같고 쓰기 도구 이름만 호스트 표기다(E9)", () => {
  const output = `${DIR}/01-requirements.md`;
  preparePlanning(root);
  // 배정 한도(작업별 총 6회) 안에서 본다 — 두 호스트 설치의 두 호출, Codex 단일 설치의 Claude 표지 호출, 표기 둘
  for (const [hosts, caller] of [[["claude", "codex"], "claude"], [["claude", "codex"], "codex"], [["codex"], "claude"]] as const) {
    writeFileSync(join(root, ".code-agent/hosts.json"), JSON.stringify(hosts));
    const item = withCaller(caller, () => dispatch("analysis"));
    const label = `${hosts.join("+")} · ${caller}`;
    assert.equal(item.staging[output], `${DIR}/.staging/${item.resultShape.dispatchId}/01-requirements.md`, label);
    assert.deepEqual(item.resultShape.artifacts, [{ path: output, staged: item.staging[output] }], label);
    cancelPlanning(root, "analysis");
  }
  assert.ok(withNotation("claude", () => dispatch("analysis")).instructions.includes("staging의 경로에 Write/Edit 로 전체 내용을 쓰고"), "Claude 표기면 Write/Edit");
  cancelPlanning(root, "analysis");
  const again = withNotation("codex", () => dispatch("analysis"));
  assert.ok(again.instructions.includes("출력 문서는 staging의 경로에 apply_patch 로 전체 내용을 쓰고 artifacts에는 {path, staged}만 넣으세요"), again.instructions);
  // Codex 담당이 staging 에 쓰고 경로만 돌려준 결과가 기록된다 — 본문이 결과 JSON(메인 대화)을 거치지 않는다
  const event = { cwd: root, session_id: "s", agent_id: "codex-staged", agent_type: again.hostAgents.codex };
  codexHook({ ...event, hook_event_name: "SubagentStart" });
  write(again.staging[output], REQUIREMENTS);
  const result = { ...again.resultShape, status: "completed", summary: "실제 근거 확인", evidence: [{ path: SPEC, line: 1 }] };
  codexHook({ ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify(result) });
  assert.equal(readFileSync(join(root, output), "utf8"), REQUIREMENTS);
  assert.equal(existsSync(join(root, again.staging[output])), false, "완료하면 staging 을 지운다");
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "completed");
});
