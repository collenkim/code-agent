/**
 * 턴 루프 통합 테스트 — next → 붙여넣기 → apply 가 실제로 이어지는지.
 *
 * 여기서 확인하려는 것은 개별 함수가 아니라 **상태가 앞으로 나아가는지**다. 사람이 할 일이
 * 두 명령으로 줄었다는 주장이 사실인지, 질문이 막다른 길이 아니라 루프인지가 여기서 판정된다.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { loadSession, questionsPath, summarizeSession } from "../core/session";
import { applyResponse, nextPrompt } from "../core/turn";
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
    {
      key: "check",
      title: "검증",
      template: "02-check.md",
      kind: "verify",
      // 저장소 루트 기준으로 본문 소스만 열어 둔다. tests/ 가 빠져 있는 것이 핵심이다 —
      // 실패한 테스트를 지워서 통과시키는 것이 구조적으로 불가능해진다.
      scope: "project",
      exemplars: [],
      outputDirs: ["app/features"],
    },
  ],
};

const PLAN_RESPONSE = {
  domainName: "shipment",
  domainLabel: "배송",
  domainRoot: "",
  domainDirName: "shipment",
  files: [{ stage: "model", path: "app/features/shipment/models.py", purpose: "배송 모델" }],
  conventions: [{ rule: "dataclass 사용", source: "doc/conventions.md" }],
  conflicts: [],
  openQuestions: [] as string[],
  reasoning: "참조 도메인 구조를 따랐다",
};

let root: string;
let context: BuildContext;

function write(relative: string, content: string) {
  const path = join(root, "repo", relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

/** 채팅 응답을 흉내 낸다. 줄 배열로 쓰는 편이 백틱 때문에 읽기 쉽다. */
function reply(...lines: string[]): string {
  return lines.join("\n");
}

/** 사람이 questions.md 를 열어 답을 적는 것과 같은 일 */
function answerAll(answer: string) {
  const path = questionsPath(context.outDir);
  writeFileSync(path, readFileSync(path, "utf-8").replace(/\(여기에 답을 적으세요\)/g, answer), "utf-8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-loop-"));
  write("app/features/orders/models.py", "from dataclasses import dataclass\n\n@dataclass\nclass Order:\n    id: int\n");
  write("doc/conventions.md", "# 컨벤션\n- dataclass 를 쓴다.\n");
  write("doc/templates/code-agent.json", JSON.stringify(MANIFEST, null, 2));
  write("doc/templates/01-model.md", "# [01] 모델\n");
  write("doc/templates/02-check.md", "# [02] 검증\n");
  writeFileSync(join(root, "spec.md"), "# 배송(shipment) 도메인\n", "utf-8");

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

/** 계획까지 끝낸 상태로 만든다 — 대부분의 테스트가 그 다음부터를 본다. */
function completePlan(openQuestions: string[] = []) {
  applyResponse(context, JSON.stringify({ ...PLAN_RESPONSE, openQuestions }));
}

describe("상태가 다음 할 일을 정한다", () => {
  test("계획이 없으면 계획부터", () => {
    const next = nextPrompt(context);

    assert.equal(next.label, "plan");
    assert.match(next.prompt!, /배송\(shipment\) 도메인/, "스펙이 실려야 한다");
  });

  test("계획이 끝나면 첫 단계로 넘어간다", () => {
    completePlan();

    assert.equal(nextPrompt(context).label, "model");
  });

  test("--spec 은 계획 때 한 번이면 된다 — 이후엔 세션이 기억한다", () => {
    completePlan();

    const withoutSpec: BuildContext = { ...context, specPaths: [] };
    const prompt = nextPrompt(withoutSpec).prompt!;

    assert.match(prompt, /배송\(shipment\) 도메인/, "세션에 남은 스펙이 다시 실려야 한다");
  });

  test("next 는 상태를 바꾸지 않아 몇 번 불러도 같다", () => {
    completePlan();

    assert.equal(nextPrompt(context).prompt, nextPrompt(context).prompt);
  });
});

describe("질문은 막다른 길이 아니라 루프다", () => {
  test("미결 질문이 생기면 문서로 남기고 멈춘다", () => {
    completePlan(["상태값을 무엇으로 두나요?"]);

    const next = nextPrompt(context);

    assert.equal(next.label, "blocked");
    assert.match(next.message!, /답하지 않은 질문이 1건/);
    assert.match(readFileSync(questionsPath(context.outDir), "utf-8"), /상태값을 무엇으로 두나요\?/);
  });

  test("답을 채우면 다시 나아가고, 그 답이 프롬프트에 실린다", () => {
    completePlan(["상태값을 무엇으로 두나요?"]);
    answerAll("준비·배송중·완료 세 가지");

    const next = nextPrompt(context);

    assert.equal(next.label, "model");
    assert.match(next.prompt!, /준비·배송중·완료 세 가지/);
    assert.match(next.prompt!, /다시 묻지 않는다/);
  });

  test("생성 중에 나온 ask 도 같은 문서로 모인다", () => {
    completePlan();
    applyResponse(context, reply("### ask", "필드 길이는 얼마인가요?"));

    assert.equal(nextPrompt(context).label, "blocked");
    assert.match(readFileSync(questionsPath(context.outDir), "utf-8"), /필드 길이는/);
  });
});

