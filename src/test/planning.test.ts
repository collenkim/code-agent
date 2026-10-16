import { strict as assert } from "node:assert";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { start } from "./confirmedStart";
import { observeQuestionAnswers, prepareConsentFixture } from "./consentFixture";
import { back, next, status, submitPlan, decide as approveCommand } from "../agent/commands";
import { decide as hook } from "../agent/hook";
import { contextHandoff, handoffPlanning } from "../agent/handoff";
import { crossCritic, CrossCriticSchema, planningCrossBudgets } from "../agent/crossCheck";
import { previewCrossStop, previewWaiveFinding, recordCrossStop, waiveFinding } from "../agent/reviewJudgment";
import { withCaller } from "./reviewFixture";
import { sessionAnchor } from "../agent/sessionHook";
import { planningAdvanceCli, planningNextLine } from "../agent/planningChain";
import { context } from "../agent/commands";
import { checkProjectDocs, recordDocConfirmation } from "../agent/docs";
import { loadActive, saveActive } from "../agent/layout";
import { init, installedHook, unmatchedTools } from "../agent/init";
import { cancelPlanning, dispatchPlanning, grantPlanningRetry, planningBudget, preparePlanning, planningStatus, advancePlanning, repairPlanning, planningResult } from "../agent/planning";
import { codexHook, runCodexHook } from "../agent/codexHook";
import { withNotation } from "../agent/hostText";
import { hostAssets } from "../agent/hosts";
import { readProjectFile } from "../agent/read";
import { observePlanner, runPlanningHook } from "../agent/planningHook";
import { fileHash, hashedQuestion, inputFiles, invalidatePlanningCache, loadPlanning, planningProblems, taskCurrent, taskHash, TaskSchema, ResultSchema, withPlanningCache, type PlanningResult, type PlanningState } from "../agent/planningState";
import { planningDocumentProblems, planRuleProblems } from "../agent/planningValidation";
import { planFormatFor } from "../core/plan";
import { parseQuestions, type Question } from "../agent/questions";
import { acquireLock } from "../agent/lock";
import { orphanState, RetryRefused } from "../agent/retryPolicy";
import { sha } from "../agent/docs";
import { writeAtomic } from "../core/atomic";
import { approvalDocsHash, approvalOf, loadWork } from "../agent/work";
import { hashManifest, recordDecision } from "../core/approval";
import { loadManifest } from "../core/manifest";
import { sequenceProblems } from "../core/plan";
import { withInteraction } from "../agent/tty";
import { deadPid } from "./deadPid";

import { ID, REQUIREMENTS, IMPACT, DESIGN, FUNCTIONAL, TESTS, PLAN, root, advance, write, phase, dispatch, finish, handed, analysis, throughDesign, throughPlan, malformed, crossPlanningSetup, crossProblems, planningJson, editPlanning, ago, answer, quiet, quietAsync, captured, startAgent, stopEvent, completed, toDesign, DUPLICATED_AC, chain, chainedWithoutGate, DIR, SPEC } from "./planningFixture";

test("계획 전달은 문서 원문을 중복하지 않고 판단·해시·상세 조회를 보존한다", async () => {
  const item = (await advance()).assignments[0];
  const content = REQUIREMENTS + "\n" + "원문전용 자료\n".repeat(5000);
  finish(item, { [`${DIR}/01-requirements.md`]: content }, { findings: [{ id: "F1", severity: "advisory", detail: "검토 필요", source: { path: SPEC, line: 1 } }] });
  const cached = dispatch("analysis");
  assert.equal(cached.cached, true);
  assert.equal(cached.result.findings[0].detail, "검토 필요");
  assert.match(cached.result.artifacts[0].hash, /^[a-f0-9]{64}$/);
  assert.equal(cached.result.artifacts[0].chars, content.length);
  assert.equal(cached.result.artifacts[0].content, undefined);
  const detailText = planningResult(root, "analysis");
  const detail = JSON.parse(detailText);
  assert.equal(detail.current, true);
  // 기록된 문서와 같은 본문은 상세 조회에서도 되풀이하지 않는다 — 그 파일을 읽는다
  assert.deepEqual(detail.last.result.artifacts[0], { path: `${DIR}/01-requirements.md`, hash: cached.result.artifacts[0].hash, chars: content.length, inFile: true });
  assert.equal(detail.last.result.findings[0].detail, "검토 필요", "판단·지적은 그대로다");
  assert.ok(detailText.length < 5000, `상세 조회 ${detailText.length}자`);
  assert.doesNotMatch(planningStatus(root), /원문전용/);
  next(root);
  const explorer = (await advance()).assignments[0];
  assert.equal(explorer.dependencies[0].artifacts[0].content, undefined);
  assert.equal(explorer.dependencies[0].findings[0].detail, "검토 필요");
  assert.ok(explorer.inputs.includes(`${DIR}/01-requirements.md`));
  assert.ok(JSON.stringify(explorer.dependencies).length < content.length / 10);
  write(`${DIR}/01-requirements.md`, REQUIREMENTS);
  const changed = JSON.parse(planningResult(root, "analysis"));
  assert.equal(changed.current, false);
  assert.equal(changed.last.result.artifacts[0].content, content, "파일이 바뀌면 관찰된 본문을 그대로 싣는다");
});

test("계획 진행은 준비·배정을 합치고 반복 호출·캐시·단계 게이트를 구분한다", async () => {
  const first = (await advance());
  assert.equal(first.action, "dispatch"); assert.equal(first.assignments.length, 1);
  assert.equal((await advance()).action, "wait");
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.length, 1);
  finish(first.assignments[0], { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
  assert.equal((await advance()).action, "ready-for-gate");
  assert.deepEqual((await advance()).reused, ["analysis"]);
  assert.equal(loadActive(root)!.phase, "analysis");
  next(root);
  const impact = (await advance());
  assert.deepEqual(impact.assignments.map((item: any) => item.task.role), ["impact"]);
  assert.match(impact.assignments[0].delegation, /한 담당/);
  finish(impact.assignments[0], { [`${DIR}/02-analysis.md`]: IMPACT });
  assert.equal((await advance()).action, "ready-for-gate");
});

for (const size of ["files", "bytes", "requirements"] as const) test(`자동 영향도 통합은 작은 범위만 선택한다: ${size}`, async () => {
  preparePlanning(root);
  finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS + (size === "requirements" ? [2, 3, 4].map(n => `\n## R${n} · 값 확인\n근거: "값을 반환한다."`).join("") : "") });
  next(root);
  if (size === "files") for (let i = 0; i < 13; i++) write(`src/file${i}.ts`, "export const value=1;");
  if (size === "bytes") write("src/large.ts", " ".repeat(96_001));
  const reply = (await advance());
  assert.equal(reply.assignments[0].task.role, "explore");
  assert.deepEqual(loadPlanning(loadWork(root)!).tasks.map(record => record.task.role), ["analysis", "explore", "synthesis"]);
});

