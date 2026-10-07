/* 템플릿 크기 — 파일별 LF 글자 수와 Claude·Codex 흐름 합계. 파일을 쓰지 않는다.
 * 사용: node scripts/template-sizes.cjs [--suggest] [--ref <git 커밋>]
 *   --suggest  src/test/templateBudget.test.ts 의 BUDGET(파일별 ceil(n×1.03/100)×100)·흐름 합계 예산(ceil(합×1.02/100)×100) 리터럴을 낸다
 *   --ref      그 커밋의 template/ 를 센다(Claude 만 — Codex 사본은 지금 빌드의 codexText 로 만든다)
 * Codex 합계는 dist/agent/hosts.js 의 hostAssets("codex") 로 센다(빌드 필요).
 */
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const ref = args.includes('--ref') ? args[args.indexOf('--ref') + 1] : undefined;
const lf = text => text.split('\r\n').join('\n');
/** template/ 아래 모든 .md 의 LF 글자 수 */
function sizes() {
  const out = {};
  if (ref) {
    const files = cp.execFileSync('git', ['ls-tree', '-r', '--name-only', ref, 'template'], { cwd: root, encoding: 'utf8' }).split('\n').filter(file => file.endsWith('.md'));
    for (const file of files) out[file] = lf(cp.execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8' })).length;
    return out;
  }
  const walk = dir => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.md')) out[rel] = lf(fs.readFileSync(path.join(root, rel), 'utf8')).length;
    }
  };
  walk('template');
  return out;
}
/** 감사·토큰 효율 기록과 같은 흐름 13개(Claude) — templateBudget.test.ts 의 FLOW 와 같은 목록 */
const FLOW_SKILLS = ['ca-request', 'ca-answer', 'ca-next', 'ca-analyze', 'ca-impact', 'ca-design', 'ca-plan', 'ca-implement', 'ca-check', 'ca-test', 'ca-review', 'ca-integrate'];
const FLOW = ['template/CLAUDE.block.md', ...FLOW_SKILLS.map(name => `template/claude/skills/${name}/SKILL.md`)];
const table = sizes();
const flowTotal = FLOW.reduce((sum, file) => sum + (table[file] ?? 0), 0);
let codexTotal;
try {
  const { hostAssets } = require(path.join(root, 'dist/agent/hosts.js'));
  const assets = hostAssets('codex');
  const codexFiles = FLOW_SKILLS.map(name => `.agents/skills/${name}/SKILL.md`);
  codexTotal = codexFiles.reduce((sum, key) => sum + lf(assets.get(key) ?? '').length, 0) + lf(fs.readFileSync(path.join(root, 'template/CODEX.block.md'), 'utf8')).length;
} catch { codexTotal = undefined; }
if (args.includes('--suggest')) {
  const budget = n => Math.ceil(n * 1.03 / 100) * 100;
  console.log('const BUDGET: Record<string, number> = {');
  for (const [file, n] of Object.entries(table)) console.log(`  ${JSON.stringify(file)}: ${budget(n)},`);
  console.log('};');
  console.log(`const FLOW_BUDGET = ${Math.ceil(flowTotal * 1.02 / 100) * 100};`);
  if (codexTotal !== undefined) console.log(`const CODEX_FLOW_BUDGET = ${Math.ceil(codexTotal * 1.02 / 100) * 100};`);
} else {
  for (const [file, n] of Object.entries(table)) console.log(`${String(n).padStart(7)}  ${file}`);
  console.log(`${String(flowTotal).padStart(7)}  (Claude 흐름 합계 — CLAUDE.block + 스킬 12)`);
  if (codexTotal !== undefined) console.log(`${String(codexTotal).padStart(7)}  (Codex 흐름 합계 — CODEX.block + .agents 스킬 12, 지금 빌드의 codexText)`);
}
