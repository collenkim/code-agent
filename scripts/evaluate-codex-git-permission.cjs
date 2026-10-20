/* 선택 실행: 실제 Codex app-server의 Git 차단→단건 승인 RPC→동일 작업 시작.
 * 문서·요구·신뢰·대시보드 응답은 격리 저장소의 합성 평가 fixture이며 실제 사람 승인으로 보고하지 않는다.
 * 사용자 설정·다른 저장소를 수정하지 않는다. node scripts/evaluate-codex-git-permission.cjs
 */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const source = path.resolve(__dirname, '..'), cli = path.join(source, 'dist/agent/cli.js');
const use = name => require(path.join(source, 'dist/agent', name));
const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-full-git-permission-')));
const fixtures = require(path.join(source, 'dist/test/consentFixture'));
const originalHome = process.env.CODEX_HOME, realHome = originalHome || path.join(os.homedir(), '.codex');
const at = new Date().toISOString(), report = { at, repo, scenario: 'codex-managed-git-permission', actualModel: true, approvalSource: 'synthetic evaluation fixture, not human approval', passed: false };
const store = use('master/store'); let token, runId, poll;
(async () => {
  fixtures.setupConsentProject(repo);
  use('init').init(repo, { cli, host: 'codex' });
  const tty = use('tty');
  const interaction = { confirm: () => ({ channel: 'tty', verified: true, detail: 'AUTOMATED EVALUATION FIXTURE; not human approval' }), ask: () => 'n' };
  fixtures.approveAndApplyFixture(repo, { action: 'setup' });
  fixtures.submitConsentRequest(repo);
  const marks = use('crossEnv');
  // 이 평가 프로세스에서만 외부 TTY fixture를 재현한다. 모델 자식에는 감독의 실행 표지가 붙는다.
  for (const key of [...marks.CODEX_MARKERS, ...marks.CLAUDE_SESSION_ENV, 'CLAUDECODE', 'CODE_AGENT_HOST', 'CODE_AGENT_CROSS']) delete process.env[key];
  tty.withInteraction(interaction, () => {
    use('executionCommands').execution(repo, 'codex');
    use('request').decideRequest(repo, fixtures.CONSENT_WORK_ID, 'confirmed');
  });
  fixtures.approveAndApplyFixture(repo, { action: 'baseline' });
  assert.equal(use('layout').loadActive(repo), undefined);
  // 생성한 hook을 기존 평가 도우미로 완전 일치 대조한다. 제품의 신뢰 가드는 변경하지 않는다.
  const invocation = require('./live-codex.cjs')(source, repo, cli);
  const start = invocation.args.indexOf('--ignore-user-config'), end = invocation.args.indexOf('--json');
  assert.ok(start > 0 && end > start);
  const prefix = process.platform === 'win32' ? [invocation.args[0]] : [];
  const flags = invocation.args.slice(start + 1, end).filter(arg => arg !== '--dangerously-bypass-hook-trust');
  flags[flags.findIndex(arg => arg.startsWith('projects='))] = `projects={${JSON.stringify(repo)}={trust_level="trusted"},${JSON.stringify(repo.toLowerCase())}={trust_level="trusted"}}`;
  const hooks = await new Promise((resolve, reject) => {
    const probe = cp.spawn(invocation.command, [...prefix, 'app-server', ...flags], { cwd: repo, stdio: ['pipe','pipe','pipe'], windowsHide: true });
    let buffer = '', stderr = '', resolved = false;
    const timer = setTimeout(() => { probe.stdin.end(); reject(Error('hooks/list timeout')); }, 20000);
    probe.stderr.on('data', d => { stderr += d; });
    probe.stdout.on('data', d => { buffer += d; let at;
      while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (!line.trim()) continue; const r = JSON.parse(line);
        if (r.id === 1) { probe.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n'); probe.stdin.write(JSON.stringify({id:2,method:'hooks/list',params:{cwds:[repo]}})+'\n'); }
        if (r.id === 2) { clearTimeout(timer); resolved = true; probe.stdin.end(); if(r.error) reject(Error(JSON.stringify(r.error))); else resolve(r.result.data.flatMap(d => d.hooks)); }
      }
    });
    probe.on('error', reject); probe.on('exit', () => { clearTimeout(timer); if(!resolved) reject(Error(stderr || 'probe exited')); });
    probe.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'code_agent_evaluation',version:'1.0.0'}}})+'\n');
  });
  assert.equal(hooks.length, use('init').CODEX_EVENTS.length, 'reviewed generated hooks only');
  for (const h of hooks) assert.equal(path.resolve(h.sourcePath).toLowerCase(), path.join(repo,'.codex/hooks.json').toLowerCase());
  flags.push('-c', `hooks={state={${hooks.map(h => `${JSON.stringify(h.key)}={trusted_hash=${JSON.stringify(h.currentHash)}}`).join(',')}}}`);
  report.reviewedHooks = hooks.map(h => ({ key: h.key, eventName: h.eventName, currentHash: h.currentHash }));
  const wrapper = path.join(repo, '.code-agent', 'live-codex-app-server.cjs');
  fs.writeFileSync(wrapper, `const cp=require('node:child_process');const child=cp.spawn(${JSON.stringify(invocation.command)},[...${JSON.stringify(prefix)},...process.argv.slice(2),...${JSON.stringify(flags)}],{env:{...process.env,CODEX_HOME:${JSON.stringify(realHome)}},stdio:'inherit',windowsHide:true});child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));\n`);
  const trustHome = path.join(repo, '.code-agent', 'evaluation-home'); fs.mkdirSync(trustHome);
  fs.writeFileSync(path.join(trustHome, 'config.toml'), `[projects.${JSON.stringify(repo)}]\ntrust_level="trusted"\n[hooks.state.${JSON.stringify(repo + '/.codex/hooks.json')}]\ntrusted_hash="synthetic-evaluation-reviewed-exact-hooks"\n`);
  process.env.CODEX_HOME = trustHome;
  const profile = path.join(repo, '.code-agent', 'evaluation-host.json'); fs.writeFileSync(profile, JSON.stringify({ kind: 'codex', command: [process.execPath, wrapper] }));
  const raw = tty.withInteraction(interaction, () => use('master/admin').masterEnable(repo, { controller: 'live-git-permission', host: profile }));
  token = /토큰\(다시 보여 주지 않습니다\): (\w+)/.exec(raw)[1];
  const binding = store.readBinding(repo), keys = crypto.generateKeyPairSync('ed25519');
  binding.humanChannel = { id: crypto.randomUUID(), controller: 'live-git-permission', generation: 1, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), createdAt: at, expiresAt: new Date(Date.now() + 600000).toISOString() }; store.writeBinding(repo, binding);
  store.writeWorkBinding(repo, { workId: fixtures.CONSENT_WORK_ID, links: {}, boundAt: at, runId: 'synthetic-intake-fixture', controller: 'live-git-permission', runs: [] });
  const envelope = (type, payload, commandId = crypto.randomUUID()) => ({ protocol: 'code-agent.master', version: 1, type, controller: 'live-git-permission', generation: 1, token, commandId, payload });
  const call = req => use('master/control').call(repo, JSON.stringify(req));
  const result = call(envelope('submit', { timeoutMs: 300000, prompt: `실제 Git 실행 권한 경로만 검증하는 임시 저장소입니다. 문서·요구 확정은 합성 평가 fixture입니다. code-agent start ${fixtures.CONSENT_SPEC} 명령을 실행하세요. .git/index.lock Permission denied이면 같은 명령을 shell 도구의 sandbox_permissions=require_escalated로 단건 권한 요청하세요. 직접 git으로 우회하거나 새 요청을 접수하지 마세요. 감독이 별도 대시보드 응답을 전달합니다. 시작 성공 뒤 code-agent status --json으로 기존 ID·종류·브랜치만 확인하고 턴을 끝내세요. 분석·계획·구현은 진행하지 마세요.` }));
  assert.equal(result.ok, true, JSON.stringify(result)); runId = result.result.runId;
  let pollError;
  poll = setInterval(() => {
    try {
      for (const r of use('interactions').currentInteractions(repo).requests.filter(r => r.kind === 'host-permission' && r.status === 'pending')) {
        assert.ok(r.permission.command.includes(`start ${fixtures.CONSENT_SPEC}`), 'unexpected command');
        const req = envelope('interaction.respond', { requestId: r.requestId, expectedRevision: r.revision, contentHash: r.contentHash, challenge: r.challenge, channelId: binding.humanChannel.id, submission: { intent: 'submit', explicit: true, permissionDecision: 'accept' } });
        req.payload.signature = crypto.sign(null, Buffer.from(use('interactionHuman').humanSigningMessage(binding.projectId, req)), keys.privateKey).toString('base64');
        const response = call(req); assert.equal(response.ok, true, JSON.stringify(response));
        console.log(`synthetic approval sent: ${r.requestId}`);
      }
    } catch (error) { pollError = error; clearInterval(poll); }
  }, 500);
  const until = Date.now() + 360000;
  let run;
  while (Date.now() < until) {
    run = store.readRun(repo, runId);
    if (['completed', 'blocked', 'failed', 'cancelled', 'paused', 'unknown'].includes(run.state)) break;
    if (pollError) throw pollError;
    await new Promise(r => setTimeout(r, 500));
  }
  clearInterval(poll);
  report.run = { runId, state: run.state, sessionId: run.sessionId, outcome: run.outcome, host: run.result?.host };
  report.permissions = use('interactions').currentInteractions(repo).requests.filter(r => r.kind === 'host-permission').map(r => ({ requestId: r.requestId, status: r.status, permission: r.permission, application: r.application }));
  report.work = use('layout').loadActive(repo);
  report.branch = cp.execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  const output = fs.readFileSync(store.runOutput(repo, runId), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  report.hookEvents = output.filter(r => r.type === 'hook.completed');
  assert.equal(run.state, 'completed'); assert.equal(store.listRuns(repo).length, 1);
  assert.equal(report.work.id, fixtures.CONSENT_WORK_ID); assert.equal(report.branch, `feature/${fixtures.CONSENT_WORK_ID}`);
  assert.ok(report.permissions.length > 0 && report.permissions.every(p => p.status === 'applied' && p.application.result.decision === 'accept' && p.application.result.executionConfirmed && p.application.result.exitCode === 0));
  assert.ok(report.hookEvents.some(h => h.eventName === 'preToolUse'), 'actual guard hook missing');
  report.passed = true;
})().catch(error => { report.error = error.stack; process.exitCode = 1; }).finally(() => {
  clearInterval(poll);
  if (runId) { const r = store.readRun(repo, runId); if (r && ['accepted', 'starting', 'running', 'stopping', 'orphaned'].includes(r.state)) use('master/runs').requestStop(repo, runId, { mode: 'cancel', by: 'evaluation', reason: 'evaluation finished', graceMs: 0, force: true }); }
  if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
  const file = path.join(source, 'dist', `codex-git-permission-${Date.now()}.json`); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, report: file, error: report.error }));
});