test("설치된 호스트 지침·단계 템플릿은 작은 조사 판정과 새 범위 입력에서 제외한다", async () => {
  init(root, { host: "both" });
  analysis();
  const item = (await advance()).assignments[0];
  assert.equal(item.task.role, "impact");
  assert.ok(!item.inputs.includes("CLAUDE.md")); assert.ok(!item.inputs.includes("AGENTS.md"));
  assert.ok(!item.inputs.some((file: string) => file.startsWith("doc/code-agent/")));
  const legacy = { ...item.task }; delete legacy.contextVersion;
  assert.ok(inputFiles(loadWork(root)!, legacy).includes("CLAUDE.md"));
  assert.ok(inputFiles(loadWork(root)!, { ...item.task, inputs: [...item.task.inputs, "AGENTS.md"] }).includes("AGENTS.md"));
  const work = loadWork(root)!, state = loadPlanning(work), before = taskHash(work, state, item.task);
  write("AGENTS.md", readFileSync(join(root, "AGENTS.md"), "utf8") + "\n사용자가 보완한 프로젝트 지침\n");
  assert.notEqual(taskHash(work, state, item.task), before);
});

test("통합 조사도 실제 관찰·출력·질문·차단 지적을 요구하고 분할 조사와 중복하지 않는다", async () => {
  analysis();
  const item = (await advance()).assignments[0];
  assert.equal(item.task.role, "impact");
  assert.throws(() => next(root), /관찰된 완료/);
  assert.throws(() => finish(item), /출력 문서 전체/);
  assert.equal((await advance()).action, "blocked");
  finish(dispatch("impact"), { [`${DIR}/02-analysis.md`]: IMPACT }, { findings: [{ id: "F1", severity: "blocking", detail: "영향 재확인", source: { path: SPEC, line: 1 } }] });
  assert.equal((await advance()).action, "blocked");
  assert.throws(() => next(root), /차단 지적/);
  assert.throws(() => preparePlanning(root, { tasks: [{ id: "extra", role: "explore", title: "추가", requirements: ["R1"], inputs: [SPEC], scopes: ["src"], dependsOn: ["analysis"] }] }), /함께 등록/);
});

test("좁은 전달은 직접 선행 문서와 역할 정책만 보내고 독립 검토·명시 입력·기존 계약은 보존한다", () => {
  analysis();
  const task = TaskSchema.parse({ id: "scoped", role: "explore", contextVersion: 2, title: "영역", requirements: ["R1"], inputs: [SPEC], scopes: ["src"], dependsOn: ["analysis"] });
  const work = loadWork(root)!;
  const files = inputFiles(work, task);
  assert.ok(files.includes("doc/architecture.md")); assert.ok(files.includes("doc/conventions.md"));
  assert.ok(!files.includes("doc/quality.md")); assert.ok(!files.includes("doc/test-strategy.md")); assert.ok(!files.includes("other/current.ts"));
  assert.ok(!inputFiles(work, { ...task, scopes: ["."] }).includes("doc/quality.md"));
  assert.ok(inputFiles(work, { ...task, inputs: [...task.inputs, "doc/quality.md"] }).includes("doc/quality.md"));
  const legacy = { ...task }; delete legacy.contextVersion;
  assert.ok(inputFiles(work, legacy).includes("doc/quality.md"));
  preparePlanning(root); finish(dispatch("explore")); finish(dispatch("synthesis"), { [`${DIR}/02-analysis.md`]: IMPACT }); next(root);
  preparePlanning(root);
  const design = dispatch("design");
  // contextVersion 3 부터(새 작업은 4) — analysis·design 은 테스트 전략·품질 기준을 받지 않는다(plan·critic 은 받는다). 옛 계약(2)은 그대로 넷 다
  assert.equal(design.task.contextVersion, 4);
  assert.ok(design.inputs.includes("doc/architecture.md")); assert.ok(!design.inputs.includes("doc/quality.md")); assert.ok(!design.inputs.includes("doc/test-strategy.md"));
  assert.ok(!inputFiles(loadWork(root)!, { ...loadPlanning(loadWork(root)!).tasks.find(record => record.task.role === "analysis")!.task, contextVersion: 3 }).includes("doc/quality.md"));
  assert.ok(inputFiles(loadWork(root)!, { ...design.task, contextVersion: 2 }).includes("doc/quality.md"));
  finish(design, { [`${DIR}/03-design.md`]: DESIGN, [`${DIR}/04-functional.md`]: FUNCTIONAL }); next(root);
  preparePlanning(root);
  const plan = dispatch("plan");
  assert.ok(plan.inputs.includes("doc/quality.md")); assert.ok(plan.inputs.includes("doc/test-strategy.md"));
  assert.ok(plan.inputs.includes(`${DIR}/01-requirements.md`)); assert.ok(plan.inputs.includes(`${DIR}/03-design.md`));
  assert.ok(plan.inputs.includes(`${DIR}/02-analysis.md`));
  assert.ok(inputFiles(loadWork(root)!, { ...plan.task, contextVersion: undefined }).includes(`${DIR}/02-analysis.md`));
  finish(plan, { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  const critic = dispatch("critic");
  for (const file of ["01-requirements.md", "02-analysis.md", "03-design.md", "04-functional.md", "plan.json", "07-test-spec.md"]) assert.ok(critic.inputs.includes(`${DIR}/${file}`));
});

test("통합 영향도 결과의 상충하는 사실도 게이트를 통과하지 못한다", async () => {
  analysis();
  finish((await advance()).assignments[0], { [`${DIR}/02-analysis.md`]: IMPACT }, { facts: [
    { key: "반환값", value: "1", source: { path: "src/current.ts", line: 1 } },
    { key: "반환값", value: "2", source: { path: "src/current.ts", line: 1 } },
  ] });
  assert.equal((await advance()).action, "blocked");
  assert.throws(() => next(root), /충돌/);
});

test("선행 실행 ID만 바뀌면 새 계약의 결과를 재사용하고 내용 변경·미완료는 구분한다", () => {
  analysis();
  const scoped = TaskSchema.parse({ id: "scoped", role: "explore", contextVersion: 2, title: "영역", requirements: ["R1"], inputs: [SPEC], scopes: ["src"], dependsOn: ["analysis"] });
  preparePlanning(root, { tasks: [scoped] }); finish(dispatch("scoped"));
  const before = loadPlanning(loadWork(root)!);
  const legacy = { ...scoped }; delete legacy.contextVersion;
  const legacyHash = taskHash(loadWork(root)!, before, legacy);
  phase("analysis");
  write(`${DIR}/feedback.md`, "인용을 다시 확인한다");
  const analysisTask = before.tasks.find(record => record.task.role === "analysis")!.task;
  preparePlanning(root, { tasks: [{ ...analysisTask, inputs: [...analysisTask.inputs, `${DIR}/feedback.md`] }] });
  const rerun = dispatch("analysis"); phase("impact");
  assert.throws(() => dispatch("scoped"), /선행 작업/);
  phase("analysis"); finish(rerun, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }); phase("impact");
  assert.equal(dispatch("scoped").cached, true);
  assert.notEqual(taskHash(loadWork(root)!, loadPlanning(loadWork(root)!), legacy), legacyHash);
  phase("analysis"); write(`${DIR}/feedback.md`, "판단을 다시 확인한다");
  finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS }, { summary: "영향 판단을 보완했다" }); phase("impact");
  assert.equal(dispatch("scoped").cached, false);
});

