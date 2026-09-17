/**
 * 4차 게이트 — 단계 산출물 확정.
 *
 * 검수(`gate`)는 모델이 하고, 위반이 남아도 두 번 시도한 뒤에는 넘어간다. 그 끝에서
 * **"이걸 근거로 삼겠다"고 말하는 주체가 사람이 아니면**, 이후 단계 전부가 아무도 확정한 적
 * 없는 문서 위에 올라간다. 여기서 판정되는 것은 그 자리가 실제로 멈추는가다.
 *
 * 모델 검수를 끄고(`gate: false`) 돈다 — 확정은 검수와 무관하게 걸려야 하고, 검수를 끄면
 * "사람이 판정하는 자리"만 남아 무엇이 막는지가 분명해진다.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { readLedger } from "../core/approval";
import { loadSession } from "../core/session";
import { applyResponse, decideApproval, nextPrompt } from "../core/turn";
import type { BuildContext } from "../core/types";

const MANIFEST = {
  language: "python",
  sourceExtensions: [".py"],
  domainBase: "app",
  domainRoots: [],
  conventions: [],
  referenceDomain: "orders",
  stages: [
    { key: "model", title: "모델", template: "01-model.md", exemplars: [], outputDirs: ["."] },
    { key: "service", title: "서비스", template: "02-service.md", exemplars: [], outputDirs: ["."] },
  ],
};

const PLAN = {
  domainName: "shipment",
  domainLabel: "배송",
  domainRoot: "",
  domainDirName: "shipment",
  files: [
    { stage: "model", path: "app/shipment/models.py", purpose: "배송 모델" },
    { stage: "service", path: "app/shipment/service.py", purpose: "배송 서비스" },
  ],
  conventions: [],
  conflicts: [],
  openQuestions: [] as string[],
  reasoning: "참조 도메인을 따랐다",
};

function writeAction(path: string, body: string): string {
  return ["### write " + path, "```", body, "```", "", "### done", ""].join("\n");
}

const MODEL = writeAction("app/shipment/models.py", "class Shipment:\n    id: int");
const SERVICE = writeAction("app/shipment/service.py", "def ship():\n    pass");

let root: string;
let context: BuildContext;

function lane(...parts: string[]): string {
  return join(root, "out", "TEST-1", "shipment", ...parts);
}

function decide(decision: "approved" | "rejected", comment?: string) {
  return decideApproval(context, decision, { approver: "팀장", target: "shipment", comment });
}

/** 계획 승인까지 끝내고 첫 단계 산출물을 만들어, 확정 대기에 세운다. */
async function reachConfirm(): Promise<void> {
  await applyResponse(context, JSON.stringify(PLAN));
  decide("approved");
  await applyResponse(context, MODEL);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-confirm-"));
  const write = (relative: string, content: string) => {
    const path = join(root, "repo", relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf-8");
  };

  write("app/orders/models.py", "class Order:\n    id: int\n");
  write("doc/templates/code-agent.json", JSON.stringify(MANIFEST, null, 2));
  write("doc/templates/01-model.md", "# [01] 모델\n");
  write("doc/templates/02-service.md", "# [02] 서비스\n");
  writeFileSync(
    join(root, "spec.md"),
    "---\nkind: feature\nid: TEST-1\ntitle: 배송 추가\ntarget: shipment\n---\n\n# 배송\n",
    "utf-8",
  );

  context = {
    specPaths: [join(root, "spec.md")],
    templatesDir: "doc/templates",
    repoRoot: join(root, "repo"),
    outDir: join(root, "out"),
    gate: false,
    maxRetries: 1,
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("확정 없이는 넘어가지 않는다", () => {
  test("단계가 끝나면 다음 단계가 아니라 확정 대기가 된다", async () => {
    await reachConfirm();

    const next = nextPrompt(context);

    assert.equal(next.label, "confirm:model");
    assert.equal(next.prompt, undefined, "확정은 사람이 하는 일이라 모델에 보낼 것이 없다");
    assert.match(next.message!, /단계 산출물을 확정해야 넘어갑니다/);
  });

  test("무엇을 확정하는지 파일 목록으로 보여 준다 — 목록 없이 묻는 판정은 형식이다", async () => {
    await reachConfirm();

    const message = nextPrompt(context).message!;

    assert.match(message, /app[\\/]shipment[\\/]models\.py/);
    assert.match(message, /\d+줄/, "몇 줄짜리인지까지 보여야 열어 볼지 판단할 수 있다");
  });

  test("확정 대기 중에 응답을 붙여넣어도 소비되지 않는다", async () => {
    await reachConfirm();

    const outcome = await applyResponse(context, SERVICE);

    assert.equal(outcome.advanced, false);
    assert.equal(outcome.execution, undefined, "다음 단계 산출물이 먼저 들어오지 않는다");
    assert.equal(loadSession(lane()).turn, 2, "소비하지 않은 응답은 턴으로 세지 않는다");
    assert.equal(nextPrompt(context).label, "confirm:model");
  });

  test("확정하면 다음 단계로 간다", async () => {
    await reachConfirm();

    decide("approved");

    assert.equal(nextPrompt(context).label, "service");
  });

  test("마지막 단계까지 확정해야 끝난다", async () => {
    await reachConfirm();
    decide("approved");
    await applyResponse(context, SERVICE);

    assert.equal(nextPrompt(context).label, "confirm:service");

    decide("approved");

    assert.equal(nextPrompt(context).label, "done");
  });
});

describe("반려하면 그 단계를 다시 돈다", () => {
  test("반려에는 사유가 필요하다", async () => {
    await reachConfirm();

    assert.throws(() => decide("rejected"), /사유/);
  });

  test("반려하면 같은 단계로 돌아가고 사유가 다음 프롬프트에 실린다", async () => {
    await reachConfirm();

    decide("rejected", "필드가 스펙과 다르다");

    const next = nextPrompt(context);
    assert.equal(next.label, "model");
    assert.match(next.prompt!, /필드가 스펙과 다르다/);
    assert.match(next.prompt!, /사람이 반려함/);
    assert.equal(loadSession(lane()).completedStages.includes("model"), false);
  });

  test("다시 만들면 확정을 또 물어본다 — 반려가 통과로 바뀌지 않는다", async () => {
    await reachConfirm();
    decide("rejected", "다시");

    await applyResponse(context, writeAction("app/shipment/models.py", "class Shipment:\n    code: str"));

    const next = nextPrompt(context);
    assert.equal(next.label, "confirm:model");
    assert.match(next.message!, /직전 판정: 반려/);
  });
});

describe("확정은 그때의 파일들에 대한 것이다", () => {
  test("확정한 뒤 산출물이 바뀌면 다시 물어본다", async () => {
    await reachConfirm();
    decide("approved");
    assert.equal(nextPrompt(context).label, "service");

    // 사람이 out/ 의 파일을 손봤다 — 확정한 그 파일이 아니게 됐다.
    writeFileSync(lane("app/shipment/models.py"), "class Shipment:\n    hacked = True\n", "utf-8");

    const next = nextPrompt(context);
    assert.equal(next.label, "confirm:model");
    assert.match(next.message!, /그 뒤 산출물이 바뀌었습니다/);
  });
});

describe("판정 기록", () => {
  test("확정도 같은 원장에 남는다 — 무엇을 확정했는지까지", async () => {
    await reachConfirm();

    decide("approved", "확인함");

    const rows = readLedger(context.repoRoot, "TEST-1");
    const confirmed = rows.filter((row) => row.stage === "model");
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].decision, "approved");
    assert.ok(confirmed[0].filesHash, "무엇을 확정했는지는 해시가 말한다");

    const snapshot = JSON.parse(readFileSync(join(context.repoRoot, confirmed[0].snapshot), "utf-8"));
    assert.deepEqual(snapshot.files, ["app/shipment/models.py"]);
  });

  test("단계 확정이 계획 판정으로 읽히지 않는다", async () => {
    // 회귀 위험: 두 판정이 같은 원장에 쌓이므로, 마지막 줄만 보면 단계 확정이 계획 승인으로
    // 읽힌다. 그러면 계획이 바뀌어도 2차 게이트가 그냥 통과한다.
    await reachConfirm();
    decide("approved");

    const planPath = lane(".plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({ ...PLAN, reasoning: "몰래 바꾼 계획" }, null, 2),
      "utf-8",
    );

    const next = nextPrompt(context);

    assert.equal(next.label, "approval");
    assert.match(next.message!, /계획이 바뀌어 직전 판정이 무효/);
  });
});
