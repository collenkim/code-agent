import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, posix } from "path";

import { APPROVALS_DIR } from "../core/approval";
import { writeAtomic } from "../core/atomic";
import { slug } from "../core/workOrder";
import { blockCount, stripBlock, upsertBlock } from "./blocks";
import { loadEvidence, planPaths, runsOf, stageProblems, validationDocFile } from "./evidence";
import type { Evidence, VerifyPhase } from "./evidence";
import { applyEntry, existingEntry, knowledgePath, parseProposal, proposalFile, readKnowledge } from "./knowledge";
import { clearActive, questionsFile, STATE_DIR, workDocsDir } from "./layout";
import { unansweredQuestions } from "./questions";
import { loadReview, reviewDocFile, reviewProblems } from "./review";
import { Stop } from "./stop";
import { changedPaths } from "./tree";
import { askOnTerminal, confirmOnTerminal } from "./tty";
import type { Work } from "./work";
import {
  acceptanceCriteria,
  loadRequirements,
  parseTestCases,
  planDocFile,
  readWorkDoc,
} from "./workDocs";

/**
 * ⑩ 10-pr.md 와 11 반영 — **로컬 커밋까지**다.
 *
 * push · MR/PR 생성은 하지 않는다. git 호스트가 붙기 전에는 만들 자리가 없어 보류한 것이고,
 * 붙으면 그때 정한다 (2026-09-29 결정). 이 파일이 남기는 것은 PR 본문 그대로다.
 *
 * 문서는 구역으로 갈린다 — 추적표·변경 요약·검증은 코드가 렌더하고(`blocks.ts`), 요약·확인 방법·
 * 위험은 모델이 쓴다. 커밋을 **CLI 가 직접** 치는 이유는 하나다: 사람이 화면에서 읽은 트리와
 * 커밋된 트리 사이에 아무 일도 끼지 않게 하는 유일한 방법이기 때문이다.
 */
export const PR_DOC_FILE = "10-pr.md";
export const PR_BLOCK = "trace";

export function prDocFile(id: string): string {
  return posix.join(workDocsDir(id), PR_DOC_FILE);
}

/** 모델이 쓰는 구역 — 코드가 만들 수 없는 것만 남겼다 */
const PROSE_SECTIONS = ["요약", "확인 방법", "위험·되돌리기"];

/** 코드 구역이 렌더하는 제목들. 구역 **밖**에 같은 제목이 있으면 위조본이다 */
const CODE_SECTIONS = ["추적표", "검증", "변경 요약"];

// ---- 추적표 ----

export interface TraceRow {
  requirement: string;
  acceptance: string[];
  files: string[];
  cases: string[];
  /** 그 R 의 TC 가 어디서 확인됐는가 — ⑧ 의 증거 그대로 */
  verified: string[];
}

/**
 * R → AC → 파일 → TC → 검증. **전부 코드가 읽은 것**이라 모델이 지어낼 수 없다.
 * 빈 칸은 "어느 요구가 테스트도 검증도 없이 지나갔는가" 를 그 자리에서 드러낸다.
 */
export function traceRows(work: Work, evidence: Evidence | undefined): TraceRow[] {
  const { repoRoot, active } = work;
  const requirements = loadRequirements(repoRoot, active.id)?.keys ?? [];
  const functional = readWorkDoc(repoRoot, active.id, "04-functional");
  const acceptance = functional ? acceptanceCriteria(functional) : [];
  const spec = readWorkDoc(repoRoot, active.id, "07-test-spec");
  const cases = spec ? parseTestCases(spec) : [];
  const verified = new Map((evidence?.testCases ?? []).map((entry) => [entry.id, entry]));

  return requirements.map((requirement) => {
    const owned = acceptance.filter((ac) => ac.startsWith(`AC-${requirement}-`));
    const covering = cases.filter((entry) => entry.acceptance.some((ac) => owned.includes(ac)));
    return {
      requirement,
      acceptance: owned,
      files: (work.plan?.files ?? []).filter((file) => (file.requirements ?? []).includes(requirement)).map((file) => file.path),
      cases: covering.map((entry) => entry.id),
      verified: covering.map((entry) => {
        const found = verified.get(entry.id);
        return `${entry.id}: ${found ? found.source : "없음"}`;
      }),
    };
  });
}