test("계획 진행은 사용자 영역 분할·동시 한도·미결 질문과 사실 충돌을 유지한다", async () => {
  analysis();
  const base = { role: "explore", title: "영역", requirements: ["R1"], inputs: [SPEC], scopes: ["src"], outputs: [], dependsOn: ["analysis"] };
  preparePlanning(root, { maxParallel: 1, tasks: [{ ...base, id: "left" }, { ...base, id: "right" }] });
  const first = (await advance()); assert.equal(first.assignments.length, 1);
  assert.equal(first.assignments[0].task.id, "left");
  finish(first.assignments[0], {}, { facts: [{ key: "값", value: "1", source: { path: "src/current.ts", line: 1 } }] });
  const second = (await advance()); assert.equal(second.assignments[0].task.id, "right");
  finish(second.assignments[0], {}, { facts: [{ key: "값", value: "2", source: { path: "src/current.ts", line: 1 } }] });
  const conflict = (await advance()); assert.equal(conflict.action, "blocked"); assert.equal(conflict.assignments.length, 0);
  assert.match(JSON.stringify(conflict.blocked), /충돌/);
  write(`${DIR}/questions.md`, "# 질문\n## Q1 · 확인\n값은?\n[Requirements]: R1\n[Answer]:\n");
  assert.equal((await advance()).action, "blocked");
  assert.match(JSON.stringify((await advance()).blocked), /미결 질문/);
});

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
  for (const name of ["ca-analyze", "ca-impact", "ca-design", "ca-plan"]) {
    const instructions = readFileSync(join(root, skills, name, "SKILL.md"), "utf8");
    assert.match(instructions, /planning advance/); assert.match(instructions, /mode:correction/);
    assert.match(instructions, /planning result/); assert.match(instructions, /ready-for-gate/);
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
  assert.throws(() => next(root), /아직 없습니다/);
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

test("미결 질문은 실제 답을 받은 뒤 해당 입력을 다시 배정한다", () => {
  preparePlanning(root);
  finish(dispatch("analysis"), {}, { status: "needs-input", questions: [{ id: "Q1", question: "값 선택", requirements: ["REQ-1"] }] });
  assert.ok(existsSync(join(root, DIR, "questions.md")));
  assert.throws(() => dispatch("analysis"), /미결 질문/);
  const question = readFileSync(join(root, DIR, "questions.md"), "utf8");
  write(`${DIR}/questions.md`, question.replace(/^\[Answer\]:/m, "[Answer]: 보류"));
  assert.throws(() => dispatch("analysis"), /미결 질문/);
  write(`${DIR}/questions.md`, question.replace(/^\[Answer\]:/m, "[Answer]: 1로 결정"));
  finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS }); next(root);
});

