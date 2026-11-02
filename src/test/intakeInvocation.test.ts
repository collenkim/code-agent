import assert from "node:assert/strict";
import { test } from "node:test";
import { intakeTrace } from "../agent/intakeTrace";

const request = { title: "값", background: "", requirements: ["값 1을 반환한다."], done: [], constraints: [], outOfScope: [] };
test("호스트별 독립 호출 줄만 추적에서 분리하고 원문에 표시한다", () => {
  for (const command of ["$ca-request", "/ca-request"]) {
    const original = `${command}\n값 1을 반환한다.`;
    const result = intakeTrace(original, request);
    assert.equal(result.missing, "");
    assert.match(result.text, /호출 표식.*원문 보존/);
    assert.ok(result.text.includes(command));
    assert.equal(original, `${command}\n값 1을 반환한다.`);
  }
});
test("한 줄의 호출은 명시적으로 구분하고 업무 문장·인용·다른 표식은 자동 제외하지 않는다", () => {
  const original = "$ca-request 값 1을 반환한다.";
  assert.equal(intakeTrace(original, request).missing, "$ca-request");
  const sourceMap = [{ quote: "$ca-request", targets: ["INVOCATION"] }, { quote: "값 1을 반환한다.", targets: ["REQ-1"] }];
  assert.equal(intakeTrace(original, { ...request, sourceMap }).missing, "");
  assert.deepEqual(intakeTrace(original, { ...request, sourceMap }).problems, []);
  assert.equal(intakeTrace(`${original} $ca-request`, { ...request, sourceMap }).missing, "$ca-request", "호출 연결은 뒤의 업무 문자열을 덮지 않는다");
  for (const body of ["화면에 $ca-request 표시", "`$ca-request`\n값 1을 반환한다.", "$ca-request를 표시", "$ca-request-extra\n값 1을 반환한다."]) {
    assert.ok(intakeTrace(body, request).missing.includes("$ca-request"));
    assert.ok(intakeTrace(body, { ...request, sourceMap }).problems.length);
  }
  assert.ok(intakeTrace(original, { ...request, sourceMap: [{ quote: original, targets: ["INVOCATION"] }] }).problems.length);
});
