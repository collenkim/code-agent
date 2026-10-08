import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join, posix, relative } from "path";

import { hashManifest, hashPlan } from "../core/approval";
import { writeAtomic } from "../core/atomic";
import { readBlock, stripBlock, upsertBlock } from "./blocks";
import { otherHost, runtimeHost } from "./crossEnv";
import {
  attemptLabel, CROSS_ID, crossAttemptsOf, crossHintText, effectiveReviewer, FINDING_CLOSED, FINDING_OPEN, findingDetailHash,
  orphanView, pointHost, pointLabel, reviewerRunLabel, reviewerState, syncLegacyRound,
  type CrossAttempt, type ReviewerRun, type Waiver,
} from "./crossRecord";
import { planPaths, reviewRoundBudget, reviewRoundUsage, reviewRoundUsageOf, stageProblems, treeHashNow } from "./evidence";
import type { ReviewRoundUsage } from "./evidence";
import { reviewFile, workDocsDir } from "./layout";
import { acquireLock } from "./lock";
import { MAX_OUTPUT_ITEMS } from "./plugins/protocol";
import { callSlot, clamp } from "./plugins/run";
import {
  budgetOf, COUNTER_LABEL, crossBudgets, crossPointHint, crossPointState, failure, grantScope, guidance, LIMITS, limitOf, POLICIES,
  RetryRefused, TIMING,
} from "./retryPolicy";
import type { Budget, RetryGrant } from "./retryPolicy";
import { Stop } from "./stop";
import type { Work } from "./work";
import { selectedHosts } from "./hosts";
import { agentName } from "./hostText";

export { CROSS_ID, crossHintText, FINDING_CLOSED, FINDING_OPEN, reviewResultProblems } from "./crossRecord";

/**
 * ⑨ 09-review.md — 9 코드 리뷰.
 *
 * 독립 ca-reviewer가 지적을 판정하고 완료 hook이 실행·결과를 기록한다.
 * 회차의 기준 트리 해시는 코드가 정하며, 수정 뒤 재리뷰 없이 반영할 수 없다.
 *
 * 그래서 회차는 `.code-agent/work/<ID>/<대상>.review.json` 에 **코드만** 쓰고(hook 이 도구 쓰기를
 * 막는다). 회차 구역과 관찰된 지적 결과를 문서에 렌더하고 게이트에서 다시 대조한다.
 * 리뷰어 실행과 교차 시도는 회차마다 append-only 배열이다 — 완료된 회차의 결과는 같은 회차의 재호출·재실행이 바꾸지 못한다.
 * 모든 쓰기는 mutateReview(잠금 + 다시 읽기 + ⑨ 구역 재렌더)로 한다.
 */
export const REVIEW_DOC_FILE = "09-review.md";
export const REVIEW_BLOCK = "review";

export function reviewDocFile(id: string): string {
  return posix.join(workDocsDir(id), REVIEW_DOC_FILE);
}

/** 회차 하나 — 무엇 위에서 본 리뷰인가 */
export interface ReviewRound {
  round: number;
  at: string;
  /** 이 회차가 본 계획 파일들의 부분 트리 해시. 게이트가 보는 것은 **마지막 회차의 이 값**이다 */
  treeHash: string;
  baseCommit: string;
  planHash: string;
  manifestHash: string;
  /** 파생 사본(옛 필드) — 배열이 저장된 회차는 syncLegacyRound 가 reviewers 에서 다시 쓴다. 판정에 쓰지 않는다 */
  reviewer?: { sessionId: string; agentId: string; startedAt: string; completedAt?: string; result?: string };
  /** 파생 사본(옛 필드) — 두 호스트 설치 프로젝트의 교차 리뷰. 배열이 저장된 회차는 syncLegacyRound 가 crossAttempts 에서 다시 쓴다 */
  cross?: { host: string; model: string; startedAt: string; completedAt?: string; result?: string; error?: string; unavailable?: string };
  /** 리뷰어 실행 — append-only. 없으면 reviewer 에서 추정한다(crossRecord.reviewersOf) */
  reviewers?: ReviewerRun[];
  /** 교차 리뷰 시도 — append-only. 없으면 cross 에서 추정한다(crossRecord.crossAttemptsOf) */
  crossAttempts?: CrossAttempt[];
}

/** 동결을 실제로 푼 지적 — **코드가** 적는다. 쓴 뒤 그 줄을 지워도 게이트가 남는다 */
export interface UsedFinding {
  id: string;
  path: string;
  /** 어느 회차에서 썼는가 */
  round: number;
}

export interface ReviewLog {
  id: string;
  target: string;
  rounds: ReviewRound[];
  /** 이 계획·회차 묶음에서 테스트 동결을 푼 지적들. 회차가 stale 로 버려지면 함께 비워진다 */
  used?: UsedFinding[];
  /** 이 묶임의 리뷰 회차 기본 한도 — 첫 회차에 고정한다. 없는 옛 기록은 reviewRoundUsageOf 가 유예 1회를 준다 */
  limit?: number;
  /** 사람 허용(judgment retry-grant) — 묶임이 바뀌어 회차를 버리면 함께 버린다 */
  grants?: RetryGrant[];
  /** 사람 판단으로 기각한 지적(judgment waive-finding) — append-only. 묶임이 바뀌면(stale) 회차·used 와 함께 버린다 */
  waivers?: Waiver[];
}