test("출처를 확인할 수 없는 답은 답 없는 질문과 다른 사유로 막는다 — 방금 답을 적은 쪽이 이유를 안다(E6)", async () => {
  preparePlanning(root);
  finish(dispatch("analysis"), {}, { status: "needs-input", questions: [{ id: "Q1", question: "값 선택", requirements: ["REQ-1"] }] });
  const question = readFileSync(join(root, DIR, "questions.md"), "utf8");
  // 질문 도구 관찰 없이 답만 적는다(write 헬퍼는 관찰을 흉내 내므로 쓰지 않는다)
  writeFileSync(join(root, DIR, "questions.md"), question.replace(/^\[Answer\]:/m, "[Answer]: 1로 결정"));
  assert.throws(() => dispatch("analysis"), (error: Error) =>
    /답 출처 미확인 Q1 — 질문 도구 응답이 관찰되지 않은 답입니다[\s\S]*\[Source\]: 대화/.test(error.message) && !/미결 질문 Q1/.test(error.message));
  assert.match(JSON.stringify((await advance()).blocked), /답 출처 미확인 Q1/);
  const line = status(root).split("\n").find((entry) => entry.startsWith("다음: "))!;
  assert.match(line, /^다음: 답이 없거나 출처를 확인할 수 없는 질문 1개 — \S+ca-answer \(답 출처 미확인 Q1 — /);
});

test("내용 없는 AC·근거 없는 BR·미결 설계·가짜 파일 근거를 차단한다", () => {
  write(`${DIR}/01-requirements.md`, REQUIREMENTS); write(`${DIR}/02-analysis.md`, IMPACT.replace("src/current.ts:1", "missing.ts:1"));
  write(`${DIR}/03-design.md`, DESIGN + "\n확인 필요: 데이터 경계");
  write(`${DIR}/04-functional.md`, FUNCTIONAL.replace(" (src/current.ts:1)", "").replace("호출하면 숫자가 반환된다", ""));
  const problems = planningDocumentProblems(loadWork(root)!, "design").join("\n");
  assert.match(problems, /근거 파일/); assert.match(problems, /미결/); assert.match(problems, /완료 조건/); assert.match(problems, /업무 규칙/);
});

test("04 의 업무 규칙은 업무 정책 문서에 있는 BR 키로 근거를 댈 수 있다 — 키 일부만 같은 것은 아니다", () => {
  write(`${DIR}/01-requirements.md`, REQUIREMENTS); write(`${DIR}/02-analysis.md`, IMPACT); write(`${DIR}/03-design.md`, DESIGN);
  write("doc/knowledge/business-rules.md", "# 업무 규칙\n\n### `BR-RET-1` 숫자 반환\n- 구분: 필수\n- 상태: 확정\n- 출처: 사용자 결정\n");
  const rule = (key: string) => FUNCTIONAL.replace("- BR-1: 숫자 반환 (src/current.ts:1)", `- ${key}: 숫자 반환`);
  write(`${DIR}/04-functional.md`, rule("BR-RET-1"));
  assert.doesNotMatch(planningDocumentProblems(loadWork(root)!, "design").join("\n"), /업무 규칙/);
  write(`${DIR}/04-functional.md`, rule("BR-RET-10"));
  assert.match(planningDocumentProblems(loadWork(root)!, "design").join("\n"), /\[FUN-BR\] .*04-functional\.md:5: 업무 규칙 BR-RET-10 에 근거가 없습니다 — 실제 파일:줄 · 답변된 Q 번호 · 업무 정책 문서의 BR 키/);
});

test("잘못된 DAG·출력 소유·Task 순환 및 중복 파일을 거부한다", () => {
  const task = TaskSchema.parse({ id: "analysis", role: "analysis", title: "분석", requirements: ["REQ-1"], inputs: [SPEC], outputs: [`${DIR}/01-requirements.md`], dependsOn: ["analysis"] });
  assert.throws(() => preparePlanning(root, { tasks: [task] }), /순환/);
  assert.throws(() => preparePlanning(root, { tasks: [{ ...task, dependsOn: [], outputs: ["src/current.ts"] }] }), /출력/);
  const plan = structuredClone(PLAN); plan.tasks[0].dependsOn = ["T2"]; plan.tasks[1].files = ["src/a.ts"];
  assert.ok(sequenceProblems(plan, loadWork(root)!.stages, "feature").length >= 2);
});

test("취소는 같은 입력 한도에 세지 않고 작업별 총 배정 6회에서 멈춘다", async () => {
  preparePlanning(root);
  for (let index = 0; index < 3; index++) { dispatch("analysis"); cancelPlanning(root, "analysis"); }
  assert.doesNotThrow(() => dispatch("analysis"), "세 번 취소한 뒤 네 번째 배정은 허용한다 — 취소는 같은 입력 실패가 아니다");
  cancelPlanning(root, "analysis");
  for (let index = 0; index < 2; index++) { dispatch("analysis"); cancelPlanning(root, "analysis"); }
  // 거부 문구는 지금 실행할 수 있는 길만 안내한다 — 다시 준비해도 시도 기록이 남아 한도가 풀리지 않는다
  assert.throws(() => dispatch("analysis"), (error: Error) => /총 6회/.test(error.message) && /다시 준비[^.]*그대로/.test(error.message) && !/한도 \+3|재계획/.test(error.message));
  assert.equal(JSON.parse(planningStatus(root)).tasks[0].attempts, 6);
  const blocked = (await advance()).blocked[0];
  assert.equal(blocked.class, "reassign-total");
  assert.deepEqual(blocked.counter, { key: "taskTotal", used: 6, limit: 6 });
  preparePlanning(root);
  assert.throws(() => dispatch("analysis"), /총 6회/);
});

test("보류·설명 메모·명시 미응답 상태와 중복 질문은 답변이 아니다", () => {
  for (const value of ["보류", "보류합니다.", "보류\n나중에 결정할 예정", "C. 보류 — 나중에 결정", "\n상태: 답변 대기", "A\n[Status]: deferred"]) assert.equal(parseQuestions(`## Q1 질문\n[Answer]: ${value}`)[0].answer, "");
  assert.equal(parseQuestions("## Q1 질문\n[Answer]: 보류 주문도 조회한다")[0].answer, "보류 주문도 조회한다");
  assert.ok(parseQuestions("## Q1 질문\n[Answer]: A\n[Status]: answered")[0].answer);
  assert.ok(parseQuestions("## Q1 질문\n[Answer]: A\n## Q1 중복\n[Answer]: B").every(item => !item.answer));
});

test("병렬 배정 한도와 관련 질문에 따른 선택적 무효화", () => {
  preparePlanning(root);
  finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS + '\n## R2 · 다른 반환\n근거: "값을 반환한다."' }); next(root);
  const base = { role: "explore", title: "영역", inputs: [SPEC], outputs: [], dependsOn: ["analysis"] };
  preparePlanning(root, { maxParallel: 1, tasks: [{ ...base, id: "left", requirements: ["R1"], scopes: ["src"] }, { ...base, id: "right", requirements: ["R2"], scopes: ["other"] }] });
  const left = dispatch("left"); assert.throws(() => dispatch("right"), /동시 실행 한도/); finish(left); finish(dispatch("right"));
  write(`${DIR}/questions.md`, "## Q9 결정\n[Requirements]: R2\n[Answer]:\n");
  assert.equal(dispatch("left").cached, true);
  assert.throws(() => dispatch("right"), /미결 질문/);
  write(`${DIR}/questions.md`, "## Q9 결정\n[Requirements]: R2\n[Answer]: 기존 반환 유지\n");
  assert.equal(dispatch("left").cached, true); finish(dispatch("right"));
  assert.equal(dispatch("right").cached, true);
  write(`${DIR}/questions.md`, "## Q9 결정\n바뀐 질문의 의미\n[Requirements]: R2\n[Answer]: 기존 반환 유지\n");
  assert.equal(dispatch("left").cached, true); assert.equal(dispatch("right").cached, false);
});

