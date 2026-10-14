import { strict as assert } from "node:assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { loadManifest } from "../core/manifest";
import { context, next, requireValidatable, submitPlan } from "../agent/commands";
import { start } from "./confirmedStart";
import { integrateCommands, stageProblems } from "../agent/evidence";
import { loadActive } from "../agent/layout";
import { manifestCheck, survey } from "../agent/survey";
import { check, runTests } from "../agent/validate";
import { loadWork } from "../agent/work";
/**
 * refactor 흐름 — 동작 보존, 종류별 단계 인식, 빈 저장소.
 *
 * p6.test 에서 describe 단위로 옮겼다(이름·본문 그대로). 저장소·헬퍼·상수는 kindFlowFixture.ts 에 있다.
 */
import {
  SRC, REPRO_TEST, KEPT_TEST, STRATEGY_NO_TEST, repo, write, git, writeFileHook, confirmDocs, approve, newRepo, dropRepo, finishDelivery, manifest, FIX_ORDER, analysisDoc, CURRENT_OK, CURRENT_NA, FIX_DESIGN, specDoc,
} from "./kindFlowFixture";

// ==== 2. refactor — 동작 보존 ====

const REF_ORDER = [
  "---", "kind: refactor", "id: REF-1", "title: total 을 정리한다",
  `target: ${SRC}`, "scope: [src/main]", "preserve: [total 의 공개 시그니처]",
  "---", "", "total 을 정리한다.", "",
].join("\n");

const REF_PLAN = {
  files: [{ stage: "code", path: SRC, purpose: "total 을 정리한다", requirements: ["R1"] }],
  preserve: [{ item: "total 의 공개 시그니처", how: "이름과 인자를 그대로 둔다" }],
  sequence: [{ step: "code", why: "하나뿐이다" }],
  approach: "내부만 정리한다",
  conventions: [], conflicts: [], openQuestions: [], reasoning: "동작은 그대로",
};

