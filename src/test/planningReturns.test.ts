/**
 * 계획 담당 결과의 반려 비용 — 결과 포인터 경로, 근거 경로의 저장소 상대화, 형식·출력 집합 오류와 문서 검사의 묶음 반려,
 * 요구 원문 인용과 파일 참조 검사, critic 재검토 범위. 실제 작업의 계획 기록에서 반려된 모양(파일 이름만 쓴 근거,
 * 절대 경로 근거, 경로 뒤에 설명을 붙인 결과 줄·절대 경로 결과 줄)을 그대로 재현한다.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { handoffPlanning } from "../agent/handoff";
import { preparePlanning } from "../agent/planning";
import { observePlanner, runPlanningHook } from "../agent/planningHook";
import { loadPlanning } from "../agent/planningState";
import { planningDocumentProblems } from "../agent/planningValidation";
import { sourceTrace } from "../agent/sourceTrace";
import { loadWork } from "../agent/work";
import { DIR, FUNCTIONAL, PLAN, REQUIREMENTS, SPEC, TESTS, advance, analysis, completed, dispatch, finish, quiet, root, startAgent, stopEvent, throughDesign, write } from "./planningFixture";

const attemptOf = (id: string) => loadPlanning(loadWork(root)!).tasks.find((record) => record.task.id === id)!.attempts.at(-1)!;
/** 파일 이름만 적은 근거 — 실제 기록의 `UsersApiApplication.java:23` 과 같은 모양 */
const NAME_ONLY = REQUIREMENTS.replace('근거: "값을 반환한다."', '근거: "값을 반환한다."\n- 현재 값은 current.ts:1 에 있다');

test("결과 줄 — 경로 뒤 설명·백틱·저장소 안 절대 경로는 그 배정의 resultFile 로 받고, 다른 배정·staging 밖·저장소 밖·되짚는 경로는 받지 않는다", async () => {
  const item = (await advance()).assignments[0];
  const staged = item.staging[`${DIR}/01-requirements.md`];
  write(staged, REQUIREMENTS);
  write(item.resultFile, JSON.stringify(completed(item, {}, { artifacts: [{ path: `${DIR}/01-requirements.md`, staged }] })));
  const refused: [string, string][] = [
    ["다른 배정", `${DIR}/.staging/other/result.json`],
    ["staging 밖", `${DIR}/result.json`],
    ["저장소 밖 절대 경로", join(dirname(root), "elsewhere", item.resultFile)],
    ["되짚는 경로", `${DIR}/.staging/other/../${item.resultShape.dispatchId}/result.json`],
  ];
  quiet((stderr) => {
    refused.forEach(([label, path], index) => {
      startAgent(item, `refused-${index}`);
      assert.equal(runPlanningHook(stopEvent(item, `refused-${index}`, `결과: ${path}`)), 2, label);
      assert.match(stderr(), new RegExp(`결과 파일 경로가 이 배정의 resultFile 이 아닙니다[^\\n]*\\(${item.resultFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`), label);
    });
  });
  assert.equal(attemptOf("analysis").status, "running", "되돌림은 시도를 바꾸지 않는다");
  // 실제 기록의 두 모양 — 경로 뒤 설명, 저장소 안 절대 경로(Windows 는 역슬래시)
  startAgent(item, "described");
  observePlanner(JSON.parse(stopEvent(item, "described", `결과: ${join(root, item.resultFile)} (01 의 근거 표기를 고쳤습니다)`)), undefined, { host: "claude" });
  assert.equal(attemptOf("analysis").status, "completed");
  assert.equal(readFileSync(join(root, DIR, "01-requirements.md"), "utf8"), REQUIREMENTS);
});