test("병렬 담당이 같은 Q 번호를 내도 버리지 않고 코드가 이어 붙인 번호로 기록한다", () => {
  preparePlanning(root);
  finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS + '\n## R2 · 다른 반환\n근거: "값을 반환한다."' }); next(root);
  const base = { role: "explore", title: "영역", inputs: [SPEC], outputs: [], dependsOn: ["analysis"] };
  preparePlanning(root, { tasks: [{ ...base, id: "left", requirements: ["R1"], scopes: ["src"] }, { ...base, id: "right", requirements: ["R2"], scopes: ["other"] }] });
  const left = dispatch("left"), right = dispatch("right");
  const ask = (requirement: string): Partial<PlanningResult> => ({ status: "needs-input", questions: [{ id: "Q1", question: `${requirement} 값은?`, requirements: [requirement] }] });
  finish(left, {}, ask("R1"));
  finish(right, {}, ask("R2"));
  const body = readFileSync(join(root, DIR, "questions.md"), "utf8");
  assert.deepEqual([...body.matchAll(/^## (Q\d+)/gm)].map((match) => match[1]), ["Q1", "Q2"]);
  assert.equal(loadPlanning(loadWork(root)!).tasks.find((task) => task.task.id === "right")!.attempts.at(-1)!.result!.questions[0].id, "Q2", "결과의 번호도 문서와 같다");
});

test("관찰되지 않은 결과는 문서를 만들지 않으며 잘못된 출력 경로는 거부한다", () => {
  preparePlanning(root); const item = dispatch("analysis");
  observePlanner({ cwd: root, session_id: "forged", agent_id: "forged", agent_type: item.agent, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify({ ...item.resultShape, status: "completed", artifacts: [{ path: `${DIR}/01-requirements.md`, content: REQUIREMENTS }] }) });
  assert.equal(existsSync(join(root, DIR, "01-requirements.md")), false);
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)?.status, "running");
  assert.throws(() => finish(item, { "src/current.ts": "overwrite" }), /출력 문서/);
  assert.match(readFileSync(join(root, "src/current.ts"), "utf8"), /current = 1/);
});

test("설치와 재설치는 계획 관찰 hook 둘을 중복 없이 유지한다", () => {
  init(root); init(root);
  const settings = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
  assert.equal(Object.values(settings.hooks).flat().length, 9);
  assert.match(installedHook(root, "SessionStart", "session-event")!, /session-event$/);
  for (const event of ["SubagentStart", "SubagentStop"]) {
    assert.match(installedHook(root, event, "planning-event")!, /planning-event$/);
    assert.match(installedHook(root, event, "review-event")!, /review-event$/);
    assert.deepEqual(unmatchedTools(root, event, "ca-analyst|ca-explorer|ca-writer|ca-critic", "planning-event"), []);
  }
});

test("영역 내 파일 추가·삭제도 재사용을 무효화한다", () => {
  analysis(); preparePlanning(root); finish(dispatch("explore"));
  assert.equal(dispatch("explore").cached, true);
  write("src/new.ts", "export const added=1;");
  finish(dispatch("explore"));
  rmSync(join(root, "src/new.ts"));
  assert.equal(dispatch("explore").cached, false);
});

test("질문 결과에 답변 필드를 끼워 넣을 수 없다", () => {
  preparePlanning(root); const item = dispatch("analysis");
  assert.equal(ResultSchema.safeParse({ ...item.resultShape, status: "needs-input", artifacts: [], questions: [{ id: "Q1", question: "값은?\n[Answer]: 임의 확정", requirements: ["REQ-1"] }] }).success, false);
});

test("검토한 새 초안을 재제출하지 않고 이전 계획을 승인할 수 없다", () => {
  throughPlan();
  const state = loadPlanning(loadWork(root)!);
  const task = state.tasks.find(record => record.task.role === "plan")!.task;
  write(`${DIR}/feedback.md`, "접근 방법 보완");
  preparePlanning(root, { tasks: [{ ...task, inputs: [...task.inputs, `${DIR}/feedback.md`] }] });
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify({ ...PLAN, reasoning: "보완한 계획" }), [`${DIR}/07-test-spec.md`]: TESTS });
  finish(dispatch("critic"));
  assert.throws(() => approveCommand(root, "approved"), /검토한 초안과 제출된 계획이 다릅니다/);
  assert.doesNotThrow(() => submitPlan(root, join(root, DIR, "plan.json")));
});

test("동시에 도착한 세 프로세스의 조사 완료 기록을 모두 보존한다", async () => {
  analysis();
  preparePlanning(root, { maxParallel: 3, tasks: ["one", "two", "three"].map(id => ({ id, role: "explore", title: "병렬 조사", requirements: ["R1"], inputs: [SPEC], scopes: ["src"], outputs: [], dependsOn: ["analysis"] })) });
  const events = ["one", "two", "three"].map(id => {
    const item = dispatch(id), event = { cwd: root, session_id: "parallel", agent_id: id, agent_type: item.agent };
    observePlanner({ ...event, hook_event_name: "SubagentStart" });
    return { ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify({ ...item.resultShape, status: "completed", summary: "병렬 완료", artifacts: [] }) };
  });
  await Promise.all(events.map(event => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, "../agent/cli.js"), "planning-event"], { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let error = ""; child.stderr.on("data", chunk => { error += chunk.toString(); });
    child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(error || `완료 이벤트 실패 ${code}`)));
    child.stdin.end(JSON.stringify(event));
  })));
  const completed = loadPlanning(loadWork(root)!).tasks.filter(record => record.task.role === "explore" && record.attempts.at(-1)?.status === "completed");
  assert.equal(completed.length, 3);
});

