import { strict as assert } from "node:assert";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { context, next, status, Stop } from "../agent/commands";
import { start } from "./confirmedStart";
import { loadActive, saveActive } from "../agent/layout";
import type { ActiveWork } from "../agent/layout";
import { formatAssumptions, parseRequirements } from "../agent/workDocs";
import { TEST_STRATEGY_DOC, repo, confirmDocs, write, submit, REQUIREMENTS, IMPACT, DESIGN, FUNCTIONAL, TEST_SPEC, writeDocs, toPlan, toImpact, toDesign, git } from "./agentFixture";

import "./agentFixture";
describe("① 01-requirements.md — 요구 항목", () => {
  test("요구사항 정의가 없으면 영향도 분석으로 넘어가지 않는다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    assert.throws(() => next(repo), /요구사항 분석 결과가 없습니다: doc\/work\/ORD-1\/01-requirements\.md/);
  });

  test("요구 항목·근거·가정이 없으면 무엇이 틀렸는지 알린다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    write("doc/work/ORD-1/01-requirements.md", "# 정의\n\n주문을 만든다.\n");
    assert.throws(() => next(repo), /요구 항목\(`## R1 · …`\)이 없습니다[\s\S]*`## 가정` 섹션이 없습니다/);
    // 근거가 없는 요구는 지시서에 없는 요구다 — 모델이 보탠 것이 여기서 걸린다
    write("doc/work/ORD-1/01-requirements.md", "## R1 · 등록\n- 데이터: 만든다\n## 가정\n- 없음\n");
    assert.throws(() => next(repo), /근거: 줄이 없는 요구 항목: R1/);
    write("doc/work/ORD-1/01-requirements.md", "## R1 · a\n근거: \"x\"\n## R1 · b\n근거: \"y\"\n## 가정\n- 없음\n");
    assert.throws(() => next(repo), /번호가 겹칩니다: R1/);
    write("doc/work/ORD-1/01-requirements.md", REQUIREMENTS);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "impact");
  });

  test("가정은 진행을 막지 않고, 제출 결과·승인 화면에 그대로 보인다", () => {
    const withAssumptions = REQUIREMENTS.replace(
      "## 가정\n- 없음",
      "## 가정\n- 목록은 id 내림차순 — 근거: 일반 관행\n- amount 는 precision 15, scale 2 — 근거: 선례 없음\n\n판정 근거:\n- 이건 가정이 아니다",
    );
    start(repo, join(repo, "doc/work/ORD-1.md"));
    writeDocs({ requirements: withAssumptions });
    const parsed = parseRequirements(readFileSync(join(repo, "doc/work/ORD-1/01-requirements.md"), "utf-8"));
    assert.deepEqual(parsed.assumptions, ["목록은 id 내림차순 — 근거: 일반 관행", "amount 는 precision 15, scale 2 — 근거: 선례 없음"]);
    next(repo);
    next(repo);
    next(repo);
    assert.match(submit(), /가정 2개 — 승인하면 계획과 함께 받아들입니다[\s\S]*- 목록은 id 내림차순/);
    assert.equal(formatAssumptions([]), undefined, "가정이 없으면 보이지 않는다");
  });

  /**
   * 가정이 조용히 빈 배열이 되면 승인 화면·05-plan.md 어디에도 실리지 않는데 게이트는 통과한다 —
   * 사람이 계획과 함께 받아들이기로 한 것이 아무에게도 보이지 않는 상태다.
   */
  test("가정은 앞의 설명 줄·CRLF·별칭 제목에도 읽힌다", () => {
    const expected = ["정렬은 id 내림차순 — 근거: 일반 관행", "금액은 BigDecimal — 근거: 선례 없음"];
    const prose = REQUIREMENTS.replace(
      "## 가정\n- 없음",
      `## 가정\n아래와 같이 정했다.\n\n- ${expected[0]}\n- ${expected[1]}`,
    );
    assert.deepEqual(parseRequirements(prose).assumptions, expected, "목록 앞의 산문");
    assert.deepEqual(parseRequirements(prose.replace(/\n/g, "\r\n")).assumptions, expected, "CRLF");
    // 스키마가 선언한 별칭(가정과 근거)·번호·괄호 설명도 다른 섹션 검사와 같게 받는다
    assert.deepEqual(parseRequirements(REQUIREMENTS.replace("## 가정", "## 1. 가정과 근거 (기본값)")).assumptions, []);
  });

  test("모르는 스테이지(P3 의 research)로 남은 커서는 이어 가지 않는다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    saveActive(repo, { ...loadActive(repo)!, phase: "research" as ActiveWork["phase"] });
    assert.throws(() => next(repo), (error: Error) => error instanceof Stop && /알 수 없는 스테이지입니다: research/.test(error.message));
    assert.throws(() => status(repo), /알 수 없는 스테이지입니다: research/);
    assert.throws(() => context(repo), /알 수 없는 스테이지입니다: research/);
  });
});