function cell(values: string[]): string {
  return values.join("<br>") || "없음";
}

/** 코드 구역 — 추적표 · 검증 · 변경 요약. 다시 렌더해 바이트로 대조한다 */
export function renderTraceBlock(work: Work, evidence: Evidence | undefined): string {
  const { active } = work;
  const rows = traceRows(work, evidence);
  const lines = [
    "## 추적표",
    "",
    "<!-- 이 구역은 code-agent deliver 가 01·04·05·07·⑧ 에서 렌더한다. 손으로 고치면 다시 렌더되어 사라진다. -->",
    "",
    "| R | AC | 계획 파일 | TC | 검증 |",
    "|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.requirement} | ${cell(row.acceptance)} | ${cell(row.files)} | ${cell(row.cases)} | ${cell(row.verified)} |`),
    "",
    "## 검증",
    "",
  ];
  if (!evidence) {
    lines.push("- 검증 증거가 없습니다");
  } else {
    const review = loadReview(work.repoRoot, active.id, active.target);
    const last = review?.rounds[review.rounds.length - 1];
    lines.push(
      `- 기준 커밋: ${evidence.baseCommit}`,
      `- 계획 파일 부분 트리 해시: ${evidence.treeHash}`,
      `- planHash: ${evidence.planHash} · manifestHash: ${evidence.manifestHash}`,
      `- 고쳐 쓰기 회차: ${evidence.rounds}`,
      ...(evidence.repro
        ? [`- repro: ${evidence.repro.cases.join(", ")} · 테스트 트리 ${evidence.repro.testTreeHash} (${evidence.repro.at})`]
        : []),
      ...(["check", "test", "integrate"] as VerifyPhase[]).map(
        (phase) =>
          `- ${phase}: ${runsOf(evidence, phase).map((run) => `${run.kind}=${run.outcome}`).join(" · ") || "돌린 기록 없음"}`,
      ),
      `- 코드 리뷰: ${last ? `${last.round}회차 (기준 트리 ${last.treeHash})` : "회차 없음"} — ${reviewDocFile(active.id)}`,
      `- 자세한 것: ${validationDocFile(active.id)} · ${planDocFile(active.id)}`,
    );
  }

  lines.push("", "## 변경 요약", "");
  const changes = active.baseCommit ? changedPaths(work.repoRoot, active.baseCommit) : [];
  const label = { A: "추가", M: "수정", D: "삭제", R: "이름변경" } as const;
  for (const status of ["A", "M", "D", "R"] as const) {
    const paths = changes.filter((change) => change.status === status).map((change) => change.path);
    if (paths.length > 0) {
      lines.push(`- ${label[status]} ${paths.length}개`, ...paths.map((path) => `  - ${path}`));
    }
  }
  if (changes.length === 0) {
    lines.push("- 없음");
  }
  return lines.join("\n");
}

const SKELETON = (id: string): string =>
  [
    `# ${id} 변경 보고서 (PR 본문)`,
    "",
    "## 요약",
    "",
    "<!-- 무엇을 왜 바꿨는지 3~10줄. 파일 나열이 아니라 판단에 필요한 것만. -->",
    "",
    "## 확인 방법",
    "",
    "<!-- 리뷰어가 손으로 확인하는 절차 — 자동 검증이 덮지 못한 것 위주로. -->",
    "",
    "## 위험·되돌리기",
    "",
    "<!-- 남은 위험과 되돌리는 방법. 없으면 근거와 함께 '없음'. -->",
    "",
  ].join("\n");