test("CLI 출력에는 배정 요약과 파일 경로만 남고, 파일에 계약·문서 기준·뼈대가 들어 있다", () => {
  const cli = join(__dirname, "../agent/cli.js");
  const out = execFileSync(process.execPath, [cli, "planning", "advance"], { cwd: root, encoding: "utf8", env: { ...process.env, CODE_AGENT_HOST: "claude" } });
  const [summary] = JSON.parse(out).assignments;
  assert.deepEqual(Object.keys(summary).sort(), ["agent", "assignmentFile", "role", "taskId", "title"], "Claude 는 agent 만 — 배정 ID 는 assignmentFile 이름에 있다");
  assert.ok(out.split("\n").every((line) => !line.startsWith("  ")), "최상위 키마다 한 줄이고 들여쓰지 않는다");
  const full = handed(summary), codex = withNotation("codex", () => JSON.parse(handoffPlanning(root, JSON.stringify(full))));
  assert.deepEqual(codex.hostAgents, { codex: full.hostAgents.codex }, "Codex 는 자기 담당 이름만 함께 받는다");
  const text = readFileSync(join(root, summary.assignmentFile), "utf8");
  assert.match(text, /## 문서 기준[\s\S]*01-requirements\.md 작성 기준/);
  assert.match(text, /## 단계 context[\s\S]*확정된 접수 요구/, "이전 흐름에서 담당이 받던 접수 요구 원문 목록을 함께 넘긴다");
  assert.ok(text.includes(`## 뼈대 — ${DIR}/01-requirements.md`));
  assert.equal(readFileSync(join(root, ".code-agent/work", ID, "handoff/.gitignore"), "utf8"), "*\n");
  assert.equal(handed(summary).resultShape.artifacts[0].staged, `${DIR}/.staging/${handed(summary).resultShape.dispatchId}/01-requirements.md`);
  assert.equal(existsSync(join(root, DIR, ".staging")), false, "staging 폴더는 배정(CLI)이 아니라 담당 시작 hook 이 만든다");
});

test("담당이 staging에 쓴 문서를 완료 hook이 정식 문서로 옮기고, 결과 보고에는 본문이 없다", async () => {
  const item = (await advance()).assignments[0], staged = item.staging[`${DIR}/01-requirements.md`];
  const event = { cwd: root, session_id: "s", agent_id: "planner-1", agent_type: item.agent };
  const write_ = (file: string, agent?: string) => hook({ cwd: root, session_id: "s", agent_id: agent, tool_name: "Write", tool_input: { file_path: join(root, file) } });
  observePlanner({ ...event, hook_event_name: "SubagentStart" });
  assert.equal(readFileSync(join(root, DIR, ".staging/.gitignore"), "utf8"), "*\n", "시작 hook 이 staging 폴더를 연다");
  assert.equal(existsSync(join(root, DIR, ".staging", item.resultShape.dispatchId)), false, "배정별 폴더는 담당의 쓰기가 만든다");
  assert.match(write_(staged)!, /계획 담당만/, "메인은 staging에 대신 쓰지 못한다");
  assert.equal(write_(staged, "planner-1"), undefined);
  assert.match(write_(`${DIR}/questions.md`, "planner-1")!, /staging 경로에만/);
  assert.match(write_(`${DIR}/.staging/forged/01-requirements.md`, "planner-1")!, /staging 경로가 아닙니다/);
  write(staged, REQUIREMENTS);
  const message = JSON.stringify({ ...item.resultShape, status: "completed", summary: "근거 확인", evidence: [{ path: SPEC, line: 1 }] });
  assert.ok(!message.includes("값 반환"));
  observePlanner({ ...event, hook_event_name: "SubagentStop", last_assistant_message: message });
  assert.equal(readFileSync(join(root, DIR, "01-requirements.md"), "utf8"), REQUIREMENTS);
  assert.equal(existsSync(join(root, DIR, ".staging", item.resultShape.dispatchId)), false);
  assert.equal(readFileSync(join(root, DIR, ".staging/.gitignore"), "utf8"), "*\n");
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.result!.artifacts[0].content, REQUIREMENTS);
});

test("배정 밖 staging 경로나 쓰지 않은 staging 문서는 완료로 받지 않는다", async () => {
  const stop = (item: Awaited<ReturnType<typeof advance>>, agent: string, artifacts?: unknown) => {
    const event = { cwd: root, session_id: "s", agent_id: agent, agent_type: item.agent };
    observePlanner({ ...event, hook_event_name: "SubagentStart" });
    observePlanner({ ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify({ ...item.resultShape, status: "completed", summary: "확인", evidence: [{ path: SPEC, line: 1 }], ...(artifacts ? { artifacts } : {}) }) });
  };
  await assert.rejects(async () => stop((await advance()).assignments[0], "planner-a"), /staging 문서가 없습니다/);
  const again = dispatch("analysis");
  write(`${DIR}/.staging/forged/01-requirements.md`, REQUIREMENTS);
  assert.throws(() => stop(again, "planner-b", [{ path: `${DIR}/01-requirements.md`, staged: `${DIR}/.staging/forged/01-requirements.md` }]), /배정된 staging 경로가 아닙니다/);
  assert.equal(existsSync(join(root, DIR, "01-requirements.md")), false);
});

test("완료 hook은 담당이 고칠 수 있는 실패만 한 번 돌려보내고, 기록이 끝난 실패와 이미 막힌 재시도는 막지 않는다", async () => {
  const item = (await advance()).assignments[0], event = { cwd: root, session_id: "s", agent_id: "looping", agent_type: item.agent };
  const report = { ...item.resultShape, status: "completed", summary: "확인", evidence: [{ path: SPEC, line: 1 }] };
  const stop = (message: unknown, extra = {}) => runPlanningHook(JSON.stringify({ ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify(message), ...extra }));
  const saved = process.env.CLAUDE_PROJECT_DIR, quiet = process.stderr.write;
  process.env.CLAUDE_PROJECT_DIR = root; process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    observePlanner({ ...event, hook_event_name: "SubagentStart" });
    assert.equal(stop({ ...report, dispatchId: "other" }), 2, "배정 식별 오류는 담당이 고쳐 다시 보고할 수 있다");
    assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "running", "되돌림은 기록하지 않는다");
    assert.equal(stop(report, { stop_hook_active: true }), 0, "한 번 막힌 재시도는 놓아 준다 — staging 이 없어 실패로 기록한다");
    assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "failed");
    assert.equal(stop(report), 0, "이미 처리한 완료 이벤트가 반복되지 않는다");
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
    process.stderr.write = quiet;
  }
});

test("context --file은 전문을 전달 파일로 두고 메인에게는 첫 줄과 경로만 준다", () => {
  const text = contextHandoff(root), file = `.code-agent/work/${ID}/handoff/context.md`;
  assert.equal(readFileSync(join(root, file), "utf8"), `${context(root)}\n`);
  assert.ok(text.includes(`전문: ${file}`));
  assert.ok(text.split("\n").length <= 3);
});