describe("P6 · refactor — 동작 보존", () => {
  beforeEach(() => {
    newRepo("ca-p6-ref-");
    write("code-agent.json", manifest({ test: ["node", "-e", "console.log('ok 1 - TC-1')"] }));
    write(SRC, "function total(items) {\n  return items.reduce((a, b) => a + b, 0);\n}\nmodule.exports = { total };\n");
    write(KEPT_TEST, "// TC-1 기존 테스트\n");
    write("doc/work/REF-1.md", REF_ORDER);
    confirmDocs();
    git("add", "-A");
    git("commit", "-qm", "init");
  });
  afterEach(dropRepo);

  function writeDocs(current = CURRENT_OK): void {
    write("doc/work/REF-1/01-requirements.md",
      ["# REF-1 요구사항 정의", "## R1 · 내부 구조 정리", "근거: \"total 을 정리한다.\"", "- 기존 코드: 고친다", "## 가정", "- 없음"].join("\n"));
    write("doc/work/REF-1/02-analysis.md", analysisDoc(current).replace(/# 영향도 분석/, "# REF-1 영향도 분석"));
    write("doc/work/REF-1/03-design.md", FIX_DESIGN);
    write("doc/work/REF-1/04-functional.md",
      ["# 기능 명세", "## 기능 정의", "- R1: 동작은 그대로", "## 업무 규칙", "- 없음 — 규칙 변경 없음",
        "## 예외", "- 없음 — 기존 예외 그대로", "## 수락 기준", "- AC-R1-1: 기존 테스트가 그대로 통과한다"].join("\n"));
    write("doc/work/REF-1/07-test-spec.md", specDoc());
  }

  function submit(plan: unknown = REF_PLAN): string {
    write("doc/work/REF-1/plan.json", JSON.stringify(plan));
    return submitPlan(repo, join(repo, "doc/work/REF-1/plan.json"));
  }

  function toPlan(current = CURRENT_OK): void {
    start(repo, join(repo, "doc/work/REF-1.md"));
    writeDocs(current);
    next(repo);
    next(repo);
    next(repo);
  }

  test("20. refactor 의 ② 가 '해당 없음' 이면 막힌다", () => {
    start(repo, join(repo, "doc/work/REF-1.md"));
    writeDocs(CURRENT_NA);
    next(repo);
    assert.throws(() => next(repo), /refactor 는 기존 시스템 분석에 \*\*지금 동작\*\*을 적습니다/);
  });

  test("21. 기준 커밋에 있던 테스트 파일을 계획에 넣으면 제출되지 않는다", () => {
    toPlan();
    assert.throws(
      () => submit({
        ...REF_PLAN,
        files: [...REF_PLAN.files, { stage: "test", path: KEPT_TEST, purpose: "테스트를 고친다", requirements: ["R1"] }],
      }),
      /리팩토링은 기존 테스트를 고치지 않습니다 — 계획에서 빼세요/,
    );
    assert.match(submit(), /계획을 제출/);
  });

  test("21b. 기존 테스트만 실행하는 리팩토링에서 존재하지 않는 TC는 승인 전에 막는다", () => {
    write(KEPT_TEST, "require('node:test')('TC-1 existing',()=>{});\n");
    git("add", KEPT_TEST); git("commit", "-qm", "existing test id");
    toPlan();
    const spec = "doc/work/REF-1/07-test-spec.md";
    write(spec, specDoc().replace(/TC-1/g, "TC-99"));
    assert.throws(() => submit(), /기존 테스트에 없는 TC-99를 실행할 계획이 없습니다/);
    write(spec, specDoc());
    assert.match(submit(), /계획을 제출/);
  });

  test("22. hook 이 기존 테스트 파일 쓰기를 거부한다", () => {
    start(repo, join(repo, "doc/work/REF-1.md"));
    assert.match(writeFileHook(KEPT_TEST)!, /리팩토링은 기존 테스트를 고치지 않습니다/);
    // 기준 커밋에 없던 테스트 파일은 이 규칙이 아니다 (계획·스테이지 규칙이 따로 판정한다)
    assert.equal(/리팩토링은 기존 테스트/.test(writeFileHook(REPRO_TEST) ?? ""), false);
  });

  /** 매니페스트를 바꿔 끼운다 — 시작 **전에** 부른다 */
  function useManifest(overrides: Record<string, unknown>): void {
    write("code-agent.json", manifest({ test: ["node", "-e", "console.log('ok 1 - TC-1')"], ...overrides }));
    confirmDocs();
    git("add", "-A");
    git("commit", "-qm", "manifest");
  }

  test("H3: 도메인 단계의 refactor는 기존 테스트를 유지하며 제출부터 반영까지 완료한다", async () => {
    write(KEPT_TEST, "const {test}=require('node:test'),a=require('node:assert/strict'),{total}=require('../main/app/order');test('TC-1',()=>a.equal(total([2,3]),5));\n");
    useManifest({ domainRoots: [], test: ["node", "--test", KEPT_TEST], stages: [
      { key: "code", title: "코드", template: "01-code.md", scope: "domain", outputDirs: ["."] },
      { key: "test", title: "테스트", template: "02-test.md", kind: "test", scope: "project", outputDirs: ["src/test"] },
    ] });
    const originalTest = readFileSync(join(repo, KEPT_TEST));
    toPlan(); submit(); approve(); next(repo);
    assert.equal(writeFileHook(SRC), undefined);
    write(SRC, "module.exports.total=items=>items.reduce((sum,item)=>sum+item,0);\n"); next(repo);
    await finishDelivery("REF-1", SRC);
    assert.deepEqual(readFileSync(join(repo, KEPT_TEST)), originalTest);
  });

  test("22b. 테스트 단계가 kinds 에서 refactor 를 뺐어도 기존 테스트는 보호된다", () => {
    // 리팩토링은 새 테스트를 만들지 않으니 kinds 에서 빼는 것이 자연스럽다. 그때 보호가 꺼지면 안 된다.
    // 코드 단계의 자리는 src 전체라 이름표만으로는 기존 테스트가 계획에 들어온다.
    useManifest({
      stages: [
        { key: "code", title: "코드", template: "01-code.md", kinds: ["feature", "fix", "refactor"], scope: "project", outputDirs: ["src"] },
        { key: "test", title: "테스트", template: "02-test.md", kind: "test", kinds: ["feature", "fix"], scope: "project", outputDirs: ["src/test"] },
      ],
    });
    toPlan();
    assert.throws(
      () => submit({
        ...REF_PLAN,
        files: [...REF_PLAN.files, { stage: "code", path: KEPT_TEST, purpose: "기존 테스트를 고친다", requirements: ["R1"] }],
      }),
      /리팩토링은 기존 테스트를 고치지 않습니다 — 계획에서 빼세요/,
    );
    assert.match(writeFileHook(KEPT_TEST)!, /리팩토링은 기존 테스트를 고치지 않습니다/);
  });

  test("22c. 테스트 단계가 자리를 밝히지 않으면 소스 루트를 테스트로 읽지 않는다 — refactor 가 제 파일을 고친다", () => {
    // 테스트가 소스 옆에 있는 모양. 옛 코드는 domainBase 로 물러서서 src/main 전체를 '기존 테스트' 로 읽었다
    useManifest({
      stages: [
        { key: "code", title: "코드", template: "01-code.md", kinds: ["feature", "fix", "refactor"], scope: "project", outputDirs: ["src/main"] },
        { key: "test", title: "테스트", template: "02-test.md", kind: "test", kinds: ["feature", "fix", "refactor"], scope: "domain", outputDirs: ["."] },
      ],
    });
    assert.match(manifestCheck(repo).text, /test 는 kind:"test" 인데 자리를 밝히지 않았습니다/);
    toPlan();
    assert.match(submit(), /계획을 제출/);
    assert.equal(/리팩토링은 기존 테스트/.test(writeFileHook(SRC) ?? ""), false);
  });

  test("22d. plan 스테이지의 context 가 기존 테스트 보호를 미리 말해 준다", () => {
    toPlan();
    const text = context(repo);
    assert.match(text, /## refactor — 기존 테스트는 계획에 넣지 않는다/);
    assert.match(text, /기준 커밋에 이미 있던 테스트 자리\(src\/test\)/);
  });

  test("23. 기존 테스트가 바뀐 채로는 check 가 돌지 않는다 — 지워도 같다", async () => {
    toPlan();
    submit();
    approve();
    next(repo);
    write(SRC, "function total(items) {\n  let sum = 0;\n  for (const item of items) sum += item;\n  return sum;\n}\nmodule.exports = { total };\n");
    next(repo);
    assert.equal(loadActive(repo)!.phase, "check");

    writeFileSync(join(repo, KEPT_TEST), "// TC-1 기존 테스트 (몰래 고침)\n");
    await assert.rejects(() => check(requireValidatable(repo, "check")), /리팩토링이 기존 테스트를 고쳤습니다: \[M\]/);

    rmSync(join(repo, KEPT_TEST));
    await assert.rejects(() => check(requireValidatable(repo, "check")), /리팩토링이 기존 테스트를 고쳤습니다: \[D\]/);
  });

  test("24. preserve 가 계획에 없으면 제출되지 않는다 (회귀)", () => {
    toPlan();
    assert.throws(() => submit({ ...REF_PLAN, preserve: [] }), /preserve 가 계획에 없습니다/);
  });

  test("25. 테스트 명령이 선언되지 않으면 test·integrate 가 not-run 으로 막힌다 (회귀)", async () => {
    write("code-agent.json", manifest({ test: undefined }));
    write("doc/test-strategy.md", STRATEGY_NO_TEST);
    confirmDocs();
    git("add", "-A");
    git("commit", "-qm", "no-test");
    toPlan();
    submit();
    approve();
    next(repo);
    write(SRC, "function total(items) {\n  let sum = 0;\n  for (const item of items) sum += item;\n  return sum;\n}\nmodule.exports = { total };\n");
    next(repo);
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.ok(stageProblems(loadWork(repo)!, "test").some((problem) => /test: not-run/.test(problem)));
    assert.throws(() => next(repo), /test: not-run/);
    // 통합 검증도 같은 선언을 딛는다 — 선언이 없으면 거기서도 통과가 아니다
    assert.equal(integrateCommands(loadManifest(repo)).find((spec) => spec.kind === "test")!.argv, undefined);
  });
});

// ==== 3. 종류별 단계 ====

describe("P6 · 종류별 단계 인식", () => {
  beforeEach(() => {
    newRepo("ca-p6-kind-");
    write(SRC, "module.exports = {};\n");
    write("doc/work/FIX-1.md", FIX_ORDER);
    write(KEPT_TEST, "// 기존 테스트\n");
  });
  afterEach(dropRepo);

  function commitWith(overrides: Record<string, unknown>): void {
    write("code-agent.json", manifest(overrides));
    confirmDocs();
    git("add", "-A");
    git("commit", "-qm", "init");
  }

  test("26. feature 만 도는 매니페스트에서 fix 를 시작하면 고치는 법을 알려 준다", () => {
    commitWith({
      stages: [
        { key: "code", title: "코드", template: "01-code.md", kinds: ["feature"], scope: "project", outputDirs: ["src/main"] },
        { key: "test", title: "테스트", template: "02-test.md", kind: "test", kinds: ["feature"], scope: "project", outputDirs: ["src/test"] },
      ],
    });
    assert.throws(
      () => start(repo, join(repo, "doc/work/FIX-1.md")),
      (error: Error) =>
        /stages\[\]\.kinds 에 "fix" 를 더하세요/.test(error.message) &&
        /code\(feature\), test\(feature\)/.test(error.message) &&
        /code-agent manifest check/.test(error.message),
    );
  });

  test("27. manifest check 가 종류별 0단계를 경고하고 종료 코드는 0 이다", () => {
    commitWith({
      stages: [
        { key: "code", title: "코드", template: "01-code.md", kinds: ["feature"], scope: "project", outputDirs: ["src/main"] },
      ],
    });
    const result = manifestCheck(repo);
    assert.equal(result.ok, true);
    assert.match(result.text, /fix 로 돌 단계가 없습니다/);
    assert.match(result.text, /refactor 로 돌 단계가 없습니다/);
  });

  test("28. manifest check 가 kind:\"test\" 단계 없음을 경고한다 (fix 는 추가 문구)", () => {
    commitWith({
      stages: [
        { key: "code", title: "코드", template: "01-code.md", kinds: [], scope: "project", outputDirs: ["src/main"] },
      ],
    });
    const result = manifestCheck(repo);
    assert.equal(result.ok, true);
    assert.match(result.text, /feature 에 kind:"test" 단계가 없습니다 — 테스트 동결이 걸리지 않습니다/);
    assert.match(result.text, /fix 는 재현 테스트를 넣을 자리가 없어 plan submit 이 거부합니다/);
  });
});

// ==== 4. 빈 저장소 ====

const NEW_ORDER = ["---", "kind: feature", "id: NEW-1", "title: 인사 기능", "target: greeting", "---", "", "이름을 받아 인사한다.", ""].join("\n");

const NEW_PLAN = {
  domainName: "Greeting",
  domainLabel: "인사",
  domainRoot: "",
  domainDirName: "greeting",
  files: [
    { stage: "code", path: "src/main/app/greeting.js", purpose: "인사 함수", requirements: ["R1"] },
    { stage: "test", path: "src/test/greeting.test.js", purpose: "테스트", requirements: ["R1"] },
  ],
  sequence: [{ step: "code", why: "먼저" }, { step: "test", why: "다음" }],
  approach: "아키텍처 문서의 구조를 따른다 — 베낄 참조 코드가 없다",
  conventions: [], conflicts: [], openQuestions: [], reasoning: "신규 저장소",
};

describe("P6 · 빈 저장소", () => {
  beforeEach(() => {
    newRepo("ca-p6-new-");
    // 소스 파일이 하나도 없다 — code-agent.json 과 POLICY 문서만 있는 저장소
    write("code-agent.json", manifest());
    write("doc/work/NEW-1.md", NEW_ORDER);
    confirmDocs();
    git("add", "-A");
    git("commit", "-qm", "도입");
  });
  afterEach(dropRepo);

  test("29. survey 가 소스 파일이 없음을 코드로 판정한다", () => {
    const text = survey(repo);
    assert.match(text, /소스 파일이 없습니다 — 신규\(빈\) 저장소입니다/);
    assert.match(text, /언어 · 소스 루트\(domainBase\)/);
  });

  test("29b. 빌드 파일이 있는데 아는 확장자의 소스만 없으면 빈 저장소라고 단정하지 않는다", () => {
    // C·Swift·Dart 처럼 SOURCE_EXT 밖의 언어로 가득 찬 저장소 — 소스 0개로 세어진다
    write("Makefile", "all:\n\techo 만든다\n");
    write("src/main/app/order.c", "int total(void) { return 0; }\n");
    const text = survey(repo);
    assert.match(text, /지원 목록 밖 언어입니다/);
    assert.match(text, /코드가 실재하는지 사람에게 확인하세요/);
    assert.equal(/소스 파일이 없습니다 — 신규\(빈\) 저장소입니다/.test(text), false);
  });

  test("30. 참조 도메인·참조 파일이 없어도 manifest check 가 통과한다", () => {
    const result = manifestCheck(repo);
    assert.equal(result.ok, true);
    assert.match(result.text, /참조 파일을 선언한 단계가 없습니다 — 신규\(빈\) 저장소면 정상입니다/);
  });

  test("31. 참조 도메인이 없으면 context 가 문서를 가리킨다 — 던지지 않는다", () => {
    start(repo, join(repo, "doc/work/NEW-1.md"));
    write("doc/work/NEW-1/01-requirements.md",
      ["# NEW-1 요구사항 정의", "## R1 · 인사한다", "근거: \"이름을 받아 인사한다.\"", "- 데이터: 안 건드린다", "## 가정", "- 없음"].join("\n"));
    next(repo);
    const text = context(repo);
    assert.match(text, /## 참조 없음 — 아키텍처·컨벤션 문서로/);
    assert.match(text, /doc\/architecture\.md/);
    assert.match(text, /doc\/conventions\.md/);
  });

  test("32. 소스가 없는 저장소에서도 start → next → plan submit 이 지난다", () => {
    start(repo, join(repo, "doc/work/NEW-1.md"));
    write("doc/work/NEW-1/01-requirements.md",
      ["# NEW-1 요구사항 정의", "## R1 · 인사한다", "근거: \"이름을 받아 인사한다.\"", "- 데이터: 만든다", "## 가정", "- 없음"].join("\n"));
    write("doc/work/NEW-1/02-analysis.md", [
      "# 영향도 분석", "## 기존 시스템 분석", "- 붙을 코드가 없다 — 새 저장소다",
      "## 영향 범위", "| R 번호 | 닿는 파일/모듈 | 부르는 곳 | 파급 |", "|---|---|---|---|",
      "| R1 | src/main/app/greeting.js | 없음 | 없음 — 새 파일 |", "## Risk", "- 없음", "## 문서 영향", "| 문서 | 키 | 판단 | 근거 |", "|---|---|---|---|", "| - | - | 영향 없음 | 지식 항목이 없다 |",
    ].join("\n"));
    write("doc/work/NEW-1/03-design.md", [
      "# 기술 설계", "## 구성 요소", "- greeting", "## 처리 흐름", "- 이름을 받아 문자열을 만든다",
      "## API", "해당 없음 — 접점이 없다", "## 데이터", "해당 없음 — 저장하지 않는다", "## 설계 결정", "- 순수 함수로 둔다",
    ].join("\n"));
    write("doc/work/NEW-1/04-functional.md", [
      "# 기능 명세", "## 기능 정의", "- R1: 인사한다", "## 업무 규칙", "- 없음 — 규칙이 없다",
      "## 예외", "- 빈 이름: Error", "## 수락 기준", "- AC-R1-1: 이름을 주면 인사 문자열이 나온다",
    ].join("\n"));
    write("doc/work/NEW-1/07-test-spec.md", [
      "# 테스트 명세", "## 테스트 케이스", "| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |", "|---|---|---|---|---|",
      "| TC-1 | Unit | AC-R1-1 | 이름을 준다 | 인사 문자열이 나온다 |",
    ].join("\n"));
    next(repo);
    next(repo);
    next(repo);
    write("doc/work/NEW-1/plan.json", JSON.stringify(NEW_PLAN));
    assert.match(submitPlan(repo, join(repo, "doc/work/NEW-1/plan.json")), /계획을 제출/);
  });
});
