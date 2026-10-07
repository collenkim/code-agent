import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { parseTestResults, resultFor, scanJUnitCases, scanTestResults } from "../agent/testResults";

test("TC 문자열·주석만으로 통과하지 않고 실패·skip·todo·중복 케이스를 구분한다", () => {
  const out = "TC-1 ok\n# TC-1\nok 1 - TC-2 # SKIP\nnot ok 2 - TC-3\nok 3 - TC-4 # TODO\nok 4 - TC-5\nnot ok 5 - TC-5\nok 6 - TC-12";
  const results = parseTestResults(out);
  assert.equal(resultFor("TC-1", results).status, "unknown");
  assert.equal(resultFor("TC-2", results).status, "skipped");
  assert.equal(resultFor("TC-3", results).status, "failed");
  assert.equal(resultFor("TC-4", results).status, "skipped");
  assert.equal(resultFor("TC-5", results).status, "failed");
  assert.equal(resultFor("TC-12", results).status, "passed");
});

test("지원 출력은 케이스별 상태를 보존한다", () => {
  for (const output of ["✔ TC-1 (1ms)", "TC-1 ... ok", "tests/test_x.py::test_TC-1 PASSED [100%]", '{"Action":"pass","Test":"TC-1"}', '{"type":"code-agent-test","id":"TC-1","status":"passed"}']) {
    assert.equal(resultFor("TC-1", parseTestResults(output)).status, "passed", output);
  }
  assert.equal(resultFor("TC-1", parseTestResults("TC-1 ... skipped 'why'")).status, "skipped");
});

test("실제 node:test에서 exit 0인 skip을 성공으로 세지 않는다", () => {
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const output = execFileSync(process.execPath, ["--test-reporter=tap", "-e", "const t=require('node:test');t('TC-1',()=>{});t.skip('TC-2',()=>{throw Error('not run')})"], { encoding: "utf8", env });
  const results = parseTestResults(output);
  assert.equal(resultFor("TC-1", results).status, "passed");
  assert.equal(resultFor("TC-2", results).status, "skipped");
});

test("콘솔 출력의 JUnit XML 은 <?xml 선언이 있는 문서만 읽는다 — 앱 로그에 섞인 조각은 결과가 아니다", () => {
  const fragment = '[app] started\n<testsuite><testcase name="TC-4 sample in log"/></testsuite>';
  assert.equal(resultFor("TC-4", parseTestResults(fragment)).status, "unknown");
  assert.equal(resultFor("TC-4", parseTestResults(`<?xml version="1.0"?>\n${fragment}`)).status, "passed");
});

test("scanTestResults 는 TC id 가 없는 결과 행도 담는다 — 환경 분류가 TC 아닌 실패를 보려고 쓴다", () => {
  const scanned = scanTestResults("not ok 3 - other broken\nok 1 - TC-1\n");
  assert.deepEqual(scanned.map((entry) => [entry.name, entry.status]), [["other broken", "failed"], ["TC-1", "passed"]]);
  assert.deepEqual(scanJUnitCases('<testsuite><testcase name="plain"><failure/></testcase></testsuite>'), [{ name: "plain", status: "failed" }]);
});