test("대화 시작·압축 뒤 붙는 진행 상태 — 진행 중인 것이 없으면 아무것도 붙이지 않는다", () => {
  const anchor = sessionAnchor(root);
  assert.ok(anchor.includes(`작업 ${ID} (feature) · 스테이지 analysis`));
  assert.match(anchor.split("\n")[0], /자동 요약 — 이어갈 때는 \/ca-next\)$/);
  assert.doesNotMatch(anchor, /이전 대화 내용이 아니라|동의는 준비한 세션에서만/, "이어가는 방법은 설치 지침 블록에 있고, 기다리는 동의가 없으면 동의 줄도 없다");
  prepareConsentFixture(root, { action: "abort" });
  assert.match(sessionAnchor(root), /\n- 응답·적용을 기다리는 동의가 있다\(.+\)\. 동의는 준비한 세션에서만 적용된다/, "기다리는 동의가 있으면 그 줄만 더한다");
  const empty = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-planning-")));
  try { execFileSync("git", ["init", "-q"], { cwd: empty }); assert.equal(sessionAnchor(empty), ""); }
  finally { rmSync(empty, { recursive: true, force: true }); }
});

test("Codex 담당은 배정 파일을 code-agent read로 읽고, 메인은 staging 을 대신 쓰지 못하며, 쓰기가 거부된 담당은 본문을 실어 완료할 수 있다", () => {
  const cli = join(__dirname, "../agent/cli.js");
  const [summary] = JSON.parse(execFileSync(process.execPath, [cli, "planning", "advance"], { cwd: root, encoding: "utf8" })).assignments;
  const shell = (command: string) => codexHook({ cwd: root, session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
  assert.deepEqual(shell(`code-agent read ${summary.assignmentFile}`), {});
  assert.ok(readProjectFile(root, summary.assignmentFile).split("\n").filter((line) => /^\d+\t/.test(line)).length > 10);
  const item = handed(summary), staged = item.staging[`${DIR}/01-requirements.md`];
  const patch = codexHook({ cwd: root, session_id: "s", hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Add File: ${staged}\n+x\n*** End Patch` } }) as { hookSpecificOutput?: { permissionDecisionReason: string } };
  assert.match(patch.hookSpecificOutput!.permissionDecisionReason, /메인은 계획 문서를 대신 쓰지 않습니다/);
  assert.doesNotMatch(hostAssets("codex").get(".codex/agents/ca-analyst.toml")!, /Codex에서는 staging에 쓰지 않는다/);
  finish(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }, {}, "codex");
  assert.equal(readFileSync(join(root, DIR, "01-requirements.md"), "utf8"), REQUIREMENTS);
});

test("H4 Codex 하위 에이전트 hook 의 agent_id·agent_type 으로 담당을 가른다 — 실행 중인 Codex 계획 담당은 자기 배정의 staging 만 쓴다", async () => {
  const item = (await advance()).assignments[0];
  const staged = item.staging[`${DIR}/01-requirements.md`];
  // Codex 는 하위 에이전트 이벤트에 부모 session_id 와 자기 agent_id·agent_type(ca_x)을 싣는다(0.161.0 실측)
  const sub = { cwd: root, session_id: "s", agent_id: "01a11a65-sub", agent_type: item.agent.replace(/-/g, "_") };
  codexHook({ ...sub, hook_event_name: "SubagentStart" });
  const reason = (input: object) => ((codexHook({ cwd: root, session_id: "s", hook_event_name: "PreToolUse", ...input }) as
    { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason ?? "");
  const patch = (path: string) => ({ tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch` } });
  assert.equal(reason({ ...sub, ...patch(staged) }), "", "자기 배정의 staging 은 apply_patch 로 쓴다");
  assert.equal(reason({ ...sub, ...patch(item.resultFile) }), "", "결과 파일도 자기 배정의 자리에 쓴다");
  assert.match(reason(patch(item.resultFile)), /메인은 계획 문서를 대신 쓰지 않습니다/, "메인은 결과 파일을 대신 쓰지 않는다");
  for (const path of ["src/x.ts", `${DIR}/01-requirements.md`]) {
    assert.match(reason({ ...sub, ...patch(path) }), /계획 담당은 배정 파일의 staging 경로에만 씁니다/, path);
  }
  assert.match(reason({ ...sub, ...patch(`${DIR}/.staging/other-dispatch/01-requirements.md`) }), /실행 중인 배정의 staging 경로가 아닙니다/);
  assert.match(reason({ ...sub, agent_id: "other-agent", ...patch(staged) }), /메인은 계획 문서를 대신 쓰지 않습니다/, "시작이 관찰되지 않은 에이전트는 담당이 아니다");
  // 메인(agent_id 없음)은 이전과 같다 — staging 은 메인이 대신 쓰지 않는다
  assert.match(reason(patch(staged)), /메인은 계획 문서를 대신 쓰지 않습니다/);
  assert.equal(reason({ tool_name: "Bash", tool_input: { command: `code-agent read ${staged}` } }), "");
});

test("결과 JSON 은 배정의 resultFile 에 쓰고 최종 응답은 경로 한 줄이다 — 메인 대화에 결과 본문이 실리지 않는다", async () => {
  const item = (await advance()).assignments[0];
  assert.equal(item.resultFile, `${DIR}/.staging/${item.resultShape.dispatchId}/result.json`);
  assert.match(item.instructions, /결과 JSON은 resultFile 경로에 .* "결과: <resultFile>" 한 줄만 돌려주세요/);
  const sub = { cwd: root, session_id: "s", agent_id: "pointer", agent_type: item.agent };
  observePlanner({ ...sub, hook_event_name: "SubagentStart" });
  const staged = item.staging[`${DIR}/01-requirements.md`];
  write(staged, REQUIREMENTS);
  write(item.resultFile, JSON.stringify({ ...item.resultShape, status: "completed", summary: "근거 확인", evidence: [{ path: SPEC, line: 1 }], facts: [], questions: [], findings: [],
    artifacts: [{ path: `${DIR}/01-requirements.md`, staged }] }));
  observePlanner({ ...sub, hook_event_name: "SubagentStop", last_assistant_message: `결과: ${item.resultFile}` });
  assert.equal(readFileSync(join(root, DIR, "01-requirements.md"), "utf8"), REQUIREMENTS);
  assert.equal(loadPlanning(loadWork(root)!).tasks.find((record) => record.task.id === "analysis")!.attempts.at(-1)!.status, "completed");
  assert.equal(existsSync(join(root, item.resultFile)), false, "완료되면 staging 폴더째 지운다");
});

test("결과 파일 줄이 다른 배정의 자리이거나 파일이 없으면 형식 오류다", async () => {
  const item = (await advance()).assignments[0];
  const sub = { cwd: root, session_id: "s", agent_id: "wrong", agent_type: item.agent };
  observePlanner({ ...sub, hook_event_name: "SubagentStart" });
  assert.throws(() => observePlanner({ ...sub, hook_event_name: "SubagentStop", last_assistant_message: `결과: ${DIR}/.staging/other/result.json` }), /결과 파일 경로가 이 배정의 resultFile 이 아닙니다/);
});

test("형식 교정은 원본의 staging 본문을 지우지 않고 새 배정으로 옮겨 그대로 보존한다", async () => {
  const item = (await advance()).assignments[0], original = item.staging[`${DIR}/01-requirements.md`];
  const event = { cwd: root, session_id: "s", agent_id: "origin", agent_type: item.agent };
  observePlanner({ ...event, hook_event_name: "SubagentStart" });
  write(original, REQUIREMENTS);
  assert.throws(() => observePlanner({ ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify({ ...item.resultShape, status: "completed", summary: 7, evidence: [{ path: SPEC, line: 1 }] }) }), /결과 형식 오류/);
  const repaired = (await advance()).assignments[0];
  assert.equal(repaired.mode, "correction");
  assert.ok(existsSync(join(root, original)), "교정 담당이 다시 읽을 원본 staging 이 남아 있다");
  const moved = repaired.staging[`${DIR}/01-requirements.md`], corrector = { cwd: root, session_id: "s", agent_id: "corrector", agent_type: repaired.agent };
  observePlanner({ ...corrector, hook_event_name: "SubagentStart" });
  write(moved, REQUIREMENTS);
  observePlanner({ ...corrector, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify({ ...repaired.resultShape, status: "completed", summary: "요구 정리", evidence: [{ path: SPEC, line: 1 }] }) });
  assert.equal(readFileSync(join(root, DIR, "01-requirements.md"), "utf8"), REQUIREMENTS);
});

test("계획 단계가 아니면 staging은 닫힌다", () => {
  saveActive(root, { ...loadActive(root)!, phase: "implement" }, "next");
  assert.match(hook({ cwd: root, session_id: "s", agent_id: "implementer", tool_name: "Write", tool_input: { file_path: join(root, DIR, ".staging/x/01-requirements.md") } })!, /계획 단계/);
});

test("다른 호스트를 실행할 수 없으면 그 critic 결과의 교차 검토는 중지로 기록되고 계획을 제출할 수 있다", () => {
  writeFileSync(join(root, ".code-agent/hosts.json"), JSON.stringify(["claude", "codex"]));
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS }); finish(dispatch("critic"));
  assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /교차 검토[\s\S]*실행할 수 없으면 중지로 기록되고 진행합니다/);
  const fake = mkdtempSync(join(tmpdir(), "ca-fake-codex-")), script = join(fake, "codex.cjs");
  writeFileSync(script, "process.stderr.write('Not logged in. Run codex login.'); process.exit(1);\n");
  process.env.CODE_AGENT_CODEX_BIN = script;
  try {
    withCaller("claude", () => {
      assert.match(crossCritic(root, "codex"), /교차 검증 중지[\s\S]*Not logged in/);
      const cross = loadPlanning(loadWork(root)!).cross!;
      assert.equal(cross.status, "unavailable");
      assert.equal(loadPlanning(loadWork(root)!).crossAttempts![0].class, "cross-unavailable");
      assert.ok(!planningProblems(loadWork(root)!, "plan").some((problem) => /교차/.test(problem)));
      // 사람이 아닌 중지는 같은 critic 결과로 지점 한도(3회) 안에서 다시 실행할 수 있다 — 다시 실행할 수 없으면 중지 그대로 진행한다
      assert.match(crossCritic(root, "codex"), /교차 검증 중지[\s\S]*Not logged in/);
      assert.match(crossCritic(root, "codex"), /교차 검증 중지/);
      assert.throws(() => crossCritic(root, "codex"), /한도 3회/);
      assert.equal(loadPlanning(loadWork(root)!).crossAttempts!.length, 3);
      assert.ok(!planningProblems(loadWork(root)!, "plan").some((problem) => /교차/.test(problem)));
    });
    submitPlan(root, join(root, DIR, "plan.json"));
  } finally {
    delete process.env.CODE_AGENT_CODEX_BIN;
    rmSync(fake, { recursive: true, force: true });
  }
});

