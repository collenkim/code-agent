/**
 * 사람이 판정하는 게이트 — 계획 승인.
 *
 * 계획이 나왔다고 곧장 생성으로 가지 않는다. 사람이 승인한 뒤에야 넘어간다. 우회 옵션은
 * 만들지 않는다 — 급할 때 쓰라고 만든 옵션은 급할 때만 쓰이지 않는다.
 *
 * 승인은 "이 작업"이 아니라 **"이 계획, 이 지시서, 이 경계, 이 근거 문서"** 에 대한 것이다.
 * 그래서 해시가 넷이다 — 지시서(사람이 확정한 것) · 계획(무엇을 만들지) · 매니페스트(어디에
 * 만들 수 있고 무엇을 돌릴지) · 문서(무엇을 근거로 세운 계획인지). 하나라도 달라지면 승인은
 * 자동으로 무효가 된다. 이것이 없으면 *승인받고 다른 것을 만드는* 구멍이 그대로 열린다 —
 * 매니페스트 해시가 없던 동안은 승인을 받은 뒤 outputDirs 를 넓히는 것만으로 승인한 적 없는
 * 경계에 코드가 나갔다.
 *
 * 기록은 **대상 저장소 안**에 남긴다. 승인은 한 사람의 메모가 아니라 팀의 기록이라 버전
 * 관리되어야 하고, 다른 머신·다른 체크아웃에서도 같은 원장을 읽어야 하기 때문이다.
 *
 * 규격은 doc/requirement.md 의 "승인 기록" 절에 있다.
 */
import { createHash } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import type { Manifest } from "./manifest";
import type { BuildPlan } from "./types";
import { slug } from "./workOrder";
import type { WorkOrder } from "./workOrder";

/**
 * 원장은 커밋되어 다른 머신에서 읽힌다. 구분자를 "/" 로 고정하는 것은 그래서다 —
 * 플랫폼 구분자를 그대로 적으면 Windows 에서 남긴 스냅샷 경로를 다른 곳에서 못 연다.
 */
export const APPROVALS_DIR = ".code-agent/approvals";

export type Decision = "approved" | "rejected";

/**
 * 판정이 들어온 통로. **누가** 판정했는지가 아니라 **사람이 그 자리에 있었는지**를 가른다.
 *
 * `approver` 는 사람이 적어 넣는 문자열이라 아무것도 증명하지 않는다. 그래서 통로를 따로 남긴다 —
 * 통로는 사람이 고르는 것이 아니라 전송이 관측하는 것이다.
 */
export type PresenceChannel =
  /** 터미널에서 사람이 직접 확인 문구를 입력했다 */
  | "tty"
  /** Claude Code의 질문 도구에서 관찰한 명시적 선택 */
  | "claude-question"
  | "codex-prompt"
  /** 사람의 입력을 관측하지 못했다 — 스크립트·비대화형 셸·명시적 우회 */
  | "unattended";

/**
 * 사람 존재의 증거. **증명하는 것은 존재와 시점이고, 신원이 아니다.**
 *
 * 이 구분이 중요하다. 신원은 로컬 도구가 알 수 없고(커밋 서명·PR·티켓에 있다), 존재는
 * 관측할 수 있다 — 비대화형 셸에는 TTY 가 없기 때문이다. 모델이 Bash 로 명령을 돌릴 때
 * stdin 은 TTY 가 아니므로, 그 자리에서 `approve` 를 부르는 길이 막힌다.
 */
export interface Presence {
  channel: PresenceChannel;
  /** 사람의 입력이 실제로 관측됐는가. false 면 이것은 증거가 아니라 기록일 뿐이다 */
  verified: boolean;
  /** 무엇을 근거로 그렇게 판정했는지. 원장을 읽는 사람이 강도를 스스로 판단할 수 있게 */
  detail: string;
}

