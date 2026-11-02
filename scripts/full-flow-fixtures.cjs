// 유료 호스트를 부르지 않는 평가용 준비·진척 판정. 제품 CLI의 판정을 재사용한다.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const { hasBaseline, pendingBaselineFiles, setupBaseline } = require('../dist/agent/bootstrap');
const { loadActive } = require('../dist/agent/layout');
const { loadWork } = require('../dist/agent/work');

function prepareBaseline(repo) {
  if (!loadActive(repo) && (!hasBaseline(repo) || pendingBaselineFiles(repo).length)) {
    setupBaseline(repo);
    return true;
  }
  return false;
}

// status 조회로 늘어나는 hook/usage 로그·임대 heartbeat는 진척으로 세지 않는다.
function progressKey(repo) {
  const hash = crypto.createHash('sha256');
  const add = relative => {
    const full = path.join(repo, relative);
    if (!fs.existsSync(full)) return;
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) for (const name of fs.readdirSync(full).sort()) add(path.join(relative, name));
    else if (stat.isFile()) hash.update(relative).update('\0').update(fs.readFileSync(full)).update('\0');
  };
  // 설정 초안이 아직 유효하지 않아도 그 수정은 진척이다. 내용 해시에 스키마 파싱을 요구하지 않는다.
  for (const file of ['doc', '.code-agent/work', '.code-agent/approvals', 'code-agent.json', '.code-agent/execution.json']) add(file);
  const work = loadWork(repo);
  hash.update(JSON.stringify(loadActive(repo) ?? null));
  for (const file of work?.plan?.files ?? []) add(file.path);
  const head = cp.spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true });
  hash.update(head.status === 0 ? head.stdout.trim() : 'no-head');
  return hash.digest('hex');
}

function requireSupportedHost(host) {
  if (host === 'codex') throw Error('Codex 전체 흐름 평가는 현재 지원하지 않습니다: workspace-write / approval_policy=never에는 작업 브랜치·통합 worktree의 Git 쓰기 권한 응답 경로가 없습니다. 준비 커밋·최종 반영 fixture만으로 해결되지 않습니다. 대화형 또는 권한 전달을 지원하는 관리 실행으로 검증하세요. 유료 호스트는 호출하지 않았습니다.');
}

function stalledProgress(previous, current, stalled = 0) {
  return previous === current ? stalled + 1 : 0;
}
module.exports = { prepareBaseline, progressKey, requireSupportedHost, stalledProgress };
