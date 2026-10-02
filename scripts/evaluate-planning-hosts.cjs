/* 선택 실행: 실제 호스트·모델이 설치된 역할을 호출하고 계획 결과를 hook으로 남기는지 검사한다.
 * 요구사항·초기 준비 동의만 명시적인 합성 fixture다. 실제 사람의 승인 검증이 아니다.
 * node scripts/evaluate-planning-hosts.cjs claude|codex [기록이름] [--vetted-hooks] [--model 모델] [--through-impact]
 * 로그와 임시 프로젝트는 dist 아래에 보존한다. 전역 설정·훅 신뢰 설정을 바꾸지 않는다.
 */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { values, positionals } = require('node:util').parseArgs({ options: { 'vetted-hooks': { type: 'boolean' }, model: { type: 'string' }, 'through-impact': { type: 'boolean' } }, allowPositionals: true });
const root = path.resolve(__dirname, '..'), host = positionals[0];
if (!['claude', 'codex'].includes(host)) throw Error('claude 또는 codex를 지정하세요. 실제 모델 호출이 발생합니다.');
const label = positionals[1];
if (positionals.length > 2) throw Error('호스트와 기록 이름만 위치 인자로 사용합니다.');
const parentModel = values.model;
const throughImpact = !!values['through-impact'];
if (parentModel && (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(parentModel) || host !== 'codex')) throw Error('--model은 Codex 메인 모델 비교 검사 전용입니다.');
if (label && !/^[a-z0-9-]+$/.test(label)) throw Error('기록 이름은 영문 소문자·숫자·하이픈만 사용합니다.');
const outputName = `planning-live-${host}${label ? `-${label}` : ''}`;
const vettedHooks = !!values['vetted-hooks'];
if (vettedHooks && host !== 'codex') throw Error('검토한 훅의 일회성 실행은 Codex 검사 전용입니다.');
if (fs.existsSync(path.join(root, 'dist', `${outputName}.json`))) throw Error('기존 검증 기록을 덮어쓰지 않습니다. 다른 기록 이름을 지정하세요.');
const use = file => require(path.join(root, 'dist', file));
const fixture = use('test/consentFixture');
const { init } = use('agent/init'), { start } = use('agent/commands');
const { advancePlanning, planningStatus } = use('agent/planning');
const { loadWork } = use('agent/work'), { loadPlanning } = use('agent/planningState');
const { hostAssets } = use('agent/hosts');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(root, 'dist', `planning-live-${host}-`)));
fixture.setupConsentProject(repo);
const fixtureConfigPath = path.join(repo, 'code-agent.json');
const fixtureConfig = JSON.parse(fs.readFileSync(fixtureConfigPath, 'utf8'));
fixtureConfig.git = { ...fixtureConfig.git, base: cp.execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim() };
fs.writeFileSync(fixtureConfigPath, JSON.stringify(fixtureConfig, null, 2) + '\n');
init(repo, { host, cli: path.join(root, 'dist/agent/cli.js') });
if (host === 'claude') fixture.approveAndApplyFixture(repo, { action: 'model', agent: 'all', model: 'sonnet' }, host);
fixture.approveAndApplyFixture(repo, { action: 'setup' }, host);
const request = use('agent/request');
request.requestBegin(repo, fixture.CONSENT_WORK_ID, 'feature');
const requirements = [
  'Node.js CommonJS 프로젝트의 src/value.js에서 숫자 인자 n 하나를 받는 value(n) 함수를 module.exports로 공개한다.',
  'n이 0 이상이면 숫자 1을 반환하고 n이 음수이면 메시지가 negative인 Error 객체를 던진다. 숫자 이외의 입력은 이번 요구 범위 밖이다.',
  'tests/value.test.js에서 node:test로 0, 2, -1 입력을 검증한다. 웹 서버, 외부 API, 데이터베이스, 추가 패키지는 사용하지 않는다.',
];
const draft = `doc/work/${fixture.CONSENT_WORK_ID}/request.json`;
fixture.writeFixture(repo, draft, JSON.stringify({ id: fixture.CONSENT_WORK_ID, kind: 'feature', title: '숫자 함수의 반환과 예외', target: ['value'], original: requirements.join('\n'), requirements }));
request.requestSubmit(repo, path.join(repo, draft));
fixture.approveAndApplyFixture(repo, { action: 'request', id: fixture.CONSENT_WORK_ID }, host);
start(repo, path.join(repo, fixture.CONSENT_SPEC));
const prompt = [
  '설치된 코드 에이전트의 실제 호스트 연동 검사입니다. 초기 준비와 요구 확정은 합성 테스트 fixture이며 사람의 승인으로 보고하지 마세요.',
  `셸에서 code-agent planning advance를 실행하고 assignments[0]의 hostAgents.${host}를 실제 하위 에이전트로 호출하세요.`,
  '하위 담당에게 배정 JSON 전체를 전달하고 지정된 지시서에서 요구 정의 문서를 작성해 결과 계약에 맞는 JSON으로 반환하도록 하세요.',
  '현재 배정의 inputs와 선행 결과에 있는 경로만 읽고 근거로 쓰세요. 역할 설명의 일반 입력 예시는 이번 배정에 파일을 추가하는 지시가 아닙니다. 배정하지 않은 KNOWLEDGE는 읽거나 인용하지 마세요.',
  'JSON evidence와 문서 본문 모두 파일 근거는 저장소 루트 기준 전체 상대 경로와 줄로 적으세요. 예: doc/work/CONSENT-1/requirement.md:16. requirement.md:16처럼 파일명만 쓰거나 존재하지 않는 미래 구현 파일을 현재 근거로 인용하지 마세요. 이 지시도 하위 담당에게 전달하세요.',
  '메인은 문서·상태 파일을 직접 쓰거나 planning-event 또는 codex-event를 호출하지 마세요. 실제 시작·완료 hook만 결과를 기록합니다.',
  '형식 교정 안내가 있으면 planning advance의 correction 배정을 같은 역할의 새 담당에게 전달하세요. 최대 1회입니다.',
  throughImpact
    ? '분석 완료 후 planning advance가 ready-for-gate이면 code-agent next로 impact 단계에 진입하세요. 그 단계도 planning advance의 실제 배정만 호출하세요. impact 역할이면 한 담당이 조사와 02 문서 작성을 함께 수행하며 문서에는 기존 시스템 분석·영향 범위·Risk 섹션과 모든 R의 영향 범위 표를 넣습니다. 영향도 단계의 ready-for-gate에서 멈추세요. 설계·승인·구현은 진행하지 마세요.'
    : '완료 후 planning advance가 ready-for-gate인지 확인하고 멈추세요. 다음 단계·승인·구현은 진행하지 마세요.',
  '호스트가 역할·훅·명령 실행을 지원하지 않으면 정확한 실패 이유를 보고하고 멈추세요.',
].join('\n');
const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
let command, args, windowsSandbox, captureLog;
if (host === 'claude') {
  command = process.env.CLAUDE_EVALUATION_BIN || path.join(os.homedir(), '.local/bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  args = ['-p', prompt, '--model', 'sonnet', '--max-budget-usd', '1.5', '--output-format', 'json', '--setting-sources', 'project', '--permission-prompts', 'none', '--allowedTools', 'Read,Grep,Glob,Agent,Skill,Bash(code-agent *)'];
} else {
  if (vettedHooks) {
    // 공식 비대화형 검사 옵션은 검토한 생성 훅만 있는 환경에서 명시적으로 선택한다.
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    if (fs.existsSync(path.join(home, 'hooks.json'))) throw Error('사용자 훅이 있는 환경에서는 일괄 신뢰 옵션을 쓰지 않습니다.');
    const settings = path.join(home, 'config.toml');
    if (process.platform === 'win32' && fs.existsSync(settings)) {
      const section = fs.readFileSync(settings, 'utf8').match(/^\[windows\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
      windowsSandbox = section?.match(/^\s*sandbox\s*=\s*"(elevated|unelevated)"/m)?.[1];
      if (!windowsSandbox) throw Error('격리 검사에 유지할 기존 Windows 샌드박스 설정을 확인하세요.');
    }
    if (fs.existsSync(settings) && /^\s*\[\[?hooks[.\]]/m.test(fs.readFileSync(settings, 'utf8'))) throw Error('사용자 인라인 훅이 있는 환경에서는 일괄 신뢰 옵션을 쓰지 않습니다.');
    for (let parent = path.dirname(repo); ; parent = path.dirname(parent)) {
      if (fs.existsSync(path.join(parent, '.codex/hooks.json'))) throw Error('상위 프로젝트 훅을 별도로 검토해야 합니다.');
      const config = path.join(parent, '.codex/config.toml');
      if (fs.existsSync(config) && /^\s*\[\[?hooks[.\]]/m.test(fs.readFileSync(config, 'utf8'))) throw Error('상위 프로젝트 인라인 훅을 별도로 검토해야 합니다.');
      if (path.dirname(parent) === parent) break;
    }
    const installed = JSON.parse(fs.readFileSync(path.join(repo, '.codex/hooks.json'), 'utf8'));
    const hooks = Object.values(installed.hooks).flat().flatMap(group => group.hooks);
    const expected = `node "${path.join(root, 'dist/agent/cli.js').replace(/\\/g, '/')}" codex-event`;
    if (hooks.length !== 5 || hooks.some(hook => hook.type !== 'command' || hook.command !== expected)) throw Error('생성한 검사 훅 이외의 명령이 있습니다.');
    // 실제 호스트 입력과 판정만 보존하는 검사 래퍼. 입력을 합성하거나 결과를 바꾸지 않는다.
    const capture = path.join(repo, '.code-agent', 'live-hook.cjs');
    captureLog = path.join(root, 'dist', `${outputName}.hooks.jsonl`);
    fs.writeFileSync(capture, [
      "const fs=require('node:fs'),cp=require('node:child_process');",
      "const input=fs.readFileSync(0,'utf8');",
      `const result=cp.spawnSync(process.execPath,[${JSON.stringify(path.join(root, 'dist/agent/cli.js'))},'codex-event'],{input,encoding:'utf8',windowsHide:true});`,
      `fs.appendFileSync(${JSON.stringify(captureLog)},JSON.stringify({input:JSON.parse(input),stdout:result.stdout,stderr:result.stderr,exitCode:result.status})+'\\n');`,
      "process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exitCode=result.status??1;",
    ].join('\n'));
    for (const hook of hooks) hook.command = `node "${capture.replace(/\\/g, '/')}"`;
    fs.writeFileSync(path.join(repo, '.codex/hooks.json'), JSON.stringify(installed, null, 2));
  }
  // Windows의 cmd 래퍼를 셸 문자열로 조립하지 않고 설치된 Node 진입점을 직접 실행한다.
  command = process.platform === 'win32' ? process.execPath : 'codex';
  args = [...(process.platform === 'win32' ? [path.join(process.env.APPDATA, 'npm/node_modules/@openai/codex/bin/codex.js')] : []),
    'exec', '--ephemeral', '--sandbox', 'workspace-write', '--json', '-c', 'model_reasoning_effort="low"',
    ...(parentModel ? ['--model', parentModel] : []),
    ...(vettedHooks ? ['--ignore-user-config', '--enable', 'hooks', '--enable', 'multi_agent', '--dangerously-bypass-hook-trust', '-c', `projects={${JSON.stringify(repo.replace(/\\/g, '/'))}={trust_level="trusted"}}`,
      ...(windowsSandbox ? ['-c', `windows.sandbox=${JSON.stringify(windowsSandbox)}`] : [])] : []), '-C', repo, prompt];
}
const began = Date.now();
const result = cp.spawnSync(command, args, { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
fs.writeFileSync(path.join(root, 'dist', `${outputName}.stdout.log`), result.stdout || '');
fs.writeFileSync(path.join(root, 'dist', `${outputName}.stderr.log`), result.stderr || '');
const state = loadPlanning(loadWork(repo));
const analysis = state.tasks.find(item => item.task.role === 'analysis');
const analysisCompleted = analysis?.attempts.at(-1)?.status === 'completed';
const impactTasks = state.tasks.filter(item => ['impact', 'explore', 'synthesis'].includes(item.task.role));
const impactCompleted = impactTasks.some(item => ['impact', 'synthesis'].includes(item.task.role)) && impactTasks.every(item => item.attempts.at(-1)?.status === 'completed');
const completed = analysisCompleted && (!throughImpact || impactCompleted);
const status = JSON.parse(planningStatus(repo));
const nativeEvents = host === 'codex' ? (result.stdout || '').split(/\r?\n/).filter(Boolean).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
}) : [];
const nativeSpawns = nativeEvents.filter(event => event.type === 'item.completed'
  && event.item?.type === 'collab_tool_call' && event.item.tool === 'spawn_agent'
  && event.item.status === 'completed' && event.item.receiver_thread_ids?.length);
const returnedAgentIds = [...new Set(nativeEvents.flatMap(event => event.type === 'item.completed'
  && event.item?.type === 'collab_tool_call'
  ? Object.entries(event.item.agents_states || {}).filter(([, value]) => value.status === 'completed' && typeof value.message === 'string').map(([id]) => id)
  : []))];
const hookEvents = captureLog && fs.existsSync(captureLog) ? fs.readFileSync(captureLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
const report = {
  host, at: new Date().toISOString(), repo, exitCode: result.status, error: result.error?.code,
  durationMs: Date.now() - began, scope: `실제 모델·호스트의 ${throughImpact ? '분석·영향도' : '분석'} 담당 호출과 관찰. 준비·요구·Claude 모델 선택 동의는 합성 fixture. 전체 개발 흐름·사람 승인 측정 아님.`,
  installedAssets: hostAssets(host).size, vettedHooks, windowsSandbox, parentModel: parentModel ?? (host === 'claude' ? 'sonnet' : '호스트 기본값'), completed: !!completed,
  throughImpact, analysisCompleted: !!analysisCompleted, ...(throughImpact ? { impactCompleted } : {}),
  observedAgents: state.agents.map(({ id, type, finished }) => ({ id, type, finished: !!finished })),
  status,
};
if (host === 'codex') report.runtime = {
  nativeSpawnCount: nativeSpawns.length, returnedAgentIds,
  // 도구 응답은 실행 증거이며 역할별 설정 적용이나 계획 결과 수락의 증거로 대신 쓰지 않는다.
  hookCaptureEnabled: !!captureLog, hookEventCount: captureLog ? hookEvents.length : null,
  hookEvents: hookEvents.map(event => ({ event: event.input.hook_event_name, exitCode: event.exitCode })),
  diagnosis: result.error ? 'host-process-error'
    : completed ? 'observed-completion'
    : captureLog && !hookEvents.length ? 'no-hook-events'
    : !state.agents.length ? 'no-observed-agent'
    : 'result-not-accepted',
};
// 새 실행을 배정하는 부작용 없이 실제 관찰 완료 뒤에만 게이트 준비를 확인한다.
if (completed) report.action = JSON.parse(advancePlanning(repo)).action;
fs.writeFileSync(path.join(root, 'dist', `${outputName}.json`), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ host, completed: report.completed, action: report.action, exitCode: report.exitCode, error: report.error, durationMs: report.durationMs }));
if (!completed || report.action !== 'ready-for-gate') process.exitCode = 1;