/** 원장 한 줄 = 승인 사건 하나. append 만 하고 고치지 않는다. */
export interface ApprovalRecord {
  id: string;
  /** 무엇에 대한 판정인가. 대상마다 따로 돌므로 같은 id 아래 대상 수만큼 줄이 쌓인다 */
  target: string;
  kind: string;
  orderHash: string;
  planHash: string;
  /**
   * 승인 시점의 경계·검증 선언. **예전 원장에는 없다** — 없으면 검사하지 않는다.
   * 예전 기록을 못 읽게 만드는 것은 이 검사가 막으려던 것보다 나쁘다.
   */
  manifestHash?: string;
  /**
   * 승인 시점에 확정돼 있던 프로젝트 필수 문서(아키텍처·컨벤션)의 해시. **예전 원장에는 없다** —
   * 없으면 검사하지 않는다. 승인은 "이 문서들을 근거로 한 이 계획"에 대한 것이다.
   */
  docsHash?: string;
  decision: Decision;
  approver: string;
  at: string;
  comment?: string;
  /**
   * 승인한 계획의 스냅샷 (저장소 루트 기준).
   * 해시만으로는 "무엇을 승인했나"를 나중에 확인할 수 없다.
   */
  snapshot: string;
  /**
   * **예전 원장에만 있다** — 지금은 쓰지 않는다.
   *
   * 단계 산출물 확정이 같은 원장에 쌓이던 시절의 단계 키다. 그 기능은 없어졌지만 이미
   * 쌓인 줄에는 남아 있고, `checkApproval` 과 `recordDecision` 이 `stage === undefined` 로
   * 계획 승인 줄만 고르는 필터를 계속 쓴다. 필드를 지우면 옛 원장을 읽을 때 타입이
   * 거짓말을 하고, 단계 확정 줄이 계획 승인으로 읽혀 계획 승인이 그냥 통과한다.
   */
  stage?: string;
  /** 예전 원장의 단계 확정 시점 산출물 해시. 위와 같은 이유로 타입에 남긴다 */
  filesHash?: string;
  /**
   * 이 판정이 들어온 통로. **예전 원장에는 없다** — 없으면 관측되지 않은 것으로 읽는다.
   */
  presence?: Presence;
  /**
   * 직전 줄의 해시. 원장을 사슬로 묶어 **나중에 고친 것이 드러나게** 한다.
   *
   * 이것이 막는 것은 위조가 아니라 *은폐* 다. 손으로 한 줄 끼워 넣거나 지운 과거를
   * 조용히 통과시킬 수 없게 된다 — 사슬이 끊기면 읽는 쪽이 거부한다.
   */
  prev?: string;
}

/** 첫 줄의 `prev`. 빈 원장과 잘려 나간 원장을 구분하려고 값을 둔다 */
export const LEDGER_GENESIS = "genesis";

/**
 * 원장이 나중에 고쳐졌다. **읽기를 거부한다.**
 *
 * 조용히 넘기면 사슬을 둔 이유가 사라진다 — 끊긴 사슬을 그냥 읽으면 그것은 사슬이 아니라
 * 장식이다. 되살리는 것은 사람의 일이고(git 으로 복원한다), 코드가 추측으로 이을 자리가 아니다.
 */
export class LedgerTamperError extends Error {
  constructor(readonly path: string, readonly line: number, detail: string) {
    super(
      `승인 원장이 나중에 고쳐졌습니다 — 읽지 않았습니다: ${path}\n` +
        `  ${line} 번째 줄에서 사슬이 끊겼습니다: ${detail}\n` +
        "원장은 append only 입니다. 줄을 고치거나 끼워 넣거나 지우면 이 검사가 걸립니다.\n" +
        "git 으로 원장을 복원하세요 — 코드가 추측으로 잇지 않습니다.",
    );
    this.name = "LedgerTamperError";
  }
}

// ---- 해시 ----

