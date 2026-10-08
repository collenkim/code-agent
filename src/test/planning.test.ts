import { strict as assert } from "node:assert";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { start } from "./confirmedStart";
import { observeQuestionAnswers } from "./consentFixture";
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
import { hostAssets } from "../agent/hosts";
import { readProjectFile } from "../agent/read";
import { observePlanner, runPlanningHook } from "../agent/planningHook";
import { fileHash, hashedQuestion, inputFiles, invalidatePlanningCache, loadPlanning, planningProblems, taskCurrent, taskHash, TaskSchema, ResultSchema, withPlanningCache, type PlanningResult, type PlanningState } from "../agent/planningState";
import { planningDocumentProblems } from "../agent/planningValidation";
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

const ID = "PLAN-1", DIR = `doc/work/${ID}`, SPEC = `${DIR}/requirement.md`;
const REQUIREMENTS = '# 요구 정의\n## R1 · 값 반환\n근거: "값을 반환한다."\n## 가정\n- 없음';
const IMPACT = '# 영향도\n## 기존 시스템 분석\n- src/current.ts:1 에 값을 반환한다\n## 영향 범위\n| R 번호 | 닿는 파일 | 호출자 | 파급 |\n|---|---|---|---|\n| R1 | src/current.ts:1 | 없음 | 새 진입점 |\n## Risk\n- 기존 반환값 보존';
const DESIGN = '# 설계\n## 구성 요소\n- 새 함수\n## 처리 흐름\n- 호출 → 반환\n## API\n해당 없음 — 내부 함수다\n## 데이터\n해당 없음 — 저장하지 않는다\n## 설계 결정\n- 순수 함수';
const FUNCTIONAL = '# 기능\n## 기능 정의\n- R1: 값 반환\n## 업무 규칙\n- BR-1: 숫자 반환 (src/current.ts:1)\n## 예외\n- 없음 — 입력 없다\n## 수락 기준\n- AC-R1-1: 호출하면 숫자가 반환된다';
const TESTS = '# 테스트\n## 테스트 케이스\n| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |\n|---|---|---|---|---|\n| TC-1 | Unit | AC-R1-1 | 호출 | 숫자 반환 |';
const PLAN = { domainName: "Value", domainLabel: "값", domainRoot: "", domainDirName: "value", approach: "순수 함수", reasoning: "기존 함수 보존", conventions: [], conflicts: [], openQuestions: [], files: [
  { stage: "app", path: "src/a.ts", purpose: "진입점", requirements: ["R1"] }, { stage: "app", path: "src/b.ts", purpose: "변환", requirements: ["R1"] }, { stage: "test", path: "test/value.test.ts", purpose: "검증", requirements: ["R1"] },
], sequence: [{ step: "app", why: "구현" }, { step: "test", why: "검증" }], tasks: [
  { id: "T1", stage: "app", title: "진입점", requirements: ["R1"], files: ["src/a.ts"], dependsOn: [], acceptance: ["AC-R1-1"] },
  { id: "T2", stage: "app", title: "변환", requirements: ["R1"], files: ["src/b.ts"], dependsOn: ["T1"], acceptance: ["AC-R1-1"] },
  { id: "T3", stage: "test", title: "검증", requirements: ["R1"], files: ["test/value.test.ts"], dependsOn: ["T2"], acceptance: ["AC-R1-1"] },
] };
let root: string, serial = 0;
const advance = () => JSON.parse(advancePlanning(root));
function write(path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content);
  // 질문 답은 사람이 질문 도구로 고른 것으로 둔다(답 출처 게이트) — 출처 판정 자체는 answers.test 가 본다
  if (path.endsWith("questions.md")) observeQuestionAnswers(root);
}
function phase(phase: "analysis" | "impact" | "design" | "plan"): void { saveActive(root, { ...loadActive(root)!, phase }, "next"); }
function dispatch(id: string) { return JSON.parse(dispatchPlanning(root, id)); }
function finish(dispatch: ReturnType<typeof JSON.parse>, artifacts: Record<string, string> = {}, extra: Partial<PlanningResult> = {}, host: "claude" | "codex" = "claude") {
  const event = { cwd: root, session_id: "s", agent_id: `agent-${++serial}`, agent_type: dispatch.hostAgents[host] };
  const result: PlanningResult = { taskId: dispatch.task.id, dispatchId: dispatch.resultShape.dispatchId, inputHash: dispatch.resultShape.inputHash, status: "completed", summary: "실제 근거 확인", evidence: [{ path: SPEC, line: 1 }], facts: [], questions: [], findings: [], artifacts: Object.entries(artifacts).map(([path, content]) => ({ path, content })), ...extra };
  const observe = host === "codex" ? codexHook : observePlanner;
  observe({ ...event, hook_event_name: "SubagentStart" });
  observe({ ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify(result) });
  return { event, result };
}
/** CLI는 배정 전문을 파일로 넘기고 경로만 출력한다 — 메인이 본문을 옮겨 쓰지 않도록 */
function handed(summary: { assignmentFile: string; resultShape?: unknown }) {
  assert.equal(summary.resultShape, undefined);
  const text = readFileSync(join(root, summary.assignmentFile), "utf8"), from = text.indexOf("```json\n") + 8;
  return JSON.parse(text.slice(from, text.indexOf("\n```", from)));
}
function analysis() { preparePlanning(root); finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS }); next(root); }
function throughDesign() {
  analysis(); preparePlanning(root);
  finish(dispatch("explore"), {}, { evidence: [{ path: "src/current.ts", line: 1 }] });
  finish(dispatch("synthesis"), { [`${DIR}/02-analysis.md`]: IMPACT }); next(root);
  preparePlanning(root); finish(dispatch("design"), { [`${DIR}/03-design.md`]: DESIGN, [`${DIR}/04-functional.md`]: FUNCTIONAL }); next(root);
}
function throughPlan() {
  throughDesign(); preparePlanning(root);
  const item = dispatch("plan");
  assert.match(item.planShape, /"tasks"/); assert.equal(item.stages[0].key, "app"); assert.ok(item.inputs.includes("code-agent.json"));
  finish(item, { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  finish(dispatch("critic"));
  submitPlan(root, join(root, DIR, "plan.json"));
}
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-planning-")));
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: root });
  write("code-agent.json", JSON.stringify({ language: "typescript", sourceExtensions: [".ts"], domainBase: "src", domainRoots: [], conventions: ["doc/conventions.md"], docs: { architecture: "doc/architecture.md" }, referenceDomain: "reference", build: ["node", "-e", "process.exit(0)"], test: ["node", "-e", "console.log('ok 1 - TC-1')"], stages: [{ key: "app", title: "함수", template: "app.md", scope: "project", outputDirs: ["src"] }, { key: "test", title: "검증", template: "test.md", kind: "test", scope: "project", outputDirs: ["test"] }] }));
  write("doc/architecture.md", "# 아키텍처\n## 기술 스택\nNode\n## 모듈/패키지 구조\nsrc\n## 계층과 책임\n함수\n## 의존 방향\ntest → src\n## 공통 모듈\n없음\n## 주요 결정\n순수 함수");
  write("doc/conventions.md", "# 컨벤션\n## 명명\n소문자\n## 계층별 규칙\n순수 함수\n## 예외 처리\nError");
  write("doc/test-strategy.md", "# 테스트 전략\n## 수준과 범위\n- Unit: 필수\n## 도구와 실행 명령\n- `test`: 전체\n## 통과 기준\n- AC마다1개");
  write("doc/quality.md", "# 품질\n## 정적 분석\n- `build`: 컴파일\n## 보안 검사\n- 없음 — 리뷰에서 확인\n## 통과 기준과 반영 차단\n- 컴파일 실패 차단");
  write(".gitignore", ".code-agent/\n");
  write("src/current.ts", "export const current = 1;\n");
  write("other/current.ts", "export const other = 1;\n");
  write(SPEC, `---\nkind: feature\nid: ${ID}\ntitle: 값 반환\ntarget: value\n---\n\n값을 반환한다.\n`);
  for (const check of checkProjectDocs(root, loadManifest(root))) recordDocConfirmation(root, check, "test", { channel: "tty", verified: true, detail: "테스트" });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture"], { cwd: root });
  start(root, join(root, SPEC), { planning: true });
});
afterEach(() => {
  assert.ok(root.startsWith(`${realpathSync.native(tmpdir())}${sep}ca-planning-`));
  rmSync(root, { recursive: true, force: true });
});

test("계획 전달은 문서 원문을 중복하지 않고 판단·해시·상세 조회를 보존한다", () => {
  const item = advance().assignments[0];
  const content = REQUIREMENTS + "\n" + "원문전용 자료\n".repeat(5000);
  finish(item, { [`${DIR}/01-requirements.md`]: content }, { findings: [{ id: "F1", severity: "advisory", detail: "검토 필요", source: { path: SPEC, line: 1 } }] });
  const cached = dispatch("analysis");
  assert.equal(cached.cached, true);
  assert.equal(cached.result.findings[0].detail, "검토 필요");
  assert.match(cached.result.artifacts[0].hash, /^[a-f0-9]{64}$/);
  assert.equal(cached.result.artifacts[0].chars, content.length);
  assert.equal(cached.result.artifacts[0].content, undefined);
  const detail = JSON.parse(planningResult(root, "analysis"));
  assert.equal(detail.current, true);
  assert.equal(detail.last.result.artifacts[0].content, content);
  assert.doesNotMatch(planningStatus(root), /원문전용/);
  next(root);
  const explorer = advance().assignments[0];
  assert.equal(explorer.dependencies[0].artifacts[0].content, undefined);
  assert.equal(explorer.dependencies[0].findings[0].detail, "검토 필요");
  assert.ok(explorer.inputs.includes(`${DIR}/01-requirements.md`));
  assert.ok(JSON.stringify(explorer.dependencies).length < JSON.stringify(detail.last.result).length / 10);
  write(`${DIR}/01-requirements.md`, REQUIREMENTS);
  assert.equal(JSON.parse(planningResult(root, "analysis")).current, false);
});

test("계획 진행은 준비·배정을 합치고 반복 호출·캐시·단계 게이트를 구분한다", () => {
  const first = advance();
  assert.equal(first.action, "dispatch"); assert.equal(first.assignments.length, 1);
  assert.equal(advance().action, "wait");
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.length, 1);
  finish(first.assignments[0], { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
  assert.equal(advance().action, "ready-for-gate");
  assert.deepEqual(advance().reused, ["analysis"]);
  assert.equal(loadActive(root)!.phase, "analysis");
  next(root);
  const impact = advance();
  assert.deepEqual(impact.assignments.map((item: any) => item.task.role), ["impact"]);
  assert.match(impact.assignments[0].delegation, /한 담당/);
  finish(impact.assignments[0], { [`${DIR}/02-analysis.md`]: IMPACT });
  assert.equal(advance().action, "ready-for-gate");
});

for (const size of ["files", "bytes", "requirements"] as const) test(`자동 영향도 통합은 작은 범위만 선택한다: ${size}`, () => {
  preparePlanning(root);
  finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS + (size === "requirements" ? [2, 3, 4].map(n => `\n## R${n} · 값 확인\n근거: "값을 반환한다."`).join("") : "") });
  next(root);
  if (size === "files") for (let i = 0; i < 13; i++) write(`src/file${i}.ts`, "export const value=1;");
  if (size === "bytes") write("src/large.ts", " ".repeat(96_001));
  const reply = advance();
  assert.equal(reply.assignments[0].task.role, "explore");
  assert.deepEqual(loadPlanning(loadWork(root)!).tasks.map(record => record.task.role), ["analysis", "explore", "synthesis"]);
});

