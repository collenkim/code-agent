/**
 * 승인 위조 방지 — 원장이 무엇을 증명하고 무엇을 증명하지 못하는가.
 *
 * 여기서 판정되는 것은 셋이다.
 *
 * 1. **제시되지 않은 게이트에 판정을 남길 수 있는가.** 없으면 질문에 막힌 대상의 계획을
 *    미리 승인해 두는 길이 열린다 — 사람은 그 계획을 본 적이 없는데 승인은 있다.
 * 2. **사람이 그 자리에 있었는지 남는가.** `approver` 는 사람이 적는 문자열이라 아무것도
 *    증명하지 않는다. 통로는 전송이 관측하는 것이라 다르다.
 * 3. **나중에 고친 것이 드러나는가.** 원장이 평문이라 손으로 고칠 수 있다. 막을 수는 없으니
 *    드러나게 만든다 — 사슬이 끊기면 읽는 쪽이 거부한다.
 *
 * 증명되지 않는 것도 분명히 해 둔다: **신원이다.** 자기가 자기를 승인할 수 있다. 이 파일이
 * 넓히는 것은 "승인 없이는 진행되지 않는다"에서 "사람 없이는 승인되지 않는다"까지다.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { LedgerTamperError, ledgerPath, readLedger } from "../core/approval";
import type { ApprovalRecord, Presence } from "../core/approval";
import { questionsPath } from "../core/session";
import { savePlan } from "../core/state";
import { applyResponse, decideApproval, nextPrompt } from "../core/turn";
import type { BuildContext, BuildPlan } from "../core/types";

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

/** 터미널에서 확인 문구를 입력한 것과 같은 관측 결과 */
const AT_TERMINAL: Presence = {
  channel: "tty",
  verified: true,
  detail: "터미널에서 approve 입력",
};

let root: string;
let context: BuildContext;

