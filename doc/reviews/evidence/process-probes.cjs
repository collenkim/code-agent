// Review probes, not product changes. Run after npm run build.
// Uses temporary repositories; approvals below are explicit fixture records,
// not a claim that a real human/Claude Code session approved anything.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const mod = name => require(path.join(root, 'dist', name));
const commands = mod('agent/commands');
const request = mod('agent/request');
const docs = mod('agent/docs');
const docsCommands = mod('agent/docsCommands');
const workModule = mod('agent/work');
const evidence = mod('agent/evidence');
const review = mod('agent/review');
const validate = mod('agent/validate');
const delivery = mod('agent/deliver');
const { POLICY_KINDS, SCHEMAS } = mod('agent/schemas');
const { parseRequirements } = mod('agent/workDocs');
const { recordDecision } = mod('core/approval');
const { loadActive } = mod('agent/layout');
const results = [];
const temporaryParent = fs.realpathSync.native(os.tmpdir());
const fixtures = [];
const presence = { channel: 'tty', verified: true, detail: 'review fixture only' };
function temp() {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(temporaryParent, 'ca-process-review-')));
  fixtures.push(repo);
  return repo;
}
function write(repo, file, content) {
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}
function git(repo, ...args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Review Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function errorOf(fn) {
  try { fn(); return null; } catch (e) { return e.message; }
}
function manifest() {
  return {
    language: 'javascript', sourceExtensions: ['.js'], domainBase: 'src',
    conventions: ['doc/conventions.md'], docs: { architecture: 'doc/architecture.md' },
    build: ['node', '-e', 'process.exit(0)'], test: ['node', '--test'],
    stages: [
      { key: 'code', title: 'Code', template: 'doc/code.md', scope: 'project', outputDirs: ['src'] },
      { key: 'test', title: 'Test', template: 'doc/test.md', kind: 'test', scope: 'project', outputDirs: ['tests'] },
    ],
  };
}
function policy(repo) {
  for (const kind of POLICY_KINDS) {
    const schema = SCHEMAS[kind];
    const values = { levels: '- Unit: 필수', tools: '- `test`: 전체 테스트', static: '- `build`: 컴파일', security: '- 없음' };
    const body = schema.sections.map(s => `## ${s.heading}\n${values[s.id] || '- 검토용 설정'}`).join('\n');
    write(repo, schema.defaultPath, `# ${schema.label}\n${body}\n`);
  }
  for (const entry of docs.checkProjectDocs(repo, workModule.loadManifestIfAny(repo))) {
    docs.recordDocConfirmation(repo, entry, 'fixture', presence);
  }
}
function workDocs(repo) {
  const dir = 'doc/work/REVIEW-1/';
  write(repo, dir + '01-requirements.md', '# 요구사항\n## R1 · 값 반환\n근거: "값 1을 반환한다."\n## 가정\n- 없음\n');
  write(repo, dir + '02-analysis.md', '# 영향도\n## 기존 시스템 분석\n- 새 파일이다\n## 영향 범위\n| R | 파일 | 부르는 곳 | 파급 |\n|---|---|---|---|\n| R1 | src/app.js | 없음 | 새 기능 |\n## Risk\n- 없음\n');
  write(repo, dir + '03-design.md', '# 설계\n## 구성 요소\n- app 함수\n## 처리 흐름\n- 값 반환\n## API\n해당 없음 — 외부 접점 없음\n## 데이터\n해당 없음 — 저장 없음\n## 설계 결정\n- 순수 함수\n');
  write(repo, dir + '04-functional.md', '# 기능\n## 기능 정의\n- R1 값 반환\n## 업무 규칙\n- 없음\n## 예외\n- 없음\n## 수락 기준\n- AC-R1-1: 값 1을 반환한다\n');
  write(repo, dir + '07-test-spec.md', '# 테스트\n## 테스트 케이스\n| TC | 수준 | AC | 케이스 | 기대 결과 |\n|---|---|---|---|---|\n| TC-1 | Unit | AC-R1-1 | 함수 호출 | 1 |\n');
}
async function main() {
  const bare = temp();
  const missingManifest = errorOf(() => request.requestBegin(bare, 'REVIEW-0', 'feature'));
  assert.match(missingManifest, /code-agent.json/);
  results.push({ id: 'P01', observation: 'No manifest: request intake stops and refers to ca-adopt', error: missingManifest });

  write(bare, 'code-agent.json', JSON.stringify(manifest()));
  request.requestBegin(bare, 'REVIEW-0', 'feature');
  const startError = errorOf(() => commands.start(bare, path.join(bare, 'doc/work/REVIEW-0/requirement.md')));
  const docsError = errorOf(() => docsCommands.docsBegin(bare));
  assert.match(startError, /필수 문서/);
  assert.match(docsError, /접수 중/);
  results.push({ id: 'P02', observation: 'Missing policy allows intake, blocks start, and blocks docsBegin until intake is aborted', startError, docsError });

  const emptyGround = parseRequirements('## R1 · 임의 요구\n근거:\n## 가정\n- 없음\n');
  assert.deepEqual(emptyGround.keys, ['R1']);
  results.push({ id: 'P03', observation: 'Empty requirement citation accepted by parser', parsed: emptyGround });

  const counts = Object.fromEntries(POLICY_KINDS.map(k => [k, SCHEMAS[k].sections.reduce((n, s) => n + s.questions.length, 0)]));
  results.push({ id: 'P04', observation: 'Policy interview question catalog size, not measured questions per session', counts, total: Object.values(counts).reduce((a, b) => a + b, 0) });

  const repo = temp();
  git(repo, 'init', '-q', '-b', 'master');
  write(repo, 'code-agent.json', JSON.stringify(manifest(), null, 2));
  write(repo, '.gitignore', '.code-agent/active.json\n.code-agent/docs-session.json\n.code-agent/request-session.json\n.code-agent/log/\n');
  policy(repo);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'review fixture baseline');
  const spec = 'doc/work/REVIEW-1/requirement.md';
  write(repo, spec, '---\nkind: feature\nid: REVIEW-1\ntitle: 값 반환\ntarget: app\n---\n값 1을 반환한다.\n입력 오류는 거부한다.\n');
  request.recordRequestDecision(repo, { id: 'REVIEW-1', spec, decision: 'confirmed', approver: 'fixture', presence });
  commands.start(repo, path.join(repo, spec));
  workDocs(repo);
  commands.next(repo); commands.next(repo); commands.next(repo);
  const plan = {
    domainName: 'App', domainLabel: '앱', domainRoot: '', domainDirName: 'app',
    files: [
      { stage: 'code', path: 'src/app.js', purpose: '값 반환', requirements: ['R1'] },
      { stage: 'test', path: 'tests/app.test.js', purpose: '값 확인', requirements: ['R1'] },
    ],
    sequence: [{ step: 'not-a-real-task', why: '' }], approach: '순수 함수',
    conventions: [], conflicts: [], openQuestions: [], reasoning: 'review fixture',
  };
  const draft = 'doc/work/REVIEW-1/plan.json';
  write(repo, draft, JSON.stringify(plan));
  commands.submitPlan(repo, path.join(repo, draft));
  results.push({ id: 'P05', observation: 'Plan submission accepts an unrelated sequence step and empty why', sequence: plan.sequence });
  plan.sequence = [{ step: 'test', why: '테스트 먼저' }, { step: 'code', why: '구현 다음' }];
  write(repo, draft, JSON.stringify(plan));
  commands.submitPlan(repo, path.join(repo, draft));
  const work = workModule.loadWork(repo);
  recordDecision(repo, { order: work.order, target: work.active.target, plan: work.plan, manifest: work.manifest,
    docsHash: workModule.approvalDocsHash(work), decision: 'approved', approver: 'fixture', presence });
  commands.next(repo);
  assert.equal(loadActive(repo).stage, 'code');
  results.push({ id: 'P06', observation: 'Feature cursor follows manifest order, not approved sequence', approvedSequence: plan.sequence, actualFirstStage: loadActive(repo).stage });
  write(repo, 'src/app.js', 'module.exports = () => 0;\n');
  commands.next(repo);
  write(repo, 'tests/app.test.js', "const test = require('node:test');\nconst assert = require('node:assert/strict');\ntest.skip('TC-1 returns 1', () => assert.equal(require('../src/app')(), 1));\n");
  commands.next(repo);
  await validate.check(commands.requireValidatable(repo, 'check'));
  commands.next(repo);
  await validate.runTests(commands.requireValidatable(repo, 'test'));
  const current = workModule.loadWork(repo);
  const problems = evidence.stageProblems(current, 'test');
  assert.deepEqual(problems, []);
  const proof = evidence.loadEvidence(repo, 'REVIEW-1', 'app');
  results.push({ id: 'P07', observation: 'A real node:test skipped failing assertion is accepted by test gate',
    testRuns: evidence.runsOf(proof, 'test'), cases: proof.testCases, gateProblems: problems,
    actualReturn: 0, requiredReturn: 1 });
  commands.next(repo);
  review.openRound(commands.requireValidatable(repo, 'review'));
  const reviewPath = review.reviewDocFile('REVIEW-1');
  write(repo, reviewPath, fs.readFileSync(path.join(repo, reviewPath), 'utf8').replace('## 지적\n', '## 지적\n\n- 없음\n'));
  const reviewProblems = review.reviewProblems(workModule.loadWork(repo));
  assert.deepEqual(reviewProblems, []);
  results.push({ id: 'P08', observation: 'Review gate checks record and findings; it does not attest that ca-reviewer actually ran', gateProblems: reviewProblems });
  results.push({ id: 'P09', observation: 'Frozen planned test labeled outside by reviewer instruction is reclassified inside by code',
    parsed: review.parseFindings('| F1 | tests/app.test.js | 계획 밖 | 열림 | 테스트 오류 |', ['tests/app.test.js']) });
  commands.next(repo);
  await validate.integrate(commands.requireValidatable(repo, 'integrate'));
  commands.next(repo);
  const finalWork = commands.requireValidatable(repo, 'deliver');
  const finalProblems = delivery.deliverProblems(finalWork, '## 요약\n검토용 코드\n## 확인 방법\n반환값 확인\n## 위험·되돌리기\n검토용 임시 저장소\n');
  assert.deepEqual(finalProblems, []);
  results.push({ id: 'P10', observation: 'Skipped TC also passes clean-worktree integration and automated delivery checks; no final TTY confirmation or delivery commit performed',
    phase: loadActive(repo).phase, gateProblems: finalProblems, integrationRuns: evidence.runsOf(evidence.loadEvidence(repo, 'REVIEW-1', 'app'), 'integrate') });
  results.push({ id: 'P11', observation: 'A second sentence in the confirmed requirement has no R/AC/TC; automated delivery checks still pass',
    omittedSentence: '입력 오류는 거부한다.', analyzedRequirementKeys: ['R1'], gateProblems: finalProblems });
}
main().then(() => {
  const report = { generatedAt: new Date().toISOString(), node: process.version, note: 'Fixture approvals; no live Claude Code session. PASS means observation reproduced, not product meets requirement.', results };
  fs.writeFileSync(path.join(__dirname, 'process-probes.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}).catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  // Delete only exact fixture directories created above, checked inside the temp root.
  for (const repo of fixtures) {
    const relative = path.relative(temporaryParent, fs.realpathSync.native(repo));
    if (!relative.startsWith('ca-process-review-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unsafe fixture path');
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