function sha(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 16)}`;
}

/** 키 순서가 바뀌었다고 승인이 무효가 되면 안 된다 — 정렬해서 담는다. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * 지시서 해시. 이것이 바뀌면 그 지시서의 **모든** 승인이 무효다 —
 * preserve 한 줄을 지우면 hook 의 경계 검사가 그냥 통과하므로, 계획보다 지시서 쪽이 더 위험하다.
 *
 * sourcePath 는 빼고 담는다. 문서를 옮겼다고 승인이 무효가 될 이유는 없다.
 */
export function hashWorkOrder(order: WorkOrder): string {
  const { sourcePath, ...rest } = order;
  return sha(canonical(rest));
}

/** 계획 해시. 범위는 계획 **전체**다 — 재승인 diff 가 그 부담을 흡수한다. */
export function hashPlan(plan: BuildPlan): string {
  return sha(canonical(plan));
}

/**
 * 매니페스트 해시 — **경계와 검증 선언만** 담는다.
 *
 * 계획은 "무엇을 만들지"를 말하지만 그것을 **어디에 만들 수 있고 무엇을 돌릴 수 있는지**는
 * 매니페스트가 정한다. 승인이 그것을 담지 않으면, 승인을 받은 뒤 `outputDirs` 를 넓히거나
 * `build` 명령을 바꾸는 것만으로 승인한 적 없는 경계로 코드가 나간다 — 이 파일이 막겠다고
 * 한 "승인받고 다른 것을 만드는" 구멍이 거기 그대로 있었다.
 *
 * 범위를 전부로 하지 않는 것은 의도다. `conventions`·`language`·템플릿 문구가 바뀔 때마다
 * 승인이 무효가 되면 재승인이 일상이 되고, 일상이 된 재승인은 통제가 아니라 잡음이다.
 * 여기 담는 것은 **사람이 승인할 때 본 경계**뿐이다.
 */
export function hashManifest(manifest: Manifest): string {
  return sha(
    canonical({
      stages: manifest.stages.map((stage) => ({
        key: stage.key,
        kind: stage.kind,
        kinds: stage.kinds,
        scope: stage.scope,
        base: stage.base,
        outputDirs: stage.outputDirs,
        expect: stage.expect,
        confirm: stage.confirm,
      })),
      build: manifest.build,
      test: manifest.test,
      // prepare 는 통합 검증이 실제로 무엇을 돌리는지를 바꾼다 — build·test 와 같은 부류다.
      // 빼 두면 승인 뒤에 준비 명령을 갈아 끼워 검증 내용을 바꿀 수 있다. 선언하지 않은
      // 매니페스트에서는 canonical 이 undefined 키를 떨구므로 기존 해시가 한 글자도 달라지지 않는다.
      prepare: manifest.prepare,
      commands: manifest.commands,
    }),
  );
}

// ---- 원장 ----

export function ledgerPath(repoRoot: string, id: string): string {
  return join(repoRoot, APPROVALS_DIR, `${slug(id)}.jsonl`);
}

/** 원장의 줄 원문. 사슬은 파싱된 객체가 아니라 **쓰인 바이트**에 걸린다 */
function ledgerLines(repoRoot: string, id: string): string[] {
  const path = ledgerPath(repoRoot, id);
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

/**
 * 원장을 읽으면서 사슬을 검사한다.
 *
 * `prev` 가 없는 줄은 사슬 도입 전에 쌓인 것이라 넘긴다 — 예전 원장을 못 읽게 만드는 것은
 * 이 검사가 막으려던 것보다 나쁘다. 다만 `prev` 를 가진 줄은 예외 없이 검사한다. 그래서
 * 새 줄이 하나라도 있으면 그 앞의 예전 줄까지 묶여 보호된다.
 */
export function readLedger(repoRoot: string, id: string): ApprovalRecord[] {
  const lines = ledgerLines(repoRoot, id);
  const records: ApprovalRecord[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    let record: ApprovalRecord;
    try {
      record = JSON.parse(lines[index]) as ApprovalRecord;
    } catch {
      throw new LedgerTamperError(ledgerPath(repoRoot, id), index + 1, "JSON 이 아닙니다");
    }

    if (record.prev !== undefined) {
      const expected = index === 0 ? LEDGER_GENESIS : sha(lines[index - 1]);
      if (record.prev !== expected) {
        throw new LedgerTamperError(
          ledgerPath(repoRoot, id),
          index + 1,
          `직전 줄의 해시가 ${expected} 여야 하는데 ${record.prev} 로 적혀 있습니다`,
        );
      }
    }
    records.push(record);
  }
  return records;
}

/**
 * 판정 한 줄을 사슬에 이어 붙인다. 두 게이트가 같은 함수를 지나므로 사슬이 갈리지 않는다.
 *
 * 붙이기 전에 원장을 **먼저 읽는다** — 이미 끊긴 사슬 위에 새 줄을 얹으면 끊긴 자리가
 * 영원히 가려진다.
 */
function appendRecord(repoRoot: string, id: string, record: ApprovalRecord): ApprovalRecord {
  readLedger(repoRoot, id);
  const lines = ledgerLines(repoRoot, id);
  const chained: ApprovalRecord = {
    ...record,
    prev: lines.length === 0 ? LEDGER_GENESIS : sha(lines[lines.length - 1]),
  };

  const path = ledgerPath(repoRoot, id);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(chained)}\n`, "utf-8");
  return chained;
}

function loadSnapshot(repoRoot: string, record: ApprovalRecord): BuildPlan | undefined {
  const path = join(repoRoot, record.snapshot);
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf-8")) as BuildPlan;
}

