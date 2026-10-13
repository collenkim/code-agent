/** 실제 모델을 호출하는 수동 검사. UI·동의·실제 cloud 작업의 검증으로 해석하지 않는다.
 * node scripts/evaluate-question-choices.cjs claude|codex [--recheck]
 * 생성 지침에 따른 응답·질문 호출 검사이며 프로젝트 설치·사용자 답·재개 검사는 아니다.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { hostAssets } = require('../dist/agent/hosts');
const { questionPresentationProblem } = require('../dist/agent/questionPresentation');
const host = process.argv[2];
if (!['claude', 'codex'].includes(host)) throw Error('claude 또는 codex를 지정하세요.');
const root = path.resolve(__dirname, '..');
const recheck = process.argv[3] === '--recheck';
const reportPath = path.join(root, 'dist', `question-choices-live-${host}.json`);
const stdoutPath = path.join(root, 'dist', `question-choices-live-${host}.stdout.jsonl`);
const previous = recheck ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : undefined;
const repo = recheck ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'ca-choice-live-'));
if (repo) cp.execFileSync('git', ['init', '--quiet', repo], { windowsHide: true });
const assets = hostAssets(host);
const prefix = host === 'claude' ? '.claude' : '.agents';
const instructions = ['ca-answer/SKILL.md', 'ca-answer/reference.md', 'ca-docs/SKILL.md', 'ca-request/SKILL.md']
  .map(file => `--- ${file} ---\n${assets.get(`${prefix}/skills/${file}`)}`).join('\n');
const prompt = [
  '실제 사용자에게 보여 줄 다음 응답 하나를 작성하는 격리 회귀 검사입니다. 아래 현행 지침을 따르세요.',
  '파일·셸·하위 에이전트를 호출하지 마세요. 실제 접수·코드 수정·동의 기록을 만들지 마세요. 질문 도구가 제공되지 않으면 그 실행 조건을 정확히 설명하세요.',
  instructions,
  '상황: UZRF-392 같은 오류의 재접수입니다. 최신 원문 저장은 이미 완료됐습니다. 사용자는 소스·설정 기준 작성을 이미 선택했습니다.',
  '미응답은 테스트 기준과 품질 기준입니다. 제안: 테스트는 Maven test와 기본키 충돌 회귀 테스트, 품질은 Maven verify와 변경 범위 정적 검사입니다. 근거는 기존 Maven 구성입니다. 두 기준은 아직 확정하지 않았습니다.',
  '직전 응답은 선택지 없이 “둘 다 기본안 적용”이라고 답하라고만 했습니다. 사용자 최신 메시지: 같은 UZRF-392 오류를 수정해 줘. 다음 사용자 응답을 기다리는 곳까지만 수행하세요.',
].join('\n\n');
const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
let command, args;
if (host === 'claude') {
  command = process.env.CLAUDE_EVALUATION_BIN || path.join(os.homedir(), '.local/bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  args = ['-p', '--output-format', 'json', '--setting-sources', 'project', '--tools', '', '--max-budget-usd', '1'];
} else {
  command = process.platform === 'win32' ? process.execPath : 'codex';
  args = [...(process.platform === 'win32' ? [path.join(process.env.APPDATA, 'npm/node_modules/@openai/codex/bin/codex.js')] : []),
    'exec', '--sandbox', 'read-only', '--json', '-C', repo, '-'];
}
const began = Date.now();
const result = recheck ? { status: previous.exitCode, stdout: fs.readFileSync(stdoutPath, 'utf8'), stderr: previous.stderr }
  : cp.spawnSync(command, args, { cwd: repo, env, input: prompt, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
if (!recheck) fs.writeFileSync(stdoutPath, result.stdout || '');
let reply = '', parseError, events = [], observedQuestions = [];
try {
  if (host === 'claude') reply = JSON.parse(result.stdout).result || '';
  else {
    events = result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    reply = events.filter(row => row.type === 'item.completed' && row.item?.type === 'agent_message').map(row => row.item.text).join('\n');
    // exec --json은 질문을 agent_message로 표시한다. 이번 thread의 실제 기록에서 호출과 결과를 대조한다.
    const thread = events.find(row => row.type === 'thread.started')?.thread_id;
    if (thread && /^[a-f0-9-]+$/.test(thread)) {
      const sessions = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
      const file = fs.readdirSync(sessions, { recursive: true }).find(file => typeof file === 'string' && file.endsWith(`-${thread}.jsonl`));
      if (file) {
        const items = fs.readFileSync(path.join(sessions, file), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
          .filter(row => row.type === 'response_item').map(row => row.payload);
        for (const call of items.filter(row => row.type === 'function_call' && /(?:^|\.)request_user_input_async$/.test(row.name))) {
          const output = items.find(row => row.type === 'function_call_output' && row.call_id === call.call_id);
          if (output && JSON.parse(output.output).accepted === true) observedQuestions.push(...JSON.parse(call.arguments).questions);
        }
      }
    }
  }
} catch (error) { parseError = error.message; }
const observed = observedQuestions.length === 2 && /테스트/.test(observedQuestions[0].title) && /품질/.test(observedQuestions[1].title) && observedQuestions.every(question =>
  ['제안 기준 사용', '항목 수정', '보류'].every(label => question.options?.some(option => option.startsWith(label))));
const report = {
  host, at: previous?.at || new Date().toISOString(), exitCode: result.status, error: result.error?.code, parseError,
  durationMs: previous?.durationMs ?? Date.now() - began, scope: '생성 지침을 제공한 실제 모델 응답·질문 호출 기록. UI 표시·사용자 답·프로젝트 훅·cloud 설치본 검증 아님.',
  checks: {
    reply: !!reply,
    independentCriteria: /테스트/.test(reply) && /품질/.test(reply),
    alternativesForBoth: (reply.match(/제안 기준 사용/g) || []).length >= 2 && (reply.match(/항목 수정/g) || []).length >= 2 && (reply.match(/보류/g) || []).length >= 2,
    toolOrNumberedChoices: observed || (reply.match(/^\s*(?:\*\*)?\d+[.)]\s+/gm) || []).length >= 6,
    noBareLiteralRequest: !!reply && !questionPresentationProblem(reply),
    toolOrLimitationExplained: observed || /도구[^\n]*(?:없|제공되지|사용할 수 없|지원하지)|(?:없|제공되지|사용할 수 없)[^\n]*도구/.test(reply),
  }, observedQuestions, reply, stderr: result.stderr || '',
};
report.passed = result.status === 0 && !parseError && Object.values(report.checks).every(Boolean);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ host, passed: report.passed, checks: report.checks, error: report.error, durationMs: report.durationMs }));
// 호스트가 남긴 검사 디렉터리는 증거 확인용으로 유지한다. 사용자 설정은 변경하지 않는다.
if (!report.passed) process.exitCode = 1;
