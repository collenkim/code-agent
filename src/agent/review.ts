import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join, posix } from "path";

import { hashManifest, hashPlan } from "../core/approval";
import { writeAtomic } from "../core/atomic";
import { readBlock, stripBlock, upsertBlock } from "./blocks";
import { planPaths, stageProblems, treeHashNow } from "./evidence";
import { reviewFile, workDocsDir } from "./layout";
import { MAX_OUTPUT_ITEMS } from "./plugins/protocol";
import { callSlot, clamp } from "./plugins/run";
import { Stop } from "./stop";
import type { Work } from "./work";
import { selectedHosts } from "./hosts";

/**
 * ⑨ 09-review.md — 9 코드 리뷰.
 *
 * 독립 ca-reviewer가 지적을 판정하고 완료 hook이 실행·결과를 기록한다.
 * 회차의 기준 트리 해시는 코드가 정하며, 수정 뒤 재리뷰 없이 반영할 수 없다.
 *
 * 그래서 회차는 `.code-agent/work/<ID>/<대상>.review.json` 에 **코드만** 쓰고(hook 이 도구 쓰기를
 * 막는다). 회차 구역과 관찰된 지적 결과를 문서에 렌더하고 게이트에서 다시 대조한다.
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
  reviewer?: { sessionId: string; agentId: string; startedAt: string; completedAt?: string; result?: string };
  /** 두 호스트가 설치된 프로젝트의 교차 리뷰 — 다른 호스트를 CLI 가 직접 실행해 같은 트리를 독립 검토한 결과 */
  cross?: { host: string; model: string; startedAt: string; completedAt?: string; result?: string; error?: string; unavailable?: string };
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

export function saveReview(repoRoot: string, log: ReviewLog): void {
  const path = reviewFile(repoRoot, log.id, log.target);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${JSON.stringify(log, null, 2)}\n`);
}

// ---- 지적 표 (독립 리뷰어가 판정하고 hook이 기록한다) ----

/**
 * 상태 칸은 이 둘뿐이고 **글자 그대로** 본다.
 *
 * `/해결/.test(status)` 같은 부분 일치는 `미해결` · `해결 안 됨` 을 전부 닫힌 것으로 읽는다 —
 * 명시적으로 안 고쳤다고 적은 지적이 게이트를 지나가는 자리였다.
 */
export const FINDING_OPEN = "열림";
export const FINDING_CLOSED = "해결";

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
}

/**
 * `| F1 | <경로> | 계획 안 | 열림 | <지적> |` 줄들.
 *
 * 코드 구역(회차 표) 밖에서만 읽고 첫 칸이 `F<번호>` 인 줄만 센다 — 회차 표와 섞이지 않게.
 * **범위는 모델이 적은 것을 믿지 않는다.** 계획 파일 목록과 대조해 코드가 정하고, 모델이 다르게
 * 적었으면 그것도 문제로 올린다 (사람이 읽는 문서가 사실과 달라지면 안 된다).
 */
export function parseFindings(text: string, planned: string[], idPattern: RegExp = /^F\d+$/): Finding[] {
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
    }));
}

const FINDINGS_HEADING = "지적";
/** 교차 리뷰의 지적 절 — id 는 X<번호> */
export const CROSS_HEADING = "교차 지적";
export const CROSS_ID = /^X\d+$/;

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

function observedFindings(last: ReviewRound, text: string): boolean {
  return !!last.reviewer?.completedAt && last.reviewer.result !== undefined &&
    normalizeFindings(findingsBody(text) ?? "") === normalizeFindings(last.reviewer.result);
}

/** 교차 리뷰 결과가 문서의 `## 교차 지적` 절과 같은가 */
function observedCross(last: ReviewRound, text: string): boolean {
  return !!last.cross?.completedAt && last.cross.result !== undefined &&
    normalizeFindings(findingsBody(text, CROSS_HEADING) ?? "") === normalizeFindings(last.cross.result);
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
    return [`${path} 에 \`## ${FINDINGS_HEADING}\` 절이 없습니다 — ca-reviewer 의 지적을 그 절에 옮기세요`];
  }
  if (findings.length === 0 && !/^\s*[-*]?\s*없음\s*$/m.test(body)) {
    return [`${path} 에 지적이 없습니다 — 표에 적거나, 하나도 없으면 \`- 없음\` 이라고 쓰세요`];
  }
  return [];
}

