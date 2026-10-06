/**
 * 경계 검사 — 지시서가 정한 상한선이 코드로 강제되는가.
 *
 * 여기서 판정되는 것은 **보존하라고 한 것을 바꾸려는 시도가 실제로 거부되는가**다.
 * 이것이 없으면 지시서의 preserve 는 모델에게 하는 부탁일 뿐이고, 새 흐름에서는 hook 이
 * 이 함수를 딛고 쓰기를 막으므로 그 부탁이 곧 유일한 방어선이 된다.
 *
 * 경계는 두 곳에서 온다. **지시서**(사람이 확정한 scope·preserve)와 **매니페스트**
 * (단계별 outputDirs)이고, 둘 다 통과해야 한다.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { checkPaths, missingPlannedFiles, preservedPaths, unplannedFiles } from "../core/gate";
import type { Manifest, StageDef } from "../core/manifest";
import type { BuildPlan } from "../core/types";
import { validateWorkOrder } from "../core/workOrder";
import type { WorkOrder } from "../core/workOrder";
import { planFormatFor } from "../core/plan";

const STAGE: StageDef = {
  key: "restructure",
  title: "구조 정리",
  template: "90-restructure.md",
  kind: "code",
  kinds: ["refactor"],
  confirm: true,
  exemplars: [],
  scope: "project",
  outputDirs: [],
} as unknown as StageDef;

const MANIFEST = {
  language: "python",
  sourceExtensions: [".py"],
  domainBase: "app/features",
  domainRoots: [],
  conventions: [],
  commands: {},
  docs: {},
  git: { base: "master" },
  workOrder: { attributes: [], requireApprover: false, requireVerifiedApproval: false },
  stages: [STAGE],
} as unknown as Manifest;

const PLAN: BuildPlan = {
  domainName: "",
  domainLabel: "",
  domainRoot: "",
  domainDirName: "",
  files: [
    {
      stage: "restructure",
      path: "app/features/settlement/service.py",
      purpose: "트랜잭션 경계를 옮긴다",
    },
  ],
  sequence: [{ step: "restructure", why: "옮길 곳이 하나다" }],
  approach: "트랜잭션 경계만 서비스로 옮긴다",
  conventions: [],
  conflicts: [],
  openQuestions: [],
  reasoning: "경계만 옮긴다",
};

let repo: string;
let ORDER: WorkOrder;

function write(relative: string, content = "x = 1\n"): void {
  const path = join(repo, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

/** 한 경로를 이 단계에서 쓰려 할 때 걸리는 위반 */
function check(...paths: string[]) {
  return checkPaths({
    repoRoot: repo,
    order: ORDER,
    manifest: MANIFEST,
    plan: PLAN,
    stage: STAGE,
    files: paths.map((path) => ({ path, content: "x = 1\n" })),
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "code-agent-gate-"));
  write("app/features/settlement/service.py", "class SettlementService:\n    pass\n");
  write("app/features/settlement/facade.py", "class SettlementFacade:\n    pass\n");
  write("app/common/tx.py", "def begin():\n    pass\n");

  ORDER = validateWorkOrder(
    repo,
    {
      kind: "refactor",
      id: "PROJ-7",
      title: "정산 트랜잭션 경계 정리",
      target: "app/features/settlement",
      scope: "app/features/settlement",
      preserve: ["app/features/settlement/facade.py", "SettlementFacade 공개 시그니처"],
    },
    "doc/work/PROJ-7.md",
    { attributes: [], requireApprover: false },
  );
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("보존 대상은 코드가 막는다", () => {
  test("preserve 에 적힌 파일은 종류와 무관하게 막는다", () => {
    const [violation, ...rest] = check("app/features/settlement/facade.py");

    assert.deepEqual(rest, [], "하나만 걸린다");
    assert.equal(violation.item, "보존 대상");
    assert.match(violation.detail, /지시서를 먼저 고쳐야/);
  });

  test("scope 밖의 파일도 막는다", () => {
    const [violation] = check("app/common/tx.py");

    assert.equal(violation.item, "지시서 scope 밖");
    assert.match(violation.detail, /app\/features\/settlement/);
  });

  test("테스트 단계 파일은 scope 상한을 받지 않지만 단계 위치와 보존 대상은 그대로 지킨다", () => {
    const run = (path: string, stage: StageDef = { ...STAGE, kind: "test", scope: "project", outputDirs: ["tests"] }) =>
      checkPaths({ repoRoot: repo, order: ORDER, manifest: MANIFEST, plan: PLAN, stage, files: [{ path, content: "" }] });
    assert.deepEqual(run("tests/settlement/test_repro.py"), [], "fix 의 재현 테스트를 scope 에 적지 않아도 계획할 수 있다");
    assert.equal(run("app/common/test_tx.py")[0].item, "do-not-touch 경계", "테스트 단계 위치 밖은 그대로 막는다");
    assert.equal(run("app/features/settlement/facade.py", { ...STAGE, kind: "test" as const })[0].item, "보존 대상");
    assert.equal(check("tests/settlement/test_repro.py")[0].item, "지시서 scope 밖", "제품 코드 단계는 그대로 scope 를 받는다");
  });

  test("scope 안의 보존 대상 아닌 파일은 통과시킨다", () => {
    assert.deepEqual(check("app/features/settlement/service.py"), []);
  });

  test("절대경로·상위 경로 참조는 막는다", () => {
    assert.equal(check("/etc/passwd")[0].item, "경로 규칙");
    assert.equal(check("../outside.py")[0].item, "경로 규칙");
  });

  /**
   * preserve 는 경로와 문장을 섞어 쓴다 — 어느 쪽인지를 추측하지 않고 실재로 가른다.
   * 저장소에 실제로 있는 경로면 코드가 막고, 나머지 문장형은 사람과 리뷰가 본다.
   */
  test("preserve 중 경로로 확인되는 것만 코드가 막는다", () => {
    assert.deepEqual(preservedPaths(repo, ORDER), ["app/features/settlement/facade.py"]);
  });
});

describe("계획 준수 — 경계는 '어디에' 를, 계획은 '무엇을' 을 막는다", () => {
  test("계획에 없는 파일을 만들려 하면 걸린다", () => {
    const [violation] = unplannedFiles(PLAN, STAGE, ["app/features/settlement/other.py"]);

    assert.equal(violation.item, "계획 준수");
    assert.match(violation.detail, /승인된 계획에 없는 파일/);
  });

  test("계획에 있는 파일은 통과한다", () => {
    assert.deepEqual(unplannedFiles(PLAN, STAGE, ["app/features/settlement/service.py"]), []);
  });

  test("계획이 그 단계에 대해 아무 말도 하지 않으면 검사하지 않는다", () => {
    // 문서 산출물처럼 계획이 파일을 열거하지 않는 단계까지 막으면 없던 규칙을 발명하는 셈이다.
    const silent: BuildPlan = { ...PLAN, files: [] };

    assert.deepEqual(unplannedFiles(silent, STAGE, ["무엇이든.py"]), []);
    assert.deepEqual(missingPlannedFiles(silent, STAGE, []), []);
  });

  test("계획에 있는데 아직 없는 것은 단계를 끝낼 때 걸린다", () => {
    const [violation] = missingPlannedFiles(PLAN, STAGE, []);

    assert.equal(violation.item, "계획 준수");
    assert.equal(violation.file, "app/features/settlement/service.py");

    assert.deepEqual(
      missingPlannedFiles(PLAN, STAGE, ["app/features/settlement/service.py"]),
      [],
      "모델이 그 파일을 쓰면 풀린다",
    );
  });
});

for (const kind of ["fix", "refactor"] as const) {
  test(`H3: ${kind}는 파일별 도메인을 풀고 분류·계층·scope·preserve 경계를 유지한다`, () => {
    const format = planFormatFor(kind);
    const plan = format.toPlan(format.schema.parse({ ...PLAN, preserve: [] }));
    const manifest = { ...MANIFEST, domainBase: "src/main", domainRoots: ["admin", "application"] };
    const stage = { ...STAGE, scope: "domain" as const, outputDirs: ["domain"] };
    const order = { ...ORDER, kind, scope: ["src/main", "src/test"], preserve: [] };
    const input = { repoRoot: repo, order, manifest, plan, stage };
    const run = (path: string, overrides = {}) => checkPaths({ ...input, files: [{ path, content: "" }], ...overrides });
    for (const root of ["admin", "application"]) {
      assert.deepEqual(run(`src/main/${root}/orders/domain/Order.java`), []);
      assert.equal(run(`src/main/${root}/orders/repository/Order.java`)[0].item, "do-not-touch 경계");
      assert.deepEqual(run(`src/test/${root}/orders/domain/OrderTest.java`, { stage: { ...stage, base: "src/test" } }), []);
    }
    assert.equal(run("src/main/unknown/orders/domain/Order.java")[0].item, "do-not-touch 경계");
    assert.equal(run("src/main/application/Order.java")[0].item, "do-not-touch 경계");
    assert.equal(run("src/main/admin/orders/domain/Order.java", { order: { ...order, scope: ["src/main/application"] } })[0].item, "지시서 scope 밖");
    write("src/main/admin/orders/domain/Order.java");
    assert.equal(run("src/main/admin/orders/domain/Order.java", { order: { ...order, preserve: ["src/main/admin/orders/domain/Order.java"] } })[0].item, "보존 대상");
    assert.deepEqual(run("src/main/orders/service.py", { manifest: { ...manifest, domainRoots: [] }, stage: { ...stage, outputDirs: ["."] } }), []);
    assert.equal(run("src/main/orders/sub/service.py", { manifest: { ...manifest, domainRoots: [] }, stage: { ...stage, outputDirs: ["."] } })[0].item, "do-not-touch 경계");
  });
}
