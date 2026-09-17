/**
 * kind: refactor — 고치는 작업.
 *
 * 여기서 판정되는 것은 둘이다. **계획이 보존 조건을 들고 있는가**와
 * **보존하라고 한 것을 바꾸려는 시도가 실제로 거부되는가.**
 *
 * 뒤쪽이 없으면 지시서의 preserve 는 모델에게 하는 부탁일 뿐이고, 앞쪽이 없으면
 * 보존 조건이 빠진 계획이 그대로 승인 화면에 올라간다 — 이 종류에서 가장 위험한 두 실패다.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { stagesFor } from "../core/manifest";
import { missingPreserve, planFormatFor } from "../core/plan";
import { applyResponse, decideApproval, nextPrompt } from "../core/turn";
import type { BuildContext, BuildPlan } from "../core/types";
import { validateWorkOrder } from "../core/workOrder";

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
      kinds: ["feature"],
      exemplars: ["models.py"],
      outputDirs: ["."],
    },
    {
      // 고치는 작업은 Entity~Controller 를 순차 생성하지 않는다. 경계는 지시서가 정한다.
      key: "restructure",
      title: "구조 정리",
      template: "90-restructure.md",
      kinds: ["refactor"],
      scope: "project",
      exemplars: [],
      outputDirs: [],
    },
  ],
};

/** 지시서가 만드는 경계: settlement 안에서만 고치고, facade 는 손대지 않는다 */
const ORDER =
  "---\n" +
  "kind: refactor\n" +
  "id: PROJ-7\n" +
  "title: 정산 트랜잭션 경계 정리\n" +
  "target: app/features/settlement\n" +
  "scope: [app/features/settlement]\n" +
  "preserve: [app/features/settlement/facade.py, SettlementFacade 공개 시그니처]\n" +
  "---\n";

const PLAN = {
  files: [
    { stage: "restructure", path: "app/features/settlement/service.py", purpose: "트랜잭션 경계를 옮긴다" },
  ],
  preserve: [
    { item: "app/features/settlement/facade.py", how: "이 파일은 열지 않는다" },
    { item: "SettlementFacade 공개 시그니처", how: "메서드 이름과 인자를 그대로 둔다" },
  ],
  conventions: [{ rule: "트랜잭션은 서비스에서 연다", source: "doc/conventions.md" }],
  conflicts: [],
  openQuestions: [] as string[],
  reasoning: "경계만 옮기고 동작은 그대로 둔다",
};

let root: string;
let context: BuildContext;

