/* Opt-in live model evaluation. Requires a build and an authenticated Claude CLI.
 * Approvals/documents/plans below are TEST FIXTURES, not human approvals or model output.
 * Every scenario gets an isolated temporary Git repository; no delivery or push is performed.
 * node scripts/evaluate-model.cjs prepare
 * node scripts/evaluate-model.cjs run <new|enhance|fix|refactor>
 * node scripts/evaluate-model.cjs collect
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const use = name => require(path.join(root, 'dist', name));
const { init } = use('agent/init');
const { docsBegin, docsEnd } = use('agent/docsCommands');
const { setupProject } = use('agent/setup');
const { checkProjectDocs, recordDocConfirmation } = use('agent/docs');
const { requestBegin, requestSubmit, recordRequestDecision } = use('agent/request');
const { start, next, submitPlan } = use('agent/commands');
const { loadWork, loadManifestIfAny, approvalDocsHash } = use('agent/work');
const { recordDecision } = use('core/approval');
const { loadEvidence } = use('agent/evidence');
const { loadReview } = use('agent/review');
const { deliverProblems } = use('agent/deliver');
const indexPath = path.join(root, 'dist', 'model-evaluation.json');
const presence = { channel: 'tty', verified: true, detail: 'AUTOMATED EVALUATION FIXTURE — not a human approval' };
const specText = "const test=require('node:test'),assert=require('node:assert/strict'),value=require('../src/value');\ntest('TC-1 nonnegative',()=>{assert.equal(value(0),1);assert.equal(value(2),1);});\ntest('TC-2 negative',()=>assert.throws(()=>value(-1),/negative/));\n";
function seed(scenario) {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `ca-live-${scenario}-`)));
  const write = (file, text) => { const p=path.join(repo,file); fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p,text); };
  const git = (...args) => cp.execFileSync('git',['-c','core.autocrlf=false','-c','user.name=evaluation-fixture','-c','user.email=fixture@example.invalid',...args],{cwd:repo,stdio:'pipe'});
  git('init','-q','-b','master');
  init(repo,{cli:path.join(root,'dist/agent/cli.js')});
  docsBegin(repo); setupProject(repo,'node'); docsEnd(repo);
  fs.mkdirSync(path.join(repo,'src'),{recursive:true});
  fs.mkdirSync(path.join(repo,'tests'),{recursive:true});
  // Keep inference costs bounded, including subagents. Only this disposable fixture is changed.
  for (const entry of fs.readdirSync(path.join(repo,'.claude/agents'))) {
    const file=path.join(repo,'.claude/agents',entry);
    fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(/^model: opus$/m,'model: sonnet'));
  }
  const kind = ['fix','refactor'].includes(scenario) ? scenario : 'feature';
  const id = `LIVE-${scenario.toUpperCase()}`;
  const requirement = scenario === 'refactor'
    ? 'value(n)의 중복 분기를 제거하되 n이 0 이상이면 1을 반환하고 음수이면 negative 오류를 던지는 동작을 유지한다.'
    : 'value(n)는 n이 0 이상이면 1을 반환하고 음수이면 negative 오류를 던진다.';
  if (scenario !== 'new') write('src/value.js', scenario === 'fix' ? "module.exports=n=>{if(n<0)throw Error('negative');return 0;};\n"
    : scenario === 'enhance' ? 'module.exports=n=>1;\n'
    : "module.exports=function value(n){if(n<0){throw Error('negative');}else if(n===0){return 1;}else{return 1;}};\n");
  if (scenario === 'refactor') write('tests/value.test.js',specText);
  for (const doc of checkProjectDocs(repo,loadManifestIfAny(repo))) recordDocConfirmation(repo,doc,'evaluation-fixture',presence);
  git('add','.');git('commit','-qm','evaluation baseline');
  requestBegin(repo,id,kind);
  const folder=`doc/work/${id}/`;
  const request={id,kind,title:`${scenario} evaluation`,target:[kind==='feature'?'value':'src/value.js'],scope:['src','tests'],preserve:kind==='feature'?[]:['value(n) 공개 함수 시그니처'],original:requirement,requirements:[requirement]};
  write(folder+'request.json',JSON.stringify(request));requestSubmit(repo,path.join(repo,folder+'request.json'));
  recordRequestDecision(repo,{id,spec:folder+'requirement.md',decision:'confirmed',approver:'evaluation-fixture',presence});
  start(repo,path.join(repo,folder+'requirement.md'));
  write(folder+'01-requirements.md',`## R1 · 값과 오류\n출처: REQ-1\n근거: "${requirement}"\n## 가정\n- 없음\n`);
  next(repo);
  write(folder+'02-analysis.md',`## 기존 시스템 분석\n${scenario==='new'?'새 기능':`src/value.js:1의 기존 순수 함수가 ${scenario==='fix'?'음수가 아니면 0을 반환한다':scenario==='enhance'?'음수도 1로 반환한다':'0 분기를 중복해서 처리한다'}. 외부 호출자는 없다.`}\n## 영향 범위\n| R | 파일 | 호출 | 파급 |\n|---|---|---|---|\n| R1 | src/value.js | 없음 | 순수 함수 동작 |\n## Risk\n음수 처리 누락\n`);
  next(repo);
  write(folder+'03-design.md','## 구성 요소\nCommonJS value 함수\n## 처리 흐름\n음수 거부 후 1 반환\n## API\nmodule.exports = value, 인자 n 하나\n## 데이터\n해당 없음 — 저장 없음\n## 설계 결정\n의존성 없는 순수 함수\n');
  write(folder+'04-functional.md','## 기능 정의\nR1 값과 오류\n## 업무 규칙\nn>=0이면 1\n## 예외\nn<0이면 Error("negative")\n## 수락 기준\n- AC-R1-1: 0과 2를 넣으면 1\n- AC-R1-2: -1을 넣으면 negative 오류\n');
  next(repo);
  write(folder+'07-test-spec.md','## 테스트 케이스\n| TC | 수준 | AC | 케이스 | 기대 결과 |\n|---|---|---|---|---|\n| TC-1 | Unit | AC-R1-1 | 0과 2 | 1 |\n| TC-2 | Unit | AC-R1-2 | -1 | negative 오류 |\n'+(kind==='fix'?'## 재현\n- TC-1\n':''));
  const files=[{stage:'code',path:'src/value.js',purpose:requirement,requirements:['R1']}];
  if(kind!=='refactor')files.push({stage:'test',path:'tests/value.test.js',purpose:'TC-1, TC-2 검증',requirements:['R1']});
  const plan={...(kind==='feature'?{domainName:'Value',domainLabel:'값',domainRoot:'',domainDirName:'value'}:{preserve:[{item:'value(n) 공개 함수 시그니처',how:'module.exports와 인자 n 유지'}]}),files,sequence:kind==='refactor'?[{step:'code',why:'기존 테스트 보존'}]:[{step:'test',why:'동작과 재현을 먼저 정의'},{step:'code',why:'검증할 동작 구현'}],approach:requirement,conventions:[],conflicts:[],openQuestions:[],reasoning:'독립 임시 저장소의 실모델 평가 fixture'};
  write(folder+'plan.json',JSON.stringify(plan));submitPlan(repo,path.join(repo,folder+'plan.json'));
  const work=loadWork(repo);
  recordDecision(repo,{order:work.order,target:work.active.target,plan:work.plan,manifest:work.manifest,docsHash:approvalDocsHash(work),decision:'approved',approver:'evaluation-fixture',presence});
  next(repo);
  return {scenario,kind,id,repo,approval:'test fixture; no human approval',scope:'model implementation, real tests, independent review and integration; input documents and approved plan are fixtures'};
}
function run(scenario) {
  const index=JSON.parse(fs.readFileSync(indexPath,'utf8'));
  const item=index.scenarios.find(s=>s.scenario===scenario);if(!item)throw Error('unknown scenario');
  const claude=process.env.CLAUDE_EVALUATION_BIN || path.join(os.homedir(),'.local','bin',process.platform==='win32'?'claude.exe':'claude');
  const prompt=`이 임시 저장소는 code-agent 실제 모델 평가입니다. 요구사항·공통문서·계획·승인은 명시적인 테스트 fixture입니다. 실제 사람의 승인으로 보고하지 마세요. 현재 승인된 구현 단계에서 시작합니다. code-agent status와 context를 읽고 승인한 순서대로 코드를 작성하세요. ca-next 단계 스킬에 따라 실제 check, test, 독립 ca-reviewer 호출(Agent 도구의 subagent_type=ca-reviewer), integrate까지 수행하세요. 리뷰 결과는 hook이 자동 기록하므로 직접 09-review.md를 조작하지 마세요. 필요한 단계에서 반복 next를 실행하세요. 작업 종류 ${item.kind}; refactor면 기존 테스트를 보존하고 fix면 repro가 먼저입니다. 완료 보고서 10-pr.md의 요약/확인 방법/위험·되돌리기를 작성하고 deliver 단계에서 멈추세요. 커밋·push·승인 명령은 호출하지 마세요. 출력은 결과와 막힌 이유를 간단히 보고하세요. Bash에서는 code-agent <하위명령> 형태를 사용하세요.`;
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const result=cp.spawnSync(claude,['-p',prompt,'--model','sonnet','--max-budget-usd','2','--output-format','json','--setting-sources','project','--permission-prompts','none','--allowedTools','Read,Edit,Write,Grep,Glob,Agent,Skill,Bash(code-agent *)'],{cwd:item.repo,encoding:'utf8',env,timeout:600000,maxBuffer:8*1024*1024,windowsHide:true});
  fs.writeFileSync(path.join(root,'dist',`model-${scenario}.json`),result.stdout||'');
  fs.writeFileSync(path.join(root,'dist',`model-${scenario}.stderr.log`),result.stderr||'');
  if(result.error)throw result.error;
  const work=loadWork(item.repo),evidence=loadEvidence(item.repo,item.id,work.active.target),review=loadReview(item.repo,item.id,work.active.target);
  const pr=path.join(item.repo,`doc/work/${item.id}/10-pr.md`);
  item.result={exitCode:result.status,phase:work.active.phase,stage:work.active.stage,tests:evidence?.testCases,integrationTests:evidence?.integrationTestCases,repro:evidence?.repro?.cases,reviewRounds:review?.rounds.map(r=>({round:r.round,treeHash:r.treeHash,observed:!!r.reviewer?.completedAt,agentId:r.reviewer?.agentId})),deliverProblems:deliverProblems(work,fs.existsSync(pr)?fs.readFileSync(pr,'utf8'):'')};
  fs.writeFileSync(path.join(root,'dist',`model-${scenario}-evidence.json`),JSON.stringify(item,null,2));console.log(JSON.stringify(item,null,2));
}
function collect() {
  const index=JSON.parse(fs.readFileSync(indexPath,'utf8'));
  const scenarios=index.scenarios.map(item=>{
    const model=JSON.parse(fs.readFileSync(path.join(root,'dist',`model-${item.scenario}.json`),'utf8'));
    const work=loadWork(item.repo),evidence=loadEvidence(item.repo,item.id,work.active.target),review=loadReview(item.repo,item.id,work.active.target);
    const git=(...args)=>cp.execFileSync('git',args,{cwd:item.repo,encoding:'utf8',stdio:'pipe'}).trim();
    const source=fs.readFileSync(path.join(item.repo,'src/value.js'),'utf8');
    const test=fs.readFileSync(path.join(item.repo,'tests/value.test.js'),'utf8');
    const baselineTest=git('ls-tree','--name-only',work.active.baseCommit,'--','tests/value.test.js');
    const report=fs.readFileSync(path.join(item.repo,`doc/work/${item.id}/10-pr.md`),'utf8');
    return {scenario:item.scenario,kind:item.kind,phase:work.active.phase,approval:item.approval,scope:item.scope,
      models:Object.keys(model.modelUsage||{}),reportedCostUSD:model.total_cost_usd,reportedDurationMs:model.duration_ms,
      modelReportedError:model.is_error||false,headUnchanged:git('rev-parse','HEAD')===work.active.baseCommit,
      baselineTestUnchanged:baselineTest?cp.execFileSync('git',['show',`${work.active.baseCommit}:tests/value.test.js`],{cwd:item.repo,encoding:'utf8',stdio:'pipe'})===test:null,
      generatedSource:source,testSource:test,
      tests:evidence.testCases,integrationTests:evidence.integrationTestCases,reproduction:evidence.repro,
      runs:evidence.runs.map(({phase,kind,outcome,status,at})=>({phase,kind,outcome,status,at})),
      review:review.rounds.map(({round,treeHash,reviewer})=>({round,treeHash,reviewer})),
      deliverProblems:deliverProblems(work,report)};
  });
  const output={at:new Date().toISOString(),claudeVersion:cp.execFileSync(process.env.CLAUDE_EVALUATION_BIN||path.join(os.homedir(),'.local','bin',process.platform==='win32'?'claude.exe':'claude'),['--version'],{encoding:'utf8'}).trim(),scenarios};
  const file=path.join(root,'doc/reviews/evidence/model-evaluation-2026-10-01.json');
  fs.writeFileSync(file,JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify(scenarios.map(s=>({scenario:s.scenario,phase:s.phase,baselineTestUnchanged:s.baselineTestUnchanged,headUnchanged:s.headUnchanged,blockers:s.deliverProblems})),null,2));
}
if(process.argv[2]==='prepare'){
  if(fs.existsSync(indexPath))throw Error('Existing evaluation preserved; move dist/model-evaluation.json to start a new run.');
  const scenarios=['new','enhance','fix','refactor'].map(seed);
  fs.writeFileSync(indexPath,JSON.stringify({at:new Date().toISOString(),scenarios},null,2));console.log(JSON.stringify(scenarios,null,2));
}else if(process.argv[2]==='run')run(process.argv[3]);else if(process.argv[2]==='collect')collect();else throw Error('Use prepare | run <scenario> | collect');
