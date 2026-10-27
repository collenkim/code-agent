import { writeFixture as writeRepoFile } from "./repoFixture";
/** 계획 시험 공통 저장소·자료·관찰 헬퍼. 시험 파일별 프로세스에서 독립적으로 초기화한다. */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { start } from "./confirmedStart";
import { observeQuestionAnswers } from "./consentFixture";
import { next, submitPlan } from "../agent/commands";
import { crossCritic } from "../agent/crossCheck";
import { withCaller } from "./reviewFixture";
import { planningAdvanceCli, planningNextLine } from "../agent/planningChain";
import { checkProjectDocs, recordDocConfirmation } from "../agent/docs";
import { loadActive, saveActive } from "../agent/layout";
import { dispatchPlanning, preparePlanning, advancePlanning } from "../agent/planning";
import { codexHook } from "../agent/codexHook";
import { observePlanner } from "../agent/planningHook";
import { planningProblems, type PlanningResult, type PlanningState } from "../agent/planningState";
import { loadWork } from "../agent/work";
import { loadManifest } from "../core/manifest";

export const ID = "PLAN-1", DIR = `doc/work/${ID}`, SPEC = `${DIR}/requirement.md`;
export const REQUIREMENTS = '# 요구 정의\n## R1 · 값 반환\n근거: "값을 반환한다."\n## 가정\n- 없음';
export const IMPACT = '# 영향도\n## 기존 시스템 분석\n- src/current.ts:1 에 값을 반환한다\n## 영향 범위\n| R 번호 | 닿는 파일 | 호출자 | 파급 |\n|---|---|---|---|\n| R1 | src/current.ts:1 | 없음 | 새 진입점 |\n## Risk\n- 기존 반환값 보존\n## 문서 영향\n| 문서 | 키 | 판단 | 근거 |\n|---|---|---|---|\n| - | - | 영향 없음 | 지식 항목이 없다 |\n';
export const DESIGN = '# 설계\n## 구성 요소\n- 새 함수\n## 처리 흐름\n- 호출 → 반환\n## API\n해당 없음 — 내부 함수다\n## 데이터\n해당 없음 — 저장하지 않는다\n## 설계 결정\n- 순수 함수';
export const FUNCTIONAL = '# 기능\n## 기능 정의\n- R1: 값 반환\n## 업무 규칙\n- BR-1: 숫자 반환 (src/current.ts:1)\n## 예외\n- 없음 — 입력 없다\n## 수락 기준\n- AC-R1-1: 호출하면 숫자가 반환된다';
export const TESTS = '# 테스트\n## 테스트 케이스\n| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |\n|---|---|---|---|---|\n| TC-1 | Unit | AC-R1-1 | 호출 | 숫자 반환 |';
export const PLAN = { domainName: "Value", domainLabel: "값", domainRoot: "", domainDirName: "value", approach: "순수 함수", reasoning: "기존 함수 보존", conventions: [], conflicts: [], openQuestions: [], files: [
  { stage: "app", path: "src/a.ts", purpose: "진입점", requirements: ["R1"] }, { stage: "app", path: "src/b.ts", purpose: "변환", requirements: ["R1"] }, { stage: "test", path: "test/value.test.ts", purpose: "검증", requirements: ["R1"] },
], sequence: [{ step: "app", why: "구현" }, { step: "test", why: "검증" }], tasks: [
  { id: "T1", stage: "app", title: "진입점", requirements: ["R1"], files: ["src/a.ts"], dependsOn: [], acceptance: ["AC-R1-1"] },
  { id: "T2", stage: "app", title: "변환", requirements: ["R1"], files: ["src/b.ts"], dependsOn: ["T1"], acceptance: ["AC-R1-1"] },
  { id: "T3", stage: "test", title: "검증", requirements: ["R1"], files: ["test/value.test.ts"], dependsOn: ["T2"], acceptance: ["AC-R1-1"] },
] };
export let root: string, serial = 0;
export const advance = async () => JSON.parse((await advancePlanning(root)));
export function write(path: string, content: string): void {
  writeRepoFile(root, path, content);
  // 질문 답은 사람이 질문 도구로 고른 것으로 둔다(답 출처 게이트) — 출처 판정 자체는 answers.test 가 본다
  if (path.endsWith("questions.md")) observeQuestionAnswers(root);
}
export function phase(phase: "analysis" | "impact" | "design" | "plan"): void { saveActive(root, { ...loadActive(root)!, phase }, "next"); }
export function dispatch(id: string) { return JSON.parse(dispatchPlanning(root, id)); }
export function finish(dispatch: ReturnType<typeof JSON.parse>, artifacts: Record<string, string> = {}, extra: Partial<PlanningResult> = {}, host: "claude" | "codex" = "claude") {
  const event = { cwd: root, session_id: "s", agent_id: `agent-${++serial}`, agent_type: dispatch.hostAgents[host] };
  const result: PlanningResult = { taskId: dispatch.task.id, dispatchId: dispatch.resultShape.dispatchId, inputHash: dispatch.resultShape.inputHash, status: "completed", summary: "실제 근거 확인", evidence: [{ path: SPEC, line: 1 }], facts: [], questions: [], findings: [], artifacts: Object.entries(artifacts).map(([path, content]) => ({ path, content })), ...extra };
  const observe = host === "codex" ? codexHook : observePlanner;
  observe({ ...event, hook_event_name: "SubagentStart" });
  observe({ ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify(result) });
  return { event, result };
}
/** CLI는 배정 전문을 파일로 넘기고 경로만 출력한다 — 메인이 본문을 옮겨 쓰지 않도록 */
export function handed(summary: { assignmentFile: string; resultShape?: unknown }) {
  assert.equal(summary.resultShape, undefined);
  const text = readFileSync(join(root, summary.assignmentFile), "utf8"), from = text.indexOf("```json\n") + 8;
  return JSON.parse(text.slice(from, text.indexOf("\n```", from)));
}
export function analysis() { preparePlanning(root); finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS }); next(root); }
export function throughDesign() {
  analysis(); preparePlanning(root);
  finish(dispatch("explore"), {}, { evidence: [{ path: "src/current.ts", line: 1 }] });
  finish(dispatch("synthesis"), { [`${DIR}/02-analysis.md`]: IMPACT }); next(root);
  preparePlanning(root); finish(dispatch("design"), { [`${DIR}/03-design.md`]: DESIGN, [`${DIR}/04-functional.md`]: FUNCTIONAL }); next(root);
}
export function throughPlan() {
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

export function malformed(item: any, options: { codex?: boolean; raw?: string; id?: string } = {}) {
  const event = { cwd: root, session_id: "format-session", agent_id: options.id ?? `format-${++serial}`, agent_type: item.agent };
  const value = { ...item.resultShape, status: "completed", summary: 123, artifacts: [{ path: `${DIR}/01-requirements.md`, content: REQUIREMENTS }] };
  const observe = options.codex ? codexHook : observePlanner;
  observe({ ...event, hook_event_name: "SubagentStart" });
  assert.throws(() => observe({ ...event, hook_event_name: "SubagentStop", last_assistant_message: options.raw ?? JSON.stringify(value) }), /결과 형식 오류/);
  return { event, value };
}

/** 두 호스트 설치 + plan·critic 완료 + 가짜 claude(FAKE_CROSS 를 결과로 내고, 호출 수와 마지막 프롬프트를 파일에 남긴다) */
export function crossPlanningSetup() {
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
export const crossProblems = () => planningProblems(loadWork(root)!, "plan").filter((problem) => /교차/.test(problem));

// ---- 재시도 규약·질문 출처·고아·되감기·결정적 문서 검사 ----

export const planningJson = () => join(root, ".code-agent/work", ID, "value.planning.json");
export function editPlanning(change: (state: PlanningState) => void): void {
  const state = JSON.parse(readFileSync(planningJson(), "utf8")) as PlanningState;
  change(state);
  writeFileSync(planningJson(), JSON.stringify(state, null, 2));
}
export const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
/** questions.md 의 그 질문 `[Answer]:` 뒤에 답을 적는다 */
export function answer(id: string, value: string): void {
  const body = readFileSync(join(root, DIR, "questions.md"), "utf8");
  write(`${DIR}/questions.md`, body.replace(new RegExp(`(## ${id} [\\s\\S]*?\\[Answer\\]:)`), `$1 ${value}`));
}
/** CLAUDE_PROJECT_DIR 을 root 로 두고 stderr 를 모은다 */
export function quiet<T>(fn: (stderr: () => string) => T): T {
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
export async function quietAsync<T>(fn: (stderr: () => string) => Promise<T>): Promise<T> {
  const saved = process.env.CLAUDE_PROJECT_DIR, original = process.stderr.write;
  let text = "";
  process.env.CLAUDE_PROJECT_DIR = root;
  process.stderr.write = ((chunk: unknown) => { text += String(chunk); return true; }) as typeof process.stderr.write;
  try { return await fn(() => text); }
  finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
    process.stderr.write = original;
  }
}
/** 동기 호출의 stdout·stderr 를 모은다 */
export function captured<T>(fn: () => T): { value: T; out: string; err: string } {
  const out = process.stdout.write, err = process.stderr.write;
  let stdout = "", stderr = "";
  process.stdout.write = ((chunk: unknown) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try { return { value: fn(), out: stdout, err: stderr }; }
  finally { process.stdout.write = out; process.stderr.write = err; }
}
export const startAgent = (item: any, agent: string) => observePlanner({ cwd: root, session_id: "s", agent_id: agent, agent_type: item.agent, hook_event_name: "SubagentStart" });
export const stopEvent = (item: any, agent: string, message: unknown, extra: object = {}) => JSON.stringify({ cwd: root, session_id: "s", agent_id: agent, agent_type: item.agent, hook_event_name: "SubagentStop",
  last_assistant_message: typeof message === "string" ? message : JSON.stringify(message), ...extra });
export const completed = (item: any, artifacts: Record<string, string> = {}, extra: Partial<PlanningResult> = {}) => ({ ...item.resultShape, status: "completed", summary: "근거 확인", evidence: [{ path: SPEC, line: 1 }],
  facts: [], questions: [], findings: [], artifacts: Object.entries(artifacts).map(([path, content]) => ({ path, content })), ...extra });
/** design 단계까지 — design 작업은 아직 배정하지 않는다 */
export function toDesign(): void {
  analysis(); preparePlanning(root);
  finish(dispatch("explore"), {}, { evidence: [{ path: "src/current.ts", line: 1 }] });
  finish(dispatch("synthesis"), { [`${DIR}/02-analysis.md`]: IMPACT }); next(root);
}
export const DUPLICATED_AC = `${FUNCTIONAL}\n- AC-R1-1: 다시 반환된다`;

// ---- 검토 반영: 크기 한도·늦은 결과·고아 표시·직전 실패·되돌린 보고 ----

// ---- C7 — next 줄·연쇄(--chain) ----

export const chain = async (on = true) => { const out = (await planningAdvanceCli(root, { chain: on })); return { exit: out.exit, view: JSON.parse(out.text) }; };

/** 실제 advance 출력(파일 픽스처)의 next 가 같은 출력으로 만든 표의 행과 같고, 연쇄는 게이트를 시도하지 않는다 */
export async function chainedWithoutGate(action: string) {
  const out = (await chain());
  assert.equal(out.view.action, action, JSON.stringify(out.view));
  assert.equal(out.exit, 0);
  assert.equal(out.view.chain, undefined);
  assert.equal(out.view.next, planningNextLine(out.view, { chained: true, workDir: DIR }));
  return out.view;
}
