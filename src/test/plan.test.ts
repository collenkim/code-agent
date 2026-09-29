/**
 * 계획의 규격 — 종류마다 갈리는 형식과, 보존 조건 대조.
 *
 * 계획은 Claude Code 안의 모델이 plan.json 으로 써 온다. 그러므로 여기서 판정되는 것은
 * "모델이 잘 쓰는가"가 아니라 **그 초안을 코드가 어떻게 검사하는가**다.
 *
 * 보존 조건 대조가 이 파일의 본체다. 문장을 그대로 옮기게 해 두면 대조를 코드가 한다 —
 * 모델이 요약하거나 흘리면 여기서 걸리고, 걸린 계획은 승인 화면에 올라가지 않는다.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { stagesFor } from "../core/manifest";
import type { Manifest } from "../core/manifest";
import { missingPreserve, planFormatFor } from "../core/plan";
import type { BuildPlan } from "../core/types";
import { validateWorkOrder } from "../core/workOrder";
import type { WorkOrder } from "../core/workOrder";

const MANIFEST = {
  language: "python",
  sourceExtensions: [".py"],
  domainBase: "app/features",
  domainRoots: [],
  conventions: ["doc/conventions.md"],
  referenceDomain: "orders",
  commands: {},
  docs: {},
  git: { base: "master" },
  workOrder: { attributes: [], requireApprover: false, requireVerifiedApproval: false },
  stages: [
    {
      key: "model",
      title: "모델",
      template: "01-model.md",
      kind: "code",
      kinds: ["feature"],
      confirm: true,
      exemplars: ["models.py"],
      scope: "domain",
      outputDirs: ["."],
    },
    {
      // 고치는 작업은 Entity~Controller 를 순차 생성하지 않는다. 경계는 지시서가 정한다.
      key: "restructure",
      title: "구조 정리",
      template: "90-restructure.md",
      kind: "code",
      kinds: ["refactor"],
      confirm: true,
      exemplars: [],
      scope: "project",
      outputDirs: [],
    },
  ],
} as unknown as Manifest;

const REFACTOR_PLAN = {
  files: [
    {
      stage: "restructure",
      path: "app/features/settlement/service.py",
      purpose: "트랜잭션 경계를 옮긴다",
    },
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

let repo: string;

function order(preserve: string[]): WorkOrder {
  return validateWorkOrder(
    repo,
    {
      kind: "refactor",
      id: "PROJ-7",
      title: "정산 트랜잭션 경계 정리",
      target: "app/features/settlement",
      scope: "app/features/settlement",
      preserve,
    },
    "doc/work/PROJ-7.md",
    { attributes: [], requireApprover: false },
  );
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "code-agent-plan-"));
  mkdirSync(join(repo, "app", "features", "settlement"), { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("종류마다 도는 단계가 다르다", () => {
  test("refactor 는 생성 단계를 돌지 않는다", () => {
    assert.deepEqual(
      stagesFor(MANIFEST, "refactor").map((stage) => stage.key),
      ["restructure"],
      "Entity~Controller 를 순차 생성하지 않는다",
    );
  });

  test("돌 단계가 하나도 없으면 조용히 끝내지 않는다", () => {
    assert.throws(
      () => stagesFor({ ...MANIFEST, stages: [MANIFEST.stages[0]] }, "refactor"),
      /선언돼 있지 않습니다/,
      "아무것도 안 한 실행을 '다 됐다'로 읽으면 안 된다",
    );
  });
});

describe("고치는 작업의 계획에는 도메인 자리가 비어 있다", () => {
  test("planFormatFor('refactor') 는 도메인 자리를 빈 문자열로 채운다", () => {
    // 도메인 자리를 비워 두면 경계 검사도 도메인 디렉토리가 아니라 지시서의 scope 를 본다.
    const format = planFormatFor("refactor");
    const built = format.toPlan(JSON.parse(JSON.stringify(REFACTOR_PLAN)));

    assert.equal(built.domainName, "");
    assert.equal(built.domainLabel, "");
    assert.equal(built.domainRoot, "");
    assert.equal(built.domainDirName, "");
    assert.equal(built.preserve?.length, 2);
    assert.equal(format.requiresPreserve, true);
  });

  test("만드는 작업은 도메인을 그대로 들고 간다", () => {
    const format = planFormatFor("feature");

    assert.equal(format.requiresPreserve, false);
    assert.equal(
      format.toPlan({ ...REFACTOR_PLAN, domainDirName: "shipment" }).domainDirName,
      "shipment",
    );
  });
});

describe("missingPreserve — 문장을 그대로 옮겼는지로 본다", () => {
  test("요약·의역은 누락으로 본다", () => {
    const paraphrased = {
      ...REFACTOR_PLAN,
      preserve: [{ item: "공개 시그니처를 유지", how: "…" }],
    };

    assert.deepEqual(
      missingPreserve(order(["공개 시그니처"]), paraphrased as unknown as BuildPlan),
      ["공개 시그니처"],
    );
  });

  test("앞뒤 공백은 같은 문장으로 본다", () => {
    const padded = { ...REFACTOR_PLAN, preserve: [{ item: " 공개 시그니처 ", how: "…" }] };

    assert.deepEqual(missingPreserve(order(["공개 시그니처"]), padded as unknown as BuildPlan), []);
  });

  test("지시서의 보존 조건을 다 든 계획은 남는 것이 없다", () => {
    const full = order([
      "app/features/settlement/facade.py",
      "SettlementFacade 공개 시그니처",
    ]);

    assert.deepEqual(missingPreserve(full, REFACTOR_PLAN as unknown as BuildPlan), []);
  });

  test("하나만 든 계획은 빠진 것을 그대로 돌려준다", () => {
    const full = order([
      "app/features/settlement/facade.py",
      "SettlementFacade 공개 시그니처",
    ]);
    const partial = { ...REFACTOR_PLAN, preserve: [REFACTOR_PLAN.preserve[0]] };

    assert.deepEqual(missingPreserve(full, partial as unknown as BuildPlan), [
      "SettlementFacade 공개 시그니처",
    ]);
  });
});
