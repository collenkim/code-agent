/**
 * 2차 게이트 — 계획 승인.
 *
 * 여기서 판정되는 것은 "사람이 승인하기 전에는 아무것도 만들어지지 않는가"와
 * "승인받은 것과 다른 것을 만들 수 있는가"다. 뒤쪽이 없으면 승인은 형식이 된다 —
 * 승인만 받아 두고 계획이나 지시서를 고치면 그대로 통과하기 때문이다.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { diffPlans, hashWorkOrder, ledgerPath, readLedger } from "../core/approval";
import type { ApprovalRecord } from "../core/approval";
import { questionsPath } from "../core/session";
import { savePlan } from "../core/state";
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
      exemplars: ["models.py"],
      outputDirs: ["."],
    },
  ],
};

const PLAN: BuildPlan = {
  domainName: "shipment",
  domainLabel: "배송",
  domainRoot: "",
  domainDirName: "shipment",
  files: [{ stage: "model", path: "app/features/shipment/models.py", purpose: "배송 모델" }],
  conventions: [{ rule: "dataclass 사용", source: "doc/conventions.md" }],
  conflicts: [],
  openQuestions: [],
  reasoning: "참조 도메인 구조를 따랐다",
};

let root: string;
let context: BuildContext;

function write(relative: string, content: string) {
  const path = join(root, "repo", relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function writeSpec(frontMatter: string) {
  writeFileSync(join(root, "spec.md"), `${frontMatter}\n# 배송(shipment) 도메인\n`, "utf-8");
}

const ORDER = "---\nkind: feature\nid: TEST-1\ntitle: 배송 도메인 추가\ntarget: shipment\n---\n";

/** 계획까지 세운 상태. 승인은 아직이다 */
async function plan(changes: Partial<BuildPlan> = {}) {
  await applyResponse(context, JSON.stringify({ ...PLAN, ...changes }));
}

/** 대상 하나가 도는 자리 */
function lane(...parts: string[]): string {
  return join(root, "out", "TEST-1", "shipment", ...parts);
}