function write(relative: string, content: string) {
  const path = join(root, "repo", relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

/** 매니페스트를 다시 쓴다 — 호출마다 다시 읽히므로 정책을 중간에 바꿀 수 있다 */
function useManifest(workOrder: Record<string, unknown> = {}) {
  write(
    "doc/templates/code-agent.json",
    JSON.stringify({ ...MANIFEST, workOrder }, null, 2),
  );
}

function lane(...parts: string[]): string {
  return join(root, "out", "TEST-1", "shipment", ...parts);
}

function ledger(): ApprovalRecord[] {
  return readLedger(join(root, "repo"), "TEST-1");
}

function ledgerFile(): string {
  return ledgerPath(join(root, "repo"), "TEST-1");
}

async function plan(changes: Partial<BuildPlan> = {}) {
  await applyResponse(context, JSON.stringify({ ...PLAN, ...changes }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-presence-"));
  write("app/features/orders/models.py", "from dataclasses import dataclass\n");
  write("doc/conventions.md", "# 컨벤션\n- dataclass 를 쓴다.\n");
  write("doc/templates/01-model.md", "# [01] 모델\n");
  useManifest();
  writeFileSync(
    join(root, "spec.md"),
    "---\nkind: feature\nid: TEST-1\ntitle: 배송 도메인 추가\ntarget: shipment\n---\n" +
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

describe("제시되지 않은 게이트에는 판정을 남기지 않는다", () => {
  test("질문에 막힌 대상의 계획을 미리 승인할 수 없다", async () => {
    // 질문 검사가 승인 검사보다 앞이므로, 이 대상은 승인 대기가 아니라 blocked 다.
    await plan({ openQuestions: ["상태값을 무엇으로 두나요?"] });
    assert.equal(nextPrompt(context).label, "blocked");

    assert.throws(
      () => decideApproval(context, "approved", { approver: "팀장", target: "shipment" }),
      /판정을 기다리지 않습니다/,
    );
    assert.equal(ledger().length, 0, "원장에 아무것도 닿지 않아야 한다");
  });

  test("계획이 아직 없으면 승인할 수 없다", async () => {
    // 이 자리는 계획을 읽는 단계에서 먼저 막힌다 — 어느 쪽이든 원장에 닿지 않는 것이 요점이다.
    assert.throws(
      () => decideApproval(context, "approved", { approver: "팀장", target: "shipment" }),
      /계획 파일이 없습니다/,
    );
    assert.equal(ledger().length, 0);
  });

  test("답을 채워 게이트가 제시되면 그때 승인된다", async () => {
    await plan({ openQuestions: ["상태값을 무엇으로 두나요?"] });
    const path = questionsPath(lane());
    writeFileSync(
      path,
      readFileSync(path, "utf-8").replace("(여기에 답을 적으세요)", "준비·배송중·완료"),
      "utf-8",
    );
    assert.equal(nextPrompt(context).label, "approval");

    decideApproval(context, "approved", { approver: "팀장", presence: AT_TERMINAL });

    assert.equal(ledger().length, 1);
    assert.equal(nextPrompt(context).label, "model");
  });

  test("이미 판정이 있는 자리는 다시 불러도 막지 않는다 — 멱등이다", async () => {
    await plan();
    decideApproval(context, "approved", { approver: "팀장", presence: AT_TERMINAL });
    const second = decideApproval(context, "approved", {
      approver: "팀장",
      target: "shipment",
      presence: AT_TERMINAL,
    });

    assert.equal(second.unchanged, true);
    assert.equal(ledger().length, 1);
  });
});

describe("사람이 그 자리에 있었는지 원장에 남는다", () => {
  test("관측한 통로와 근거가 함께 남는다", async () => {
    await plan();
    decideApproval(context, "approved", { approver: "팀장", presence: AT_TERMINAL });

    const [record] = ledger();
    assert.equal(record.presence?.channel, "tty");
    assert.equal(record.presence?.verified, true);
    assert.match(record.presence!.detail, /approve 입력/);
  });

  test("전송이 넘기지 않으면 '관측되지 않음' 으로 남는다 — 조용히 권한을 주지 않는다", async () => {
    await plan();
    decideApproval(context, "approved", { approver: "팀장" });

    const [record] = ledger();
    assert.equal(record.presence?.channel, "unattended");
    assert.equal(record.presence?.verified, false);
  });
});

describe("requireVerifiedApproval — 관측된 판정만 게이트를 연다", () => {
  test("기본값에서는 관측되지 않은 승인도 게이트를 연다", async () => {
    // 서버 화면으로 승인하는 팀의 길을 조용히 막지 않는다. 켜는 것은 선언이다.
    await plan();
    decideApproval(context, "approved", { approver: "팀장" });

    assert.equal(nextPrompt(context).label, "model");
  });

  test("켜면 관측되지 않은 승인은 게이트를 열지 않고, 이유를 말한다", async () => {
    useManifest({ requireVerifiedApproval: true });
    await plan();
    decideApproval(context, "approved", { approver: "팀장" });

    const next = nextPrompt(context);

    assert.equal(next.label, "approval", "승인 줄은 있으나 통과하지 못한다");
    assert.equal(next.prompt, undefined);
    assert.match(next.message!, /사람 존재가 관측되지 않았습니다/);
    assert.match(next.message!, /unattended/, "어느 통로였는지 보여야 한다");
    assert.match(next.message!, /터미널에서/, "무엇을 해야 하는지 말해야 한다");
  });

  test("켜도 터미널에서 관측된 승인은 게이트를 연다", async () => {
    useManifest({ requireVerifiedApproval: true });
    await plan();
    decideApproval(context, "approved", { approver: "팀장", presence: AT_TERMINAL });

    assert.equal(nextPrompt(context).label, "model");
  });

  test("관측되지 않은 승인 위에 관측된 승인을 얹으면 풀린다", async () => {
    useManifest({ requireVerifiedApproval: true });
    await plan();
    decideApproval(context, "approved", { approver: "팀장" });
    assert.equal(nextPrompt(context).label, "approval");

    // 같은 계획에 같은 판정이지만 통로가 다르다 — 멱등 단축로가 이것을 삼키면 안 된다.
    decideApproval(context, "approved", { approver: "팀장", presence: AT_TERMINAL });

    assert.equal(nextPrompt(context).label, "model");
    assert.equal(ledger().length, 2, "두 판정이 모두 사건으로 남는다");
  });
});

describe("원장 사슬 — 나중에 고친 것이 드러난다", () => {
  /** 판정 두 건을 쌓는다 — 계획을 고쳐 재승인 대기로 되돌리는 것이 실제 경로다 */
  async function twoDecisions() {
    await plan();
    decideApproval(context, "approved", { approver: "팀장", presence: AT_TERMINAL });
    savePlan(lane(), { ...PLAN, reasoning: "범위를 좁혀 다시 세웠다" });
    decideApproval(context, "approved", { approver: "팀장", presence: AT_TERMINAL });
  }

  test("새 줄은 직전 줄의 해시를 안고 쌓인다", async () => {
    await twoDecisions();

    const rows = ledger();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].prev, "genesis");
    assert.match(rows[1].prev!, /^sha256:/);
  });

  test("줄을 고치면 읽기를 거부한다", async () => {
    await twoDecisions();

    // 첫 줄의 승인자를 바꿔 치운다. 뒤 줄이 그 줄의 해시를 안고 있어 사슬이 끊긴다.
    const lines = readFileSync(ledgerFile(), "utf-8").trim().split("\n");
    lines[0] = lines[0].replace('"팀장"', '"내가나를"');
    writeFileSync(ledgerFile(), `${lines.join("\n")}\n`, "utf-8");

    assert.throws(() => ledger(), LedgerTamperError);
    assert.throws(() => nextPrompt(context), /나중에 고쳐졌습니다/);
  });

  test("손으로 승인 줄을 끼워 넣으면 드러난다", async () => {
    await plan();
    decideApproval(context, "approved", { approver: "팀장", presence: AT_TERMINAL });

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

  test("끊긴 사슬 위에는 새 판정을 얹지 않는다 — 끊긴 자리가 가려지기 때문", async () => {
    await plan();
    decideApproval(context, "approved", { approver: "팀장", presence: AT_TERMINAL });
    writeFileSync(
      ledgerFile(),
      readFileSync(ledgerFile(), "utf-8").replace('"genesis"', '"sha256:deadbeefdeadbeef"'),
      "utf-8",
    );

    assert.throws(
      () =>
        decideApproval(context, "approved", {
          approver: "팀장",
          target: "shipment",
          presence: AT_TERMINAL,
        }),
      LedgerTamperError,
    );
  });

  test("사슬 이전에 쌓인 원장은 그대로 읽힌다", async () => {
    // 예전 원장을 못 읽게 만드는 것은 이 검사가 막으려던 것보다 나쁘다.
    const legacy = {
      id: "TEST-1",
      target: "shipment",
      kind: "feature",
      orderHash: "sha256:1111111111111111",
      planHash: "sha256:2222222222222222",
      decision: "approved",
      approver: "팀장",
      at: "2026-01-01T00:00:00.000Z",
      snapshot: ".code-agent/approvals/TEST-1/shipment-1.plan.json",
    };
    mkdirSync(join(root, "repo", ".code-agent", "approvals"), { recursive: true });
    writeFileSync(ledgerFile(), `${JSON.stringify(legacy)}\n`, "utf-8");

    const rows = ledger();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].prev, undefined);
    assert.equal(rows[0].presence, undefined, "관측 기록이 없으면 없는 것으로 읽는다");
  });
});
