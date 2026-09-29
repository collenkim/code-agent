import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { userInfo } from "os";

import { formatDiff, recordDecision } from "../core/approval";
import type { Decision } from "../core/approval";
import { collectExemplars, formatExemplars } from "../core/exemplar";
import { checkPaths, missingPlannedFiles } from "../core/gate";
import { stagesFor } from "../core/manifest";
import type { StageDef } from "../core/manifest";
import { formatPlan, missingPreserve, planFormatFor } from "../core/plan";
import { writeAtomic } from "../core/atomic";
import { checkProjectDocs, docPaths, docsReady, formatDocChecks } from "./docs";
import {
  AFTER_IMPLEMENT,
  canonical,
  clearActive,
  loadActive,
  PHASES,
  planFile,
  questionsFile,
  saveActive,
  workDocsDir,
} from "./layout";
import type { ActiveWork, Phase } from "./layout";
import { unansweredQuestions } from "./questions";
import { isGitRepo, switchToWorkBranch } from "./git";
import { commitOf, mergeBase } from "./tree";
import { prDocFile } from "./deliver";
import { proposalFile } from "./knowledge";
import {
  fixLimit,
  loadEvidence,
  outsideChanges,
  overFixLimit,
  runsOf,
  stageProblems,
  testStageFiles,
  validationDocFile,
} from "./evidence";
import type { VerifyPhase } from "./evidence";
import { loadReview, reviewDocFile, reviewProblems } from "./review";
import { KNOWLEDGE_KINDS } from "./schemas";
import { Stop } from "./stop";
import { confirmOnTerminal } from "./tty";
import { approvalDocsHash, approvalOf, loadManifestIfAny, loadWork, readOrder } from "./work";
import type { Work } from "./work";
import {
  acceptanceCriteria,
  analysisProblems,
  designProblems,
  formatAssumptions,
  functionalProblems,
  loadRequirements,
  parseTestCases,
  planDocFile,
  readWorkDoc,
  renderPlanDoc,
  testSpecProblems,
  workDocPath,
} from "./workDocs";
import type { Requirements } from "./workDocs";

// Stop 은 work.ts 도 던지므로 따로 있다 (여기 두면 work.ts ↔ commands.ts 가 서로를 부른다)
export { Stop } from "./stop";


const PHASE_LABEL: Record<Phase, string> = {
  analysis: "요구사항 분석",
  impact: "영향도 분석",
  design: "설계·정의",
  plan: "구현 계획",
  implement: "구현",
  check: "정적 분석·컴파일",
  test: "테스트",
  review: "코드 리뷰",
  integrate: "통합 검증",
  deliver: "반영",
};

/**
 * 모르는 스테이지는 옛 버전이 남긴 커서다 (P3 의 `research`). 조용히 다른 칸으로 옮겨 이어 가면
 * 그 작업의 문서가 어느 게이트를 지났는지 아무도 모른다 — 지우고 다시 시작하게 한다.
 */
function requirePhase(active: ActiveWork): void {
  if (!(PHASES as readonly string[]).includes(active.phase)) {
    throw new Stop(
      `알 수 없는 스테이지입니다: ${active.phase} (스테이지: ${PHASES.join(" → ")}).\n` +
        "code-agent abort 로 커서를 지우고 다시 시작하세요 — 작업 폴더의 문서는 그대로 남습니다.",
    );
  }
}

/**
 * P5 이전에 시작된 작업에는 굳혀 둔 기준 커밋이 없다. 그 위에서 검증하면 변경 목록이 실제보다
 * 넓거나 좁고, 증거가 무엇 위에서 났는지 아무도 모른다 — 지금 다시 굳히는 것도 같은 이유로 안 된다
 * (그 사이 기준 브랜치가 움직였을 수 있다). 지우고 다시 시작하게 한다.
 *
 * git 저장소가 아니었으면 브랜치도 없다 — 그 작업은 애초에 굳힐 커밋이 없었던 것이라 통과시킨다.
 */
function requireBaseCommit(active: ActiveWork): void {
  if (active.branch && !active.baseCommit) {
    throw new Stop(
      "이 작업에는 굳혀 둔 기준 커밋이 없습니다 (P5 이전에 시작된 커서입니다).\n" +
        "code-agent abort 로 커서를 지우고 다시 시작하세요 — 작업 폴더의 문서는 그대로 남습니다.",
    );
  }
}

function requireWork(repoRoot: string): Work {
  const work = loadWork(repoRoot);
  if (!work) {
    throw new Stop("진행 중인 작업이 없습니다. /ca-feature · /ca-fix · /ca-refactor 로 시작하세요.");
  }
  requirePhase(work.active);
  requireBaseCommit(work.active);
  return work;
}

function requireDocs(repoRoot: string, work?: Work): void {
  const checks = checkProjectDocs(repoRoot, work?.manifest ?? loadManifestIfAny(repoRoot));
  if (!docsReady(checks)) {
    throw new Stop(
      "프로젝트 필수 문서가 갖춰지지 않아 진행할 수 없습니다.\n" +
        `${formatDocChecks(checks)}\n` +
        "/ca-docs 로 작성하세요 (역공학 · 사용자 입력 · 기존 문서 연결).",
    );
  }
}

function requireAnswers(repoRoot: string, active: ActiveWork): void {
  const open = unansweredQuestions(repoRoot, questionsFile(active.id));
  if (open.length > 0) {
    throw new Stop(
      `답이 없는 질문이 ${open.length}개 있어 넘어갈 수 없습니다 (${questionsFile(active.id)}):\n` +
        open.map((question) => `  - ${question.title}`).join("\n") +
        "\n/ca-answer 로 답하세요.",
    );
  }
}

/** ① 요구 항목. 없거나 형식이 틀리면 멈춘다 — 뒤 스테이지의 검사가 전부 여기에 기댄다 */
function requireRequirements(repoRoot: string, active: ActiveWork): Requirements {
  const path = workDocPath(active.id, "01-requirements");
  let requirements: Requirements | undefined;
  try {
    requirements = loadRequirements(repoRoot, active.id);
  } catch (error) {
    const lines = (error instanceof Error ? error.message : String(error)).split("\n");
    throw new Stop(`${path} 의 형식이 맞지 않습니다:\n${lines.map((line) => `  - ${line}`).join("\n")}`);
  }
  if (!requirements) {
    throw new Stop(
      `요구사항 분석 결과가 없습니다: ${path} 에 요구 항목(## R1 · …)과 ## 가정 을 쓰세요 (code-agent docs skeleton 01-requirements).`,
    );
  }
  return requirements;
}

