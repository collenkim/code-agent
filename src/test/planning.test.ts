import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { next } from "../agent/commands";
import { loadActive } from "../agent/layout";
import { init } from "../agent/init";
import { preparePlanning, planningStatus, planningResult } from "../agent/planning";
import { inputFiles, loadPlanning, taskHash, TaskSchema } from "../agent/planningState";
import { loadWork } from "../agent/work";
import { REQUIREMENTS, IMPACT, DESIGN, FUNCTIONAL, TESTS, PLAN, root, advance, write, phase, dispatch, finish, analysis, DIR, SPEC } from "./planningFixture";

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