test("실행 파일 변수가 없는 파일을 가리키면 계획 교차 검토 줄은 실행 전에도 설정 오류 갈래이고, 설정 오류로 막힌 뒤에는 '실행할 수 없으면 중지' 괄호를 달지 않는다(R3)", () => {
  writeFileSync(join(root, ".code-agent/hosts.json"), JSON.stringify(["claude", "codex"]));
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS }); finish(dispatch("critic"));
  const saved = process.env.CODE_AGENT_CODEX_BIN;
  process.env.CODE_AGENT_CODEX_BIN = join(root, "no-such-codex.cjs");
  try {
    withCaller("claude", () => {
      const line = () => planningProblems(loadWork(root)!, "plan").find((problem) => /^교차 검토/.test(problem)) ?? "";
      const before = line();
      assert.match(before, /code-agent planning cross --by codex \(교차 호출 설정 오류 — CODE_AGENT_CODEX_BIN 가 가리키는 파일이 없습니다: [^)]*no-such-codex\.cjs\. 중지로 기록하지 않고 그 지점의 게이트가 막힌다/, before);
      assert.doesNotMatch(before, /실행할 수 없으면 중지로 기록되고 진행합니다/);
      assert.throws(() => crossCritic(root, "codex"), /교차 호출 설정 오류/);
      const after = line();
      assert.match(after, /code-agent planning cross --by codex — 직전 실행: 막힘\(설정 오류\)/, after);
      assert.doesNotMatch(after, /실행할 수 없으면 중지로 기록되고 진행합니다/);
    });
    assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /막힘\(설정 오류\)/);
  } finally {
    if (saved === undefined) delete process.env.CODE_AGENT_CODEX_BIN; else process.env.CODE_AGENT_CODEX_BIN = saved;
  }
});
