/**
 * 대상이 여럿일 때 — 대상마다 따로 돈다.
 *
 * 여기서 판정되는 것은 "지시서 하나가 대상 여럿을 다룰 때 각 대상이 독립된 왕복을 도는가"다.
 * 계획·질문·승인이 대상 단위로 갈리지 않으면, 대상 A 의 승인이 B 의 코드를 통과시키는
 * 구멍이 그대로 생긴다.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { readLedger } from "../core/approval";
import { questionsPath } from "../core/session";
import { readRunState } from "../core/targets";
import { applyResponse, decideApproval, nextPrompt, rememberIssued } from "../core/turn";
import type { BuildContext } from "../core/types";

const MANIFEST = {
  language: "python",
  sourceExtensions: [".py"],
  domainBase: "app/features",
  domainRoots: [],
  conventions: ["doc/conventions.md"],
  referenceDomain: "orders",
  stages: [
    {
      key: "model",
      title: "모델",
      template: "01-model.md",
      exemplars: ["models.py"],
      outputDirs: ["."],
    },
  ],
};

function planFor(domain: string, openQuestions: string[] = []) {
  return JSON.stringify({
    domainName: domain,
    domainLabel: domain,
    domainRoot: "",
    domainDirName: domain,
    files: [{ stage: "model", path: `app/features/${domain}/models.py`, purpose: "모델" }],
    conventions: [{ rule: "dataclass 사용", source: "doc/conventions.md" }],
    conflicts: [],
    openQuestions,
    reasoning: "참조 도메인 구조를 따랐다",
  });
}

let root: string;
let context: BuildContext;

function write(relative: string, content: string) {
  const path = join(root, "repo", relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

/** 대상 하나의 갈래 */
function lane(target: string, ...parts: string[]): string {
  return join(root, "out", "TEST-1", target, ...parts);
}