// ---- 코드 구역 렌더 ----

export function renderRoundsBlock(log: ReviewLog): string {
  return [
    "## 회차",
    "",
    `<!-- 이 구역은 code-agent review 가 .code-agent/work/${log.id}/${log.target}.review.json 에서 렌더한다. 손으로 고치면 게이트가 거부한다. -->`,
    "",
    "| 회차 | 시각 | 기준 트리 해시 (계획 파일) |",
    "|---|---|---|",
    ...log.rounds.map((round) => `| ${round.round} | ${round.at} | ${round.treeHash} |`),
  ].join("\n");
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

/** 회차 기록을 문서의 코드 구역에 반영한다. 문서가 없으면 뼈대부터 만든다 */
function renderReviewDoc(work: Work, log: ReviewLog): void {
  const path = join(work.repoRoot, reviewDocFile(log.id));
  const text = existsSync(path) ? readFileSync(path, "utf-8") : SKELETON(log.id);
  writeAtomic(path, upsertBlock(text, REVIEW_BLOCK, renderRoundsBlock(log)));
}

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
  const previous = loadReview(repoRoot, active.id, active.target);
  // 다른 계획·경계 위에서 난 회차를 이어 세면 "마지막 회차가 본 트리" 가 거짓말이 된다
  const stale =
    !previous ||
    previous.rounds.some(
      (round) =>
        round.baseCommit !== active.baseCommit || round.planHash !== planHash || round.manifestHash !== manifestHash,
    );
  const rounds = stale ? [] : previous!.rounds;

  const last = rounds[rounds.length - 1];
  if (last && last.treeHash === treeHash) {
    throw new Stop(
      `${last.round}회차가 이미 지금 트리를 보고 있습니다 — 고친 것이 없으면 새 회차를 열지 않습니다.\n` +
        `ca-reviewer를 호출해 결과를 기록하세요. 고친 뒤에는 code-agent check부터 다시 돌리세요.`,
    );
  }

  const round: ReviewRound = {
    round: rounds.length + 1,
    at: new Date().toISOString(),
    treeHash,
    baseCommit: active.baseCommit!,
    planHash,
    manifestHash,
  };
  // 동결을 푼 기록도 회차와 한 묶음이다 — 회차를 버리면(다른 계획·경계) 그 기록도 함께 버린다
  const log: ReviewLog = {
    id: active.id,
    target: active.target,
    rounds: [...rounds, round],
    used: stale ? [] : (previous!.used ?? []),
  };
  saveReview(repoRoot, log);
  renderReviewDoc(work, log);

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
          `## 의심 항목 (플러그인 ${prefilter.name} — 판정이 아니라 단서다. 지적은 ca-reviewer 가 낸 것만 ⑨ 에 적는다)`,
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
    `ca-reviewer를 호출하세요. hook이 실행·완료와 결과를 기록하고 ${reviewDocFile(active.id)} 의 지적 표를 자동으로 채웁니다.`,
    "| id | 계획 파일 | 범위 | 상태 | 지적 | — 지적이 없으면 `- 없음`.",
    "계획 안 지적은 고친 뒤 code-agent check 부터 다시 돌고, 이 명령으로 다음 회차를 엽니다.",
    "계획 밖 경로를 가리키는 지적은 모델이 닫을 수 없습니다 — questions.md 로 묻거나 계획을 고쳐 재승인받습니다.",
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
 * 않는다: 흔적 없는 탈출구는 탈출구가 아니다.
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
  const primary = observedFindings(last, text), cross = observedCross(last, text);
  if (!primary && !cross) return false;
  // 리뷰 뒤 구현 파일을 먼저 고칠 수 있다. 지적은 이 계획·회차의 수정 권한이며,
  // 완료 게이트는 모든 수정 후 새 트리에서 독립 재검토를 요구한다.
  const finding = [...(primary ? parseFindings(text, planPaths(work)) : []), ...(cross ? parseFindings(text, planPaths(work), CROSS_ID) : [])].find(
    (candidate) => candidate.path === path && candidate.scope === "계획 안" && candidate.written === candidate.scope && candidate.status === FINDING_OPEN,
  );
  if (!finding) {
    return false;
  }
  const used = log.used ?? [];
  if (used.some((entry) => entry.id === finding.id && entry.path === finding.path)) {
    return true;
  }
  try {
    saveReview(repoRoot, { ...log, used: [...used, { id: finding.id, path: finding.path, round: last.round }] });
  } catch {
    return false;
  }
  return true;
}

