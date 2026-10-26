import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCrossProcess } from "../agent/crossProcess";
import { applyEntry, existingEntry, parseProposal } from "../agent/knowledge";
import { pidAlive } from "../agent/lock";
import { sensitiveProblems } from "../agent/sensitiveText";
import { parseTestResults, resultFor } from "../agent/testResults";

test("2-8 Jest 실패·생략 글리프를 TC 결과로 읽는다", () => {
  const results = parseTestResults("✕ TC-1 fails\n○ TC-2 skipped\n✓ TC-3 passes");
  assert.deepEqual([1, 2, 3].map(n => resultFor(`TC-${n}`, results).status), ["failed", "skipped", "passed"]);
});

test("2-8 알려진 토큰 접두어와 연결 문자열·암호문구를 기록에서 거부한다", () => {
  for (const value of ["glpat-" + "a".repeat(20), "AIza" + "a".repeat(35), "sk_live_" + "a".repeat(24), "rk_live_" + "a".repeat(24),
    "npm_" + "a".repeat(36), "xapp-" + "a".repeat(20), "AccountKey=not-a-real-key", "SharedAccessSignature=sv=2026&sig=example", "passphrase=example-only"]) {
    assert.ok(sensitiveProblems({ note: value }).length > 0, value.split(/[=_-]/)[0]);
  }
});

test("2-8 KNOWLEDGE의 일반 소제목은 항목에 남고 새 키는 종류 절에 들어간다", () => {
  const before = "# 지식\n\n## features\n\n### `A` 기능\n본문\n### 예시\n유지할 예시\n\n## flows\n\n## 변경 이력\n기록\n";
  assert.match(existingEntry(before, "A")!, /유지할 예시/);
  const entry = parseProposal("## features\n### `B` 새 기능\n근거 R1\n", ["R1"]).entries[0];
  const after = applyEntry(before, entry);
  assert.ok(after.indexOf("### `B`") < after.indexOf("## flows"));
  assert.match(after, /## 변경 이력\n기록/);
});

test("2-8 교차 감독은 출력·종료 코드와 실행 파일 없음 오류를 보존한다", () => {
  const result = runCrossProcess(process.execPath, ["-e", "console.log('result');console.error('detail');process.exit(3)"], tmpdir(), process.env, 5000);
  assert.equal(result.status, 3); assert.match(result.stdout, /result/); assert.match(result.stderr, /detail/);
  assert.equal(runCrossProcess(join(tmpdir(), "no-such-cross-command"), [], tmpdir(), process.env, 1000).error?.code, "ENOENT");
});

test("2-8 교차 시간 초과는 래퍼의 자식 프로세스까지 끝낸다", () => {
  const root = mkdtempSync(join(tmpdir(), "ca-cross-tree-"));
  try {
    writeFileSync(join(root, "wrapper.cjs"), "const fs=require('fs'),{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('child.pid',String(c.pid));setInterval(()=>{},1000);");
    const result = runCrossProcess(process.execPath, [join(root, "wrapper.cjs")], root, process.env, 1500);
    assert.equal(result.error?.code, "ETIMEDOUT");
    const pid = Number(readFileSync(join(root, "child.pid"), "utf8"));
    for (let n = 0; n < 20 && pidAlive(pid); n += 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    assert.equal(pidAlive(pid), false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
