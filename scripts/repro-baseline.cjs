/* 재현 시나리오 기준선 — 한 빌드의 dist 로 같은 fixture(test/reproScenarios.js)를 돌려 사실·소요·실행 타임라인 요약을 JSON 으로 내고, 두 결과를 비교한다.
 * 사용: node scripts/repro-baseline.cjs [--dist <dist 폴더>] [--repeat <횟수>] [--only <이름,…>] [--out <파일>]
 *       node scripts/repro-baseline.cjs --compare <전.json> <후.json>
 * 개선 전후 비교: 고치기 전 빌드로 --out 전.json, 고친 뒤 빌드로 --out 후.json 을 만들고 --compare 한다. 다른 체크아웃의 빌드는 그 dist 폴더를 --dist 로 준다.
 * fixture 는 시나리오·저장소 모듈 해시로 가린다 — 다르면 비교가 알린다. 시나리오마다 새 임시 저장소를 만들고 지운다. 모델을 부르지 않는다.
 * 결과에는 시나리오가 관찰한 사실과 타임라인 요약만 싣는다(지시서·담당 결과·대화 본문은 싣지 않는다).
 */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

const USAGE = '사용법: node scripts/repro-baseline.cjs [--dist <dist 폴더>] [--repeat <횟수>] [--only <이름,…>] [--out <파일>] | --compare <전.json> <후.json>';
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };

if (args[0] === '--compare') {
  if (args.length !== 3) { console.error(USAGE); process.exit(1); }
  compare(...args.slice(1).map(file => JSON.parse(fs.readFileSync(file, 'utf8'))));
  process.exit(0);
}
const dist = path.resolve(option('--dist') ?? path.join(__dirname, '..', 'dist'));
const repeat = Number(option('--repeat') ?? 1);
const scenarios = path.join(dist, 'test', 'reproScenarios.js');
if (!Number.isInteger(repeat) || repeat < 1 || !fs.existsSync(scenarios)) {
  console.error(fs.existsSync(scenarios) ? USAGE : `${scenarios} 가 없습니다 — 그 체크아웃에서 npm run build 를 먼저 실행하세요.`);
  process.exit(1);
}
const { SCENARIOS, runScenario } = require(scenarios);
const names = option('--only')?.split(',') ?? Object.keys(SCENARIOS);
const unknown = names.filter(name => !(name in SCENARIOS));
if (unknown.length) { console.error(`없는 시나리오: ${unknown.join(', ')} — ${Object.keys(SCENARIOS).join(', ')}`); process.exit(1); }

const fixture = crypto.createHash('sha256');
for (const file of ['reproScenarios.js', 'planningRepo.js']) fixture.update(fs.readFileSync(path.join(dist, 'test', file)));
const results = names.map(name => {
  const runs = Array.from({ length: repeat }, () => runScenario(name));
  const wall = runs.map(run => run.wallMs).sort((a, b) => a - b);
  return {
    name, title: runs[0].title, facts: runs[0].facts,
    // 반복마다 사실이 같은가 — 다르면 시간 비교보다 이것을 먼저 본다
    stable: runs.every(run => JSON.stringify(run.facts) === JSON.stringify(runs[0].facts)),
    wallMs: { runs: wall, median: wall[Math.floor(wall.length / 2)], min: wall[0], max: wall.at(-1) },
    timeline: runs[0].timeline,
  };
});
const report = { at: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`, dist: path.relative(process.cwd(), dist).replace(/\\/g, '/') || '.',
  runtime: results.length ? require(path.join(dist, 'agent', 'timeline.js')).runtimeLabel() : undefined,
  fixture: `sha256:${fixture.digest('hex').slice(0, 16)}`, repeat, scenarios: results };
const out = option('--out');
if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`); }
console.log(out ? `${out} 에 썼습니다 — ${summaryLine(report)}` : JSON.stringify(report, null, 2));

function summaryLine(value) {
  return value.scenarios.map(item => `${item.name} ${item.wallMs.median}ms${item.stable ? '' : '(사실이 반복마다 다름)'}`).join(' · ');
}

/** 시나리오마다 바뀐 사실, 소요 중앙값, 타임라인 분류 시간(우선순위 귀속)·대기 수의 전후 */
function compare(before, after) {
  console.log(`전: ${before.runtime} · ${before.at} · ${before.fixture}\n후: ${after.runtime} · ${after.at} · ${after.fixture}`);
  if (before.fixture !== after.fixture) console.log('주의: fixture 가 다릅니다 — 같은 시나리오 모듈로 돌린 결과가 아닙니다.');
  const sum = (timeline, read) => (timeline ?? []).reduce((total, work) => total + read(work), 0);
  for (const item of after.scenarios) {
    const prior = before.scenarios.find(entry => entry.name === item.name);
    if (!prior) { console.log(`\n${item.name}: 전 결과에 없습니다`); continue; }
    console.log(`\n${item.name} — ${item.title}`);
    const keys = [...new Set([...Object.keys(prior.facts), ...Object.keys(item.facts)])];
    const changed = keys.filter(key => JSON.stringify(prior.facts[key]) !== JSON.stringify(item.facts[key]));
    console.log(changed.length ? changed.map(key => `  사실 ${key}: ${JSON.stringify(prior.facts[key])} → ${JSON.stringify(item.facts[key])}`).join('\n') : '  사실: 같음');
    console.log(`  소요 중앙값: ${prior.wallMs.median}ms → ${item.wallMs.median}ms`);
    for (const category of ['agent', 'build-test', 'human', 'external', 'host-resume']) {
      const [a, b] = [prior, item].map(entry => sum(entry.timeline, work => work.categories[category].exclusiveMs));
      const [ca, cb] = [prior, item].map(entry => sum(entry.timeline, work => work.categories[category].count));
      if (a || b || ca || cb) console.log(`  ${category}: ${a}ms(${ca}) → ${b}ms(${cb})`);
    }
    const reasons = entry => (entry.timeline ?? []).flatMap(work => work.waits.map(wait => `${wait.category}:${wait.reason}${wait.human ? '(사람 입력)' : ''}`));
    console.log(`  대기: ${JSON.stringify(reasons(prior))} → ${JSON.stringify(reasons(item))}`);
  }
}
