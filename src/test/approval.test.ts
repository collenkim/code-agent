/**
 * 계획 승인. **코어를 직접 부른다.**
 *
 * 여기서 판정되는 것은 셋이다.
 *
 * 1. **승인받은 것과 다른 것을 만들 수 있는가.** 없으면 승인은 형식이다 — 승인만 받아 두고
 *    계획·지시서·경계를 고치면 그대로 통과하기 때문이다.
 * 2. **사람이 그 자리에 있었는지 남는가.** `approver` 는 사람이 적는 문자열이라 아무것도
 *    증명하지 않는다. 통로는 전송이 관측하는 것이라 다르다.
 * 3. **나중에 고친 것이 드러나는가.** 원장이 평문이라 손으로 고칠 수 있다. 막을 수는 없으니
 *    드러나게 만든다 — 사슬이 끊기면 읽는 쪽이 거부한다.
 *
 * 증명되지 않는 것도 분명히 해 둔다: **신원이다.** 자기가 자기를 승인할 수 있다.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  checkApproval,
  diffPlans,
  hashManifest,
  hashWorkOrder,
  LedgerTamperError,
  ledgerPath,
  readLedger,
  recordDecision,
} from "../core/approval";
import type { ApprovalRecord, Presence } from "../core/approval";
import type { Manifest } from "../core/manifest";
import type { BuildPlan } from "../core/types";
import { validateWorkOrder } from "../core/workOrder";
import type { WorkOrder } from "../core/workOrder";

const MANIFEST: Manifest = {
  language: "python",
  sourceExtensions: [".py"],
  domainBase: "app/features",
  domainRoots: [],
  conventions: ["doc/conventions.md"],
  referenceDomain: "orders",
  fixRounds: 2,
  commandTimeoutMinutes: 10,
  plugins: {},
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
      kinds: [],
      confirm: true,
      exemplars: ["models.py"],
      scope: "domain",
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
  sequence: [{ step: "model", why: "다른 단계가 이 모델에 기댄다" }],
  approach: "참조 도메인의 구조를 그대로 따라 새로 만든다",
  conventions: [{ rule: "dataclass 사용", source: "doc/conventions.md" }],
  conflicts: [],
  openQuestions: [],
  reasoning: "참조 도메인 구조를 따랐다",
};

/** 터미널에서 확인 문구를 입력한 것과 같은 관측 결과 */
const AT_TERMINAL: Presence = {
  channel: "tty",
  verified: true,
  detail: "터미널에서 approve 입력",
};

/** 전송이 사람 존재를 관측하지 못했을 때 */
const UNATTENDED: Presence = {
  channel: "unattended",
  verified: false,
  detail: "사람의 입력을 관측하지 못했습니다",
};

const TARGET = "shipment";

let root: string;
let repo: string;
let ORDER: WorkOrder;

function order(attributes: Record<string, unknown> = {}): WorkOrder {
  return validateWorkOrder(
    repo,
    { kind: "feature", id: "TEST-1", title: "배송 도메인 추가", target: TARGET, ...attributes },
    "doc/work/TEST-1.md",
    { attributes: [], requireApprover: false },
  );
}

/** 판정 한 건을 남긴다 — 코어를 그대로 부른다 */
function decide(
  overrides: {
    plan?: BuildPlan;
    decision?: "approved" | "rejected";
    presence?: Presence;
    comment?: string;
    order?: WorkOrder;
    repoRoot?: string;
  } = {},
): ApprovalRecord {
  return recordDecision(overrides.repoRoot ?? repo, {
    order: overrides.order ?? ORDER,
    target: TARGET,
    plan: overrides.plan ?? PLAN,
    manifest: MANIFEST,
    decision: overrides.decision ?? "approved",
    approver: "팀장",
    ...(overrides.comment ? { comment: overrides.comment } : {}),
    presence: overrides.presence ?? AT_TERMINAL,
  });
}

function ledger(repoRoot = repo): ApprovalRecord[] {
  return readLedger(repoRoot, "TEST-1");
}