/** 번호 문서의 게이트 — 지나지 못하면 무엇이 모자란지 그대로 알린다 */
function requireWorkDocs(problems: string[]): void {
  if (problems.length > 0) {
    throw new Stop(
      "작업 문서가 게이트를 지나지 못했습니다:\n" +
        problems.map((problem) => `  - ${problem}`).join("\n"),
    );
  }
}

/** 계획이 요구 항목을 전부 덮는가 — 파일마다 어느 항목을 위한 것인지 적게 해 코드가 대조한다 */
function coverageProblems(keys: string[], files: { path: string; requirements?: string[] }[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const listed = file.requirements ?? [];
    if (listed.length === 0) {
      problems.push(`${file.path}: 어느 요구 항목을 위한 파일인지 requirements 에 적으세요 (${keys.join(", ")})`);
    }
    for (const key of listed.filter((key) => !keys.includes(key))) {
      problems.push(`${file.path}: 01-requirements.md 에 없는 요구 항목 ${key}`);
    }
  }
  const covered = new Set(files.flatMap((file) => file.requirements ?? []));
  const uncovered = keys.filter((key) => !covered.has(key));
  if (uncovered.length > 0) {
    problems.push(`어떤 파일에도 닿지 않는 요구 항목: ${uncovered.join(", ")} — 파일을 더하거나, 이번 범위가 아니면 질문으로 확인하세요`);
  }
  return problems;
}

/**
 * implement 가 실제로 도는 단계 — 계획에 파일이 있는 것만. 공통 모듈처럼 대부분의 작업에서 비는 단계에
 * 서브에이전트를 빈손으로 보내지 않는다.
 */
function plannedStages(work: Work): StageDef[] {
  const files = work.plan?.files ?? [];
  return codeStages(work).filter((stage) => files.some((file) => file.stage === stage.key));
}

/** implement 가 도는 단계 — 검증 단계는 verify 스테이지가 맡는다 */
function codeStages(work: Work): StageDef[] {
  return work.stages.filter((stage) => stage.kind !== "verify");
}

function toRepoPath(repoRoot: string, path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  return relative(repoRoot, canonical(absolute)).replace(/\\/g, "/");
}

// ---- start ----

export function start(repoRoot: string, spec: string, options: { target?: string; base?: string } = {}): string {
  const { target } = options;
  const manifest = loadManifestIfAny(repoRoot);
  if (!manifest) {
    throw new Stop("code-agent.json 이 없습니다. /ca-adopt 로 프로젝트를 먼저 도입하세요.");
  }
  requireDocs(repoRoot);

  const specPath = toRepoPath(repoRoot, spec);
  const order = readOrder(repoRoot, specPath, manifest);
  const chosen = target ?? order.target[0];
  if (!order.target.includes(chosen)) {
    throw new Stop(`지시서의 대상이 아닙니다: ${chosen} (대상: ${order.target.join(", ")})`);
  }
  stagesFor(manifest, order.kind);

  const current = loadActive(repoRoot);
  if (current && (current.id !== order.id || current.target !== chosen)) {
    throw new Stop(
      `진행 중인 작업이 있습니다: ${current.id} (${current.target}, ${current.phase}). ` +
        "끝내거나 code-agent abort 로 멈춘 뒤 시작하세요.",
    );
  }
  if (current) {
    return `이미 진행 중입니다: ${current.id} · ${PHASE_LABEL[current.phase]}\n\n${status(repoRoot)}`;
  }

  // 작업 브랜치 — 기준은 사용자 입력(--base) > code-agent.json 의 git.base > master
  let branch: string | undefined;
  let base: string | undefined;
  let baseCommit: string | undefined;
  let branchNote = "git 저장소가 아니라 작업 브랜치를 만들지 않았습니다.";
  if (isGitRepo(repoRoot)) {
    base = options.base ?? manifest.git.base;
    branch = `${order.kind}/${order.id}`;
    let how: "created" | "switched" | "already";
    try {
      how = switchToWorkBranch(repoRoot, branch, base);
      branchNote =
        how === "created" ? `작업 브랜치 ${branch} 를 ${base} 에서 만들었습니다.`
        : how === "switched" ? `이미 있는 작업 브랜치 ${branch} 로 전환했습니다.`
        : `작업 브랜치 ${branch} 에 있습니다.`;
    } catch (error) {
      throw new Stop(`작업 브랜치로 옮기지 못했습니다: ${error instanceof Error ? error.message : error}`);
    }
    // 기준을 **이름이 아니라 커밋으로** 굳힌다. 새로 딴 브랜치는 기준 브랜치의 끝이 곧 갈라진
    // 자리지만, 이미 있던 브랜치로 돌아온 것이라면 그 사이 기준이 나아갔을 수 있다 — 그때 끝을
    // 굳히면 기준이 더한 파일이 전부 이 작업의 `[D]` 삭제로 잡혀 검증이 통째로 막힌다.
    baseCommit =
      (how === "created" ? commitOf(repoRoot, base) : mergeBase(repoRoot, base, "HEAD")) ??
      commitOf(repoRoot, base) ??
      commitOf(repoRoot, "HEAD");
    if (!baseCommit) {
      throw new Stop(
        `기준 커밋을 굳힐 수 없습니다 (${base}). 커밋이 하나도 없는 저장소에서는 검증 증거를 묶을 자리가 없습니다 — 먼저 커밋하세요.`,
      );
    }
    branchNote += ` 기준 커밋 ${baseCommit.slice(0, 12)} 를 굳혔습니다.`;
  }

  const questions = join(repoRoot, questionsFile(order.id));
  mkdirSync(dirname(questions), { recursive: true });
  if (!existsSync(questions)) {
    writeFileSync(
      questions,
      `# ${order.id} 질문\n\n` +
        "<!-- 질문은 `## Q<번호> · <스테이지>` 로 시작하고, 답은 `[Answer]:` 뒤에 적는다. 답이 없으면 다음으로 넘어가지 않는다. -->\n",
    );
  }
  saveActive(repoRoot, { id: order.id, spec: specPath, target: chosen, phase: "analysis", branch, base, baseCommit });
  return `시작했습니다: ${order.id} · ${order.title} (${order.kind}, 대상 ${chosen})\n${branchNote}\n\n${status(repoRoot)}`;
}