test("되돌림이 전달되지 않아 끝난 담당을 메인이 이어 부르면 그 재개의 시작은 새 담당이 아니고, 다음 Stop 이 같은 배정으로 판정된다", async () => {
  const item = (await advance()).assignments[0];
  const staged = item.staging[`${DIR}/01-requirements.md`];
  write(staged, REQUIREMENTS);
  write(item.resultFile, JSON.stringify(completed(item, {}, { artifacts: [{ path: `${DIR}/01-requirements.md`, staged }] })));
  startAgent(item, "resumed");
  assert.throws(() => observePlanner(JSON.parse(stopEvent(item, "resumed", `결과: ${DIR}/.staging/wrong/result.json`)), undefined, { host: "claude" }), /resultFile 이 아닙니다/);
  assert.ok(attemptOf("analysis").returnPending, "되돌림 대기");
  startAgent(item, "resumed");   // 실측: 재개는 같은 agent_id 로 SubagentStart 를 다시 보낸다
  const state = loadPlanning(loadWork(root)!);
  assert.equal(state.agents.filter((agent) => agent.id === "resumed").length, 1, "새로 등록하지 않는다");
  observePlanner(JSON.parse(stopEvent(item, "resumed", `결과: ${item.resultFile}`, { stop_hook_active: false })), undefined, { host: "claude" });
  const last = attemptOf("analysis");
  assert.equal(last.status, "completed");
  assert.equal(last.returnPending, undefined);
});

// 줄 전체를 백틱으로 감싼 모양은 실제 Claude 담당이 낸 최종 응답이다(sonnet, 2026-10-30 실측)
for (const [label, line] of [["경로만", (file: string) => `결과: \`${file}\``], ["줄 전체", (file: string) => `\`결과: ${file}\``], ["따옴표", (file: string) => `결과: "${file}" 에 썼습니다`]] as const) {
  test(`결과 줄을 백틱·따옴표로 감싸도 같은 자리다: ${label}`, async () => {
    const item = (await advance()).assignments[0];
    const staged = item.staging[`${DIR}/01-requirements.md`];
    write(staged, REQUIREMENTS);
    write(item.resultFile, JSON.stringify(completed(item, {}, { artifacts: [{ path: `${DIR}/01-requirements.md`, staged }] })));
    startAgent(item, "ticked");
    observePlanner(JSON.parse(stopEvent(item, "ticked", `작업을 마쳤습니다.\n${line(item.resultFile)}`)), undefined, { host: "claude" });
    assert.equal(attemptOf("analysis").status, "completed");
  });
}

test("RES-SCOPE — 저장소 안 파일을 절대 경로로 쓴 근거는 저장소 상대 경로로 받아 기록한다", () => {
  analysis(); preparePlanning(root);
  const absolute = join(root, "src", "current.ts");
  // 실제 기록의 조사 담당 — evidence 를 `C:/IdeaProjects/users-api/build.gradle` 처럼 슬래시 절대 경로로 썼다
  finish(dispatch("explore"), {}, { evidence: [{ path: absolute.replace(/\\/g, "/"), line: 1 }], facts: [{ key: "값", value: "1", source: { path: absolute, line: 1 } }] });
  const result = attemptOf("explore").result!;
  assert.deepEqual([result.evidence[0].path, result.facts[0].source.path], ["src/current.ts", "src/current.ts"], "기록은 저장소 상대 경로다 — 후속 담당의 인용 범위와 같은 글자");
});

test("RES-SCOPE — 저장소 밖 근거와 저장소 안이지만 배정 범위 밖인 근거는 한 결과에서 함께 거부한다", () => {
  analysis(); preparePlanning(root);
  const outside = join(dirname(root), "elsewhere", "src", "current.ts");
  assert.throws(() => finish(dispatch("explore"), {}, { evidence: [{ path: outside, line: 1 }, { path: join(root, "doc", "work", "OTHER-1", "02-analysis.md"), line: 1 }] }), (error: Error) => {
    assert.match(error.message, /\[RES-SCOPE\] 배정 범위 밖 근거입니다: doc\/work\/OTHER-1\/02-analysis\.md/, "저장소 안이면 상대 경로로 바꿔 범위를 본다");
    assert.ok(error.message.includes(`[RES-SCOPE] 배정 범위 밖 근거입니다: ${outside}`), "저장소 밖 경로는 그대로 거부한다");
    return true;
  });
});

