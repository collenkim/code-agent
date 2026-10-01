/* Opt-in live evaluation from intake through local delivery in disposable repositories.
 * Only TTY interaction is mocked by this driver; every such decision is labelled as a fixture.
 * Never claims to measure a real beginner or human approval. No push or external publication.
 * Usage: node scripts/evaluate-full-flow.cjs run|resume <new|enhance|fix|refactor>
 */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const use = name => require(path.join(root, 'dist', name));
const { init } = use('agent/init');
const { docsBegin, docsEnd, confirmDoc } = use('agent/docsCommands');
const { setupProject } = use('agent/setup');
const { hasBaseline, setupBaseline } = use('agent/bootstrap');
const { checkProjectDocs } = use('agent/docs');
const { loadManifestIfAny, loadWork } = use('agent/work');
const { loadActive } = use('agent/layout');
const { loadRequestSession, requestState, decideRequest } = use('agent/request');
const { decide, requireValidatable } = use('agent/commands');
const { deliver } = use('agent/deliver');
const { loadEvidence } = use('agent/evidence');
const { loadReview } = use('agent/review');
const { parseQuestions } = use('agent/questions');
const tty = use('agent/tty');
const scenario = process.argv[3], resume = process.argv[2] === 'resume';
if (!['run','resume'].includes(process.argv[2]) || !['new', 'enhance', 'fix', 'refactor'].includes(scenario)) throw Error('Use run|resume <new|enhance|fix|refactor>');
const reportPath = path.join(root, 'doc/reviews/evidence', `full-flow-${scenario}-2026-10-01.json`);
const previous = resume ? JSON.parse(fs.readFileSync(reportPath,'utf8')) : undefined;
if (previous?.finished) throw Error('Scenario already completed; preserve the recorded result.');
const repo = resume ? fs.realpathSync.native(previous.repo) : fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `ca-full-${scenario}-`)));
if (resume && (path.dirname(repo) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(repo).startsWith(`ca-full-${scenario}-`))) throw Error('Resume is limited to the disposable evaluation repository.');
const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
const git = (...args) => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
if (!resume) {
git('init', '-q', '-b', 'master'); git('config', 'user.name', 'evaluation-fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
init(repo, { cli: path.join(root, 'dist/agent/cli.js') });
}
for (const file of fs.readdirSync(path.join(repo, '.claude/agents'))) {
  const full = path.join(repo, '.claude/agents', file);
  fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace(/^model: .+$/m, 'model: sonnet'));
}
const correct = "module.exports=function value(n){if(n<0)throw Error('negative');return 1;};\n";
const tests = "const test=require('node:test'),assert=require('node:assert/strict'),value=require('../src/value');test('TC-1 nonnegative',()=>{assert.equal(value(0),1);assert.equal(value(2),1);});test('TC-2 negative',()=>assert.throws(()=>value(-1),/negative/));\n";
if (!resume && scenario !== 'new') {
  docsBegin(repo); setupProject(repo, 'node'); docsEnd(repo);
  write('src/value.js', scenario === 'fix' ? "module.exports=function value(n){if(n<0)throw Error('negative');return 0;};\n" : scenario === 'enhance' ? "module.exports=function value(n){return 1;};\n" : "module.exports=function value(n){if(n<0)throw Error('negative');if(n===0)return 1;else return 1;};\n");
  write('tests/value.test.js', scenario === 'refactor' ? tests : "const test=require('node:test'),assert=require('node:assert/strict'),value=require('../src/value');test('existing negative',()=>assert.equal(typeof value,'function'));\n");
  git('add', '.'); git('commit', '-qm', 'evaluation baseline');
}
const approvals = previous?.approvals || [], turns = previous?.turns || [], started = Date.now();
tty.confirmOnTerminal = (_shown, word) => { approvals.push({ word, kind: 'automated TTY fixture; not human', at: new Date().toISOString() }); return { channel: 'tty', verified: true, detail: 'AUTOMATED EVALUATION FIXTURE — not a human approval' }; };
tty.askOnTerminal = () => 'n'; // Optional knowledge promotion is not part of this small scenario.
const claude = process.env.CLAUDE_EVALUATION_BIN || path.join(os.homedir(), '.local/bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
const requests = {
  new: '신규: Node.js와 기존 추천의 node:test로 src/value.js를 만들어 주세요. CommonJS로 value(n) 함수 하나를 export합니다. 숫자 n이 0 이상이면 1을 반환하고, 음수면 Error("negative")를 던져야 합니다. 외부 패키지·웹서버·DB는 필요 없습니다. tests/value.test.js와 실행 안내도 작성해 주세요.',
  enhance: '기능 개선: src/value.js의 value(n)에 음수 입력 시 Error("negative")를 던지는 기능을 추가해 주세요. 0 이상이면 1 반환, CommonJS 함수 export와 함수 시그니처는 유지합니다. tests/value.test.js에서 0, 2, -1을 검증해 주세요. 기존 Node.js·node:test를 유지합니다.',
  fix: '버그 수정: src/value.js의 value(n)이 0 이상에서 0을 반환하는 결함을 고쳐 주세요. 기대는 1 반환입니다. 음수에서 Error("negative"), CommonJS 함수 export와 함수 시그니처는 유지합니다. 변경 범위는 src/value.js와 tests/value.test.js입니다. 0, 2, -1을 검증하고 수정 전에 0 입력의 실패를 재현해 주세요. 기존 Node.js·node:test를 유지합니다.',
  refactor: '리팩토링: src/value.js에서 value(n)의 중복 반환 분기만 제거해 주세요. 동작은 0 이상이면 1, 음수면 Error("negative")입니다. CommonJS export와 함수 시그니처, tests/value.test.js의 기존 테스트를 그대로 보존합니다. 변경 범위는 src/value.js뿐입니다. 기존 Node.js·node:test를 유지합니다.',
};
let finished = false, lastWork, blocked, cost = previous?.reportedCostUSD || 0;
const startingTurn = turns.length, costLimit = cost + 5;
function fixtureActions() {
  const manifest = loadManifestIfAny(repo);
  if (manifest) {
    const docs = checkProjectDocs(repo, manifest);
    if (docs.every(d => d.state === 'unconfirmed' || d.state === 'confirmed') && docs.some(d => d.state === 'unconfirmed')) confirmDoc(repo, 'all');
    if (!hasBaseline(repo)) setupBaseline(repo);
  }
  const session = loadRequestSession(repo);
  if (session) {
    const spec = `doc/work/${session.id}/requirement.md`;
    if (fs.existsSync(path.join(repo, spec)) && requestState(repo, session.id, spec).status !== 'confirmed') decideRequest(repo, session.id, 'confirmed');
  }
  const active = loadActive(repo);
  if (active?.phase === 'plan') decide(repo, 'approved');
  if (active?.phase === 'deliver') {
    lastWork = loadWork(repo);
    deliver(requireValidatable(repo, 'deliver'));
    finished = true;
  }
}
for (let turn = startingTurn; turn < startingTurn + 8 && !finished && cost < costLimit; turn++) {
  const prompt = turn === 0
    ? `이 저장소는 실제 모델 프로세스 평가용 임시 저장소입니다. 사용자 요청: ${requests[scenario]}\n/ca-request부터 원문 접수·공통 문서 준비·분석·계획·구현·검증·독립 리뷰·반영 대기까지 ca-next 절차대로 진행하세요. 단계별로 멈추지 말고 사람 판정 또는 필수 미답 질문에서만 멈추세요. 승인·최초 커밋·deliver는 호출하지 마세요. 평가 드라이버가 별도로 명시적인 테스트용 TTY fixture로 처리하며 실제 사람의 승인으로 보고하지 않습니다. 원문 내용은 임의로 줄이지 말고 sourceMap을 완성하세요. 내부 기술 선택은 기존 구성으로 정하고 업무 질문만 남기세요. Bash는 code-agent 명령만 사용합니다.`
    : '평가 드라이버가 가능한 문서·요구사항·계획 확인을 테스트용 TTY fixture로 처리했습니다. 실제 사람 승인으로 보고하지 마세요. code-agent status로 현재 상태를 읽고 ca-next 절차를 이어가세요. 독립 ca-reviewer 호출과 실제 검증을 수행하고 deliver 대기에서 멈추세요. 원문 미연결·문서 형식 문제는 기존 요청에 근거해 보완하세요.';
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const argv = ['-p', prompt, ...(turn ? ['--continue'] : []), '--model', 'sonnet', '--max-budget-usd', String(Math.min(1.5, costLimit - cost)), '--output-format', 'json', '--setting-sources', 'project', '--permission-prompts', 'none', '--allowedTools', 'Read,Edit,Write,Grep,Glob,Agent,Skill,Bash(code-agent *)'];
  const result = cp.spawnSync(claude, argv, { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout:600000, maxBuffer:12*1024*1024 });
  fs.writeFileSync(path.join(root, 'dist', `full-${scenario}-${turn}.json`), result.stdout || '');
  let model;
  try { model = JSON.parse(result.stdout); } catch { blocked = result.error?.message || result.stderr || 'Model returned no JSON'; break; }
  cost += model.total_cost_usd || 0;
  const record = { turn:turn + 1, exitCode:result.status, durationMs:model.duration_ms, reportedCostUSD:model.total_cost_usd, modelError:!!model.is_error, phase:loadActive(repo)?.phase || 'request', result:model.result };
  turns.push(record);
  try { fixtureActions(); blocked = undefined; } catch (error) { record.fixtureBlocked = error.message; blocked = error.message; }
  console.log(JSON.stringify({ scenario, turn:turn + 1, phase:loadActive(repo)?.phase, finished, cost, blocked }));
  if (model.is_error) break;
}
const work = lastWork || loadWork(repo);
const session = loadRequestSession(repo);
const id = work?.active.id || session?.id;
const questionFile = id && path.join(repo, `doc/work/${id}/questions.md`);
const questions = questionFile && fs.existsSync(questionFile) ? parseQuestions(fs.readFileSync(questionFile, 'utf8')) : [];
const evidence = work && loadEvidence(repo, id, work.active.target);
const review = work && loadReview(repo, id, work.active.target);
const report = { scenario, at:new Date().toISOString(), scope:'Live model from intake; automated TTY fixtures, not a real novice or human approval', repo, finished, blocked,
  durationMs:(previous?.durationMs || 0)+Date.now()-started, reportedCostUSD:cost, approvals, questionCount:questions.length, questionCountScope:'questions.md entries only; conversational questions are preserved in turns but not counted here', unanswered:questions.filter(q=>!q.answer).map(q=>q.title), turns,
  taskSequence:work?.plan?.sequence, tests:evidence?.testCases, integrationTests:evidence?.integrationTestCases, reproduction:evidence?.repro,
  reviews:review?.rounds.map(r=>({round:r.round,observed:!!r.reviewer?.completedAt,result:r.reviewer?.result})),
  source:fs.existsSync(path.join(repo,'src/value.js'))?fs.readFileSync(path.join(repo,'src/value.js'),'utf8'):null,
  baselineTestUnchanged:scenario==='refactor' && fs.readFileSync(path.join(repo,'tests/value.test.js'),'utf8')===tests,
  finalCommit:hasBaseline(repo)?git('rev-parse','HEAD'):null, activeAfterDelivery:loadActive(repo)?.phase || null };
if (!finished && !report.blocked) report.blocked = cost >= costLimit ? 'Per-run evaluation cost limit reached; resume preserves evidence.' : 'Model stopped before delivery.';
fs.writeFileSync(reportPath, JSON.stringify(report,null,2)+'\n');
if (!finished) process.exitCode = 1;