// ---- status ----

function nextHint(work: Work): string {
  const { repoRoot, active } = work;
  const open = unansweredQuestions(repoRoot, questionsFile(active.id)).length;
  if (open > 0) {
    return `답이 없는 질문 ${open}개 — /ca-answer`;
  }
  switch (active.phase) {
    case "analysis":
    case "impact":
    case "design":
      return `${PHASE_LABEL[active.phase]}(${workDocsDir(active.id)}/ 의 번호 문서)을 마치면 code-agent next`;
    case "plan": {
      if (!work.plan) {
        return `계획 초안을 ${workDocsDir(active.id)}/plan.json 에 쓰고 code-agent plan submit ${workDocsDir(active.id)}/plan.json`;
      }
      const approval = approvalOf(work);
      if (approval.status === "approved") {
        return "승인됨 — code-agent next 로 구현 시작";
      }
      // 반려는 다시 내라는 뜻이 아니라 다시 보라는 뜻이다 — 사유가 어느 문서를 가리키는지부터 읽게 한다
      if (approval.status === "rejected") {
        return (
          `반려됐습니다: ${approval.record.comment ?? "(사유 없음)"} — ` +
          `사유가 가리키는 문서(01~04 · 07 · plan.json)를 다시 보고, 정할 수 없는 것은 ${questionsFile(active.id)} 에 질문으로 남긴 뒤 다시 제출하세요`
        );
      }
      return `사람이 별도 터미널에서 code-agent approve (현재: ${approval.status})`;
    }
    case "implement":
      return `단계 ${active.stage} 를 구현한 뒤 code-agent next`;
    case "check":
    case "test": {
      const evidence = loadEvidence(repoRoot, active.id, active.target);
      if (!evidence) {
        return `code-agent ${active.phase}`;
      }
      if (overFixLimit(work, evidence)) {
        return `고쳐 쓰기 ${fixLimit(work, evidence)}회를 넘겨 막혔습니다 — 계획 파일은 더 고칠 수 없습니다. ${workDocsDir(active.id)}/questions.md 에 적고 사람에게 보고하세요`;
      }
      const failed = runsOf(evidence, active.phase).filter((run) => run.outcome !== "passed");
      return failed.length === 0 && runsOf(evidence, active.phase).length > 0
        ? "검증 통과 — code-agent next"
        : `${failed.map((run) => `${run.kind}(${run.outcome})`).join(", ") || "아직 돌리지 않음"} — 계획 안에서 고치고 code-agent ${active.phase} (${evidence.rounds}/${fixLimit(work, evidence) + 1}회차)`;
    }
    case "review": {
      const problems = reviewProblems(work);
      return problems.length === 0
        ? "리뷰가 닫혔습니다 — code-agent next 로 통합 검증으로"
        : `${problems[0]}${problems.length > 1 ? ` (외 ${problems.length - 1}건)` : ""}`;
    }
    case "integrate": {
      const evidence = loadEvidence(repoRoot, active.id, active.target);
      return evidence && runsOf(evidence, "integrate").length > 0 && stageProblems(work, "integrate").length === 0
        ? "통합 검증 통과 — code-agent next"
        : "code-agent integrate (기준 커밋 위의 깨끗한 worktree 에서 전체 build · test)";
    }
    case "deliver":
      return `사람이 별도 터미널에서 code-agent deliver — ${prDocFile(active.id)} 의 요약·확인 방법·위험을 먼저 쓰세요`;
  }
}

export function status(repoRoot: string): string {
  const manifest = loadManifestIfAny(repoRoot);
  const checks = checkProjectDocs(repoRoot, manifest);
  const lines = [`code-agent — ${repoRoot}`, "", "프로젝트 문서:", formatDocChecks(checks)];

  const work = loadWork(repoRoot);
  if (!work) {
    const hint = !manifest
      ? "/ca-adopt 로 도입 (레거시) · 신규 프로젝트면 /ca-docs 로 공통 POLICY 4종부터"
      : !docsReady(checks)
        ? "/ca-docs 로 필수 문서를 갖추세요 — 확정은 별도 터미널에서 code-agent confirm doc <종류>"
        : "/ca-feature <지시서> 로 시작";
    lines.push("", "작업: 없음", `다음: ${hint}`);
    return lines.join("\n");
  }

  const { active, order } = work;
  requirePhase(active);
  const flow = PHASES.map((phase) => (phase === active.phase ? `[${phase}]` : phase)).join(" → ");
  const open = unansweredQuestions(repoRoot, questionsFile(active.id));
  lines.push(
    "",
    `작업: ${order.id} · ${order.title} (${order.kind}, 대상 ${active.target})`,
    `지시서: ${active.spec}`,
    `작업 폴더: ${workDocsDir(active.id)}/`,
    `브랜치: ${active.branch ? `${active.branch} (기준 ${active.base})` : "없음"}`,
    `스테이지: ${PHASE_LABEL[active.phase]} — ${flow}`,
  );
  if (active.phase === "implement") {
    const keys = plannedStages(work).map((stage) => (stage.key === active.stage ? `[${stage.key}]` : stage.key));
    lines.push(`단계: ${keys.join(" → ")}`);
  }
  lines.push(`질문: ${open.length === 0 ? "답 없는 질문 없음" : open.map((q) => q.id).join(", ") + " 답 없음"}`);
  if (work.plan) {
    lines.push(`계획: 제출됨 · 승인 ${approvalOf(work).status}`);
  } else {
    lines.push("계획: 없음");
  }
  if (AFTER_IMPLEMENT.includes(active.phase)) {
    const evidence = loadEvidence(repoRoot, active.id, active.target);
    lines.push(
      `검증: ${evidence ? `${evidence.rounds}회차 · ${evidence.runs.length}회 실행 (${validationDocFile(active.id)})` : "아직 없음"}`,
    );
    if (active.phase !== "check" && active.phase !== "test") {
      const review = loadReview(repoRoot, active.id, active.target);
      const last = review?.rounds[review.rounds.length - 1];
      lines.push(
        `리뷰: ${last ? `${last.round}회차 · 기준 트리 ${last.treeHash.slice(-12)} (${reviewDocFile(active.id)})` : "회차 없음 — code-agent review"}`,
      );
    }
    const outside = outsideChanges(work);
    if (outside.length > 0) {
      lines.push(`계획 밖 변경: ${outside.map((change) => `[${change.status}] ${change.path}`).join(", ")}`);
    }
  }
  lines.push(`다음: ${nextHint(work)}`);
  return lines.join("\n");
}

