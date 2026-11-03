/* 실행별 원시 보고서는 커밋하지 않는다. 공개 검증 문서는 검토한 요약만 직접 갱신한다. */
const fs = require('node:fs'), path = require('node:path');
function reportDirectory() {
  const configured = process.env.CODE_AGENT_EVAL_REPORT_DIR;
  if (configured && !path.isAbsolute(configured)) throw Error('CODE_AGENT_EVAL_REPORT_DIR must be an absolute path');
  return configured || path.resolve(__dirname, '..', '.code-agent', 'evaluations');
}
function reportFile(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/.test(name)) throw Error('Invalid evaluation report name');
  const dir = reportDirectory();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}
module.exports = { reportDirectory, reportFile };
