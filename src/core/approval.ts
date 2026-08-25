/**
 * 2차 게이트 — 계획 승인.
 *
 * 계획이 나왔다고 곧장 생성으로 가지 않는다. 사람이 승인한 뒤에야 넘어간다. 우회 옵션은
 * 만들지 않는다 — 급할 때 쓰라고 만든 옵션은 급할 때만 쓰이지 않는다.
 *
 * 승인은 "이 작업"이 아니라 **"이 계획, 이 지시서"** 에 대한 것이다. 그래서 해시가 둘이다.
 * 하나라도 달라지면 승인은 자동으로 무효가 된다. 이것이 없으면 *승인받고 다른 것을 만드는*
 * 구멍이 그대로 열린다.
 *
 * 기록은 **대상 저장소 안**에 남긴다. out/ 은 확인 후 지우는 staging 이라 승인 이력이 거기
 * 있으면 같이 사라지고, 승인은 팀의 기록이라 버전 관리되어야 한다. "대상 저장소는 건드리지
 * 않는다"의 의도된 예외다 — 그 약속은 생성물에 대한 것이고 이것은 통제 기록이다.
 *
 * 규격은 doc/work-order.md 의 "승인 기록" 절에 있다.
 */
import { createHash } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import type { BuildPlan } from "./types";
import { slug } from "./workOrder";
import type { WorkOrder } from "./workOrder";

/**
 * 원장은 커밋되어 다른 머신에서 읽힌다. 구분자를 "/" 로 고정하는 것은 그래서다 —
 * 플랫폼 구분자를 그대로 적으면 Windows 에서 남긴 스냅샷 경로를 다른 곳에서 못 연다.
 */
export const APPROVALS_DIR = ".code-agent/approvals";

export type Decision = "approved" | "rejected";

/** 원장 한 줄 = 승인 사건 하나. append 만 하고 고치지 않는다. */
export interface ApprovalRecord {
  id: string;
  /** 무엇에 대한 판정인가. 대상마다 따로 돌므로 같은 id 아래 대상 수만큼 줄이 쌓인다 */
  target: string;
  kind: string;
  orderHash: string;
  planHash: string;
  decision: Decision;
  approver: string;
  at: string;
  comment?: string;
  /** 승인 시점 계획 스냅샷 (저장소 루트 기준). 해시만으로는 diff 를 만들 수 없다 */
  snapshot: string;
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
 * preserve 한 줄을 지우면 3차 게이트가 그냥 통과하므로, 계획보다 지시서 쪽이 더 위험하다.
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

// ---- 원장 ----

export function ledgerPath(repoRoot: string, id: string): string {
  return join(repoRoot, APPROVALS_DIR, `${slug(id)}.jsonl`);
}

export function readLedger(repoRoot: string, id: string): ApprovalRecord[] {
  const path = ledgerPath(repoRoot, id);
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ApprovalRecord);
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
  /** 계획이 바뀌었다 — 그 대상의 승인이 무효. 2차부터 다시 */
  | { status: "stale-plan"; record: ApprovalRecord; diff: PlanDiffEntry[] }
  /** 지시서가 바뀌었다 — 그 지시서의 모든 승인이 무효. 0차부터 다시 */
  | { status: "stale-order"; record: ApprovalRecord };

/** 승인이 나지 않은 상태들. 이 중 하나면 생성 단계로 넘어가지 않는다 */
export type PendingApproval = Exclude<ApprovalState, { status: "approved" }>;

/**
 * 이 계획으로 생성 단계에 들어가도 되는가.
 *
 * 검사 순서가 곧 무효 규칙이다. 지시서를 먼저 보는 이유는, 지시서가 바뀌면 계획이 그대로여도
 * 승인이 무효이기 때문이다 — 그 반대는 성립하지 않는다.
 */
export function checkApproval(
  repoRoot: string,
  order: WorkOrder,
  plan: BuildPlan,
  target: string,
): ApprovalState {
  // 같은 id 아래 대상 수만큼 줄이 쌓인다. 대상 A 의 승인이 B 의 승인일 수는 없다.
  const rows = readLedger(repoRoot, order.id).filter((row) => row.target === target);
  const record = rows[rows.length - 1];

  if (!record) {
    return { status: "none" };
  }
  if (record.orderHash !== hashWorkOrder(order)) {
    return { status: "stale-order", record };
  }
  if (record.planHash !== hashPlan(plan)) {
    const before = loadSnapshot(repoRoot, record);
    return { status: "stale-plan", record, diff: before ? diffPlans(before, plan) : [] };
  }
  if (record.decision === "rejected") {
    return { status: "rejected", record };
  }
  return { status: "approved", record };
}

// ---- 판정 기록 ----

export interface DecisionInput {
  order: WorkOrder;
  /** 지시서의 대상 중 이번에 판정하는 것 */
  target: string;
  plan: BuildPlan;
  decision: Decision;
  approver: string;
  comment?: string;
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
  const seq = readLedger(repoRoot, order.id).filter((row) => row.target === target).length + 1;
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
    decision: input.decision,
    approver: input.approver,
    at: new Date().toISOString(),
    ...(input.comment ? { comment: input.comment } : {}),
    snapshot,
  };

  const path = ledgerPath(repoRoot, order.id);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
  return record;
}

// ---- 재승인 diff ----

export interface PlanDiffEntry {
  section: "도메인" | "파일" | "보존" | "규칙" | "충돌" | "질문" | "근거";
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
