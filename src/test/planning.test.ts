import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { start } from "./confirmedStart";
import { next, submitPlan, decide as approveCommand } from "../agent/commands";
import { decide as hook } from "../agent/hook";
import { contextHandoff } from "../agent/handoff";
import { sessionAnchor } from "../agent/sessionHook";
import { context } from "../agent/commands";
import { checkProjectDocs, recordDocConfirmation } from "../agent/docs";
import { loadActive, saveActive } from "../agent/layout";
import { init, installedHook, unmatchedTools } from "../agent/init";
import { cancelPlanning, dispatchPlanning, preparePlanning, planningStatus, advancePlanning, repairPlanning, planningResult } from "../agent/planning";
import { codexHook } from "../agent/codexHook";
import { hostAssets } from "../agent/hosts";
import { readProjectFile } from "../agent/read";
import { observePlanner } from "../agent/planningHook";
import { inputFiles, loadPlanning, planningProblems, taskHash, TaskSchema, ResultSchema, type PlanningResult } from "../agent/planningState";
import { planningDocumentProblems } from "../agent/planningValidation";
import { parseQuestions } from "../agent/questions";
import { approvalDocsHash, approvalOf, loadWork } from "../agent/work";
import { recordDecision } from "../core/approval";
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
test("세 번 취소한 같은 입력은 무한 재시도하지 않는다", () => {
  preparePlanning(root);
  for (let index = 0; index < 3; index++) { dispatch("analysis"); cancelPlanning(root, "analysis"); }
  assert.throws(() => dispatch("analysis"), /세 번/);
  assert.equal(JSON.parse(planningStatus(root)).tasks[0].attempts, 3);
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