// ---- 지금 승인 상태가 어떤가 ----

export type ApprovalState =
  /** 아직 아무 판정도 없다 */
  | { status: "none" }
  | { status: "approved"; record: ApprovalRecord }
  /** 같은 계획이 반려됐다. 계획을 다시 세우기 전에는 풀리지 않는다 */
  | { status: "rejected"; record: ApprovalRecord }
  /** 계획이 바뀌었다 — 그 대상의 승인이 무효. 계획 승인부터 다시 */
  | { status: "stale-plan"; record: ApprovalRecord; diff: PlanDiffEntry[] }
  /** 지시서가 바뀌었다 — 그 지시서의 모든 승인이 무효. 지시서 검사부터 다시 */
  | { status: "stale-order"; record: ApprovalRecord }
  /** 경계·검증 선언이 바뀌었다 — 승인한 계획을 승인한 적 없는 규칙으로 만들게 된다 */
  | { status: "stale-manifest"; record: ApprovalRecord }
  /** 근거 문서가 바뀌었다 — 승인한 계획의 전제가 달라졌다 */
  | { status: "stale-docs"; record: ApprovalRecord }
  /**
   * 승인 줄은 있으나 **사람 존재가 관측되지 않았다.**
   *
   * 프로젝트가 `requireVerifiedApproval` 을 켠 경우에만 나온다. 기본값에서는 이 상태가
   * 생기지 않는다 — TTY 가 없는 자리에서 남긴 승인까지 조용히 막아 버리기 때문이다.
   */
  | { status: "unverified"; record: ApprovalRecord };

/**
 * 이 계획으로 생성 단계에 들어가도 되는가.
 *
 * 검사 순서가 곧 무효 규칙이다. 지시서를 먼저 보는 이유는, 지시서가 바뀌면 계획이 그대로여도
 * 승인이 무효이기 때문이다 — 그 반대는 성립하지 않는다.
 */
export interface ApprovalPolicy {
  /**
   * 지금 실행의 매니페스트. 주면 승인 시점의 경계·검증 선언과 대조한다.
   *
   * 넘기지 않으면 검사하지 않는다 — 호출자가 그것을 모르는 자리(예전 코드·테스트)를
   * 조용히 막지 않기 위해서다.
   */
  manifest?: Manifest;
  /**
   * 사람 존재가 관측된 승인만 게이트를 열게 할지. 프로젝트가 `code-agent.json` 에 선언한다.
   *
   * 기본값이 `false` 인 것은 의도다 — 켜는 순간 TTY 가 없는 자리(스크립트·비대화형 셸)의
   * 판정은 기록으로만 남고 게이트를 열지 못한다. 무엇을 잃는지 알고 켜는 선언이어야 한다.
   */
  requireVerifiedApproval?: boolean;
  /** 지금 확정된 필수 문서의 해시. 주면 승인 시점의 것과 대조한다 */
  docsHash?: string;
}

export function checkApproval(
  repoRoot: string,
  order: WorkOrder,
  plan: BuildPlan,
  target: string,
  policy: ApprovalPolicy = {},
): ApprovalState {
  // 같은 id 아래 대상 수만큼 줄이 쌓인다. 대상 A 의 승인이 B 의 승인일 수는 없다.
  // 단계 확정 줄은 걸러 낸다 — 섞으면 마지막 단계 확정이 계획 판정으로 읽혀,
  // 계획이 바뀌어도 계획 승인이 통과해 버린다.
  const rows = readLedger(repoRoot, order.id).filter(
    (row) => row.target === target && row.stage === undefined,
  );
  const record = rows[rows.length - 1];

  if (!record) {
    return { status: "none" };
  }
  if (record.orderHash !== hashWorkOrder(order)) {
    return { status: "stale-order", record };
  }
  // 지시서 다음이 경계다. 계획보다 앞인 이유는, 같은 계획이어도 경계가 달라지면
  // **만들어지는 곳**이 달라지기 때문이다 — 계획 diff 로는 그것이 보이지 않는다.
  if (
    policy.manifest &&
    record.manifestHash !== undefined &&
    record.manifestHash !== hashManifest(policy.manifest)
  ) {
    return { status: "stale-manifest", record };
  }
  if (policy.docsHash !== undefined && record.docsHash !== undefined && record.docsHash !== policy.docsHash) {
    return { status: "stale-docs", record };
  }
  if (record.planHash !== hashPlan(plan)) {
    const before = loadSnapshot(repoRoot, record);
    return { status: "stale-plan", record, diff: before ? diffPlans(before, plan) : [] };
  }
  if (record.decision === "rejected") {
    return { status: "rejected", record };
  }
  // 사람 존재 검사는 마지막이다. 지시서·계획이 이미 어긋났으면 그쪽이 먼저 풀려야 한다.
  if (policy.requireVerifiedApproval && record.presence?.verified !== true) {
    return { status: "unverified", record };
  }
  return { status: "approved", record };
}

