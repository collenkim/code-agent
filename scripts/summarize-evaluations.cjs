/* 반복 평가 실행 요약 — doc/reviews/evidence/full-flow-<scenario>-<label 접두어>*.json 을 읽어 지표별 n·평균·최소·최대를 출력한다.
 * 사용: node scripts/summarize-evaluations.cjs <new|enhance|fix|refactor> <label 접두어>
 * 예: 조건별 3회(--label opt-r1·opt-r2·opt-r3)를 evaluate-full-flow.cjs 로 돌린 뒤 `node scripts/summarize-evaluations.cjs new opt-r`.
 * 파일을 쓰지 않는다. 모델을 부르지 않는다. usageData 가 없는 이전 보고서는 그 지표를 빼고 센다.
 */
const fs = require('node:fs'), path = require('node:path');
const [scenario, prefix] = process.argv.slice(2);
if (!['new', 'enhance', 'fix', 'refactor'].includes(scenario) || !prefix || !/^[\w.-]+$/.test(prefix)) {
  console.error('사용법: node scripts/summarize-evaluations.cjs <new|enhance|fix|refactor> <label 접두어>');
  process.exit(1);
}
const dir = path.resolve(__dirname, '..', 'doc/reviews/evidence');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.startsWith(`full-flow-${scenario}-${prefix}`) && name.endsWith('.json')).sort() : [];
if (!files.length) { console.log(`${dir} 에 full-flow-${scenario}-${prefix}*.json 이 없습니다.`); process.exit(0); }
const reports = files.map(name => ({ name, report: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) }));
const claudeSection = report => report.usageData?.sections?.find(section => section.source === 'claude');
const mainRow = report => claudeSection(report)?.agents?.find(row => row.label === 'main');
const total = rows => rows?.reduce((sum, row) => ({ requests: sum.requests + row.calls.requests, toolCalls: sum.toolCalls + row.calls.toolCalls, toolResultChars: sum.toolResultChars + row.calls.toolResultChars }), { requests: 0, toolCalls: 0, toolResultChars: 0 });
const METRICS = [
  ['비용(USD, 보고값)', report => report.reportedCostUSD],
  ['소요(초)', report => typeof report.durationMs === 'number' ? report.durationMs / 1000 : undefined],
  ['턴 수(모델 num_turns 합)', report => report.turns?.some(turn => typeof turn.numTurns === 'number') ? report.turns.reduce((sum, turn) => sum + (turn.numTurns ?? 0), 0) : undefined],
  ['메인 요청', report => mainRow(report)?.calls.requests],
  ['메인 도구 호출', report => mainRow(report)?.calls.toolCalls],
  ['메인 도구 결과(자)', report => mainRow(report)?.calls.toolResultChars],
  ['전체 요청', report => total(claudeSection(report)?.agents)?.requests],
  ['전체 도구 호출', report => total(claudeSection(report)?.agents)?.toolCalls],
  ['재배정 합', report => Array.isArray(report.retry) ? report.retry.reduce((sum, row) => sum + (row.reassignments ?? 0), 0) : undefined],
  ['code-agent next 호출', report => claudeSection(report)?.commands?.next],
  ['code-agent status 호출', report => claudeSection(report)?.commands?.status],
  ['ca-answer 읽기', report => claudeSection(report)?.skillReads?.['ca-answer/SKILL.md']],
];
const fmt = value => Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(2);
console.log(`${scenario} · ${prefix}* · 보고서 ${reports.length}개 (끝까지 간 것 ${reports.filter(item => item.report.finished).length})`);
console.log(['지표', 'n', '평균', '최소', '최대'].join('\t'));
for (const [label, read] of METRICS) {
  const values = reports.map(item => read(item.report)).filter(value => typeof value === 'number' && Number.isFinite(value));
  if (!values.length) { console.log([label, 0, '-', '-', '-'].join('\t')); continue; }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  console.log([label, values.length, fmt(mean), fmt(Math.min(...values)), fmt(Math.max(...values))].join('\t'));
}