function write(relative: string, content: string) {
  const path = join(root, "repo", relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function lane(...parts: string[]): string {
  return join(root, "out", "PROJ-7", "app-features-settlement", ...parts);
}

async function plan(changes: Partial<typeof PLAN> = {}) {
  await applyResponse(context, JSON.stringify({ ...PLAN, ...changes }));
}

function approve() {
  decideApproval(context, "approved", { approver: "팀장", target: "app/features/settlement" });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-refactor-"));
  write("app/features/orders/models.py", "from dataclasses import dataclass\n");
  write("app/features/settlement/service.py", "class SettlementService:\n    def run(self):\n        pass\n");
  write("app/features/settlement/facade.py", "class SettlementFacade:\n    def settle(self):\n        pass\n");
  write("app/common/tx.py", "def begin():\n    pass\n");
  write("doc/conventions.md", "# 컨벤션\n- 트랜잭션은 서비스에서 연다.\n");
  write("doc/templates/code-agent.json", JSON.stringify(MANIFEST, null, 2));
  write("doc/templates/01-model.md", "# [01] 모델\n");
  write("doc/templates/90-restructure.md", "# [90] 구조 정리\n");
  writeFileSync(join(root, "spec.md"), `${ORDER}\n# 정산 트랜잭션 경계\n`, "utf-8");

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

describe("종류마다 도는 단계가 다르다", () => {
  test("refactor 는 생성 단계를 돌지 않는다", async () => {
    const stages = stagesFor({ ...MANIFEST, stages: MANIFEST.stages } as never, "refactor");

    assert.deepEqual(
      stages.map((stage) => stage.key),
      ["restructure"],
      "Entity~Controller 를 순차 생성하지 않는다",
    );
  });

  test("돌 단계가 하나도 없으면 조용히 끝내지 않는다", async () => {
    assert.throws(
      () => stagesFor({ ...MANIFEST, stages: [MANIFEST.stages[0]] } as never, "refactor"),
      /선언돼 있지 않습니다/,
      "아무것도 안 한 실행을 '다 됐다'로 읽으면 안 된다",
    );
  });
});

describe("계획이 갈린다 — 고칠 파일과 보존 조건", () => {
  test("계획 프롬프트가 참조 도메인이 아니라 대상의 현재 파일을 싣는다", async () => {
    const prompt = nextPrompt(context).prompt!;

    assert.match(prompt, /리팩토링 계획자/);
    assert.match(prompt, /# 대상의 현재 파일/);
    assert.match(prompt, /app\/features\/settlement\/service\.py/);
    assert.doesNotMatch(prompt, /참조 표준 도메인의 파일 구조/, "복제할 도메인이 없는 작업이다");
    assert.match(prompt, /"preserve"/, "보존 조건이 응답 형식에 있어야 한다");
  });

  test("보존 조건이 빠진 계획은 저장하지 않는다", async () => {
    const outcome = await applyResponse(
      context,
      JSON.stringify({ ...PLAN, preserve: [PLAN.preserve[0]] }),
    );

    assert.equal(outcome.advanced, false);
    assert.equal(outcome.violations.length, 1);
    assert.match(outcome.violations[0].detail, /SettlementFacade 공개 시그니처/);
    assert.ok(!existsSync(lane(".plan.json")), "승인 화면에 올라가면 안 된다");
  });

  test("보존 조건을 다 든 계획은 저장되고 승인을 기다린다", async () => {
    await plan();

    assert.ok(existsSync(lane(".plan.json")));
    const next = nextPrompt(context);
    assert.equal(next.label, "approval");
    assert.match(next.message!, /보존 조건 \(2건\)/, "승인 화면에 보존 조건이 보여야 한다");
    assert.match(next.message!, /고칠 파일/);
  });

  test("missingPreserve 는 문장을 그대로 옮겼는지로 본다", async () => {
    const order = validateWorkOrder(
      join(root, "repo"),
      {
        kind: "refactor",
        id: "PROJ-7",
        title: "t",
        target: "app/features/settlement",
        scope: "app/features/settlement",
        preserve: ["공개 시그니처"],
      },
      "spec.md",
      { attributes: [], requireApprover: false },
    );

    const paraphrased = { ...PLAN, preserve: [{ item: "공개 시그니처를 유지", how: "…" }] };
    assert.deepEqual(missingPreserve(order, paraphrased as unknown as BuildPlan), ["공개 시그니처"]);
    assert.deepEqual(
      missingPreserve(order, { ...PLAN, preserve: [{ item: " 공개 시그니처 ", how: "…" }] } as unknown as BuildPlan),
      [],
      "앞뒤 공백은 같은 문장으로 본다",
    );
  });

  test("고치는 작업의 계획에는 도메인 자리가 비어 있다", async () => {
    const format = planFormatFor("refactor");
    const built = format.toPlan(JSON.parse(JSON.stringify(PLAN)));

    assert.equal(built.domainDirName, "");
    assert.equal(built.preserve?.length, 2);
  });
});

describe("보존 대상은 코드가 막는다", () => {
  test("preserve 에 적힌 파일을 고치려 하면 반영하지 않는다", async () => {
    await plan();
    approve();

    const outcome = await applyResponse(
      context,
      [
        "### edit app/features/settlement/facade.py",
        "#### find",
        "```",
        "    def settle(self):",
        "```",
        "#### replace",
        "```",
        "    def settle(self, tx):",
        "```",
        "",
        "### done",
      ].join("\n"),
    );

    assert.equal(outcome.violations.length, 1);
    assert.equal(outcome.violations[0].item, "보존 대상");
    assert.match(outcome.violations[0].detail, /지시서를 먼저 고쳐야/);
    assert.ok(!existsSync(lane("app/features/settlement/facade.py")), "디스크에 남으면 안 된다");
  });

  test("scope 밖의 파일도 막는다", async () => {
    await plan();
    approve();

    const outcome = await applyResponse(
      context,
      [
        "### write app/common/tx.py",
        "```py",
        "def begin():",
        "    return None",
        "```",
        "",
        "### done",
      ].join("\n"),
    );

    assert.equal(outcome.violations[0].item, "지시서 scope 밖");
  });

  test("scope 안의 보존 대상 아닌 파일은 고칠 수 있다", async () => {
    await plan();
    approve();

    const outcome = await applyResponse(
      context,
      [
        "### edit app/features/settlement/service.py",
        "#### find",
        "```",
        "    def run(self):",
        "```",
        "#### replace",
        "```",
        "    def run(self, tx):",
        "```",
        "",
        "### done",
      ].join("\n"),
    );

    assert.deepEqual(outcome.violations, []);
    assert.match(
      readFileSync(lane("app/features/settlement/service.py"), "utf-8"),
      /def run\(self, tx\)/,
    );
    assert.match(
      readFileSync(join(root, "repo", "app/features/settlement/service.py"), "utf-8"),
      /def run\(self\)/,
      "대상 저장소는 건드리지 않는다",
    );
  });

  test("생성 프롬프트에 고칠 파일의 현재 내용이 실린다", async () => {
    await plan();
    approve();

    const prompt = nextPrompt(context).prompt!;

    assert.match(prompt, /# 고칠 파일의 현재 내용/);
    assert.match(prompt, /class SettlementService/);
    assert.doesNotMatch(prompt, /class SettlementFacade/, "보존 대상까지 실을 이유는 없다");
  });
});
