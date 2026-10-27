import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { next, requireValidatable, submitPlan } from "../agent/commands";
import { stageProblems } from "../agent/evidence";
import { check, runTests } from "../agent/validate";
import { renderVerification, verificationJson, verify } from "../agent/verificationFlow";
import { loadWork } from "../agent/work";
import { start } from "./confirmedStart";
import {
  DESIGN, FAIL_UNTIL_FIXED, FUNCTIONAL, IMPACT, ORDER, PLAN, REQUIREMENTS, TEST_FILE, TEST_SPEC, createStageRepo, removeStageRepo, repo, toCheck, useManifest, write,
} from "./stageFixture";

/**
 * 수정 루프의 입력 — 검증 실패의 수정 배정 파일(repairFile), TC 표기 근접 오류 안내, 뒤 단계(02·03)의 가정이 승인 묶음에 실리는 것.
 * 임시 git 저장소(stageFixture)에 실제 함수를 그대로 부른다.
 */
beforeEach(() => createStageRepo("ca-repair-"));

afterEach(() => removeStageRepo());

describe("검증 수정 배정", () => {
  test("repair 노드는 실패 명령·로그·실패 TC→AC·고칠 수 없는 테스트·남은 회차를 코드가 모은 파일로 넘긴다", async () => {
    useManifest({ test: FAIL_UNTIL_FIXED });
    toCheck();
    const result = await verify(repo);
    assert.equal(result.node, "repair");
    assert.match(result.repairFile ?? "", /^\.code-agent\/work\/ORD-1\/handoff\/repair-1\.md$/);
    const text = readFileSync(join(repo, result.repairFile!), "utf8");
    assert.match(text, /^- test·test: failed .* · 전체 로그 \S+/m);
    assert.match(text, /\| TC-1 \| failed \| AC-R1-1 \| 주문 저장 → id 가 생긴다 \|/);
    assert.ok(!/\| TC-2 \|/.test(text), "통과한 TC 는 싣지 않는다");
    // 결과가 인식돼 실패한 TC 뿐이면 할 일은 코드 수정이다 — 'TC id 를 남기세요' 를 싣지 않는다. 실패 명령 줄은 문제에 되풀이하지 않는다
    assert.match(text, /TC-1\(failed\) — 필수 TC가 실제 실행되어 passed여야 합니다\. 실패한 TC는 테스트를 약하게 하지 않고 계획 안의 코드를 고칩니다/);
    assert.ok(!/TC id를 남기세요/.test(text));
    assert.equal(text.split("- test: failed").length - 1, 0, text);
    assert.match(text, new RegExp(`- 계획 파일: ${ORDER}/domain/Order\\.java`));
    // 결과가 인식된 test 실행 뒤라 테스트 파일은 얼어 있다 — 범위를 넓히지 않고 고칠 수 없다는 것을 알린다
    assert.match(text, new RegExp(`- 고칠 수 없는 테스트 파일\\(동결·기존 테스트\\): ${TEST_FILE}`));
    assert.match(text, /- 남은 회차: 남은 고쳐 쓰기 \d+회/);
    assert.match(text, /검증 명령·단언·기대값을 약하게 만들어 통과시키지 않는다/);
    assert.match(renderVerification(result), new RegExp(`수정 배정: ${result.repairFile}`));
    assert.equal(JSON.parse(verificationJson(result)).repairFile, result.repairFile);
  });

  test("컴파일 오류가 가리킨 계획 파일을 로그에서 골라 싣는다 — 실패 TC 표·동결 줄은 없다", async () => {
    useManifest({ build: ["node", "-e", `console.error('${ORDER}/domain/Order.java:1: error: missing symbol'); process.exit(2)`] });
    toCheck();
    const result = await verify(repo);
    assert.equal(result.node, "repair");
    const text = readFileSync(join(repo, result.repairFile!), "utf8");
    assert.match(text, new RegExp(`## 로그에 나온 계획 파일\\n\\n- ${ORDER}/domain/Order\\.java\\n`));
    assert.ok(!text.includes(`- ${ORDER}/repository/OrderRepository.java\n`), "로그에 없는 계획 파일은 그 목록에 넣지 않는다");
    assert.ok(!/실패한 TC/.test(text));
    assert.ok(!/고칠 수 없는 테스트 파일/.test(text), "test 가 돌기 전에는 동결이 없다");
  });
});

