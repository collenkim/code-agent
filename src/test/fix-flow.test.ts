import { strict as assert } from "node:assert";
import { join } from "node:path";
import { describe, test } from "node:test";
import { context, next, requireReproable, Stop } from "../agent/commands";
import { start } from "./confirmedStart";
import { withNotation } from "../agent/hostText";
import { loadActive } from "../agent/layout";
import { manifestCheck } from "../agent/survey";
import { repro } from "../agent/validate";
import { analysisProblems } from "../agent/workDocs";
import { SRC, repo, write, writeFileHook, finishDelivery, analysisDoc, CURRENT_OK, CURRENT_NA, CURRENT_NO_REF, specDoc, FIX_PLAN } from "./kindFlowFixture";
import { setupFixFlow, useManifest, writeDocs, submit, toImplement, writeReproTest, fixSource } from "./fixFlowFixture";

describe("fix 계획·분석·단계 순서", () => {
  setupFixFlow();

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
});
