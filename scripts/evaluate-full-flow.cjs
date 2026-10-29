require('./live-eval-guard.cjs')('node scripts/evaluate-full-flow.cjs');
/* Opt-in live evaluation from intake through local delivery in disposable repositories.
 * Only TTY interaction is mocked by this driver; every such decision is labelled as a fixture.
 * Never claims to measure a real beginner or human approval. No push or external publication.
 * Usage: node scripts/evaluate-full-flow.cjs run|resume <new|enhance|fix|refactor> [--model sonnet|opus] [--agents policy|exec-opus|opus|sonnet] [--label 기록이름] [--budget USD] [--timeout 분] [--hosts claude|both] [--main codex --vetted-hooks]
 * --hosts both 는 Codex 도 설치해 계획 검토·코드 리뷰의 교차 검증을 실제 Codex 로 돈다(로그인된 codex 필요).
 * 기본은 sonnet·$5 한도다. --model 은 메인 세션 모델이다. 담당(서브에이전트) 모델은 --agents 가 정한다 —
 * policy = 설치 정책 그대로(판단 opus/high · 실행 sonnet/medium, --model opus 의 기본), exec-opus = 실행 역할만 model: opus(강도 줄 유지),
 * opus·sonnet = 모든 역할을 그 모델로 바꾸고 effort 줄을 지운다(--model sonnet의 기본은 sonnet).
 * 정책 효과 비교는 policy 대 exec-opus 로 한다 — 실행 역할의 모델 하나만 다르다. 보고서의 agents 에 역할별 model/effort 를 싣는다.
 * 판단 역할 목록은 modelPolicy ROLE_POLICY 의 등급에서 가져온다. resume 은 기록된 agentsMode 를 잇고 다른 --agents 는 거부한다
 * (agentsMode 가 없는 이전 기록은 그 기록의 --model 값 opus·sonnet 을 모드로 본다).
 * 보고서에는 usage 텍스트와 함께 usageData(usageReport — 요청·도구 호출·도구 결과 글자·명령별 호출·스킬 읽기·실행 타임라인 요약)·retry(retryReports — 읽기 전용)·
 * 턴별 numTurns·codexAgents 를 싣는다. 반복 실행 편차는 scripts/summarize-evaluations.cjs 로 요약한다.
 * total_cost_usd는 --continue 세션의 누적값이다 — 턴 비용은 직전 누적값과의 차이로 센다.
 * 업무 질문의 빈 답은 드라이버가 '평가 fixture 답'으로 채운다. 실제 사람의 답이 아니며 questionFixtures에 남긴다.
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
const { usage, usageReport } = use('agent/usage');
const { retryReports } = use('agent/retryReport');
const { AGENTS, ROLE_POLICY, claudeFrontmatter, frontmatterModel } = use('agent/modelPolicy');
const scenario = process.argv[3], resume = process.argv[2] === 'resume';
if (!['run','resume'].includes(process.argv[2]) || !['new', 'enhance', 'fix', 'refactor'].includes(scenario)) throw Error('Use run|resume <new|enhance|fix|refactor>');
const option = name => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : undefined; };
const mainHost = option('main') ?? 'claude';
if (!['claude', 'codex'].includes(mainHost) || mainHost === 'codex' && !process.argv.includes('--vetted-hooks')) throw Error('Codex main requires --main codex --hosts both --vetted-hooks');
const installHosts = option('hosts') ?? 'claude', hostModel = option('model') ?? 'sonnet', label = option('label') ?? 'latest', budget = Number(option('budget') ?? 5), timeoutMin = Number(option('timeout') ?? 10);
if (!['sonnet', 'opus'].includes(hostModel) || !/^[\w.-]+$/.test(label) || !(budget > 0) || !(timeoutMin > 0) || !['claude', 'both'].includes(installHosts)) throw Error('Use --model sonnet|opus, --label [A-Za-z0-9_.-]+, --budget <positive USD>, --timeout <minutes>');
const reportPath = path.join(root, 'doc/reviews/evidence', `full-flow-${scenario}-${label}.json`);
const previous = resume ? JSON.parse(fs.readFileSync(reportPath,'utf8')) : undefined;
if (previous && (previous.mainHost ?? 'claude') !== mainHost) throw Error('Resume must keep the original main host');
if (mainHost === 'codex' && installHosts !== 'both') throw Error('Codex evaluation requires --hosts both');
// resume은 기록된 담당 모델을 유지한다. agentsMode가 없으면 model의 opus·sonnet 값을 사용한다.
const recordedAgents = previous && (previous.agentsMode ?? (['opus', 'sonnet'].includes(previous.model) ? previous.model : undefined));
if (resume && !recordedAgents) throw Error('Resume needs agentsMode or model (opus|sonnet) in the previous report.');
if (resume && option('agents') && option('agents') !== recordedAgents) throw Error(`Resume keeps the recorded --agents ${recordedAgents}; start a new --label to run another mode.`);
const agentsMode = resume ? recordedAgents : option('agents') ?? (hostModel === 'opus' ? 'policy' : 'sonnet');
if (!['policy', 'exec-opus', 'opus', 'sonnet'].includes(agentsMode)) throw Error('Use --agents policy|exec-opus|opus|sonnet');
if (previous?.finished) throw Error('Scenario already completed; preserve the recorded result.');
const repo = resume ? fs.realpathSync.native(previous.repo) : fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `ca-full-${scenario}-`)));
if (resume && (path.dirname(repo) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(repo).startsWith(`ca-full-${scenario}-`))) throw Error('Resume is limited to the disposable evaluation repository.');
const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
const git = (...args) => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
if (!resume) {
git('init', '-q', '-b', 'master'); git('config', 'user.name', 'evaluation-fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
init(repo, { cli: path.join(root, 'dist/agent/cli.js'), host: installHosts });
}
// 담당 모델 — 비교하려는 변수 하나만 다르게 둔다(policy 대 exec-opus 는 실행 역할의 모델만 다르다)
const JUDGMENT_AGENTS = AGENTS.filter(agent => ROLE_POLICY[agent].tier === 'judgment').map(agent => `ca-${agent}.md`);
for (const file of agentsMode === 'policy' ? [] : fs.readdirSync(path.join(repo, '.claude/agents')).filter(name => /^ca-.+\.md$/.test(name))) {
  if (agentsMode === 'exec-opus' && JUDGMENT_AGENTS.includes(file)) continue;
  const full = path.join(repo, '.claude/agents', file), text = fs.readFileSync(full, 'utf8');
  const config = agentsMode === 'exec-opus' ? { model: 'opus', effort: frontmatterModel(text).effort } : { model: agentsMode };
  fs.writeFileSync(full, claudeFrontmatter(text, config));
}
const agentsReport = () => Object.fromEntries(fs.readdirSync(path.join(repo, '.claude/agents')).filter(name => /^ca-.+\.md$/.test(name)).map(name => {
  const config = frontmatterModel(fs.readFileSync(path.join(repo, '.claude/agents', name), 'utf8'));
  return [name.replace(/^ca-|\.md$/g, ''), config.effort ? `${config.model}/${config.effort}` : config.model];
}));
// Codex 역할 설정 — .codex/agents/*.toml 의 model·model_reasoning_effort(두 호스트 설치일 때만)
const codexAgentsReport = () => { const dir = path.join(repo, '.codex/agents'); if (!fs.existsSync(dir)) return undefined;
  return Object.fromEntries(fs.readdirSync(dir).filter(name => name.endsWith('.toml')).map(name => { const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const value = key => (new RegExp(`^${key} = "([^"]*)"`, 'm').exec(text) || [])[1];
    return [name.replace(/\.toml$/, ''), { model: value('model'), effort: value('model_reasoning_effort') }]; })); };
const correct = "module.exports=function value(n){if(n<0)throw Error('negative');return 1;};\n";
const tests = "const test=require('node:test'),assert=require('node:assert/strict'),value=require('../src/value');test('TC-1 nonnegative',()=>{assert.equal(value(0),1);assert.equal(value(2),1);});test('TC-2 negative',()=>assert.throws(()=>value(-1),/negative/));\n";
if (!resume && scenario !== 'new') {
  docsBegin(repo); setupProject(repo, 'node'); docsEnd(repo);
  write('src/value.js', scenario === 'fix' ? "module.exports=function value(n){if(n<0)throw Error('negative');return 0;};\n" : scenario === 'enhance' ? "module.exports=function value(n){return 1;};\n" : "module.exports=function value(n){if(n<0)throw Error('negative');if(n===0)return 1;else return 1;};\n");
  write('tests/value.test.js', scenario === 'refactor' ? tests : "const test=require('node:test'),assert=require('node:assert/strict'),value=require('../src/value');test('existing negative',()=>assert.equal(typeof value,'function'));\n");
  git('add', '.'); git('commit', '-qm', 'evaluation baseline');
}
const approvals = previous?.approvals || [], turns = previous?.turns || [], questionFixtures = previous?.questionFixtures || [], started = Date.now();
let cumulative = previous?.turns?.at(-1)?.reportedCostUSD || 0;
tty.confirmOnTerminal = (_shown, word) => { approvals.push({ word, kind: 'automated TTY fixture; not human', at: new Date().toISOString() }); return { channel: 'tty', verified: true, detail: 'AUTOMATED EVALUATION FIXTURE — not a human approval' }; };
tty.askOnTerminal = () => 'n'; // Optional knowledge promotion is not part of this small scenario.
if (!resume && mainHost === 'codex') {
  const env = { ...process.env };
  for (const key of [...use('agent/crossEnv').CODEX_MARKERS, 'CLAUDECODE']) delete process.env[key];
  try { use('agent/executionCommands').execution(repo, 'codex'); } finally { process.env = env; }
}
const claude = process.env.CLAUDE_EVALUATION_BIN || path.join(os.homedir(), '.local/bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
const requests = {
  new: '신규: Node.js와 기존 추천의 node:test로 src/value.js를 만들어 주세요. CommonJS로 value(n) 함수 하나를 export합니다. 숫자 n이 0 이상이면 1을 반환하고, 음수면 Error("negative")를 던져야 합니다. 외부 패키지·웹서버·DB는 필요 없습니다. tests/value.test.js와 실행 안내도 작성해 주세요.',
  enhance: '기능 개선: src/value.js의 value(n)에 음수 입력 시 Error("negative")를 던지는 기능을 추가해 주세요. 0 이상이면 1 반환, CommonJS 함수 export와 함수 시그니처는 유지합니다. tests/value.test.js에서 0, 2, -1을 검증해 주세요. 기존 Node.js·node:test를 유지합니다.',
  fix: '버그 수정: src/value.js의 value(n)이 0 이상에서 0을 반환하는 결함을 고쳐 주세요. 기대는 1 반환입니다. 음수에서 Error("negative"), CommonJS 함수 export와 함수 시그니처는 유지합니다. 변경 범위는 src/value.js와 tests/value.test.js입니다. 0, 2, -1을 검증하고 수정 전에 0 입력의 실패를 재현해 주세요. 기존 Node.js·node:test를 유지합니다.\n운영 오류 로그:\n2026-10-06T09:12:44Z ERROR checkout - unexpected value\nAssertionError [ERR_ASSERTION]: value(0) expected 1 but was 0\n    at value (src/value.js:1:63)',
  refactor: '리팩토링: src/value.js에서 value(n)의 중복 반환 분기만 제거해 주세요. 동작은 0 이상이면 1, 음수면 Error("negative")입니다. CommonJS export와 함수 시그니처, tests/value.test.js의 기존 테스트를 그대로 보존합니다. 변경 범위는 src/value.js뿐입니다. 기존 Node.js·node:test를 유지합니다.',
};
let finished = false, lastWork, blocked, cost = previous?.reportedCostUSD || 0;
let nativeSession = previous?.sessionId;
if (resume && !nativeSession) throw Error('Resume requires the recorded explicit native sessionId; never use the latest session');
const startingTurn = turns.length, costLimit = cost + budget, perTurn = option('budget') ? budget : 1.5;
function answerQuestions(id) {
  const file = id && path.join(repo, `doc/work/${id}/questions.md`);
  if (!file || !fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  const open = parseQuestions(text).filter(q => !q.answer).map(q => q.id);
  if (!open.length) return;
  const filled = text.replace(/^\[Answer\]:[ \t]*(\r?)$/gm, (_, cr) => `[Answer]: 평가 fixture 답 — 실제 사람의 답이 아님. 질문에 적힌 추천안으로 진행한다.${cr}\n[Source]: 대화 (평가 fixture — 사람 아님)${cr}`);
  fs.writeFileSync(file, filled);
  for (const q of parseQuestions(filled)) if (open.includes(q.id) && q.answer) questionFixtures.push({ id: q.id, kind: 'automated question fixture; not human', at: new Date().toISOString() });
}
function fixtureActions() {
  answerQuestions(loadActive(repo)?.id ?? loadRequestSession(repo)?.id);
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
  // 부른 세션(Claude·Codex)의 표지를 지워 사용자가 터미널에서 띄운 호스트와 같은 환경으로 띄운다
  const env = use('agent/crossEnv').hostBaseEnv(process.env); delete env.NODE_TEST_CONTEXT;
  const argv = ['-p', prompt, ...(nativeSession ? ['--resume', nativeSession] : []), '--model', hostModel, '--max-budget-usd', String(Math.min(perTurn, costLimit - cost)), '--output-format', 'json', '--setting-sources', 'project', '--permission-prompts', 'none', '--allowedTools', 'Read,Edit,Write,Grep,Glob,Agent,Skill,Bash(code-agent *)'];
  const codex = mainHost === 'codex' ? require('./live-codex.cjs')(root, repo, path.join(root, 'dist/agent/cli.js'), nativeSession) : undefined;
  const result = cp.spawnSync(codex?.command ?? claude, codex?.args ?? argv, { cwd: repo, env, ...(codex ? { input: prompt.replaceAll('/ca-', 'ca_') } : {}), encoding: 'utf8', windowsHide: true, timeout:timeoutMin*60000, maxBuffer:12*1024*1024 });
  fs.writeFileSync(path.join(root, 'dist', `full-${scenario}-${label}-${turn}.json`), result.stdout || '');
  fs.writeFileSync(path.join(root, 'dist', `full-${scenario}-${label}-${turn}.stderr.log`), result.stderr || '');
  let model;
  try {
    if (codex) {
      const events = result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      const thread = events.find(e => e.type === 'thread.started')?.thread_id;
      if (!thread || nativeSession && nativeSession !== thread) throw Error('Codex did not confirm the same thread');
      nativeSession = thread;
      model = { session_id: thread, is_error: !events.some(e => e.type === 'turn.completed'), result: events.filter(e => e.type === 'item.completed' && e.item.type === 'agent_message').map(e => e.item.text).join('\n') };
    } else model = JSON.parse(result.stdout);
    nativeSession = model.session_id ?? nativeSession;
  } catch (error) { blocked = result.error?.message || result.stderr || error.message; break; }
  const reported = model.total_cost_usd || 0, turnCost = reported >= cumulative ? reported - cumulative : reported;
  cumulative = reported; cost += turnCost;
  const record = { turn:turn + 1, exitCode:result.status, durationMs:model.duration_ms, ...(typeof model.num_turns === 'number' ? { numTurns:model.num_turns } : {}), reportedCostUSD:reported, turnCostUSD:+turnCost.toFixed(4), modelError:!!model.is_error, phase:loadActive(repo)?.phase || 'request', result:model.result };
  turns.push(record);
  try { fixtureActions(); blocked = undefined; } catch (error) { record.fixtureBlocked = error.message; blocked = error.message; }
  console.log(JSON.stringify({ scenario, turn:turn + 1, phase:loadActive(repo)?.phase, finished, cost, blocked }));
  if (mainHost === 'codex' && /\.git\/index\.lock.{0,12}Permission denied/i.test(model.result)) { blocked = 'Codex workspace-write sandbox denied .git/index.lock; permissions were not widened.'; break; }
  if (model.is_error) break;
}
const work = lastWork || loadWork(repo);
const session = loadRequestSession(repo);
const id = work?.active.id || session?.id;
const questionFile = id && path.join(repo, `doc/work/${id}/questions.md`);
const questions = questionFile && fs.existsSync(questionFile) ? parseQuestions(fs.readFileSync(questionFile, 'utf8')) : [];
const evidence = work && loadEvidence(repo, id, work.active.target);
const review = work && loadReview(repo, id, work.active.target);
const report = { scenario, mainHost, sessionId: nativeSession, model:mainHost === 'codex' ? 'host default' : hostModel, agentsMode, agents:agentsReport(), hosts:installHosts, at:new Date().toISOString(), scope:'Live model from intake; automated TTY fixtures, not a real novice or human approval. Consent questions and the consent prepare/finish round trip are replaced by TTY fixtures, so usageData does not contain them', repo, finished, blocked,
  durationMs:(previous?.durationMs || 0)+Date.now()-started, reportedCostUSD:mainHost === 'codex' ? null : cost, costNote:mainHost === 'codex' ? 'Codex cost is unavailable; zero is not asserted.' : 'turn cost = delta of reported total_cost_usd; interrupted turns may have unreported cost; usage is transcript-based', interruptedAttempts:previous?.interruptedAttempts, approvals, questionFixtures, questionCount:questions.length, questionCountScope:'questions.md entries only; conversational questions are preserved in turns but not counted here', unanswered:questions.filter(q=>!q.answer).map(q=>q.title), turns,
  taskSequence:work?.plan?.sequence, tests:evidence?.testCases, integrationTests:evidence?.integrationTestCases, reproduction:evidence?.repro,
  reviews:review?.rounds.map(r=>({round:r.round,observed:!!r.reviewer?.completedAt,result:r.reviewer?.result,cross:r.cross&&{host:r.cross.host,model:r.cross.model,completed:!!r.cross.completedAt,result:r.cross.result,error:r.cross.error}})),
  planningCross:(()=>{try{const s=use('agent/planningState').loadPlanning(work);return s.cross&&{host:s.cross.host,model:s.cross.model,status:s.cross.status,findings:s.cross.findings.length,questions:s.cross.questions};}catch{return undefined;}})(),
  source:fs.existsSync(path.join(repo,'src/value.js'))?fs.readFileSync(path.join(repo,'src/value.js'),'utf8'):null,
  baselineTestUnchanged:scenario==='refactor' && fs.readFileSync(path.join(repo,'tests/value.test.js'),'utf8')===tests,
  finalCommit:hasBaseline(repo)?git('rev-parse','HEAD'):null, activeAfterDelivery:loadActive(repo)?.phase || null,
  usage:usage(repo).split(/\r?\n/), usageData:usageReport(repo), retry:retryReports(repo, id),
  codexAgents:installHosts === 'both' ? codexAgentsReport() : undefined };
if (!finished && !report.blocked) report.blocked = cost >= costLimit ? 'Per-run evaluation cost limit reached; resume preserves evidence.' : 'Model stopped before delivery.';
fs.writeFileSync(reportPath, JSON.stringify(report,null,2)+'\n');
if (!finished) process.exitCode = 1;
