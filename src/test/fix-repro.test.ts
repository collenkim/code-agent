import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { next, requireReproable, Stop } from "../agent/commands";
import { start } from "./confirmedStart";
import { loadEvidence, runsOf, testStageFiles, validationDocFile } from "../agent/evidence";
import { loadActive } from "../agent/layout";
import { partialTreeHash } from "../agent/tree";
import { repro } from "../agent/validate";
import { RetryRefused } from "../agent/retryPolicy";
import { verify } from "../agent/verificationFlow";
import { loadWork } from "../agent/work";
import { PASS, NOT_INSTALLED, SRC, REPRO_TEST, SILENT_FAIL, STRATEGY_TWO, STRATEGY_NO_TEST, repo, write, writeFileHook, approve } from "./kindFlowFixture";
import { setupFixFlow, useManifest, writeDocs, submit, toImplement, writeReproTest, fixSource } from "./fixFlowFixture";

describe("fix 재현 실행·실패 판정", () => {
  setupFixFlow();

  // ---- 재현 전후의 hook ----

  test("6. 재현 전에는 고칠 파일을 쓸 수 없고 테스트 파일은 쓸 수 있다", () => {
    toImplement();
    assert.match(writeFileHook(SRC)!, /재현을 먼저 봐야 이 파일을 고칠 수 있습니다/);
    assert.equal(writeFileHook(REPRO_TEST), undefined);
  });

  test("7. 비-test 계획 파일이 이미 바뀌어 있으면 repro 가 거부한다", async () => {
    toImplement();
    writeReproTest();
    fixSource();
    await assert.rejects(
      () => repro(requireReproable(repo)),
      (error: Error) => error instanceof Stop && /재현을 보기 전에 이미 바뀐 계획 파일이 있습니다/.test(error.message),
    );
  });

  test("8. 재현 TC 가 통과하면 재현이 아니다", async () => {
    useManifest({ test: PASS });
    toImplement();
    writeReproTest();
    await assert.rejects(() => repro(requireReproable(repo)), /재현하지 못했습니다/);
  });

  test("8b. 같은 테스트 트리로 재현하지 못했으면 다시 돌리지 않는다 — 다시 돌려도 같다", async () => {
    useManifest({ test: PASS });
    toImplement();
    writeReproTest();
    await assert.rejects(() => repro(requireReproable(repo)), /재현하지 못했습니다[\s\S]*남은 재현 시도 2회/);
    assert.equal(loadEvidence(repo, "FIX-1", SRC)!.reproAttempt!.class, "result-unconfirmed");
    const at = runsOf(loadEvidence(repo, "FIX-1", SRC)!, "repro")[0].at;
    await assert.rejects(() => repro(requireReproable(repo)),
      (error: Error) => error instanceof RetryRefused && /같은 테스트 트리로 이미 재현하지 못했습니다/.test(error.message));
    assert.equal(runsOf(loadEvidence(repo, "FIX-1", SRC)!, "repro")[0].at, at, "거부는 실행하지 않는다");
  });

  test("8c. fix 의 결과 미확인 회차에는 수집 수정 창이 없다 — 재현부터 언 테스트는 ⑨ 지적으로만 열린다", async () => {
    // ⑦ 에 TC 가 둘이고 테스트는 재현 TC 만 찍는다
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs();
    write("doc/work/FIX-1/07-test-spec.md", [
      "# 테스트 명세", "## 테스트 케이스",
      "| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |", "|---|---|---|---|---|",
      "| TC-1 | Unit | AC-R1-1 | 항목 두 개를 담고 총액을 읽는다 | 합계가 나온다 |",
      "| TC-2 | Unit | AC-R1-1 | 빈 목록의 총액을 읽는다 | 0 이 나온다 |",
      "## 재현", "- TC-1",
    ].join("\n"));
    next(repo);
    next(repo);
    next(repo);
    submit();
    approve();
    next(repo);
    writeReproTest("// TC-1 · TC-2 재현\n");
    await repro(requireReproable(repo));
    fixSource();
    next(repo);
    next(repo);
    const result = await verify(repo);
    assert.equal(result.node, "diagnose");
    assert.equal(result.failure?.class, "result-unconfirmed");
    assert.equal(result.budget?.collect.limit, 0);
    assert.equal(result.budget?.totalRounds.limit, 6);
    assert.match(writeFileHook(REPRO_TEST) ?? "", /얼어 있는/);
  });

  test("9. 테스트 명령이 없으면 not-run, 실행 파일이 없으면 error — 둘 다 재현이 아니다", async () => {
    useManifest({ test: undefined }, STRATEGY_NO_TEST);
    toImplement();
    writeReproTest();
    await assert.rejects(() => repro(requireReproable(repo)), /재현 명령이 돌지 못했습니다 \(test: not-run\)/);
  });

  test("9b. 실행 파일이 없으면 error 로 거부한다", async () => {
    useManifest({ test: NOT_INSTALLED });
    toImplement();
    writeReproTest();
    await assert.rejects(() => repro(requireReproable(repo)), /재현 명령이 돌지 못했습니다 \(test: error\)/);
  });

  test("10. 재현 TC id 가 실패한 실행의 출력에 없으면 거부한다 — 테스트 파일에 적혀 있어도", async () => {
    useManifest({ test: SILENT_FAIL });
    toImplement();
    // 파일에는 id 가 있다. 그래도 재현이 아니다 — 파일을 grep 한 것은 *무엇이 실패했는지* 말해 주지 않는다
    writeReproTest("// TC-1 재현\n");
    await assert.rejects(() => repro(requireReproable(repo)), /재현 TC 가 실패한 실행의 출력에 없습니다: TC-1/);
    assert.equal(loadEvidence(repo, "FIX-1", SRC)!.repro, undefined);
  });

  test("10b. 다른 TC 만 실패로 찍히면 재현이 아니다 — 무관한 빨간 스위트로 고칠 파일이 열리지 않는다", async () => {
    useManifest({ test: ["node", "-e", "console.log('TC-9 FAILED'); process.exit(1)"] });
    toImplement();
    writeReproTest("// TC-1 재현\n");
    await assert.rejects(() => repro(requireReproable(repo)), /재현 TC 가 실패한 실행의 출력에 없습니다: TC-1/);
    assert.match(writeFileHook(SRC)!, /재현을 먼저 봐야 이 파일을 고칠 수 있습니다/);
  });

  test("10c. 통과한 실행이 id 를 찍어도 재현이 아니다 — 실패한 실행의 출력만 본다", async () => {
    // smoke 는 TC-1 을 찍고 통과하고, test 는 id 없이 실패한다 — 출력을 통째로 합쳐 보면 지나가던 자리다
    useManifest({ test: SILENT_FAIL, commands: { smoke: ["node", "-e", "console.log('TC-1 ok')"] } }, STRATEGY_TWO);
    toImplement();
    writeReproTest("// 재현 테스트\n");
    await assert.rejects(() => repro(requireReproable(repo)), /재현 TC 가 실패한 실행의 출력에 없습니다: TC-1/);
  });

  test("10d. 같은 실행에서 재현 TC 통과 + 다른 TC 실패는 재현이 아니다", async () => {
    useManifest({ test: ["node", "-e", "console.log('ok 1 - TC-1\\nnot ok 2 - TC-9'); process.exit(1)"] });
    toImplement();
    writeReproTest();
    await assert.rejects(() => repro(requireReproable(repo)), /실제 실패 결과가 필요합니다/);
    assert.equal(loadEvidence(repo, "FIX-1", SRC)!.repro, undefined);
  });

  test("10e. 선언된 환경 오류로 실패한 재현 TC 는 재현이 아니다 — 컨텍스트 로드 실패 등", async () => {
    useManifest({
      test: ["node", "-e", "console.log('not ok 1 - TC-1'); console.error('java.lang.IllegalStateException: Failed to load ApplicationContext'); process.exit(1)"],
      environmentErrors: ["Failed to load ApplicationContext"],
    });
    toImplement();
    writeReproTest();
    await assert.rejects(() => repro(requireReproable(repo)), /환경 오류로 실패했습니다.*Failed to load ApplicationContext/);
    assert.equal(loadEvidence(repo, "FIX-1", SRC)!.repro, undefined);
    assert.ok(writeFileHook(SRC), "재현을 보지 못했으니 고칠 파일은 아직 닫혀 있다");
  });

  test("11. 재현을 보면 증거가 테스트 트리 해시에 묶여 0회차로 남는다", async () => {
    toImplement();
    writeReproTest();
    const out = await repro(requireReproable(repo));
    assert.match(out, /재현을 봤습니다/);

    const work = loadWork(repo)!;
    const evidence = loadEvidence(repo, "FIX-1", SRC)!;
    assert.equal(evidence.rounds, 0);
    assert.equal(evidence.runs[0].phase, "repro");
    assert.equal(evidence.runs[0].round, 0);
    assert.equal(evidence.runs[0].outcome, "failed");
    assert.deepEqual(evidence.repro!.cases, ["TC-1"]);
    assert.equal(evidence.repro!.testTreeHash, partialTreeHash(repo, testStageFiles(work)));
    assert.deepEqual(testStageFiles(work), [REPRO_TEST]);

    const validation = readFileSync(join(repo, validationDocFile("FIX-1")), "utf-8");
    assert.match(validation, /- 재현: 로컬 재현 TC-1 · 테스트 트리 sha256:/);
    // 0회차는 고쳐 쓰기가 아니다 — 수정 루프 절에 실리지 않는다
    assert.equal(/## 수정 루프/.test(validation), false);

    // 같은 트리에서 다시 부르면 다시 돌리지 않는다
    assert.match(await repro(requireReproable(repo)), /이미 재현을 봤습니다/);
  });

  test("12. 재현을 본 뒤에는 고칠 파일을 쓸 수 있다", async () => {
    toImplement();
    writeReproTest();
    await repro(requireReproable(repo));
    // 재현을 봤으므로 테스트 단계를 넘길 수 있다 — 그다음 단계가 고칠 파일의 자리다
    next(repo);
    assert.equal(loadActive(repo)!.stage, "code");
    assert.equal(writeFileHook(SRC), undefined);
  });
});
