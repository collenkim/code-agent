// Historical probes from BEFORE the remaining-work corrections on 2026-10-01.
// remaining-work-probes.json preserves that run. These assertions intentionally describe
// the old defects and are not the current regression suite (see src/test/remaining.test.ts).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseQuestions } = require('../../../dist/agent/questions.js');
const { parseTestResults, resultFor } = require('../../../dist/agent/testResults.js');
const { sourceTrace } = require('../../../dist/agent/sourceTrace.js');

const questions = Object.entries({
  empty: '', commentOnly: '<!-- waiting for user -->', separatorOnly: '---', actualAnswer: 'A',
}).map(([inputKind, suffix]) => {
  const question = parseQuestions(`## Q1\nQuestion\n[Answer]:\n${suffix}`)[0];
  return { inputKind, parsedAnswer: question.answer, treatedAsUnanswered: question.answer === '' };
});
assert.deepEqual(questions.map(q => q.treatedAsUnanswered), [true, false, false, false]);

const formats = Object.entries({
  junitXml: '<testsuite tests="1"><testcase name="TC-1"/></testsuite>',
  summaryOnly: 'BUILD SUCCESSFUL\n1 test completed',
  tap: 'ok 1 - TC-1',
}).map(([inputKind, output]) => ({ inputKind, ...resultFor('TC-1', parseTestResults(output)) }));
assert.deepEqual(formats.map(f => f.status), ['unknown', 'unknown', 'passed']);

const trace = sourceTrace(
  '## 원문\nExport CSV and restrict export to admins.\n\n## 요구 내용\n- [REQ-1] Export CSV.\n',
  '## R1\n출처: REQ-1\n근거: Export CSV.\n',
);
assert.equal(trace.problems.length, 0);
assert.equal(trace.rows.length, 1);

const result = {
  date: '2026-10-01',
  scope: 'Parser probes only; no real Gradle/Maven execution, model run, or end-to-end gate run.',
  questions, formats,
  originalToStructured: { omittedFromStructured: 'restrict export to admins', problems: trace.problems, rows: trace.rows },
};
fs.writeFileSync(path.join(__dirname, 'remaining-work-probes.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
