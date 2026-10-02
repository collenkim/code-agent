/* 실제 Codex 이벤트만 기록하는 격리 진단. 제품 상태나 관찰 이벤트를 합성하지 않는다. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { values } = require('node:util').parseArgs({ options: { standalone: { type: 'boolean' }, 'user-config': { type: 'boolean' }, 'project-config': { type: 'boolean' }, 'native-trust-path': { type: 'boolean' } } });
const root = path.resolve(__dirname, '..');
const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
if (fs.existsSync(path.join(home, 'hooks.json'))) throw Error('사용자 훅을 별도로 검토해야 합니다.');
const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
if (/^\s*\[\[?hooks[.\]]/m.test(config)) throw Error('사용자 인라인 훅을 별도로 검토해야 합니다.');
for (let parent = root; ; parent = path.dirname(parent)) {
  if (fs.existsSync(path.join(parent, '.codex/hooks.json'))) throw Error('상위 프로젝트 훅을 별도로 검토해야 합니다.');
  const file = path.join(parent, '.codex/config.toml');
  if (fs.existsSync(file) && /^\s*\[\[?hooks[.\]]/m.test(fs.readFileSync(file, 'utf8'))) throw Error('상위 인라인 훅을 별도로 검토해야 합니다.');
  if (parent === path.dirname(parent)) break;
}
const repo = fs.mkdtempSync(path.join(root, 'dist', 'codex-hook-probe-'));
cp.execFileSync('git', ['init', '--quiet'], { cwd: repo });
fs.mkdirSync(path.join(repo, '.codex'));
if (values['project-config']) fs.writeFileSync(path.join(repo, '.codex/config.toml'), '[features]\nhooks = true\n');
const capture = path.join(repo, 'capture.cjs'), log = path.join(repo, 'hooks.jsonl');
fs.writeFileSync(capture, `const fs=require('node:fs');const input=fs.readFileSync(0,'utf8');fs.appendFileSync(${JSON.stringify(log)},input.trim()+'\\n');process.stdout.write('{}');`);
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd'];
fs.writeFileSync(path.join(repo, '.codex/hooks.json'), JSON.stringify({ hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [{type:'command',command:`node "${capture.replace(/\\/g,'/')}"`}] }]])) }, null, 2));
const args = [path.join(process.env.APPDATA, 'npm/node_modules/@openai/codex/bin/codex.js'),
  ...(values.standalone ? ['--no-daemon'] : []), 'exec', '--ephemeral', ...(values['user-config'] ? [] : ['--ignore-user-config']), '--sandbox', 'workspace-write',
  '--enable', 'hooks', '--dangerously-bypass-hook-trust', '--json', '-c', 'windows.sandbox="unelevated"',
  '-c', `projects={${JSON.stringify(values['native-trust-path'] ? repo : repo.replace(/\\/g,'/'))}={trust_level="trusted"}}`,
  '--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="low"', '-C', repo, 'Reply with exactly OK. Do not use tools.'];
console.log(JSON.stringify({repo,standalone:!!values.standalone}));
const start = Date.now();
const result = cp.spawnSync(process.execPath, args, {cwd:repo,input:'',encoding:'utf8',timeout:60000,windowsHide:true});
fs.writeFileSync(path.join(repo, 'stdout.jsonl'), result.stdout || '');
fs.writeFileSync(path.join(repo, 'stderr.log'), result.stderr || '');
const observed = fs.existsSync(log) ? fs.readFileSync(log,'utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line)) : [];
const report = {repo,options:values,standalone:!!values.standalone,exitCode:result.status,error:result.error?.code,durationMs:Date.now()-start,events:observed.map(item=>item.hook_event_name)};
fs.writeFileSync(path.join(repo,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
if (!observed.length || result.status !== 0) process.exitCode=1;
