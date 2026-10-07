import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { back, context, next, requireReproable, requireValidatable, Stop, submitPlan } from "../agent/commands";
import { start } from "./confirmedStart";
import { withInteraction } from "../agent/tty";
import { withNotation } from "../agent/hostText";
import { loadEvidence, saveEvidence, runsOf, stageProblems, testStageFiles, validationDocFile } from "../agent/evidence";
import { loadActive } from "../agent/layout";
import { openRound, reviewDocFile } from "../agent/review";
import { recordReviewFixture } from "./reviewFixture";
import { manifestCheck } from "../agent/survey";
import { partialTreeHash } from "../agent/tree";
import { approveLogBasis, check, integrate, repro, runTests } from "../agent/validate";
import { RetryRefused } from "../agent/retryPolicy";
import { verify } from "../agent/verificationFlow";
import { prepareConsent } from "../agent/consent";
import { loadWork } from "../agent/work";
import { analysisProblems } from "../agent/workDocs";
/**
 * fix 흐름 — 재현 먼저(repro·로그 근거·동결).
 *
 * p6.test 에서 describe 단위로 옮겼다(이름·본문 그대로). 저장소·헬퍼·상수는 kindFlowFixture.ts 에 있다.
 */
import {
  PASS, NOT_INSTALLED, SRC, REPRO_TEST, KEPT_TEST, SILENT_FAIL, STRATEGY, STRATEGY_TWO, STRATEGY_NO_TEST, repo, write, git, writeFileHook, confirmDocs, approve, newRepo, dropRepo, finishDelivery, manifest, FIX_HEAD, FIX_ORDER, LOG_LINE, FIX_ORDER_LOG, CURRENT_LOG, FIX_REQ, analysisDoc, CURRENT_OK, CURRENT_NA, CURRENT_NO_REF, FIX_DESIGN, FIX_FUNC, specDoc, FIX_PLAN,
} from "./kindFlowFixture";

