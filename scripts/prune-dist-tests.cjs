/* 지운·옮긴 시험과 도우미의 옛 산출물 정리 — tsc는 소스가 지워져도 산출물을 남긴다.
 * src/test에 같은 상대 경로의 .ts가 없는 dist/test의 .js를 지우고
 * 지운 목록을 한 줄씩 출력한다. npm test 가 tsc 다음에 부른다.
 */
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist', 'test'), src = path.join(root, 'src', 'test');
if (!fs.existsSync(dist)) process.exit(0);
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
for (const file of walk(dist)) {
  if (!file.endsWith('.js')) continue;
  const rel = path.relative(dist, file);
  if (fs.existsSync(path.join(src, rel.replace(/\.js$/, '.ts')))) continue;
  fs.rmSync(file);
  console.log(`지움: dist/test/${rel.split(path.sep).join('/')}`);
}