test("설치된 호스트 지침·단계 템플릿은 작은 조사 판정과 새 범위 입력에서 제외한다", () => {
  init(root, { host: "both" });
  analysis();
  const item = advance().assignments[0];
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

test("통합 조사도 실제 관찰·출력·질문·차단 지적을 요구하고 분할 조사와 중복하지 않는다", () => {
  analysis();
  const item = advance().assignments[0];
  assert.equal(item.task.role, "impact");
  assert.throws(() => next(root), /관찰된 완료/);
  assert.throws(() => finish(item), /출력 문서 전체/);
  assert.equal(advance().action, "blocked");
  finish(dispatch("impact"), { [`${DIR}/02-analysis.md`]: IMPACT }, { findings: [{ id: "F1", severity: "blocking", detail: "영향 재확인", source: { path: SPEC, line: 1 } }] });
  assert.equal(advance().action, "blocked");
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
  preparePlanning(root); finish(dispatch("design"), { [`${DIR}/03-design.md`]: DESIGN, [`${DIR}/04-functional.md`]: FUNCTIONAL }); next(root);
  preparePlanning(root);
  const plan = dispatch("plan");
  assert.ok(plan.inputs.includes(`${DIR}/01-requirements.md`)); assert.ok(plan.inputs.includes(`${DIR}/03-design.md`));
  assert.ok(plan.inputs.includes(`${DIR}/02-analysis.md`));
  assert.ok(inputFiles(loadWork(root)!, { ...plan.task, contextVersion: undefined }).includes(`${DIR}/02-analysis.md`));
  finish(plan, { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  const critic = dispatch("critic");
  for (const file of ["01-requirements.md", "02-analysis.md", "03-design.md", "04-functional.md", "plan.json", "07-test-spec.md"]) assert.ok(critic.inputs.includes(`${DIR}/${file}`));
});

test("통합 영향도 결과의 상충하는 사실도 게이트를 통과하지 못한다", () => {
  analysis();
  finish(advance().assignments[0], { [`${DIR}/02-analysis.md`]: IMPACT }, { facts: [
    { key: "반환값", value: "1", source: { path: "src/current.ts", line: 1 } },
    { key: "반환값", value: "2", source: { path: "src/current.ts", line: 1 } },
  ] });
  assert.equal(advance().action, "blocked");
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

test("계획 진행은 사용자 영역 분할·동시 한도·미결 질문과 사실 충돌을 유지한다", () => {
  analysis();
  const base = { role: "explore", title: "영역", requirements: ["R1"], inputs: [SPEC], scopes: ["src"], outputs: [], dependsOn: ["analysis"] };
  preparePlanning(root, { maxParallel: 1, tasks: [{ ...base, id: "left" }, { ...base, id: "right" }] });
  const first = advance(); assert.equal(first.assignments.length, 1);
  assert.equal(first.assignments[0].task.id, "left");
  finish(first.assignments[0], {}, { facts: [{ key: "값", value: "1", source: { path: "src/current.ts", line: 1 } }] });
  const second = advance(); assert.equal(second.assignments[0].task.id, "right");
  finish(second.assignments[0], {}, { facts: [{ key: "값", value: "2", source: { path: "src/current.ts", line: 1 } }] });
  const conflict = advance(); assert.equal(conflict.action, "blocked"); assert.equal(conflict.assignments.length, 0);
  assert.match(JSON.stringify(conflict.blocked), /충돌/);
  write(`${DIR}/questions.md`, "# 질문\n## Q1 · 확인\n값은?\n[Requirements]: R1\n[Answer]:\n");
  assert.equal(advance().action, "blocked");
  assert.match(JSON.stringify(advance().blocked), /미결 질문/);
});

function malformed(item: any, options: { codex?: boolean; raw?: string; id?: string } = {}) {
  const event = { cwd: root, session_id: "format-session", agent_id: options.id ?? `format-${++serial}`, agent_type: item.agent };
  const value = { ...item.resultShape, status: "completed", summary: 123, artifacts: [{ path: `${DIR}/01-requirements.md`, content: REQUIREMENTS }] };
  const observe = options.codex ? codexHook : observePlanner;
  observe({ ...event, hook_event_name: "SubagentStart" });
  assert.throws(() => observe({ ...event, hook_event_name: "SubagentStop", last_assistant_message: options.raw ?? JSON.stringify(value) }), /결과 형식 오류/);
  return { event, value };
}

test("형식 교정은 관찰 원본과 같은 입력을 재사용하고 늦은 결과·무관찰 완료를 막는다", () => {
  const item = advance().assignments[0], original = malformed(item);
  assert.equal(existsSync(join(root, DIR, "01-requirements.md")), false);
  assert.equal(JSON.parse(planningStatus(root)).tasks[0].state, "needs-correction");
  assert.throws(() => dispatch("analysis"), /교정/);
  const repaired = advance().assignments[0];
  assert.equal(repaired.mode, "correction");
  assert.equal(JSON.parse(repaired.originalResponse).summary, 123);
  assert.notEqual(repaired.resultShape.dispatchId, item.resultShape.dispatchId);
  assert.equal(repaired.resultShape.inputHash, item.resultShape.inputHash);
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.length, 1);
  assert.throws(() => observePlanner({ ...original.event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify({ ...original.value, summary: "교정" }) }), /이미 처리/);
  observePlanner({ cwd: root, session_id: "forged", agent_id: "forged", agent_type: item.agent, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify({ ...repaired.resultShape, status: "completed" }) });
  assert.equal(existsSync(join(root, DIR, "01-requirements.md")), false);
  finish(repaired, { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
  assert.equal(advance().action, "ready-for-gate");
  assert.equal(JSON.parse(planningResult(root, "analysis")).last.correction.used, true);
});

test("Codex 관찰에서도 교정은 한 번만 허용하며 CLI 상세 조회에 원본 오류를 노출하지 않는다", () => {
  const item = advance().assignments[0]; malformed(item, { codex: true });
  const repaired = JSON.parse(repairPlanning(root, "analysis"));
  malformed(repaired, { codex: true });
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "failed");
  assert.throws(() => repairPlanning(root, "analysis"), /한 번/);
  assert.equal(advance().action, "blocked");
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.length, 1);
  const detail = JSON.parse(planningResult(root, "analysis"));
  assert.equal(detail.last.correction.raw, undefined);
});

test("형식 교정이 유효한 차단 지적과 문서 내용을 조용히 바꾸지 못한다", () => {
  const item = advance().assignments[0];
  const findings = [{ id: "F1", severity: "blocking", detail: "확인할 위험", source: { path: SPEC, line: 1 } }];
  malformed(item, { raw: JSON.stringify({ ...item.resultShape, status: "completed", summary: 123, findings, artifacts: [{ path: `${DIR}/01-requirements.md`, content: REQUIREMENTS }] }) });
  const repaired = advance().assignments[0];
  assert.throws(() => finish(repaired, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }), /유효한 원본 findings/);
  assert.equal(existsSync(join(root, DIR, "01-requirements.md")), false);
});

test("교정도 입력 변경·취소·의미상 근거 오류를 우회하지 못한다", () => {
  const item = advance().assignments[0]; malformed(item);
  write(SPEC, readFileSync(join(root, SPEC), "utf8") + "\n추가 요구\n");
  assert.throws(() => repairPlanning(root, "analysis"), /입력이 바뀌/);
  cancelPlanning(root, "analysis");
  assert.throws(() => repairPlanning(root, "analysis"), /교정할/);
  const second = advance().assignments[0]; malformed(second);
  const repaired = JSON.parse(repairPlanning(root, "analysis"));
  assert.throws(() => finish(repaired, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }, { evidence: [{ path: "outside.ts", line: 1 }] }), /범위 밖/);
  assert.equal(existsSync(join(root, DIR, "01-requirements.md")), false);
});

test("깨진 JSON은 시작 때 배정이 유일한 경우만 교정하며 위조 식별자는 거부한다", () => {
  const item = advance().assignments[0]; malformed(item, { raw: "{broken" });
  assert.equal(advance().assignments[0].mode, "correction");
  cancelPlanning(root, "analysis");
  const second = advance().assignments[0];
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

for (const host of ["claude", "codex"] as const) test(`${host}: 설치된 절차로 형식 교정부터 독립 검토·승인 게이트까지 같은 기능을 제공한다`, () => {
  init(root, { host });
  const skills = host === "claude" ? ".claude/skills" : ".agents/skills";
  for (const name of ["ca-analyze", "ca-impact", "ca-design", "ca-plan"]) {
    const instructions = readFileSync(join(root, skills, name, "SKILL.md"), "utf8");
    assert.match(instructions, /planning advance/); assert.match(instructions, /mode:correction/);
    assert.match(instructions, /planning result/); assert.match(instructions, /ready-for-gate/);
  }
  const initial = advance().assignments[0];
  malformed(initial, { codex: host === "codex" });
  finish(advance().assignments[0], { [`${DIR}/01-requirements.md`]: REQUIREMENTS }, {}, host);
  assert.equal(advance().action, "ready-for-gate"); next(root);
  finish(advance().assignments[0], { [`${DIR}/02-analysis.md`]: IMPACT }, { evidence: [{ path: "src/current.ts", line: 1 }] }, host);
  assert.equal(advance().action, "ready-for-gate"); next(root);
  finish(advance().assignments[0], { [`${DIR}/03-design.md`]: DESIGN, [`${DIR}/04-functional.md`]: FUNCTIONAL }, {}, host);
  assert.equal(advance().action, "ready-for-gate"); next(root);
  finish(advance().assignments[0], { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS }, {}, host);
  assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /critic/);
  finish(advance().assignments[0], {}, {}, host);
  assert.equal(advance().action, "ready-for-gate");
  submitPlan(root, join(root, DIR, "plan.json"));
  assert.throws(() => next(root), /승인/);
  assert.equal(loadActive(root)!.phase, "plan");
  const state = loadPlanning(loadWork(root)!);
  assert.deepEqual(state.tasks.map(item => item.task.role), ["analysis", "impact", "design", "plan", "critic"]);
  assert.ok(state.tasks.every(item => item.attempts.length === 1));
  assert.equal(JSON.parse(planningResult(root, "plan")).current, true);
});

test("병렬 실행의 식별자 없는 깨진 결과를 임의 작업의 교정으로 연결하지 않는다", () => {
  analysis();
  const base = { role: "explore", title: "영역", requirements: ["R1"], inputs: [SPEC], scopes: ["src"], outputs: [], dependsOn: ["analysis"] };
  preparePlanning(root, { tasks: [{ ...base, id: "left" }, { ...base, id: "right" }] });
  const batch = advance(); assert.equal(batch.assignments.length, 2);
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
test("Codex 담당의 배정 계약은 staging 이 아니라 {path, content} 다 — Codex 단일 설치와 두 호스트 설치의 Codex 호출(E9)", () => {
  const output = `${DIR}/01-requirements.md`;
  preparePlanning(root);
  // 두 호스트 설치 — 부른 쪽이 Claude 면 staging 계약, Codex 면 content 계약
  writeFileSync(join(root, ".code-agent/hosts.json"), JSON.stringify(["claude", "codex"]));
  const viaClaude = withCaller("claude", () => dispatch("analysis"));
  assert.equal(viaClaude.resultShape.artifacts[0].staged, `${DIR}/.staging/${viaClaude.resultShape.dispatchId}/01-requirements.md`);
  cancelPlanning(root, "analysis");
  const viaCodex = withCaller("codex", () => dispatch("analysis"));
  assert.deepEqual([viaCodex.staging, viaCodex.resultShape.artifacts], [undefined, [{ path: output, content: "<문서 전체 내용>" }]]);
  cancelPlanning(root, "analysis");
  // Codex 단일 설치 — 부른 쪽 표지와 무관하게 Codex 계약
  writeFileSync(join(root, ".code-agent/hosts.json"), JSON.stringify(["codex"]));
  const item = withCaller("claude", () => dispatch("analysis"));
  assert.equal(item.staging, undefined, "Codex 담당은 staging 을 쓸 수 없다");
  assert.deepEqual(item.resultShape.artifacts, [{ path: output, content: "<문서 전체 내용>" }]);
  assert.ok(item.instructions.includes("출력 문서는 파일로 쓰지 말고 artifacts에 {path, content}로 전체 내용을 넣으세요(staging 은 이 호스트의 담당에게 열리지 않습니다)"));
  assert.ok(!item.instructions.includes("{path, staged}") && !item.instructions.includes("staging에 지정된 경로"), item.instructions);
  // 계약대로 돌려준 결과가 그대로 받아들여진다
  finish(item, { [output]: REQUIREMENTS }, {}, "codex");
  assert.equal(readFileSync(join(root, output), "utf8"), REQUIREMENTS);
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
test("출처를 확인할 수 없는 답은 답 없는 질문과 다른 사유로 막는다 — 방금 답을 적은 쪽이 이유를 안다(E6)", () => {
  preparePlanning(root);
  finish(dispatch("analysis"), {}, { status: "needs-input", questions: [{ id: "Q1", question: "값 선택", requirements: ["REQ-1"] }] });
  const question = readFileSync(join(root, DIR, "questions.md"), "utf8");
  // 질문 도구 관찰 없이 답만 적는다(write 헬퍼는 관찰을 흉내 내므로 쓰지 않는다)
  writeFileSync(join(root, DIR, "questions.md"), question.replace(/^\[Answer\]:/m, "[Answer]: 1로 결정"));
  assert.throws(() => dispatch("analysis"), (error: Error) =>
    /답 출처 미확인 Q1 — 질문 도구 응답이 관찰되지 않은 답입니다[\s\S]*\[Source\]: 대화/.test(error.message) && !/미결 질문 Q1/.test(error.message));
  assert.match(JSON.stringify(advance().blocked), /답 출처 미확인 Q1/);
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
test("잘못된 DAG·출력 소유·Task 순환 및 중복 파일을 거부한다", () => {
  const task = TaskSchema.parse({ id: "analysis", role: "analysis", title: "분석", requirements: ["REQ-1"], inputs: [SPEC], outputs: [`${DIR}/01-requirements.md`], dependsOn: ["analysis"] });
  assert.throws(() => preparePlanning(root, { tasks: [task] }), /순환/);
  assert.throws(() => preparePlanning(root, { tasks: [{ ...task, dependsOn: [], outputs: ["src/current.ts"] }] }), /출력/);
  const plan = structuredClone(PLAN); plan.tasks[0].dependsOn = ["T2"]; plan.tasks[1].files = ["src/a.ts"];
  assert.ok(sequenceProblems(plan, loadWork(root)!.stages, "feature").length >= 2);
});
test("취소는 같은 입력 한도에 세지 않고 작업별 총 배정 6회에서 멈춘다", () => {
  preparePlanning(root);
  for (let index = 0; index < 3; index++) { dispatch("analysis"); cancelPlanning(root, "analysis"); }
  assert.doesNotThrow(() => dispatch("analysis"), "세 번 취소한 뒤 네 번째 배정은 허용한다 — 취소는 같은 입력 실패가 아니다");
  cancelPlanning(root, "analysis");
  for (let index = 0; index < 2; index++) { dispatch("analysis"); cancelPlanning(root, "analysis"); }
  // 거부 문구는 지금 실행할 수 있는 길만 안내한다 — 다시 준비해도 시도 기록이 남아 한도가 풀리지 않는다
  assert.throws(() => dispatch("analysis"), (error: Error) => /총 6회/.test(error.message) && /다시 준비[^.]*그대로/.test(error.message) && !/한도 \+3|재계획/.test(error.message));
  assert.equal(JSON.parse(planningStatus(root)).tasks[0].attempts, 6);
  const blocked = advance().blocked[0];
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
  const [summary] = JSON.parse(execFileSync(process.execPath, [cli, "planning", "advance"], { cwd: root, encoding: "utf8" })).assignments;
  assert.deepEqual(Object.keys(summary).sort(), ["agent", "assignmentFile", "dispatchId", "hostAgents", "role", "taskId", "title"]);
  const text = readFileSync(join(root, summary.assignmentFile), "utf8");
  assert.match(text, /## 문서 기준[\s\S]*01-requirements\.md 작성 기준/);
  assert.match(text, /## 단계 context[\s\S]*확정된 접수 요구/, "이전 흐름에서 담당이 받던 접수 요구 원문 목록을 함께 넘긴다");
  assert.ok(text.includes(`## 뼈대 — ${DIR}/01-requirements.md`));
  assert.equal(readFileSync(join(root, ".code-agent/work", ID, "handoff/.gitignore"), "utf8"), "*\n");
  assert.equal(handed(summary).resultShape.artifacts[0].staged, `${DIR}/.staging/${summary.dispatchId}/01-requirements.md`);
});

test("담당이 staging에 쓴 문서를 완료 hook이 정식 문서로 옮기고, 결과 보고에는 본문이 없다", () => {
  const item = advance().assignments[0], staged = item.staging[`${DIR}/01-requirements.md`];
  const event = { cwd: root, session_id: "s", agent_id: "planner-1", agent_type: item.agent };
  const write_ = (file: string, agent?: string) => hook({ cwd: root, session_id: "s", agent_id: agent, tool_name: "Write", tool_input: { file_path: join(root, file) } });
  observePlanner({ ...event, hook_event_name: "SubagentStart" });
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

test("배정 밖 staging 경로나 쓰지 않은 staging 문서는 완료로 받지 않는다", () => {
  const stop = (item: ReturnType<typeof advance>, agent: string, artifacts?: unknown) => {
    const event = { cwd: root, session_id: "s", agent_id: agent, agent_type: item.agent };
    observePlanner({ ...event, hook_event_name: "SubagentStart" });
    observePlanner({ ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify({ ...item.resultShape, status: "completed", summary: "확인", evidence: [{ path: SPEC, line: 1 }], ...(artifacts ? { artifacts } : {}) }) });
  };
  assert.throws(() => stop(advance().assignments[0], "planner-a"), /staging 문서가 없습니다/);
  const again = dispatch("analysis");
  write(`${DIR}/.staging/forged/01-requirements.md`, REQUIREMENTS);
  assert.throws(() => stop(again, "planner-b", [{ path: `${DIR}/01-requirements.md`, staged: `${DIR}/.staging/forged/01-requirements.md` }]), /배정된 staging 경로가 아닙니다/);
  assert.equal(existsSync(join(root, DIR, "01-requirements.md")), false);
});

test("완료 hook은 담당이 고칠 수 있는 실패만 한 번 돌려보내고, 기록이 끝난 실패와 이미 막힌 재시도는 막지 않는다", () => {
  const item = advance().assignments[0], event = { cwd: root, session_id: "s", agent_id: "looping", agent_type: item.agent };
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
  assert.ok(sessionAnchor(root).includes(`작업 ${ID} (feature) · 스테이지 analysis`));
  const empty = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-planning-")));
  try { execFileSync("git", ["init", "-q"], { cwd: empty }); assert.equal(sessionAnchor(empty), ""); }
  finally { rmSync(empty, { recursive: true, force: true }); }
});

test("Codex 담당은 배정 파일을 code-agent read로 읽고, staging 대신 본문을 실어 완료한다", () => {
  const cli = join(__dirname, "../agent/cli.js");
  const [summary] = JSON.parse(execFileSync(process.execPath, [cli, "planning", "advance"], { cwd: root, encoding: "utf8" })).assignments;
  const shell = (command: string) => codexHook({ cwd: root, session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
  assert.deepEqual(shell(`code-agent read ${summary.assignmentFile}`), {});
  assert.ok(JSON.parse(readProjectFile(root, summary.assignmentFile)).lines.length > 10);
  const item = handed(summary), staged = item.staging[`${DIR}/01-requirements.md`];
  const patch = codexHook({ cwd: root, session_id: "s", hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Add File: ${staged}\n+x\n*** End Patch` } }) as { hookSpecificOutput?: { permissionDecisionReason: string } };
  assert.match(patch.hookSpecificOutput!.permissionDecisionReason, /Codex.*\{path, content\}/);
  assert.match(hostAssets("codex").get(".codex/agents/ca-analyst.toml")!, /Codex에서는 staging에 쓰지 않는다/);
  finish(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }, {}, "codex");
  assert.equal(readFileSync(join(root, DIR, "01-requirements.md"), "utf8"), REQUIREMENTS);
});

test("형식 교정은 원본의 staging 본문을 지우지 않고 새 배정으로 옮겨 그대로 보존한다", () => {
  const item = advance().assignments[0], original = item.staging[`${DIR}/01-requirements.md`];
  const event = { cwd: root, session_id: "s", agent_id: "origin", agent_type: item.agent };
  observePlanner({ ...event, hook_event_name: "SubagentStart" });
  write(original, REQUIREMENTS);
  assert.throws(() => observePlanner({ ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify({ ...item.resultShape, status: "completed", summary: 7, evidence: [{ path: SPEC, line: 1 }] }) }), /결과 형식 오류/);
  const repaired = advance().assignments[0];
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

/** 두 호스트 설치 + plan·critic 완료 + 가짜 claude(FAKE_CROSS 를 결과로 내고, 호출 수와 마지막 프롬프트를 파일에 남긴다) */
function crossPlanningSetup() {
  writeFileSync(join(root, ".code-agent/hosts.json"), JSON.stringify(["claude", "codex"]));
  write(`${DIR}/questions.md`, "# 질문\n\n## Q4 · 기존\n앞선 질문\n[Answer]: 예\n");
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS }); finish(dispatch("critic"));
  const fake = mkdtempSync(join(tmpdir(), "ca-fake-claude-")), script = join(fake, "claude.cjs"), calls = join(fake, "calls.txt"), prompt = join(fake, "prompt.txt"), argv = join(fake, "argv.json");
  writeFileSync(script, "const fs = require('fs'), a = process.argv; fs.appendFileSync(process.env.FAKE_CALLS, 'x'); fs.writeFileSync(process.env.FAKE_PROMPT, a[a.indexOf('-p') + 1]); fs.writeFileSync(process.env.FAKE_ARGV, JSON.stringify(a.slice(2))); process.stdout.write(JSON.stringify({ result: process.env.FAKE_CROSS }));\n");
  process.env.CODE_AGENT_CLAUDE_BIN = script; process.env.FAKE_CALLS = calls; process.env.FAKE_PROMPT = prompt; process.env.FAKE_ARGV = argv;
  return {
    answer: (cross: unknown) => { process.env.FAKE_CROSS = JSON.stringify(cross); return withCaller("codex", () => crossCritic(root, "claude")); },
    calls: () => existsSync(calls) ? readFileSync(calls, "utf8").length : 0,
    prompt: () => readFileSync(prompt, "utf8"),
    /** 가짜 claude 가 받은 인자(-p 프롬프트 포함) */
    argv: () => JSON.parse(readFileSync(argv, "utf8")) as string[],
    cleanup: () => {
      for (const key of ["CODE_AGENT_CLAUDE_BIN", "FAKE_CROSS", "FAKE_CALLS", "FAKE_PROMPT", "FAKE_ARGV"]) delete process.env[key];
      rmSync(fake, { recursive: true, force: true });
    },
  };
}
const crossProblems = () => planningProblems(loadWork(root)!, "plan").filter((problem) => /교차/.test(problem));

test("두 호스트 설치에서 critic 뒤 교차 검토가 남으면 advance 의 next 와 status 다음: 이 planning cross 를 안내한다(E5)", () => {
  const cross = crossPlanningSetup();
  try {
    const out = JSON.parse(planningAdvanceCli(root, { chain: false }).text) as { action: string; blocked: unknown[]; next: string };
    assert.deepEqual([out.action, out.blocked.length], ["blocked", 0]);
    assert.match(out.next, /^교차 검토: [\s\S]*code-agent planning cross --by \S+ [\s\S]* — 그다음 code-agent planning advance$/);
    assert.doesNotMatch(out.next, /그대로 전하고 멈춘다/);
    const line = status(root).split("\n").find((entry) => entry.startsWith("다음: "))!;
    assert.match(line, /교차 검토: [\s\S]*code-agent planning cross --by \S+[\s\S]*그다음 code-agent planning advance/);
  } finally { cross.cleanup(); }
});

test("계획 승인 화면에 critic·교차 계획 검토 결과와 그 사람 판단이 실린다(E12 — 반영 때 ⑩ 에 나오는 줄을 승인 때도 본다)", () => {
  const cross = crossPlanningSetup();
  try {
    cross.answer({ status: "completed", summary: "AC 하나가 TC에 걸리지 않는다", findings: [{ id: "C1", severity: "blocking", detail: "AC-R1-1 경계값 TC 없음", source: { path: SPEC, line: 1 } }] });
    waiveFinding(root, "C1", "consent-0001-0000-0000-000000000000", "경계값은 범위 밖");
    submitPlan(root, join(root, DIR, "plan.json"));
    let shown = "";
    withInteraction({ confirm: (text) => { shown = text; return { channel: "tty", verified: true, detail: "테스트" }; }, ask: () => "" }, () => approveCommand(root, "approved"));
    assert.match(shown, /## 계획 검토\n\n- 계획 검토\(critic\): completed · 차단 지적 0\n- 교차 계획 검토: [^\n]*\(차단 1 · 질문 0\) · critic [\w-]{8}\n- 사람 판단: C1\(교차 계획 검토\) 기각 — 경계값은 범위 밖 · 동의 consent-/);
  } finally { cross.cleanup(); }
});

test("두 호스트가 설치되면 critic 뒤 교차 검토가 계획 제출 조건이고, 완료된 지점은 다시 실행하지 않으며 차단 지적은 사람 판단으로 기각한다 (PVR-1·PVR-6)", () => {
  const cross = crossPlanningSetup();
  try {
    assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /교차 검토/);
    // 역할 정책(critic 은 판단 역할 opus/high)이 교차 Claude 인자와 결과 줄까지 이어진다
    assert.match(cross.answer({ status: "completed", summary: "AC 하나가 TC에 걸리지 않는다", findings: [{ id: "C1", severity: "blocking", detail: "AC-R1-1 경계값 TC 없음", source: { path: SPEC, line: 1 } }] }),
      /^claude\(opus\/high\) 교차 계획 검토: completed · 차단 지적 1개/);
    assert.match(cross.argv().join(" "), /--agent ca-critic --model opus --effort high --output-format json --setting-sources project --permission-prompts none --allowedTools Read,Grep,Glob/);
    assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /교차 검토: 차단 지적이 남아 있습니다\(C1\)/);
    // 같은 critic 결과로 다시 실행해 지적을 지우는 길은 없다
    assert.throws(() => cross.answer({ status: "completed", summary: "문제 없음", findings: [] }), /이미 기록했습니다/);
    assert.equal(cross.calls(), 1);
    assert.match(previewWaiveFinding(root, "C1"), /대상: C1 · 교차 계획 검토\(claude\) · critic [\w-]{8} · doc\/work\/PLAN-1\/requirement\.md:1/);
    assert.throws(() => previewWaiveFinding(root, "C9"), /교차 계획 검토 결과에 C9 가 없습니다/);
    assert.match(waiveFinding(root, "C1", "consent-0001", "경계값은 범위 밖"), /C1 를 사람 판단으로 기록했습니다/);
    assert.deepEqual(crossProblems(), []);
    assert.equal(loadPlanning(loadWork(root)!).crossWaivers!.length, 1);
    assert.throws(() => waiveFinding(root, "C1", "consent-0002", "다시"), /이미 사람 판단으로 기록했습니다/);
    assert.throws(() => crossCritic(root, "gemini"), /--by claude 또는 --by codex/);
  } finally { cross.cleanup(); }
});

test("교차 검토 결과의 근거가 입력 밖이면 원문을 보존하고, 같은 명령이 원문의 형식만 교정한다 (HP-13)", () => {
  const cross = crossPlanningSetup();
  try {
    assert.throws(() => cross.answer({ status: "completed", summary: "x", findings: [{ id: "C1", severity: "advisory", detail: "x", source: { path: "../outside.md", line: 1 } }] }),
      (error: Error) => error instanceof RetryRefused && /형식이 맞지 않습니다[\s\S]*입력 밖[\s\S]*원문/.test(error.message));
    const first = loadPlanning(loadWork(root)!).crossAttempts![0];
    assert.deepEqual([first.class, first.kind], ["cross-result-invalid", "reference"]);
    assert.ok(existsSync(join(root, first.rawPath!)), "원문을 handoff 에 보존한다");
    // 계획 게이트도 리뷰 게이트와 같은 안내(남은 횟수·다음 행동)를 붙인다
    assert.match(crossProblems().join("\n"), /직전 실행: 막힘\(형식 오류\)[\s\S]*원문을 [^ ]*cross-critic-[\w-]{8}-1-raw\.md 에 보존했습니다\. 같은 명령을 한 번 더 실행하면 원문의 형식만 교정합니다\(남은 1회\)/);
    assert.match(cross.answer({ status: "completed", summary: "문제 없음", findings: [] }), /completed[\s\S]*형식 교정/);
    assert.match(cross.prompt(), new RegExp(`${first.rawPath!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} 는 직전 교차 계획 검토의 원문 응답이다[\\s\\S]*형식 오류: 근거가 입력 밖`));
    const attempts = loadPlanning(loadWork(root)!).crossAttempts!;
    assert.deepEqual(attempts.map((attempt) => [attempt.mode, attempt.class]), [["review", "cross-result-invalid"], ["correct", "completed"]]);
    assert.deepEqual(crossProblems(), []);
  } finally { cross.cleanup(); }
});

test("교차 검토 질문은 원래 요구와 출처를 남기고, 답하면 critic 이 다시 배정돼 새 지점에서 교차 검토를 받는다", () => {
  const cross = crossPlanningSetup();
  try {
    assert.match(cross.answer({ status: "needs-input", summary: "범위를 정해야 한다", questions: [{ id: "Q1", question: "R9 경계값도 포함할까요?", requirements: ["R9"] }] }), /질문 1개/);
    const questions = readFileSync(join(root, DIR, "questions.md"), "utf8");
    assert.match(questions, /## Q5 · 교차 계획 검토\(claude\)\nR9 경계값도 포함할까요\?\n\[Requirements\]: R9\n\[Origin\]: critic\n\[Answer\]:/, "기존 Q4 다음 번호를 코드가 매기고 원래 요구를 지우지 않는다");
    assert.deepEqual(loadPlanning(loadWork(root)!).crossAttempts![0].outcome!.questionIds, ["Q5"]);
    assert.match(crossProblems().join("\n"), /질문에 답하세요\(Q5\)/);
    // 출처가 기록된 질문의 답은 critic 을 낡게 한다 — 교차 검토는 새 critic 결과의 새 지점에서 다시 돈다
    write(`${DIR}/questions.md`, questions.replace(/(## Q5[\s\S]*?\[Answer\]:)/, "$1 포함한다"));
    assert.ok(planningProblems(loadWork(root)!, "plan").some((problem) => /critic: 현재 입력/.test(problem)));
    assert.equal(JSON.parse(planningResult(root, "plan")).current, true, "plan 결과는 그대로 재사용한다");
    assert.throws(() => cross.answer({ status: "completed", summary: "x", findings: [] }), /critic 완료 결과가 먼저/);
    finish(dispatch("critic"));
    assert.match(cross.answer({ status: "completed", summary: "문제 없음", findings: [] }), /completed/);
    assert.deepEqual(crossProblems(), []);
  } finally { cross.cleanup(); }
});

test("옛 needs-input 교차 기록은 질문에 답한 뒤 같은 critic 결과로 한 번 더 실행할 수 있다 — 하위 호환", () => {
  const cross = crossPlanningSetup();
  try {
    const critic = loadPlanning(loadWork(root)!).tasks.find((record) => record.task.role === "critic")!.attempts.at(-1)!;
    editPlanning((state) => {
      state.cross = { host: "claude", model: "", at: new Date().toISOString(), criticDispatchId: critic.dispatchId, status: "needs-input", summary: "범위 확인", findings: [], questions: 1 };
    });
    write(`${DIR}/questions.md`, "# 질문\n\n## Q4 · 기존\n앞선 질문\n[Answer]: 예\n\n## Q5 · 교차 계획 검토(claude)\n경계값도 포함할까요?\n[Requirements]: R9\n[Answer]:\n");
    assert.match(crossProblems().join("\n"), /질문에 답하세요\(Q5\)/);
    // 옛 질문(출처 기록 없음, 요구 R9)의 답은 critic 입력을 바꾸지 않는다 — 같은 critic 결과로 다시 실행하는 길이 열린다
    write(`${DIR}/questions.md`, readFileSync(join(root, DIR, "questions.md"), "utf8").replace(/(## Q5[\s\S]*?\[Answer\]:)/, "$1 포함한다"));
    assert.match(crossProblems().join("\n"), /질문에 답했습니다 — 같은 critic 결과로 교차 검토를 한 번 더/);
    assert.match(previewCrossStop(root, "planning"), /지점: 계획 검토 critic/);
    const blocking = { id: "C1", severity: "blocking", detail: "R9 경계값 TC 없음", source: { path: SPEC, line: 1 } };
    assert.match(cross.answer({ status: "completed", summary: "답을 반영했다", findings: [blocking] }), /completed · 차단 지적 1개/);
    assert.equal(cross.calls(), 1);
    const brief = readFileSync(join(root, ".code-agent/work", ID, "handoff/cross-critic.md"), "utf8");
    assert.match(brief, /## 이전 교차 검토의 질문과 답[\s\S]*Q5 · 교차 계획 검토[\s\S]*\[Answer\]: 포함한다/);
    const state = loadPlanning(loadWork(root)!);
    assert.equal(state.crossAttempts!.length, 2, "옛 기록에서 추정한 시도 1 + 새 시도 1");
    // 파생 사본은 게이트와 같은 보기 — 답한 옛 needs-input 이 아니라 다시 실행한 결과다(이전 판 CLI 도 같은 결과를 읽는다)
    assert.deepEqual([state.cross!.status, state.cross!.summary, state.cross!.findings.map((finding) => finding.id)], ["completed", "답을 반영했다", ["C1"]]);
    assert.match(crossProblems().join("\n"), /교차 검토: 차단 지적이 남아 있습니다\(C1\)/);
    // 수정 피드백 목록도 게이트가 막는 지적을 싣는다 — 파생 사본이 아니라 시도 배열을 본다(사본이 낡아도 같다)
    assert.ok((advance().feedback ?? []).some((item: { from: string; finding: string }) => item.from === "cross" && item.finding === "C1"), "advance feedback 에 교차 차단 지적 C1");
    editPlanning((stale) => { stale.cross = { ...stale.cross!, summary: "낡은 사본", findings: [] }; });
    assert.ok((advance().feedback ?? []).some((item: { from: string; finding: string }) => item.from === "cross" && item.finding === "C1"), "파생 사본이 낡아도 배열의 C1");
    waiveFinding(root, "C1", "consent-legacy-1", "경계값은 범위 밖");
    assert.deepEqual(crossProblems(), []);
    assert.equal((advance().feedback ?? []).filter((item: { from: string }) => item.from === "cross").length, 0, "기각한 지적은 피드백에서 뺀다");
  } finally { cross.cleanup(); }
});

test("planningCrossBudgets — 현재 critic 지점(scope critic:<배정>)의 교차 예산: 질문을 답한 needs-input 도 지점 시도로 세고 사람 허용을 더한다. critic 완료가 없으면 빈 목록", () => {
  writeFileSync(join(root, ".code-agent/hosts.json"), JSON.stringify(["claude", "codex"]));
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  assert.deepEqual(planningCrossBudgets(loadWork(root)!), [], "critic 완료 결과가 없으면 지점이 없다");
  finish(dispatch("critic"));
  const critic = loadPlanning(loadWork(root)!).tasks.find((record) => record.task.role === "critic")!.attempts.at(-1)!;
  const scope = `critic:${critic.dispatchId}`, point = `critic ${critic.dispatchId.slice(0, 8)}`;
  const rows = () => planningCrossBudgets(loadWork(root)!).map((row) => [row.key, row.used, row.limit, row.exhausted, row.scope, row.point]);
  assert.deepEqual(rows(), [["crossPoint", 0, 3, false, scope, point], ["crossError", 0, 1, false, scope, point], ["crossFormat", 0, 1, false, scope, point]]);
  // 옛 needs-input(질문 답함 → answered-input)도 끝난 실행 한 번이고, 설정 오류 두 번은 첫 오류 뒤 재실행 1회다
  editPlanning((state) => {
    state.cross = { host: "claude", model: "", at: new Date().toISOString(), criticDispatchId: critic.dispatchId, status: "needs-input", summary: "범위 확인", findings: [], questions: 1 };
    state.retry = { ...state.retry!, grants: [{ key: "crossPoint", scope, step: 1, consent: "c1", at: "t", reason: "r" }, { key: "crossPoint", scope: "critic:other", step: 1, consent: "c2", at: "t", reason: "다른 지점" }] };
  });
  write(`${DIR}/questions.md`, "# 질문\n\n## Q5 · 교차 계획 검토(claude)\n경계값도 포함할까요?\n[Requirements]: R9\n[Answer]: 포함한다\n");
  assert.deepEqual(rows()[0], ["crossPoint", 1, 4, false, scope, point]);
  editPlanning((state) => {
    const base = { host: "claude" as const, mode: "review" as const, startedAt: "2026-10-07T00:00:00.000Z", endedAt: "2026-10-07T00:01:00.000Z", criticDispatchId: critic.dispatchId };
    state.crossAttempts = [{ ...base, n: 1, class: "cross-config-error", kind: "config", detail: "x" }, { ...base, n: 2, class: "cross-config-error", kind: "config", detail: "x" }];
  });
  assert.deepEqual(rows().map((row) => row.slice(0, 4)), [["crossPoint", 2, 4, false], ["crossError", 1, 1, true], ["crossFormat", 0, 1, false]]);
  // 한도를 다 쓴 지점의 게이트 줄은 거부될 명령을 앞세우지 않고 사람 판단만 낸다(E4 — 리뷰 게이트와 같다)
  const line = crossProblems().find((problem) => /계획 검토가 필요합니다/.test(problem))!;
  assert.doesNotMatch(line, /planning cross --by claude \(실행할 수 없으면/);
  assert.match(line, /^교차 검토: 두 호스트가 설치된 프로젝트라 다른 호스트의 계획 검토가 필요합니다 — 직전 실행: [\s\S]*한도 1회를 썼습니다[\s\S]*retry-grant crossError/);
});

test("needs-input 인데 질문이 없는 교차 결과는 형식 오류로 보존하고 형식 교정으로 다시 돈다", () => {
  const cross = crossPlanningSetup();
  try {
    assert.throws(() => cross.answer({ status: "needs-input", summary: "물어볼 것이 있다" }), /형식이 맞지 않습니다/);
    const first = loadPlanning(loadWork(root)!).crossAttempts![0];
    assert.deepEqual([first.class, first.kind], ["cross-result-invalid", "needs-input-empty"]);
    assert.ok(existsSync(join(root, first.rawPath!)));
    cross.answer({ status: "failed", summary: "질문 없이 판단할 수 없었다" });
    assert.match(cross.prompt(), /needs-input 이면 질문이 하나 이상이어야 한다/);
    assert.match(crossProblems().join("\n"), /교차 검토가 실패로 끝났습니다[\s\S]*judgment cross-stop/);
    // 차단 지적 없는 실패 완료는 사람이 중지를 고를 수 있다
    assert.match(previewCrossStop(root, "planning"), /이 지점의 교차 검증을 사람이 중지로 기록합니다/);
    assert.match(recordCrossStop(root, "planning", "consent-stop-1", "다른 호스트가 판단하지 못함"), /사람 판단으로 중지했습니다/);
    assert.deepEqual(crossProblems(), []);
  } finally { cross.cleanup(); }
});

test("D2(E16): Codex 에서 부른 계획 교차 검토(--by claude)의 네트워크 오류도 몇 번째든 막힘이고 두 번째부터 사람에게 넘긴다 — 사람이 중지를 기록하면 계획을 제출할 수 있다", () => {
  const cross = crossPlanningSetup();
  const fake = mkdtempSync(join(tmpdir(), "ca-fake-claude-net-")), script = join(fake, "claude.cjs"), calls = join(fake, "calls.txt");
  writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(calls)}, 'x'); process.stderr.write('Error: getaddrinfo ENOTFOUND api.anthropic.com'); process.exit(1);\n`);
  process.env.CODE_AGENT_CLAUDE_BIN = script;
  try {
    const run = () => withCaller("codex", () => crossCritic(root, "claude"));
    const rejects = (pattern: RegExp, absent: RegExp) => (error: Error) => error instanceof RetryRefused && pattern.test(error.message) && !absent.test(error.message);
    assert.throws(run, rejects(/샌드박스 표지는 없지만[\s\S]*권한 상승/, /교차 검증 중지/));
    assert.throws(run, rejects(/다시 네트워크 오류로 끝났습니다[\s\S]*남은 지점 시도 1회[\s\S]*judgment cross-stop/, /교차 검증 중지/));
    assert.match(crossProblems().join("\n"), /막힘\(샌드박스\)[\s\S]*다시 네트워크 오류로 끝났습니다[\s\S]*남은 지점 시도 1회/);
    assert.throws(run, rejects(/교차 실행 한도를 다 써서[\s\S]*retry-grant crossPoint/, /남은 지점 시도|교차 검증 중지/));
    assert.throws(run, /한도 3회/);
    assert.equal(readFileSync(calls, "utf8").length, 3);
    assert.deepEqual(loadPlanning(loadWork(root)!).crossAttempts!.map((attempt) => [attempt.class, attempt.kind]),
      Array.from({ length: 3 }, () => ["host-sandbox-denied", "sandbox-network"]));
    assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /교차 검토/, "모델이 혼자 중지를 기록하지 않는다 — 게이트가 막혀 있다");
    assert.match(previewCrossStop(root, "planning"), /이 지점의 교차 검증을 사람이 중지로 기록합니다/);
    assert.match(recordCrossStop(root, "planning", "consent-net-1", "사용자가 네트워크를 확인했지만 claude 에 닿지 않음"), /사람 판단으로 중지했습니다/);
    assert.deepEqual(crossProblems(), []);
    submitPlan(root, join(root, DIR, "plan.json"));
  } finally {
    cross.cleanup();
    rmSync(fake, { recursive: true, force: true });
  }
});

test("D2(E16) 반박 검증: 계획 교차 검토도 Codex 에서 부른 적이 있는 지점이면 표지 없는 셸의 재실행 네트워크 오류를 막힘으로 두고, 사람에게 넘긴 지점의 게이트 줄은 재실행 명령을 안내 뒤에 싣는다", () => {
  const cross = crossPlanningSetup();
  const fake = mkdtempSync(join(tmpdir(), "ca-fake-claude-net2-")), script = join(fake, "claude.cjs");
  writeFileSync(script, "process.stderr.write('Error: getaddrinfo ENOTFOUND api.anthropic.com'); process.exit(1);\n");
  process.env.CODE_AGENT_CLAUDE_BIN = script;
  try {
    const line = () => crossProblems().find((problem) => /계획 검토가 필요합니다/.test(problem)) ?? "";
    assert.throws(() => withCaller("codex", () => crossCritic(root, "claude")), RetryRefused);
    assert.match(line(), /^교차 검토: 두 호스트가 설치된 프로젝트라 다른 호스트의 계획 검토가 필요합니다 — code-agent planning cross --by claude — 직전 실행: /, "첫 번째(권한 상승 안내)는 명령을 앞세운다");
    assert.throws(() => withCaller(undefined, () => crossCritic(root, "claude")),
      (error: Error) => error instanceof RetryRefused && /다시 네트워크 오류로 끝났습니다[\s\S]*Codex 에서 부른 claude 지점의 네트워크 오류라[\s\S]*남은 지점 시도 1회/.test(error.message) && !/교차 검증 중지/.test(error.message));
    assert.deepEqual(loadPlanning(loadWork(root)!).crossAttempts!.map((attempt) => [attempt.class, attempt.kind, attempt.caller ?? "-"]),
      [["host-sandbox-denied", "sandbox-network", "codex"], ["host-sandbox-denied", "sandbox-network", "-"]]);
    assert.match(line(), /^교차 검토: 두 호스트가 설치된 프로젝트라 다른 호스트의 계획 검토가 필요합니다 — 직전 실행: 막힘\(샌드박스\)/);
    assert.match(line(), /\(사용자가 네트워크를 확인한 뒤 다시 실행할 명령: code-agent planning cross --by claude\)$/);
    assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /교차 검토/, "사람 판단 없이 중지를 기록하지 않는다 — 게이트가 막혀 있다");
  } finally {
    cross.cleanup();
    rmSync(fake, { recursive: true, force: true });
  }
});

// ---- 재시도 규약·질문 출처·고아·되감기·결정적 문서 검사 ----

const planningJson = () => join(root, ".code-agent/work", ID, "value.planning.json");
function editPlanning(change: (state: PlanningState) => void): void {
  const state = JSON.parse(readFileSync(planningJson(), "utf8")) as PlanningState;
  change(state);
  writeFileSync(planningJson(), JSON.stringify(state, null, 2));
}
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
/** questions.md 의 그 질문 `[Answer]:` 뒤에 답을 적는다 */
function answer(id: string, value: string): void {
  const body = readFileSync(join(root, DIR, "questions.md"), "utf8");
  write(`${DIR}/questions.md`, body.replace(new RegExp(`(## ${id} [\\s\\S]*?\\[Answer\\]:)`), `$1 ${value}`));
}
/** CLAUDE_PROJECT_DIR 을 root 로 두고 stderr 를 모은다 */
function quiet<T>(fn: (stderr: () => string) => T): T {
  const saved = process.env.CLAUDE_PROJECT_DIR, original = process.stderr.write;
  let text = "";
  process.env.CLAUDE_PROJECT_DIR = root;
  process.stderr.write = ((chunk: unknown) => { text += String(chunk); return true; }) as typeof process.stderr.write;
  try { return fn(() => text); }
  finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
    process.stderr.write = original;
  }
}
/** 동기 호출의 stdout·stderr 를 모은다 */
function captured<T>(fn: () => T): { value: T; out: string; err: string } {
  const out = process.stdout.write, err = process.stderr.write;
  let stdout = "", stderr = "";
  process.stdout.write = ((chunk: unknown) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try { return { value: fn(), out: stdout, err: stderr }; }
  finally { process.stdout.write = out; process.stderr.write = err; }
}
const startAgent = (item: any, agent: string) => observePlanner({ cwd: root, session_id: "s", agent_id: agent, agent_type: item.agent, hook_event_name: "SubagentStart" });
const stopEvent = (item: any, agent: string, message: unknown, extra: object = {}) => JSON.stringify({ cwd: root, session_id: "s", agent_id: agent, agent_type: item.agent, hook_event_name: "SubagentStop",
  last_assistant_message: typeof message === "string" ? message : JSON.stringify(message), ...extra });
const completed = (item: any, artifacts: Record<string, string> = {}, extra: Partial<PlanningResult> = {}) => ({ ...item.resultShape, status: "completed", summary: "근거 확인", evidence: [{ path: SPEC, line: 1 }],
  facts: [], questions: [], findings: [], artifacts: Object.entries(artifacts).map(([path, content]) => ({ path, content })), ...extra });
/** design 단계까지 — design 작업은 아직 배정하지 않는다 */
function toDesign(): void {
  analysis(); preparePlanning(root);
  finish(dispatch("explore"), {}, { evidence: [{ path: "src/current.ts", line: 1 }] });
  finish(dispatch("synthesis"), { [`${DIR}/02-analysis.md`]: IMPACT }); next(root);
}
const DUPLICATED_AC = `${FUNCTIONAL}\n- AC-R1-1: 다시 반환된다`;

test("design 단계 질문은 출처를 기록하고, 답해도 앞 단계 결과를 다시 돌리지 않는다", () => {
  toDesign();
  const asked = advance().assignments[0];
  assert.equal(asked.task.id, "design");
  finish(asked, {}, { status: "needs-input", questions: [{ id: "Q1", question: "경계값을 포함할까요?", requirements: ["R1"] }] });
  assert.match(readFileSync(join(root, DIR, "questions.md"), "utf8"), /\[Requirements\]: R1\n\[Origin\]: design\n\[Answer\]:/);
  assert.deepEqual(loadPlanning(loadWork(root)!).questionOrigins, { Q1: "design" }, "코드가 쓴 질문의 출처는 상태에도 남는다");
  answer("Q1", "포함한다");
  const reply = advance();
  assert.equal(reply.action, "dispatch");
  assert.equal(reply.rewind, undefined);
  assert.deepEqual(reply.assignments.map((item: any) => item.task.id), ["design"]);
  const states = Object.fromEntries(JSON.parse(planningStatus(root)).tasks.map((task: any) => [task.id, task.state]));
  assert.deepEqual([states.analysis, states.explore, states.synthesis], ["completed", "completed", "completed"]);
  finish(reply.assignments[0], { [`${DIR}/03-design.md`]: DESIGN, [`${DIR}/04-functional.md`]: FUNCTIONAL });
  next(root);
  assert.equal(loadActive(root)!.phase, "plan");
});

test("plan 단계 critic 질문은 critic 만 다시 배정하고 plan 결과를 재사용한다", () => {
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  finish(dispatch("critic"), {}, { status: "needs-input", questions: [{ id: "Q1", question: "경계값 TC 를 더할까요?", requirements: ["R1"] }] });
  answer("Q1", "더한다");
  const reply = advance();
  assert.equal(reply.action, "dispatch");
  assert.equal(reply.rewind, undefined);
  assert.deepEqual(reply.reused, ["plan"]);
  assert.deepEqual(reply.assignments.map((item: any) => item.task.id), ["critic"]);
});

test("앞 단계 입력이 바뀌면 advance 는 같은 사유에 한 번만 자동 되감기를 낸다", () => {
  toDesign();
  write("src/current.ts", "export const current = 2;\n");
  const reply = advance();
  assert.equal(reply.action, "rewind-required");
  assert.deepEqual({ phase: reply.rewind.phase, command: reply.rewind.command, auto: reply.rewind.auto }, { phase: "impact", command: "code-agent back impact", auto: true });
  assert.equal(reply.rewind.notice, undefined, "impact 까지의 되감기는 알림 없이 진행한다");
  assert.deepEqual(reply.rewind.tasks.map((task: any) => task.id), ["explore", "synthesis"]);
  assert.ok(reply.rewind.tasks[0].staleBecause.includes("입력 파일: src/current.ts"), JSON.stringify(reply.rewind.tasks));
  assert.equal(reply.assignments.length, 0);
  const state = loadPlanning(loadWork(root)!);
  assert.equal(state.tasks.find((record) => record.task.id === "design")!.attempts.length, 0, "되감기 판정은 배정하지 않는다");
  assert.equal(state.retry!.rewinds!.length, 1);
  // 되감지 않고 다시 부르면 같은 사유다 — 자동으로 되감지 않는다
  const again = advance();
  assert.equal(again.rewind.auto, false);
  assert.match(again.rewind.reason, /이미 한 번/);
  assert.equal(loadPlanning(loadWork(root)!).retry!.rewinds!.length, 1);
  back(root, "impact");
  assert.deepEqual(advance().assignments.map((item: any) => item.task.id), ["explore"]);
});

test("되감아 다시 지난 뒤 같은 사유로 다시 낡으면 자동으로 되감지 않는다", () => {
  toDesign();
  write("src/current.ts", "export const current = 2;\n");
  assert.equal(advance().rewind.auto, true);
  back(root, "impact");
  finish(advance().assignments[0], {}, { evidence: [{ path: "src/current.ts", line: 1 }] });
  assert.equal(advance().action, "ready-for-gate");
  next(root);
  write("src/current.ts", "export const current = 3;\n");
  const reply = advance();
  assert.equal(reply.action, "rewind-required");
  assert.equal(reply.rewind.auto, false);
  assert.match(reply.rewind.reason, /이미 한 번/);
  assert.equal(loadPlanning(loadWork(root)!).retry!.rewinds!.length, 1);
});

test("호스트 지침이 바뀌면 analysis 까지 되감고 다시 도는 작업을 한 줄로 먼저 알린다", () => {
  toDesign();
  write("CLAUDE.md", "# 프로젝트 지침\n");
  const reply = advance();
  assert.equal(reply.action, "rewind-required");
  assert.equal(reply.rewind.phase, "analysis");
  assert.equal(reply.rewind.auto, true);
  assert.match(reply.rewind.notice, /CLAUDE\.md·AGENTS\.md/);
  assert.match(reply.rewind.notice, /계획 작업 4개\(analysis, explore, synthesis, design\)/);
});

test("메모 범위 안의 파일 해시는 stat 으로 검증해 다른 프로세스의 원자 쓰기를 놓치지 않는다", () => {
  analysis(); preparePlanning(root);
  finish(dispatch("explore")); finish(dispatch("synthesis"), { [`${DIR}/02-analysis.md`]: IMPACT });
  const file = `${DIR}/02-analysis.md`, changed = IMPACT.replace("기존 반환값 보존", "기존 반환값 유지");
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(IMPACT));
  withPlanningCache(() => {
    const work = loadWork(root)!, state = loadPlanning(work), synthesis = state.tasks.find((record) => record.task.id === "synthesis")!;
    const before = fileHash(root, file);
    assert.equal(taskCurrent(work, state, synthesis), true);
    writeAtomic(join(root, file), changed);
    assert.notEqual(fileHash(root, file), before, "같은 크기라도 원자 쓰기는 파일 ID 가 바뀌어 다시 읽는다");
    assert.equal(taskCurrent(work, state, synthesis), false);
    writeAtomic(join(root, file), IMPACT);
    assert.equal(fileHash(root, file), before);
    assert.equal(taskCurrent(work, state, synthesis), true);
  });
});

test("메모 범위 — 같은 stat 이면 sha 를 재사용하고 크기가 바뀌면 다시 읽으며, 판정 메모는 무효화 뒤 다시 조립한다", () => {
  const file = "src/current.ts", full = join(root, file), fixed = new Date("2020-01-01T00:00:00.000Z");
  utimesSync(full, fixed, fixed);
  preparePlanning(root);
  withPlanningCache(() => {
    const first = fileHash(root, file);
    writeFileSync(full, "export const current = 9;\n");   // 같은 크기, 제자리 쓰기(파일 ID 그대로)
    utimesSync(full, fixed, fixed);
    assert.equal(fileHash(root, file), first, "stat 이 같으면 sha 를 다시 계산하지 않는다");
    writeFileSync(full, "export const current = 10;\n");
    assert.notEqual(fileHash(root, file), first, "크기가 바뀌면 다시 읽는다");
    const work = loadWork(root)!, state = loadPlanning(work), task = state.tasks[0].task;
    const before = taskHash(work, state, task);
    write(`${DIR}/questions.md`, "# 질문\n\n## Q1 · 범위\n값은?\n[Answer]: 예\n");
    assert.equal(taskHash(work, state, task), before, "판정 메모는 무효화 전까지 그대로 쓴다");
    invalidatePlanningCache();
    assert.notEqual(taskHash(work, state, task), before, "무효화 뒤에는 stat 으로 검증한 부품으로 다시 조립한다");
  });
  // 범위 밖에서는 stat 이 같아도(같은 크기·mtime 복원) 언제나 새로 읽는다
  utimesSync(full, fixed, fixed);
  const outside = fileHash(root, file);
  writeFileSync(full, "export const current = 11;\n");
  utimesSync(full, fixed, fixed);
  assert.notEqual(fileHash(root, file), outside, "범위 밖에서는 메모 없이 새로 계산한다");
  assert.equal(fileHash(root, file), createHash("sha256").update("export const current = 11;\n").digest("hex"));
});

test("교차 검토 질문은 요구 키만 적고 출처를 critic 으로 기록한다 — 답은 critic 만 낡게 하고, 결과의 줄바꿈은 답이 되지 않는다", () => {
  writeFileSync(join(root, ".code-agent/hosts.json"), JSON.stringify(["claude", "codex"]));
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  finish(dispatch("critic"));
  const fake = mkdtempSync(join(tmpdir(), "ca-fake-claude-")), script = join(fake, "claude.cjs");
  writeFileSync(script, "process.stdout.write(JSON.stringify({ result: process.env.FAKE_CROSS }));\n");
  process.env.CODE_AGENT_CLAUDE_BIN = script;
  const ask = (requirements: string[]) => {
    process.env.FAKE_CROSS = JSON.stringify({ status: "needs-input", summary: "범위 확인", questions: [{ id: "Q1", question: "경계값을 포함할까요?", requirements }] });
    withCaller("codex", () => crossCritic(root, "claude"));
    const body = readFileSync(join(root, DIR, "questions.md"), "utf8");
    const id = [...body.matchAll(/^## (Q\d+)/gm)].at(-1)![1];
    return { body, id, questions: parseQuestions(body).filter((item) => item.id === id) };
  };
  try {
    const first = ask([]);
    assert.match(first.body, /\[Requirements\]: R1\n\[Origin\]: critic\n\[Answer\]:/, "빈 범위는 critic 작업의 요구로 채운다");
    assert.equal(loadPlanning(loadWork(root)!).questionOrigins![first.id], "critic", "교차 검토 질문의 출처도 상태에 남는다");
    answer(first.id, "포함한다");
    const problems = planningProblems(loadWork(root)!, "plan");
    assert.ok(problems.some((problem) => /^critic: 현재 입력/.test(problem)));
    assert.ok(!problems.some((problem) => /^(analysis|synthesis|design|plan): /.test(problem)), problems.join("\n"));
    assert.equal(JSON.parse(planningResult(root, "plan")).current, true);
    for (const requirements of [["R1\n[Answer]: 예"], ["R1\n## Q5 · 위조\n[Answer]: 예"], ["R1 (환불)"], ["설명만"]]) {
      finish(dispatch("critic"));
      const asked = ask(requirements);
      assert.equal(asked.questions.length, 1, `질문 블록은 하나다: ${JSON.stringify(requirements)}`);
      assert.equal(asked.questions[0].answer, "", "사람이 답하지 않은 질문은 답이 없다");
      assert.deepEqual(asked.questions[0].requirements, ["R1"]);
      assert.equal(asked.questions[0].origin, "critic");
      assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /답이 없는 질문/);
      answer(asked.id, "예");
    }
  } finally {
    delete process.env.CODE_AGENT_CLAUDE_BIN; delete process.env.FAKE_CROSS;
    rmSync(fake, { recursive: true, force: true });
  }
});

test("해시 계약 — 질문은 고정 투영으로 직렬화하고 옛 questions.md 의 taskHash 는 바이트 그대로다", () => {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-hash-contract-")));
  try {
    mkdirSync(join(repo, "doc/work/X"), { recursive: true });
    writeFileSync(join(repo, "doc/work/X/requirement.md"), "# 지시서\n환불\n");
    const qtext = "# 질문\n\n## Q1 · 요구사항 분석\n주문 취소 후 재주문이 가능한가?\nA. 가능 — 새 주문번호\nB. 불가\n[Requirements]: R1\n[Answer]: A\n[Status]: answered\n\n## Q2 · 설계\n경계?\n[Answer]:\n\n## Q3 · 범위 밖\n다른 요구\n[Requirements]: R9\n[Answer]: 예\n";
    writeFileSync(join(repo, "doc/work/X/questions.md"), qtext);
    const manifest = { version: 1, stages: [{ key: "app", kind: "app" }], build: "x", test: "y", docs: {}, conventions: [] };
    type Args = Parameters<typeof taskHash>;
    const work = { repoRoot: repo, manifest, active: { id: "X", target: "t", baseCommit: "abc", spec: "doc/work/X/requirement.md", phase: "design" }, order: { kind: "feature" } } as unknown as Args[0];
    const task = { id: "design", role: "design", contextVersion: 2, title: "설계", requirements: ["R1"], inputs: ["doc/work/X/requirement.md"], scopes: [], outputs: [], dependsOn: [], questionIds: [] } as Args[2];
    const state = { version: 1, id: "X", target: "t", maxParallel: 3, tasks: [{ task, attempts: [] }], agents: [] } as Args[1];
    // 골든 — 구현 전(3b5e867) dist 의 taskHash 값이다. 바뀌면 진행 중인 모든 관찰 작업이 다시 돈다
    assert.equal(taskHash(work, state, task), "sha256:db1f7ff0e520c33d");
    const legacy = { ...task }; delete legacy.contextVersion;
    assert.equal(taskHash(work, { ...state, tasks: [{ task: legacy, attempts: [] }] }, legacy), "sha256:c21019bbdf154ea9");
    // 공식 — 직렬화 객체와 손으로 쓴 질문 투영
    const inputs = inputFiles(work, task, state).map((file) => [file, fileHash(repo, file)]);
    const questions = [
      { id: "Q1", title: "Q1 · 요구사항 분석", answer: "A", status: "answered", requirements: ["R1"], content: "Q1 · 요구사항 분석\n주문 취소 후 재주문이 가능한가?\nA. 가능 — 새 주문번호\nB. 불가\n[Requirements]: R1\n[Answer]: A\n[Status]: answered" },
      { id: "Q2", title: "Q2 · 설계", answer: "", content: "Q2 · 설계\n경계?\n[Answer]:" },
    ];
    assert.equal(sha(JSON.stringify({ task, base: "abc", manifest: hashManifest(manifest as never), inputs, hostInstructions: [["CLAUDE.md", "missing"], ["AGENTS.md", "missing"]], dependencies: [], questions })), taskHash(work, state, task));
    assert.equal("origin" in parseQuestions(qtext)[0], false, "[Origin] 이 없는 옛 질문에는 origin 키가 없다");
    const projected = JSON.stringify(hashedQuestion({ ...parseQuestions(qtext)[0], options: { A: "x" }, source: "대화" } as Question, "c"));
    assert.ok(!projected.includes("options") && !projected.includes("source"), projected);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("코드가 기록한 출처의 질문은 출처 작업과 그 후손만 낡게 하고, 기록 없는 [Origin] 줄은 요구 겹침 규칙을 따른다", () => {
  preparePlanning(root);
  finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS + '\n## R2 · 다른 반환\n근거: "값을 반환한다."' }); next(root);
  const base = { role: "explore", title: "영역", inputs: [SPEC], outputs: [], dependsOn: ["analysis"] };
  preparePlanning(root, { tasks: [{ ...base, id: "left", requirements: ["R1"], scopes: ["src"] }, { ...base, id: "right", requirements: ["R2"], scopes: ["other"] },
    { id: "synthesis", role: "synthesis", title: "합성", requirements: ["R1", "R2"], inputs: [SPEC], outputs: [`${DIR}/02-analysis.md`], dependsOn: ["left", "right"] }] });
  finish(dispatch("left")); finish(dispatch("right"));
  finish(dispatch("synthesis"), { [`${DIR}/02-analysis.md`]: IMPACT.replace("| R1 | src/current.ts:1 | 없음 | 새 진입점 |", "| R1 | src/current.ts:1 | 없음 | 새 진입점 |\n| R2 | src/current.ts:1 | 없음 | 새 진입점 |") });
  write(`${DIR}/questions.md`, "# 질문\n\n## Q1 · 영역\n경계값?\n[Requirements]: R2\n[Origin]: left\n[Answer]: 포함한다\n");
  const current = (id: string) => { const work = loadWork(root)!, state = loadPlanning(work); return taskCurrent(work, state, state.tasks.find((record) => record.task.id === id)!); };
  const because = (id: string) => (JSON.parse(planningStatus(root)).tasks.find((task: any) => task.id === id).staleBecause ?? []).join("\n");
  // 메인이 적은 [Origin] 은 검증할 수 없다 — 범위(R2)가 겹치는 right 와 그 후손 synthesis 가 낡는다
  assert.deepEqual(["left", "synthesis", "right"].map(current), [true, false, false]);
  assert.match(because("right"), /질문 Q1 추가·변경\(출처 없음/);
  // 완료 hook·교차 검토가 쓴 질문은 출처를 상태에도 남긴다 — 출처 규칙은 left 와 그 후손(synthesis)만 낡게 한다
  editPlanning((state) => { state.questionOrigins = { Q1: "left" }; });
  assert.deepEqual(["left", "synthesis", "right"].map(current), [false, false, true]);
  assert.match(because("left"), /질문 Q1 추가·변경\(출처 left\)/);
  // 기록과 다른 [Origin] 줄은 믿지 않는다
  editPlanning((state) => { state.questionOrigins = { Q1: "right" }; });
  assert.deepEqual(["left", "synthesis", "right"].map(current), [true, false, false]);
});

test("시작이 관찰되지 않은 채 10분이 지난 배정은 stale 로 보이고 cancel 목록을 낸다", () => {
  advance();
  editPlanning((state) => { state.tasks[0].attempts[0].at = ago(11); });
  const reply = advance();
  assert.equal(reply.action, "stale");
  assert.deepEqual(reply.cancel, ["analysis"]);
  assert.equal(reply.stale[0].observedStart, false);
  assert.equal(reply.stale[0].reason, "담당 시작이 관찰되지 않았습니다(배정 11분 전)");
  assert.throws(() => dispatch("analysis"), /담당 시작이 관찰되지 않았습니다\(배정 11분 전\)[\s\S]*planning cancel analysis/);
  cancelPlanning(root, "analysis");
  assert.equal(advance().action, "dispatch");
});

test("시작이 관찰된 담당이 60분 넘게 끝나지 않으면 stale 이다", () => {
  const item = advance().assignments[0];
  startAgent(item, "slow");
  editPlanning((state) => { state.tasks[0].attempts[0].at = ago(62); state.agents[0].startedAt = ago(61); });
  const reply = advance();
  assert.equal(reply.action, "stale");
  assert.equal(reply.stale[0].observedStart, true);
  assert.equal(reply.stale[0].reason, "담당이 61분째 끝나지 않았습니다");
});

test("시작 미관찰 기한은 배정 뒤 마지막 담당 활동부터 잰다 — 차례로 실행하는 호스트의 다음 배정은 stale 이 아니다", () => {
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
  const waiting = advance();
  assert.ok(waiting.waiting.includes("right"), JSON.stringify(waiting));
  assert.equal(waiting.stale, undefined);
  editPlanning((state) => { state.agents.at(-1)!.endedAt = ago(11); });
  const stale = advance();
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

test("연결된 담당이 끝났는데 결과가 없는 배정은 advance 가 고아로 표시하고 같은 호출에서 다시 배정한다", () => {
  startAgent(advance().assignments[0], "lost");
  editPlanning((state) => { state.agents[0].finished = true; });
  const reply = advance();
  assert.equal(reply.orphaned[0].id, "analysis");
  assert.equal(reply.action, "dispatch");
  const attempts = loadPlanning(loadWork(root)!).tasks[0].attempts;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].status, "orphaned");
  assert.equal(attempts[0].failure!.class, "dispatch-orphan");
});

test("Claude 완료 hook — 식별 불일치는 한 번 되돌리고, 그다음은 고아로 기록해 같은 입력 실패에 세지 않는다", () => {
  const item = advance().assignments[0];
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
  assert.equal(advance().action, "dispatch");
  assert.equal(JSON.parse(planningStatus(root)).tasks[0].budget.sameInput.used, 0);
});

test("Codex 완료 hook — 식별 불일치는 되돌리지 않고 고아로 기록한 뒤 0 을 낸다", () => {
  const item = advance().assignments[0];
  const event = { cwd: root, session_id: "s", agent_id: "codex-copy", agent_type: item.hostAgents.codex };
  codexHook({ ...event, hook_event_name: "SubagentStart" });
  const message = JSON.stringify({ ...completed(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }), dispatchId: "other" });
  const result = captured(() => runCodexHook(JSON.stringify({ ...event, hook_event_name: "SubagentStop", last_assistant_message: message })));
  assert.equal(result.value, 0);
  assert.equal(result.out, "{}");
  assert.match(result.err, /현재 배정에 속한 실행 결과가 아닙니다/);
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "orphaned");
});

test("Codex 담당 시작 이벤트의 판정 실패도 막지 않는다", () => {
  advance();
  writeFileSync(planningJson(), "{broken");
  const result = captured(() => runCodexHook(JSON.stringify({ cwd: root, session_id: "s", agent_id: "a", agent_type: "ca_analyst", hook_event_name: "SubagentStart" })));
  assert.equal(result.value, 0);
  assert.equal(result.out, "{}");
  assert.match(result.err, /code-agent codex-event: /);
});

test("Claude 완료 hook — 형식 오류는 첫 Stop 에서 되돌리고, 이미 막힌 재시도는 교정 대기로 기록한다", () => {
  const item = advance().assignments[0];
  startAgent(item, "format");
  const broken = { ...item.resultShape, status: "completed", summary: 7, evidence: [{ path: SPEC, line: 1 }] };
  quiet((stderr) => {
    assert.equal(runPlanningHook(stopEvent(item, "format", broken)), 2);
    assert.match(stderr(), /resultShape 형태 JSON 하나로 다시 반환/);
    assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "running");
    assert.equal(runPlanningHook(stopEvent(item, "format", broken, { stop_hook_active: true })), 0);
  });
  const last = loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!;
  assert.equal(last.status, "needs-correction");
  assert.equal(last.failure!.class, "agent-format-error");
});

test("완료 hook 은 staging 본문에 그 역할의 게이트 검사를 먼저 돌려 한 번 되돌린다", () => {
  toDesign();
  const item = advance().assignments[0];
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

test("host 없이 부른 완료 관찰은 문서 검사 실패를 바로 내용 오류로 기록한다", () => {
  toDesign();
  const item = advance().assignments[0];
  assert.throws(() => finish(item, { [`${DIR}/03-design.md`]: DESIGN, [`${DIR}/04-functional.md`]: DUPLICATED_AC }), /수락 기준 id 가 겹칩니다/);
  const last = loadPlanning(loadWork(root)!).tasks.find((record) => record.task.id === "design")!.attempts.at(-1)!;
  assert.equal(last.status, "failed");
  assert.equal(last.failure!.class, "agent-content-error");
  assert.equal(existsSync(join(root, DIR, "03-design.md")), false);
  assert.equal(existsSync(join(root, DIR, "04-functional.md")), false);
});

test("analysis 결과도 요구 형식·원문 추적 검사를 완료 전에 받는다", () => {
  assert.throws(() => finish(advance().assignments[0], { [`${DIR}/01-requirements.md`]: REQUIREMENTS.replace('근거: "값을 반환한다."', "") }), /근거: 줄이 없는 요구 항목/);
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

test("교정 시도의 문서 검사 실패는 되돌리지 않고 실패로 기록한다", () => {
  const item = advance().assignments[0];
  const bad = REQUIREMENTS.replace('근거: "값을 반환한다."', "");
  malformed(item, { raw: JSON.stringify({ ...item.resultShape, status: "completed", summary: 123, evidence: [{ path: SPEC, line: 1 }], artifacts: [{ path: `${DIR}/01-requirements.md`, content: bad }] }) });
  const repaired = advance().assignments[0];
  assert.equal(repaired.mode, "correction");
  startAgent(repaired, "corrector");
  quiet(() => assert.equal(runPlanningHook(stopEvent(repaired, "corrector", completed(repaired, { [`${DIR}/01-requirements.md`]: bad }))), 0));
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "failed");
});

test("같은 입력으로 세 번 실패하면 명시 배정도 거부하고 advance 는 한도 원인을 낸다", () => {
  preparePlanning(root);
  for (let index = 0; index < 3; index++) {
    assert.throws(() => finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS }, { evidence: [{ path: "outside.ts", line: 1 }] }), /범위 밖/);
  }
  assert.throws(() => dispatch("analysis"), /3번 실패/);
  const blocked = advance().blocked[0];
  assert.equal(blocked.class, "same-input-repeat");
  assert.deepEqual(blocked.counter, { key: "sameInput", used: 3, limit: 3 });
});

test("retry 기록이 없는 옛 계획 기록은 이행 시각 이후의 배정만 센다", () => {
  preparePlanning(root);
  editPlanning((state) => {
    delete state.retry;
    state.tasks[0].attempts = Array.from({ length: 5 }, (_, index) => ({ dispatchId: `old-${index}`, inputHash: "old", at: "2026-01-01T00:00:00.000Z", status: "cancelled" as const }));
  });
  assert.equal(advance().action, "dispatch");
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
  assert.equal(grantPlanningRetry(root, "taskTotal", "analysis", "consent-2", "사람 판단"), "작업 analysis의 작업 총 배정 한도를 6→9회로 늘렸습니다(사람 판단, 동의 consent-2)");
  assert.equal(loadPlanning(loadWork(root)!).retry!.grants[0].scope, "planning:analysis");
  assert.equal(planningBudget(root, "analysis").taskTotal.limit, 9);
  assert.doesNotThrow(() => dispatch("analysis"));
});

test("계획 기록 잠금 — 죽은 주인·오래된 빈 잠금은 회수하고, 살아 있거나 다른 PC·주인 불명이면 사람에게 넘긴다", () => {
  preparePlanning(root);
  const lock = `${planningJson()}.lock`, display = `.code-agent/work/${ID}/value.planning.json.lock`;
  const dead = deadPid();
  writeFileSync(lock, JSON.stringify({ pid: dead, host: hostname(), at: new Date().toISOString() }));
  quiet((stderr) => { assert.doesNotThrow(() => advance()); assert.match(stderr(), /계획 기록 잠금을 회수했습니다 — pid \d+ 종료/); });
  writeFileSync(lock, "");
  const old = new Date(Date.now() - 11 * 60_000);
  utimesSync(lock, old, old);
  quiet((stderr) => { assert.doesNotThrow(() => advance()); assert.match(stderr(), /주인 기록 없음, 1\d분 경과/); });
  writeFileSync(lock, "");
  let started = Date.now();
  assert.throws(() => advance(), (error: Error) => error.message.includes(display) && /10분/.test(error.message));
  assert.ok(Date.now() - started < 1000, "주인 불명은 기다리지 않는다");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
  started = Date.now();
  assert.throws(() => advance(), /pid \d+[\s\S]*다시 실행/);
  assert.ok(Date.now() - started >= 1500, "살아 있는 주인은 기다린 뒤 멈춘다");
  writeFileSync(lock, JSON.stringify({ pid: 1, host: "other-pc", at: new Date().toISOString() }));
  started = Date.now();
  assert.throws(() => advance(), /다른 PC\(other-pc/);
  assert.ok(Date.now() - started < 1000);
  rmSync(lock);
  mkdirSync(join(root, "x"), { recursive: true });
  writeFileSync(join(root, "x/apply.lock"), "");
  assert.throws(() => acquireLock(join(root, "x/apply.lock"), { waitMs: 0, ageReclaim: false, label: "동의 적용", messages: { unknown: () => "지정한 문구" } }), (error: Error) => error.message === "지정한 문구");
  assert.throws(() => acquireLock(join(root, "x/apply.lock"), { waitMs: 0, ageReclaim: false, label: "동의 적용" }), (error: Error) => /apply\.lock 을 지운 뒤/.test(error.message) && !/10분/.test(error.message));
});

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
  assert.match(text, /## 참고 문서 섹션[\s\S]*doc\/knowledge\/business-rules\.md · ## 반환 규칙/);
  finish(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }, { evidence: [{ path: SPEC, line: 1 }, { path: "doc/knowledge/business-rules.md", line: 3 }] });
  assert.equal(JSON.parse(planningResult(root, "analysis")).current, true, "업무 규칙 근거는 배정 범위 안이다");
});

test("이미 준비한 작업의 inputs 는 그대로 둔다 — 진행 중 작업의 해시를 바꾸지 않는다", () => {
  preparePlanning(root);
  write("doc/knowledge/business-rules.md", "# 업무 규칙\n## 반환 규칙\n- BR-1: 값을 반환한다\n");
  assert.deepEqual(advance().assignments[0].task.inputs, [SPEC]);
});

test("대화가 새로 열리면 실행 중으로 기록된 계획 배정과 취소 명령을 붙인다", () => {
  advance();
  const cleared = sessionAnchor(root, "clear");
  assert.match(cleared, /실행 중으로 기록된 계획 배정: analysis\(ca-analyst, 담당 시작 미관찰, 0분 전\)/);
  assert.match(cleared, /code-agent planning cancel analysis/);
  const compacted = sessionAnchor(root, "compact");
  assert.match(compacted, /stale·cancel 안내/);
  assert.doesNotMatch(compacted, /planning cancel analysis/);
});

test("planning status 는 실행 관찰·낡은 이유·재시도 예산을 보인다", () => {
  const item = advance().assignments[0];
  startAgent(item, "watch");
  let status = JSON.parse(planningStatus(root)).tasks[0];
  assert.equal(status.run.observedStart, true);
  assert.equal(status.run.orphan, "running");
  assert.deepEqual(status.budget, { sameInput: { used: 0, limit: 3 }, taskTotal: { used: 1, limit: 6 } });
  observePlanner(JSON.parse(stopEvent(item, "watch", completed(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }))));
  write("doc/quality.md", `${readFileSync(join(root, "doc/quality.md"), "utf8")}\n- 추가 기준\n`);
  status = JSON.parse(planningStatus(root)).tasks[0];
  assert.equal(status.state, "stale");
  assert.ok(status.staleBecause.includes("입력 파일: doc/quality.md"), JSON.stringify(status.staleBecause));
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

test("Codex 사본 — 고정 치환 세 문장과 계획 루프의 새 문장이 그대로 있다", () => {
  const assets = hostAssets("codex");
  for (const name of ["ca-analyze", "ca-impact", "ca-design", "ca-plan"]) {
    const text = assets.get(`.agents/skills/${name}/SKILL.md`)!;
    assert.ok(text.includes("Codex 담당은 출력 문서 전체를 결과 JSON의 artifacts에 `{path, content}`로 넣는다(staging은 Claude 전용)."), name);
    for (const phrase of ["planning cancel <ID>", "rewind.auto", "rewind.command", "same-input-repeat"]) assert.ok(text.includes(phrase), `${name}: ${phrase}`);
  }
  assert.ok(assets.get(".codex/agents/ca-analyst.toml")!.includes("출력 문서는 artifacts에 `{path, content}`로 전체 내용을 넣는다. 파일은 쓰지 않는다."));
  assert.ok(assets.get(".codex/agents/ca-explorer.toml")!.includes("문서 전체는 artifacts의 `{path, content}`로 넣는다. 파일을 쓰거나"));
});

test("차단 지적은 인용 문서를 낸 작업만 후보로 보이고 자동으로 되감지 않는다", () => {
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  const line = FUNCTIONAL.split("\n").findIndex((row) => row.startsWith("- AC-R1-1")) + 1;
  finish(dispatch("critic"), {}, { findings: [{ id: "F1", severity: "blocking", detail: "AC-R1-1 경계값 TC 없음", source: { path: `${DIR}/04-functional.md`, line } }] });
  const reply = advance();
  assert.notEqual(reply.action, "rewind-required");
  assert.equal(reply.feedback[0].from, "critic");
  assert.equal(reply.feedback[0].citedTask, "design");
  assert.equal(reply.feedback[0].citedPhase, "design");
  assert.match(reply.feedback[0].note, /근거 문서가 앞 단계\(design\) 출력입니다/);
  assert.equal("command" in reply.feedback[0], false);
});

// ---- 검토 반영: 크기 한도·늦은 결과·고아 표시·직전 실패·되돌린 보고 ----

for (const via of ["claude", "codex"] as const) test(`크기 한도를 넘은 결과는 원본을 보존하지 않으므로 교정 대기 대신 실패로 기록하고 교정을 받지 않는다: ${via}`, () => {
  const item = advance().assignments[0];
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
  assert.equal(advance().blocked[0].class, "agent-format-error");
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

test("취소된 배정의 담당이 재배정 뒤 늦게 시작해 새 배정에 연결돼도 그 늦은 결과는 새 배정을 고아로 만들지 않는다", () => {
  const first = advance().assignments[0];
  editPlanning((state) => { state.tasks[0].attempts[0].at = ago(11); });
  assert.equal(advance().action, "stale");
  cancelPlanning(root, "analysis");
  const second = advance().assignments[0];
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

test("취소된 배정의 늦은 결과가 형식까지 틀려도 되돌리지 않고 늦은 결과로만 기록한다", () => {
  const first = advance().assignments[0];
  cancelPlanning(root, "analysis");
  const second = advance().assignments[0];
  startAgent(first, "late-broken");
  quiet(() => assert.equal(runPlanningHook(stopEvent(first, "late-broken", { ...first.resultShape, status: "completed", summary: 7 })), 0));
  const state = loadPlanning(loadWork(root)!);
  assert.equal(state.agents[0].failure!.detail, "취소·교체된 배정의 늦은 결과");
  assert.equal(state.agents[0].dispatchId, first.resultShape.dispatchId, "연결을 보고한 배정으로 옮긴다");
  assert.equal(state.tasks[0].attempts.at(-1)!.status, "running");
  assert.equal(state.tasks[0].attempts.at(-1)!.dispatchId, second.resultShape.dispatchId);
});

test("늦은 결과의 담당만 새 배정에 연결됐으면 새 배정은 담당을 기다리고, 다른 담당이 일하는 배정은 식별 오류로 고아가 되지 않는다", () => {
  const first = advance().assignments[0];
  cancelPlanning(root, "analysis");
  const second = advance().assignments[0];
  startAgent(first, "late-only");
  quiet(() => runPlanningHook(stopEvent(first, "late-only", completed(first, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }))));
  const waiting = advance();
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

test("출처 검증 실패로 고아가 된 배정은 다시 배정할 때 직전 실패를 보이고, 두 번 이어지면 자동으로 다시 배정하지 않는다", () => {
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
    run(advance().assignments[0], "first");
    const again = advance();
    assert.equal(again.action, "dispatch");
    const previous = again.assignments[0].previous;
    assert.deepEqual({ status: previous.status, class: previous.class }, { status: "orphaned", class: "dispatch-orphan" });
    assert.match(previous.detail, /하위 에이전트 기록이 아닙니다/);
    assert.deepEqual(JSON.parse(handoffPlanning(root, JSON.stringify(again))).assignments[0].previous, previous, "CLI 요약에도 남는다");
    run(again.assignments[0], "second");
    const stopped = advance();
    assert.equal(stopped.assignments.length, 0);
    assert.equal(stopped.action, "blocked");
    assert.equal(stopped.blocked[0].class, "hook-failure");
    assert.match(stopped.blocked[0].reasons.join("\n"), /두 번 이어서[\s\S]*planning dispatch analysis/);
    assert.equal(dispatch("analysis").cached, false, "명시 배정은 받는다");
  } finally { rmSync(outside, { recursive: true, force: true }); }
});

for (const via of ["text", "handback"] as const) test(`되돌린 뒤의 완료는 되돌릴 때 판정한 SubagentHandback 을 다시 읽지 않는다: ${via}`, () => {
  const item = advance().assignments[0];
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

// ---- C7 — next 줄·연쇄(--chain) ----

const chain = (on = true) => { const out = planningAdvanceCli(root, { chain: on }); return { exit: out.exit, view: JSON.parse(out.text) }; };

test("C7 advance 출력의 next 줄 — 배정·대기·게이트·제출, 기존 키(problems)는 그대로", () => {
  const dispatched = chain(false).view;
  assert.equal(dispatched.action, "dispatch");
  assert.ok("problems" in dispatched);
  assert.match(dispatched.next, /assignmentFile 경로만 넘기고, 완료 알림을 받으면 code-agent planning advance$/);
  assert.equal(chain(false).view.action, "wait");
  assert.match(chain(false).view.next, /기다린다[\s\S]*planning cancel/);
  finish(handed(dispatched.assignments[0]), { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
  const gate = chain(false);
  assert.equal(gate.view.action, "ready-for-gate");
  assert.match(gate.view.next, /^게이트 — code-agent next\./);
  assert.equal(gate.view.chain, undefined);
  assert.equal(loadActive(root)!.phase, "analysis", "연쇄가 아니면 게이트를 시도하지 않는다");
});

test("C7 연쇄 — --chain 안내는 --chain 을 유지하고, 결과가 준비되면 같은 호출로 게이트만 지나며 다음 단계는 배정하지 않는다", () => {
  const first = chain();
  assert.equal(first.view.action, "dispatch");
  assert.match(first.view.next, /code-agent planning advance --chain$/);
  finish(handed(first.view.assignments[0]), { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
  const second = chain();
  assert.equal(second.exit, 0);
  assert.equal(second.view.phase, "analysis");
  assert.equal(second.view.action, "ready-for-gate");
  assert.deepEqual(second.view.chain, { from: "analysis", gate: "passed", to: "impact" });
  assert.equal(loadActive(root)!.phase, "impact");
  assert.match(second.view.next, /^게이트 통과\(analysis→impact\)[\s\S]*ca-impact 절차를 읽고 그 1항부터/);
  const state = loadPlanning(loadWork(root)!);
  assert.ok(state.tasks.filter((record) => record.task.role !== "analysis").every((record) => record.attempts.length === 0), "다음 단계 배정이 생기면 안 된다");
});

test("C7 연쇄 — 게이트 거부면 exit 1·chain.rejected·사유 그대로, 커서는 제자리, 자동으로 다시 시도하지 않는다", () => {
  preparePlanning(root); finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
  // 같은 브랜치의 AI-DLC 작업 — next 가 막고 advance 는 막지 않는다
  write("aidlc/spaces/default/intents/x/aidlc-state.md", "# 상태\n- **Status**: in-progress\n");
  let expected = "";
  try { next(root); } catch (error) { expected = (error as Error).message; }
  assert.ok(expected, "next 가 거부해야 한다");
  const out = chain();
  assert.equal(out.view.action, "ready-for-gate", JSON.stringify(out.view));
  assert.equal(out.exit, 1);
  assert.equal(out.view.chain.gate, "rejected");
  assert.equal(out.view.chain.reason, expected);
  assert.equal(out.view.chain.questions, undefined);
  assert.match(out.view.next, /^게이트 거부\(analysis\)/);
  assert.equal(loadActive(root)!.phase, "analysis");
});

test("C7 연쇄 — 답 없는 질문으로 게이트가 거부되면 질문 수를 싣고 ca-answer 뒤 연쇄 advance 로 돌아가게 한다", () => {
  write(`${DIR}/questions.md`, "# 질문\n## Q1 · 확인\n값은?\n[Requirements]: R1\n[Answer]:\n");
  preparePlanning(root); finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
  const out = chain();
  assert.equal(out.view.action, "ready-for-gate");
  assert.equal(out.exit, 1);
  assert.equal(out.view.chain.gate, "rejected");
  assert.equal(out.view.chain.questions, 1);
  assert.match(out.view.next, /질문 1개 때문에 게이트\(analysis\)를 지나지 못했다 — ca-answer 절차로 실제 답을 받아 기록한 뒤 code-agent planning advance --chain$/);
  assert.equal(loadActive(root)!.phase, "analysis");
});

test("C7 연쇄 — 질문이 열려 있어도 다른 사유(AI-DLC)로 거부되면 질문 수를 싣지 않고 그 사유를 전하게 한다", () => {
  write(`${DIR}/questions.md`, "# 질문\n## Q1 · 확인\n값은?\n[Requirements]: R1\n[Answer]:\n");
  preparePlanning(root); finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
  write("aidlc/spaces/default/intents/x/aidlc-state.md", "# 상태\n- **Status**: in-progress\n");
  let expected = "";
  try { next(root); } catch (error) { expected = (error as Error).message; }
  assert.doesNotMatch(expected, /질문/, "next 는 질문보다 AI-DLC 를 먼저 본다");
  const out = chain();
  assert.equal(out.view.action, "ready-for-gate", JSON.stringify(out.view));
  assert.equal(out.exit, 1);
  assert.equal(out.view.chain.reason, expected);
  assert.equal(out.view.chain.questions, undefined);
  assert.match(out.view.next, /^게이트 거부\(analysis\) — chain\.reason/);
  assert.doesNotMatch(out.view.next, /ca-answer/);
});

test("C7 연쇄 — 실패로 막히면 게이트를 시도하지 않고 advance 가 적은 원인·재배정 안내를 낸다", () => {
  const item = advance().assignments[0]; malformed(item);
  malformed(JSON.parse(repairPlanning(root, "analysis")));
  const out = chain();
  assert.equal(out.view.action, "blocked");
  assert.equal(out.exit, 0);
  assert.equal(out.view.chain, undefined);
  assert.match(out.view.next, /^analysis: [\s\S]*planning dispatch로 명시적으로 재배정하세요\.$/);
  assert.equal(loadActive(root)!.phase, "analysis");
});

/** 실제 advance 출력(파일 픽스처)의 next 가 같은 출력으로 만든 표의 행과 같고, 연쇄는 게이트를 시도하지 않는다 */
function chainedWithoutGate(action: string) {
  const out = chain();
  assert.equal(out.view.action, action, JSON.stringify(out.view));
  assert.equal(out.exit, 0);
  assert.equal(out.view.chain, undefined);
  assert.equal(out.view.next, planningNextLine(out.view, { chained: true, workDir: DIR }));
  return out.view;
}

test("C7 실제 출력 — 되감기(rewind-required)는 rewind.phase·command·auto 로 next 를 만든다", () => {
  toDesign();
  write("src/current.ts", "export const current = 2;\n");
  const first = chainedWithoutGate("rewind-required");
  assert.match(first.next, /^앞 단계\(impact\) 계획 작업이 지금 입력과 맞지 않는다 — code-agent back impact 를 실행하고\(같은 사유의 첫 자동 되감기라 사용자 지시 없이 한다\) ca-impact 절차로 잇는다$/);
  const again = chainedWithoutGate("rewind-required");
  assert.equal(again.rewind.auto, false);
  assert.match(again.next, /^앞 단계\(impact\) 계획 작업이 같은 사유로 다시 낡았다 — 자동으로 되감지 않는다\. rewind\.reason 과 rewind\.tasks\[\]\.staleBecause/);
  assert.equal(loadActive(root)!.phase, "design");
});

test("C7 실제 출력 — stale 은 stale[].id·reason 으로 고아 안내를 만들고 --chain 을 유지한다", () => {
  advance();
  editPlanning((state) => { state.tasks[0].attempts[0].at = ago(11); });
  const view = chainedWithoutGate("stale");
  assert.ok(view.next.includes("planning cancel analysis"), view.next);
  assert.ok(view.next.includes("담당 시작이 관찰되지 않았습니다(배정 11분 전)"), view.next);
  assert.ok(view.next.includes("code-agent planning advance --chain"), view.next);
  assert.doesNotMatch(view.next, /planning advance(?! --chain)/);
});

test("C7 실제 출력 — 차단 지적(feedback)은 다시 배정 안내를 덧붙이고 되감기 명령을 내지 않는다", () => {
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  const line = FUNCTIONAL.split("\n").findIndex((row) => row.startsWith("- AC-R1-1")) + 1;
  finish(dispatch("critic"), {}, { findings: [{ id: "F1", severity: "blocking", detail: "AC-R1-1 경계값 TC 없음", source: { path: `${DIR}/04-functional.md`, line } }] });
  const out = chain();
  assert.equal(out.view.chain, undefined);
  assert.equal(out.view.next, planningNextLine(out.view, { chained: true, workDir: DIR }));
  assert.equal(out.view.feedback.length, 1);
  assert.match(out.view.next, / — 차단 지적 1건: 계약의 수정 피드백으로 고칠 작업을 다시 배정한다\(feedback\[\]\.citedTask 는 근거 문서를 낸 작업일 뿐/);
  assert.doesNotMatch(out.view.next, /code-agent back/);
  assert.equal(loadActive(root)!.phase, "plan");
});

test("C7 연쇄 — plan 단계의 ready-for-gate 는 제출을 안내하고 게이트를 지나지 않는다", () => {
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  finish(dispatch("critic"));
  const out = chain();
  assert.equal(out.view.action, "ready-for-gate");
  assert.equal(out.exit, 0);
  assert.equal(out.view.chain, undefined);
  assert.equal(out.view.next, `계획 제출 — code-agent plan submit ${DIR}/plan.json (ca-plan 끝 절차)`);
  assert.equal(loadActive(root)!.phase, "plan");
});

test("C7 CLI — planning advance 의 모르는 인자는 사용법, hook 은 --chain 을 연다", () => {
  const cli = join(__dirname, "../agent/cli.js");
  const bad = spawnSync(process.execPath, [cli, "planning", "advance", "--bogus"], { cwd: root, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /사용법: code-agent planning advance \[--chain\]/);
  assert.equal(hook({ cwd: root, tool_name: "Bash", tool_input: { command: "code-agent planning advance --chain" } }), undefined);
});

test("C7 SessionStart — 압축·비우기 뒤에는 ca-answer 를 다시 읽으라는 줄을 붙인다(시작·재개·인자 없음에는 없다)", () => {
  const line = /대화가 압축·비워졌다 — 질문·동의 전에 ca-answer 절차/;
  assert.match(sessionAnchor(root, "compact"), line);
  assert.match(sessionAnchor(root, "clear"), line);
  for (const source of ["startup", "resume", undefined]) assert.doesNotMatch(sessionAnchor(root, source), line);
  // 실제 hook 경로 — stdin 의 source 를 읽는다
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR; delete env.CODE_AGENT_CROSS;
  const hookRun = (source: string) => spawnSync(process.execPath, [join(__dirname, "../agent/cli.js"), "session-event"], { cwd: root, env, encoding: "utf8", input: JSON.stringify({ cwd: root, source }) });
  const cleared = hookRun("clear");
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.match(cleared.stdout, line);
  assert.doesNotMatch(hookRun("startup").stdout, line);
});