describe("P6 · fix — 재현 먼저", () => {
  beforeEach(() => {
    newRepo("ca-p6-fix-");
    write("code-agent.json", manifest());
    write(SRC, "function total(items) {\n  // 버그: 더하지 않는다\n  return 0;\n}\nmodule.exports = { total };\n");
    write(KEPT_TEST, "// 기존 테스트\n");
    write("doc/work/FIX-1.md", FIX_ORDER);
    confirmDocs();
    git("add", "-A");
    git("commit", "-qm", "init");
  });
  afterEach(dropRepo);

  /** 매니페스트를 바꿔 끼운다 — 시작 **전에** 부른다 (뒤에 바꾸면 승인이 stale 이 된다) */
  function useManifest(overrides: Record<string, unknown>, strategy = STRATEGY): void {
    write("code-agent.json", manifest(overrides));
    write("doc/test-strategy.md", strategy);
    confirmDocs();
    git("add", "-A");
    git("commit", "-qm", "manifest");
  }

  function writeDocs(current = CURRENT_OK, repro: string | null = "- TC-1"): void {
    write("doc/work/FIX-1/01-requirements.md", FIX_REQ);
    write("doc/work/FIX-1/02-analysis.md", analysisDoc(current));
    write("doc/work/FIX-1/03-design.md", FIX_DESIGN);
    write("doc/work/FIX-1/04-functional.md", FIX_FUNC);
    write("doc/work/FIX-1/07-test-spec.md", specDoc(repro));
  }

  function submit(plan: unknown = FIX_PLAN): string {
    write("doc/work/FIX-1/plan.json", JSON.stringify(plan));
    return submitPlan(repo, join(repo, "doc/work/FIX-1/plan.json"));
  }

  /** 계획 승인까지 마치고 implement 스테이지에 세운다 */
  function toImplement(plan: unknown = FIX_PLAN): void {
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs();
    next(repo);
    next(repo);
    next(repo);
    submit(plan);
    approve();
    next(repo);
  }

  function writeReproTest(body = "// TC-1 재현\n"): void {
    write(REPRO_TEST, body);
  }

  function fixSource(): void {
    write(SRC, "function total(items) {\n  // fixed\n  return items.reduce((a, b) => a + b, 0);\n}\nmodule.exports = { total };\n");
  }

  test("context 의 재현 절 — 서브에이전트 제약만 싣는다(메인 절차인 repro 실행·repro-log 동의는 스킬이 원천), 두 호스트가 같다", () => {
    toImplement();
    const section = (text: string) => text.slice(text.indexOf("## fix — 재현 먼저")).split("\n").slice(0, 3).join("\n");
    const claude = withNotation("claude", () => section(context(repo)));
    assert.match(claude, /^## fix — 재현 먼저\n- 테스트 단계에서 ⑦ [^\n]*의 `## 재현` 이 가리키는 TC 를 먼저 씁니다\. 메인이 code-agent repro 로 그 TC 의 \*\*실패\*\*를 확인하기 전에는 고칠 파일 쓰기를 hook 이 거부합니다 — 거부되면 우회하지 말고 메인에게 보고합니다\.\n- repro 를 지나면 재현 테스트/);
    assert.equal(withNotation("codex", () => section(context(repo))), claude);
    assert.doesNotMatch(claude, /Bash:|셸:|repro-log/);
  });

  test("H3: 도메인 단계의 fix를 제출하고 실제 실패 재현→수정→검증→통합→반영까지 완료한다", async () => {
    useManifest({ domainRoots: [], test: ["node", "--test", "--test-reporter=tap"], stages: [
      { key: "code", title: "코드", template: "01-code.md", scope: "domain", outputDirs: ["."] },
      { key: "test", title: "테스트", template: "02-test.md", kind: "test", scope: "project", outputDirs: ["src/test"] },
    ] });
    toImplement();
    writeReproTest("const {test}=require('node:test'),a=require('node:assert/strict'),{total}=require('../main/app/order');test('TC-1',()=>a.equal(total([2,3]),5));\n");
    await repro(requireReproable(repo)); next(repo);
    assert.equal(writeFileHook(SRC), undefined);
    fixSource(); next(repo);
    await finishDelivery("FIX-1", SRC);
  });

  // ---- ② 기존 시스템 분석 ----

  test("1. ② 의 기존 시스템 분석이 '해당 없음' 이면 fix 가 막힌다 — feature 는 그대로 지난다", () => {
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs(CURRENT_NA);
    next(repo);
    assert.throws(
      () => next(repo),
      (error: Error) => error instanceof Stop && /'해당 없음' 으로 비울 수 없습니다/.test(error.message),
    );
    // 같은 문서를 feature 로 보면 지난다 — 새 규칙은 고치는 작업에만 걸린다
    assert.deepEqual(analysisProblems(repo, "FIX-1", ["R1"], "feature"), []);
  });

  test("1b. 다 쓴 분석에 '해당 없음 — <근거>' 한 줄이 섞여 있는 것은 비운 것이 아니다", () => {
    write("doc/work/FIX-1/02-analysis.md", analysisDoc([CURRENT_OK, "- 해당 없음 — 이 경로는 캐시를 타지 않는다"].join("\n")));
    assert.deepEqual(analysisProblems(repo, "FIX-1", ["R1"], "fix"), []);
    // 절의 내용이 그 한 줄뿐이면 비운 것이다
    write("doc/work/FIX-1/02-analysis.md", analysisDoc(CURRENT_NA));
    assert.ok(
      analysisProblems(repo, "FIX-1", ["R1"], "fix").some((problem) => /'해당 없음' 으로 비울 수 없습니다/.test(problem)),
    );
  });

  test("2. ② 에 근거 path:line 이 없으면 fix 가 막히고, 붙이면 지난다", () => {
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs(CURRENT_NO_REF);
    next(repo);
    assert.throws(() => next(repo), /근거 path:line 이 최소 하나/);
    write("doc/work/FIX-1/02-analysis.md", analysisDoc(CURRENT_OK));
    next(repo);
    assert.equal(loadActive(repo)!.phase, "design");
  });

  // ---- ⑦ 의 `## 재현` ----

  test("3. ⑦ 에 `## 재현` 이 없거나 표에 없는 TC 를 가리키면 fix 의 계획이 제출되지 않는다", () => {
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs(CURRENT_OK, null);
    next(repo);
    next(repo);
    next(repo);
    assert.throws(() => submit(), /`## 재현` 절에 결함을 재현하는 TC id/);

    write("doc/work/FIX-1/07-test-spec.md", specDoc("- TC-9"));
    assert.throws(() => submit(), /`## 재현` 이 표에 없는 TC 를 가리킵니다: TC-9/);

    write("doc/work/FIX-1/07-test-spec.md", specDoc("- TC-1"));
    assert.match(submit(), /계획을 제출/);
  });

  test("4. fix 의 sequence[0] 이 테스트 단계가 아니면 제출되지 않는다", () => {
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs();
    next(repo);
    next(repo);
    next(repo);
    assert.throws(
      () => submit({ ...FIX_PLAN, sequence: [{ step: "code", why: "먼저" }, { step: "test", why: "나중" }] }),
      /sequence\[0\] 이 테스트 단계가 아닙니다/,
    );
    // 테스트 단계 파일이 아예 없는 계획도 막힌다
    assert.throws(
      () => submit({ ...FIX_PLAN, files: [FIX_PLAN.files[1]], sequence: [{ step: "code", why: "하나뿐" }] }),
      /sequence\[0\] 이 테스트 단계가 아닙니다/,
    );
    assert.match(submit(), /계획을 제출/);
  });

  test("4b. 고칠 파일을 kind:\"test\" 단계에 적어 넣는 계획은 제출되지 않는다 — 이름표로 재현을 비껴가는 길", () => {
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs();
    next(repo);
    next(repo);
    next(repo);
    assert.throws(
      () =>
        submit({
          ...FIX_PLAN,
          files: [
            { stage: "test", path: SRC, purpose: "고칠 파일을 테스트 단계에 넣는다", requirements: ["R1"] },
            { stage: "code", path: "src/main/app/total.js", purpose: "도우미", requirements: ["R1"] },
          ],
        }),
      /계획이 kind:"test" 단계에 테스트 자리 밖의 파일을 넣었습니다: src\/main\/app\/order\.js/,
    );
  });

  test("4c. kind:\"test\" 단계가 자리를 밝히지 않으면 fix 의 계획을 세운다 — manifest check 도 경고한다", () => {
    // 테스트가 소스 옆에 있는 모양(scope:"domain", base 없음) — 무엇이 테스트 파일인지 잴 수 없다
    useManifest({
      stages: [
        { key: "code", title: "코드", template: "01-code.md", kinds: ["feature", "fix", "refactor"], scope: "project", outputDirs: ["src/main"] },
        { key: "test", title: "테스트", template: "02-test.md", kind: "test", kinds: ["feature", "fix", "refactor"], scope: "project", outputDirs: [] },
      ],
    });
    assert.match(manifestCheck(repo).text, /test 는 kind:"test" 인데 자리를 밝히지 않았습니다/);
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs();
    next(repo);
    next(repo);
    next(repo);
    assert.throws(() => submit(), /kind:"test" 단계\(test\)가 자리를 밝히지 않아 재현 테스트를 가려낼 수 없습니다/);
  });

  test("4d. plan 스테이지의 context 가 제출이 세우는 fix 규칙을 미리 말해 준다", () => {
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs();
    next(repo);
    next(repo);
    next(repo);
    const text = context(repo);
    assert.match(text, /## fix — 재현이 먼저다/);
    assert.match(text, /`## 재현` 절/);
    assert.match(text, /sequence\[0\]\.step` 이 kind:"test" 단계의 key/);
    assert.match(text, /테스트 자리 안이어야 합니다: src\/test/);
  });

  test("5. fix 는 커서를 테스트 단계에 먼저 세운다 — 매니페스트 선언 순서와 무관하게", () => {
    toImplement();
    assert.equal(loadActive(repo)!.phase, "implement");
    assert.equal(loadActive(repo)!.stage, "test");
  });

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