describe("TC 표기 안내", () => {
  test("TC_1·tc-1 처럼 인식되지 않는 표기는 check 사전 점검과 test 결과 미확인 줄이 고칠 표기를 알린다", async () => {
    useManifest({ test: ["node", "-e", "console.log('ok 1 - tc_1 saves'); console.log('ok 2 - TC-2')"] });
    toCheck();
    write(TEST_FILE, "// tc_1 saves · TC-2\nclass OrderTest {}\n");
    const checked = await check(requireValidatable(repo, "check"));
    assert.match(checked, /!! ⑦ 의 TC id 가 대조 대상 파일에 없습니다: TC-1 /);
    assert.match(checked, /TC-1: 계획 파일에 tc_1 가 있습니다 — 결과는 TC-1 표기\(대문자 TC, 하이픈, 숫자\)만 인식합니다/);
    next(repo);
    const tested = await runTests(requireValidatable(repo, "test"));
    assert.match(tested, /TC-1: TC 대조 대상 파일에 id가 없습니다/);
    assert.match(tested, /TC-1: 계획 파일에 tc_1 가 있습니다/);
    assert.ok(!/TC-2: 계획 파일에/.test(tested), "인식된 TC 는 안내하지 않는다");
    const gate = stageProblems(loadWork(repo)!, "test").join("\n");
    assert.match(gate, /TC-1\(unknown\) — .*결과에 TC id를 남기세요/, "결과가 인식되지 않은 TC 는 이름 안내를 그대로 받는다");
  });

  test("결과 인식과 같은 경계로 찾는다 — TC-1_saves 는 있는 것이고 TC-1a 는 근접 표기다", async () => {
    toCheck();
    write(TEST_FILE, "// TC-1_saves · TC-2\nclass OrderTest {}\n");
    assert.ok(!/!! ⑦ 의 TC id/.test(await check(requireValidatable(repo, "check"))));
    write(TEST_FILE, "// TC-1a · TC-2\nclass OrderTest {}\n");
    const checked = await check(requireValidatable(repo, "check"));
    assert.match(checked, /TC-1: 계획 파일에 TC-1a 가 있습니다/);
  });
});

describe("뒤 단계의 가정", () => {
  test("02·03 의 `## 가정` 은 출처 문서를 붙여 제출 결과·05-plan 에 01 의 가정과 함께 실린다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    write("doc/work/ORD-1/01-requirements.md", REQUIREMENTS);
    write("doc/work/ORD-1/02-analysis.md", `${IMPACT}\n## 가정\n- 조회 캐시는 두지 않는다 — 기존 저장소에 캐시 계층이 없다\n`);
    write("doc/work/ORD-1/03-design.md", `${DESIGN}\n## 가정\n- 없음\n`);
    write("doc/work/ORD-1/04-functional.md", FUNCTIONAL);
    write("doc/work/ORD-1/07-test-spec.md", TEST_SPEC);
    next(repo);
    next(repo);
    next(repo);
    write("doc/work/ORD-1/plan.json", JSON.stringify(PLAN));
    const output = submitPlan(repo, join(repo, "doc/work/ORD-1/plan.json"));
    assert.match(output, /- 조회 캐시는 두지 않는다 — 기존 저장소에 캐시 계층이 없다 \(02-analysis\.md\)/);
    assert.ok(!/없음 \(03-design\.md\)/.test(output), "`없음` 은 가정이 아니다");
    const doc = readFileSync(join(repo, "doc/work/ORD-1/05-plan.md"), "utf8");
    assert.match(doc, /### 가정 \(01-requirements\.md · 02·03 은 항목 끝에\)\n- 조회 캐시는 두지 않는다 — 기존 저장소에 캐시 계층이 없다 \(02-analysis\.md\)/);
  });
});
