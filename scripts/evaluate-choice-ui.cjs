require('./live-eval-guard.cjs')('node scripts/evaluate-choice-ui.cjs');
/** 수동 키보드 검증: npm run build 후 node scripts/evaluate-choice-ui.cjs.
 * 실제 Codex TUI를 임시 저장소에서 연다. UI·MCP·hook 신뢰 및 선택은 사람이 조작한다.
 * 모델·사용자 전역 설정을 덮어쓰지 않는다. 임시 저장소와 기록은 검증 후 확인용으로 남긴다.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const base = path.resolve(__dirname, '..');
const { hostCommand } = require('../dist/agent/hosts');
const { init } = require('../dist/agent/init');
const { setupConsentProject } = require('../dist/test/consentFixture');
const command = hostCommand('codex');
if (typeof command === 'string') throw new Error(command);
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-choice-ui-')));
setupConsentProject(root);
init(root, { host: 'codex', cli: path.join(base, 'dist/agent/cli.js') });
const prompt = 'Synthetic disposable UI regression test. Call code_agent.ask with two questions: Display style (Compact, Detailed) and Theme (Light, Dark). Wait for the actual user selection. Then run code-agent consent prepare --action setup --for codex (use code-agent.cmd in PowerShell), show its complete summary, call code_agent.confirm with only the returned id and wait for the real user response. If approved run consent finish. If .git is read-only in the sandbox, request escalation on the FIRST finish because setup commits the synthetic baseline. Never retry a failed ID; stop and report failure. Never fabricate UI answers or use consent respond. Stop after reporting the applied status. Do not change models, bypass hooks, or edit files manually.';
console.log(`임시 UI 검증 저장소: ${root}\n프로젝트 hook을 검토한 뒤 신뢰하세요. 질문은 방향키·Enter로 선택하고 결과를 확인합니다.`);
const trust = JSON.stringify(root);
const child = cp.spawn(command.file, [...command.prefix, '--no-daemon', '--no-alt-screen', '-s', 'workspace-write', '-a', 'on-request', '-c', `projects={${trust}={trust_level="trusted"}}`, '-C', root, prompt], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => {
  const dir = path.join(root, '.code-agent/consents');
  const records = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => {
    const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    return { id: record.id, status: record.status, channel: record.channel, failure: record.failure };
  }) : [];
  console.log(JSON.stringify({ root, records, verification: '키보드 조작·화면 표시는 검사자가 별도로 확인해야 함' }, null, 2));
  process.exitCode = code ?? 1;
});
