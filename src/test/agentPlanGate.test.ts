import { strict as assert } from "node:assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { abort, next, status, Stop, submitPlan } from "../agent/commands";
import { start } from "./confirmedStart";
import { loadActive, saveActive } from "../agent/layout";
import { observeAnswerFixture } from "./consentFixture";
import { APP, ORDER, MANIFEST, PLAN, ARCH, repo, write, approve, submit, writeDocs, toPlan, toImplement, git } from "./agentFixture";

import "./agentFixture";
describe("start — 문서 게이트와 작업 브랜치", () => {
  test("아키텍처 문서가 없으면 시작하지 않는다", () => {
    rmSync(join(repo, "doc/architecture.md"));
    assert.throws(() => start(repo, join(repo, "doc/work/ORD-1.md")), (error: Error) =>
      error instanceof Stop && /아키텍처: 파일이 없습니다/.test(error.message));
  });

  test("등록한 아키텍처 경로에 파일이 없으면 시작하지 않는다", () => {
    write("code-agent.json", JSON.stringify({ ...MANIFEST, docs: { architecture: "doc/arch/overview.md" } }));
    assert.throws(() => start(repo, join(repo, "doc/work/ORD-1.md")), /아키텍처: 파일이 없습니다: doc\/arch\/overview\.md/);
  });

  test("컨벤션 문서가 없으면 시작하지 않는다", () => {
    rmSync(join(repo, "doc/conventions.md"));
    assert.throws(() => start(repo, join(repo, "doc/work/ORD-1.md")), /코드 컨벤션: 파일이 없습니다/);
  });

  test("확정되지 않은 문서로는 시작하지 않는다", () => {
    rmSync(join(repo, ".code-agent/approvals/docs.jsonl"));
    assert.throws(() => start(repo, join(repo, "doc/work/ORD-1.md")), /사람의 확정이 없습니다/);
  });

  test("확정 뒤 바뀐 문서로는 시작하지 않는다", () => {
    write("doc/architecture.md", `${ARCH}\n## 추가\n내용\n`);
    assert.throws(() => start(repo, join(repo, "doc/work/ORD-1.md")), /확정 뒤 내용이 바뀌었습니다/);
  });

  test("기준 브랜치(기본 master)에서 <종류>/<ID> 를 딴다", () => {
    const out = start(repo, join(repo, "doc/work/ORD-1.md"));
    assert.match(out, /feature\/ORD-1 를 master 에서 만들었습니다/);
    assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "feature/ORD-1");
    assert.deepEqual(
      { branch: loadActive(repo)!.branch, base: loadActive(repo)!.base },
      { branch: "feature/ORD-1", base: "master" },
    );
  });

  test("사용자가 준 기준 브랜치가 매니페스트보다 앞선다", () => {
    write("code-agent.json", JSON.stringify({ ...MANIFEST, git: { base: "release" } }));
    git("add", "code-agent.json"); git("commit", "-qm", "prepare manifest");
    git("branch", "develop");
    start(repo, join(repo, "doc/work/ORD-1.md"), { base: "develop" });
    assert.equal(loadActive(repo)!.base, "develop");
  });

  test("매니페스트의 기준 브랜치를 쓴다", () => {
    write("code-agent.json", JSON.stringify({ ...MANIFEST, git: { base: "develop" } }));
    git("add", "code-agent.json"); git("commit", "-qm", "prepare manifest");
    git("branch", "develop");
    start(repo, join(repo, "doc/work/ORD-1.md"));
    assert.equal(loadActive(repo)!.base, "develop");
  });

  test("없는 기준 브랜치면 멈춘다", () => {
    assert.throws(() => start(repo, join(repo, "doc/work/ORD-1.md"), { base: "nope" }), /기준 브랜치가 없습니다: nope/);
    assert.equal(loadActive(repo), undefined);
  });

  test("이미 있는 작업 브랜치로는 전환만 한다", () => {
    git("branch", "feature/ORD-1");
    assert.match(start(repo, join(repo, "doc/work/ORD-1.md")), /이미 있는 작업 브랜치 feature\/ORD-1 로 전환/);
  });

  test("지시서에 없는 대상은 거부한다", () => {
    // 사람이 읽은 계획과 판정한 계획이 달라질 수 있다 — 대상은 지시서가 정한 것뿐이다.
    assert.throws(
      () => start(repo, join(repo, "doc/work/ORD-1.md"), { target: "없는대상" }),
      /지시서의 대상이 아닙니다: 없는대상/,
    );
    assert.equal(loadActive(repo), undefined);
  });

  test("다른 작업이 진행 중이면 시작하지 않는다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    write("doc/work/ORD-2.md", "---\nkind: feature\nid: ORD-2\ntitle: 다른 것\ntarget: order\n---\n");
    assert.throws(() => start(repo, join(repo, "doc/work/ORD-2.md")), /진행 중인 작업이 있습니다: ORD-1/);
  });
});

