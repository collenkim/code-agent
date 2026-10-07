import { strict as assert } from "node:assert";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { start } from "./confirmedStart";
import { back, next, submitPlan, decide as approveCommand } from "../agent/commands";
import { decide as hook } from "../agent/hook";
import { contextHandoff } from "../agent/handoff";
import { crossCritic, CrossCriticSchema } from "../agent/crossCheck";
import { sessionAnchor } from "../agent/sessionHook";
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
import { orphanState } from "../agent/retryPolicy";
import { sha } from "../agent/docs";
import { writeAtomic } from "../core/atomic";
import { approvalDocsHash, approvalOf, loadWork } from "../agent/work";
import { hashManifest, recordDecision } from "../core/approval";
import { loadManifest } from "../core/manifest";
import { sequenceProblems } from "../core/plan";

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
function write(path: string, content: string): void { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
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
  assert.throws(() => dispatch("analysis"), /총 6회/);
  assert.equal(JSON.parse(planningStatus(root)).tasks[0].attempts, 6);
  const blocked = advance().blocked[0];
  assert.equal(blocked.class, "reassign-total");
  assert.deepEqual(blocked.counter, { key: "taskTotal", used: 6, limit: 6 });
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
    assert.match(crossCritic(root, "codex"), /교차 검증 중지[\s\S]*Not logged in/);
    const cross = loadPlanning(loadWork(root)!).cross!;
    assert.equal(cross.status, "unavailable");
    assert.ok(!planningProblems(loadWork(root)!, "plan").some((problem) => /교차/.test(problem)));
    submitPlan(root, join(root, DIR, "plan.json"));
  } finally {
    delete process.env.CODE_AGENT_CODEX_BIN;
    rmSync(fake, { recursive: true, force: true });
  }
});

test("두 호스트가 설치되면 critic 뒤 다른 호스트의 교차 검토가 계획 제출 조건이고, 질문 번호는 코드가 매긴다", () => {
  writeFileSync(join(root, ".code-agent/hosts.json"), JSON.stringify(["claude", "codex"]));
  write(`${DIR}/questions.md`, "# 질문\n\n## Q4 · 기존\n앞선 질문\n[Answer]: 예\n");
  throughDesign(); preparePlanning(root);
  const planAndCritic = () => { finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS }); finish(dispatch("critic")); };
  planAndCritic();
  assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /교차 검토/);
  const fake = mkdtempSync(join(tmpdir(), "ca-fake-claude-")), script = join(fake, "claude.cjs");
  writeFileSync(script, "process.stdout.write(JSON.stringify({ result: process.env.FAKE_CROSS }));\n");
  process.env.CODE_AGENT_CLAUDE_BIN = script;
  const answer = (cross: unknown) => { process.env.FAKE_CROSS = JSON.stringify(cross); return crossCritic(root, "claude"); };
  try {
    assert.match(answer({ status: "completed", summary: "AC 하나가 TC에 걸리지 않는다", findings: [{ id: "C1", severity: "blocking", detail: "AC-R1-1 경계값 TC 없음", source: { path: SPEC, line: 1 } }] }), /차단 지적 1개/);
    assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /교차 검토: 차단 지적/);
    assert.throws(() => answer({ status: "completed", summary: "x", findings: [{ id: "C1", severity: "advisory", detail: "x", source: { path: "../outside.md", line: 1 } }] }), /입력 밖/);
    answer({ status: "completed", summary: "문제 없음", findings: [] });
    assert.ok(!planningProblems(loadWork(root)!, "plan").some((problem) => /교차/.test(problem)));
    assert.match(answer({ status: "needs-input", summary: "경계값 범위를 정해야 한다", questions: [{ id: "Q1", question: "경계값을 포함할까요?", requirements: ["R1"] }] }), /질문 1개/);
    const questions = readFileSync(join(root, DIR, "questions.md"), "utf8");
    assert.ok(questions.includes("## Q5 · 교차 계획 검토(claude)"), "기존 Q4 다음 번호를 코드가 매긴다");
    assert.ok(planningProblems(loadWork(root)!, "plan").some((problem) => /질문에 답한 뒤/.test(problem)));
    // 교차 검토 질문은 출처 critic만 낡게 한다 — 교차 검토는 새 critic 뒤에만 다시 돈다
    write(`${DIR}/questions.md`, questions.replace(/(## Q5[\s\S]*?\[Answer\]:)/, "$1 포함한다"));
    assert.ok(planningProblems(loadWork(root)!, "plan").some((problem) => /critic: 현재 입력/.test(problem)));
    assert.equal(JSON.parse(planningResult(root, "plan")).current, true, "plan 결과는 그대로 재사용한다");
    assert.throws(() => answer({ status: "completed", summary: "x", findings: [] }), /critic 완료 결과가 먼저/);
    assert.throws(() => crossCritic(root, "gemini"), /--by claude 또는 --by codex/);
  } finally {
    delete process.env.CODE_AGENT_CLAUDE_BIN; delete process.env.FAKE_CROSS;
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
  assert.notEqual(fileHash(root, file), "missing");
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
    crossCritic(root, "claude");
    const body = readFileSync(join(root, DIR, "questions.md"), "utf8");
    const id = [...body.matchAll(/^## (Q\d+)/gm)].at(-1)![1];
    return { body, id, questions: parseQuestions(body).filter((item) => item.id === id) };
  };
  try {
    const first = ask([]);
    assert.match(first.body, /\[Requirements\]: R1\n\[Origin\]: critic\n\[Answer\]:/, "빈 범위는 critic 작업의 요구로 채운다");
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

test("출처가 기록된 질문은 출처 작업과 그 후손만 낡게 한다", () => {
  preparePlanning(root);
  finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS + '\n## R2 · 다른 반환\n근거: "값을 반환한다."' }); next(root);
  const base = { role: "explore", title: "영역", inputs: [SPEC], outputs: [], dependsOn: ["analysis"] };
  preparePlanning(root, { tasks: [{ ...base, id: "left", requirements: ["R1"], scopes: ["src"] }, { ...base, id: "right", requirements: ["R2"], scopes: ["other"] },
    { id: "synthesis", role: "synthesis", title: "합성", requirements: ["R1", "R2"], inputs: [SPEC], outputs: [`${DIR}/02-analysis.md`], dependsOn: ["left", "right"] }] });
  finish(dispatch("left")); finish(dispatch("right"));
  finish(dispatch("synthesis"), { [`${DIR}/02-analysis.md`]: IMPACT.replace("| R1 | src/current.ts:1 | 없음 | 새 진입점 |", "| R1 | src/current.ts:1 | 없음 | 새 진입점 |\n| R2 | src/current.ts:1 | 없음 | 새 진입점 |") });
  // 범위(R2)만 보면 right 가 낡지만, 출처 규칙은 left 와 그 후손(synthesis)만 낡게 한다
  write(`${DIR}/questions.md`, "# 질문\n\n## Q1 · 영역\n경계값?\n[Requirements]: R2\n[Origin]: left\n[Answer]: 포함한다\n");
  const work = loadWork(root)!, state = loadPlanning(work);
  const current = (id: string) => taskCurrent(work, state, state.tasks.find((record) => record.task.id === id)!);
  assert.deepEqual(["left", "synthesis", "right"].map(current), [false, false, true]);
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
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
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
