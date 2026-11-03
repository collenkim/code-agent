import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { next, requireReproable, requireValidatable } from "../agent/commands";
import { start } from "./confirmedStart";
import { withInteraction } from "../agent/tty";
import { loadEvidence, runsOf, testStageFiles, validationDocFile } from "../agent/evidence";
import { openRound, reviewDocFile } from "../agent/review";
import { recordReviewFixture } from "./reviewFixture";
import { partialTreeHash } from "../agent/tree";
import { approveLogBasis, check, repro, runTests } from "../agent/validate";
import { RetryRefused } from "../agent/retryPolicy";
import { prepareConsent } from "../agent/consent";
import { loadWork } from "../agent/work";
import { PASS, SRC, REPRO_TEST, repo, write, git, writeFileHook, approve, FIX_HEAD, LOG_LINE, FIX_ORDER_LOG, CURRENT_LOG, CURRENT_OK } from "./kindFlowFixture";
import { setupFixFlow, useManifest, writeDocs, submit, toImplement, writeReproTest, fixSource } from "./fixFlowFixture";

describe("fix 오류 로그 근거·시도 한도", () => {
  setupFixFlow();

  // ---- 오류 로그 기반 fix — 로컬 재현은 될 수도 안 될 수도 있다 ----

  /** 지시서를 바꿔 끼운다 — 시작 **전에** 부른다 */
  function useOrder(order: string): void {
    write("doc/work/FIX-1.md", order);
    git("add", "-A");
    git("commit", "-qm", "order");
  }

  function toImplementWith(current: string, reproSection: string): void {
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs(current, reproSection);
    next(repo);
    next(repo);
    next(repo);
    submit();
    approve();
    next(repo);
  }

  const PASSES_LOCALLY = ["node", "-e", "console.log('ok 1 - TC-1')"];
  const HUMAN = { confirm: () => ({ channel: "tty" as const, verified: true, detail: "테스트" }), ask: () => "n" };

  test("13a. fix 지시서에 오류 로그(없으면 사유·재현 절차)가 없으면 시작하지 않는다", () => {
    useOrder(FIX_HEAD);
    assert.throws(() => start(repo, join(repo, "doc/work/FIX-1.md")), /오류 로그/);
  });

  test("13b. 오류 로그가 있으면 ② 에 로그 문구와 실재하는 원인 코드의 대응이 있어야 넘어간다", () => {
    useOrder(FIX_ORDER_LOG);
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs(CURRENT_OK);
    next(repo);
    assert.throws(() => next(repo), /오류 로그의 어느 줄이 어느 코드에서/);
    writeDocs(`- \`${LOG_LINE}\` 에서 난다 (order.js:3)`);
    assert.throws(() => next(repo), /오류 로그의 어느 줄이 어느 코드에서/, "로그 안의 위치나 실재하지 않는 경로는 코드 대응이 아니다");
    writeDocs(CURRENT_LOG);
    next(repo);
  });

  test("13c. 계획에서 로그 근거로 정하면 수정 전 결과만 남기고 고칠 파일을 연다 — 반영 기록에 운영 확인 필요", async () => {
    useManifest({ test: PASSES_LOCALLY });
    useOrder(FIX_ORDER_LOG);
    toImplementWith(CURRENT_LOG, "- 방식: 로그 근거 — 운영 데이터에서만 발생\n- TC-1");
    writeReproTest();
    assert.match(await repro(requireReproable(repo)), /로그 근거로 진행합니다\(계획 승인/);
    const evidence = loadEvidence(repo, "FIX-1", SRC)!;
    assert.equal(evidence.repro!.mode, "log");
    assert.equal(evidence.repro!.found[0].status, "passed");
    next(repo);
    assert.equal(writeFileHook(SRC), undefined);
    assert.ok(writeFileHook(REPRO_TEST), "회귀 TC 도 얼었다");
    assert.match(readFileSync(join(repo, validationDocFile("FIX-1")), "utf-8"), /- 재현: 로그 근거\(계획 승인\) TC-1 .*로컬 재현 없음 — 운영 로그로 확인 필요/);
  });

  test("13d. 로그 근거는 지시서에 오류 로그가 있을 때만, 사유와 함께 계획한다", () => {
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs(CURRENT_OK, "- 방식: 로그 근거 — 운영에서만 발생\n- TC-1");
    next(repo);
    next(repo);
    next(repo);
    assert.throws(() => submit(), /로그 근거는 지시서의 `## 오류 로그` 가 있을 때만/);
    writeDocs(CURRENT_OK, "- 방식: 로그 근거\n- TC-1");
    assert.throws(() => submit(), /사유를 적습니다/);
  });

  test("13e. 로컬 재현이 안 되면 시도를 남기고, 사람이 확인해야 로그 근거로 고칠 파일이 열린다", async () => {
    useManifest({ test: PASSES_LOCALLY });
    useOrder(FIX_ORDER_LOG);
    toImplementWith(CURRENT_LOG, "- TC-1");
    writeReproTest();
    await assert.rejects(() => repro(requireReproable(repo)), /재현하지 못했습니다[\s\S]*repro-log 동의/);
    assert.ok(loadEvidence(repo, "FIX-1", SRC)!.reproAttempt);
    assert.ok(writeFileHook(SRC), "확인 전에는 고칠 파일이 닫혀 있다");
    const prepared = JSON.parse(prepareConsent(repo, { action: "repro-log" }));
    assert.match(prepared.summary, /로컬에서 재현되지 않았습니다[\s\S]*total mismatch/);
    assert.equal(loadEvidence(repo, "FIX-1", SRC)!.repro, undefined, "확인 준비는 아무것도 바꾸지 않는다");
    assert.match(withInteraction(HUMAN, () => approveLogBasis(requireReproable(repo))), /로그 근거로 진행합니다/);
    const evidence = loadEvidence(repo, "FIX-1", SRC)!;
    assert.equal(evidence.repro!.basis!.by, "approved");
    assert.equal(evidence.reproAttempt, undefined);
    next(repo);
    assert.equal(writeFileHook(SRC), undefined);
  });

  test("13e-2. 재현 시도는 서로 다른 테스트 트리로 3회까지다 — 넘으면 멈추고 repro-log 동의를 안내한다", async () => {
    useManifest({ test: PASSES_LOCALLY });
    useOrder(FIX_ORDER_LOG);
    toImplementWith(CURRENT_LOG, "- TC-1");
    for (let attempt = 1; attempt <= 3; attempt++) {
      writeReproTest(`// TC-1 재현 시도 ${attempt}\n`);
      await assert.rejects(() => repro(requireReproable(repo)), /재현하지 못했습니다/);
    }
    writeReproTest("// TC-1 재현 시도 4\n");
    await assert.rejects(() => repro(requireReproable(repo)),
      (error: Error) => error instanceof RetryRefused && /재현 시도 3회/.test(error.message) && /repro-log/.test(error.message));
    // 거부는 시도 기록(사람이 로그 근거 전환을 판단할 자료)을 지우지 않는다
    assert.ok(loadEvidence(repo, "FIX-1", SRC)!.reproAttempt);
  });

  test("13e-3. 로그 근거 확인은 재현 시도 카운터를 비운다 — 리뷰 지적으로 재현 테스트를 보완한 뒤의 격리 재현 갱신이 막히지 않는다", async () => {
    useManifest({ test: ["node", "--test", "--test-reporter=tap"] });
    useOrder(FIX_ORDER_LOG);
    toImplementWith(CURRENT_LOG, "- TC-1");
    // 기준 코드에서도 통과하는(재현하지 못하는) 테스트로 서로 다른 트리 3회 — 재현 시도 한도를 다 쓴다
    const base = "const test=require('node:test'),assert=require('node:assert/strict'),{total}=require('../main/app/order');test('TC-1 one',()=>assert.equal(total([]),total([])));\n";
    for (let attempt = 1; attempt <= 3; attempt++) {
      writeReproTest(`${base}// 시도 ${attempt}\n`);
      await assert.rejects(() => repro(requireReproable(repo)), /재현하지 못했습니다/);
    }
    assert.equal(loadEvidence(repo, "FIX-1", SRC)!.retry!.repro!.trees.length, 3);
    withInteraction(HUMAN, () => approveLogBasis(requireReproable(repo)));
    assert.deepEqual(loadEvidence(repo, "FIX-1", SRC)!.retry!.repro, { trees: [], reruns: {} }, "로그 근거 확인은 재현을 본 것과 같다");
    next(repo);
    fixSource();
    next(repo);
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    next(repo);
    openRound(requireValidatable(repo, "review"));
    const review = join(repo, reviewDocFile("FIX-1"));
    writeFileSync(review, `${readFileSync(review, "utf-8")}\n| F1 | ${REPRO_TEST} | 계획 안 | 열림 | 단언 보완 |\n`);
    recordReviewFixture(repo);
    assert.equal(writeFileHook(REPRO_TEST), undefined);
    writeReproTest(`${base}test('TC-1 two',()=>assert.equal(total([1]),1));\n`);
    writeFileSync(review, readFileSync(review, "utf-8").replace("| 열림 |", "| 해결 |"));
    // 확인 전의 시도 3회가 남아 있으면 여기서 재현 시도 한도로 거부되고, 이미 받은 repro-log 동의를 다시 요구한다
    await check(requireValidatable(repo, "check"));
    const evidence = loadEvidence(repo, "FIX-1", SRC)!;
    assert.equal(evidence.repro!.mode, "log");
    assert.equal(evidence.repro!.testTreeHash, partialTreeHash(repo, testStageFiles(loadWork(repo)!)));
    assert.equal(evidence.testFreeze!.rebased!.at(-1)!.by, "finding");
  });

  test("13e-4. 뒤 트리의 시도가 시도 기록을 덮어도 이미 재현하지 못한 트리는 다시 돌리지 않는다 — 트리별 원인이 남는다", async () => {
    useManifest({ test: PASS });
    toImplement();
    writeReproTest("// TC-1 재현 A\n");
    await assert.rejects(() => repro(requireReproable(repo)), /재현하지 못했습니다/);
    writeReproTest("// TC-1 재현 B\n");
    await assert.rejects(() => repro(requireReproable(repo)), /재현하지 못했습니다/);
    // A 로 되돌린다 — reproAttempt 는 B 의 것이라, 트리별 원인이 없으면 A 를 끝 기록 없이 끊긴 시도로 보고 다시 돌린다
    writeReproTest("// TC-1 재현 A\n");
    const at = runsOf(loadEvidence(repo, "FIX-1", SRC)!, "repro")[0].at;
    await assert.rejects(() => repro(requireReproable(repo)),
      (error: Error) => error instanceof RetryRefused && /같은 테스트 트리로 이미 재현하지 못했습니다 — 다시 돌려도 같습니다/.test(error.message));
    const evidence = loadEvidence(repo, "FIX-1", SRC)!;
    assert.equal(runsOf(evidence, "repro")[0].at, at, "거부는 실행하지 않는다");
    assert.deepEqual(evidence.retry!.repro!.reruns, {}, "재실행으로 세지 않는다");
    assert.deepEqual(Object.values(evidence.retry!.repro!.classes!), ["result-unconfirmed", "result-unconfirmed"]);
  });

  test("13f. 오류 로그 없는 결함은 재현되지 않으면 로그 근거로 넘어가지 않는다", async () => {
    useManifest({ test: PASSES_LOCALLY });
    toImplement();
    writeReproTest();
    await assert.rejects(() => repro(requireReproable(repo)), /로그 근거로 넘어갈 수 없습니다/);
    assert.throws(() => withInteraction(HUMAN, () => approveLogBasis(requireReproable(repo))), /오류 로그가 없어/);
    assert.ok(writeFileHook(SRC));
  });
});