function ledger(): ApprovalRecord[] {
  return readLedger(join(root, "repo"), "TEST-1");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-approval-"));
  write("app/features/orders/models.py", "from dataclasses import dataclass\n");
  write("doc/conventions.md", "# 컨벤션\n- dataclass 를 쓴다.\n");
  write("doc/templates/code-agent.json", JSON.stringify(MANIFEST, null, 2));
  write("doc/templates/01-model.md", "# [01] 모델\n");
  writeSpec(ORDER);

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

describe("승인 전에는 진행되지 않는다", () => {
  test("계획이 서면 프롬프트 대신 승인 요청이 나온다", async () => {
    await plan();
    const next = nextPrompt(context);

    assert.equal(next.label, "approval");
    assert.equal(next.prompt, undefined, "모델에 보낼 것이 없다 — 승인은 사람이 하는 일이다");
    assert.match(next.message!, /계획 승인이 필요합니다/);
    assert.match(next.message!, /app\/features\/shipment\/models\.py/, "계획 전문이 보여야 한다");
  });

  test("승인 화면은 사람이 답한 것을 함께 보여 준다", async () => {
    // 승인하는 사람은 이 계획이 어떤 답 위에 세워졌는지도 봐야 한다. 그리고 여기까지
    // 왔다는 것은 답이 다 채워졌다는 뜻이라, 그것을 '미결' 이라 부르면 잘못 읽는다.
    await plan({ openQuestions: ["주소 최대 길이는?"] });
    const path = questionsPath(lane());
    writeFileSync(
      path,
      readFileSync(path, "utf-8").replace("(여기에 답을 적으세요)", "최대 200자"),
      "utf-8",
    );

    const message = nextPrompt(context).message!;

    assert.match(message, /사람이 답한 것/);
    assert.match(message, /최대 200자/);
    assert.doesNotMatch(message, /미결 질문/);
  });

  test("승인 전에 응답을 붙여넣어도 아무것도 반영하지 않는다", async () => {
    await plan();
    const out = await applyResponse(context, "### write app/features/shipment/models.py\n```py\nx = 1\n```\n### done");

    assert.equal(out.advanced, false);
    assert.equal(out.label, "approval");
    assert.ok(!existsSync(lane("app/features/shipment/models.py")));
  });

  test("승인하면 첫 단계로 넘어간다", async () => {
    await plan();
    decideApproval(context, "approved", { approver: "팀장" });

    assert.equal(nextPrompt(context).label, "model");
  });

  test("반려하면 계획을 다시 세우기 전에는 풀리지 않는다", async () => {
    await plan();
    decideApproval(context, "rejected", { approver: "팀장", comment: "공통 모듈은 별도 지시서로" });

    const next = nextPrompt(context);
    assert.equal(next.label, "approval");
    assert.match(next.message!, /반려/);
    assert.match(next.message!, /공통 모듈은 별도 지시서로/, "사유가 보여야 한다");
  });

  test("반려에는 사유가 필요하다", async () => {
    await plan();
    assert.throws(() => decideApproval(context, "rejected", { approver: "팀장" }), /사유/);
  });

  test("누가 판정했는지 모르면 남기지 않는다", async () => {
    await plan();
    assert.throws(() => decideApproval(context, "approved", {}), /--approver/);
  });

  test("지시서의 approver 가 기본값이 된다", async () => {
    writeSpec(
      "---\nkind: feature\nid: TEST-1\ntitle: 배송 도메인 추가\ntarget: shipment\napprover: team-lead\n---\n",
    );
    await plan();
    const { record } = decideApproval(context, "approved", {});

    assert.equal(record.approver, "team-lead");
  });
});

/**
 * 실제로 샜던 자리를 그대로 재현한다.
 *
 * bootstrap 스타터처럼 `conventions` 와 `exemplars` 가 비어 있으면 저장소에서 읽을 것이 하나도
 * 없다. 그래서 오타 난 저장소 경로가 아무 데도 걸리지 않고 승인까지 흘러가고, recursive mkdir 이
 * 거기에 트리를 통째로 만들어 버린다 — 아무도 승인한 적 없는 곳에 승인 기록이 생긴다.
 */
describe("없는 저장소에는 판정을 남기지 않는다", () => {
  const BOOTSTRAP_MANIFEST = {
    domainBase: "src",
    domainRoots: [],
    conventions: [],
    stages: [
      {
        key: "decisions",
        title: "결정 질문지",
        template: "01-decisions.md",
        kind: "doc",
        scope: "project",
        exemplars: [],
        outputDirs: ["doc"],
      },
    ],
  };

  /** 저장소를 하나도 읽지 않는 실행. repoRoot 만 갈아 끼워 쓴다 */
  function bootstrapAt(repoRoot: string): BuildContext {
    return {
      specPaths: [join(root, "new-spec.md")],
      templatesDir: join(root, "templates"),
      repoRoot,
      outDir: join(root, "out-new"),
      maxRetries: 1,
    };
  }

  beforeEach(() => {
    // 템플릿은 저장소 밖에 둔다 — 저장소가 없어도 매니페스트가 해석되는 상황이다.
    mkdirSync(join(root, "templates"), { recursive: true });
    writeFileSync(
      join(root, "templates", "code-agent.json"),
      JSON.stringify(BOOTSTRAP_MANIFEST),
      "utf-8",
    );
    writeFileSync(join(root, "templates", "01-decisions.md"), "# [01] 결정 질문지\n", "utf-8");
    writeFileSync(
      join(root, "new-spec.md"),
      "---\nkind: bootstrap\nid: NEW-1\ntitle: 신규\ntarget: new-service\n---\n\n# 프로젝트 개요\n무언가를 만든다.\n",
      "utf-8",
    );
  });

  /** 계획까지 세운다. 저장소가 없어도 여기까지는 돈다 */
  async function planFor(repoRoot: string): Promise<BuildContext> {
    const built = bootstrapAt(repoRoot);
    await applyResponse(
      built,
      JSON.stringify({
        domainName: "new-service",
        domainLabel: "신규",
        domainRoot: "",
        domainDirName: "new-service",
        files: [{ stage: "decisions", path: "doc/architecture-decisions.md", purpose: "질문지" }],
        conventions: [],
        conflicts: [],
        openQuestions: [],
        reasoning: "복제할 코드가 없다",
      }),
    );
    return built;
  }

  test("경로가 없으면 만들지 않고 멈춘다", async () => {
    const typo = join(root, "저장소-오타");
    const built = await planFor(typo);

    assert.throws(
      () => decideApproval(built, "approved", { approver: "팀장" }),
      /대상 저장소가 없습니다/,
    );
    assert.equal(existsSync(typo), false, "없는 경로에 디렉토리가 생기면 안 된다");
  });

  test("저장소 자리에 파일이 있으면 거부한다", async () => {
    const notADir = join(root, "저장소-아닌-파일");
    writeFileSync(notADir, "이건 디렉토리가 아니다", "utf-8");
    const built = await planFor(notADir);

    assert.throws(
      () => decideApproval(built, "approved", { approver: "팀장" }),
      /대상 저장소가 없습니다/,
    );
  });

  test("디렉토리만 있으면 남긴다 — git 저장소일 필요는 없다", async () => {
    const plainDir = join(root, "그냥-디렉토리");
    mkdirSync(plainDir, { recursive: true });
    const built = await planFor(plainDir);

    decideApproval(built, "approved", { approver: "팀장" });

    assert.equal(readLedger(plainDir, "NEW-1").length, 1);
  });
});

describe("원장 — 판정 사건이 쌓인다", () => {
  test("대상 저장소 안에 남는다 — out/ 은 지워지는 곳이다", async () => {
    await plan();
    decideApproval(context, "approved", { approver: "팀장", comment: "확인함" });

    const path = ledgerPath(join(root, "repo"), "TEST-1");
    assert.ok(existsSync(path), "저장소의 .code-agent/approvals/ 에 있어야 한다");
    assert.ok(!existsSync(join(root, "out", ".code-agent", "approvals")));

    const [record] = ledger();
    assert.equal(record.decision, "approved");
    assert.equal(record.approver, "팀장");
    assert.equal(record.comment, "확인함");
    assert.equal(record.target, "shipment");
    assert.equal(record.kind, "feature");
    assert.match(record.orderHash, /^sha256:/);
    assert.match(record.planHash, /^sha256:/);
  });

  test("반려도 남는다 — 지워야 할 실패가 아니다", async () => {
    await plan();
    decideApproval(context, "rejected", { approver: "팀장", comment: "범위가 넓다" });
    await plan({ files: [] });
    decideApproval(context, "approved", { approver: "팀장" });

    const rows = ledger();
    assert.equal(rows.length, 2, "앞 줄을 고치지 않고 이어붙인다");
    assert.equal(rows[0].decision, "rejected");
    assert.equal(rows[1].decision, "approved");
  });

  test("승인 시점 계획 스냅샷이 함께 남는다 — 해시만으로는 diff 를 만들 수 없다", async () => {
    await plan();
    const { record } = decideApproval(context, "approved", { approver: "팀장" });

    const snapshot = JSON.parse(readFileSync(join(root, "repo", record.snapshot), "utf-8"));
    assert.equal(snapshot.files[0].path, "app/features/shipment/models.py");
  });

  test("같은 계획에 같은 승인을 두 번 남기지 않는다", async () => {
    await plan();
    decideApproval(context, "approved", { approver: "팀장" });
    const second = decideApproval(context, "approved", { approver: "팀장", target: "shipment" });

    assert.equal(second.unchanged, true);
    assert.equal(ledger().length, 1);
  });
});

describe("승인은 이 계획, 이 지시서에 대한 것이다", () => {
  test("계획이 바뀌면 승인이 무효가 되고 재승인을 기다린다", async () => {
    await plan();
    decideApproval(context, "approved", { approver: "팀장" });
    assert.equal(nextPrompt(context).label, "model");

    savePlan(lane(), {
      ...PLAN,
      files: [
        ...PLAN.files,
        { stage: "model", path: "app/features/shipment/service.py", purpose: "배송 서비스" },
      ],
    });

    const next = nextPrompt(context);
    assert.equal(next.label, "approval", "승인받고 다른 것을 만드는 길이 없어야 한다");
    assert.match(next.message!, /직전 판정이 무효/);
  });

  test("재승인 화면은 계획 전문이 아니라 달라진 항목만 띄운다", async () => {
    await plan();
    decideApproval(context, "approved", { approver: "팀장" });

    savePlan(lane(), {
      ...PLAN,
      files: [{ stage: "model", path: "app/features/shipment/service.py", purpose: "배송 서비스" }],
      conventions: [{ rule: "dataclass 사용", source: "doc/style.md" }],
    });

    const message = nextPrompt(context).message!;
    assert.match(message, /파일 {3}- app\/features\/shipment\/models\.py/);
    assert.match(message, /\+ app\/features\/shipment\/service\.py/);
    assert.match(message, /규칙 {3}~ dataclass 사용: 근거 doc\/conventions\.md → doc\/style\.md/);
    assert.doesNotMatch(message, /## 작업 명세서/, "전문을 다시 읽히지 않는다");
  });

  test("작업 지시서가 바뀌면 승인이 무효가 된다 — 0차부터 다시", async () => {
    await plan();
    decideApproval(context, "approved", { approver: "팀장" });
    assert.equal(nextPrompt(context).label, "model");

    // preserve 한 줄을 지우면 3차 게이트가 그냥 통과한다. 계획보다 이쪽이 더 위험하다.
    // 대상은 그대로 둔다 — 대상을 바꾸는 것은 무효가 아니라 아예 다른 레인을 여는 일이다.
    writeSpec("---\nkind: feature\nid: TEST-1\ntitle: 배송 도메인 정리\ntarget: shipment\n---\n");

    const next = nextPrompt(context);
    assert.equal(next.label, "approval");
    assert.match(next.message!, /지시서가 바뀌어/);
    assert.match(next.message!, /0차부터 다시/);
  });

  test("속성 순서만 바꾼 지시서는 같은 것으로 본다", async () => {
    const policy = { attributes: [], requireApprover: false };
    const one = validateWorkOrder(
      join(root, "repo"),
      { kind: "feature", id: "TEST-1", title: "제목", target: "shipment" },
      "spec.md",
      policy,
    );
    const other = validateWorkOrder(
      join(root, "repo"),
      { target: "shipment", title: "제목", id: "TEST-1", kind: "feature" },
      "other.md",
      policy,
    );

    assert.equal(hashWorkOrder(one), hashWorkOrder(other), "순서와 파일 위치는 내용이 아니다");
  });
});

describe("diff — 문구 하나와 파일 하나가 같은 무게로 보이면 안 된다", () => {
  test("절마다 항목 단위로 비교한다", async () => {
    const entries = diffPlans(PLAN, {
      ...PLAN,
      domainDirName: "shipments",
      files: [{ stage: "model", path: "app/features/shipment/models.py", purpose: "배송 집계" }],
      conflicts: [
        { topic: "트랜잭션 경계", docSays: "Handler", codeSays: "Facade", decision: "Facade 를 따른다" },
      ],
      reasoning: "다시 판단했다",
    });

    const of = (section: string) => entries.filter((entry) => entry.section === section);
    assert.equal(of("도메인").length, 1);
    assert.deepEqual(of("파일").map((entry) => entry.change), ["~"], "경로가 같으면 변경이다");
    assert.deepEqual(of("충돌").map((entry) => entry.change), ["+"]);
    assert.deepEqual(of("근거").map((entry) => entry.change), ["~"]);
    assert.equal(of("규칙").length, 0, "안 바뀐 절은 나오지 않는다");
  });

  test("순서만 바뀐 것은 변경이 아니다", async () => {
    const two = {
      ...PLAN,
      files: [
        { stage: "model", path: "a.py", purpose: "가" },
        { stage: "model", path: "b.py", purpose: "나" },
      ],
    };
    const flipped = { ...two, files: [two.files[1], two.files[0]] };

    assert.deepEqual(diffPlans(two, flipped), []);
  });
});
