import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { back, next, requireReproable, requireValidatable } from "../agent/commands";
import { start } from "./confirmedStart";
import { loadEvidence, saveEvidence, runsOf, stageProblems } from "../agent/evidence";
import { loadActive } from "../agent/layout";
import { openRound, reviewDocFile } from "../agent/review";
import { recordReviewFixture } from "./reviewFixture";
import { check, integrate, repro, runTests } from "../agent/validate";
import { loadWork } from "../agent/work";
import { SRC, REPRO_TEST, repo, write, writeFileHook, approve, FIX_PLAN } from "./kindFlowFixture";
import { setupFixFlow, useManifest, submit, toImplement, writeReproTest, fixSource } from "./fixFlowFixture";

describe("fix 테스트 동결·격리 재현 갱신", () => {
  setupFixFlow();

  test("12b. 실제 실패 상태 없는 구버전 재현 기록은 쓰기·검증·캐시 재사용을 열지 않는다", async () => {
    toImplement();
    writeReproTest();
    await repro(requireReproable(repo));
    const old = loadEvidence(repo, "FIX-1", SRC)!;
    delete old.repro!.found[0].status;
    saveEvidence(repo, old);
    assert.match(writeFileHook(SRC) ?? "", /실제 실패 결과가 없습니다/);
    assert.throws(() => next(repo), /실제 실패 결과가 없습니다/);
    assert.ok(stageProblems(loadWork(repo)!, "test").some((problem) => /실제 실패 결과가 없습니다/.test(problem)));
    const rerun = await repro(requireReproable(repo));
    assert.equal(rerun.includes("이미 재현을 봤습니다"), false);
    assert.equal(loadEvidence(repo, "FIX-1", SRC)!.repro!.found[0].status, "failed");
    next(repo);
    assert.equal(writeFileHook(SRC), undefined);
  });

  test("13. 재현을 본 뒤에는 테스트 파일이 언다 — check 를 돌기 전에도", async () => {
    toImplement();
    writeReproTest();
    await repro(requireReproable(repo));
    assert.match(writeFileHook(REPRO_TEST)!, /얼어 있는 파일입니다/);
  });

  test("14. 재현을 본 뒤 테스트 파일이 바뀌면 고칠 파일이 다시 잠긴다 (첫 check 전)", async () => {
    toImplement();
    writeReproTest();
    await repro(requireReproable(repo));
    // 동결을 우회해 직접 고친 것 — hook 이 아니라 파일시스템으로
    writeReproTest("// TC-1 재현 (고쳐 씀)\n");
    assert.match(writeFileHook(SRC)!, /재현을 본 뒤 테스트 파일이 바뀌었습니다/);
  });

  test("15. 첫 check 뒤에는 테스트 트리 대조가 내려간다 — 수정 루프가 교착되지 않는다 (C2)", async () => {
    toImplement();
    writeReproTest();
    await repro(requireReproable(repo));
    fixSource();
    next(repo);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "check");
    await check(requireValidatable(repo, "check"));

    // ⑨ 지적으로 동결을 풀어 재현 테스트를 고친 상황
    writeReproTest("// TC-1 재현 (리뷰 지적으로 고침)\n");
    assert.equal(writeFileHook(SRC), undefined);
  });

  test("16. 계획을 재승인하면 재현 증거가 함께 무효가 된다", async () => {
    toImplement();
    writeReproTest();
    await repro(requireReproable(repo));
    next(repo);
    assert.equal(writeFileHook(SRC), undefined);

    back(repo, "plan");
    submit({ ...FIX_PLAN, approach: "재현 테스트를 먼저 쓰고 total 을 reduce 로 고친다" });
    approve();
    next(repo);
    assert.match(writeFileHook(SRC)!, /재현을 본 기록이 없습니다/);
  });

  test("17. 완주 — 재현(실패) → 고침 → check → test(같은 TC 가 이제 통과) → 리뷰", async () => {
    toImplement();
    writeReproTest();
    await repro(requireReproable(repo));
    fixSource();
    next(repo);
    next(repo);
    await check(requireValidatable(repo, "check"));
    next(repo);
    const tested = await runTests(requireValidatable(repo, "test"));
    assert.match(tested, /test: passed/);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "review");

    const evidence = loadEvidence(repo, "FIX-1", SRC)!;
    assert.equal(runsOf(evidence, "repro")[0].outcome, "failed");
    assert.equal(runsOf(evidence, "test")[0].outcome, "passed");
    assert.ok(evidence.repro);
  });

  /** 리뷰까지 간 뒤 한 번 더 check → test → 리뷰를 돌아 통합 검증 앞에 세운다 */
  async function toIntegrateAgain(): Promise<void> {
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    next(repo);
    openRound(requireValidatable(repo, "review"));
    const path = join(repo, reviewDocFile("FIX-1"));
    writeFileSync(path, `${readFileSync(path, "utf-8")}\n- 없음\n`);
    recordReviewFixture(repo);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "integrate");
  }

  test("17b. 리뷰 후 테스트 보완은 기준 코드에서 격리 재현하고 수정 코드를 보존한 채 통합한다", async () => {
    useManifest({ test: ["node", "--test", "--test-reporter=tap"] });
    toImplement();
    const testBody = "const test=require('node:test'),assert=require('node:assert/strict'),{total}=require('../main/app/order');test('TC-1 sum',()=>assert.equal(total([2,3]),5));\n";
    writeReproTest(testBody);
    await repro(requireReproable(repo));
    fixSource();
    next(repo);
    next(repo);
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    next(repo);

    const fixed = readFileSync(join(repo, SRC), "utf8");
    // 리뷰 지적이 재현 테스트를 연다 — 동결 뒤 바뀐 테스트 파일은 ⑨ 지적으로 연 것만 다음 check 가 기준을 갱신한다
    openRound(requireValidatable(repo, "review"));
    const review = join(repo, reviewDocFile("FIX-1"));
    writeFileSync(review, `${readFileSync(review, "utf-8")}\n| F1 | ${REPRO_TEST} | 계획 안 | 열림 | 빈 목록의 총액 단언이 없다 |\n`);
    recordReviewFixture(repo);
    assert.equal(writeFileHook(REPRO_TEST), undefined);
    writeReproTest(testBody + "test('TC-1 empty',()=>assert.equal(total([]),0));\n");
    writeFileSync(review, readFileSync(review, "utf-8").replace("| 열림 |", "| 해결 |"));
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    next(repo);
    openRound(requireValidatable(repo, "review"));
    recordReviewFixture(repo);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "integrate");
    assert.equal(loadEvidence(repo, "FIX-1", SRC)!.testFreeze!.rebased![0].by, "finding");
    assert.equal(readFileSync(join(repo, SRC), "utf8"), fixed);
    assert.equal(loadEvidence(repo, "FIX-1", SRC)!.repro!.found[0].status, "failed");
    await integrate(requireValidatable(repo, "integrate"));
    assert.deepEqual(stageProblems(loadWork(repo)!, "integrate"), []);
  });

  test("17d. 단언을 없애 기준 코드에서도 통과하는 테스트는 재현 갱신에서 차단한다", async () => {
    useManifest({ test: ["node", "--test", "--test-reporter=tap"] });
    toImplement();
    writeReproTest("const test=require('node:test'),assert=require('node:assert/strict'),{total}=require('../main/app/order');test('TC-1 sum',()=>assert.equal(total([2,3]),5));\n");
    await repro(requireReproable(repo)); fixSource(); next(repo); next(repo);
    await check(requireValidatable(repo, "check"));
    writeReproTest("require('node:test')('TC-1 weakened',()=>{});\n");
    const fixed = readFileSync(join(repo, SRC), "utf8");
    await assert.rejects(() => check(requireValidatable(repo, "check")), /재현하지 못했습니다/);
    assert.equal(readFileSync(join(repo, SRC), "utf8"), fixed);
    assert.ok(stageProblems(loadWork(repo)!, "integrate").some(p => /재현을 본 테스트 트리/.test(p)));
    // 실패한 재현 갱신은 증거의 treeHash 를 바꾸지 않는다 — 옛 회차의 check 가 바뀐 트리에 묶인 것처럼 보이지 않는다
    assert.ok(stageProblems(loadWork(repo)!, "check").some((problem) => /계획 파일이 바뀌었습니다/.test(problem)));
  });

  test("17c. 재현 뒤 테스트를 고치지 않았으면 통합 검증 앞에서 재현 묶임이 걸리지 않는다", async () => {
    toImplement();
    writeReproTest();
    await repro(requireReproable(repo));
    fixSource();
    next(repo);
    next(repo);
    await toIntegrateAgain();
    assert.equal(
      stageProblems(loadWork(repo)!, "integrate").some((problem) => /재현을 본 테스트 트리/.test(problem)),
      false,
    );
  });

  test("18. repro 는 fix 의 구현·재검증 단계에서 실행 가능하다", async () => {
    toImplement();
    writeReproTest();
    await repro(requireReproable(repo));
    fixSource();
    next(repo);
    next(repo);
    assert.equal(requireReproable(repo).active.phase, "check");
  });

  test("18b. feature 작업에서 repro 를 부르면 거부된다", () => {
    write("doc/work/FEAT-1.md", ["---", "kind: feature", "id: FEAT-1", "title: 새 도메인", "target: billing", "---", "", "새로 만든다.", ""].join("\n"));
    start(repo, join(repo, "doc/work/FEAT-1.md"));
    assert.throws(() => requireReproable(repo), /code-agent repro 는 fix 작업에서만 돕니다 \(지금: feature\)/);
  });

  test("19. 재현을 보지 않으면 next 가 테스트 단계를 넘기지 않는다", () => {
    toImplement();
    writeReproTest();
    assert.throws(() => next(repo), /code-agent repro 로 지금 코드에서 재현 TC 가 실패하는 것을 보고/);
  });
});