describe("next — 질문과 승인", () => {
  test("답이 없는 질문이 있으면 넘어가지 않는다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    const questions = join(repo, "doc/work/ORD-1/questions.md");
    writeDocs();
    writeFileSync(questions, `${readFileSync(questions, "utf-8")}\n## Q1 · 요구사항 분석\n금액 타입은?\nA. Long\nB. BigDecimal\n[Answer]:\n`);
    assert.throws(() => next(repo), /답이 없는 질문이 1개/);
    writeFileSync(questions, readFileSync(questions, "utf-8").replace(/\[Answer\]:\n$/, "[Answer]: B\n"));
    // 답은 질문 도구로 받은 것이어야 한다 — 관찰 없이 적은 답은 출처 미확인으로 막힌다
    assert.throws(() => next(repo), /답의 출처를 확인할 수 없는 질문이 1개/);
    observeAnswerFixture(repo, "ORD-1", "Q1", "BigDecimal");
    next(repo);
    assert.equal(loadActive(repo)!.phase, "impact");
  });

  test("계획이 승인되지 않으면 구현으로 넘어가지 않는다", () => {
    toPlan();
    assert.throws(() => next(repo), /제출된 계획이 없습니다/);
    submit();
    assert.throws(() => next(repo), /승인되지 않았습니다 \(none\)/);
    approve();
    next(repo);
    assert.deepEqual([loadActive(repo)!.phase, loadActive(repo)!.stage], ["implement", "entity"]);
  });

  test("단계의 계획 파일이 모두 있어야 다음 단계로, 마지막 뒤에는 check 로", () => {
    toImplement();
    assert.throws(() => next(repo), /단계 entity 의 파일 작업이 끝나지 않았습니다/);
    write(`${ORDER}/domain/Order.java`, "class Order {}\n");
    next(repo);
    assert.equal(loadActive(repo)!.stage, "repository");
    write(`${ORDER}/repository/OrderRepository.java`, "interface OrderRepository {}\n");
    next(repo);
    assert.equal(loadActive(repo)!.phase, "check");
  });

  test("계획에 파일이 없는 단계는 구현에서 건너뛴다 — 빈손으로 서브에이전트를 보내지 않는다", () => {
    toPlan();
    submit({ ...PLAN, files: [{ ...PLAN.files[1], requirements: ["R1", "R2"] }], sequence: [PLAN.sequence[1]] });
    approve();
    next(repo);
    assert.deepEqual([loadActive(repo)!.phase, loadActive(repo)!.stage], ["implement", "repository"]);
    assert.match(status(repo), /단계: \[repository\]$/m);
  });

  test("status 는 어디서 무엇을 기다리는지 보여 준다", () => {
    toPlan();
    submit();
    assert.match(status(repo), /계획: 제출됨 · 승인 none/);
    assert.match(status(repo), /현재 호스트 세션[\s\S]*plan 동의 절차/);
  });
});

