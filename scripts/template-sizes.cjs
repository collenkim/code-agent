/* 템플릿 크기 — 파일별 LF 글자 수와 Claude·Codex 흐름 합계. 파일을 쓰지 않는다.
 * 사용: node scripts/template-sizes.cjs [--suggest] [--ref <git 커밋> [--ref-dist <그 커밋 빌드의 dist 폴더>]]
 *   --suggest   src/test/templateBudget.test.ts 의 BUDGET(파일별 ceil(n×1.03/100)×100)·흐름 합계 예산(ceil(합×1.02/100)×100) 리터럴을 낸다
 *   --ref       그 커밋의 template/ 를 센다(Claude). Codex 사본은 그 커밋의 codexText 로 만들어야 하므로 --ref-dist 가 없으면 Codex 합계를 내지 않는다
 *   --ref-dist  그 커밋을 빌드한 dist 폴더 — 그 빌드의 hostAssets("codex")(같은 패키지의 template/)로 Codex 합계를 센다
 * --ref 가 없으면 Codex 합계는 이 저장소 dist/agent/hosts.js 의 hostAssets("codex") 로 센다(빌드 필요).
 */
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const ref = option('--ref');
const refDist = option('--ref-dist');
if (refDist && !ref) { console.error('--ref-dist 는 --ref 와 함께 씁니다.'); process.exit(1); }
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
/** Codex 흐름 합계 — 빌드(dist)의 hostAssets 와 그 패키지의 CODEX.block. --ref 인데 그 빌드가 없으면 세지 않는다(지금 트리를 섞지 않는다) */
const codexDist = ref ? (refDist ? path.resolve(refDist) : undefined) : path.join(root, 'dist');
let codexTotal, codexNote;
if (!codexDist) codexNote = 'Codex 흐름 합계 생략 — --ref 의 Codex 사본은 그 커밋의 codexText 가 만든다. 그 커밋을 빌드한 dist 를 --ref-dist 로 주면 센다';
else {
  try {
    const { hostAssets } = require(path.join(codexDist, 'agent/hosts.js'));
    const assets = hostAssets('codex');
    const codexFiles = FLOW_SKILLS.map(name => `.agents/skills/${name}/SKILL.md`);
    codexTotal = codexFiles.reduce((sum, key) => sum + lf(assets.get(key) ?? '').length, 0) + lf(fs.readFileSync(path.join(codexDist, '..', 'template/CODEX.block.md'), 'utf8')).length;
  } catch (error) { codexNote = `Codex 흐름 합계를 세지 못했습니다(${codexDist}): ${error.message.split('\n')[0]}`; }
}
if (args.includes('--suggest')) {
  const budget = n => Math.ceil(n * 1.03 / 100) * 100;
  console.log('const BUDGET: Record<string, number> = {');
  for (const [file, n] of Object.entries(table)) console.log(`  ${JSON.stringify(file)}: ${budget(n)},`);
  console.log('};');
  console.log(`const FLOW_BUDGET = ${Math.ceil(flowTotal * 1.02 / 100) * 100};`);
  if (codexTotal !== undefined) console.log(`const CODEX_FLOW_BUDGET = ${Math.ceil(codexTotal * 1.02 / 100) * 100};`);
} else {
  for (const [file, n] of Object.entries(table)) console.log(`${String(n).padStart(7)}  ${file}`);
  console.log(`${String(flowTotal).padStart(7)}  (Claude 흐름 합계 — CLAUDE.block + 스킬 12${ref ? `, ${ref}` : ''})`);
  if (codexTotal !== undefined) console.log(`${String(codexTotal).padStart(7)}  (Codex 흐름 합계 — CODEX.block + .agents 스킬 12, ${ref ? `${ref} 빌드 ${codexDist}` : '지금 빌드'}의 codexText)`);
}
if (codexNote) console.error(codexNote);
