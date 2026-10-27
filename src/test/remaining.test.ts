import { writeFixture as writeRepoFile } from "./repoFixture";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { setupBaseline, setupStatus } from "../agent/bootstrap";
import { docsBegin, docsEnd } from "../agent/docsCommands";
import { setupProject } from "../agent/setup";
import { requestBegin, requestSubmit, decideRequest } from "../agent/request";
import { intakeTrace } from "../agent/intakeTrace";
import { parseQuestions } from "../agent/questions";
import { freshTestReports, reportSnapshot } from "../agent/testReports";
import type { ReportScan } from "../agent/testReports";
import { environmentMatch } from "../agent/retryPolicy";
import { parseTestResults, resultFor } from "../agent/testResults";
import { decide } from "../agent/hook";
import * as tty from "../agent/tty";

let root: string;
function write(file: string, body: string) { writeRepoFile(root, file, body); }
function git(...args: string[]) { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim(); }
const presence = { channel: "tty" as const, verified: true, detail: "automated fixture, not a human" };
beforeEach(() => { root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-remaining-"))); });
afterEach(() => { mock.restoreAll(); rmSync(root, { recursive: true, force: true }); });

test("초기 준비는 기존 명령을 보여주며 테스트를 실행하지 않고 기준 파일만 확인 후 커밋한다", () => {
  git("init", "-q", "-b", "master"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.invalid");
  docsBegin(root); setupProject(root, "node"); docsEnd(root);
  write("src/untouched.js", "throw Error('do not run at setup')");
  write("doc/work/X/raw.txt", "private draft");
  const manifest = JSON.parse(readFileSync(join(root, "code-agent.json"), "utf8"));
  manifest.test = ["node", "-e", "require('fs').writeFileSync('TEST_RAN', 'bad')"];
  write("code-agent.json", JSON.stringify(manifest));
  assert.match(setupStatus(root), /기존 언어·도구 유지/);
  assert.match(setupStatus(root), /실행 환경: node 확인됨/);
  assert.equal(existsSync(join(root, "TEST_RAN")), false);
  assert.throws(() => setupBaseline(root), /TTY/);
  let shown = "";
  mock.method(tty, "confirmOnTerminal", (text: string) => { shown = text; return presence; });
  assert.match(setupBaseline(root), /최초 기준 커밋/);
  assert.match(shown, /code-agent.json/);
  const committed = git("ls-tree", "-r", "--name-only", "HEAD");
  assert.doesNotMatch(committed, /untouched|raw.txt/);
  assert.equal(existsSync(join(root, "TEST_RAN")), false);
  assert.match(setupBaseline(root), /이미 있습니다/);
});

test("초기 기준 확인 중 파일이 바뀌면 커밋하지 않고 기존 index도 덮지 않는다", () => {
  git("init", "-q", "-b", "master");
  docsBegin(root); setupProject(root, "node"); docsEnd(root);
  mock.method(tty, "confirmOnTerminal", () => { write("doc/architecture.md", "changed"); return presence; });
  assert.throws(() => setupBaseline(root), /확인 중 준비 파일/);
  assert.equal(git("diff", "--cached", "--name-only"), "");
  git("add", "code-agent.json");
  assert.throws(() => setupBaseline(root), /이미 스테이징/);
});

test("모델은 준비 상태만 조회하고 최초 커밋은 실행할 수 없다", () => {
  docsBegin(root); setupProject(root, "node");
  assert.equal(decide({ cwd: root, tool_name: "Bash", tool_input: { command: "code-agent setup" } }), undefined);
  assert.ok(decide({ cwd: root, tool_name: "Bash", tool_input: { command: "code-agent setup baseline" } }));
});

test("주석과 구분선뿐인 답은 미응답이며 실제 여러 줄 답은 유지한다", () => {
  for (const body of ["<!-- waiting -->", "<!--\nwaiting\n-->", "---", "* * *", "<!-- waiting -->\n___"]) {
    assert.equal(parseQuestions(`## Q1\nQuestion\n[Answer]:\n${body}`)[0].answer, "");
  }
  assert.equal(parseQuestions("## Q1\nQuestion\n[Answer]: first\nsecond\n<!-- note -->")[0].answer, "first\nsecond");
});

test("원문의 권한 조건 누락을 확정 전에 드러내고 명시적 반영·제외를 연결한다", () => {
  const original = "Export CSV. Restrict export to admins.";
  const request = { title: "Export", background: "", requirements: ["Export CSV."], done: [], constraints: [], outOfScope: [] };
  assert.equal(intakeTrace(original, request).missing, "Restrict export to admins.");
  const full = { ...request, constraints: ["Admins only."], sourceMap: [{ quote: "Export CSV.", targets: ["REQ-1"] }, { quote: "Restrict export to admins.", targets: ["CON-1"] }] };
  assert.equal(intakeTrace(original, full).missing, "");
  assert.match(intakeTrace(original, { ...full, sourceMap: [{ quote: "Invented", targets: ["REQ-99"] }] }).problems.join("\n"), /원문에 없는 인용/);
  docsBegin(root); setupProject(root, "node"); docsEnd(root);
  requestBegin(root, "TRACE-1", "feature");
  const draft = "doc/work/TRACE-1/request.json";
  write(draft, JSON.stringify({ ...request, original, id: "TRACE-1", kind: "feature", target: ["export"] }));
  requestSubmit(root, join(root, draft));
  assert.throws(() => decideRequest(root, "TRACE-1", "confirmed"), /원문 대조에 미연결/);
  write(draft, JSON.stringify({ ...full, original, id: "TRACE-1", kind: "feature", target: ["export"] }));
  requestSubmit(root, join(root, draft));
  mock.method(tty, "confirmOnTerminal", () => presence);
  assert.match(decideRequest(root, "TRACE-1", "confirmed"), /확정했습니다/);
});

test("기존 JUnit 결과의 성공·실패·생략과 오래된 보고서를 구분한다", () => {
  const file = "module/build/test-results/test/TEST-value.xml";
  const report = '<testsuite><testcase name="TC-1 ok"/><testcase name="TC-2 bad"><failure>bad</failure></testcase><testcase name="TC-3 skip"><skipped/></testcase></testsuite>';
  write(file, report);
  const old = reportSnapshot(root);
  assert.equal(freshTestReports(root, old), "");
  write("module/target/surefire-reports/TEST-new.xml", report);
  const results = parseTestResults(freshTestReports(root, old));
  assert.deepEqual(["TC-1", "TC-2", "TC-3"].map(id => resultFor(id, results).status), ["passed", "failed", "skipped"]);
  // 콘솔 JUnit 은 <?xml 선언이 있을 때만 읽는다 — 선언을 붙여야 아래 두 방어(DOCTYPE·ENTITY 거부, CDATA 제거)가 실제로 결과를 막는지 본다
  const declared = (xml: string) => `<?xml version="1.0"?>
${xml}`;
  assert.equal(resultFor("TC-1", parseTestResults(declared('<testsuite><testcase name="TC-1"/></testsuite>'))).status, "passed", "대조군 — 선언이 있으면 읽는다");
  assert.equal(resultFor("TC-1", parseTestResults(declared('<!DOCTYPE x SYSTEM "file:///secret"><testsuite><testcase name="TC-1"/></testsuite>'))).status, "unknown");
  assert.equal(resultFor("TC-1", parseTestResults(declared('<!ENTITY x "y"><testsuite><testcase name="TC-1"/></testsuite>'))).status, "unknown");
  assert.equal(resultFor("TC-1", parseTestResults(declared('<testsuite><system-out><![CDATA[<testcase name="TC-1"/>]]></system-out></testsuite>'))).status, "unknown");
  assert.equal(resultFor("TC-1", parseTestResults('<testsuite><testcase name="TC-1"/></testsuite>')).status, "unknown", "선언 없는 콘솔 조각은 읽지 않는다");
});

test("보고서 탐색이 깊이 12 를 넘겨 끊기면 기록에 남긴다", () => {
  const deep = Array.from({ length: 14 }, (_, index) => `d${index}`).join("/");
  write(`${deep}/build/test-results/TEST-deep.xml`, '<testsuite><testcase name="TC-1"/></testsuite>');
  const scan: ReportScan = { truncated: false, cases: [] };
  assert.equal(reportSnapshot(root, scan).size, 0, "깊이 14 아래 보고서는 찾지 못한다");
  assert.equal(scan.truncated, true);
  const shallow: ReportScan = { truncated: false, cases: [] };
  reportSnapshot(join(root, "d0"), shallow);
  assert.equal(shallow.truncated, true, "깊이 13 디렉터리도 들어가지 못했다");
});

test("새 보고서의 TC 아닌 실패도 탐색 기록에 담겨 환경 분류를 막는다 — 반환 JSONL 은 TC 만이다", () => {
  const old = reportSnapshot(root);
  write("build/test-results/test/TEST-x.xml", '<testsuite><testcase name="TC-1 ok"/><testcase name="other broken"><failure>x</failure></testcase></testsuite>');
  const scan: ReportScan = { truncated: false, cases: [] };
  const jsonl = freshTestReports(root, old, scan);
  assert.deepEqual(jsonl.split("\n").map((line) => JSON.parse(line).id), ["TC-1"]);
  assert.ok(scan.cases.some((entry) => entry.name === "other broken" && entry.status === "failed"));
  assert.equal(environmentMatch("Connection refused", ["Connection refused"], scan.cases), undefined);
});
