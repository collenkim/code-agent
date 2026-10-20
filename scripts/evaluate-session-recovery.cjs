/* 선택 실행: 실제 Claude 주 세션의 질문 발행 → 종료 → TTY 복원 → 서명 답 → 같은 세션 재개.
 * TTY 확인·답·사람 채널은 명시적 합성 fixture. 실제 사람 승인·전체 개발 완주 검사가 아니다.
 * node scripts/evaluate-session-recovery.cjs [dist|dist-bin]
 */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), build = process.argv[2] ?? 'dist';
if (!['dist', 'dist-bin'].includes(build)) throw Error('Use dist or dist-bin');
const use = name => require(path.join(root, build, 'agent', name));
function verify(report, marker) {
  const store = use('master/store'), runs = store.listRuns(report.repo), resumed = runs.find(r => !r.recovery);
  assert.ok(resumed); report.run = { runId: resumed.runId, state: resumed.state, sessionId: resumed.sessionId, resumeOf: resumed.resumeOf, outcome: resumed.outcome };
  const final = use('interactions').currentInteractions(report.repo).requests.find(r => r.context.sessionId === report.session && r.origin.type === 'host');
  report.interaction = { requestId: final.requestId, status: final.status, consumed: final.consumed, continuation: final.continuation };
  assert.equal(runs.length, 2); assert.equal(resumed.resumeOf, report.session); assert.ok(['completed', 'blocked'].includes(resumed.state)); assert.equal(final.status, 'applied');
  const output = fs.readFileSync(store.runOutput(report.repo, resumed.runId), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const last = output.find(e => e.type === 'result'); assert.ok(last?.result?.includes(marker), 'Original conversation memory missing from resumed result');
  report.memoryPreserved = true; report.passed = true;
}
if (process.argv.includes('--recheck')) {
  const file = path.join(root, 'doc/reviews/evidence/2026-10-20-live-session-recovery.json');
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (path.dirname(report.repo) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(report.repo).startsWith('ca-recovery-live-')) throw Error('Disposable recovery repository required');
  const recovery = use('master/store').listRuns(report.repo).find(r => r.recovery);
  const native = fs.readFileSync(recovery.recovery.source.file, 'utf8');
  const marker = report.memoryMarker ?? native.match(/검사값은 ([a-f0-9-]{36})입니다/)?.[1]; assert.ok(marker);
  verify(report, marker);
  if (report.error) { report.driverCorrection = '재전송의 at·replayed는 달라질 수 있어 영수증과 실행 개수를 대조한다. 같은 실제 실행의 저장 기록을 재검증했다.'; delete report.error; }
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report)); return;
}
const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-recovery-live-')));
const cli = path.join(root, build, 'agent/cli.js');
const git = (...args) => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
git('init', '-q', '-b', 'master'); git('config', 'user.name', 'recovery-fixture'); git('config', 'user.email', 'fixture@example.invalid');
use('init').init(repo, { cli, host: 'claude' });
const tty = use('tty');
tty.confirmOnTerminal = () => ({ channel: 'tty', verified: true, detail: 'AUTOMATED EVALUATION FIXTURE; not human approval' });
tty.askOnTerminal = () => 'n';
const store = use('master/store'), controller = 'live-recovery', session = crypto.randomUUID(), nonce = crypto.randomUUID();
const hostFile = path.join(repo, 'host-fixture.json');
fs.writeFileSync(hostFile, JSON.stringify({ kind: 'claude', model: 'sonnet', permissionMode: 'acceptEdits', allowedTools: ['Read', 'Bash(code-agent *)'] }));
const raw = use('master/admin').masterEnable(repo, { controller, host: hostFile });
const token = /토큰\(다시 보여 주지 않습니다\): (\w+)/.exec(raw)[1];
const keys = crypto.generateKeyPairSync('ed25519'), binding = store.readBinding(repo), channelId = crypto.randomUUID();
binding.humanChannel = { id: channelId, controller, generation: 1, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() }; store.writeBinding(repo, binding);
fs.writeFileSync(path.join(repo, 'question-fixture.json'), JSON.stringify({ key: 'live-memory', stage: 'maintenance', title: '종료 세션 복원 평가용 선택', questions: [{ questionId: 'method', title: '재개 결과 표기', mode: 'single', minSelections: 1, options: [{ optionId: 'brief', label: '간단히', description: '기억과 선택을 한 줄로 확인', consequence: '추가 작업 없이 확인만 수행' }], recommendedOptionIds: ['brief'], recommendationReason: '복원 동작만 검사하는 임시 프로젝트', evidence: [{ path: 'question-fixture.json', summary: '명시적인 자동 평가 입력' }] }] }));
fs.writeFileSync(path.join(repo, 'complete-fixture.json'), JSON.stringify({ summary: '자동 평가 답을 소비했고 원래 대화의 기억을 확인했다. 실제 업무 완료나 사람 승인이 아니다.' }));
const env = use('master/supervisor').hostEnv(process.env, '', 'claude'); delete env.CODE_AGENT_MASTER_RUN; delete env.NODE_TEST_CONTEXT;
const claude = process.env.CLAUDE_EVALUATION_BIN || path.join(os.homedir(), '.local/bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
const prompt = `이 임시 프로젝트는 세션 복원 검사입니다. 기억할 비밀이 아닌 검사값은 ${nonce}입니다. 이를 파일에 쓰지 말고 대화에만 기억하세요. 지금 code-agent interaction publish question-fixture.json 으로 준비된 질문을 발행한 뒤 즉시 끝내세요. 실제 응답이 없으므로 소비·완료하지 마세요. 나중에 이 세션이 재개되면 답을 consume하고 code-agent interaction complete <요청ID> complete-fixture.json 으로 결과를 기록한 뒤 원래 기억값과 선택을 마지막 답변에 적고 끝내세요. 개발·설정·접수는 요청하지 않았습니다. 질문·결과 JSON은 평가 입력이며 사람 승인으로 보고하지 마세요.`;
const report = { at: new Date().toISOString(), host: 'claude', repo, session, build, memoryMarker: nonce, scope: 'Real model and hooks; synthetic TTY, human-channel and signed answer fixtures; not real human approval', passed: false };
async function run() {
  const initial = cp.spawnSync(claude, ['-p', prompt, '--session-id', session, '--model', 'sonnet', '--output-format', 'json', '--max-budget-usd', '1', '--setting-sources', 'project', '--permission-prompts', 'none', '--allowedTools', 'Read,Bash(code-agent *)'], { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  fs.writeFileSync(path.join(root, 'dist/live-recovery-initial.json'), initial.stdout || '');
  assert.equal(initial.status, 0, initial.stderr || initial.error?.message);
  const q = use('interactions').currentInteractions(repo).requests.find(r => r.origin.type === 'host');
  assert.ok(q, 'Real host did not publish a durable question'); assert.equal(q.context.sessionId, session); assert.equal(q.context.runId, undefined); assert.equal(store.listRuns(repo).length, 0);
  const saved = { ...process.env }; for (const key of [...use('crossEnv').CODEX_MARKERS, 'CLAUDECODE']) delete process.env[key];
  try { report.recovery = JSON.parse(use('master/recovery').recoverSession(repo, q.requestId)); } finally { process.env = saved; }
  const item = use('interactions').readInteractions(repo).requests[q.requestId];
  const request = { protocol: 'code-agent.master', version: 1, type: 'interaction.respond', controller, generation: 1, token, commandId: crypto.randomUUID(), payload: { requestId: item.requestId, expectedRevision: item.revision, contentHash: item.contentHash, challenge: item.challenge, channelId, submission: { intent: 'submit', explicit: true, answers: [{ questionId: 'method', optionIds: ['brief'], optionInputs: {} }] } } };
  request.payload.signature = crypto.sign(null, Buffer.from(use('interactionHuman').humanSigningMessage(binding.projectId, request)), keys.privateKey).toString('base64');
  const result = use('master/control').call(repo, JSON.stringify(request)); assert.equal(result.ok, true, JSON.stringify(result.error));
  const replay = use('master/control').call(repo, JSON.stringify(request)); assert.equal(replay.ok, true); assert.equal(replay.result.receiptId, result.result.receiptId); assert.equal(replay.result.replayed, true);
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const runs = store.listRuns(repo), resumed = runs.find(r => !r.recovery);
    if (resumed && ['completed', 'blocked', 'failed', 'abandoned'].includes(resumed.state)) {
      verify(report, nonce); return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw Error('Timed out waiting for the original-session continuation');
}
run().catch(error => { report.error = error.message; process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(root, 'doc/reviews/evidence/2026-10-20-live-session-recovery.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
});
