import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { next, status, submitPlan, decide as approveCommand } from "../agent/commands";

import { init, installedHook, unmatchedTools } from "../agent/init";
import { cancelPlanning, preparePlanning, planningStatus } from "../agent/planning";
import { observePlanner } from "../agent/planningHook";
import { loadPlanning, TaskSchema, ResultSchema, type PlanningResult } from "../agent/planningState";
import { planningDocumentProblems } from "../agent/planningValidation";
import { parseQuestions } from "../agent/questions";
import { loadWork } from "../agent/work";
import { sequenceProblems } from "../core/plan";
import { REQUIREMENTS, IMPACT, DESIGN, FUNCTIONAL, TESTS, PLAN, root, advance, write, dispatch, finish, analysis, throughPlan, DIR, SPEC } from "./planningFixture";

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
  assert.equal(Object.values(settings.hooks).flat().length, 12);
  assert.match(installedHook(root, "SessionStart", "session-event")!, /session-event$/);
  for (const event of ["SubagentStart", "SubagentStop"]) {
    assert.match(installedHook(root, event, "planning-event")!, /planning-event$/);
    assert.match(installedHook(root, event, "review-event")!, /review-event$/);
    assert.match(installedHook(root, event, "agent-event")!, /agent-event$/);
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
