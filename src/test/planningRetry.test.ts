import { writeFixture as writeRepoFile } from "./repoFixture";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { start } from "./confirmedStart";
import { observeQuestionAnswers } from "./consentFixture";
import { next } from "../agent/commands";
import { handoffPlanning } from "../agent/handoff";
import { checkProjectDocs, recordDocConfirmation } from "../agent/docs";
import { codexHook } from "../agent/codexHook";
import { advancePlanning, cancelPlanning, dispatchPlanning, latestDrafts, preparePlanning } from "../agent/planning";
import { observePlanner, runPlanningHook } from "../agent/planningHook";
import { inputFiles, loadPlanning, type PlanningResult, type TaskRecord } from "../agent/planningState";
import { RULES, rulesFor, submitChecklist, type ChecklistContext } from "../agent/planningRules";
import { loadManifest } from "../core/manifest";
import { loadWork } from "../agent/work";
import { stateView } from "../agent/stateView";
import { AGENT_RUNS_FILE, pendingCompletion } from "../agent/agentRuns";

const ID = "RETRY-1", DIR = `doc/work/${ID}`, SPEC = `${DIR}/requirement.md`, OUT = `${DIR}/01-requirements.md`;
const REQUIREMENTS = '# 요구 정의\n## R1 · 값 반환\n출처: REQ-1\n근거: "값을 반환한다."\n## 가정\n- 없음';
const IMPACT = '# 영향도\n## 기존 시스템 분석\n- src/current.ts:1 에 값을 반환한다\n## 영향 범위\n| R 번호 | 닿는 파일 | 호출자 | 파급 |\n|---|---|---|---|\n| R1 | src/current.ts:1 | 없음 | 새 진입점 |\n## Risk\n- 기존 반환값 보존\n## 문서 영향\n| 문서 | 키 | 판단 | 근거 |\n|---|---|---|---|\n| - | - | 영향 없음 | 지식 항목이 없다 |\n';
let root: string, serial = 0;
function write(path: string, content: string): void {
  writeRepoFile(root, path, content);
  if (path.endsWith("questions.md")) observeQuestionAnswers(root);
}
const dispatch = (id: string) => JSON.parse(dispatchPlanning(root, id));
type Item = ReturnType<typeof dispatch>;
/** 담당 한 번 — 시작(staging 준비) → 완료. artifacts 는 결과 JSON 그대로 */
function run(item: Item, result: Partial<PlanningResult>, host: "claude" | "codex" = "codex", between?: () => void) {
  const event = { cwd: root, session_id: "s", agent_id: `agent-${++serial}`, agent_type: item.hostAgents[host] };
  const observe = host === "codex" ? codexHook : (input: Parameters<typeof observePlanner>[0]) => observePlanner(input, root, { host: "claude" });
  observe({ ...event, hook_event_name: "SubagentStart" });
  between?.();
  const full: PlanningResult = { taskId: item.task.id, dispatchId: item.resultShape.dispatchId, inputHash: item.resultShape.inputHash, status: "completed", summary: "확인", evidence: [{ path: SPEC, line: 1 }], facts: [], questions: [], findings: [], artifacts: [], ...result };
  // Codex 완료 hook 은 기록한 실패를 예외로 알린다 — 기록 자체는 상태에서 확인한다
  try { observe({ ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify(full) }); } catch (error) { return error as Error; }
  return undefined;
}
const attempts = (id: string) => loadPlanning(loadWork(root)!).tasks.find((record) => record.task.id === id)!.attempts;
/** 담당 실행 장부의 실행 중 담당 */
const running = () => Object.keys((JSON.parse(readFileSync(join(root, AGENT_RUNS_FILE), "utf8")).works[loadWork(root)!.active.id]?.running) ?? {});

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-retry-")));
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: root });
  write("code-agent.json", JSON.stringify({ language: "typescript", sourceExtensions: [".ts"], domainBase: "src", domainRoots: [], conventions: ["doc/conventions.md"], docs: { architecture: "doc/architecture.md" }, referenceDomain: "reference", build: ["node", "-e", "process.exit(0)"], test: ["node", "-e", "process.exit(0)"], stages: [{ key: "app", title: "함수", template: "app.md", scope: "project", outputDirs: ["src"], exemplars: ["reference.ts"] }, { key: "test", title: "검증", template: "test.md", kind: "test", scope: "project", outputDirs: ["test"] }] }));
  write("doc/architecture.md", "# 아키텍처\n## 기술 스택\nNode\n## 모듈/패키지 구조\nsrc\n## 계층과 책임\n함수\n## 의존 방향\ntest → src\n## 공통 모듈\n없음\n## 주요 결정\n순수 함수");
  write("doc/conventions.md", "# 컨벤션\n## 명명\n소문자\n## 계층별 규칙\n순수 함수\n## 예외 처리\nError");
  write("doc/test-strategy.md", "# 테스트 전략\n## 수준과 범위\n- Unit: 필수\n## 도구와 실행 명령\n- `test`: 전체\n## 통과 기준\n- AC마다1개");
  write("doc/quality.md", "# 품질\n## 정적 분석\n- `build`: 컴파일\n## 보안 검사\n- 없음 — 리뷰에서 확인\n## 통과 기준과 반영 차단\n- 컴파일 실패 차단");
  write(".gitignore", ".code-agent/\n");
  write("src/current.ts", "export const current = 1;\n");
  write("src/reference/reference.ts", "export const reference = 1;\n");
  write("other/current.ts", "export const other = 1;\n");
  write(SPEC, `---\nkind: feature\nid: ${ID}\ntitle: 값 반환\ntarget: value\n---\n\n값을 반환한다.\n`);
  for (const check of checkProjectDocs(root, loadManifest(root))) recordDocConfirmation(root, check, "test", { channel: "tty", verified: true, detail: "테스트" });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture"], { cwd: root });
  start(root, join(root, SPEC), { planning: true });
});
afterEach(() => {
  assert.ok(root.startsWith(`${realpathSync.native(tmpdir())}${sep}ca-retry-`));
  rmSync(root, { recursive: true, force: true });
});

