import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test, mock } from "node:test";
import { sourceItems, sourceTrace } from "../agent/sourceTrace";
import { confirmDoc, docsBegin, docsEnd } from "../agent/docsCommands";
import { setupProject } from "../agent/setup";
import { requestBegin, requestSubmit, loadRequestSession, recordRequestDecision } from "../agent/request";
import { abort, start, next, status, submitPlan, requireValidatable } from "../agent/commands";
import { loadActive, planFile } from "../agent/layout";
import { checkProjectDocs, recordDocConfirmation, readDocLedger } from "../agent/docs";
import { approvalDocsHash, loadWork, loadManifestIfAny } from "../agent/work";
import { decide as hook } from "../agent/hook";
import { recordDecision } from "../core/approval";
import { planTasks, sequenceProblems } from "../core/plan";
import { parseRequirements } from "../agent/workDocs";
import { check, runTests, integrate } from "../agent/validate";
import { openRound, reviewDocFile } from "../agent/review";
import { recordReviewFixture } from "./reviewFixture";
import { deliverProblems, renderTraceBlock } from "../agent/deliver";
import { loadEvidence } from "../agent/evidence";
import * as tty from "../agent/tty";

let repo: string;
const presence = { channel: "tty" as const, verified: true, detail: "테스트 fixture" };
function write(file: string, text: string) { mkdirSync(dirname(join(repo, file)), { recursive: true }); writeFileSync(join(repo, file), text); }
function read(file: string) { return readFileSync(join(repo, file), "utf8"); }
function git(...args: string[]) {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
beforeEach(() => { repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-process-"))); });
afterEach(() => { mock.restoreAll(); rmSync(repo, { recursive: true, force: true }); });

test("원문 두 문장 중 하나가 빠지면 추적 검사가 막고 인용의 합으로 전량 연결한다", () => {
  const order = "---\nkind: feature\n---\n값 1을 반환한다. 입력 오류를 거부한다.\n";
  const one = '## R1 · 값\n근거: "값 1을 반환한다."\n## 가정\n- 없음';
  assert.match(sourceTrace(order, one).problems.join("\n"), /빠진 요구 REQ-1.*입력 오류/);
  const all = one + '\n## R2 · 오류\n근거: "입력 오류를 거부한다."';
  assert.deepEqual(sourceTrace(order, all).problems, []);
  assert.deepEqual(sourceTrace(order, all).rows[0].requirements, ["R1", "R2"]);
  assert.match(sourceTrace(order, all.replace("입력 오류를 거부한다.\"", "입력 오류를 무시한다.\"")).problems.join("\n"), /인용이 확정된/);
});

test("정리된 요구·완료 조건·제약은 각각 추적하며 원문 블록으로 대체하지 않는다", () => {
  const order = "## 원문\n> 요청 원문\n## 요구 내용\n- [REQ-1] 기능 추가\n## 완료 조건\n- [DONE-1] 오류 거부\n## 제약\n- [CON-1] 호환 유지\n";
  assert.deepEqual(sourceItems(order).map((item) => item.id), ["REQ-1", "DONE-1", "CON-1"]);
  const analysis = '## R1 · 구현\n출처: REQ-1\n근거: "기능 추가"';
  assert.match(sourceTrace(order, analysis).problems.join("\n"), /DONE-1/);
  assert.match(sourceTrace(order, analysis).problems.join("\n"), /CON-1/);
  assert.match(sourceTrace(order, analysis.replace("REQ-1", "REQ-99")).problems.join("\n"), /없는 출처/);
  const multiline = "## 요구 내용\n- [REQ-1] 저장한다.\n  실패하면 오류.\n- [REQ-2] 조회한다.\n";
  assert.deepEqual(sourceItems(multiline), [{ id: "REQ-1", text: "저장한다.\n실패하면 오류." }, { id: "REQ-2", text: "조회한다." }]);
  assert.deepEqual(sourceTrace(multiline, '## R1 · 전체\n출처: REQ-1, REQ-2\n근거: "저장한다. 실패하면 오류."\n근거: "조회한다."').problems, []);
  assert.match(sourceTrace("값 >= 100", '## R1 · 조건\n근거: "값"\n근거: "100"').problems.join("\n"), />=/);
  for (const citation of ["", '""', '"  "']) assert.throws(() => parseRequirements(`## R1 · 값\n근거: ${citation}\n## 가정\n- 없음`), /근거:/);
});

test("설정 없는 접수에서 ID 발급·원문 보존·준비·복귀가 이어지고 코드는 잠겨 있다", () => {
  assert.match(requestBegin(repo, undefined, "feature"), /WORK-0001/);
  write("doc/work/WORK-0001/request.json", '{"original":"인사 프로그램"}');
  assert.match(status(repo), /ca-adopt/);
  assert.match(docsBegin(repo), /접수한 ID·원문 초안은 유지됩니다/);
  assert.match(setupProject(repo, "node"), /추천 구성 node/);
  assert.match(hook({ cwd: repo, tool_name: "Write", tool_input: { file_path: join(repo, "src/app.js") } })!, /문서 작성 중/);
  assert.match(hook({ cwd: repo, tool_name: "Write", tool_input: { file_path: join(repo, "doc/work/WORK-0001/requirement.md") } })!, /접수가 아니라|request submit/);
  assert.match(docsEnd(repo), /접수 WORK-0001 유지/);
  assert.equal(read("doc/work/WORK-0001/request.json"), '{"original":"인사 프로그램"}');
  assert.equal(loadRequestSession(repo)?.id, "WORK-0001");
  abort(repo);
  assert.match(requestBegin(repo, undefined, "feature"), /WORK-0002/);
});

test("신규 추천은 기존 코드와 문서를 덮지 않고 Python 정책도 필수 절을 채운다", () => {
  docsBegin(repo);
  write("main.cpp", "int main() {}\n");
  assert.throws(() => setupProject(repo, "node"), /기존 설정이나 프로젝트 파일/);
  rmSync(join(repo, "main.cpp"));
  write("doc/architecture.md", "사람이 쓴 문서");
  assert.throws(() => setupProject(repo, "python"), /기존 파일을 덮지/);
  assert.equal(existsSync(join(repo, "code-agent.json")), false);
  rmSync(join(repo, "doc/architecture.md"));
  setupProject(repo, "python");
  assert.ok(checkProjectDocs(repo, loadManifestIfAny(repo)).every((entry) => entry.state === "unconfirmed"));
  assert.equal(loadManifestIfAny(repo)?.language, "python");
});

test("문서 일괄 확정은 TTY가 필요하고 읽는 중 바뀌면 한 건도 확정하지 않는다", () => {
  docsBegin(repo); setupProject(repo, "node"); docsEnd(repo);
  assert.throws(() => confirmDoc(repo, "all"), /TTY/);
  mock.method(tty, "confirmOnTerminal", () => { write("doc/architecture.md", read("doc/architecture.md") + "\n변경\n"); return presence; });
  assert.throws(() => confirmDoc(repo, "all"), /확정하는 동안/);
  assert.equal(readDocLedger(repo).length, 0);
  mock.restoreAll();
  mock.method(tty, "confirmOnTerminal", () => presence);
  assert.match(confirmDoc(repo, "all"), /POLICY 4종을 확정/);
  assert.equal(readDocLedger(repo).length, 4);
  confirmDoc(repo, "all");
  assert.equal(readDocLedger(repo).length, 4);
});

test("Python 추천 명령은 실제 코드를 검사하고 TC를 실행하며 계획 밖 캐시를 만들지 않는다", (t) => {
  if (spawnSync("python", ["--version"]).status !== 0) return t.skip("Python 런타임이 없는 환경");
  docsBegin(repo); setupProject(repo, "python"); docsEnd(repo);
  const manifest = loadManifestIfAny(repo)!;
  write("src/value.py", "def value(n):\n    return n\n");
  write("tests/test_value.py", 'import unittest\nfrom src.value import value\nclass ValueTest(unittest.TestCase):\n    def test_value(self):\n        """TC-1"""\n        self.assertEqual(value(2), 2)\n');
  const run = (argv: string[]) => spawnSync(argv[0], argv.slice(1), { cwd: repo, encoding: "utf8" });
  assert.equal(run(manifest.build!).status, 0);
  const tested = run(manifest.test!);
  assert.equal(tested.status, 0, tested.stderr);
  assert.match(tested.stdout + tested.stderr, /TC-1/);
  assert.equal(existsSync(join(repo, "src/__pycache__")), false);
  assert.equal(existsSync(join(repo, "tests/__pycache__")), false);
  write("src/value.py", "return 1\n");
  assert.notEqual(run(manifest.build!).status, 0);
});

async function preparedPlan() {
  git("init", "-q", "-b", "master");
  docsBegin(repo); setupProject(repo, "node"); docsEnd(repo);
  for (const entry of checkProjectDocs(repo, loadManifestIfAny(repo))) recordDocConfirmation(repo, entry, "test", presence);
  write(".gitignore", ".code-agent/active.json\n.code-agent/request-session.json\n.code-agent/docs-session.json\n.code-agent/log/\n");
  git("add", "."); git("commit", "-qm", "initial setup");
  requestBegin(repo, "FLOW-1", "feature");
  const draft = "doc/work/FLOW-1/request.json";
  write(draft, JSON.stringify({ id: "FLOW-1", kind: "feature", title: "값과 오류", target: ["value"], original: "값 1을 반환한다. 음수는 거부한다.", requirements: ["값 1을 반환한다.", "음수는 거부한다."] }));
  requestSubmit(repo, join(repo, draft));
  const spec = "doc/work/FLOW-1/requirement.md";
  recordRequestDecision(repo, { id: "FLOW-1", spec, decision: "confirmed", approver: "test", presence });
  docsBegin(repo);
  assert.throws(() => start(repo, join(repo, spec)), /문서 준비 세션/);
  docsEnd(repo);
  start(repo, join(repo, spec));
  const prefix = "doc/work/FLOW-1/";
  const one = '## R1 · 값\n출처: REQ-1\n근거: "값 1을 반환한다."\n## 가정\n- 없음\n';
  write(prefix + "01-requirements.md", one);
  assert.throws(() => next(repo), /빠진 요구 REQ-2/);
  write(prefix + "01-requirements.md", one + '\n## R2 · 오류\n출처: REQ-2\n근거: "음수는 거부한다."\n');
  next(repo);
  write(prefix + "02-analysis.md", "## 기존 시스템 분석\n새 기능\n## 영향 범위\n| R | 파일 | 호출 | 파급 |\n|---|---|---|---|\n| R1 | src/value.js | 없음 | 새 기능 |\n| R2 | src/value.js | 없음 | 예외 |\n## Risk\n잘못된 입력\n");
  next(repo);
  write(prefix + "03-design.md", "## 구성 요소\nvalue 함수\n## 처리 흐름\n입력 검사 후 값 반환\n## API\n해당 없음 — 외부 접점 없음\n## 데이터\n해당 없음 — 저장 없음\n## 설계 결정\n순수 함수\n");
  write(prefix + "04-functional.md", "## 기능 정의\n값과 오류\n## 업무 규칙\n음수 거부\n## 예외\n음수는 Error\n## 수락 기준\n- AC-R1-1: 양수이면 1\n- AC-R2-1: 음수이면 Error\n");
  next(repo);
  write(prefix + "07-test-spec.md", "## 테스트 케이스\n| TC | 수준 | AC | 케이스 | 기대 결과 |\n|---|---|---|---|---|\n| TC-1 | Unit | AC-R1-1 | 양수 | 1 |\n| TC-2 | Unit | AC-R2-1 | 음수 | Error |\n");
  const plan = { domainName: "Value", domainLabel: "값", domainRoot: "", domainDirName: "value",
    files: [{ stage: "code", path: "src/value.js", purpose: "값과 오류", requirements: ["R1", "R2"] }, { stage: "test", path: "tests/value.test.js", purpose: "검증", requirements: ["R1", "R2"] }],
    sequence: [{ step: "test", why: "동작을 먼저 명시" }, { step: "code", why: "명시한 동작 구현" }], approach: "순수 함수", conventions: [], conflicts: [], openQuestions: [], reasoning: "테스트 먼저" };
  return { prefix, plan };
}

test("승인한 test→code 순서로 구현하고 실제 테스트·리뷰·통합과 원 요구→Task 보고까지 이어진다", async () => {
  const { prefix, plan } = await preparedPlan();
  const manifest = loadManifestIfAny(repo)!;
  assert.match(sequenceProblems({ ...plan, sequence: [{ step: "unknown", why: "x" }] }, manifest.stages, "feature").join("\n"), /빠졌습니다/);
  assert.match(sequenceProblems({ ...plan, sequence: [plan.sequence[0], plan.sequence[0], plan.sequence[1]] }, manifest.stages, "feature").join("\n"), /중복/);
  assert.match(sequenceProblems({ ...plan, sequence: [{ step: "test", why: " " }, plan.sequence[1]] }, manifest.stages, "feature").join("\n"), /이유가 없습니다/);
  assert.deepEqual(sequenceProblems(plan, manifest.stages, "fix"), []);
  assert.match(sequenceProblems({ ...plan, sequence: [...plan.sequence].reverse() }, manifest.stages, "fix").join("\n"), /테스트 단계/);
  assert.deepEqual(sequenceProblems(plan, manifest.stages, "refactor"), []);
  const path = prefix + "plan.json";
  write(path, JSON.stringify({ ...plan, sequence: [{ step: "unknown", why: "x" }] }));
  assert.throws(() => submitPlan(repo, join(repo, path)), /실행 단계가 아닙니다/);
  write(path, JSON.stringify(plan)); submitPlan(repo, join(repo, path));
  const stored = planFile(repo, "FLOW-1", "value");
  writeFileSync(stored, JSON.stringify({ ...plan, sequence: [{ step: "obsolete", why: "옛 계획" }] }));
  assert.throws(() => next(repo), /실행 순서가 유효하지/);
  submitPlan(repo, join(repo, path)); // 옛 순서가 잘못돼도 수정본 제출은 가능하다.
  let work = loadWork(repo)!;
  recordDecision(repo, { order: work.order, target: work.active.target, plan: work.plan!, manifest: work.manifest, docsHash: approvalDocsHash(work), decision: "approved", approver: "test", presence });
  next(repo);
  assert.equal(loadActive(repo)?.stage, "test");
  assert.match(status(repo), /T1 test: 진행 중/);
  writeFileSync(stored, JSON.stringify({ ...plan, sequence: [...plan.sequence].reverse() }));
  assert.throws(() => next(repo), /계획이 승인되지 않았습니다/);
  assert.equal(loadActive(repo)?.stage, "test");
  writeFileSync(stored, JSON.stringify(plan));
  assert.ok(hook({ cwd: repo, tool_name: "Write", tool_input: { file_path: join(repo, "src/value.js") } }));
  write("tests/value.test.js", "const test=require('node:test'),a=require('node:assert/strict'),v=require('../src/value');\ntest('TC-1',()=>a.equal(v(1),1));\ntest('TC-2',()=>a.throws(()=>v(-1)));\n");
  next(repo);
  assert.equal(loadActive(repo)?.stage, "code");
  write("src/value.js", "module.exports=n=>{if(n<0)throw Error('negative');return 1;};\n");
  next(repo);
  assert.deepEqual(planTasks(plan).map((task) => task.id), ["T1", "T2"]);
  await check(requireValidatable(repo, "check")); next(repo);
  await runTests(requireValidatable(repo, "test")); next(repo);
  openRound(requireValidatable(repo, "review"));
  const reviewPath = reviewDocFile("FLOW-1");
  write(reviewPath, read(reviewPath).replace("## 지적\n", "## 지적\n\n- 없음\n"));
  recordReviewFixture(repo);
  next(repo); await integrate(requireValidatable(repo, "integrate")); next(repo);
  work = loadWork(repo)!;
  assert.deepEqual(deliverProblems(work, "## 요약\n값과 오류 구현\n## 확인 방법\n함수 호출\n## 위험·되돌리기\n테스트 fixture\n"), []);
  const report = renderTraceBlock(work, loadEvidence(repo, "FLOW-1", "value"));
  assert.match(report, /REQ-2.*R2/); assert.match(report, /T1 test/);
  assert.match(status(repo), /검증됨·반영 대기/);
});
