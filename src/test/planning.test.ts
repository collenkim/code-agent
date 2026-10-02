import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { start } from "./confirmedStart";
import { next, submitPlan, decide as approveCommand } from "../agent/commands";
import { decide as hook } from "../agent/hook";
import { checkProjectDocs, recordDocConfirmation } from "../agent/docs";
import { loadActive, saveActive } from "../agent/layout";
import { init, installedHook, unmatchedTools } from "../agent/init";
import { cancelPlanning, dispatchPlanning, preparePlanning, planningStatus } from "../agent/planning";
import { observePlanner } from "../agent/planningHook";
import { loadPlanning, planningProblems, TaskSchema, ResultSchema, type PlanningResult } from "../agent/planningState";
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
function write(path: string, content: string): void { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
function phase(phase: "analysis" | "impact" | "design" | "plan"): void { saveActive(root, { ...loadActive(root)!, phase }, "next"); }
function dispatch(id: string) { return JSON.parse(dispatchPlanning(root, id)); }
function finish(dispatch: ReturnType<typeof JSON.parse>, artifacts: Record<string, string> = {}, extra: Partial<PlanningResult> = {}) {
  const event = { cwd: root, session_id: "s", agent_id: `agent-${++serial}`, agent_type: dispatch.agent };
  const result: PlanningResult = { taskId: dispatch.task.id, dispatchId: dispatch.resultShape.dispatchId, inputHash: dispatch.resultShape.inputHash, status: "completed", summary: "실제 근거 확인", evidence: [{ path: SPEC, line: 1 }], facts: [], questions: [], findings: [], artifacts: Object.entries(artifacts).map(([path, content]) => ({ path, content })), ...extra };
  observePlanner({ ...event, hook_event_name: "SubagentStart" });
  observePlanner({ ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify(result) });
  return { event, result };
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
  assert.equal(Object.values(settings.hooks).flat().length, 8);
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