describe("액션 실행", () => {
  test("write + done 이면 단계가 끝나고 검수로 넘어간다", () => {
    completePlan();

    const outcome = applyResponse(
      context,
      reply("### write app/features/shipment/models.py", "```python", "class Shipment:", "    id: int", "```", "### done"),
    );

    assert.equal(outcome.advanced, true);
    assert.equal(outcome.execution!.writtenFiles.length, 1);
    assert.equal(nextPrompt(context).label, "gate:model");
  });

  test("done 이 없으면 그 단계를 이어서 돈다", () => {
    completePlan();

    const outcome = applyResponse(
      context,
      reply("### write app/features/shipment/models.py", "```", "class Shipment:", "```"),
    );

    assert.equal(outcome.advanced, false);
    assert.equal(nextPrompt(context).label, "model");
  });

  test("read 결과가 다음 프롬프트에 실린다 — 이게 툴 호출 한 턴이다", () => {
    completePlan();

    const outcome = applyResponse(context, reply("### read app/features/orders/models.py"));

    assert.equal(outcome.execution!.observations.length, 1);
    assert.equal(outcome.advanced, false, "읽기만 했으면 아직 끝난 게 아니다");

    const prompt = nextPrompt(context).prompt!;
    assert.match(prompt, /앞 턴에서 요청한 것의 결과/);
    assert.match(prompt, /class Order/, "읽은 내용이 실려야 한다");
  });

  test("없는 파일을 읽으면 없다고 알려준다 — 조용히 지어내게 두지 않는다", () => {
    completePlan();

    const outcome = applyResponse(context, reply("### read app/features/nope/x.py"));

    assert.match(outcome.execution!.observations[0].body, /없는 파일/);
  });
});

describe("경계는 코드가 지킨다", () => {
  test("도메인 밖 write 는 하나도 반영하지 않는다", () => {
    completePlan();

    const outcome = applyResponse(
      context,
      reply(
        "### write app/features/shipment/models.py",
        "```",
        "ok",
        "```",
        "### write app/features/other/x.py",
        "```",
        "bad",
        "```",
        "### done",
      ),
    );

    assert.equal(outcome.violations.length, 1);
    assert.match(outcome.violations[0].item, /do-not-touch/);
    assert.equal(
      existsSync(join(context.outDir, "app/features/shipment/models.py")),
      false,
      "같은 응답의 정상 파일까지 반영하지 않아야 한다 — 절반만 반영된 상태가 가장 다루기 어렵다",
    );
  });

  test("명령 실행은 verify 단계에서만 된다", () => {
    completePlan();

    const outcome = applyResponse(context, reply("### run test"));

    assert.equal(outcome.violations.length, 1);
    assert.match(outcome.violations[0].detail, /verify인 단계에서만/);
  });

  test("edit 은 저장소 원본을 건드리지 않고 out/ 에만 쓴다", () => {
    completePlan();
    // done 을 넣지 않아 같은 단계에 머문다 — 고쳐 쓰는 것도 한 단계 안의 일이다.
    applyResponse(
      context,
      reply("### write app/features/shipment/models.py", "```", "class Shipment:", "    id: int", "```"),
    );

    const outcome = applyResponse(
      context,
      reply(
        "### edit app/features/shipment/models.py",
        "#### find",
        "```",
        "    id: int",
        "```",
        "#### replace",
        "```",
        "    id: int",
        "    address: str",
        "```",
      ),
    );

    assert.deepEqual(outcome.violations, []);
    assert.match(
      readFileSync(join(context.outDir, "app/features/shipment/models.py"), "utf-8"),
      /address: str/,
    );
    assert.match(
      readFileSync(join(context.repoRoot, "app/features/orders/models.py"), "utf-8"),
      /class Order/,
      "저장소는 그대로여야 한다",
    );
  });

  test("edit 의 find 가 여러 곳에 걸리면 거부한다", () => {
    completePlan();
    applyResponse(
      context,
      reply("### write app/features/shipment/models.py", "```", "pass", "pass", "```"),
    );

    const outcome = applyResponse(
      context,
      reply(
        "### edit app/features/shipment/models.py",
        "#### find",
        "```",
        "pass",
        "```",
        "#### replace",
        "```",
        "return",
        "```",
      ),
    );

    assert.match(outcome.violations[0].detail, /2곳에 걸립니다/);
  });
});