describe("② 02-analysis.md — 영향 범위 표에 모든 R", () => {
  test("없거나 필수 섹션이 비면 설계로 넘어가지 않는다", () => {
    toImpact();
    assert.throws(() => next(repo), /02-analysis\.md — 없거나 비어 있습니다 \(code-agent docs skeleton 02-analysis\)/);
    write("doc/work/ORD-1/02-analysis.md", IMPACT.replace("- 없음 — 기존 경로를 건드리지 않는다", ""));
    assert.throws(() => next(repo), /필수 섹션이 비었거나 없습니다: Risk/);
  });

  test("표 첫 열에 빠진 R 이 있으면 넘어가지 않는다 — 본문에 번호가 등장하는 것으로는 안 된다", () => {
    toImpact();
    const onlyR1 = IMPACT.replace("| R2 | 새 파일 | 없음 | 없음 — 새 도메인 |\n", "")
      .replace("- 주문 도메인은 아직 없다 (참조: deal)", "- 주문 도메인은 아직 없다. R2 는 영향이 없다");
    write("doc/work/ORD-1/02-analysis.md", onlyR1);
    assert.throws(() => next(repo), /영향 범위 표에 없는 요구 항목: R2/);
    write("doc/work/ORD-1/02-analysis.md", IMPACT);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "design");
  });

  test("R 번호만 적고 나머지 칸이 빈 줄은 영향을 본 것이 아니다", () => {
    toImpact();
    write("doc/work/ORD-1/02-analysis.md", IMPACT.replace("| R2 | 새 파일 | 없음 | 없음 — 새 도메인 |", "| R2 | | | |"));
    assert.throws(() => next(repo), /영향 범위 표의 줄이 비었습니다: R2/);
  });
});

describe("③ 03-design.md · ④ 04-functional.md — 설계·정의", () => {
  test("근거 없는 `해당 없음` 은 미충족이다", () => {
    toDesign();
    write("doc/work/ORD-1/04-functional.md", FUNCTIONAL);
    // 목록 표시·강조를 붙여도 근거 없는 한 단어인 것은 같다
    for (const decorated of ["해당 없음", "- 해당 없음", "**해당 없음**", "- **해당 없음**"]) {
      write("doc/work/ORD-1/03-design.md", DESIGN.replace("해당 없음 — 이번 범위는 도메인·저장소까지다", decorated));
      assert.throws(() => next(repo), /해당 없음 에 근거가 없습니다: API/, decorated);
    }
    write("doc/work/ORD-1/03-design.md", DESIGN);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "plan");
  });

  test("R 마다 AC 가 하나는 있어야 하고, 겹치거나 없는 R 을 가리킬 수 없다", () => {
    toDesign();
    write("doc/work/ORD-1/03-design.md", DESIGN);
    write("doc/work/ORD-1/04-functional.md", FUNCTIONAL.replace("- AC-R2-1: 없는 주문을 조회하면 ORDER_NOT_FOUND 다", ""));
    assert.throws(() => next(repo), /AC 가 없는 요구 항목: R2/);
    write("doc/work/ORD-1/04-functional.md", FUNCTIONAL.replace("AC-R2-1", "AC-R9-1"));
    assert.throws(() => next(repo), /01 에 없는 요구 항목을 가리키는 수락 기준: AC-R9-1/);
    write("doc/work/ORD-1/04-functional.md", FUNCTIONAL.replace("AC-R2-1", "AC-R1-1"));
    assert.throws(() => next(repo), /수락 기준 id 가 겹칩니다: AC-R1-1/);
  });

  test("필수 섹션이 비면 넘어가지 않는다", () => {
    toDesign();
    write("doc/work/ORD-1/03-design.md", DESIGN);
    write("doc/work/ORD-1/04-functional.md", FUNCTIONAL.replace("- 없음 — 사용자 답에 규칙이 없다", ""));
    assert.throws(() => next(repo), /필수 섹션이 비었거나 없습니다: 업무 규칙/);
  });
});