/**
 * 리뷰 회차 한도 거부 — 판정은 reviewRoundUsageOf 하나이고, 문구는 check() 의 리뷰 회차 거부와 같은 limit-exceeded 안내다.
 * stale(묶임이 바뀌어 회차를 버린다)이면 거부하지 않는다.
 */
export function reviewLimitRefusal(usage: ReviewRoundUsage, reviewDoc: string): RetryRefused | undefined {
  if (usage.stale || usage.used < usage.limit) return undefined;
  return new RetryRefused(
    failure("limit-exceeded", "리뷰 회차 소진", { origin: "blocking-finding", counter: { key: "reviewRounds", used: usage.used, limit: usage.limit } }),
    guidance("limit-exceeded", { counterLabel: COUNTER_LABEL.reviewRounds, limit: usage.limit, originLabel: POLICIES["blocking-finding"].label, evidence: reviewDoc }),
  );
}

export function loadReview(repoRoot: string, id: string, target: string): ReviewLog | undefined {
  const path = reviewFile(repoRoot, id, target);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ReviewLog;
  } catch {
    // 읽을 수 없는 회차 기록은 기록이 아니다. 다시 열면 덮어쓰인다
    return undefined;
  }
}

/** 잠금 없이 그대로 저장한다 — 시험 픽스처용이다. 코드의 쓰기는 모두 mutateReview 를 쓴다 */
export function saveReview(repoRoot: string, log: ReviewLog): void {
  const path = reviewFile(repoRoot, log.id, log.target);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${JSON.stringify(log, null, 2)}\n`);
}

/**
 * review.json 의 모든 쓰기 — `<review.json>.lock` 잠금 안에서 **다시 읽고** update 를 부른다. update 가 log 를 돌려주면
 * 회차마다 옛 필드(파생 사본)를 다시 쓴 뒤 원자 저장하고, ⑨ 가 있으면(또는 skeleton 이면 뼈대로) 같은 잠금 안에서 document 를
 * 적용한 뒤 회차 구역을 다시 렌더한다. log 를 돌려주지 않으면 아무것도 쓰지 않는다. 다른 호스트 실행처럼 오래 걸리는 일은 이 안에서
 * 하지 않는다 — 그 사이 기록된 리뷰어 결과·`used`·교차 기록이 이 쓰기에 덮이지 않게 한다. update 가 던지면 아무것도 쓰지 않는다.
 */
export function mutateReview<T>(repoRoot: string, id: string, target: string,
  update: (log: ReviewLog | undefined) => { log?: ReviewLog; value: T },
  options: { hook?: boolean; document?: (text: string, log: ReviewLog) => string; skeleton?: boolean } = {}): T {
  const path = reviewFile(repoRoot, id, target);
  mkdirSync(dirname(path), { recursive: true });
  const release = acquireLock(`${path}.lock`, { waitMs: options.hook ? TIMING.hookLockWaitMs : TIMING.lockWaitMs, ageReclaim: true,
    label: "리뷰 기록", display: relative(repoRoot, `${path}.lock`).replace(/\\/g, "/") });
  try {
    const result = update(loadReview(repoRoot, id, target));
    const log = result.log;
    if (log) {
      for (const round of log.rounds) syncLegacyRound(round);
      writeAtomic(path, `${JSON.stringify(log, null, 2)}\n`);
      const doc = join(repoRoot, reviewDocFile(id));
      const exists = existsSync(doc);
      if (exists || options.skeleton) {
        let text = exists ? readFileSync(doc, "utf-8") : SKELETON(id);
        if (options.document) text = options.document(text, log);
        writeAtomic(doc, upsertBlock(text, REVIEW_BLOCK, renderRoundsBlock(log)));
      }
    }
    return result.value;
  } finally { release(); }
}

// ---- 지적 표 (독립 리뷰어가 판정하고 hook이 기록한다) ----

/**
 * 상태 칸은 열림 · 해결 둘뿐이고 **글자 그대로** 본다(FINDING_OPEN·FINDING_CLOSED).
 *
 * `/해결/.test(status)` 같은 부분 일치는 `미해결` · `해결 안 됨` 을 전부 닫힌 것으로 읽는다 —
 * 명시적으로 안 고쳤다고 적은 지적이 게이트를 지나가는 자리였다.
 */
function isClosed(status: string): boolean {
  return status.trim() === FINDING_CLOSED;
}

export type FindingScope = "계획 안" | "계획 밖";

export interface Finding {
  id: string;
  /** 모델이 적은 계획 파일 경로 */
  path: string;
  /** 모델이 적은 범위 */
  written: string;
  /** 코드가 계획과 대조해 정한 범위. 게이트는 이쪽만 믿는다 */
  scope: FindingScope;
  status: string;
  /** 지적 칸 원문 — 사람 판단의 대조(detailHash)에 쓴다 */
  detail: string;
}

/**
 * `| F1 | <경로> | 계획 안 | 열림 | <지적> |` 줄들.
 *
 * 코드 구역(회차 표) 밖에서만 읽고 첫 칸이 `F<번호>` 인 줄만 센다 — 회차 표와 섞이지 않게.
 * **범위는 모델이 적은 것을 믿지 않는다.** 계획 파일 목록과 대조해 코드가 정하고, 모델이 다르게
 * 적었으면 그것도 문제로 올린다 (사람이 읽는 문서가 사실과 달라지면 안 된다).
 */
export function parseFindings(text: string, planned: readonly string[], idPattern: RegExp = /^F\d+$/): Finding[] {
  const allowed = new Set(planned);
  return stripBlock(text, REVIEW_BLOCK)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 4 && idPattern.test(cells[0]))
    .map((cells) => ({
      id: cells[0],
      path: cells[1],
      written: cells[2],
      scope: (allowed.has(cells[1]) ? "계획 안" : "계획 밖") as FindingScope,
      status: cells[3],
      detail: cells[4] ?? "",
    }));
}

const FINDINGS_HEADING = "지적";
/** 교차 리뷰의 지적 절 — id 는 X<번호> */
export const CROSS_HEADING = "교차 지적";

/** `## 지적`(또는 지정한 절)의 본문 — 다음 `##` 까지. 절이 없으면 undefined */
export function findingsBody(text: string, heading: string = FINDINGS_HEADING): string | undefined {
  const lines = stripBlock(text, REVIEW_BLOCK).split("\n");
  const from = lines.findIndex((line) => new RegExp(`^##\\s*${heading}\\s*$`).test(line.trim()));
  if (from < 0) {
    return undefined;
  }
  const to = lines.findIndex((line, index) => index > from && /^##\s/.test(line));
  return lines.slice(from + 1, to < 0 ? lines.length : to).join("\n");
}

export function normalizeFindings(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
}

/** 유효한 리뷰어 결과(crossRecord.effectiveReviewer)가 문서의 `## 지적` 절과 같은가 */
function observedFindings(last: ReviewRound, text: string, planned: readonly string[]): boolean {
  const result = effectiveReviewer(last, planned)?.result;
  return result !== undefined && normalizeFindings(findingsBody(text) ?? "") === normalizeFindings(result);
}

/** 완료된 교차 리뷰 결과(첫 completed)가 문서의 `## 교차 지적` 절과 같은가 */
function observedCross(last: ReviewRound, text: string, planned: readonly string[], now = Date.now()): boolean {
  const result = (crossPointState(orphanView(crossAttemptsOf(last, planned), now)).completed as CrossAttempt | undefined)?.result;
  return result !== undefined && normalizeFindings(findingsBody(text, CROSS_HEADING) ?? "") === normalizeFindings(result);
}

/** 지적의 출처 — F 는 독립 리뷰, X 는 교차 리뷰 */
const sourceOf = (finding: { id: string }): Waiver["source"] => CROSS_ID.test(finding.id) ? "cross" : "reviewer";
/**
 * 사람 판단(waive-finding)이 이 회차의 이 지적에 적용되는가 — 출처·id·경로가 같고, 기록한 회차이거나
 * 범위 칸과 지적 칸(공백 차이 제외)까지 같을 때만. 새 회차에서 같은 번호가 다른 지적에 붙으면 이어지지 않는다.
 */
export function waived(log: ReviewLog | undefined, finding: Finding, round: number): boolean {
  const hash = findingDetailHash(finding.detail);
  return (log?.waivers ?? []).some((waiver) => waiver.source === sourceOf(finding) && waiver.id === finding.id && waiver.path === finding.path
    && (waiver.round === round || (waiver.scope === finding.written && waiver.detailHash === hash)));
}
/** 같은 출처·id·경로의 기각이 있지만 이 지적에는 적용되지 않을 때 그 기각 — 게이트 문구에 "다시 판단"을 붙인다 */
export function staleWaiver(log: ReviewLog | undefined, finding: Finding, round: number): Waiver | undefined {
  if (waived(log, finding, round)) return undefined;
  return (log?.waivers ?? []).filter((waiver) => waiver.source === sourceOf(finding) && waiver.id === finding.id && waiver.path === finding.path).at(-1);
}

/**
 * 두 호스트가 설치돼 있으면 교차 검증을 요구한다. 다른 호스트를 실행할 수 없으면 `review cross`·`planning cross` 가
 * 그 지점을 중지로 기록하고 게이트는 통과시킨다 — 두 호스트를 모두 쓸 수 있을 때만 교차 검증이 실제로 돈다.
 */
export function crossRequired(repoRoot: string): boolean {
  return selectedHosts(repoRoot).length > 1;
}

/**
 * `## 지적` 을 아예 안 쓰는 길을 닫는다 — 지적이 없으면 그 절 안에 `없음` 이라고 적게 한다.
 * 문서 전체에서 `없음` 을 찾으면 다른 절의 산문 한 줄이 이 검사를 대신 통과시킨다.
 */
function findingsSectionProblems(path: string, text: string, findings: Finding[]): string[] {
  const body = findingsBody(text);
  if (body === undefined) {
    return [`${path} 에 \`## ${FINDINGS_HEADING}\` 절이 없습니다 — ${agentName("ca-reviewer")} 의 지적을 그 절에 옮기세요`];
  }
  if (findings.length === 0 && !/^\s*[-*]?\s*없음\s*$/m.test(body)) {
    return [`${path} 에 지적이 없습니다 — 표에 적거나, 하나도 없으면 \`- 없음\` 이라고 쓰세요`];
  }
  return [];
}

// ---- 코드 구역 렌더 ----

const oneLine = (text: string, max = 200): string => text.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * ⑨ 의 코드 구역. 옛 기록(배열·사람 판단 없음)은 이전 판과 바이트가 같다 — 실행 기록 절은 저장된 배열에 재호출·실패·무시가
 * 있을 때만, 사람 판단 절은 기각·사람 중지가 있을 때만 붙는다.
 */
export function renderRoundsBlock(log: ReviewLog): string {
  const lines = [
    "## 회차",
    "",
    `<!-- 이 구역은 code-agent review 가 .code-agent/work/${log.id}/${log.target}.review.json 에서 렌더한다. 손으로 고치면 게이트가 거부한다. -->`,
    "",
    "| 회차 | 시각 | 기준 트리 해시 (계획 파일) |",
    "|---|---|---|",
    ...log.rounds.map((round) => `| ${round.round} | ${round.at} | ${round.treeHash} |`),
  ];
  const noteworthy = (round: ReviewRound) =>
    (round.reviewers !== undefined && (round.reviewers.length >= 2 || round.reviewers.some((run) => run.failure || run.ignored)))
    || (round.crossAttempts !== undefined && round.crossAttempts.length >= 2);
  if (log.rounds.some(noteworthy)) {
    lines.push("", "### 실행 기록", "");
    for (const round of log.rounds.filter((item) => item.reviewers !== undefined || item.crossAttempts !== undefined)) {
      const parts: string[] = [];
      if (round.reviewers) parts.push(`리뷰어: ${round.reviewers.length}회 호출 — ${round.reviewers.map(reviewerRunLabel).join(", ") || "없음"}`);
      if (round.crossAttempts?.length) parts.push(`교차(${pointHost(round.crossAttempts) ?? round.crossAttempts[0].host}): ${round.crossAttempts.map(attemptLabel).join(", ")}`);
      lines.push(`- ${round.round}회차 ${parts.join(" · ")}`);
    }
  }
  const stops = log.rounds.flatMap((round) => (round.crossAttempts ?? []).filter((attempt) => attempt.class === "cross-stop")
    .map((attempt) => ({ round: round.round, attempt })));
  if ((log.waivers ?? []).length || stops.length) {
    lines.push("", "### 사람 판단", "");
    for (const waiver of log.waivers ?? []) {
      lines.push(`- ${waiver.id} (${waiver.path}) ${waiver.verdict} — ${oneLine(waiver.reason)} · ${waiver.round}회차 · 동의 ${waiver.consent.slice(0, 8)}`);
    }
    for (const { round, attempt } of stops) {
      lines.push(`- ${round}회차 교차 리뷰 중지 — ${oneLine(attempt.detail ?? "")} · 동의 ${(attempt.consent ?? "").slice(0, 8)}`);
    }
  }
  return lines.join("\n");
}

const SKELETON = (id: string): string =>
  [
    `# ${id} 코드 리뷰`,
    "",
    "## 지적",
    "",
    "<!-- 독립 ca-reviewer의 완료 hook이 결과를 기록한다. 메인은 결과·상태를 대신 쓰지 않는다. -->",
    "<!-- 상태는 열림 · 해결 둘뿐이고 글자 그대로 본다. 계획 밖 경로는 모델이 닫을 수 없다 — 질문(questions.md) 또는 재계획이다. -->",
    "<!-- 계획 파일 칸은 저장소 기준 경로 그대로 — 백틱도 `:줄번호` 도 붙이지 않는다. 줄번호·근거는 지적 칸에 넣는다. -->",
    "",
    "| id | 계획 파일 | 범위 | 상태 | 지적 |",
    "|---|---|---|---|---|",
    "",
  ].join("\n");

// ---- code-agent review ----

/**
 * 회차를 연다. **검증이 지금 트리 위에서 전부 통과한 뒤에만** 열린다 —
 * 컴파일도 안 되는 코드를 리뷰한 회차는 아무것도 묶지 못한다.
 */
export function openRound(work: Work): string {
  const { repoRoot, active } = work;
  const blockers = [...new Set([...stageProblems(work, "check"), ...stageProblems(work, "test")])];
  if (blockers.length > 0) {
    throw new Stop(
      "검증이 지금 트리 위에서 통과하지 않아 리뷰 회차를 열지 않았습니다:\n" +
        blockers.map((problem) => `  - ${problem}`).join("\n") +
        "\ncode-agent check · test 부터 다시 돌리세요.",
    );
  }

  const treeHash = treeHashNow(work);
  const planHash = hashPlan(work.plan!);
  const manifestHash = hashManifest(work.manifest);
  const binding = { baseCommit: active.baseCommit!, planHash, manifestHash };
  /** stale → 같은 트리 거부 → 리뷰 회차 한도(C3). 잠금 밖에서 한 번, 잠금 안에서 다시 읽은 기록으로 한 번 더 한다 */
  const decide = (previous: ReviewLog | undefined) => {
    // 다른 계획·경계 위에서 난 회차를 이어 세면 "마지막 회차가 본 트리" 가 거짓말이 된다
    const stale = !previous || previous.rounds.some(
      (round) => round.baseCommit !== active.baseCommit || round.planHash !== planHash || round.manifestHash !== manifestHash,
    );
    const rounds = stale ? [] : previous!.rounds;
    const last = rounds[rounds.length - 1];
    if (last && last.treeHash === treeHash) {
      throw new Stop(
        `${last.round}회차가 이미 지금 트리를 보고 있습니다 — 고친 것이 없으면 새 회차를 열지 않습니다.\n` +
          `${agentName("ca-reviewer")}를 호출해 결과를 기록하세요. 고친 뒤에는 code-agent check부터 다시 돌리세요.`,
      );
    }
    // 리뷰 회차 한도는 같은 트리 거부 **뒤에** 본다 — 마지막 회차 트리에서 다시 부르면 맞는 안내는 "리뷰어를 호출하세요" 다
    const usage = reviewRoundUsageOf(previous, binding);
    const refusal = reviewLimitRefusal(usage, reviewDocFile(active.id));
    if (refusal) throw refusal;
    return { stale, rounds, usage };
  };
  decide(loadReview(repoRoot, active.id, active.target));

  const { round, log } = mutateReview(repoRoot, active.id, active.target, (previous) => {
    const { stale, rounds, usage } = decide(previous);
    const round: ReviewRound = {
      round: rounds.length + 1,
      at: new Date().toISOString(),
      treeHash,
      baseCommit: active.baseCommit!,
      planHash,
      manifestHash,
    };
    // 동결을 푼 기록·사람 허용·사람 판단도 회차와 한 묶음이다 — 회차를 버리면(다른 계획·경계) 그 기록도 함께 버린다.
    // 이전 기록의 다른 필드(교차 기록 등)는 버리지 않는다. 한도는 이 묶임의 첫 회차에 고정한다(옛 기록은 여기서 고정되며 유예가 끝난다)
    const limit = stale ? LIMITS.reviewRounds : (previous!.limit ?? usage.base);
    const log: ReviewLog = {
      ...(stale ? {} : previous!),
      id: active.id,
      target: active.target,
      rounds: [...rounds, round],
      used: stale ? [] : (previous!.used ?? []),
      limit,
      ...(stale ? { grants: [], waivers: [] } : {}),
    };
    return { log, value: { round, log } };
  }, { skeleton: true });

  // review.prefilter의 단서는 stdout에만 싣는다. 지적 표에는 독립 리뷰어가 확인한 결과만 기록한다.
  // 플러그인 기록은 .code-agent/log/plugins/에 남는다.
  const prefilter = callSlot(
    repoRoot,
    work.manifest,
    "review.prefilter",
    () => ({
      baseCommit: round.baseCommit,
      treeHash,
      files: planPaths(work),
      rules: (work.plan?.conventions ?? []).map((entry) => ({ source: entry.source, rule: entry.rule })),
    }),
    () => ({ suspects: [] }),
  );
  const suspects =
    prefilter.source === "plugin" && prefilter.output.suspects.length > 0
      ? [
          "",
          `## 의심 항목 (플러그인 ${prefilter.name} — 판정이 아니라 단서다. 지적은 ${agentName("ca-reviewer")} 가 낸 것만 ⑨ 에 적는다)`,
          // 개수와 길이를 여기서 묶는다 — 이 블록은 모델이 지시로 읽는 화면이다
          ...prefilter.output.suspects.slice(0, MAX_OUTPUT_ITEMS).map(
            (entry) =>
              `- ${clamp(entry.path)}${entry.line ? `:${entry.line}` : ""} — ${clamp(entry.note)}${entry.rule ? ` (${clamp(entry.rule)})` : ""}`,
          ),
        ]
      : [];

  return [
    `# code-agent review — ${active.id} · ${round.round}회차`,
    "",
    `- 기준 트리 해시: ${treeHash}`,
    `- 리뷰 대상 계획 파일 ${planPaths(work).length}개 (code-agent context 가 목록과 검증 증거를 준다)`,
    ...(prefilter.notice ? [`- ${prefilter.notice}`] : []),
    ...suspects,
    "",
    `${agentName("ca-reviewer")}를 호출하세요. hook이 실행·완료와 결과를 기록하고 ${reviewDocFile(active.id)} 의 지적 표를 자동으로 채웁니다.`,
    "| id | 계획 파일 | 범위 | 상태 | 지적 | — 지적이 없으면 `- 없음`.",
    `계획 안 지적은 고친 뒤 code-agent verify 로 check 부터 다시 돌고, 이 명령으로 다음 회차를 엽니다 (리뷰 회차 ${round.round}/${limitOf("reviewRounds", log.limit, log.grants ?? [], grantScope({ file: "review", key: "reviewRounds" }))}).`,
    "계획 밖 경로를 가리키는 지적은 모델이 닫을 수 없습니다 — 질문으로 묻고, 사용자가 범위 밖으로 확인하면 ca-answer 동의 judgment waive-finding 으로 기록하거나 계획을 고쳐 재승인받습니다.",
  ].join("\n");
}

/**
 * ⑨ 에 이 파일을 가리키는 **열린 계획 안 지적**이 있는가 — 테스트 동결의 두 번째 탈출구다.
 *
 * 리뷰어가 "이 테스트가 틀렸다"고 짚었는데 고칠 길이 재승인뿐이면, 맞는 지적 하나에 계획 전체가
 * 다시 승인 대기로 간다. 대신 **문서에 남긴 지적**이 열쇠다.
 *
 * 열쇠가 되려면 셋이 함께여야 한다 — ⑨ 는 작업 폴더 안이라 모델이 아무 때나 쓸 수 있기 때문이다.
 * ① **리뷰 스테이지**여야 하고(test 에서 미리 적어 두고 푸는 길을 닫는다), ② `code-agent review`
 * 가 연 **회차가 있어야** 하며(코드가 쓴 `review.json` 만이 회차의 근거다), ③ 푼 사실을 그 파일에
 * 적는다 — 쓴 뒤 표에서 줄을 지워도 `reviewProblems` 가 그것을 찾아 막는다. 남기지 못하면 풀지
 * 않는다: 흔적 없는 탈출구는 탈출구가 아니다. 사람 판단으로 기각한 지적은 열쇠가 되지 못한다.
 */
export function findingOpensFile(work: Work, path: string): boolean {
  const { repoRoot, active } = work;
  if (active.phase !== "review") {
    return false;
  }
  const log = loadReview(repoRoot, active.id, active.target);
  const last = log?.rounds[log.rounds.length - 1];
  if (!log || !last) {
    return false;
  }
  const full = join(repoRoot, reviewDocFile(active.id));
  if (!existsSync(full)) {
    return false;
  }
  if (last.baseCommit !== active.baseCommit || last.planHash !== hashPlan(work.plan!) ||
      last.manifestHash !== hashManifest(work.manifest)) return false;
  const text = readFileSync(full, "utf-8");
  const planned = planPaths(work);
  const primary = observedFindings(last, text, planned), cross = observedCross(last, text, planned);
  if (!primary && !cross) return false;
  // 리뷰 뒤 구현 파일을 먼저 고칠 수 있다. 지적은 이 계획·회차의 수정 권한이며,
  // 완료 게이트는 모든 수정 후 새 트리에서 독립 재검토를 요구한다.
  const finding = [...(primary ? parseFindings(text, planned) : []), ...(cross ? parseFindings(text, planned, CROSS_ID) : [])].find(
    (candidate) => candidate.path === path && candidate.scope === "계획 안" && candidate.written === candidate.scope && candidate.status === FINDING_OPEN
      && !waived(log, candidate, last.round),
  );
  if (!finding) {
    return false;
  }
  if ((log.used ?? []).some((entry) => entry.id === finding.id && entry.path === finding.path)) {
    return true;
  }
  try {
    return mutateReview(repoRoot, active.id, active.target, (current) => {
      const now = current?.rounds.at(-1);
      if (!current || !now || now.round !== last.round || now.treeHash !== last.treeHash) return { value: false };
      const used = current.used ?? [];
      if (used.some((entry) => entry.id === finding.id && entry.path === finding.path)) return { value: true };
      current.used = [...used, { id: finding.id, path: finding.path, round: last.round }];
      return { log: current, value: true };
    }, { hook: true });
  } catch {
    return false;
  }
}

// ---- 게이트 (review → integrate) ----

const clock = (at: string): string => new Date(at).toTimeString().slice(0, 5);
const REVIEWER_ORPHAN_MIN = Math.round(TIMING.reviewerOrphanMs / 60_000);
const JUDGMENT_TAIL = " — 기록된 결과라 고칠 수 없습니다. 새 회차에서 리뷰어가 바로잡게 하거나 사용자 판단을 ca-answer 동의 judgment waive-finding 으로 기록하세요";

/**
 * 리뷰를 마쳤다고 할 수 있는가.
 *
 * 실제 강제력은 **마지막 회차의 트리 해시 == 지금**이다. 나머지는 그 위에 선다 —
 * 열린 지적이 남아 있으면 안 되고, 계획 밖을 가리키는 지적은 모델이 닫을 수 없다(사람 판단으로 기록한 것은 세지 않는다).
 */
export function reviewProblems(work: Work): string[] {
  const { repoRoot, active } = work;
  const path = reviewDocFile(active.id);
  const log = loadReview(repoRoot, active.id, active.target);
  const last = log?.rounds[log.rounds.length - 1];
  if (!last) {
    return [`리뷰 회차가 없습니다 — code-agent review 로 회차를 열고 ${path} 에 지적을 적으세요`];
  }

  const problems: string[] = [];
  if (last.baseCommit !== active.baseCommit || last.manifestHash !== hashManifest(work.manifest)) {
    problems.push("리뷰 회차가 지금 기준 커밋·경계 선언 위의 것이 아닙니다 — code-agent review 로 다시 여세요");
  }
  if (work.plan && last.planHash !== hashPlan(work.plan)) {
    problems.push("리뷰 뒤 계획이 바뀌었습니다 — 재승인된 계획 위에서 다시 리뷰해야 합니다");
  }
  if (last.treeHash !== treeHashNow(work)) {
    problems.push(
      `${last.round}회차 뒤 계획 파일이 바뀌었습니다 — 리뷰는 그 트리에 묶입니다. ` +
        "code-agent check · test 를 다시 돌리고 code-agent review 로 회차를 여세요",
    );
  }

  const planned = planPaths(work);
  const now = Date.now();
  const grants = log!.grants ?? [];
  const full = join(repoRoot, path);
  const text = existsSync(full) ? readFileSync(full, "utf-8") : "";
  const reviewer = reviewerState(last, planned, now);
  if (!reviewer.effective) {
    const limit = limitOf("reviewerRuns", LIMITS.reviewerRuns, grants, grantScope({ file: "review", key: "reviewerRuns", round: last.round }));
    const left = Math.max(0, limit - reviewer.runs);
    const failed = `형식 오류 ${reviewer.failures - reviewer.hookFailures}회${reviewer.hookFailures ? ` · hook 판정 실패 ${reviewer.hookFailures}회` : ""}`;
    const exhausted = `리뷰어 호출 한도 ${limit}회를 모두 썼습니다(${failed}) — 사용자에게 보고하고 사람 판단(ca-answer 동의 judgment retry-grant reviewerRuns)을 받으세요.`;
    if (reviewer.running && !reviewer.orphanable) {
      problems.push(`독립 리뷰어가 실행 중입니다(${clock(reviewer.running.startedAt)} 시작) — 완료를 기다리세요.` +
        (left > 0 ? ` 사용자가 중단해 멈춘 실행이면 시작 ${REVIEWER_ORPHAN_MIN}분 뒤부터 ${agentName("ca-reviewer")} 를 새로 호출할 수 있습니다(이 회차 남은 호출 ${left}회).` : ""));
    } else if (reviewer.running) {
      problems.push(left > 0
        ? `독립 리뷰어 실행(${clock(reviewer.running.startedAt)} 시작)이 ${REVIEWER_ORPHAN_MIN}분 넘게 끝나지 않았습니다 — 멈춘 실행으로 보고 ${agentName("ca-reviewer")} 를 새로 호출하세요(남은 ${left}회). 그 실행의 뒤늦은 결과는 쓰지 않습니다.`
        : exhausted);
    } else if (reviewer.runs >= limit) {
      problems.push(exhausted);
    } else if (reviewer.invalid) {
      problems.push(`기록된 리뷰어 결과가 표 규칙(상태·범위·경로)에 맞지 않습니다: ${oneLine(reviewer.invalid.join(" · "), 120)} — ${agentName("ca-reviewer")} 를 새로 호출하세요(남은 ${left}회).`);
    } else if (reviewer.failures > 0) {
      problems.push(`독립 리뷰어의 완료 결과가 없습니다(${failed} 기록) — ${agentName("ca-reviewer")} 를 새로 호출하세요(이 회차 남은 호출 ${left}회).`);
    } else {
      problems.push(`독립 리뷰어 실행·완료 기록이 없습니다 — ${agentName("ca-reviewer")}를 호출하세요. hook 설치는 code-agent doctor로 확인합니다.`);
    }
  } else if (!observedFindings(last, text, planned)) {
    problems.push(`리뷰 문서의 ## 지적 이 관찰된 ${agentName("ca-reviewer")} 결과와 다릅니다 — 지적·상태를 임의로 바꾸지 말고 기록(review.json 의 ${last.round}회차 리뷰어 결과)대로 되돌리세요. 같은 회차는 다시 리뷰하지 않습니다.`);
  }
  if (readBlock(text, REVIEW_BLOCK) !== renderRoundsBlock(log!).trim()) {
    problems.push(`${path} 의 회차 구역이 기록과 다릅니다 — code-agent review 가 렌더하는 자리입니다`);
  }

  const cross = crossRequired(repoRoot);
  if (cross) {
    const attempts = orphanView(crossAttemptsOf(last, planned), now);
    const point = crossPointState(attempts);
    const host = pointHost(attempts) ?? (runtimeHost() ? otherHost(runtimeHost()!) : undefined);
    if (point.state === "completed") {
      if (!observedCross(last, text, planned, now)) {
        problems.push(`리뷰 문서의 ## ${CROSS_HEADING} 이 기록된 교차 리뷰 결과와 다릅니다 — 임의로 바꾸지 말고 기록(review.json 의 ${last.round}회차 교차 결과)대로 되돌리세요. 같은 회차는 다시 교차 리뷰하지 않습니다.`);
      }
    } else if (point.state === "stopped") {
      // 다른 호스트를 실행할 수 없었던(또는 사람이 중지를 결정한) 회차는 교차 리뷰 없이 진행한다 — 중지 사유는 회차 기록과 ⑨ 에 남는다
    } else if (point.state === "running") {
      problems.push(`교차 리뷰가 실행 중입니다(${point.running!.host}, ${clock(point.running!.startedAt)} 시작) — 끝난 뒤 다시 확인하세요.`);
    } else {
      const hint = crossPointHint({ attempts, grants, scope: grantScope({ file: "review", key: "crossPoint", round: last.round }),
        rawExists: (raw) => existsSync(join(repoRoot, raw)) });
      // 한도로 거부될 지점(limit-exceeded)에는 실행 명령을 앞세우지 않는다 — 그 명령은 거부되고, 남은 길은 사람 판단이다
      let line = hint?.class === "limit-exceeded"
        ? "두 호스트가 설치된 프로젝트라 교차 리뷰가 필요합니다"
        : `두 호스트가 설치된 프로젝트라 교차 리뷰가 필요합니다 — code-agent review cross --by ${host ?? "<다른 호스트>"} (실행할 수 없으면 중지로 기록되고 진행합니다)`;
      if (hint) {
        line += ` — 직전 실행: ${pointLabel(attempts)}: ${oneLine(point.lastFailure?.detail ?? hint.detail, 120)}. ${crossHintText(hint, { host: host ?? "다른 호스트", point: `리뷰 ${last.round}회차`, attempts })}`;
      }
      problems.push(line);
    }
  }
  const findings = [...parseFindings(text, planned), ...(cross ? parseFindings(text, planned, CROSS_ID) : [])];
  problems.push(...findingsSectionProblems(path, text, findings.filter((finding) => !CROSS_ID.test(finding.id))));
  const counted = findings.filter((finding) => !waived(log, finding, last.round));
  const open = counted.filter((finding) => !isClosed(finding.status));
  if (open.length > 0) {
    problems.push(`열린 지적: ${open.map((finding) => {
      const stale = staleWaiver(log, finding, last.round);
      return `${finding.id}(${finding.path})${stale ? ` (${stale.round}회차 사람 판단과 지적 내용이 다릅니다 — 다시 판단)` : ""}`;
    }).join(", ")} — 고친 뒤 code-agent check 부터 다시 돌아 새 회차에서 해결을 받고, 의견이 갈리면 사용자 판단을 ca-answer 동의 judgment waive-finding 으로 기록하세요`);
  }
  // `미해결` 처럼 둘 다 아닌 값은 조용히 열림으로 세지 않고 오타로 짚는다 — 사람이 읽는 문서다
  const unknown = counted.filter(
    (finding) => finding.status.trim() !== FINDING_OPEN && !isClosed(finding.status),
  );
  if (unknown.length > 0) {
    problems.push(
      `상태 칸은 ${FINDING_OPEN} · ${FINDING_CLOSED} 둘뿐입니다: ` +
        unknown.map((finding) => `${finding.id}(${finding.status || "빈 칸"})`).join(", ") + JUDGMENT_TAIL,
    );
  }
  // 동결을 푼 지적은 지울 수 없다 — 쓰고 지우면 커밋된 ⑨ 에 아무 흔적도 남지 않는다
  for (const entry of log!.used ?? []) {
    if (!findings.some((finding) => finding.id === entry.id && finding.path === entry.path)) {
      problems.push(
        `${entry.round}회차에서 ${entry.path} 의 테스트 동결을 푼 지적 ${entry.id} 이 표에 없습니다 — ` +
          "동결을 푼 지적은 지울 수 없습니다. 그 줄을 되살리고 상태를 적으세요",
      );
    }
  }
  const outside = counted.filter((finding) => finding.scope === "계획 밖");
  if (outside.length > 0) {
    problems.push(
      `계획 밖을 가리키는 지적: ${outside.map((finding) => `${finding.id}(${finding.path})`).join(", ")} — ` +
        "모델이 닫을 수 없습니다. 사용자가 범위 밖으로 확인하면 ca-answer 동의 judgment waive-finding 으로 기록하거나, 계획을 고쳐 재승인받으세요",
    );
  }
  const mislabeled = counted.filter((finding) => finding.written !== finding.scope);
  if (mislabeled.length > 0) {
    problems.push(
      `범위 칸이 계획과 다릅니다: ${mislabeled.map((finding) => `${finding.id}(${finding.written} → ${finding.scope})`).join(", ")}` + JUDGMENT_TAIL,
    );
  }
  return problems;
}

/** status 리뷰 줄의 꼬리 — 회차 사용·리뷰어 상태·교차 지점·사람 판단 수 */
export function reviewStatusTail(work: Work, log: ReviewLog, last: ReviewRound): string {
  const planned = planPaths(work), now = Date.now();
  const state = reviewerState(last, planned, now);
  const reviewer = state.effective ? "완료" : state.running ? "실행 중" : state.failures ? `형식 오류 ${state.failures}회` : "없음";
  const parts = [`회차 ${last.round}/${reviewRoundUsage(work).limit}`, `리뷰어 ${reviewer}`];
  if (crossRequired(work.repoRoot)) {
    const attempts = orphanView(crossAttemptsOf(last, planned), now);
    parts.push(`교차 ${attempts.length ? pointLabel(attempts) : "없음"}`);
  }
  if (log.waivers?.length) parts.push(`사람 판단 ${log.waivers.length}건`);
  return ` · ${parts.join(" · ")}`;
}

// ---- 사람 허용의 대상(C5 judgment retry-grant 가 읽는다) ----

export type ReviewBudget = Budget & { point: string; scope: string };
/**
 * review 단계의 카운터 예산 — 리뷰 회차(검증 예산과 같은 reviewRoundBudget — 통과 뒤 변경으로 연 검증 회차도 센다), 마지막 회차의 리뷰어 호출, 교차 지점 시도·설정 오류·형식 교정
 * (crossBudgets, 게이트 쪽 고아 보기). 한도를 **읽기만** 한다. 허용은 mutateReview 로 grants 에 append 한다(scope 는 행의 scope).
 */
export function reviewBudgets(work: Work): ReviewBudget[] {
  const { repoRoot, active } = work;
  const log = loadReview(repoRoot, active.id, active.target);
  // 리뷰 회차 행은 검증 예산과 같은 값이다(통과 뒤 변경으로 연 검증 회차도 센다 — reviewRoundBudget)
  const usage = reviewRoundBudget(work);
  const rows: ReviewBudget[] = [{ key: "reviewRounds", used: usage.used, limit: usage.limit, left: Math.max(0, usage.limit - usage.used),
    exhausted: usage.used >= usage.limit, point: "리뷰 회차", scope: grantScope({ file: "review", key: "reviewRounds" }) }];
  const last = log?.rounds.at(-1);
  if (!log || !last || usage.stale) return rows;
  const planned = planPaths(work), now = Date.now(), grants = log.grants ?? [];
  const runsScope = grantScope({ file: "review", key: "reviewerRuns", round: last.round });
  rows.push({ ...budgetOf("reviewerRuns", reviewerState(last, planned, now).runs, LIMITS.reviewerRuns, grants, runsScope), point: `리뷰 ${last.round}회차`, scope: runsScope });
  if (crossRequired(repoRoot)) {
    const crossScope = grantScope({ file: "review", key: "crossPoint", round: last.round });
    const budgets = crossBudgets(orphanView(crossAttemptsOf(last, planned), now), grants, crossScope);
    for (const key of ["crossPoint", "crossError", "crossFormat"] as const) rows.push({ ...budgets[key], point: `리뷰 ${last.round}회차 교차`, scope: crossScope });
  }
  return rows;
}