// ---- 판정 기록 ----

export interface DecisionInput {
  order: WorkOrder;
  /** 지시서의 대상 중 이번에 판정하는 것 */
  target: string;
  plan: BuildPlan;
  /** 이 판정이 전제한 경계·검증 선언. 뒤에 바뀌면 승인이 무효가 된다 */
  manifest: Manifest;
  decision: Decision;
  approver: string;
  comment?: string;
  /** 전송이 관측한 사람 존재. 코어는 추측하지 않는다 — 관측하는 쪽이 넘긴다 */
  presence: Presence;
  /** 이 판정이 근거로 삼은 필수 문서의 해시 */
  docsHash?: string;
}

/**
 * 승인 기록은 대상 저장소 **안에** 남는다. 그러므로 그 저장소가 없으면 만들지 않고 멈춘다.
 *
 * recursive mkdir 은 오타 난 경로에도 트리를 통째로 만들어 버린다. 그러면 아무도 승인한 적
 * 없는 곳에 승인 기록이 생기고, 정작 승인했다고 믿은 저장소에는 아무것도 없다. 없는 경로를
 * 만들어 주는 편의보다, 어디에 남기려는지 사람이 다시 보게 하는 편이 낫다.
 */
function assertRepoExists(repoRoot: string): void {
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    throw new Error(
      `승인 기록을 남길 대상 저장소가 없습니다: ${repoRoot}\n` +
        "없는 경로에 디렉토리를 만들지 않고 멈췄습니다 — 경로 오타면 엉뚱한 곳에 승인 기록이 남습니다.\n" +
        "경로가 맞는지 확인하고, 맞다면 그 디렉토리를 먼저 만드세요.",
    );
  }
}

/**
 * 판정을 원장에 남긴다. 반려도 남긴다 — 반려는 지워야 할 실패가 아니라 가장 값진 기록이다.
 *
 * 이 파일은 신원을 증명하지 않는다. 자기가 자기를 승인할 수 있다. 규격이 보장하는 것은
 * "승인 없이는 진행되지 않는다"까지이고, 증명은 커밋·PR·티켓에 있다.
 */
export function recordDecision(repoRoot: string, input: DecisionInput): ApprovalRecord {
  assertRepoExists(repoRoot);

  const { order, plan, target } = input;
  const seq =
    readLedger(repoRoot, order.id).filter(
      (row) => row.target === target && row.stage === undefined,
    ).length + 1;
  const snapshot = `${APPROVALS_DIR}/${slug(order.id)}/${slug(target)}-${seq}.plan.json`;

  const snapshotPath = join(repoRoot, snapshot);
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify(plan, null, 2), "utf-8");

  const record: ApprovalRecord = {
    id: order.id,
    target,
    kind: order.kind,
    orderHash: hashWorkOrder(order),
    planHash: hashPlan(plan),
    manifestHash: hashManifest(input.manifest),
    ...(input.docsHash ? { docsHash: input.docsHash } : {}),
    decision: input.decision,
    approver: input.approver,
    at: new Date().toISOString(),
    ...(input.comment ? { comment: input.comment } : {}),
    snapshot,
    presence: input.presence,
  };

  return appendRecord(repoRoot, order.id, record);
}

// ---- 재승인 diff ----

export interface PlanDiffEntry {
  section: "도메인" | "파일" | "보존" | "규칙" | "충돌" | "질문" | "근거" | "작업 Task";
  change: "+" | "-" | "~";
  text: string;
}

/**
 * 승인이 무효가 되어도 계획 전체를 처음부터 다시 읽히지 않는다. 직전 판정본과의 차이만 낸다.
 *
 * 텍스트 diff 가 아니라 계획 구조의 **항목 비교**다. 문구만 바뀐 것과 파일이 늘어난 것이
 * 같은 무게로 보이면 안 된다.
 *
 * 문구가 통째로 바뀐 항목은 `-` 와 `+` 두 줄로 보인다. 어느 옛 항목이 어느 새 항목이 됐는지
 * 짝짓는 것은 추측이고, 승인 화면에 추측을 올리지는 않는다.
 */