function ledgerFile(): string {
  return ledgerPath(repo, "TEST-1");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-approval-"));
  repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  ORDER = order();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("없는 저장소에는 판정을 남기지 않는다", () => {
  /**
   * 실제로 샜던 자리다. recursive mkdir 은 오타 난 경로에도 트리를 통째로 만들어 버린다 —
   * 아무도 승인한 적 없는 곳에 승인 기록이 생기고, 정작 승인했다고 믿은 저장소에는 없다.
   */
  test("경로가 없으면 만들지 않고 멈춘다", () => {
    const typo = join(root, "저장소-오타");

    assert.throws(() => decide({ repoRoot: typo }), /대상 저장소가 없습니다/);
    assert.equal(existsSync(typo), false, "없는 경로에 디렉토리가 생기면 안 된다");
  });

  test("저장소 자리에 파일이 있으면 거부한다", () => {
    const notADir = join(root, "저장소-아닌-파일");
    writeFileSync(notADir, "이건 디렉토리가 아니다", "utf-8");

    assert.throws(() => decide({ repoRoot: notADir }), /대상 저장소가 없습니다/);
  });

  test("디렉토리만 있으면 남긴다 — git 저장소일 필요는 없다", () => {
    const plainDir = join(root, "그냥-디렉토리");
    mkdirSync(plainDir, { recursive: true });

    decide({ repoRoot: plainDir });

    assert.equal(ledger(plainDir).length, 1);
  });
});

describe("원장 — 판정 사건이 쌓인다", () => {
  test("대상 저장소 안에 남는다", () => {
    decide({ comment: "확인함" });

    assert.ok(existsSync(ledgerFile()), "저장소의 .code-agent/approvals/ 에 있어야 한다");
    assert.match(ledgerFile().replace(/\\/g, "/"), /\.code-agent\/approvals\/TEST-1\.jsonl$/);

    const [record] = ledger();
    assert.equal(record.decision, "approved");
    assert.equal(record.approver, "팀장");
    assert.equal(record.comment, "확인함");
    assert.equal(record.target, TARGET);
    assert.equal(record.kind, "feature");
    assert.match(record.orderHash, /^sha256:/);
    assert.match(record.planHash, /^sha256:/);
  });

  test("반려도 남는다 — 지워야 할 실패가 아니다", () => {
    decide({ decision: "rejected", comment: "범위가 넓다" });
    decide({ plan: { ...PLAN, files: [] } });

    const rows = ledger();
    assert.equal(rows.length, 2, "앞 줄을 고치지 않고 이어붙인다");
    assert.equal(rows[0].decision, "rejected");
    assert.equal(rows[1].decision, "approved");
  });

  test("승인 시점 계획 스냅샷이 함께 남는다 — 해시만으로는 diff 를 만들 수 없다", () => {
    const record = decide();

    const snapshot = JSON.parse(readFileSync(join(repo, record.snapshot), "utf-8"));
    assert.equal(snapshot.files[0].path, "app/features/shipment/models.py");
  });

  test("같은 계획에 같은 승인을 두 번 남겨도 승인 상태는 그대로다", () => {
    decide();
    decide();

    assert.equal(ledger().length, 2, "판정은 사건이라 둘 다 남는다");
    assert.equal(checkApproval(repo, ORDER, PLAN, TARGET).status, "approved");
  });
});

describe("승인은 이 계획, 이 지시서, 이 경계에 대한 것이다", () => {
  test("판정이 없으면 none 이다", () => {
    assert.equal(checkApproval(repo, ORDER, PLAN, TARGET).status, "none");
  });

  test("계획이 바뀌면 무효가 되고 달라진 항목이 함께 온다", () => {
    decide();
    assert.equal(checkApproval(repo, ORDER, PLAN, TARGET).status, "approved");

    const grown: BuildPlan = {
      ...PLAN,
      files: [
        ...PLAN.files,
        { stage: "model", path: "app/features/shipment/service.py", purpose: "배송 서비스" },
      ],
    };
    const state = checkApproval(repo, ORDER, grown, TARGET);

    assert.equal(state.status, "stale-plan", "승인받고 다른 것을 만드는 길이 없어야 한다");
    assert.ok(state.status === "stale-plan");
    assert.deepEqual(
      state.diff.map((entry) => [entry.section, entry.change]),
      [["파일", "+"]],
      "스냅샷을 읽어 diff 를 만드는 경로까지 탄다",
    );
  });

  test("반려된 계획은 다시 세우기 전에는 풀리지 않는다", () => {
    decide({ decision: "rejected", comment: "공통 모듈은 별도 지시서로" });

    assert.equal(checkApproval(repo, ORDER, PLAN, TARGET).status, "rejected");
  });

  test("작업 지시서가 바뀌면 무효가 된다 — 0차부터 다시", () => {
    decide();

    // preserve 한 줄을 지우면 경계 검사가 그냥 통과한다. 계획보다 이쪽이 더 위험하다.
    const retitled = order({ title: "배송 도메인 정리" });

    assert.equal(checkApproval(repo, retitled, PLAN, TARGET).status, "stale-order");
  });

  test("경계가 바뀌면 무효가 된다 — 승인한 적 없는 곳에 코드가 나가지 않게", () => {
    decide();

    // 계획도 지시서도 그대로다 — 그래서 그 둘의 해시로는 이것이 잡히지 않는다.
    const wider: Manifest = {
      ...MANIFEST,
      stages: [{ ...MANIFEST.stages[0], outputDirs: [".", "config"] }],
    };

    assert.equal(
      checkApproval(repo, ORDER, PLAN, TARGET, { manifest: wider }).status,
      "stale-manifest",
    );
  });

  test("검증 명령이 바뀌어도 무효가 된다 — 무엇을 돌릴지도 승인의 범위다", () => {
    decide();

    const retested: Manifest = { ...MANIFEST, test: ["python", "-m", "pytest"] };

    assert.equal(
      checkApproval(repo, ORDER, PLAN, TARGET, { manifest: retested }).status,
      "stale-manifest",
    );
  });

  test("매니페스트 해시는 경계·검증만 담는다", () => {
    const wider: Manifest = {
      ...MANIFEST,
      stages: [{ ...MANIFEST.stages[0], outputDirs: [".", "config"] }],
    };
    // 일상적으로 고치는 것들이다. 이것까지 재승인을 요구하면 재승인이 형식이 된다.
    const reworded: Manifest = { ...MANIFEST, language: "javascript", conventions: ["doc/other.md"] };

    assert.notEqual(hashManifest(MANIFEST), hashManifest(wider), "경계가 달라지면 달라야 한다");
    assert.equal(hashManifest(MANIFEST), hashManifest(reworded), "문구·언어는 경계가 아니다");
  });

  test("경계 검사가 없던 예전 원장은 그대로 읽힌다", () => {
    decide();

    // manifestHash 도 prev 도 없는 줄 — 이 검사들이 생기기 전에 쌓인 것들이다.
    const stripped = readFileSync(ledgerFile(), "utf-8")
      .trim()
      .split("\n")
      .map((line) => {
        const { manifestHash, prev, ...rest } = JSON.parse(line) as ApprovalRecord;
        assert.equal(rest.stage, undefined, "계획 승인 줄에는 stage 가 없다");
        return JSON.stringify(rest);
      });
    writeFileSync(ledgerFile(), `${stripped.join("\n")}\n`, "utf-8");

    const wider: Manifest = {
      ...MANIFEST,
      stages: [{ ...MANIFEST.stages[0], outputDirs: [".", "x"] }],
    };

    assert.equal(
      checkApproval(repo, ORDER, PLAN, TARGET, { manifest: wider }).status,
      "approved",
      "예전 기록을 못 읽게 만드는 것은 이 검사가 막으려던 것보다 나쁘다",
    );
  });

  test("근거 문서가 바뀌면 무효가 된다", () => {
    recordDecision(repo, {
      order: ORDER,
      target: TARGET,
      plan: PLAN,
      manifest: MANIFEST,
      decision: "approved",
      approver: "팀장",
      presence: AT_TERMINAL,
      docsHash: "sha256:aaaaaaaaaaaaaaaa",
    });

    assert.equal(
      checkApproval(repo, ORDER, PLAN, TARGET, { docsHash: "sha256:aaaaaaaaaaaaaaaa" }).status,
      "approved",
    );
    assert.equal(
      checkApproval(repo, ORDER, PLAN, TARGET, { docsHash: "sha256:bbbbbbbbbbbbbbbb" }).status,
      "stale-docs",
    );
  });

  test("속성 순서만 바꾼 지시서는 같은 것으로 본다", () => {
    const policy = { attributes: [], requireApprover: false };
    const one = validateWorkOrder(
      repo,
      { kind: "feature", id: "TEST-1", title: "제목", target: TARGET },
      "spec.md",
      policy,
    );
    const other = validateWorkOrder(
      repo,
      { target: TARGET, title: "제목", id: "TEST-1", kind: "feature" },
      "other.md",
      policy,
    );

    assert.equal(hashWorkOrder(one), hashWorkOrder(other), "순서와 파일 위치는 내용이 아니다");
  });
});

describe("사람이 그 자리에 있었는지 원장에 남는다", () => {
  test("관측한 통로와 근거가 함께 남는다", () => {
    decide({ presence: AT_TERMINAL });

    const [record] = ledger();
    assert.equal(record.presence?.channel, "tty");
    assert.equal(record.presence?.verified, true);
    assert.match(record.presence!.detail, /approve 입력/);
  });

  test("관측되지 않았으면 그렇게 남는다 — 조용히 채우지 않는다", () => {
    decide({ presence: UNATTENDED });

    const [record] = ledger();
    assert.equal(record.presence?.channel, "unattended");
    assert.equal(record.presence?.verified, false);
  });
});

describe("requireVerifiedApproval — 관측된 판정만 게이트를 연다", () => {
  test("기본값에서는 관측되지 않은 승인도 게이트를 연다", () => {
    // 켜는 것은 선언이다. 기본값이 막으면 무엇을 잃는지 모르는 채로 길이 닫힌다.
    decide({ presence: UNATTENDED });

    assert.equal(checkApproval(repo, ORDER, PLAN, TARGET).status, "approved");
  });

  test("켜면 관측되지 않은 승인은 게이트를 열지 않는다", () => {
    decide({ presence: UNATTENDED });

    const state = checkApproval(repo, ORDER, PLAN, TARGET, { requireVerifiedApproval: true });

    assert.equal(state.status, "unverified");
    assert.ok(state.status === "unverified");
    assert.equal(state.record.presence?.channel, "unattended", "어느 통로였는지 남아야 한다");
  });

  test("켜도 터미널에서 관측된 승인은 게이트를 연다", () => {
    decide({ presence: AT_TERMINAL });

    assert.equal(
      checkApproval(repo, ORDER, PLAN, TARGET, { requireVerifiedApproval: true }).status,
      "approved",
    );
  });

  test("관측되지 않은 승인 위에 관측된 승인을 얹으면 풀린다", () => {
    decide({ presence: UNATTENDED });
    decide({ presence: AT_TERMINAL });

    assert.equal(
      checkApproval(repo, ORDER, PLAN, TARGET, { requireVerifiedApproval: true }).status,
      "approved",
    );
    assert.equal(ledger().length, 2, "두 판정이 모두 사건으로 남는다");
  });
});

describe("원장 사슬 — 나중에 고친 것이 드러난다", () => {
  /** 판정 두 건을 쌓는다 — 계획을 고쳐 재승인하는 것이 실제 경로다 */
  function twoDecisions() {
    decide();
    decide({ plan: { ...PLAN, reasoning: "범위를 좁혀 다시 세웠다" } });
  }

  test("새 줄은 직전 줄의 해시를 안고 쌓인다", () => {
    twoDecisions();

    const rows = ledger();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].prev, "genesis");
    assert.match(rows[1].prev!, /^sha256:/);
  });

  test("줄을 고치면 읽기를 거부한다", () => {
    twoDecisions();

    // 첫 줄의 승인자를 바꿔 치운다. 뒤 줄이 그 줄의 해시를 안고 있어 사슬이 끊긴다.
    const lines = readFileSync(ledgerFile(), "utf-8").trim().split("\n");
    lines[0] = lines[0].replace('"팀장"', '"내가나를"');
    writeFileSync(ledgerFile(), `${lines.join("\n")}\n`, "utf-8");

    assert.throws(() => ledger(), LedgerTamperError);
    // 읽기를 지나는 모든 길이 같은 예외를 밖으로 던진다 — 조용히 넘기는 자리가 없어야 한다.
    assert.throws(() => checkApproval(repo, ORDER, PLAN, TARGET), /나중에 고쳐졌습니다/);
  });

  test("autocrlf 체크아웃이 붙인 CR 은 고친 것이 아니다", () => {
    twoDecisions();
    writeFileSync(ledgerFile(), readFileSync(ledgerFile(), "utf-8").replace(/\n/g, "\r\n"), "utf-8");
    assert.equal(ledger().length, 2);
  });

  test("손으로 승인 줄을 끼워 넣으면 드러난다", () => {
    decide();

    // 관측을 통과한 것처럼 꾸민 줄. 내용은 그럴듯하지만 사슬이 맞지 않는다.
    const forged = JSON.stringify({
      ...ledger()[0],
      approver: "내가나를",
      presence: AT_TERMINAL,
      prev: "sha256:0000000000000000",
    });
    writeFileSync(ledgerFile(), `${readFileSync(ledgerFile(), "utf-8")}${forged}\n`, "utf-8");

    assert.throws(() => ledger(), /사슬이 끊겼습니다/);
  });

  test("끊긴 사슬 위에는 새 판정을 얹지 않는다 — 끊긴 자리가 가려지기 때문", () => {
    decide();
    writeFileSync(
      ledgerFile(),
      readFileSync(ledgerFile(), "utf-8").replace('"genesis"', '"sha256:deadbeefdeadbeef"'),
      "utf-8",
    );

    assert.throws(() => decide(), LedgerTamperError);
  });

  test("사슬 이전에 쌓인 원장은 그대로 읽힌다", () => {
    // 예전 원장을 못 읽게 만드는 것은 이 검사가 막으려던 것보다 나쁘다.
    const legacy = {
      id: "TEST-1",
      target: TARGET,
      kind: "feature",
      orderHash: "sha256:1111111111111111",
      planHash: "sha256:2222222222222222",
      decision: "approved",
      approver: "팀장",
      at: "2026-01-01T00:00:00.000Z",
      snapshot: ".code-agent/approvals/TEST-1/shipment-1.plan.json",
    };
    mkdirSync(join(repo, ".code-agent", "approvals"), { recursive: true });
    writeFileSync(ledgerFile(), `${JSON.stringify(legacy)}\n`, "utf-8");

    const rows = ledger();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].prev, undefined);
    assert.equal(rows[0].presence, undefined, "관측 기록이 없으면 없는 것으로 읽는다");
    assert.equal(rows[0].stage, undefined, "계획 승인 줄로 읽힌다");
  });
});

describe("diff — 문구 하나와 파일 하나가 같은 무게로 보이면 안 된다", () => {
  test("절마다 항목 단위로 비교한다", () => {
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

  test("순서만 바뀐 것은 변경이 아니다", () => {
    const two: BuildPlan = {
      ...PLAN,
      files: [
        { stage: "model", path: "a.py", purpose: "가" },
        { stage: "model", path: "b.py", purpose: "나" },
      ],
    };
    const flipped: BuildPlan = { ...two, files: [two.files[1], two.files[0]] };

    assert.deepEqual(diffPlans(two, flipped), []);
  });
});
