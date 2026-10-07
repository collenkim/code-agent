/* 지운·옮긴 시험의 옛 산출물 정리 — tsc 는 지운 소스의 dist/test/*.test.js 를 지우지 않아 `node --test "dist/test/**\/*.test.js"` 가
 * 옛 파일을 계속 돌린다(시간 두 배·중복 실패). src/test 에 같은 상대 경로의 *.test.ts 가 없는 dist/test 의 *.test.js(와 짝 .map)를 지우고
 * 지운 목록을 한 줄씩 출력한다. npm test 가 tsc 다음에 부른다.
 */
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist', 'test'), src = path.join(root, 'src', 'test');
if (!fs.existsSync(dist)) process.exit(0);
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
for (const file of walk(dist)) {
  if (!file.endsWith('.test.js')) continue;
  const rel = path.relative(dist, file);
  if (fs.existsSync(path.join(src, rel.replace(/\.js$/, '.ts')))) continue;
  for (const stale of [file, `${file}.map`]) if (fs.existsSync(stale)) fs.rmSync(stale);
  console.log(`지움: dist/test/${rel.split(path.sep).join('/')}`);
}