// ---- 게이트 (review → integrate) ----

/**
 * 리뷰를 마쳤다고 할 수 있는가.
 *
 * 실제 강제력은 **마지막 회차의 트리 해시 == 지금**이다. 나머지는 그 위에 선다 —
 * 열린 지적이 남아 있으면 안 되고, 계획 밖을 가리키는 지적은 모델이 닫을 수 없다.
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

  const full = join(repoRoot, path);
  const text = existsSync(full) ? readFileSync(full, "utf-8") : "";
  if (!last.reviewer?.completedAt) {
    problems.push("독립 리뷰어 실행·완료 기록이 없습니다 — ca-reviewer를 호출하세요. hook 설치는 code-agent doctor로 확인합니다.");
  } else if (!observedFindings(last, text)) {
    problems.push("리뷰 문서가 관찰된 ca-reviewer 결과와 다릅니다 — 지적·상태를 임의로 바꾸지 말고 다시 리뷰하세요.");
  }
  if (readBlock(text, REVIEW_BLOCK) !== renderRoundsBlock(log!).trim()) {
    problems.push(`${path} 의 회차 구역이 기록과 다릅니다 — code-agent review 가 렌더하는 자리입니다`);
  }

  if (crossRequired(repoRoot)) {
    if (last.cross?.unavailable && !last.cross.completedAt) {
      // 다른 호스트를 실행할 수 없었던 회차는 교차 리뷰 없이 진행한다 — 중지 사유는 회차 기록과 ⑨ 에 남는다
    } else if (!last.cross?.completedAt) {
      problems.push(`두 호스트가 설치된 프로젝트라 교차 리뷰가 필요합니다 — code-agent review cross --by <다른 호스트> (실행할 수 없으면 중지로 기록되고 진행합니다)${last.cross?.error ? ` (직전 실행: ${last.cross.error})` : ""}`);
    } else if (!observedCross(last, text)) {
      problems.push(`리뷰 문서의 ## ${CROSS_HEADING} 이 기록된 교차 리뷰 결과와 다릅니다 — 임의로 바꾸지 말고 다시 교차 리뷰하세요.`);
    }
  }
  const findings = [...parseFindings(text, planPaths(work)), ...(crossRequired(repoRoot) ? parseFindings(text, planPaths(work), CROSS_ID) : [])];
  problems.push(...findingsSectionProblems(path, text, findings.filter((finding) => !CROSS_ID.test(finding.id))));
  const open = findings.filter((finding) => !isClosed(finding.status));
  if (open.length > 0) {
    problems.push(`열린 지적: ${open.map((finding) => `${finding.id}(${finding.path})`).join(", ")} — 고치고 상태를 ${FINDING_CLOSED} 로 바꾸세요`);
  }
  // `미해결` 처럼 둘 다 아닌 값은 조용히 열림으로 세지 않고 오타로 짚는다 — 사람이 읽는 문서다
  const unknown = findings.filter(
    (finding) => finding.status.trim() !== FINDING_OPEN && !isClosed(finding.status),
  );
  if (unknown.length > 0) {
    problems.push(
      `상태 칸은 ${FINDING_OPEN} · ${FINDING_CLOSED} 둘뿐입니다: ` +
        unknown.map((finding) => `${finding.id}(${finding.status || "빈 칸"})`).join(", "),
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
  const outside = findings.filter((finding) => finding.scope === "계획 밖");
  if (outside.length > 0) {
    problems.push(
      `계획 밖을 가리키는 지적: ${outside.map((finding) => `${finding.id}(${finding.path})`).join(", ")} — ` +
        "모델이 닫을 수 없습니다. 답을 받아 범위 밖임이 확인되면 그 줄을 지우고 새 회차를 열거나, 계획을 고쳐 재승인받으세요",
    );
  }
  const mislabeled = findings.filter((finding) => finding.written !== finding.scope);
  if (mislabeled.length > 0) {
    problems.push(
      `범위 칸이 계획과 다릅니다: ${mislabeled.map((finding) => `${finding.id}(${finding.written} → ${finding.scope})`).join(", ")}`,
    );
  }
  return problems;
}