/** 제목 아래 본문 — 주석과 빈 줄만 남았으면 안 쓴 것이다 */
function sectionFilled(text: string, heading: string): boolean {
  const lines = text.split("\n");
  const from = lines.findIndex((line) => line.replace(/\s/g, "") === `##${heading.replace(/\s/g, "")}`);
  if (from < 0) {
    return false;
  }
  const to = lines.findIndex((line, index) => index > from && /^##\s/.test(line));
  return lines
    .slice(from + 1, to < 0 ? lines.length : to)
    .some((line) => line.trim() !== "" && !line.trim().startsWith("<!--"));
}

// ---- 게이트 ----

/** 반영해도 되는가. 하나라도 걸리면 커밋하지 않는다 */
export function deliverProblems(work: Work, prText: string): string[] {
  const { repoRoot, active } = work;
  const problems = [
    ...new Set([
      ...stageProblems(work, "check"),
      ...stageProblems(work, "test"),
      ...stageProblems(work, "integrate"),
      ...reviewProblems(work),
    ]),
  ];
  const open = unansweredQuestions(repoRoot, questionsFile(active.id));
  if (open.length > 0) {
    problems.push(`답이 없는 질문이 ${open.length}개 있습니다 (${questionsFile(active.id)})`);
  }
  for (const row of traceRows(work, loadEvidence(repoRoot, active.id, active.target))) {
    const blank = [
      row.acceptance.length === 0 ? "AC" : "",
      row.files.length === 0 ? "계획 파일" : "",
      row.cases.length === 0 ? "TC" : "",
    ].filter(Boolean);
    if (blank.length > 0) {
      problems.push(`추적표의 ${row.requirement} 이 비어 있습니다: ${blank.join(", ")}`);
    }
    for (const entry of row.verified.filter((entry) => entry.endsWith("없음"))) {
      problems.push(`추적표의 ${row.requirement} — 확인되지 않은 테스트 케이스 ${entry.split(":")[0]}`);
    }
  }
  for (const heading of PROSE_SECTIONS.filter((heading) => !sectionFilled(prText, heading))) {
    problems.push(`${prDocFile(active.id)} 의 \`## ${heading}\` 이 비어 있습니다 — 모델이 쓰는 구역입니다`);
  }
  // 표시 없이 같은 제목의 표를 따로 써 두면 재렌더가 그것을 덮지 못하고 **아래에 덧붙는다** —
  // 화면에는 진짜가 보이는데 커밋되는 ⑩ 에는 지어낸 추적표가 함께 실린다. 커밋을 세운다.
  const outside = stripBlock(prText, PR_BLOCK);
  for (const heading of CODE_SECTIONS) {
    if (new RegExp(`^##\\s*${heading}\\s*$`, "m").test(outside)) {
      problems.push(
        `${prDocFile(active.id)} 의 \`## ${heading}\` 이 코드 구역 밖에 있습니다 — ` +
          "코드가 렌더하는 자리입니다. 그 절을 지우세요",
      );
    }
  }
  return problems;
}

// ---- KNOWLEDGE 갱신 ----

function selectKnowledge(work: Work): string[] {
  const { repoRoot, active, manifest } = work;
  const path = join(repoRoot, proposalFile(active.id));
  if (!existsSync(path)) {
    return [];
  }
  const keys = loadRequirements(repoRoot, active.id)?.keys ?? [];
  const { entries, skipped } = parseProposal(readFileSync(path, "utf-8"), keys);
  for (const reason of skipped) {
    process.stdout.write(`건너뜀: ${reason}\n`);
  }

  const pending = new Map<string, string>();
  for (const entry of entries) {
    const target = knowledgePath(manifest, entry.kind);
    const current = pending.get(target) ?? readKnowledge(repoRoot, manifest, entry.kind);
    const before = existingEntry(current, entry.key);
    // 같은 키에 다른 내용이 오면 조용히 덮지 않는다 — 양쪽을 나란히 보여 주고 사람이 고른다
    const shown = [
      `--- ${target} · \`${entry.key}\` (근거 ${entry.requirements.join(", ")})`,
      before ? `[지금]\n${before}\n` : "[지금] 없음 — 새 항목입니다\n",
      `[제안]\n${entry.text}`,
    ].join("\n");
    if (askOnTerminal(shown, "적용하려면 y") !== "y") {
      continue;
    }
    pending.set(target, applyEntry(current, entry));
  }
  for (const [target, text] of pending) {
    writeAtomic(join(repoRoot, target), text);
  }
  return [...pending.keys()];
}

// ---- 커밋 ----

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * 커밋 메시지는 지시서에서 결정론적으로 만든다 — 모델이 쓴 문장을 커밋 이력에 싣지 않는다.
 * 사람이 읽을 서사는 ⑩ 에 있고, 그 파일이 이 커밋 안에 함께 들어간다.
 */
function commitMessage(work: Work, evidence: Evidence): string {
  const { order, active } = work;
  const keys = loadRequirements(work.repoRoot, active.id)?.keys ?? [];
  return [
    `[${order.id}] ${order.title}`,
    "",
    `요구: ${keys.join(", ") || "없음"}`,
    `검증: ${(["check", "test", "integrate"] as VerifyPhase[])
      .map((phase) => `${phase}=${runsOf(evidence, phase).every((run) => run.outcome === "passed") ? "passed" : "?"}`)
      .join(" · ")} · 기준 커밋 ${evidence.baseCommit.slice(0, 12)} · 트리 ${evidence.treeHash.slice(-12)}`,
    `근거: ${prDocFile(active.id)} · ${validationDocFile(active.id)} · ${reviewDocFile(active.id)}`,
  ].join("\n");
}

/**
 * 검증된 변경 집합만 커밋한다 — `git add -A` 가 아니라 **경로를 명시해** 넘긴다.
 * 그래야 같은 트리에 있던 무관한 파일이 사람이 확인한 것 밖에서 따라 들어가지 않는다.
 * 증거(`.code-agent/work/<ID>/*.verify.json`·`review.json`)와 원장이 같은 커밋에 들어가 git 에 남는다.
 *
 * `.code-agent` 를 통째로 올리지 않는다 — 그러면 **다른 작업의** 증거·계획, 전 작업의 원장·스냅샷,
 * 도입 설정(`models.json`·`version`·`approvals/docs.jsonl`)까지 이 커밋에 따라 들어온다.
 * 이 반영이 남기는 것은 **이 작업의** 파일·증거·원장뿐이다.
 *
 * `add` 와 `commit` 이 **같은 경로 목록**을 든다 — 올리는 것만 제한하면 이미 인덱스에 있던 것이
 * 따라 들어와, 제한이 반쪽이 된다. `add` 는 그대로 둔다: 미추적 파일은 git 이 먼저 알아야 담긴다.
 */
export function commitDelivery(work: Work, evidence: Evidence, knowledge: string[]): string {
  const { repoRoot, active } = work;
  const mine = [
    // planFile·verifyFile·reviewFile 은 raw id 를 쓰고 원장·스냅샷은 slug(id) 를 쓴다 — 두 규칙을 각각 그대로
    `${STATE_DIR}/work/${active.id}`,
    `${APPROVALS_DIR}/${slug(active.id)}.jsonl`,
    `${APPROVALS_DIR}/${slug(active.id)}`,
  ];
  const paths = [...planPaths(work), workDocsDir(active.id), ...mine, ...knowledge]
    // 없는 pathspec 은 git add 가 fatal 로 세운다 — 판정 스냅샷 디렉토리는 승인 전에는 없다
    .filter((path) => existsSync(join(repoRoot, path)));
  git(repoRoot, ["add", "--", ...paths]);
  try {
    // 커밋도 **같은 경로 목록으로** 묶는다. `git add` 가 무엇을 올리는지만 정하면, 이미 인덱스에
    // 올라가 있던 것(사람이 터미널에서 친 git add · 앞서 실패한 deliver 가 남긴 스테이지)이
    // 이 커밋에 그대로 실려 간다 — 검증된 변경 집합만 커밋한다는 말이 그때 거짓이 된다.
    git(repoRoot, ["commit", "-m", commitMessage(work, evidence), "--", ...paths]);
  } catch (error) {
    // 스테이지는 이미 올라가 있다 — 사람이 git commit 만 다시 치면 된다
    throw new Stop(
      `git commit 이 실패했습니다 (변경은 스테이지에 올라가 있습니다): ${error instanceof Error ? error.message : error}`,
    );
  }
  return git(repoRoot, ["rev-parse", "HEAD"]);
}

// ---- code-agent deliver ----

/**
 * 11 반영. **사람이 별도 터미널에서만** 돌린다 (`confirmOnTerminal`) — 모델 세션 안의 확인은
 * 모델이 한 것과 구분되지 않는다. 화면을 그리기 직전에 게이트를 다시 돌려, 사람이 읽는 것과
 * 커밋되는 것 사이에 틈이 없게 한다.
 */
export function deliver(work: Work): string {
  const { repoRoot, active } = work;
  if (!active.baseCommit) {
    throw new Stop("기준 커밋이 굳혀져 있지 않아 반영할 수 없습니다 — code-agent abort 뒤 다시 시작하세요.");
  }
  const path = join(repoRoot, prDocFile(active.id));
  const text = existsSync(path) ? readFileSync(path, "utf-8") : SKELETON(active.id);

  // 코드 구역을 먼저 갈아 끼운다. 손으로 고쳐져 있었으면 그 사실을 확인 화면에 그대로 싣는다.
  // 구역 안쪽만 보지 않고 **파일 전체의 바이트**로 본다 — 표시를 한 짝 더 붙여 놓으면 안쪽
  // 대조는 첫 짝만 보고 지나가고 둘째 짝이 위조본을 커밋까지 실어 나른다.
  const evidence = loadEvidence(repoRoot, active.id, active.target);
  const block = renderTraceBlock(work, evidence);
  const had = blockCount(text, PR_BLOCK);
  const rendered = upsertBlock(text, PR_BLOCK, block);
  const tampered = had > 0 && rendered !== text;
  writeAtomic(path, rendered);

  const problems = deliverProblems(work, rendered);
  if (problems.length > 0) {
    throw new Stop(
      `반영할 수 없습니다 (커밋하지 않았습니다). ${prDocFile(active.id)} 는 렌더했습니다:\n` +
        problems.map((problem) => `  - ${problem}`).join("\n"),
    );
  }

  // 커밋이 이 반영의 유일한 기록이다 (원장에는 계획 승인만 쌓인다). 사람이 다른 터미널에서
  // 돌리는 명령이라 그 창이 다른 브랜치에 서 있을 수 있는데, 화면은 작업 브랜치라고 말한다 —
  // 그대로 두면 확인한 것과 커밋된 자리가 갈린다.
  if (active.branch) {
    const head = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (head !== active.branch) {
      throw new Stop(
        `작업 브랜치가 아닙니다 (지금 ${head}, 작업 브랜치 ${active.branch}) — 커밋하지 않았습니다.\n` +
          `git switch ${active.branch} 로 옮긴 뒤 다시 실행하세요. 커밋이 이 반영의 유일한 기록입니다.`,
      );
    }
  }

  const shown = [
    `# ${active.id} 반영 — ${work.order.title}`,
    "",
    `브랜치 ${active.branch ?? "(없음)"} 에 **로컬 커밋**합니다. push · MR/PR 생성은 하지 않습니다.`,
    ...(tampered ? ["", `!! ${prDocFile(active.id)} 의 코드 구역이 손으로 고쳐져 있어 다시 렌더했습니다.`] : []),
    "",
    block,
  ].join("\n");
  const presence = confirmOnTerminal(shown, "deliver");

  const knowledge = selectKnowledge(work);
  const commit = commitDelivery(work, evidence!, knowledge);

  clearActive(repoRoot);
  return [
    `반영했습니다 — ${active.branch ?? "현재 브랜치"} 에 로컬 커밋 ${commit.slice(0, 12)}`,
    `확인한 사람: ${presence.detail}`,
    ...(knowledge.length > 0 ? [`공통 KNOWLEDGE 갱신: ${knowledge.join(", ")}`] : ["공통 KNOWLEDGE 는 갱신하지 않았습니다."]),
    "",
    `PR 본문은 ${prDocFile(active.id)} 에 있습니다. push · MR/PR 생성은 하지 않았습니다 — git 호스트가 붙을 때까지 보류입니다.`,
    `커밋한 것은 이 작업의 파일·증거·원장뿐입니다 — 도입 설정(${STATE_DIR}/version · ${STATE_DIR}/models.json · ${APPROVALS_DIR}/docs.jsonl)은 사람이 따로 커밋합니다.`,
    "작업 커서를 지웠습니다.",
  ].join("\n");
}