test("형식 오류와 staging 문서 검사는 한 번에 돌려주고, 기록할 때는 교정이 고칠 수 없는 문서 문제가 있으면 교정 대신 실패로 남긴다", async () => {
  const item = (await advance()).assignments[0];
  write(item.staging[`${DIR}/01-requirements.md`], NAME_ONLY);
  startAgent(item, "broken");
  const broken = { ...item.resultShape, status: "completed", summary: 7, evidence: [{ path: SPEC, line: 1 }] };
  quiet((stderr) => {
    assert.equal(runPlanningHook(stopEvent(item, "broken", broken)), 2);
    const message = stderr();
    assert.match(message, /결과 형식 오류입니다 — [\s\S]*summary/);
    assert.match(message, /\[DOC-REF\] doc\/work\/PLAN-1\/01-requirements\.md:\d+: 근거 파일이 없습니다: current\.ts — 저장소 루트 기준 전체 경로로 씁니다 \(저장소에 있는 같은 이름: [^)]*src\/current\.ts/);
    // 고치지 않고 다시 멈추면 기록한다 — 교정은 문서를 바꿀 수 없으므로 needs-correction 이 아니라 실패다
    assert.equal(runPlanningHook(stopEvent(item, "broken", broken, { stop_hook_active: true })), 0);
  });
  const last = attemptOf("analysis");
  assert.equal(last.status, "failed");
  assert.equal(last.failure?.class, "agent-content-error");
  assert.match(last.error!, /^결과 형식 오류: [\s\S]*\n\[DOC-REF\]/);
  write(`${DIR}/feedback.md`, "# 수정 피드백\n- 근거는 저장소 루트 기준 전체 경로로 쓴다\n");
  const task = loadPlanning(loadWork(root)!).tasks.find((record) => record.task.id === "analysis")!.task;
  preparePlanning(root, { tasks: [{ ...task, inputs: [...task.inputs, `${DIR}/feedback.md`] }] });
  const again = dispatch("analysis");
  const text = readFileSync(join(root, JSON.parse(handoffPlanning(root, JSON.stringify(again))).assignmentFile), "utf8");
  assert.match(text, /## 직전 시도[\s\S]*결과 형식 오류[\s\S]*\[DOC-REF\]/, "다음 배정이 두 사유를 함께 받는다");
});

test("문서가 검사를 통과하면 형식 오류는 그대로 형식 교정으로 간다", async () => {
  const item = (await advance()).assignments[0];
  write(item.staging[`${DIR}/01-requirements.md`], REQUIREMENTS);
  startAgent(item, "format-only");
  assert.throws(() => observePlanner(JSON.parse(stopEvent(item, "format-only", { ...item.resultShape, status: "completed", summary: 7 }))), /결과 형식 오류/);
  assert.equal(attemptOf("analysis").status, "needs-correction");
});

test("출력 집합 오류(RES-OUTPUT)와 staging 문서 문제는 한 반려에 싣는다", async () => {
  const item = (await advance()).assignments[0];
  write(item.staging[`${DIR}/01-requirements.md`], NAME_ONLY);
  startAgent(item, "missing-output");
  quiet((stderr) => {
    assert.equal(runPlanningHook(stopEvent(item, "missing-output", completed(item))), 2);
    assert.match(stderr(), /\[RES-OUTPUT\][\s\S]*\[DOC-REF\][^\n]*current\.ts/);
  });
});

test("DOC-REF — 파일 이름만 쓴 근거는 막고 전체 경로는 통과한다", () => {
  write("src/main/java/com/finger/users/api/UsersApiApplication.java", "class UsersApiApplication {}\n".repeat(30));
  const analysisDoc = (ref: string) => `# 영향도\n## 기존 시스템 분석\n- ${ref} 에서 애플리케이션이 시작한다\n`;
  const problems = (ref: string) => planningDocumentProblems(loadWork(root)!, "impact", { overlay: new Map([[`${DIR}/02-analysis.md`, analysisDoc(ref)]]), only: ["02-analysis.md"] })
    .filter((problem) => problem.startsWith("[DOC-REF]"));
  assert.deepEqual(problems("src/main/java/com/finger/users/api/UsersApiApplication.java:12"), []);
  assert.deepEqual(problems("UsersApiApplication.java:12"), [
    "[DOC-REF] doc/work/PLAN-1/02-analysis.md:3: 근거 파일이 없습니다: UsersApiApplication.java — 저장소 루트 기준 전체 경로로 씁니다 (저장소에 있는 같은 이름: src/main/java/com/finger/users/api/UsersApiApplication.java). 지시서 원문(요구·오류 로그)의 글이면 원문 글자 그대로 따옴표나 백틱 안에 인용합니다",
  ]);
});

test("DOC-REF — 확정 지시서 원문을 글자 그대로 인용한 호스트:포트·파일:줄은 근거로 검사하지 않아 REQ-TRACE 와 모순되지 않고, 원문에 없는 인용·인용 밖 참조는 계속 막는다", () => {
  const order = "캐시는 cache.internal.net:6379 를 쓰고 설정은 application.yml:51 을 따른다.";
  write(SPEC, `---\nkind: feature\nid: PLAN-1\ntitle: 값 반환\ntarget: value\n---\n\n${order}\n`);
  const doc = (body: string) => `# 요구 정의\n## R1 · 캐시 설정\n${body}\n## 가정\n- 없음`;
  const check = (text: string) => ({
    trace: sourceTrace(readFileSync(join(root, SPEC), "utf8"), text).problems,
    refs: planningDocumentProblems(loadWork(root)!, "analysis", { overlay: new Map([[`${DIR}/01-requirements.md`, text]]), only: ["01-requirements.md"] }).filter((problem) => problem.startsWith("[DOC-REF]")),
  });
  for (const quoted of [`근거: "${order}"`, `근거: “${order}”`, `근거: \`${order}\``]) assert.deepEqual(check(doc(quoted)), { trace: [], refs: [] }, quoted);
  // 원문에 없는 인용은 원문이 아니다 — 파일 참조로 검사한다
  assert.match(check(doc(`근거: "${order}"\n- 설정 위치: "설정은 application.yml:99 을 따른다"`)).refs.join("\n"), /application\.yml/);
  // 인용 밖에 쓴 같은 참조는 저장소 근거 주장이다
  assert.match(check(doc(`근거: "${order}"\n- 설정은 application.yml:51 을 따른다`)).refs.join("\n"), /근거 파일이 없습니다: application\.yml/);
  // 원문 인용 안의 `파일:줄`은 업무 규칙의 근거도 아니다 — 면제가 FUN-BR 을 느슨하게 만들지 않는다
  const functional = (rule: string) => `# 기능\n## 기능 정의\n- R1: 캐시 설정\n## 업무 규칙\n${rule}\n## 예외\n- 없음 — 입력 없다\n## 수락 기준\n- AC-R1-1: 설정을 읽는다\n`;
  const rules = (rule: string) => planningDocumentProblems(loadWork(root)!, "design", { overlay: new Map([[`${DIR}/04-functional.md`, functional(rule)]]), only: ["04-functional.md"] });
  assert.match(rules(`- BR-1: "${order}"`).join("\n"), /\[FUN-BR\][^\n]*BR-1 에 근거가 없습니다/);
  assert.deepEqual(rules(`- BR-1: "${order}" (src/current.ts:1)`), []);
});

test("critic 재검토는 직전 차단 지적과 바뀐 입력을 받고, advisory 는 다시 싣지 않는다", () => {
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  const line = FUNCTIONAL.split("\n").findIndex((row) => row.startsWith("- AC-R1-1")) + 1;
  finish(dispatch("critic"), {}, { findings: [
    { id: "F1", severity: "blocking", detail: "AC-R1-1 경계값 TC 없음", source: { path: `${DIR}/04-functional.md`, line } },
    { id: "A1", severity: "advisory", detail: "TC 이름을 더 구체적으로", source: { path: `${DIR}/04-functional.md`, line } },
  ] });
  write(`${DIR}/feedback.md`, "# 수정 피드백\n- F1: AC-R1-1 경계값 TC 를 더한다\n");
  const planTask = loadPlanning(loadWork(root)!).tasks.find((record) => record.task.role === "plan")!.task;
  preparePlanning(root, { tasks: [{ ...planTask, inputs: [...planTask.inputs, `${DIR}/feedback.md`] }] });
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: `${TESTS}\n| TC-2 | Unit | AC-R1-1 | 경계값 | 숫자 반환 |` });
  const again = dispatch("critic");
  assert.deepEqual(again.previous.findings.map((finding: { id: string }) => finding.id), ["F1"]);
  assert.ok(again.previous.changed.some((text: string) => /07-test-spec\.md|plan\.json/.test(text)), again.previous.changed.join("\n"));
  const text = readFileSync(join(root, JSON.parse(handoffPlanning(root, JSON.stringify(again))).assignmentFile), "utf8");
  assert.match(text, /직전 검토의 차단 지적 — 각 지적이 해결됐는지[\s\S]*바뀐 부분의 새 차단 문제\(보안 포함\)[\s\S]*F1 doc\/work\/PLAN-1\/04-functional\.md:\d+ — AC-R1-1 경계값 TC 없음/);
  assert.doesNotMatch(text, /A1|거부·실패 사유/);
});
