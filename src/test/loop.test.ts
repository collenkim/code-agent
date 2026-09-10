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
import { applyResponse, decideApproval, nextPrompt } from "../core/turn";
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

/** 대상 하나가 도는 자리. 대상마다 갈라지므로 out/ 바로 아래가 아니다. */
function lane(...parts: string[]): string {
  return join(root, "out", "TEST-1", "shipment", ...parts);
}

/** 채팅 응답을 흉내 낸다. 줄 배열로 쓰는 편이 백틱 때문에 읽기 쉽다. */
function reply(...lines: string[]): string {
  return lines.join("\n");
}

/** 사람이 questions.md 를 열어 답을 적는 것과 같은 일 */
function answerAll(answer: string) {
  const path = questionsPath(lane());
  writeFileSync(path, readFileSync(path, "utf-8").replace(/\(여기에 답을 적으세요\)/g, answer), "utf-8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-loop-"));
  write("app/features/orders/models.py", "from dataclasses import dataclass\n\n@dataclass\nclass Order:\n    id: int\n");
  write("doc/conventions.md", "# 컨벤션\n- dataclass 를 쓴다.\n");
  write("doc/templates/code-agent.json", JSON.stringify(MANIFEST, null, 2));
  write("doc/templates/01-model.md", "# [01] 모델\n");
  write("doc/templates/02-check.md", "# [02] 검증\n");
  // 0차 게이트가 생긴 뒤로는 어떤 실행이든 작업 지시서 머리말이 있어야 한다.
  writeFileSync(
    join(root, "spec.md"),
    "---\nkind: feature\nid: TEST-1\ntitle: 배송 도메인 추가\ntarget: shipment\n---\n\n" +
      "# 배송(shipment) 도메인\n",
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

/** 사람이 계획을 승인하는 것과 같은 일 — 2차 게이트 */
function approvePlan() {
  decideApproval(context, "approved", { approver: "tester", target: "shipment" });
}

/** 사람이 단계 산출물을 확정하는 것과 같은 일 — 4차 게이트 */
function confirmStage() {
  decideApproval(context, "approved", { approver: "tester", target: "shipment" });
}

/**
 * 계획까지 끝내고 승인까지 받은 상태로 만든다 — 대부분의 테스트가 그 다음부터를 본다.
 * 2차 게이트 자체를 보는 테스트는 이 함수를 쓰지 않고 계획만 반영한다.
 */
function completePlan(openQuestions: string[] = []) {
  applyResponse(context, JSON.stringify({ ...PLAN_RESPONSE, openQuestions }));
  // 미결 질문이 남으면 승인 게이트가 아직 제시되지 않는다(질문 검사가 승인보다 앞이다).
  // 그 자리에 승인을 미리 박아 두는 것은 통제의 우회라 코드가 거부한다 — 그리고 질문이
  // 막는지 보는 테스트에는 승인이 필요하지 않다.
  if (openQuestions.length === 0) {
    approvePlan();
  }
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
    assert.match(readFileSync(questionsPath(lane()), "utf-8"), /상태값을 무엇으로 두나요\?/);
  });

  test("질문이 여러 건이면 전부 센다", () => {
    // 회귀: 블록 구분선이 앞 질문의 답에 딸려 와, 마지막 질문 말고는 전부 "답이 있는" 것으로
    // 읽혔다. 질문이 하나일 때는 드러나지 않아 오래 남아 있었다.
    completePlan(["상태값을 무엇으로 두나요?", "주소 최대 길이는?"]);

    const next = nextPrompt(context);

    assert.equal(next.label, "blocked");
    assert.match(next.message!, /답하지 않은 질문이 2건/);
  });

  test("일부만 답하면 아직 막혀 있다", () => {
    completePlan(["상태값을 무엇으로 두나요?", "주소 최대 길이는?"]);

    const path = questionsPath(lane());
    // 첫 질문에만 답을 적는다.
    writeFileSync(
      path,
      readFileSync(path, "utf-8").replace("(여기에 답을 적으세요)", "준비·배송중·완료"),
      "utf-8",
    );

    assert.match(nextPrompt(context).message!, /답하지 않은 질문이 1건/);
  });

  test("답을 채우면 다시 나아가고, 그 답이 프롬프트에 실린다", () => {
    completePlan(["상태값을 무엇으로 두나요?"]);
    answerAll("준비·배송중·완료 세 가지");
    // 답이 채워지면 그 다음에 오는 것이 2차 게이트다. 승인은 질문이 풀린 뒤의 일이다.
    assert.equal(nextPrompt(context).label, "approval");
    approvePlan();

    const next = nextPrompt(context);

    assert.equal(next.label, "model");
    assert.match(next.prompt!, /준비·배송중·완료 세 가지/);
    assert.match(next.prompt!, /다시 묻지 않는다/);
  });

  test("생성 중에 나온 ask 도 같은 문서로 모인다", () => {
    completePlan();
    applyResponse(context, reply("### ask", "필드 길이는 얼마인가요?"));

    assert.equal(nextPrompt(context).label, "blocked");
    assert.match(readFileSync(questionsPath(lane()), "utf-8"), /필드 길이는/);
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

describe("계획 준수 — 승인한 것과 만든 것을 대조한다", () => {
  test("계획에 없는 파일은 쓰기 전에 거부된다", () => {
    // 경계(outputDirs)는 "어디에" 를 막는다. 이 파일은 허용된 위치에 있으므로 경계는 통과한다 —
    // 막는 것은 사람이 승인한 계획에 이 파일이 없다는 사실이다.
    completePlan();

    const outcome = applyResponse(
      context,
      reply(
        "### write app/features/shipment/models.py",
        "```",
        "ok",
        "```",
        "### write app/features/shipment/helper.py",
        "```",
        "계획에 없다",
        "```",
        "### done",
      ),
    );

    assert.equal(outcome.violations.length, 1);
    assert.match(outcome.violations[0].item, /계획 준수/);
    assert.match(outcome.violations[0].file, /helper\.py/);
    assert.equal(
      existsSync(lane("app/features/shipment/helper.py")),
      false,
      "쓰기 전에 거부되어야 한다 — 쓴 뒤에 알리면 모델이 되돌릴 수단이 없다",
    );
    assert.equal(outcome.advanced, false);
  });

  test("계획에 있는 파일이 빠지면 done 이 통하지 않는다", () => {
    completePlan();

    const outcome = applyResponse(context, reply("### note 만들 것이 없다고 판단", "### done"));

    assert.equal(outcome.advanced, false, "승인된 계획을 다 만들지 않고 끝낼 수는 없다");
    assert.equal(outcome.violations.length, 1);
    assert.match(outcome.violations[0].item, /계획 준수/);
    assert.match(outcome.violations[0].detail, /만들어지지 않았습니다/);
  });

  test("누락은 그 파일을 쓰면 풀린다 — 갇히지 않는다", () => {
    completePlan();
    applyResponse(context, reply("### done"));

    const outcome = applyResponse(
      context,
      reply("### write app/features/shipment/models.py", "```", "ok", "```", "### done"),
    );

    assert.equal(outcome.violations.length, 0);
    assert.equal(outcome.advanced, true);
  });

  test("중간 턴에는 누락을 묻지 않는다 — 한 단계가 여러 턴에 걸쳐 돈다", () => {
    // done 없이 read 만 한 턴. 여기서 "계획에 있는데 없다"고 하면 매 턴 거짓 위반이 뜬다.
    completePlan();

    const outcome = applyResponse(context, reply("### read app/features/orders/models.py"));

    assert.equal(outcome.violations.length, 0);
    assert.equal(outcome.advanced, false, "관찰 요청이 남아 아직 끝난 것은 아니다");
  });

  test("경계에 걸린 파일을 계획 준수로 또 세지 않는다", () => {
    // 도메인 밖 파일은 당연히 계획 밖이기도 하다. 둘 다 보고하면 같은 잘못이 두 줄로 보인다.
    completePlan();

    const outcome = applyResponse(
      context,
      reply("### write app/features/other/x.py", "```", "bad", "```", "### done"),
    );

    assert.equal(outcome.violations.length, 1);
    assert.match(outcome.violations[0].item, /do-not-touch/);
  });
});

describe("형식이 깨진 응답은 어느 단계든 턴으로 센다", () => {
  test("계획 단계의 형식 오류가 세션 기록에 남는다", () => {
    // 액션 단계는 원래 그랬는데 JSON 단계(plan·gate·intake)는 throw 로 빠져 턴이 안 세어졌다.
    // 그러면 `log` 의 형식오류 수치가 절반의 단계에서 빠진다 — 서버를 붙일지 판단하는 그 수치다.
    const outcome = applyResponse(context, "계획은 대충 이렇습니다: 모델 하나 만들면 됩니다.");

    assert.equal(outcome.advanced, false);
    assert.equal(outcome.parseErrors.length, 1);
    const session = loadSession(lane());
    assert.equal(session.turn, 1, "왕복 한 번은 한 번으로 센다");
    assert.equal(session.log[0].parseErrors, 1);
    assert.equal(nextPrompt(context).label, "plan", "다시 계획 프롬프트를 낸다");
  });

  test("검수 단계의 형식 오류도 같다", () => {
    completePlan();
    applyResponse(
      context,
      reply("### write app/features/shipment/models.py", "```", "ok", "```", "### done"),
    );
    assert.equal(nextPrompt(context).label, "gate:model");

    const outcome = applyResponse(context, "위반은 없어 보입니다.");

    assert.equal(outcome.parseErrors.length, 1);
    assert.equal(nextPrompt(context).label, "gate:model", "검수를 다시 받는다");
  });
});

describe("confirm: false 인 단계는 사람 확정 없이 넘어간다", () => {
  test("선언한 단계는 검수 뒤 곧바로 다음 단계다", () => {
    write(
      "doc/templates/code-agent.json",
      JSON.stringify(
        {
          ...MANIFEST,
          stages: MANIFEST.stages.map((stage) =>
            stage.key === "model" ? { ...stage, confirm: false } : stage,
          ),
        },
        null,
        2,
      ),
    );
    completePlan();
    applyResponse(
      context,
      reply("### write app/features/shipment/models.py", "```", "ok", "```", "### done"),
    );
    applyResponse(context, JSON.stringify({ violations: [] }));

    assert.equal(nextPrompt(context).label, "check", "confirm 을 기다리지 않고 다음 단계로 간다");
  });

  test("선언하지 않으면 기본은 확정을 기다린다", () => {
    completePlan();
    applyResponse(
      context,
      reply("### write app/features/shipment/models.py", "```", "ok", "```", "### done"),
    );
    applyResponse(context, JSON.stringify({ violations: [] }));

    assert.equal(nextPrompt(context).label, "confirm:model");
  });
});

describe("commands — build·test 외의 검증 명령", () => {
  test("선언하지 않은 이름은 돌리지 않고, 무엇을 선언했는지 말해 준다", () => {
    write(
      "doc/templates/code-agent.json",
      JSON.stringify({ ...MANIFEST, commands: { lint: ["node", "-e", "process.exit(0)"] } }, null, 2),
    );
    completePlan();
    applyResponse(
      context,
      reply("### write app/features/shipment/models.py", "```", "ok", "```", "### done"),
    );
    applyResponse(context, JSON.stringify({ violations: [] }));
    confirmStage();
    assert.equal(nextPrompt(context).label, "check");

    const outcome = applyResponse(context, reply("### run migrate"));

    const [observation] = outcome.execution!.observations;
    assert.match(observation.body, /실행할 수 없습니다/);
    assert.match(observation.body, /lint/, "선언된 이름을 알려 준다");
  });

  test("선언한 이름은 run 의 문을 지난다", () => {
    write(
      "doc/templates/code-agent.json",
      JSON.stringify({ ...MANIFEST, commands: { lint: ["node", "-e", "process.exit(0)"] } }, null, 2),
    );
    completePlan();
    applyResponse(
      context,
      reply("### write app/features/shipment/models.py", "```", "ok", "```", "### done"),
    );
    applyResponse(context, JSON.stringify({ violations: [] }));
    confirmStage();

    const outcome = applyResponse(context, reply("### run lint"));

    const [observation] = outcome.execution!.observations;
    assert.doesNotMatch(observation.body, /실행할 수 없습니다/);
    assert.match(observation.label, /^run lint/);
  });
});

describe("참조 표준이 빠진 것을 조용히 넘기지 않는다", () => {
  test("선언한 참조 표준을 하나도 못 찾으면 프롬프트를 만들지 않는다", () => {
    completePlan();
    // 참조 도메인의 파일을 치운다 — {Ref} 치환이 실제 클래스명과 어긋날 때와 같은 상황이다.
    rmSync(join(root, "repo", "app", "features", "orders", "models.py"));

    // 이대로 프롬프트를 내면 참조 표준 없이 지어낸 코드가 나온다.
    assert.throws(() => nextPrompt(context), /참조 표준을 하나도 찾지 못해/);
  });

  test("일부만 못 찾으면 경고로 알리고 진행한다", () => {
    completePlan();
    write(
      "doc/templates/code-agent.json",
      JSON.stringify(
        {
          ...MANIFEST,
          stages: MANIFEST.stages.map((stage) =>
            stage.key === "model" ? { ...stage, exemplars: ["models.py", "gone.py"] } : stage,
          ),
        },
        null,
        2,
      ),
    );

    const next = nextPrompt(context);

    assert.ok(next.prompt, "남은 참조 표준으로 진행한다");
    assert.equal(next.warnings?.length, 1);
    assert.match(next.warnings![0], /gone\.py/);
    assert.match(next.warnings![0], /나머지 1건으로 진행/);
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
      existsSync(lane("app/features/shipment/models.py")),
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
      readFileSync(lane("app/features/shipment/models.py"), "utf-8"),
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

  test("위반이 없어도 사람이 확정해야 다음 단계로 넘어간다", () => {
    reachGate();

    const outcome = applyResponse(context, JSON.stringify({ violations: [] }));

    assert.equal(outcome.advanced, true);
    assert.equal(nextPrompt(context).label, "confirm:model", "검수는 모델이 했을 뿐이다");

    confirmStage();

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
    confirmStage();
    assert.equal(nextPrompt(context).label, "check");
  }

  test("verify 단계에서는 명령을 돌릴 수 있고 결과가 다음 프롬프트에 실린다", () => {
    reachVerify();

    const outcome = applyResponse(context, reply("### run test"));

    assert.deepEqual(outcome.violations, []);
    assert.equal(outcome.execution!.observations.length, 1);
    assert.match(nextPrompt(context).prompt!, /run test/);
  });

  test("돌리지 않은 검증을 '통과'라고 말하지 않는다", () => {
    // 이 fixture 에는 test 명령이 선언돼 있지 않아 실행 자체가 일어나지 않는다.
    // 그것을 통과로 알리면 검증하지 않은 코드를 검증된 것으로 착각하고 단계를 끝낸다.
    reachVerify();

    const label = applyResponse(context, reply("### run test")).execution!.observations[0].label;

    assert.match(label, /실행되지 않음/);
    assert.doesNotMatch(label, /통과/);
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
      existsSync(lane("tests/test_shipment.py")),
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
      readFileSync(lane("app/features/shipment/models.py"), "utf-8"),
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

    const session = loadSession(lane());
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
    assert.match(summarizeSession(loadSession(lane())), /형식오류/);
  });
});