/** 사람이 questions.md 를 열어 답을 적는 것과 같은 일 */
function answerAll(target: string, answer: string) {
  const path = questionsPath(lane(target));
  writeFileSync(path, readFileSync(path, "utf-8").replace(/\(여기에 답을 적으세요\)/g, answer), "utf-8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-targets-"));
  write("app/features/orders/models.py", "from dataclasses import dataclass\n");
  write("doc/conventions.md", "# 컨벤션\n- dataclass 를 쓴다.\n");
  write("doc/templates/code-agent.json", JSON.stringify(MANIFEST, null, 2));
  write("doc/templates/01-model.md", "# [01] 모델\n");
  writeFileSync(
    join(root, "spec.md"),
    "---\nkind: feature\nid: TEST-1\ntitle: 배송과 정산\ntarget: [shipment, settlement]\n---\n\n" +
      "# 배송(shipment) 과 정산(settlement)\n",
    "utf-8",
  );

  context = {
    specPaths: [join(root, "spec.md")],
    templatesDir: "doc/templates",
    repoRoot: join(root, "repo"),
    outDir: join(root, "out"),
    maxRetries: 1,
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("대상마다 갈래가 갈린다", () => {
  test("첫 프롬프트는 첫 대상의 것이고, 그 대상만 실린다", () => {
    const next = nextPrompt(context);

    assert.equal(next.lane, "shipment");
    assert.equal(next.label, "shipment:plan", "대상이 여럿이면 label 에 대상이 붙는다");
    assert.match(next.prompt!, /- 대상: shipment/);
    assert.match(next.prompt!, /다른 대상도 있다\(settlement\)/, "남의 대상에 손대지 않게 알린다");
    assert.doesNotMatch(next.prompt!, /- 대상: shipment, settlement/);
  });

  test("계획은 대상마다 따로 선다", () => {
    applyResponse(context, planFor("shipment"));

    // shipment 는 승인 대기라 진행할 수 없다. 대상 간 의존은 없으므로 다음 대상으로 간다.
    const next = nextPrompt(context);
    assert.equal(next.lane, "settlement");
    assert.equal(next.label, "settlement:plan");

    applyResponse(context, planFor("settlement"));

    assert.ok(existsSync(lane("shipment", ".plan.json")));
    assert.ok(existsSync(lane("settlement", ".plan.json")));
  });

  test("생성물도 대상별 갈래에 쌓인다", () => {
    applyResponse(context, planFor("shipment"));
    decideApproval(context, "approved", { approver: "팀장", target: "shipment" });
    applyResponse(
      context,
      "### write app/features/shipment/models.py\n```py\nx = 1\n```\n\n### done",
    );

    assert.ok(existsSync(lane("shipment", "app/features/shipment/models.py")));
    assert.ok(!existsSync(join(root, "out", "app/features/shipment/models.py")));
  });
});

describe("한 대상이 막혀도 나머지는 돈다", () => {
  test("미결 질문은 그 대상만 막는다", () => {
    applyResponse(context, planFor("shipment", ["상태값을 무엇으로 두나요?"]));

    const next = nextPrompt(context);
    assert.equal(next.lane, "settlement", "질문이 남은 대상은 건너뛴다");
    assert.match(next.message ?? next.prompt!, /settlement/);

    // 질문 문서도 대상마다 따로 있다.
    assert.ok(existsSync(questionsPath(lane("shipment"))));
    assert.ok(!existsSync(questionsPath(lane("settlement"))));
  });

  test("막힌 대상이 무엇 때문에 막혔는지 함께 알린다", () => {
    applyResponse(context, planFor("shipment", ["상태값을 무엇으로 두나요?"]));
    applyResponse(context, planFor("settlement"));

    // 둘 다 막혔다 — 하나는 질문, 하나는 승인 대기.
    const next = nextPrompt(context);
    assert.equal(next.prompt, undefined);
    assert.match(next.message!, /shipment: 미결 질문/);
    assert.match(next.message!, /settlement: 승인 대기/);
  });

  test("답을 채우면 그 대상이 다시 돈다", () => {
    applyResponse(context, planFor("shipment", ["상태값을 무엇으로 두나요?"]));
    answerAll("shipment", "준비·배송중·완료");
    decideApproval(context, "approved", { approver: "팀장", target: "shipment" });

    assert.equal(nextPrompt(context).lane, "shipment");
  });
});

describe("승인도 대상마다다", () => {
  test("한 대상을 승인해도 다른 대상은 그대로 대기한다", () => {
    applyResponse(context, planFor("shipment"));
    applyResponse(context, planFor("settlement"));

    decideApproval(context, "approved", { approver: "팀장", target: "shipment" });

    const rows = readLedger(join(root, "repo"), "TEST-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target, "shipment", "같은 id 아래 대상마다 줄이 쌓인다");

    assert.equal(nextPrompt(context).lane, "shipment", "승인된 대상이 먼저 돈다");

    decideApproval(context, "approved", { approver: "팀장", target: "settlement" });
    assert.equal(readLedger(join(root, "repo"), "TEST-1").length, 2);
  });

  test("승인 대기가 둘이면 고르지 않고 묻는다", () => {
    applyResponse(context, planFor("shipment"));
    applyResponse(context, planFor("settlement"));

    assert.throws(
      () => decideApproval(context, "approved", { approver: "팀장" }),
      /--target/,
      "사람이 읽은 계획과 판정한 계획이 달라질 수 있다",
    );
  });

  test("승인 대기가 하나뿐이면 그것으로 본다", () => {
    applyResponse(context, planFor("shipment"));

    const { record } = decideApproval(context, "approved", { approver: "팀장" });
    assert.equal(record.target, "shipment");
  });

  test("지시서에 없는 대상은 거부한다", () => {
    applyResponse(context, planFor("shipment"));

    assert.throws(
      () => decideApproval(context, "approved", { approver: "팀장", target: "billing" }),
      /없는 대상/,
    );
  });
});

describe("응답은 프롬프트를 내준 대상에 반영된다", () => {
  /** shipment 를 먼저 돌 차례로 만든다 — 질문에 답하고 계획까지 승인하면 model 단계다 */
  function makeShipmentNext() {
    answerAll("shipment", "준비·배송중·완료");
    decideApproval(context, "approved", { approver: "팀장", target: "shipment" });
  }

  test("그 사이 다른 대상이 먼저 돌 차례가 되어도 레인이 바뀌지 않는다", () => {
    applyResponse(context, planFor("shipment", ["상태값을 무엇으로 두나요?"]));

    // shipment 가 막혀 settlement 의 프롬프트를 받았다.
    const issued = nextPrompt(context);
    assert.equal(issued.lane, "settlement");
    // 프롬프트를 사람에게 내주는 자리가 하는 일. CLI 의 next 와 서버의 GET /prompt 가 이것을 부른다.
    rememberIssued(context, issued);

    // 붙여넣기 전에 사람이 shipment 를 풀어 버렸다 — 차례가 shipment 로 넘어간다.
    makeShipmentNext();
    assert.equal(nextPrompt(context).lane, "shipment", "차례 자체는 shipment 로 넘어갔다");

    const outcome = applyResponse(context, planFor("settlement"));

    assert.equal(outcome.lane, "settlement", "받은 프롬프트의 대상에 반영해야 한다");
    assert.ok(existsSync(lane("settlement", ".plan.json")));
    assert.equal(
      readFileSync(lane("shipment", ".plan.json"), "utf-8").includes("settlement"),
      false,
      "다른 대상의 계획이 덮이면 안 된다",
    );
  });

  test("상태 조회는 프롬프트를 내준 기록을 덮지 않는다", () => {
    // 회귀: dispatch 를 nextPrompt 안에서 적던 때, status·log·질문 답변·목록 조회가 모두
    // 그 함수를 불러 기록을 덮었다. 그러면 붙여넣은 응답이 엉뚱한 레인에 반영된다 —
    // dispatch 가 막으려던 바로 그 사고다.
    applyResponse(context, planFor("shipment", ["상태값을 무엇으로 두나요?"]));

    const issued = nextPrompt(context);
    rememberIssued(context, issued);
    assert.equal(readRunState(join(root, "out")).dispatch?.target, "settlement");

    makeShipmentNext();
    // 조회다. 상태를 움직이지 않으므로 기록도 건드리지 않아야 한다.
    nextPrompt(context);

    assert.equal(
      readRunState(join(root, "out")).dispatch?.target,
      "settlement",
      "조회가 프롬프트를 내준 대상 기록을 덮으면 안 된다",
    );
  });
});