describe("plan submit — 제출 전 검사", () => {
  beforeEach(toPlan);

  test("단계 위치 밖의 파일은 계획에 넣을 수 없다", () => {
    const plan = { ...PLAN, files: [{ stage: "entity", path: `${ORDER}/repository/X.java`, purpose: "x" }] };
    assert.throws(() => submit(plan), /do-not-touch 경계/);
  });

  test("모르는 단계는 거부한다", () => {
    assert.throws(() => submit({ ...PLAN, files: [{ stage: "nope", path: `${ORDER}/domain/A.java`, purpose: "x" }] }), /알 수 없는 단계 nope/);
  });

  test("남은 질문이 있으면 제출되지 않는다 — questions.md 로 보낸다", () => {
    assert.throws(() => submit({ ...PLAN, openQuestions: ["금액 타입?"] }), /남은 질문이 있습니다/);
  });

  test("형식이 틀리면 어디가 틀렸는지 알린다", () => {
    assert.throws(() => submit({ ...PLAN, files: "x" }), /계획 형식이 맞지 않습니다[\s\S]*files/);
  });

  test("plan 스테이지가 아니면 받지 않는다", () => {
    saveActive(repo, { ...loadActive(repo)!, phase: "analysis" });
    assert.throws(() => submit(), /plan 스테이지에서 제출합니다/);
  });

  /**
   * 보존 조건이 빠진 계획이 승인 화면에 올라가는 것이 고치는 작업에서 가장 위험한 실패다.
   * 문장을 그대로 옮기게 해 두면 대조를 코드가 하고, 걸린 계획은 제출 자체가 막힌다.
   */
  test("kind: refactor — 보존 조건이 빠진 계획은 제출되지 않는다", () => {
    const DEAL = `${APP}/deal`;
    abort(repo);
    git("switch", "-q", "master");
    // 고치는 작업은 Entity~Controller 를 순차 생성하지 않는다 — 경계는 지시서가 정한다.
    write("code-agent.json", JSON.stringify({
      ...MANIFEST,
      stages: [...MANIFEST.stages, {
        key: "restructure", title: "구조 정리", template: "90-restructure.md",
        kinds: ["refactor"], scope: "project", exemplars: [], outputDirs: [],
      }],
    }));
    git("add", "code-agent.json"); git("commit", "-qm", "prepare refactor manifest");
    // abort 한 ORD-1 의 작업 폴더가 미추적으로 남으면 새 작업 브랜치로 따라가 start 가 거부한다
    git("add", "-A", "doc/work/ORD-1"); git("commit", "-qm", "ORD-1 작업 문서");
    write("doc/work/REF-1.md", [
      "---", "kind: refactor", "id: REF-1", "title: 거래 경계 정리",
      `target: ${DEAL}`, `scope: [${DEAL}]`,
      `preserve: [${DEAL}/repository/DealRepository.java, DealFacade 공개 시그니처]`,
      "---", "", "경계만 옮긴다.", "",
    ].join("\n"));
    start(repo, join(repo, "doc/work/REF-1.md"));
    write("doc/work/REF-1/01-requirements.md",
      ["## R1 · 경계 정리", "근거: \"경계만 옮긴다.\"", "- 데이터: 안 건드린다", "## 가정", "- 없음", ""].join("\n"));
    write("doc/work/REF-1/02-analysis.md", [
      // refactor 의 ② 는 '지금 동작' 을 근거 path:line 과 함께 적어야 지난다
      "## 기존 시스템 분석", `- DealFacade 가 트랜잭션을 연다 — ${DEAL}/facade/DealFacade.java:42`,
      "## 영향 범위", "| R 번호 | 닿는 파일 | 부르는 곳 | 파급 |", "|---|---|---|---|", "| R1 | Deal.java | DealFacade | 없음 |",
      "## Risk", "- 없음 — 시그니처를 바꾸지 않는다", "## 문서 영향", "| 문서 | 키 | 판단 | 근거 |", "|---|---|---|---|", "| - | - | 영향 없음 | 지식 항목이 없다 |", "",
    ].join("\n"));
    write("doc/work/REF-1/03-design.md", [
      "## 구성 요소", "- Deal", "## 처리 흐름", "- 그대로", "## API", "해당 없음 — 접점을 안 건드린다",
      "## 데이터", "해당 없음 — 스키마를 안 건드린다", "## 설계 결정", "- 경계만 옮긴다", "",
    ].join("\n"));
    write("doc/work/REF-1/04-functional.md", [
      "## 기능 정의", "- R1: 동작은 그대로", "## 업무 규칙", "- 없음 — 규칙 변경 없음",
      "## 예외", "- 없음 — 기존 예외 그대로", "## 수락 기준", "- AC-R1-1: 기존 테스트가 그대로 통과한다", "",
    ].join("\n"));
    write("doc/work/REF-1/07-test-spec.md", [
      "## 테스트 케이스", "| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |", "|---|---|---|---|---|",
      "| TC-1 | Unit | AC-R1-1 | 기존 테스트 | 통과 |", "",
    ].join("\n"));
    next(repo);
    next(repo);
    next(repo);

    const base = {
      files: [{ stage: "restructure", path: `${DEAL}/domain/Deal.java`, purpose: "경계를 옮긴다", requirements: ["R1"] }],
      sequence: [{ step: "restructure", why: "옮길 곳이 하나다" }],
      approach: "트랜잭션 경계만 서비스로 옮긴다",
      conventions: [], conflicts: [], openQuestions: [], reasoning: "경계만 옮긴다",
    };
    const submitRef = (plan: unknown) => {
      write("doc/work/REF-1/plan.json", JSON.stringify(plan));
      return submitPlan(repo, join(repo, "doc/work/REF-1/plan.json"));
    };

    // 문장 하나를 흘린 계획 — 요약·의역도 누락으로 본다.
    assert.throws(
      () => submitRef({ ...base, preserve: [{ item: "DealFacade 공개 시그니처", how: "그대로 둔다" }] }),
      /preserve 가 계획에 없습니다: .*DealRepository\.java/,
    );
    // 다 든 계획은 제출된다.
    submitRef({ ...base, preserve: [
      { item: `${DEAL}/repository/DealRepository.java`, how: "열지 않는다" },
      { item: "DealFacade 공개 시그니처", how: "그대로 둔다" },
    ] });
  });
});