describe("⑦ 07-test-spec.md — 모든 AC 가 TC 에", () => {
  test("테스트 명세가 없으면 계획이 제출되지 않는다", () => {
    toPlan();
    rmSync(join(repo, "doc/work/ORD-1/07-test-spec.md"));
    assert.throws(() => submit(), /07-test-spec\.md — 없거나 비어 있습니다/);
  });

  test("표를 읽지 못하거나 AC 가 안 덮이면 제출되지 않는다", () => {
    toPlan();
    write("doc/work/ORD-1/07-test-spec.md", "## 테스트 케이스\n- TC-1: 주문 저장 (AC-R1-1)\n");
    assert.throws(() => submit(), /테스트 케이스 표를 읽지 못했습니다/);
    write("doc/work/ORD-1/07-test-spec.md", TEST_SPEC.replace("\n| TC-2 | Unit | AC-R2-1 | 없는 주문 조회 | ORDER_NOT_FOUND |", ""));
    assert.throws(() => submit(), /테스트 케이스가 없는 수락 기준: AC-R2-1/);
    write("doc/work/ORD-1/07-test-spec.md", TEST_SPEC.replace("| TC-2 | Unit | AC-R2-1", "| TC-1 | Unit | AC-R9-1"));
    assert.throws(() => submit(), /TC id 가 겹칩니다: TC-1[\s\S]*04 에 없는 수락 기준을 가리킵니다: AC-R9-1/);
  });

  test("전략이 '하지 않음' 이라 한 수준은 `안 하는 것` 에 근거가 있어야 쓴다", () => {
    write("doc/test-strategy.md", TEST_STRATEGY_DOC.replace("- Unit: 필수", "- Unit: 필수\n- E2E: 하지 않음"));
    confirmDocs();
    git("add", "doc/test-strategy.md"); git("commit", "-qm", "prepare strategy");
    toPlan();
    const e2e = TEST_SPEC.replace("| TC-2 | Unit | AC-R2-1", "| TC-2 | E2E | AC-R2-1");
    write("doc/work/ORD-1/07-test-spec.md", e2e);
    assert.throws(() => submit(), /테스트 전략이 '하지 않음' 이라 한 수준을 씁니다: E2E/);
    write("doc/work/ORD-1/07-test-spec.md", `${e2e}\n## 안 하는 것\n- E2E 를 쓰는 이유: 조회 경로가 화면까지 걸린다 (사용자 답 Q1)\n`);
    submit();
  });

  /**
   * 부정을 줄 전체에서 찾으면 조건을 적은 수준 줄이 '하지 않음' 으로 분류돼, 빠져나갈 길이
   * 확정된 POLICY 문서를 고치는 것뿐인 자리에서 정상적인 제출이 막힌다.
   */
  test("수준 줄의 조건 설명은 '하지 않음' 이 아니다", () => {
    write("doc/test-strategy.md", TEST_STRATEGY_DOC.replace("- Unit: 필수", "- Unit: 분기 있는 로직만 — 단순 위임은 하지 않음"));
    confirmDocs();
    git("add", "doc/test-strategy.md"); git("commit", "-qm", "prepare strategy");
    toPlan();
    assert.match(submit(), /계획을 제출하고/);
  });

  test("케이스·기대 결과가 빈 줄로는 AC 를 덮지 못한다 — 열은 다섯 개다", () => {
    toPlan();
    const header = "## 테스트 케이스\n| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |\n|---|---|---|---|---|\n";
    write("doc/work/ORD-1/07-test-spec.md", `${header}| TC-1 | Unit | AC-R1-1 AC-R2-1 | | |\n`);
    assert.throws(() => submit(), /케이스·기대 결과가 빈 테스트 케이스: TC-1/);
    // 열을 줄여 쓴 줄은 아예 케이스로 읽지 않는다
    write("doc/work/ORD-1/07-test-spec.md", `${header}| TC-1 | Unit | AC-R1-1 AC-R2-1 |\n`);
    assert.throws(() => submit(), /테스트 케이스 표를 읽지 못했습니다/);
  });

  test("전략에서 수준을 읽지 못하면 대조를 건너뛰고 그 사실을 알린다", () => {
    write("doc/test-strategy.md", TEST_STRATEGY_DOC.replace("- Unit: 필수", "- 자세한 것은 팀 위키를 따른다"));
    confirmDocs();
    git("add", "doc/test-strategy.md"); git("commit", "-qm", "prepare strategy");
    toPlan();
    assert.match(submit(), /참고: 테스트 전략의 `수준과 범위` 에서 수준을 읽지 못해 수준 대조는 건너뛰었습니다/);
  });
});