// ---- next ----

export function next(repoRoot: string): string {
  const work = requireWork(repoRoot);
  const { active } = work;
  requireDocs(repoRoot, work);
  requireAnswers(repoRoot, active);

  const advance = (phase: Phase, stage?: string): string => {
    saveActive(repoRoot, { ...active, phase, stage });
    return status(repoRoot);
  };

  switch (active.phase) {
    case "analysis":
      requireRequirements(repoRoot, active);
      return advance("impact");
    case "impact": {
      const { keys } = requireRequirements(repoRoot, active);
      requireWorkDocs(analysisProblems(repoRoot, active.id, keys));
      return advance("design");
    }
    case "design": {
      const { keys } = requireRequirements(repoRoot, active);
      requireWorkDocs([
        ...designProblems(repoRoot, active.id),
        ...functionalProblems(repoRoot, active.id, keys).problems,
      ]);
      return advance("plan");
    }
    case "plan": {
      if (!work.plan) {
        throw new Stop("제출된 계획이 없습니다. code-agent plan submit <초안> 으로 제출하세요.");
      }
      const approval = approvalOf(work);
      if (approval.status !== "approved") {
        throw new Stop(`계획이 승인되지 않았습니다 (${approval.status}). 사람이 별도 터미널에서 code-agent approve 를 실행해야 합니다.`);
      }
      return advance("implement", plannedStages(work)[0]?.key);
    }
    case "implement": {
      const stages = plannedStages(work);
      const index = stages.findIndex((stage) => stage.key === active.stage);
      const stage = stages[index];
      if (stage && work.plan) {
        const present = work.plan.files
          .filter((file) => file.stage === stage.key && existsSync(join(repoRoot, file.path)))
          .map((file) => file.path);
        const missing = missingPlannedFiles(work.plan, stage, present);
        if (missing.length > 0) {
          throw new Stop(
            `단계 ${stage.key} 의 계획 파일이 아직 없습니다:\n` +
              missing.map((violation) => `  - ${violation.file}`).join("\n"),
          );
        }
      }
      const following = stages[index + 1];
      return following ? advance("implement", following.key) : advance("check", undefined);
    }
    // 7·8 은 코드가 남긴 증거만 읽는다 — 모델의 "통과했습니다" 는 여기서 아무 효력이 없다.
    case "check":
      requireEvidence(work, "check");
      return advance("test");
    case "test":
      requireEvidence(work, "test");
      return advance("review");
    case "review": {
      const problems = reviewProblems(work);
      if (problems.length > 0) {
        throw new Stop(
          "코드 리뷰를 마치지 못했습니다:\n" + problems.map((problem) => `  - ${problem}`).join("\n"),
        );
      }
      return advance("integrate");
    }
    case "integrate":
      requireEvidence(work, "integrate");
      return advance("deliver");
    case "deliver":
      // 반영은 사람의 자리다 — 모델이 next 로 끝낼 수 없고, deliver 가 커밋 뒤 커서를 지운다
      throw new Stop(
        `반영은 사람이 **별도 터미널**에서 code-agent deliver 로 합니다 (TTY 확인 뒤 로컬 커밋).\n` +
          `${prDocFile(active.id)} 의 요약·확인 방법·위험·되돌리기를 먼저 쓰세요 — 추적표·검증·변경 요약은 코드가 렌더합니다.`,
      );
  }
}

/**
 * 수정 루프가 `check` 로 되감을 수 있는 자리 — 검증 실패·지적이 나는 스테이지들.
 *
 * `deliver` 는 넣지 않는다. 거기는 사람이 터미널에 서 있는 자리라, 모델이 부른 `check` 한 번에
 * 커서가 뒤로 가면 사람이 보던 화면이 조용히 무효가 된다.
 */
const REWINDABLE: readonly Phase[] = ["test", "review", "integrate"];

/**
 * `code-agent check` · `test` 의 전제. 승인이 stale 로 돌아섰는데 검증을 통과시키면
 * 그 통과는 근거 없는 것이 되므로 승인 상태까지 여기서 본다.
 *
 * **`check` 만은 커서를 되감는다.** 수정 루프의 규칙이 "고쳤으면 `check` 부터 다시"인데 커서가
 * 앞으로만 가면 그 문장을 실행할 길이 없다 — `test` 에서 실패해 고치면 `check` 는 "지금은 test"
 * 라고 막고, `test` 는 "계획 파일이 바뀌었으니 check 부터" 라고 막아 `abort` 말고는 나갈 데가
 * 없었다. 되감아도 잃는 것은 없다: 증거는 회차와 트리 해시에 묶여 있어 앞 스테이지의 통과가
 * 되살아나지 않고, 다시 `next` 로 같은 게이트를 전부 지나야 한다.
 */
export function requireValidatable(
  repoRoot: string,
  phase: "check" | "test" | "review" | "integrate" | "deliver",
): Work {
  let work = requireWork(repoRoot);
  requireDocs(repoRoot, work);
  requireAnswers(repoRoot, work.active);
  if (phase === "check" && REWINDABLE.includes(work.active.phase)) {
    saveActive(repoRoot, { ...work.active, phase: "check", stage: undefined });
    work = requireWork(repoRoot);
  }
  if (work.active.phase !== phase) {
    throw new Stop(
      `${PHASE_LABEL[phase]}(${phase}) 스테이지에서 돌립니다 (지금: ${work.active.phase}).\n${nextHint(work)}`,
    );
  }
  const approval = approvalOf(work);
  if (approval.status !== "approved") {
    throw new Stop(
      `계획이 승인되지 않았습니다 (${approval.status}). 승인 위에서 나지 않은 검증 결과는 증거가 아닙니다.`,
    );
  }
  return work;
}

