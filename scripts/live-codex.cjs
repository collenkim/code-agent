// 선택 실행 검사 전용: 생성한 임시 프로젝트 hook만 검토해 이번 호출에 신뢰한다.
// 사용자 설정·권한·인증 파일을 바꾸지 않는다. 제품의 관리 실행은 이 도우미를 사용하지 않는다.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
module.exports = function liveCodex(root, repo, cli, session) {
  if (path.dirname(repo) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(repo).startsWith('ca-full-')) throw Error('Disposable full-flow repository required');
  const inline = /^\s*\[\[?hooks(?:\]|\.(?!state[.\]]))/m;
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (fs.existsSync(path.join(home, 'hooks.json'))) throw Error('User hooks require separate review');
  const config = fs.existsSync(path.join(home, 'config.toml')) ? fs.readFileSync(path.join(home, 'config.toml'), 'utf8') : '';
  if (inline.test(config)) throw Error('User inline hooks require separate review');
  const localConfig = path.join(repo, '.codex/config.toml');
  if (fs.existsSync(localConfig) && inline.test(fs.readFileSync(localConfig, 'utf8'))) throw Error('Project inline hooks require separate review');
  for (let parent = path.dirname(repo); ; parent = path.dirname(parent)) {
    const c = path.join(parent, '.codex/config.toml');
    if (fs.existsSync(path.join(parent, '.codex/hooks.json')) || fs.existsSync(c) && inline.test(fs.readFileSync(c, 'utf8'))) throw Error('Parent hooks require separate review');
    if (parent === path.dirname(parent)) break;
  }
  const installed = JSON.parse(fs.readFileSync(path.join(repo, '.codex/hooks.json'), 'utf8')).hooks;
  const { CODEX_EVENTS, codexWindowsCommand } = require(path.join(root, 'dist/agent/init'));
  const hooks = Object.values(installed).flat().flatMap(group => group.hooks);
  const expected = `node "${cli.replace(/\\/g, '/')}" codex-event`;
  if (hooks.length !== CODEX_EVENTS.length || Object.keys(installed).length !== CODEX_EVENTS.length || CODEX_EVENTS.some(event => {
    const group = installed[event]; const h = group?.[0]?.hooks?.[0];
    return group?.length !== 1 || group[0].hooks.length !== 1 || h.type !== 'command' || h.command !== expected + (event === 'PreToolUse' ? ' || exit 2' : '') || h.commandWindows !== codexWindowsCommand(event, cli);
  })) throw Error('Only generated code-agent hooks are allowed');
  const windows = config.match(/^\[windows\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1]?.match(/^\s*sandbox\s*=\s*"(elevated|unelevated)"/m)?.[1];
  if (process.platform === 'win32' && !windows) throw Error('Existing Windows sandbox setting required');
  const prefix = process.platform === 'win32' ? [path.join(process.env.APPDATA, 'npm/node_modules/@openai/codex/bin/codex.js')] : [];
  return { command: process.platform === 'win32' ? process.execPath : 'codex', args: [...prefix, 'exec',
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=false',
    '--ignore-user-config', '--enable', 'hooks', '--enable', 'multi_agent', '--dangerously-bypass-hook-trust',
    '-c', `projects={${JSON.stringify(repo)}={trust_level="trusted"}}`, ...(windows ? ['-c', `windows.sandbox=${JSON.stringify(windows)}`] : []),
    ...(session ? ['resume', session] : []), '--json', '-'] };
};
