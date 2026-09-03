/**
 * kind: spec — 스펙 문서를 왕복으로 만든다.
 *
 * 여기서 판정되는 것은 **문서의 내용이 어디서 오는가**다. 스펙은 이후 모든 실행의 근거인데,
 * 목적·사용자·범위는 사람만 아는 것이라 모델이 읽어 올 곳이 없다. 그래서 이 종류는
 * "빈칸을 코드가 찾아 묻고, 사람이 답하고, 모델은 옮겨 적기만 한다"로 돈다.
 *
 * 스타터(starter/spec)를 그대로 쓴다 — 실제로 배포되는 선언이 이 절차를 돌릴 수 있는지가
 * 이 테스트의 절반이다.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { readQuestions, writeQuestions } from "../core/session";
import { applyResponse, decideApproval, nextPrompt } from "../core/turn";
import type { BuildContext } from "../core/types";

/** 배포되는 스타터를 그대로 쓴다 — dist/test 에서 저장소 뿌리로 두 단계 올라간다. */
const STARTER = join(__dirname, "..", "..", "starter", "spec");

const SEED =
  "---\nkind: spec\nid: NEW-1\ntitle: 주문 관리 서비스 스펙\ntarget: order-service\n---\n\n" +
  "# 씨앗\n사내 주문 관리 백엔드를 새로 만들려고 한다.\n";

const PLAN = {
  domainName: "order-service",
  domainLabel: "프로젝트",
  domainRoot: "",
  domainDirName: "",
  files: [{ stage: "spec-doc", path: "doc/spec.md", purpose: "스펙 문서" }],
  conventions: [],
  conflicts: [],
  openQuestions: [] as string[],
  reasoning: "사람이 답한 것을 문서로 옮긴다",
};

/** 아무것도 읽히지 않은 추출 결과. 씨앗에는 목적 한 줄뿐이라 이것이 정상이다. */
const EMPTY_INTAKE = {
  slots: [
    { key: "purpose", value: "", evidence: "" },
    { key: "users", value: "", evidence: "" },
    { key: "domains", value: "", evidence: "" },
    { key: "capabilities", value: "", evidence: "" },
    { key: "constraints", value: "", evidence: "" },
  ],
};

const ANSWERS: Record<string, string> = {
  purpose: "주문 접수가 엑셀로 돌아 누락이 잦다. 그걸 시스템으로 옮긴다",
  users: "사내 영업팀 100명",
  domains: "order · customer · product",
  capabilities: "주문 접수 · 상태 변경 · 조회. 정산은 이번에 하지 않는다",
};

function writeAction(path: string, body: string): string {
  return ["### write " + path, "```", body, "```", "", "### done", ""].join("\n");
}

let root: string;
let context: BuildContext;

/** 1차 게이트가 남긴 질문에 사람이 답한 상태를 만든다. */
function answerAll(lane: string): void {
  writeQuestions(
    lane,
    readQuestions(lane).map((question) => ({
      ...question,
      answer: ANSWERS[question.target.replace("intake:", "")] ?? "",
    })),
  );
}

function runUpToStage(): string {
  const lane = applyResponse(context, JSON.stringify(EMPTY_INTAKE)).outDir;
  answerAll(lane);

  applyResponse(context, JSON.stringify(PLAN));
  decideApproval(context, "approved", { approver: "카이", target: "order-service" });
  return lane;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-spec-"));
  // 스펙을 둘 폴더. 저장소는 아직 없다 — 승인 기록은 이 폴더에 남는다.
  mkdirSync(join(root, "specs"), { recursive: true });
  writeFileSync(join(root, "seed.md"), SEED, "utf-8");

  context = {
    specPaths: [join(root, "seed.md")],
    templatesDir: STARTER,
    repoRoot: join(root, "specs"),
    outDir: join(root, "out"),
    gate: false,
    maxRetries: 1,
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("빈칸은 코드가 찾아 묻는다", () => {
  test("씨앗에서 읽히지 않은 필수 항목이 질문으로 남는다", () => {
    assert.equal(nextPrompt(context).label, "intake");

    const outcome = applyResponse(context, JSON.stringify(EMPTY_INTAKE));

    assert.equal(outcome.questionsAdded, 4);
    const targets = readQuestions(outcome.outDir).map((question) => question.target);
    assert.deepEqual(targets, [
      "intake:purpose",
      "intake:users",
      "intake:domains",
      "intake:capabilities",
    ]);
  });

  test("확정된 것이 없다고 적어 둔 항목은 묻지 않는다 — 비워 두는 것이 답이다", () => {
    const outcome = applyResponse(context, JSON.stringify(EMPTY_INTAKE));

    const asked = readQuestions(outcome.outDir).map((question) => question.target);
    assert.equal(asked.includes("intake:constraints"), false);
  });

  test("답하지 않으면 계획으로 넘어가지 않는다", () => {
    applyResponse(context, JSON.stringify(EMPTY_INTAKE));

    const next = nextPrompt(context);

    assert.equal(next.label, "blocked");
    assert.equal(next.prompt, undefined);
  });
});

describe("모델은 옮겨 적기만 한다", () => {
  test("사람이 답한 것이 단계 프롬프트에 실린다", () => {
    runUpToStage();

    const next = nextPrompt(context);

    assert.equal(next.label, "spec-doc");
    assert.match(next.prompt!, /# 사람이 답한 것/);
    assert.match(next.prompt!, /사내 영업팀 100명/);
    assert.match(next.prompt!, /정산은 이번에 하지 않는다/);
  });

  test("언어·프레임워크를 적지 말라는 규칙이 프롬프트에 실린다", () => {
    runUpToStage();

    const prompt = nextPrompt(context).prompt!;

    assert.match(prompt, /언어·프레임워크·계층·DB·식별자 전략을 적지 않는다/);
    assert.match(prompt, /아키텍처 결정서는 이 문서의 입력이 아니라 다음 실행의 산출물이다/);
  });

  test("스펙 문서 한 장이 생기고, 다음 실행의 지시서 머리말을 달고 나온다", () => {
    const lane = runUpToStage();
    const body =
      "---\nkind: bootstrap\nid: NEW-1\ntitle: 주문 관리 서비스 신규 구축\ntarget: order-service\n---\n\n" +
      "# 프로젝트 개요\n사내 영업팀 100명이 쓰는 주문 관리 백엔드를 새로 만든다.\n";

    const outcome = applyResponse(context, writeAction("doc/spec.md", body));

    assert.equal(outcome.violations.length, 0);
    assert.equal(outcome.advanced, true);
    const written = readFileSync(join(lane, "doc", "spec.md"), "utf-8");
    assert.match(written, /^---\nkind: bootstrap\n/);
  });
});

describe("경계는 이 종류에서도 그대로다", () => {
  test("선언한 위치 밖에는 쓰지 못한다", () => {
    runUpToStage();

    const outcome = applyResponse(context, writeAction("spec.md", "# 아무 데나"));

    assert.equal(outcome.execution!.writtenFiles.length, 0);
    assert.equal(outcome.violations[0].item, "do-not-touch 경계");
  });

  test("승인 전에는 어느 단계도 돌지 않는다", () => {
    const lane = applyResponse(context, JSON.stringify(EMPTY_INTAKE)).outDir;
    answerAll(lane);
    applyResponse(context, JSON.stringify(PLAN));

    const next = nextPrompt(context);

    assert.equal(next.label, "approval");
    assert.equal(next.prompt, undefined);
  });
});