describe("검수 결과가 생성으로 되돌아온다", () => {
  function reachGate() {
    completePlan();
    applyResponse(
      context,
      reply("### write app/features/shipment/models.py", "```", "class Shipment:", "```", "### done"),
    );
  }

  test("위반이 있으면 그 단계로 돌아가고 위반이 프롬프트에 실린다", () => {
    reachGate();

    const outcome = applyResponse(
      context,
      JSON.stringify({
        violations: [
          { item: "dataclass 규칙", file: "app/features/shipment/models.py", detail: "@dataclass 가 없습니다" },
        ],
      }),
    );

    assert.equal(outcome.advanced, false);
    const next = nextPrompt(context);
    assert.equal(next.label, "model", "다시 그 단계로 돌아가야 한다");
    assert.match(next.prompt!, /@dataclass 가 없습니다/);
    assert.match(next.prompt!, /이번에는 반드시 고친다/);
  });

  test("위반이 없으면 다음 단계로 넘어간다", () => {
    reachGate();

    const outcome = applyResponse(context, JSON.stringify({ violations: [] }));

    assert.equal(outcome.advanced, true);
    assert.equal(nextPrompt(context).label, "check");
  });

  test("두 번 시도해도 남으면 덮지 않고 사람에게 넘긴다", () => {
    reachGate();
    const violation = {
      violations: [{ item: "규칙", file: "app/features/shipment/models.py", detail: "여전히 어긋남" }],
    };

    applyResponse(context, JSON.stringify(violation));
    applyResponse(
      context,
      reply("### write app/features/shipment/models.py", "```", "class Shipment:", "```", "### done"),
    );
    const second = applyResponse(context, JSON.stringify(violation));

    assert.equal(second.advanced, true);
    assert.match(second.message!, /자동으로 덮지 않고/);
  });
});

describe("verify 단계 — 실패를 덮을 수 없게 한다", () => {
  /** 검수까지 통과시켜 verify 단계에 세운다. */
  function reachVerify() {
    completePlan();
    applyResponse(
      context,
      reply("### write app/features/shipment/models.py", "```", "class Shipment:", "```", "### done"),
    );
    applyResponse(context, JSON.stringify({ violations: [] }));
    assert.equal(nextPrompt(context).label, "check");
  }

  test("verify 단계에서는 명령을 돌릴 수 있고 결과가 다음 프롬프트에 실린다", () => {
    reachVerify();

    const outcome = applyResponse(context, reply("### run test"));

    assert.deepEqual(outcome.violations, []);
    assert.equal(outcome.execution!.observations.length, 1);
    assert.match(nextPrompt(context).prompt!, /run test/);
  });

  test("테스트 파일은 고칠 수 없다 — 단언을 지워 통과시키는 길을 막는다", () => {
    reachVerify();

    const outcome = applyResponse(
      context,
      reply(
        "### edit tests/test_shipment.py",
        "#### find",
        "```",
        "assert shipment.id == 1",
        "```",
        "#### replace",
        "```",
        "pass",
        "```",
      ),
    );

    assert.equal(outcome.violations.length, 1);
    assert.match(outcome.violations[0].item, /do-not-touch/);
    assert.equal(
      existsSync(join(context.outDir, "tests/test_shipment.py")),
      false,
      "테스트 파일이 만들어지면 안 된다",
    );
  });

  test("본문 소스는 고칠 수 있다", () => {
    reachVerify();

    const outcome = applyResponse(
      context,
      reply(
        "### edit app/features/shipment/models.py",
        "#### find",
        "```",
        "class Shipment:",
        "```",
        "#### replace",
        "```",
        "class Shipment:",
        "    id: int",
        "```",
      ),
    );

    assert.deepEqual(outcome.violations, []);
    assert.match(
      readFileSync(join(context.outDir, "app/features/shipment/models.py"), "utf-8"),
      /id: int/,
    );
  });
});

describe("턴 기록", () => {
  test("효율을 판단할 수치가 남는다", () => {
    completePlan();
    applyResponse(context, reply("### read app/features/orders/models.py"));
    applyResponse(
      context,
      reply("### write app/features/shipment/models.py", "```", "class Shipment:", "```", "### done"),
    );

    const session = loadSession(context.outDir);
    const summary = summarizeSession(session);

    assert.equal(session.log.length, 3, "계획 1턴 + 생성 2턴");
    assert.match(summary, /탐색\(read·list\) 요청: 1건/);
    assert.match(summary, /대상당 평균 턴/);
  });

  test("형식이 깨진 응답은 반영하지 않고 기록만 남긴다", () => {
    completePlan();

    const outcome = applyResponse(context, "네, 만들어 드릴게요!");

    assert.equal(outcome.parseErrors.length, 1);
    assert.equal(outcome.execution, undefined);
    assert.match(summarizeSession(loadSession(context.outDir)), /형식오류/);
  });
});