export function diffPlans(before: BuildPlan, after: BuildPlan): PlanDiffEntry[] {
  const entries: PlanDiffEntry[] = [];

  const location = (plan: BuildPlan) =>
    `${plan.domainName} (${[plan.domainRoot, plan.domainDirName].filter(Boolean).join("/")})`;
  if (location(before) !== location(after)) {
    entries.push({
      section: "도메인",
      change: "~",
      text: `${location(before)} → ${location(after)}`,
    });
  }

  compare(
    entries,
    "파일",
    before.files,
    after.files,
    (file) => file.path,
    (file) => `${file.path} [${file.stage}] — ${file.purpose}`,
    (old, now) =>
      old.stage === now.stage && old.purpose === now.purpose
        ? undefined
        : `${old.path}: [${old.stage}] ${old.purpose} → [${now.stage}] ${now.purpose}`,
  );

  // 보존 조건은 고치는 작업의 본체다. 한 줄이 바뀌면 승인이 무효가 되고, 그 줄이 보여야 한다.
  compare(
    entries,
    "보존",
    before.preserve ?? [],
    after.preserve ?? [],
    (entry) => entry.item,
    (entry) => `${entry.item} → ${entry.how}`,
    (old, now) => (old.how === now.how ? undefined : `${old.item}: ${old.how} → ${now.how}`),
  );

  compare(
    entries,
    "규칙",
    before.conventions,
    after.conventions,
    (rule) => rule.rule,
    (rule) => `${rule.rule} (${rule.source})`,
    (old, now) =>
      old.source === now.source ? undefined : `${old.rule}: 근거 ${old.source} → ${now.source}`,
  );

  compare(
    entries,
    "충돌",
    before.conflicts,
    after.conflicts,
    (conflict) => conflict.topic,
    (conflict) => `${conflict.topic} — ${conflict.decision}`,
    (old, now) =>
      old.docSays === now.docSays && old.codeSays === now.codeSays && old.decision === now.decision
        ? undefined
        : `${old.topic}: ${old.decision} → ${now.decision}`,
  );

  compare(
    entries,
    "질문",
    before.openQuestions,
    after.openQuestions,
    (question) => question,
    (question) => question,
    () => undefined,
  );

  if (canonical(before.tasks ?? []) !== canonical(after.tasks ?? [])) {
    entries.push({ section: "작업 Task", change: "~", text: "파일 소유·의존성·완료 기준이 바뀌었습니다. 현재 작업 Task 표를 확인하세요." });
  }
  if (before.reasoning !== after.reasoning) {
    entries.push({ section: "근거", change: "~", text: `${before.reasoning} → ${after.reasoning}` });
  }

  return entries;
}

/** 키가 같은 것끼리 대조한다. 순서가 바뀐 것은 변경이 아니다. */
function compare<T>(
  entries: PlanDiffEntry[],
  section: PlanDiffEntry["section"],
  before: T[],
  after: T[],
  keyOf: (item: T) => string,
  describe: (item: T) => string,
  changed: (before: T, after: T) => string | undefined,
): void {
  const olds = new Map(before.map((item) => [keyOf(item), item]));
  const news = new Map(after.map((item) => [keyOf(item), item]));

  for (const [key, item] of olds) {
    const now = news.get(key);
    if (!now) {
      entries.push({ section, change: "-", text: describe(item) });
      continue;
    }
    const detail = changed(item, now);
    if (detail) {
      entries.push({ section, change: "~", text: detail });
    }
  }
  for (const [key, item] of news) {
    if (!olds.has(key)) {
      entries.push({ section, change: "+", text: describe(item) });
    }
  }
}

/** 승인 화면에 올릴 형태. 절이 같은 줄은 한 번만 이름을 단다. */
export function formatDiff(entries: PlanDiffEntry[]): string {
  if (entries.length === 0) {
    return "  (구조에는 차이가 없습니다 — 계획 파일이 바뀌었으므로 승인은 다시 받아야 합니다)";
  }
  let last = "";
  return entries
    .map((entry) => {
      const label = entry.section === last ? "    " : entry.section.padEnd(4, " ");
      last = entry.section;
      return `  ${label} ${entry.change} ${entry.text}`;
    })
    .join("\n");
}
