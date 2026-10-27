import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const scripts = resolve(__dirname, "../../scripts");

test("세션 복원 평가 결과는 과거 보고서 없이 처음 저장하고 최신 결과로 다시 읽는다", () => {
  const root = mkdtempSync(join(tmpdir(), "ca-recovery-report-"));
  try {
    const source = readFileSync(join(scripts, "evaluate-session-recovery.cjs"), "utf8");
    const setup = source.slice(0, source.indexOf("function verify("));
    const context = {
      __dirname: join(root, "scripts"), process: { argv: ["node", "evaluate-session-recovery.cjs", "dist"] },
      require: (name: string) => name === "./live-eval-guard.cjs" ? () => {} : require(name),
      report: { passed: false, session: "test-session", error: "interrupted" },
    };
    runInNewContext(`${setup}\nsaveRecoveryReport(report);`, context);
    const file = join(root, "doc/reviews/evidence/session-recovery-live.json");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), context.report);
    const completed = { passed: true, session: "test-session", memoryPreserved: true };
    runInNewContext(`${setup}\nsaveRecoveryReport(report);`, { ...context, report: completed });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), completed);
    assert.deepEqual(readdirSync(join(root, "doc/reviews/evidence")), ["session-recovery-live.json"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("실제 모델 평가의 기본 실행과 --help는 모델·빌드 산출물 없이 안내만 낸다", () => {
  const root = mkdtempSync(join(tmpdir(), "ca-script-guard-"));
  try {
    copyFileSync(join(scripts, "live-eval-guard.cjs"), join(root, "live-eval-guard.cjs"));
    const names = readdirSync(scripts).filter(name => name.startsWith("evaluate-") || name === "diagnose-codex-hooks.cjs");
    const env = { ...process.env }; delete env.CODE_AGENT_LIVE_EVAL;
    for (const name of names) {
      const file = join(root, name); copyFileSync(join(scripts, name), file);
      for (const enabled of [false, true]) {
        const text = execFileSync(process.execPath, [file, ...(enabled ? ["--help"] : [])],
          { cwd: root, encoding: "utf8", env: { ...env, ...(enabled ? { CODE_AGENT_LIVE_EVAL: "1" } : {}) } });
        assert.match(text, /CODE_AGENT_LIVE_EVAL=1/);
      }
    }
    assert.deepEqual(readdirSync(root).sort(), [...names, "live-eval-guard.cjs"].sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("시험 산출물 정리는 삭제된 fixture도 지우고 소스가 있는 파일과 비JS 파일은 남긴다", () => {
  const root = mkdtempSync(join(tmpdir(), "ca-script-prune-"));
  try {
    for (const dir of ["scripts", "src/test/nested", "dist/test/nested"]) mkdirSync(join(root, dir), { recursive: true });
    copyFileSync(join(scripts, "prune-dist-tests.cjs"), join(root, "scripts/prune-dist-tests.cjs"));
    writeFileSync(join(root, "src/test/nested/liveFixture.ts"), "");
    for (const name of ["old.test.js", "oldFixture.js", "nested/liveFixture.js", "keep.json"]) writeFileSync(join(root, "dist/test", name), "");
    execFileSync(process.execPath, [join(root, "scripts/prune-dist-tests.cjs")], { cwd: root });
    assert.equal(existsSync(join(root, "dist/test/old.test.js")), false);
    assert.equal(existsSync(join(root, "dist/test/oldFixture.js")), false);
    assert.equal(existsSync(join(root, "dist/test/nested/liveFixture.js")), true);
    assert.equal(existsSync(join(root, "dist/test/keep.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