test("needs-input 의 쓰던 문서는 초안으로만 남고, 답을 받은 재배정이 초안·답변·바뀐 입력을 이어받는다", () => {
  preparePlanning(root);
  const first = dispatch("analysis");
  // resultShape 를 미리 채운 그대로(파일 없이) 둔 자리는 초안이 아니고, 결과를 거부할 이유도 아니다
  run(first, { status: "needs-input", questions: [{ id: "Q1", question: "단위는 원인가?", requirements: ["REQ-1"] }], artifacts: [{ path: OUT, staged: first.staging[OUT] }] }, "codex",
    () => write(first.staging[OUT], "# 요구 정의\n## R1 · 값 반환\n근거: \"값을 반환한다.\"\n"));
  const [asked] = attempts("analysis");
  assert.equal(asked.status, "needs-input");
  assert.deepEqual(asked.drafts?.map((draft) => draft.path), [OUT]);
  assert.equal(existsSync(join(root, OUT)), false, "초안을 정식 문서로 옮기지 않는다");
  assert.match(readFileSync(join(root, DIR, "questions.md"), "utf8"), /## Q1 · [\s\S]*단위는 원인가\?[\s\S]*\[Origin\]: analysis/);

  // 파일 머리 주석에도 `[Answer]:` 가 있다 — 질문 블록의 마지막 줄만 채운다
  write(`${DIR}/questions.md`, readFileSync(join(root, DIR, "questions.md"), "utf8").replace(/\[Answer\]:\n$/, "[Answer]: 원 단위다\n"));
  const summary = JSON.parse(handoffPlanning(root, dispatchPlanning(root, "analysis")));
  assert.deepEqual(Object.keys(summary.previous).sort(), ["detail", "dispatchId", "drafts", "status"], "메인 요약에는 답변·바뀐 입력을 싣지 않는다");
  const file = readFileSync(join(root, summary.assignmentFile), "utf8");
  assert.match(file, /## 직전 시도\n\n- 상태: needs-input/);
  assert.match(file, /- staging 에 직전 초안을 미리 두었다: doc\/work\/RETRY-1\/01-requirements\.md/);
  assert.match(file, /- 직전 질문의 답:\n  - Q1 단위는 원인가\? → 원 단위다/);
  assert.match(file, /- 직전 시도 뒤 바뀐 입력:\n  - 질문 Q1 추가·변경\(출처 analysis\)/);
  assert.match(file, /## 제출 전 점검[\s\S]*- \[REQ-TRACE\] `출처:` 에 지시서 ID 를 글자 그대로\(REQ-1\)/);
  assert.doesNotMatch(file, /\[PLN-|\[IMP-/, "역할에 걸리지 않는 규칙은 싣지 않는다");
  const second = JSON.parse(readFileSync(join(root, summary.assignmentFile), "utf8").split("```json\n")[1].split("\n```")[0]);
  assert.match(second.statusContract["needs-input"], /질문 하나 이상\(requirements 는 REQ-1 중에서\)/);
  run(second, { artifacts: [{ path: OUT, staged: second.staging[OUT] }] }, "codex",
    () => {
      assert.match(readFileSync(join(root, second.staging[OUT]), "utf8"), /## R1 · 값 반환/, "직전 초안이 staging 에 놓였다");
      write(second.staging[OUT], REQUIREMENTS);
    });
  assert.equal(attempts("analysis").at(-1)!.status, "completed");
  assert.equal(readFileSync(join(root, OUT), "utf8"), REQUIREMENTS);
});

test("needs-input 에 질문이 없으면 거부하고, 문서 검사에 걸린 완료 결과는 초안·질문·전체 사유를 다음 배정에 넘긴다", () => {
  preparePlanning(root);
  run(dispatch("analysis"), { status: "needs-input" });
  assert.match(attempts("analysis")[0].error!, /^\[RES-STATUS\] needs-input 결과에는 사용자가 정할 질문이 하나 이상/);
  const broken = '# 요구 정의\n## R1 · 값 반환\n출처: REQ-1\n## 가정\n- 없음';
  run(dispatch("analysis"), { artifacts: [{ path: OUT, content: broken }] });
  const failed = attempts("analysis")[1];
  assert.equal(failed.status, "failed");
  assert.equal(failed.drafts?.[0].path, OUT);
  assert.equal(readFileSync(join(root, failed.drafts![0].staged), "utf8"), broken, "{path, content} 로 낸 초안도 그 배정의 staging 에 남긴다");
  const summary = JSON.parse(handoffPlanning(root, dispatchPlanning(root, "analysis")));
  const file = readFileSync(join(root, summary.assignmentFile), "utf8");
  assert.match(file, /- 거부·실패 사유 — 이 부분만 고친다:\n  - \[REQ-FORMAT\] doc\/work\/RETRY-1\/01-requirements\.md: 근거: 줄이 없는 요구 항목: R1\(2행\)/);
  const third = JSON.parse(file.split("```json\n")[1].split("\n```")[0]);
  run(third, { artifacts: [{ path: OUT, staged: third.staging[OUT] }] }, "codex", () => {
    assert.equal(readFileSync(join(root, third.staging[OUT]), "utf8"), broken, "실패한 초안에서 이어 쓴다");
    write(third.staging[OUT], REQUIREMENTS);
  });
  assert.equal(attempts("analysis").at(-1)!.status, "completed");
});

test("Claude 완료 hook — 미리 채운 artifacts 를 둔 needs-input 은 되돌리지 않고, 질문 없는 needs-input 만 같은 담당에게 되돌린다", () => {
  preparePlanning(root);
  const item = dispatch("analysis");
  const event = { cwd: root, session_id: "s", agent_id: "claude-1", agent_type: item.hostAgents.claude };
  observePlanner({ ...event, hook_event_name: "SubagentStart" });
  const result = { taskId: item.task.id, dispatchId: item.resultShape.dispatchId, inputHash: item.resultShape.inputHash, status: "needs-input", summary: "단위 결정 필요", evidence: [{ path: SPEC, line: 1 }], facts: [],
    questions: [] as unknown[], findings: [], artifacts: [{ path: OUT, staged: item.staging[OUT] }] };
  const stop = (body: object) => {
    const saved = process.env.CLAUDE_PROJECT_DIR, write = process.stderr.write;
    process.env.CLAUDE_PROJECT_DIR = root;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try { return runPlanningHook(JSON.stringify({ ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify(body) })); }
    finally { process.stderr.write = write; if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved; }
  };
  assert.equal(stop(result), 2, "질문 없는 needs-input 은 같은 담당에게 되돌린다");
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "running");
  assert.deepEqual(loadPlanning(loadWork(root)!).agents.at(-1)!.returnedRules, ["RES-STATUS"], "되돌린 규칙은 측정에만 남긴다");
  assert.equal(stop({ ...result, questions: [{ id: "Q1", question: "단위는 원인가?", requirements: ["REQ-1"] }] }), 0, "미완료 결과의 artifacts 로 되돌리지 않는다");
  const last = loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!;
  assert.equal(last.status, "needs-input");
  assert.equal(last.drafts, undefined, "쓰지 않은 자리는 초안이 아니다");
});

test("종료된 담당에게 닿지 않은 되돌림은 지적·초안을 보존해 메인에게 회수와 재배정을 안내한다", async () => {
  preparePlanning(root);
  const item = dispatch("analysis");
  const broken = "# 요구 정의\n## R1 · 값 반환\n근거가 빠진 초안\n";
  run(item, { artifacts: [{ path: OUT, staged: item.staging[OUT] }] }, "claude", () => write(item.staging[OUT], broken));
  const pending = attempts("analysis").at(-1)!;
  assert.ok(pending.returnPending?.detail.includes("REQ-FORMAT"));
  assert.ok(pending.drafts?.length);
  const view = stateView(root);
  assert.notEqual(view.resume.code, "wait");
  assert.ok(view.resume.reasons.some(reason => reason.code === "attempt-return-pending"));
  assert.match(await advancePlanning(root), /담당이 이미 종료됐다면/);
  assert.deepEqual(running(), [`agent-${serial}`], "되돌린 담당은 끝을 관찰하기 전까지 실행 중이다");
  cancelPlanning(root, "analysis");
  assert.equal(attempts("analysis").at(-1)!.returnDeliveryFailed, true);
  assert.deepEqual(running(), [], "회수한 배정의 담당은 장부에서도 거둔다 — 재배정한 담당의 완료 뒤 이어가기를 막지 않는다");
  const summary = JSON.parse(handoffPlanning(root, dispatchPlanning(root, "analysis")));
  const assignment = readFileSync(join(root, summary.assignmentFile), "utf8");
  assert.match(assignment, /REQ-FORMAT/);
  const again = JSON.parse(assignment.split("```json\n")[1].split("\n```")[0]);
  run(again, { artifacts: [{ path: OUT, staged: again.staging[OUT] }] }, "codex", () => {
    assert.equal(readFileSync(join(root, again.staging[OUT]), "utf8"), broken);
    write(again.staging[OUT], REQUIREMENTS);
  });
  assert.equal(attempts("analysis").at(-1)!.status, "completed");
  assert.deepEqual([pendingCompletion(root, loadWork(root)!.active.id)?.completion.status, pendingCompletion(root, loadWork(root)!.active.id)?.running], ["completed", 0]);
});

test("완료된 정식 문서보다 오래된 초안은 다시 놓지 않는다", () => {
  const record = { task: { id: "analysis" }, attempts: [
    { status: "failed", drafts: [{ path: OUT, staged: "old", chars: 1 }] }, { status: "completed" },
    { status: "needs-input", drafts: [{ path: "x.md", staged: "newer", chars: 1 }] }, { status: "running" },
  ] } as unknown as TaskRecord;
  assert.deepEqual([...latestDrafts(record)], [["x.md", "newer"]]);
  record.attempts.splice(2, 1);
  assert.deepEqual([...latestDrafts(record)], []);
});

test("contextVersion 4 — 읽으라고 준 참조·계획 기존 파일이 입력이고, 선행 결과의 사실 출처를 인용할 수 있다", () => {
  preparePlanning(root);
  run(dispatch("analysis"), { artifacts: [{ path: OUT, content: REQUIREMENTS }] });
  next(root); preparePlanning(root);
  const work = loadWork(root)!, state = loadPlanning(work);
  const task = (role: "design" | "critic", contextVersion: 3 | 4) => ({ id: role, role, contextVersion, title: role, requirements: ["R1"], inputs: [SPEC], scopes: [], outputs: [], dependsOn: [], questionIds: [] });
  assert.ok(inputFiles(work, task("design", 4), state).includes("src/reference/reference.ts"), "context 의 참조 표준 파일");
  assert.ok(!inputFiles(work, task("design", 3), state).includes("src/reference/reference.ts"), "진행 중이던 작업(3)의 입력 해시는 그대로");
  write(`${DIR}/plan.json`, JSON.stringify({ files: [{ path: "src/current.ts" }, { path: "src/new.ts" }, { path: "../escape.ts" }] }));
  const critic = inputFiles(work, task("critic", 4), state);
  assert.ok(critic.includes("src/current.ts") && !critic.includes("src/new.ts") && !critic.includes("../escape.ts"), critic.join(", "));

  // 조사 담당이 사실로 남긴 출처는 합성 담당이 인용할 수 있다 — 어디에도 없던 파일은 계속 범위 밖이다
  const explored = run(dispatch("explore"), { facts: [{ key: "기존", value: "other 에도 있다", source: { path: "other/current.ts", line: 1 } }] });
  assert.equal(explored, undefined, explored?.message ?? "");
  const synthesized = run(dispatch("synthesis"), { evidence: [{ path: "other/current.ts", line: 1 }, { path: "code-agent.json", line: 1 }], artifacts: [{ path: `${DIR}/02-analysis.md`, content: IMPACT }] });
  assert.equal(synthesized, undefined, synthesized?.message ?? "");
  assert.equal(attempts("synthesis").at(-1)!.status, "completed", attempts("synthesis").at(-1)!.error ?? "");
  write(`${DIR}/02-analysis.md`, IMPACT + "\n");   // 출력이 바뀌어 다시 배정한다
  run(dispatch("synthesis"), { evidence: [{ path: "src/current.ts", line: 1 }], artifacts: [{ path: `${DIR}/02-analysis.md`, content: IMPACT }] });
  assert.match(attempts("synthesis").at(-1)!.error!, /^\[RES-SCOPE\] 배정 범위 밖 근거입니다: src\/current\.ts/);
});

test("제출 전 점검은 역할·작업 종류에 걸리는 규칙만 싣고, 코드가 내는 모든 규칙 ID 는 표에 있다", () => {
  const ctx = (role: string, kind: string, extra: Partial<ChecklistContext> = {}): ChecklistContext =>
    ({ role, kind, requirements: ["R1", "R2"], outputs: [`${DIR}/02-analysis.md`], log: false, knowledge: false, preserve: false, stages: [{ key: "app", dirs: ["src"], test: false }, { key: "test", dirs: ["test"], test: true }], ...extra });
  assert.ok(rulesFor(ctx("impact", "fix", { log: true })).includes("IMP-LOG"));
  assert.ok(!rulesFor(ctx("impact", "feature", { log: true })).includes("IMP-LOG"));
  assert.ok(!rulesFor(ctx("impact", "feature")).includes("IMP-CURRENT"));
  assert.ok(rulesFor(ctx("plan", "refactor")).includes("PLN-REFACTOR") && !rulesFor(ctx("plan", "feature")).includes("PLN-REFACTOR"));
  assert.ok(rulesFor(ctx("plan", "fix")).includes("TST-REPRO") && rulesFor(ctx("plan", "fix")).includes("PLN-FIX"));
  assert.deepEqual(rulesFor(ctx("explore", "feature", { outputs: [] })), ["RES-SCOPE", "RES-STATUS", "RES-QREQ"]);
  assert.match(submitChecklist(ctx("impact", "fix", { log: true })), /\[IMP-LOG\] .*예: `- \\`NullPointerException: items is null\\` → src\/main\/java\/app\/OrderService\.java:42/);
  assert.match(submitChecklist(ctx("plan", "fix")), /\[PLN-FIX\] sequence\[0\] 은 테스트 단계, 재현 테스트 파일은 테스트 단계 위치\(test\) 안에/);
  // 검사 문구의 ID 와 점검 표가 어긋나지 않는다 — 소스의 ruled("…") 를 모두 모아 대조한다
  const source = join(__dirname, "..", "..", "src", "agent");
  const used = new Set(readdirSync(source).filter((name) => name.endsWith(".ts")).flatMap((name) => [...readFileSync(join(source, name), "utf8").matchAll(/ruled\("([A-Z]+-[A-Z]+)"/g)].map((match) => match[1])));
  const known = RULES.map((rule) => rule.id);
  assert.deepEqual([...used].filter((id) => !known.includes(id as never)), [], "표에 없는 ID 를 쓰지 않는다");
  assert.deepEqual(known.filter((id) => !used.has(id)), [], "표의 ID 는 모두 어떤 검사가 낸다");
});