/** 증거가 없거나 지금 트리를 가리키지 않거나 하나라도 통과가 아니면 넘어가지 않는다 */
function requireEvidence(work: Work, phase: VerifyPhase): void {
  const problems = stageProblems(work, phase);
  if (problems.length > 0) {
    throw new Stop(
      `${PHASE_LABEL[phase]} 를 마치지 못했습니다:\n` +
        problems.map((problem) => `  - ${problem}`).join("\n") +
        `\ncode-agent ${phase} 로 다시 돌리세요.`,
    );
  }
}

export function abort(repoRoot: string): string {
  const active = loadActive(repoRoot);
  if (!active) {
    throw new Stop("진행 중인 작업이 없습니다.");
  }
  clearActive(repoRoot);
  return `작업 커서를 지웠습니다: ${active.id}. 작업 폴더·계획·원장은 남아 있습니다 — 같은 지시서로 다시 시작할 수 있습니다.`;
}

// ---- context ----

/**
 * 지금 스테이지에 필요한 것만. 모델이 저장소를 헤매지 않게 코드가 골라 준다 —
 * 참조 코드는 매니페스트대로 결정론적으로 읽고, 긴 문서는 경로만 준다.
 */
export function context(repoRoot: string): string {
  const work = requireWork(repoRoot);
  const { active, manifest, order } = work;
  const out: string[] = [
    `# code-agent context — ${order.id} · ${PHASE_LABEL[active.phase]}`,
    "",
    `- 지시서: ${active.spec} (${order.kind}, 대상 ${active.target})`,
    `- 작업 폴더: ${workDocsDir(active.id)}/ — 분석·질문·작업 문서·계획 초안을 여기에 쓴다`,
    `- 질문: ${questionsFile(active.id)}`,
    `- 아키텍처: ${manifest.docs.architecture ?? "(없음)"}`,
    `- 코드 컨벤션: ${manifest.conventions.join(", ") || "(없음)"}`,
  ];
  if (order.scope.length > 0) out.push(`- scope (건드려도 되는 곳): ${order.scope.join(", ")}`);
  if (order.preserve.length > 0) out.push(`- preserve (바뀌면 안 되는 것): ${order.preserve.join(" / ")}`);

  if (active.phase === "analysis") {
    out.push(
      "",
      "## ① 01-requirements.md — 요구사항 정의",
      `${workDocPath(active.id, "01-requirements")} 에 쓴다 (뼈대: code-agent docs skeleton 01-requirements).`,
      "코드가 보는 것은 셋이다 — `## R<번호>` 1개 이상·중복 없음 · R 블록마다 `근거:` 줄 · `## 가정` 섹션. 없으면 code-agent next 가 넘어가지 않는다.",
      "```markdown",
      "## R1 · <요구 한 가지>",
      "근거: \"<지시서 문장 그대로>\"",
      "- 데이터: 만든다 | 바꾼다 | 안 건드린다",
      "- 접점(API·화면): 만든다 | 바꾼다 | 안 건드린다",
      "- 기존 코드: 고친다 | 안 고친다",
      "",
      "## 가정",
      "- <정한 것> — 근거: <컨벤션 위치 · 참조 코드 path:line · 일반 관행>   ← 없으면 `- 없음`",
      "",
      "## 범위 밖   ← 선택",
      "- <이번에 하지 않는 것> — 근거: <왜 밖인가>",
      "```",
    );
  }

  if (active.phase === "analysis" || active.phase === "impact" || active.phase === "design") {
    out.push(
      "",
      "## 질문과 가정 — 어느 쪽인가",
      `- **질문** (${questionsFile(active.id)}, 답이 올 때까지 진행 금지): 업무 규칙 · 범위(무엇을 만들고 무엇을 안 만드는가) · 권한 · 데이터의 의미 ·`,
      "  다른 도메인·외부와의 계약 · 아키텍처·컨벤션과 충돌하는 것. 모델이 정하면 지어낸 것이 되는 것들이다.",
      `- **가정** (${workDocPath(active.id, "01-requirements")} 의 \`## 가정\`, 진행한다): 컨벤션·참조 코드·일반 관행으로 기본값을 댈 수 있고 승인 때 고쳐도 싼 기술 세부 —`,
      "  메서드 이름 · 정렬 · 숫자 정밀도 · 테스트 케이스 목록 · 메시지 문구 · 이번 범위 밖으로 둘 부수 작업. 근거를 반드시 단다.",
      "- 가정은 승인 화면에 그대로 보여 사람이 계획과 함께 받아들인다. 확신이 없으면 질문으로.",
    );
  }

  if (active.phase === "impact") {
    out.push(
      "",
      "## ② 02-analysis.md — 영향도 분석",
      `${workDocPath(active.id, "02-analysis")} 에 쓴다 (뼈대: code-agent docs skeleton 02-analysis).`,
      "필수 섹션: 기존 시스템 분석 · 영향 범위 · Risk. `영향 범위` 표의 **첫 열에 01 의 모든 R** 이 한 줄 이상이어야 넘어간다 —",
      "영향이 없는 R 도 근거와 함께 '없음' 으로 한 줄 넣는다.",
      "```markdown",
      "## 영향 범위",
      "| R 번호 | 닿는 파일/모듈 | 부르는 곳 | 파급 |",
      "|---|---|---|---|",
      "| R1 | <path:line> | <부르는 곳> | 없음 — <근거> |",
      "```",
      `- 공통 KNOWLEDGE (읽기만 — 키가 이미 있으면 ca-explorer 를 붙이지 말고 인용한다): ${KNOWLEDGE_KINDS.map((kind) => docPaths(manifest, kind)[0]).join(", ")}`,
    );
  }

  if (active.phase === "design") {
    out.push(
      "",
      "## ③ 03-design.md · ④ 04-functional.md — 설계·정의 (같은 스테이지에서 함께 쓴다)",
      `뼈대: code-agent docs skeleton 03-design · code-agent docs skeleton 04-functional`,
      `- ${workDocPath(active.id, "03-design")} — 구성 요소 · 처리 흐름 · API · 데이터 · 설계 결정.`,
      "  API·데이터는 조건부다: 안 건드리면 `해당 없음 — <근거>`. **근거 없는 `해당 없음` 은 미충족이다.**",
      `- ${workDocPath(active.id, "04-functional")} — 기능 정의 · 업무 규칙 · 예외 · 수락 기준.`,
      "  수락 기준은 `AC-R<n>-<m>` 한 줄씩, **R 마다 최소 하나** · id 중복 없음 · 01 에 없는 R 을 가리키지 않는다. 오류 코드는 03 의 API 와 글자까지 같게.",
      `- 공통 KNOWLEDGE (읽기만 — 인용은 키와 기대는 사실 한 줄을 옮겨 적고 차이만): ${KNOWLEDGE_KINDS.map((kind) => docPaths(manifest, kind)[0]).join(", ")}`,
    );
  }

  if (active.phase === "impact" || active.phase === "design" || active.phase === "plan") {
    const { keys } = requireRequirements(repoRoot, active);
    out.push("", `- 요구 항목: ${keys.join(", ")} (${workDocPath(active.id, "01-requirements")})`);

    // 참조 코드는 코드가 고른다 — 조사자마다 참조 도메인을 다시 찾아 저장소를 훑지 않게 경로를 준다.
    if (manifest.referenceDomain) {
      out.push("", `## 참조 도메인 ${manifest.referenceDomain} — 단계별 표준 파일 (다시 찾지 말고 이것부터 읽는다)`);
      for (const stage of codeStages(work)) {
        const where = stage.scope === "project" ? `저장소 기준 ${stage.outputDirs.join(", ") || "제한 없음"}` : "도메인 안";
        const { files, missing } = collectExemplars(repoRoot, manifest, manifest.referenceDomain, stage);
        const paths = files.map((file) => file.path);
        out.push(`- ${stage.key} (${where}): ${paths.join(", ") || (stage.exemplars.length === 0 ? "참조 없음" : `못 찾음 ${missing.join(", ")}`)}`);
      }
    }
  }

  if (active.phase === "plan") {
    const format = planFormatFor(order.kind);
    const functional = readWorkDoc(repoRoot, active.id, "04-functional");
    const acceptance = functional ? acceptanceCriteria(functional) : [];
    const spec = readWorkDoc(repoRoot, active.id, "07-test-spec");
    const cases = spec ? parseTestCases(spec) : [];
    out.push(
      "",
      `- 수락 기준 (${workDocPath(active.id, "04-functional")}): ${acceptance.join(", ") || "없음 — 04 를 먼저 쓴다"}`,
      `- 테스트 케이스 (${workDocPath(active.id, "07-test-spec")}): ` +
        (cases.length > 0
          ? cases.map((entry) => `${entry.id}(${entry.level} → ${entry.acceptance.join(",") || "대상 없음"})`).join(", ")
          : "아직 없음"),
      `- 테스트 전략: ${docPaths(manifest, "test-strategy")[0]} · 품질·보안 기준: ${docPaths(manifest, "quality")[0]}`,
      "",
      "## ⑦ 07-test-spec.md — 테스트 명세 (구현 전에 쓴다)",
      "뼈대: code-agent docs skeleton 07-test-spec. 열 순서는 고정이고, 04 의 **모든 AC 가 최소 한 TC 에** 걸려야 계획이 제출된다.",
      "```markdown",
      "| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |",
      "|---|---|---|---|---|",
      "| TC-1 | Unit | AC-R1-1 | <무엇을 한다> | <무엇이 된다> |",
      "```",
      "",
      "## 계획 형식",
      `초안을 ${workDocsDir(active.id)}/plan.json 에 쓰고 \`code-agent plan submit ${workDocsDir(active.id)}/plan.json\` 로 제출한다.`,
      "openQuestions 가 남아 있으면 제출되지 않는다 — questions.md 로 옮겨 답을 받는다.",
      "files[].requirements 에 그 파일이 담당하는 요구 항목 번호를 적는다. 모든 요구 항목이 어느 파일엔가 닿아야 제출된다.",
      `제출하면 코드가 ${planDocFile(active.id)} 를 렌더한다 — 그 파일은 손대지 않는다 (hook 이 거부한다).`,
      "```json",
      format.shape,
      "```",
      "",
      "## 단계 (files[].stage 에 쓰는 key)",
      ...codeStages(work).map(
        (stage) =>
          `- ${stage.key}: ${stage.title} — 위치 ${stage.scope === "project" ? "(저장소 기준) " : ""}${stage.outputDirs.join(", ") || "제한 없음"}` +
          (stage.base ? ` · base ${stage.base}` : ""),
      ),
      "",
      `도메인 위치: ${manifest.domainBase}/{${manifest.domainRoots.join(",")}}/<도메인>/<단계 위치>`,
      `참조 도메인: ${manifest.referenceDomain ?? "(없음)"}`,
    );
  }

  if (active.phase === "implement" && work.stage && work.plan) {
    const stage = work.stage;
    const planned = work.plan.files.filter((file) => file.stage === stage.key);
    out.push("", `## 단계 ${stage.key} — ${stage.title}`, "", "만들 파일 (승인된 계획 — 이 밖은 hook 이 거부한다):");
    out.push(...planned.map((file) => `- ${file.path} — ${file.purpose}`));
    const template = join(repoRoot, stage.template);
    if (existsSync(template)) {
      out.push("", `## 단계 규칙 (${stage.template})`, readFileSync(template, "utf-8").trim());
    }
    if (work.plan.conventions.length > 0) {
      out.push("", "## 이번 계획이 적용하기로 한 규칙");
      out.push(...work.plan.conventions.map((rule) => `- ${rule.rule} (${rule.source})`));
    }
    if (stage.exemplars.length > 0 && manifest.referenceDomain) {
      const exemplars = collectExemplars(repoRoot, manifest, manifest.referenceDomain, stage);
      out.push("", `## 참조 표준 — ${manifest.referenceDomain} (이 구조를 그대로 따른다)`, formatExemplars(exemplars.files, manifest.language));
      if (exemplars.missing.length > 0) out.push("", `찾지 못한 참조: ${exemplars.missing.join(", ")}`);
      for (const omitted of exemplars.omitted) {
        out.push(`내용을 생략한 참조 (${omitted.pattern}): ${omitted.names.join(", ")}`);
      }
    }
  }

  // 검증·리뷰 스테이지 — 재탐색이 비용을 터뜨리는 자리다. 읽을 것을 코드가 골라 주고,
  // 긴 것(실패 로그)은 내용이 아니라 경로만 준다.
  if (AFTER_IMPLEMENT.includes(active.phase) && work.plan) {
    const frozen = testStageFiles(work);
    out.push(
      "",
      "## 계획 파일",
      ...work.plan.files.map(
        (file) =>
          `- [${file.stage}] ${file.path} — ${file.purpose} · 요구 ${(file.requirements ?? []).join(", ") || "없음"}` +
          (frozen.includes(file.path) ? " · **얼어 있음 (kind:test)**" : ""),
      ),
    );
    const evidence = loadEvidence(repoRoot, active.id, active.target);
    out.push(
      "",
      `## 검증 증거 (${validationDocFile(active.id)})`,
      evidence
        ? [
            `- ${evidence.rounds}회차 · 한도 ${fixLimit(work, evidence) + 1}회차`,
            ...(["check", "test"] as const).flatMap((phase) =>
              runsOf(evidence, phase).map(
                (run) => `- ${phase}/${run.kind}: ${run.outcome}${run.logFile ? ` · 로그 ${run.logFile}` : ""}`,
              ),
            ),
          ].join("\n")
        : "- 아직 없습니다 — code-agent check",
      "",
      "얼어 있는 테스트 파일은 고칠 수 없습니다. 틀렸다고 보이면 고치지 말고 근거와 함께 보고하세요 — hook 이 거부합니다.",
      `계획 밖을 고쳐야 하면 ${questionsFile(active.id)} 에 질문으로 남기고 멈추세요.`,
    );
  }

  if (active.phase === "review") {
    const review = loadReview(repoRoot, active.id, active.target);
    const last = review?.rounds[review.rounds.length - 1];
    out.push(
      "",
      `## ⑨ ${reviewDocFile(active.id)} — 코드 리뷰`,
      `- 회차: ${last ? `${last.round}회차 (기준 트리 ${last.treeHash})` : "없음 — code-agent review 로 먼저 여세요"}`,
      "- 회차 구역(`<!-- code-agent:review:... -->`)은 코드가 렌더합니다. 손대면 게이트가 거부합니다.",
      "- ca-reviewer 에게는 위 계획 파일 목록·검증 증거·컨벤션 경로만 넘깁니다 — 저장소를 다시 훑게 하지 않습니다.",
      "",
      "`## 지적` 표에 ca-reviewer 의 지적을 줄이지 말고 그대로 옮깁니다 (하나도 없으면 `- 없음`):",
      "```markdown",
      "| id | 계획 파일 | 범위 | 상태 | 지적 |",
      "|---|---|---|---|---|",
      "| F1 | <계획 파일 경로> | 계획 안 | 열림 | <무엇이 어긋났나 · 근거 · 고치는 방향> |",
      "```",
      "- **열 순서는 고정입니다** — 코드가 칸 위치로 읽습니다. 상태는 `열림` · `해결` 둘뿐이고 글자 그대로 봅니다.",
      "- 계획 파일 칸은 **저장소 기준 경로 그대로** — 백틱도 `:줄번호` 도 붙이지 마세요 (줄번호·근거는 지적 칸에).",
      "- **범위는 코드가 계획과 대조해 정합니다** — 적은 것이 다르면 게이트가 알려 줍니다.",
      "- 계획 안 지적: 고친 뒤 code-agent check → test → review 로 다음 회차를 엽니다 (check 가 이 자리에서 되감습니다).",
      `- 계획 밖 지적: 모델이 닫을 수 없습니다. ${questionsFile(active.id)} 로 묻거나 계획을 고쳐 재승인받습니다.`,
    );
  }

  if (active.phase === "integrate") {
    out.push(
      "",
      "## 10 통합 검증",
      "`code-agent integrate` — 굳혀 둔 기준 커밋 위에 깨끗한 worktree 를 만들고 이 작업의 변경만 얹어 전체 build · test 를 돌립니다.",
      "작업 트리에 남아 있던 산출물이 결과를 떠받치지 않는지 보는 자리라, 모델이 할 일은 명령을 부르는 것뿐입니다.",
    );
  }

  if (active.phase === "deliver") {
    out.push(
      "",
      `## ⑩ ${prDocFile(active.id)} — PR 본문`,
      "모델이 쓰는 것은 세 섹션입니다 — `## 요약` · `## 확인 방법` · `## 위험·되돌리기`.",
      "추적표(R → AC → 파일 → TC → 검증) · 검증 · 변경 요약은 코드 구역(`<!-- code-agent:trace:... -->`)이라 code-agent deliver 가 렌더합니다.",
      `공통 KNOWLEDGE 에 더할 것이 있으면 ${proposalFile(active.id)} 에 제안으로 씁니다 — 종류(\`## data-dictionary\`)마다 \`### \`키\` 이름\` 블록, 본문에 이번 작업의 R 번호를 답니다.`,
      "",
      "**반영은 사람이 별도 터미널에서 `code-agent deliver`** 로 합니다 — TTY 확인 뒤 작업 브랜치에 로컬 커밋합니다.",
      "push · MR/PR 생성은 하지 않습니다 (git 호스트가 붙을 때까지 보류).",
    );
  }
  return out.join("\n");
}

// ---- plan submit ----

export function submitPlan(repoRoot: string, draft: string): string {
  const work = requireWork(repoRoot);
  const { active, order, manifest } = work;
  if (active.phase !== "plan") {
    throw new Stop(`계획은 plan 스테이지에서 제출합니다 (지금: ${active.phase}).`);
  }
  requireDocs(repoRoot, work);
  requireAnswers(repoRoot, active);

  // 계획 검사 전에 ①~④·⑦ 을 다시 본다 — 스테이지를 지난 뒤에 문서를 고쳤을 수 있고, 승인은 이 묶음에 대한 것이다.
  const requirements = requireRequirements(repoRoot, active);
  const functional = functionalProblems(repoRoot, active.id, requirements.keys);
  const testSpec = testSpecProblems(repoRoot, active.id, functional.acceptance, manifest);
  requireWorkDocs([
    ...analysisProblems(repoRoot, active.id, requirements.keys),
    ...designProblems(repoRoot, active.id),
    ...functional.problems,
    ...testSpec.problems,
  ]);

  const format = planFormatFor(order.kind);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(process.cwd(), draft), "utf-8"));
  } catch (error) {
    throw new Stop(`계획 초안을 읽을 수 없습니다: ${error instanceof Error ? error.message : error}`);
  }
  const parsed = format.schema.safeParse(raw);
  if (!parsed.success) {
    throw new Stop(
      "계획 형식이 맞지 않습니다:\n" +
        parsed.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n"),
    );
  }
  const plan = format.toPlan(parsed.data);

  const problems: string[] = [...coverageProblems(requirements.keys, plan.files)];
  if (plan.openQuestions.length > 0) {
    problems.push(`남은 질문이 있습니다 — questions.md 로 옮겨 답을 받으세요: ${plan.openQuestions.join(" / ")}`);
  }
  if (format.requiresPreserve) {
    problems.push(...missingPreserve(order, plan).map((item) => `preserve 가 계획에 없습니다: ${item}`));
  }
  // 검증 명령이 이 계획이 쓰는 파일을 가리키면 모델이 제 검증기를 쓰게 된다 — 그래도 묶임은
  // 전부 들어맞는다(가짜 검증기까지 함께 굳으므로). 코드가 판별할 수 있는 것이 아니라 사람이
  // 판단할 것이라, 조용히 지나가지 않게 제출을 세우고 무엇이 걸렸는지 그대로 보여 준다.
  const planned = new Set(plan.files.map((file) => file.path));
  const declared = [manifest.build, manifest.test, ...Object.values(manifest.commands)]
    .filter((argv): argv is string[] => Array.isArray(argv))
    .flat()
    .map((element) => element.replace(/^\.\//, ""));
  for (const path of [...new Set(declared.filter((element) => planned.has(element)))]) {
    problems.push(
      `검증 명령이 이 계획이 쓰는 파일을 가리킵니다: ${path} — 검증을 스스로 쓰는 계획은 증거가 되지 않습니다`,
    );
  }

  const stages = codeStages(work);
  for (const file of plan.files) {
    const stage = stages.find((candidate) => candidate.key === file.stage);
    if (!stage) {
      problems.push(`${file.path}: 알 수 없는 단계 ${file.stage} (단계: ${stages.map((s) => s.key).join(", ")})`);
      continue;
    }
    for (const violation of checkPaths({ repoRoot, order, manifest, plan, stage, files: [file.path].map((path) => ({ path, content: "" })) })) {
      problems.push(`[${violation.item}] ${violation.file}: ${violation.detail}`);
    }
  }
  if (problems.length > 0) {
    throw new Stop(`계획을 제출하지 않았습니다:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  }

  const path = planFile(repoRoot, active.id, active.target);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${JSON.stringify(plan, null, 2)}\n`);
  // ⑤ 05-plan.md 는 제출본의 파생물이다 — 승인하는 사람과 구현하는 모델이 같은 것을 보게 코드가 렌더한다.
  const rendered = join(repoRoot, planDocFile(active.id));
  writeAtomic(rendered, renderPlanDoc(active.id, plan, requirements.assumptions));

  const assumptions = formatAssumptions(requirements.assumptions);
  return (
    `계획을 제출하고 ${planDocFile(active.id)} 를 렌더했습니다.\n\n${formatPlan(plan)}\n\n` +
    (assumptions ? `${assumptions}\n\n` : "") +
    testSpec.notes.map((note) => `참고: ${note}\n\n`).join("") +
    "사람이 **별도 터미널**에서 `code-agent approve` 를 실행해야 구현으로 넘어갑니다."
  );
}

// ---- approve / reject ----

export function decide(repoRoot: string, decision: Decision, comment?: string): string {
  const work = requireWork(repoRoot);
  const { active, order, manifest, plan } = work;
  if (!plan) {
    throw new Stop("제출된 계획이 없습니다.");
  }
  if (decision === "rejected" && !comment) {
    throw new Stop("반려에는 사유가 필요합니다: code-agent reject --comment \"사유\"");
  }

  // 확정되지 않은 문서 위의 계획은 승인하지 않는다 — 승인이 묶을 근거가 없다.
  requireDocs(repoRoot, work);
  // 제출과 승인 사이에도 작업 폴더는 쓸 수 있다 — 제출 때 지난 게이트를 다시 본다.
  // 여기서 안 보면 02·07 을 빈 파일로 덮은 상태의 docsHash 가 그대로 승인으로 굳는다 (승인 화면에는 계획만 보인다).
  const requirements = requireRequirements(repoRoot, active);
  const functional = functionalProblems(repoRoot, active.id, requirements.keys);
  requireWorkDocs([
    ...analysisProblems(repoRoot, active.id, requirements.keys),
    ...designProblems(repoRoot, active.id),
    ...functional.problems,
    ...testSpecProblems(repoRoot, active.id, functional.acceptance, manifest).problems,
  ]);
  const docsHash = approvalDocsHash(work);

  const state = approvalOf(work);
  const shown = [formatPlan(plan)];
  const assumptions = formatAssumptions(requirements.assumptions);
  if (assumptions) shown.push("", assumptions);
  if (state.status === "stale-plan" && state.diff.length > 0) {
    shown.push("", "이전 판정 이후 바뀐 곳:", formatDiff(state.diff));
  }
  const presence = confirmOnTerminal(shown.join("\n"), decision === "approved" ? "approve" : "reject");
  recordDecision(repoRoot, {
    order,
    target: active.target,
    plan,
    manifest,
    decision,
    approver: order.approver ?? userInfo().username,
    comment,
    presence,
    docsHash,
  });
  return decision === "approved"
    ? "승인을 원장에 남겼습니다. Claude Code 에서 /ca-next 로 구현을 시작하세요."
    : "반려를 원장에 남겼습니다. 계획을 고쳐 다시 제출해야 합니다.";
}
