import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { userInfo } from "os";

import { formatBoundary, formatDiff, hashPlan, manifestBoundary, recordDecision } from "../core/approval";
import type { ApprovalState, Decision } from "../core/approval";
import { collectExemplars, formatExemplars } from "../core/exemplar";
import { checkPaths, missingPlannedFiles } from "../core/gate";
import { stagesFor } from "../core/manifest";
import { errorLogProblems } from "../core/workOrder";
import type { Manifest, StageDef } from "../core/manifest";
import { formatPlan, missingPreserve, planFormatFor, planTasks, sequenceProblems } from "../core/plan";
import { businessRuleFiles, planningProblems, requiredOutputs } from "./planningState";
import { formatPlanIssues, planningDocumentProblems, planShapeProblems, reviewedPlanProblems } from "./planningValidation";
import { writeAtomic } from "../core/atomic";
import { checkProjectDocs, docPaths, docsReady, formatDocChecks } from "./docs";
import {
  AFTER_IMPLEMENT,
  canonical,
  clearActive,
  DOCS_SESSION_FILE,
  loadActive,
  logStage,
  PHASES,
  planFile,
  questionsFile,
  saveActive,
  workDocsDir,
} from "./layout";
import type { ActiveWork, Phase } from "./layout";
import { formatAnswerSources, openQuestions, writeAnswerBaseline } from "./answers";
import { hookInstallWarning, requireStartHooks } from "./init";
import { isGitRepo, switchToWorkBranch } from "./git";
import { requirePreparedBranch } from "./bootstrap";
import { commitOf, mergeBase } from "./tree";
import { prDocFile } from "./deliver";
import { proposalFile } from "./knowledge";
import {
  bindingProblems,
  collectWindowOpen,
  loadEvidence,
  outsideChanges,
  reproMissing,
  reviewRoundUsage,
  runsOf,
  stageProblems,
  testFrozen,
  testRoots,
  testStageFiles,
  trackedTestFiles,
  validationDocFile,
  verifyView,
} from "./evidence";
import type { VerifyPhase, VerifyView } from "./evidence";
import { budgetText, nextRoundDecision, verifyNode, verifyState, writeBlockReason } from "./retryPolicy";
import { docRefs, isTestPath, keywordsOf, rankCandidatesScan, relevantDocSections, requirementItems, type RankScan } from "./plugins/defaults";
import { MAX_ITEMS } from "./plugins/protocol";
import type { RequirementRef } from "./plugins/protocol";
import { callSlot, clamp, sourceLines } from "./plugins/run";
import {
  clearRequestSession,
  loadRequestSession,
  preparationHint,
  requestContext,
  requestDraftFile,
  requestHint,
  requestState,
  requestStateLine,
  requestStatusLines,
  requireRequestConfirmed,
  startBlockers,
} from "./request";
import { loadReview, reviewDocFile, reviewProblems, reviewStatusTail } from "./review";
import { crossStopStreak } from "./crossRecord";
import { KNOWLEDGE_KINDS } from "./schemas";
import { sourceFileScan, SURVEY_MAX_FILES } from "./survey";
import { Stop } from "./stop";
import { confirmOnTerminal } from "./tty";
import { approvalDocsState, approvalOf, loadManifestIfAny, loadWork, readOrder } from "./work";
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
import { formatSourceTrace, readSourceTrace, sourceItems } from "./sourceTrace";
import { aidlcBlock, aidlcWarning } from "./aidlc";
import { crossNotice } from "./hosts";
import { agentName, askVia, shellLabel, skill } from "./hostText";
import { PHASE_SKILL, reentryHint, staleEarliest } from "./reentry";
import { failureHint } from "./failureHint";
import { leaseLine } from "./lease";

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
 * `다음:` 줄의 머리 — 지금 이 칸 하나만 도는 스킬(reentry.ts PHASE_SKILL)과, 이어서 돌리는 사이클. 단계별로 나눠 두면 어디서
 * 어긋났는지 보고 그 칸만 다시 돌 수 있다. `ca-next` 는 같은 절차를 이어서 도는 사이클이라 결과가 같고, `deliver` 는 현재 세션에서
 * ca-answer의 동의 절차로 확인한 뒤 적용한다(스킬이 없다). 표기는 호스트별이다(hostText.skill).
 */
function stageCommand(phase: Exclude<Phase, "deliver">): string {
  return `${skill(PHASE_SKILL[phase])} (또는 ${skill("ca-next")} 로 사이클)`;
}

/** AI-DLC 가 진행 중이면 `다음:` 은 이 줄 하나다 — next·검증이 어차피 거부한다(requireNoAidlc) */
const AIDLC_HINT = "AI-DLC 작업이 진행 중이라 code-agent 를 진행하지 않습니다 — 위 AI-DLC 줄의 안내대로 정리한 뒤 이어갑니다";

/**
 * 모르는 스테이지는 옛 버전이 남긴 커서다 (P3 의 `research`). 조용히 다른 칸으로 옮겨 이어 가면
 * 그 작업의 문서가 어느 게이트를 지났는지 아무도 모른다 — 지우고 다시 시작하게 한다.
 */
function requirePhase(active: ActiveWork): void {
  if (!(PHASES as readonly string[]).includes(active.phase)) {
    throw new Stop(
      `알 수 없는 스테이지입니다: ${active.phase} (스테이지: ${PHASES.join(" → ")}).\n` +
        "현재 호스트 세션에서 ca-answer의 abort 동의 절차로 커서를 지우고 다시 시작하세요 — 작업 폴더의 문서는 그대로 남습니다.",
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
        "현재 호스트 세션에서 ca-answer의 abort 동의 절차로 커서를 지우고 다시 시작하세요 — 작업 폴더의 문서는 그대로 남습니다.",
    );
  }
}

function requireWork(repoRoot: string): Work {
  const work = loadWork(repoRoot);
  if (!work) {
    const session = loadRequestSession(repoRoot);
    throw new Stop(
      session
        ? `아직 작업이 시작되지 않았습니다 — ${session.id} 요구사항을 접수 중입니다.\n다음: ${requestStatusLines(repoRoot, session).hint}`
        : `진행 중인 작업이 없습니다. ${skill("ca-request")} [ID] <요구사항> 으로 접수부터 시작하세요. 신규·기능 변경은 ${skill("ca-feature")}, 결함 수정은 ${skill("ca-fix")}, 동작 보존은 ${skill("ca-refactor")} 로도 시작할 수 있습니다.`,
    );
  }
  requirePhase(work.active);
  requireBaseCommit(work.active);
  return work;
}

function requireDocs(repoRoot: string, work?: Work): void {
  const checks = checkProjectDocs(repoRoot, work?.manifest ?? loadManifestIfAny(repoRoot));
  if (!docsReady(checks)) {
    // 상태별로 나눈다 — 빠진 파일·절은 작성(ca-docs), 확정만 남았으면 사람의 동의(최초 준비면 setup)
    const missing = checks.some((entry) => entry.state === "missing-file" || entry.state === "missing-sections");
    throw new Stop(
      "프로젝트 필수 문서가 갖춰지지 않아 진행할 수 없습니다.\n" +
        `${formatDocChecks(checks)}\n` +
        (missing
          ? `${skill("ca-docs")} 로 작성하세요 (역공학 · 사용자 입력 · 기존 문서 연결).`
          : "공통 문서의 사람 확정이 필요합니다 — 현재 호스트 세션에서 ca-answer의 docs 동의 절차로 확정합니다 (최초 준비면 setup, 직접 CLI는 TTY의 code-agent confirm doc all)."),
    );
  }
}

function requireAnswers(repoRoot: string, active: ActiveWork): void {
  const { unanswered: open, unverified } = openQuestions(repoRoot, questionsFile(active.id));
  if (open.length > 0) {
    throw new Stop(
      `답이 없는 질문이 ${open.length}개 있어 넘어갈 수 없습니다 (${questionsFile(active.id)}):\n` +
        open.map((question) => `  - ${question.title}`).join("\n") +
        `\n메인은 ${skill("ca-answer")} 공통 절차의 ${askVia()} 답을 받아 기록하세요.`,
    );
  }
  if (unverified.length > 0) {
    // 답 출처 — 관찰된 질문 도구 응답과 맞거나, 접수 때 확정 화면에 실린 답이거나, 대화로 받았다고 밝힌 답만 받는다
    throw new Stop(
      `답의 출처를 확인할 수 없는 질문이 ${unverified.length}개 있어 넘어갈 수 없습니다 (${questionsFile(active.id)}):\n` +
        unverified.map((question) => `  - ${question.title}`).join("\n") +
        "\nhook 이 관찰한 질문 도구의 답이면 선택한 label(또는 직접 입력 원문)을 그대로 [Answer]: 에 적습니다. " +
        "hook 이 관찰하지 못하는 답(사용자가 대화로 직접 준 답, Codex 에서 받은 모든 답)은 그 원문을 적고 다음 줄에 [Source]: 대화 를 붙입니다. " +
        "모델이 정한 값은 답이 아닙니다 — 질문으로 받으세요.",
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
  requireWorkDocs(readSourceTrace(repoRoot, active.id, active.spec).problems);
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

/**
 * implement 가 실제로 도는 단계 — 계획에 파일이 있는 것만. 공통 모듈처럼 대부분의 작업에서 비는 단계에
 * 서브에이전트를 빈손으로 보내지 않는다.
 */
function plannedStages(work: Work): StageDef[] {
  if (!work.plan) return [];
  requireWorkDocs(sequenceProblems(work.plan, work.stages, work.order.kind));
  return work.plan.sequence.map((entry) => work.stages.find((stage) => stage.key === entry.step)!);
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

export function start(repoRoot: string, spec: string, startOptions: { target?: string; base?: string } = {}): string {
  if (existsSync(join(repoRoot, DOCS_SESSION_FILE))) {
    throw new Stop("문서 준비 세션이 열려 있습니다. code-agent docs end 뒤에 같은 요구사항으로 시작하세요.");
  }
  // 이미 시작한 같은 작업이면 상태만 보인다 — 진행 중인 작업을 hook 게이트로 붙잡지 않는다
  const started = loadActive(repoRoot);
  const hooks = started ? undefined : requireStartHooks(repoRoot);
  const aidlc = aidlcBlock(repoRoot);
  if (aidlc) throw new Stop(aidlc);
  const manifest = loadManifestIfAny(repoRoot);
  if (!manifest) {
    throw new Stop(`code-agent.json 이 없습니다. ${skill("ca-adopt")} 로 프로젝트를 먼저 도입하세요.`);
  }
  requireDocs(repoRoot);

  const specPath = toRepoPath(repoRoot, spec);
  const order = readOrder(repoRoot, specPath, manifest);
  const intake = loadRequestSession(repoRoot);
  if (intake && intake.id !== order.id) {
    throw new Stop(
      `접수 중인 요구사항이 있습니다: ${intake.id} (${intake.kind}). 그것을 끝내거나 현재 호스트 세션에서 ca-answer의 abort 동의 절차로 종료한 뒤 시작하세요.`,
    );
  }
  // 접수 때 사람이 말한 기준 브랜치 · 대상 — 확정을 사이에 두고 명령이 끊겨도 잃지 않는다. 지금 준 값이 이긴다
  const options = { base: startOptions.base ?? intake?.base, target: startOptions.target ?? intake?.target };
  const { target } = options;
  const chosen = target ?? order.target[0];
  if (!order.target.includes(chosen)) {
    throw new Stop(`지시서의 대상이 아닙니다: ${chosen} (대상: ${order.target.join(", ")})`);
  }
  stagesFor(manifest, order.kind);
  // 사람이 지금 내용으로 확정한 요구사항만 받는다 — 모델이 지시서를 지어내 스스로 시작하는 길이 여기서 닫힌다
  requireRequestConfirmed(repoRoot, order.id, specPath);

  const current = loadActive(repoRoot);
  if (current && (current.id !== order.id || current.target !== chosen)) {
    throw new Stop(
      `진행 중인 작업이 있습니다: ${current.id} (${current.target}, ${current.phase}). ` +
        "끝내거나 현재 호스트 세션에서 ca-answer의 abort 동의 절차로 종료한 뒤 시작하세요.",
    );
  }
  if (current) {
    return `이미 진행 중입니다: ${current.id} · ${PHASE_LABEL[current.phase]}\n\n${status(repoRoot)}`;
  }
  // 작업 하나는 대상 하나만 진행한다(FLOW-08) — 진행 중 확인 뒤라 대상 여럿인 지시서로 이미 시작한 작업은 위에서 그대로 잇고,
  // 브랜치 전환 앞이라 거부 때 아무것도 바뀌지 않는다. 확정 뒤 고쳐 다시 제출하면 지시서 해시가 바뀌어 사람이 다시 확정한다
  if (order.target.length > 1) {
    const draft = requestDraftFile(order.id);
    const fix = existsSync(join(repoRoot, draft))
      ? `${draft} 의 target 을 하나로 고쳐 code-agent request submit 으로 다시 제출하고 사람이 다시 확정하거나`
      : `지시서 ${specPath} 의 target 을 하나로 고치고 사람이 다시 확정하거나`;
    throw new Stop(`대상이 ${order.target.length}개입니다(${order.target.join(", ")}) — 작업 하나는 대상 하나만 진행합니다. ${fix}, 대상마다 별도 ID 로 접수하세요 (브랜치는 바꾸지 않았습니다).`);
  }
  // fix 는 오류 로그로 고친다 — 새로 시작할 때만 건다(이미 진행 중인 예전 작업은 그대로 잇는다)
  const missingLog = errorLogProblems(order.kind, readFileSync(join(repoRoot, specPath), "utf-8"));
  if (missingLog.length > 0) throw new Stop(`${specPath}: ${missingLog.map((problem) => problem.detail).join("\n")}`);

  // 작업 브랜치 — 기준은 사용자 입력(--base) > code-agent.json 의 git.base > master
  let branch: string | undefined;
  let base: string | undefined;
  let baseCommit: string | undefined;
  let branchNote = "git 저장소가 아니라 작업 브랜치를 만들지 않았습니다.";
  if (isGitRepo(repoRoot)) {
    base = options.base ?? manifest.git.base;
    branch = `${order.kind}/${order.id}`;
    requirePreparedBranch(repoRoot, branch, base);
    // 새 작업 브랜치를 딸 때만 미커밋 변경을 본다(FLOW-07) — git switch -c 는 변경을 데려가 첫 검증의 '계획 밖 변경'이 되거나
    // 반영 커밋에 섞인다. 이미 있는 브랜치는 중단 뒤 재시작이라 그 작업의 변경이 남아 있을 수 있다
    if (!commitOf(repoRoot, branch)) {
      const blockers = startBlockers(repoRoot, order.id, specPath);
      if (blockers.length > 0) {
        throw new Stop([
          "작업 트리에 커밋하지 않은 변경이 있어 시작하지 않았습니다 (브랜치는 바꾸지 않았습니다):",
          ...blockers.slice(0, 10).map((change) => `  - [${change.status}] ${change.path}`),
          ...(blockers.length > 10 ? [`  - 외 ${blockers.length - 10}개`] : []),
          "이대로 시작하면 이 변경이 새 작업 브랜치로 따라가, 계획 승인 뒤 첫 검증에서 '계획 밖 변경'으로 막히거나 계획 파일과 겹치면 무관한 수정이 반영 커밋에 섞입니다.",
          "사람이 커밋·stash 하거나 되돌린 뒤 같은 명령으로 다시 시작합니다 (모델은 파일을 되돌리지 않습니다).",
        ].join("\n"));
      }
    }
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
        "<!-- 질문은 `## Q<번호> · <스테이지>` 로 시작하고, 답은 `[Answer]:` 뒤에 적는다. hook 이 관찰하지 못한 답(대화로 받은 답, Codex 에서 받은 답)은 `[Answer]:` 다음 줄에 `[Source]: 대화` 를 둔다. 답이 없으면 다음으로 넘어가지 않는다. -->\n",
    );
  }
  // 답 출처 판정의 시작 행 — 이미 답이 있던 질문은 확정 지시서의 "접수 때 정한 것"과 같을 때만 접수 답으로 본다
  writeAnswerBaseline(repoRoot, order.id, specPath);
  saveActive(repoRoot, { id: order.id, spec: specPath, target: chosen, phase: "analysis", branch, base, baseCommit, planningVersion: 1 }, "start");
  // 접수는 끝났다 — 이제부터는 작업 커서가 hook 의 판정을 맡는다
  if (intake) clearRequestSession(repoRoot);
  return `시작했습니다: ${order.id} · ${order.title} (${order.kind}, 대상 ${chosen})\n${branchNote}\n\n${status(repoRoot)}${hooks ? `\n\n${hooks}` : ""}`;
}

// ---- status ----

/**
 * check·test 의 한도 소진 줄 — **증거로** 판정한다(check() 직접 호출에는 verify 기록이 없고, 사람이 회차를 허용한 뒤에는
 * 마지막 verify 기록의 한도 줄이 낡는다). 다음 회차가 거부되거나(writeBlockReason 과 같은 판정) 노드가 decision 이면
 * 카운터별 문구를 낸다. 한도 줄은 이 자리 하나다.
 */
export function verifyLimitHint(work: Work): string | undefined {
  const evidence = loadEvidence(work.repoRoot, work.active.id, work.active.target);
  if (!evidence || !work.plan || evidence.planHash !== hashPlan(work.plan)) return undefined;
  const view = verifyView(work, evidence);
  if (writeBlockReason({ state: view.state, emptyRound: view.emptyRound, budget: view.budget, path: "", questionsPath: questionsFile(work.active.id) })) {
    return exhaustedHint(view, work.active.id);
  }
  const phase = work.active.phase === "test" ? "test" : "check";
  const state = verifyState({ phase, round: evidence.rounds, runs: evidence.runs, cases: phase === "test" ? evidence.testCases : undefined });
  if (state !== "passed" && state !== "precondition" && verifyNode(state, view.budget) === "decision") return exhaustedHint(view, work.active.id, state);
  return undefined;
}

/** 카운터별 한도 소진 문구 — 고쳐 쓰기 한도 문구는 이 자리 하나다 */
function exhaustedHint(view: VerifyView, id: string, state?: string): string {
  const questions = questionsFile(id);
  // 막은 카운터 — 고쳐도 다음 회차가 거부되면 그 카운터, 아니면 같은 코드 재실행(노드가 decision)
  const next = nextRoundDecision({ previous: view.state, emptyRound: view.emptyRound, treeChanged: true, budget: view.budget,
    reviewOpenFindings: view.budget.reviewRounds.used > 0 });
  const key = next.action === "refuse" && next.failure.counter && !(state === "environment" || state === "interrupted")
    ? next.failure.counter.key : "rerun";
  switch (key) {
    case "fix":
      return `고쳐 쓰기 ${view.budget.fix.limit}회를 넘겨 막혔습니다 — 계획 파일은 더 고칠 수 없습니다. ${questions} 에 적고 사람에게 보고하세요`;
    case "reviewRounds":
      return `리뷰 회차 한도 ${view.budget.reviewRounds.limit}회를 모두 써서 막혔습니다 — 남은 지적은 사람이 판단합니다. ${questions} 에 적고 보고하세요`;
    case "totalRounds":
      return `검증 회차가 총 ${view.budget.totalRounds.limit}회에 닿아 막혔습니다 — ${questions} 에 적고 사람에게 보고하세요`;
    default:
      return `같은 코드 재실행 ${view.budget.rerun.limit}회를 모두 썼습니다 — 환경을 사람이 확인해야 합니다. 막힌 이유를 보고하세요`;
  }
}

/**
 * `다음:` 한 줄. 판정 순서(위가 먼저): AI-DLC 차단 → 요구 미확정 → 미응답 질문 → 승인 무효(implement 이후, 재진입 순서) →
 * 검증 한도(check·test, 증거 기반) → 원천이 `다음:` 에 닿지 않는 실패(failureHint — 관찰 흐름의 배정 실패·고아, deliver 동의 실패) →
 * 스테이지별 문구. 원인별 안내는 원인을 판정한 모듈이 렌더한 문구다 — 검증은 아래 check·test 갈래, 리뷰·교차는 reviewProblems 첫 줄,
 * 계획 배정은 planning advance. 같은 상태에서 직전 명령과 무관하게 같은 줄이다(증거·기록만 본다).
 * 이 순서를 바꾸면 ca-next 의 '멈춘 자리별 재개' 표도 함께 고친다.
 */
function nextHint(work: Work): string {
  const { repoRoot, active } = work;
  if (aidlcBlock(repoRoot)) return AIDLC_HINT;
  if (requestState(repoRoot, active.id, active.spec).status !== "confirmed") {
    return requestHint(repoRoot, active.id, active.spec);
  }
  const questions = openQuestions(repoRoot, questionsFile(active.id));
  const open = questions.unanswered.length + questions.unverified.length;
  if (open > 0) {
    return `답이 없거나 출처를 확인할 수 없는 질문 ${open}개 — ${skill("ca-answer")}`;
  }
  if (work.plan && PHASES.indexOf(active.phase) > PHASES.indexOf("plan")) {
    const reentry = reentryHint(work);
    if (reentry) return reentry;
  }
  // 한도 줄은 verifyLimitHint 한 곳에서만 낸다 — 증거가 정본이다(check 직접 호출에는 verify 기록이 없다)
  if (active.phase === "check" || active.phase === "test") {
    const limited = verifyLimitHint(work);
    if (limited) return limited;
  }
  const failed = failureHint(work);
  if (failed) return failed;
  const dir = workDocsDir(active.id);
  switch (active.phase) {
    case "analysis":
    case "impact":
    case "design":
      // 관찰 흐름은 담당 배정이 먼저다 — 문서를 메인이 쓰지 않는다
      return active.planningVersion
        ? `${stageCommand(active.phase)} — code-agent planning advance 로 담당을 배정하고, 결과가 기록돼 action 이 ready-for-gate 면 code-agent next`
        : `${stageCommand(active.phase)} — ${PHASE_LABEL[active.phase]}(${dir}/ 의 번호 문서)을 마치면 code-agent next`;
    case "plan": {
      if (!work.plan) {
        return active.planningVersion
          ? `${stageCommand("plan")} — code-agent planning advance 로 계획·검토 담당을 배정하고, 관찰된 결과로 ${dir}/plan.json 이 생기면 code-agent plan submit ${dir}/plan.json`
          : `${stageCommand("plan")} — 계획 초안을 ${dir}/plan.json 에 쓰고 code-agent plan submit ${dir}/plan.json`;
      }
      const approval = approvalOf(work);
      if (approval.status === "approved") {
        return `승인됨 — code-agent next 로 넘긴 뒤 ${stageCommand("implement")}`;
      }
      // 반려는 다시 내라는 뜻이 아니라 다시 보라는 뜻이다 — 사유가 어느 문서를 가리키는지부터 읽게 한다
      if (approval.status === "rejected") {
        return (
          `${stageCommand("plan")} — 반려됐습니다: ${approval.record.comment ?? "(사유 없음)"} — ` +
          `사유가 가리키는 문서(01~04 · 07 · plan.json)를 다시 보고, 정할 수 없는 것은 ${questionsFile(active.id)} 에 질문으로 남긴 뒤 다시 제출하세요`
        );
      }
      // 승인 뒤 무효가 됐고 낡은 계획 작업이 있으면(관찰 흐름) 재진입 순서 — 그대로 다시 승인해도 next 의 계획 게이트가 막는다
      if (approval.status !== "none" && staleEarliest(work)) return reentryHint(work, approval) ?? "";
      return `현재 호스트 세션에서 ca-answer의 plan 동의 절차로 확인하고 적용 뒤 ca-next 흐름을 자동으로 이어갑니다 (현재: ${approval.status})`;
    }
    case "implement":
      return `${stageCommand("implement")} — 단계 ${active.stage} 를 구현한 뒤 code-agent next`;
    case "check":
    case "test": {
      // 판정·원인·한도 문구의 원천은 증거 기반 갈래 하나다(한도 줄은 위 verifyLimitHint). 진입 명령은 verify(전체 흐름)다 —
      // 원인별 재개(--retry 여부)는 verify 결과의 failure.guide 가 알려 준다
      const evidence = loadEvidence(repoRoot, active.id, active.target);
      if (!evidence) {
        return `${stageCommand(active.phase)} — code-agent verify --json (전체 흐름 · 단계만 돌릴 때는 code-agent ${active.phase})`;
      }
      const view = verifyView(work, evidence);
      const failed = runsOf(evidence, active.phase).filter((run) => run.outcome !== "passed");
      if (failed.length === 0 && runsOf(evidence, active.phase).length > 0) {
        return `검증 통과 — code-agent next 로 넘긴 뒤 ${stageCommand(active.phase === "check" ? "test" : "review")}`;
      }
      const state = verifyState({ phase: active.phase, round: evidence.rounds, runs: evidence.runs, cases: active.phase === "test" ? evidence.testCases : undefined });
      const node = state === "precondition" || state === "passed" ? "diagnose" : verifyNode(state, view.budget);
      return `${stageCommand(active.phase)} — ${failed.map((run) => `${run.kind}(${run.outcome})`).join(", ") || "아직 돌리지 않음"} — ` +
        `${node === "repair" ? "계획 안에서 고치고" : "원인을 확인하고"} code-agent verify --json (${budgetText(view.budget)})`;
    }
    case "review": {
      const problems = reviewProblems(work);
      return problems.length === 0
        ? `리뷰가 닫혔습니다 — code-agent next 로 넘긴 뒤 ${stageCommand("integrate")}`
        : `${stageCommand("review")} — ${problems[0]}${problems.length > 1 ? ` (외 ${problems.length - 1}건)` : ""}`;
    }
    case "integrate": {
      const evidence = loadEvidence(repoRoot, active.id, active.target);
      return evidence && runsOf(evidence, "integrate").length > 0 && stageProblems(work, "integrate").length === 0
        ? "통합 검증 통과 — code-agent next 로 넘긴 뒤 현재 호스트 세션에서 ca-answer의 deliver 동의 절차로 확인하고 반영합니다"
        : `${stageCommand("integrate")} — code-agent integrate (기준 커밋 위의 깨끗한 worktree 에서 전체 build · test)`;
    }
    case "deliver":
      // 사람이 반영 단계에서 계획 파일·경계 선언을 고쳐 증거 묶임이 깨졌으면 반영 게이트가 막는다 — 돌아갈 길을 먼저 보인다
      // (verify·check 는 이때만 deliver 에서도 check 로 되감는다 — requireValidatable)
      if (evidenceBroken(work)) {
        return `${stageCommand("check")} — 반영할 트리가 검증 뒤 바뀌었습니다(증거가 지금 계획 파일·code-agent.json·기준 커밋과 맞지 않습니다). ` +
          "code-agent verify --json 이 check 로 되감아 다시 검증합니다 — 바꾼 것을 되돌리려면 사람이 되돌립니다";
      }
      return `현재 호스트 세션에서 ca-answer의 deliver 동의 절차로 확인하고 반영합니다 — ${prDocFile(active.id)} 의 요약·확인 방법·위험을 먼저 쓰세요`;
  }
}

export function status(repoRoot: string): string {
  const manifest = loadManifestIfAny(repoRoot);
  const checks = checkProjectDocs(repoRoot, manifest);
  const lines = [`code-agent — ${repoRoot}`, "", "프로젝트 문서:", formatDocChecks(checks)];
  const aidlc = aidlcBlock(repoRoot) ?? aidlcWarning(repoRoot);
  if (aidlc) lines.push("", aidlc);
  const cross = crossNotice(repoRoot);
  if (cross) lines.push("", cross);
  const hookWarning = hookInstallWarning(repoRoot);
  if (hookWarning) lines.push("", `hook: ${hookWarning}`);
  if (cross) {
    // 실행 불가 중지가 이어지면 다른 호스트의 설치·로그인·한도 문제일 수 있다 — 설정 오류는 중지가 아니라 게이트를 막는다
    const streak = crossStopStreak(repoRoot);
    if (streak.count >= 2) {
      lines.push(`교차 검증: 최근 ${streak.count}개 지점이 연속 중지로 기록됐습니다(마지막: ${streak.last?.host ?? "?"} — ${(streak.last?.detail ?? "").replace(/\s+/g, " ").slice(0, 80)}) — 다른 호스트의 설치·로그인·사용 한도를 확인하세요. 설정 오류는 중지가 아니라 게이트를 막습니다.`);
    }
  }

  const work = loadWork(repoRoot);
  if (!work) {
    const session = loadRequestSession(repoRoot);
    if (session) {
      const intake = requestStatusLines(repoRoot, session);
      lines.push("", "작업: 아직 시작 전", ...intake.lines);
      lines.push(`다음: ${intake.hint}`);
      return lines.join("\n");
    }
    lines.push("", "작업: 없음", `다음: ${idleHint(repoRoot, manifest)}`);
    return lines.join("\n");
  }

  const { active, order } = work;
  requirePhase(active);
  const flow = PHASES.map((phase) => (phase === active.phase ? `[${phase}]` : phase)).join(" → ");
  const { unanswered: open, unverified } = openQuestions(repoRoot, questionsFile(active.id));
  lines.push(
    "",
    `작업: ${order.id} · ${order.title} (${order.kind}, 대상 ${active.target})`,
    `지시서: ${active.spec}`,
    requestStateLine(repoRoot, active.id, active.spec),
    `작업 폴더: ${workDocsDir(active.id)}/`,
    `계획 처리: ${active.planningVersion ? "관찰 흐름 — code-agent planning status" : "기존 작업 호환 흐름"}`,
    `브랜치: ${active.branch ? `${active.branch} (기준 ${active.base})` : "없음"}`,
  );
  // 작업 임대(동시 진행 방지) — 이 작업을 진행 중인 세션
  const lease = leaseLine(work);
  if (lease) lines.push(lease);
  lines.push(`스테이지: ${PHASE_LABEL[active.phase]} — ${flow}`);
  if (active.phase === "implement") {
    const keys = plannedStages(work).map((stage) => (stage.key === active.stage ? `[${stage.key}]` : stage.key));
    lines.push(`단계: ${keys.join(" → ")}`);
  }
  lines.push(`질문: ${open.length === 0 ? "답 없는 질문 없음" : open.map((q) => q.id).join(", ") + " 답 없음"}${unverified.length ? ` · ${unverified.map((q) => q.id).join(", ")} 답 출처 미확인` : ""}`);
  if (work.plan) {
    const approval = approvalOf(work).status;
    lines.push(`계획: 제출됨 · 승인 ${approval}`);
    const verified = active.phase === "deliver" && approval === "approved" &&
      stageProblems(work, "integrate").length === 0 && reviewProblems(work).length === 0;
    const tasks = planTasks(work.plan);
    const cursor = tasks.findIndex((task) => active.task ? task.id === active.task : task.stage === active.stage);
    lines.push("작업 Task (완료는 검증·리뷰 뒤 최종 확인):", ...tasks.map((task, index) => {
      const state = active.phase === "implement" ? (index < cursor ? "구현됨·검증 대기" : index === cursor ? "진행 중" : "대기")
        : AFTER_IMPLEMENT.includes(active.phase) ? (verified ? "검증됨·반영 대기" : "검증 중") : "대기";
      return `  - ${task.id} ${task.stage}: ${state} · ${task.requirements.join(", ")}`;
    }));
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
        `리뷰: ${last ? `${last.round}회차 · 기준 트리 ${last.treeHash.slice(-12)} (${reviewDocFile(active.id)})${reviewStatusTail(work, review!, last)}` : "회차 없음 — code-agent review"}`,
      );
    }
  }
  // 계획 밖 변경은 모든 스테이지에 낸다(FLOW-07) — analysis~plan 은 계획 파일이 없어 작업 폴더 밖 변경이 전부 나온다
  // (그 단계에서 모델은 작업 폴더 밖을 쓸 수 없으므로 사람·외부 도구의 변경이다)
  const outside = outsideChanges(work);
  if (outside.length > 0) {
    lines.push(`계획 밖 변경: ${outside.map((change) => `[${change.status}] ${change.path}`).join(", ")}`);
  }
  lines.push(`다음: ${nextHint(work)}`);
  return lines.join("\n");
}

/**
 * 처리 주체가 없는 상태(FLOW-13)의 `다음:` — AI-DLC 차단, 문서 세션(매니페스트가 아직 없어도 — ca-adopt 도중), 매니페스트 없음,
 * 준비 동의(preparationHint 가 고른다) 순으로 본다. 문서 세션 중에는 request begin 이 거부되므로 접수 안내를 내지 않는다
 */
function idleHint(repoRoot: string, manifest: Manifest | undefined): string {
  return aidlcBlock(repoRoot) ? AIDLC_HINT
    : !manifest && !existsSync(join(repoRoot, DOCS_SESSION_FILE))
      ? `${skill("ca-request")} <요구사항> 으로 접수 — ID는 자동 발급하고 공통 문서 준비부터 이어갑니다 (${skill("ca-adopt")})`
      : preparationHint(repoRoot, false) ??
        `${skill("ca-request")} [ID] <요구사항> 으로 접수 — 신규·기능 변경은 ${skill("ca-feature")}, 결함 수정은 ${skill("ca-fix")}, 동작 보존은 ${skill("ca-refactor")} 로도 시작`;
}

/**
 * `status` 의 `다음:` 줄 값과 스테이지 — 동의 적용 결과(`consent finish`)가 같은 값을 돌려줘 메인이 status 를 다시 부르지 않는다.
 * 작업이 있으면 `requirePhase` 를 지나야 하므로 예외가 날 수 있다(부르는 쪽이 잡는다).
 */
export function nextStep(repoRoot: string): { phase?: Phase; next: string } {
  const work = loadWork(repoRoot);
  if (!work) {
    const session = loadRequestSession(repoRoot);
    if (session) return { next: requestStatusLines(repoRoot, session).hint };
    return { next: idleHint(repoRoot, loadManifestIfAny(repoRoot)) };
  }
  requirePhase(work.active);
  return { phase: work.active.phase, next: nextHint(work) };
}

// ---- next ----

/** 작업 도중 AI-DLC 가 시작됐으면 다음 단계·검증으로 넘어가지 않는다 */
function requireNoAidlc(repoRoot: string): void {
  const aidlc = aidlcBlock(repoRoot);
  if (aidlc) throw new Stop(aidlc);
}

export function next(repoRoot: string): string {
  requireNoAidlc(repoRoot);
  const work = requireWork(repoRoot);
  const { active } = work;
  requireDocs(repoRoot, work);
  requireRequestConfirmed(repoRoot, active.id, active.spec);
  requireAnswers(repoRoot, active);

  if (["analysis", "impact", "design", "plan"].includes(active.phase)) requireWorkDocs([...planningProblems(work, active.phase as "analysis" | "impact" | "design" | "plan"), ...planningDocumentProblems(work, active.phase)]);
  // implement 이후의 승인 무효는 스테이지 게이트보다 먼저 재진입 순서로 멈춘다 — status 의 다음:(nextHint)·requireValidatable·
  // hook 쓰기 거부와 같은 문장이다. 게이트 문제 목록의 승인 줄(… check 로 다시 돌리세요)을 따르면 한 번 돌아가는 길이 생긴다
  if (PHASES.indexOf(active.phase) > PHASES.indexOf("plan")) {
    const approval = approvalOf(work);
    if (approval.status !== "approved") throw new Stop(`계획이 승인되지 않았습니다 (${approval.status}). ${reentryHint(work, approval) ?? ""}`);
  }
  const advance = (phase: Phase, stage?: string, task?: string): string => {
    saveActive(repoRoot, { ...active, phase, stage, task }, "next");
    return status(repoRoot);
  };

  switch (active.phase) {
    case "analysis":
      requireRequirements(repoRoot, active);
      return advance("impact");
    case "impact": {
      const { keys } = requireRequirements(repoRoot, active);
      requireWorkDocs(analysisProblems(repoRoot, active.id, keys, work.order.kind, active.spec));
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
      requireRequirements(repoRoot, active);
      requireWorkDocs(reviewedPlanProblems(work));
      if (!work.plan) {
        throw new Stop("제출된 계획이 없습니다. code-agent plan submit <초안> 으로 제출하세요.");
      }
      const approval = approvalOf(work);
      if (approval.status !== "approved") {
        throw new Stop(`계획이 승인되지 않았습니다 (${approval.status}). 현재 호스트 세션에서 ca-answer의 plan 동의 절차로 확인하고 적용 뒤 ca-next 흐름을 자동으로 이어갑니다.`);
      }
      return advance("implement", plannedStages(work)[0]?.key, work.plan.tasks?.[0]?.id);
    }
    case "implement": {
      requireRequirements(repoRoot, active);
      const stages = plannedStages(work);
      const index = stages.findIndex((stage) => stage.key === active.stage);
      if (index < 0) throw new Stop("현재 구현 단계가 승인된 순서에 없습니다. code-agent back plan 으로 돌아가 계획을 확인하세요.");
      const stage = stages[index];
      if (work.plan?.tasks) {
        const taskIndex = work.plan.tasks.findIndex(task => task.id === active.task);
        const task = work.plan.tasks[taskIndex];
        if (!task || task.stage !== active.stage) throw new Stop("현재 구현 Task가 승인된 계획에 없습니다. back plan으로 돌아가세요.");
        const missing = task.files.filter(file => !existsSync(join(repoRoot, file)));
        if (missing.length) throw new Stop(`Task ${task.id}의 계획 파일이 아직 없습니다: ${missing.join(", ")}`);
        const following = work.plan.tasks[taskIndex + 1];
        if (following?.stage === stage.key) return advance("implement", stage.key, following.id);
      }
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
      // 재현은 hook 도 막지만, 거부는 모델이 **엉뚱한 자리**(다음 단계에서 고칠 파일을 쓰려 할 때)에
      // 도착한다. 경계에서 바로 말해 준다.
      if (stage && stage.kind === "test" && work.order.kind === "fix") {
        const missing = reproMissing(work, loadEvidence(repoRoot, active.id, active.target));
        if (missing) {
          throw new Stop(`${missing} — code-agent repro 로 지금 코드에서 재현 TC 가 실패하는 것을 보고 넘어가세요.`);
        }
      }
      const following = stages[index + 1];
      return following ? advance("implement", following.key, work.plan?.tasks?.find(task => task.stage === following.key)?.id) : advance("check", undefined);
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
      // 반영은 사용자 동의 뒤 적용한다 — next 로 끝낼 수 없고, deliver 가 커밋 뒤 커서를 지운다
      throw new Stop(
        `반영은 현재 호스트 세션에서 ca-answer의 deliver 동의 절차로 확인한 뒤 로컬 커밋합니다 (직접 CLI를 원하면 TTY에서 code-agent deliver).\n` +
          `${prDocFile(active.id)} 의 요약·확인 방법·위험·되돌리기를 먼저 쓰세요 — 추적표·검증·변경 요약은 코드가 렌더합니다.`,
      );
  }
}

/**
 * 수정 루프가 `check` 로 되감을 수 있는 자리 — 검증 실패·지적이 나는 스테이지들.
 *
 * `deliver` 는 넣지 않는다. 거기는 사용자가 반영할 내용을 확인하는 자리라, 증거가 지금 트리와 맞는데 모델이 부른 `check`
 * 한 번에 커서가 뒤로 가면 사람이 보던 화면이 조용히 무효가 된다. 증거 묶임이 이미 깨졌을 때(`evidenceBroken` — 사람이
 * 계획 파일·경계·계획을 바꿨다)만 deliver 에서도 check 로 되감는다 — 그때는 반영 게이트가 어차피 막아 막다른 자리가 된다.
 * 사용자가 반영 전에 수정을 요청하면 `back` 으로 되감는다(사용자 지시 — 스킬 규칙).
 */
const REWINDABLE: readonly Phase[] = ["test", "review", "integrate"];

/** 증거가 있고 그 묶임(기준 커밋·계획 파일 트리·매니페스트·계획 해시)이 지금과 맞지 않는가 — 계획 밖 변경만이면 되감아도 풀리지 않아 넣지 않는다 */
function evidenceBroken(work: Work): boolean {
  const evidence = loadEvidence(work.repoRoot, work.active.id, work.active.target);
  return !!evidence && bindingProblems(work, evidence).length > 0;
}

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
  requireNoAidlc(repoRoot);
  let work = requireWork(repoRoot);
  requireDocs(repoRoot, work);
  requireRequestConfirmed(repoRoot, work.active.id, work.active.spec);
  requireRequirements(repoRoot, work.active);
  requireAnswers(repoRoot, work.active);
  if (phase === "check" && (REWINDABLE.includes(work.active.phase) || (work.active.phase === "deliver" && evidenceBroken(work)))) {
    saveActive(repoRoot, { ...work.active, phase: "check", stage: undefined }, "next");
    work = requireWork(repoRoot);
  }
  if (work.active.phase !== phase) {
    throw new Stop(
      `${PHASE_LABEL[phase]}(${phase}) 스테이지에서 돌립니다 (지금: ${work.active.phase}).\n` +
        (phase === "check" && work.active.phase === "deliver"
          ? "반영 단계에서는 검증을 다시 돌리지 않습니다 — 증거가 지금 트리와 맞습니다. 고칠 것이 있으면 사용자 확인 뒤 code-agent back check.\n"
          : "") +
        nextHint(work),
    );
  }
  const approval = approvalOf(work);
  if (approval.status !== "approved") {
    throw new Stop(
      `계획이 승인되지 않았습니다 (${approval.status}). 승인 위에서 나지 않은 검증 결과는 증거가 아닙니다.\n${reentryHint(work, approval) ?? ""}`,
    );
  }
  return work;
}

/**
 * `code-agent repro` 의 전제 — fix 의 implement 스테이지에서만, 승인된 계획 위에서만 돈다.
 * 승인 위에서 나지 않은 재현은 나중에 계획이 바뀌면 무엇에 대한 재현이었는지 알 수 없다.
 */
export function requireReproable(repoRoot: string): Work {
  const work = requireWork(repoRoot);
  requireDocs(repoRoot, work);
  requireRequestConfirmed(repoRoot, work.active.id, work.active.spec);
  requireAnswers(repoRoot, work.active);
  if (work.order.kind !== "fix") {
    throw new Stop(`code-agent repro 는 fix 작업에서만 돕니다 (지금: ${work.order.kind}).`);
  }
  if (!["implement", "check", "test", "review", "integrate"].includes(work.active.phase)) {
    throw new Stop(`재현은 구현·재검증 중에 돕니다 (지금: ${work.active.phase}).\n${nextHint(work)}`);
  }
  const approval = approvalOf(work);
  if (approval.status !== "approved") {
    throw new Stop(`계획이 승인되지 않았습니다 (${approval.status}). 승인 위에서 나지 않은 재현은 증거가 아닙니다.\n${reentryHint(work, approval) ?? ""}`);
  }
  return work;
}

/** 증거가 없거나 지금 트리를 가리키지 않거나 하나라도 통과가 아니면 넘어가지 않는다 */
// `repro` 는 스테이지가 아니라 implement 안에서 도는 자리라 여기 오지 않는다
function requireEvidence(work: Work, phase: Exclude<VerifyPhase, "repro">): void {
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
    const session = loadRequestSession(repoRoot);
    if (session) {
      logStage(repoRoot, { id: session.id, target: "", phase: "request" }, "abort");
      clearRequestSession(repoRoot);
      return `요구사항 접수를 닫았습니다: ${session.id}. 작업 폴더(${workDocsDir(session.id)}/)와 확정 원장은 남아 있습니다 — 같은 ID 로 다시 접수할 수 있습니다.`;
    }
    throw new Stop("진행 중인 작업도 접수 중인 요구사항도 없습니다.");
  }
  logStage(repoRoot, active, "abort");
  clearActive(repoRoot);
  return `작업 커서를 지웠습니다: ${active.id}. 작업 폴더·계획·원장은 남아 있습니다 — 같은 지시서로 다시 시작할 수 있습니다.`;
}

// ---- back ----

/**
 * `code-agent back` 이 받는 스테이지. `deliver` 는 없다 — 마지막 칸이라 되감아 갈 자리가 아니다.
 */
export const BACK_PHASES: readonly Phase[] = PHASES.filter((phase) => phase !== "deliver");

/** 되감으면 무엇이 무효가 되는가 — 무엇을 다시 해야 하는지까지 적는다 */
function backNotes(to: Phase, from: Phase): string[] {
  const notes = [
    "증거(⑧) · 리뷰 회차(⑨) · 승인 원장 · 작업 문서는 그대로 둡니다 — 커서만 옮겼습니다.",
    "검증 회차와 재시도 카운터는 planHash 에 묶여 있어 되감아도 줄지 않습니다. 계획을 재승인해야 처음부터 셉니다.",
  ];
  if (to === "analysis" || to === "impact" || to === "design") {
    notes.push(
      "01~04 · 07 을 고치면 승인이 무효가 됩니다(stale-docs) — 계획을 다시 제출하고 사람이 다시 승인해야 코드를 쓸 수 있습니다.",
    );
  }
  if (to === "plan") {
    notes.push(
      "계획을 바꿔 제출하면 재승인이 필요합니다. 같은 문서 위에서 같은 계획을 다시 제출하면 승인은 그대로입니다.",
    );
  }
  if (from === "deliver") {
    notes.push(
      "반영 확인(deliver 동의)을 준비해 두었다면 그 동의는 대상이 바뀌어 적용되지 않습니다 — 되감은 칸부터 검증·리뷰·통합을 다시 지나 반영 단계에 오면 새로 준비합니다.",
    );
  }
  notes.push("앞으로 가는 길은 code-agent next 뿐입니다 — 게이트를 다시 전부 지나야 합니다.");
  return notes;
}

/**
 * 커서를 **앞 스테이지로만** 되감는다. 단계별 스킬이 어긋난 칸 하나를 다시 돌 수 있게 하는 자리다.
 *
 * 앞으로 가지 못하게 막는 이유는 하나다 — 건너뛸 수 있으면 나머지 게이트가 전부 장식이 된다.
 * 지우는 것도 없다. 증거·리뷰 회차·승인 원장·문서를 그대로 두고 커서만 옮기므로, 되감았다고
 * 앞 스테이지의 통과가 되살아나거나 고쳐 쓰기 회차가 줄지 않는다 (전부 해시에 묶여 있다).
 */
export function back(repoRoot: string, to: string): string {
  const work = requireWork(repoRoot);
  const { active } = work;
  // deliver 에서도 사용자 지시가 있으면 되감는다 — 반영 전에 고칠 것이 생기면 수정 루프로 돌아가는 유일한 길이다.
  // 준비해 둔 deliver 동의는 스냅샷 대조(consent.ts requireConsentSnapshot)가 무효로 만든다. "사용자 지시 시에만"은 스킬 규칙이다
  if (!(BACK_PHASES as readonly string[]).includes(to)) {
    throw new Stop(`되감을 수 없는 스테이지입니다: ${to || "(없음)"} — 받는 값: ${BACK_PHASES.join(" | ")}`);
  }
  const target = to as Phase;
  if (PHASES.indexOf(target) >= PHASES.indexOf(active.phase)) {
    throw new Stop(
      `back 은 뒤로만 갑니다 (지금 ${active.phase}, 받은 값 ${target}). ` +
        "앞으로 가는 길은 code-agent next 뿐입니다 — 게이트를 건너뛰는 자리가 아닙니다.",
    );
  }
  // implement 로 되감으면 계획의 첫 단계부터 — 단계 키가 비면 hook 이 지금 단계를 찾지 못해 쓰기를 전부 막는다
  const stage = target === "implement" ? plannedStages(work)[0]?.key : undefined;
  saveActive(repoRoot, { ...active, phase: target, stage, task: target === "implement" ? work.plan?.tasks?.[0]?.id : undefined }, "back");
  return (
    `커서를 ${PHASE_LABEL[active.phase]}(${active.phase}) 에서 ${PHASE_LABEL[target]}(${target}) 로 되감았습니다.\n` +
    backNotes(target, active.phase)
      .map((note) => `  - ${note}`)
      .join("\n") +
    `\n\n${status(repoRoot)}`
  );
}

// ---- context ----

/**
 * 지금 스테이지에 필요한 것만. 모델이 저장소를 헤매지 않게 코드가 골라 준다 —
 * 참조 코드는 매니페스트대로 결정론적으로 읽고, 긴 문서는 경로만 준다.
 */
/** 순위는 20개, 문서 절은 10개 — 컨텍스트에 넣을 값이 있는 만큼만 */
const CANDIDATE_LIMIT = 20;
const DOC_SECTION_LIMIT = 10;

/** `candidates.rank` — 요구 항목과 관련된 파일 순위 */
function candidateLines(repoRoot: string, manifest: Manifest, items: RequirementRef[], keywords: string[]): string[] {
  const { files, truncated } = sourceFileScan(repoRoot);
  // 플러그인에는 상한(MAX_ITEMS)까지만 간다 — 잘려도 소스가 남도록 테스트가 아닌 파일을 먼저 둔다
  const ordered = [...files.filter((file) => !isTestPath(file.path)), ...files.filter((file) => isTestPath(file.path))];
  let scan = undefined as RankScan | undefined;   // 기본 구현이 돌았을 때만 채워진다
  const result = callSlot(
    repoRoot,
    manifest,
    "candidates.rank",
    () => ({ requirements: items, keywords, files: ordered, limit: CANDIDATE_LIMIT }),
    () => {
      scan = rankCandidatesScan(repoRoot, files, keywords, CANDIDATE_LIMIT);
      return { ranked: scan.ranked };
    },
  );
  const ranked = result.output.ranked.slice(0, CANDIDATE_LIMIT);
  const scope: string[] = [];
  if (scan && scan.skipped > 0) {
    scope.push(`- 범위: 소스 ${scan.total}개 중 경로는 전부, 본문은 ${scan.read}개만 봤습니다(경로가 걸린 파일·테스트가 아닌 파일 먼저) — 순위에 없으면 직접 찾아야 합니다.`);
  }
  if (truncated) {
    scope.push(`- 범위: 저장소 파일이 ${SURVEY_MAX_FILES}개를 넘어 앞부분(경로 사전순)만 셌습니다 — 순위에 없으면 직접 찾아야 합니다.`);
  }
  if (result.source === "plugin" && files.length > MAX_ITEMS) {
    scope.push(`- 플러그인에는 소스 앞 ${MAX_ITEMS}개(테스트가 아닌 파일 먼저)만 보냈습니다 — 순위에 없으면 직접 찾아야 합니다.`);
  }
  return [
    "## 관련 후보 파일 (순위 — 다시 찾지 말고 이것부터)",
    ...sourceLines(result, "내장 키워드 스캔, 결정론"),
    ...scope,
    ...(ranked.length > 0
      ? ranked.map((entry, index) => `${index + 1}. ${clamp(entry.path)} (${entry.score.toFixed(2)} — ${clamp(entry.why)})`)
      : [scope.length > 0
        ? "- 없음 — 본 범위에서 요구 항목의 낱말에 걸리는 파일이 없습니다. 후보를 직접 찾아야 합니다."
        : "- 없음 — 요구 항목의 낱말에 걸리는 파일이 없습니다. 후보를 직접 찾아야 합니다."]),
  ];
}

/** `context.docs` — 컨벤션·KNOWLEDGE 에서 읽을 절 */
function docSectionLines(repoRoot: string, manifest: Manifest, items: RequirementRef[], keywords: string[]): string[] {
  const result = callSlot(
    repoRoot,
    manifest,
    "context.docs",
    () => ({ requirements: items, docs: docRefs(repoRoot, manifest), limit: DOC_SECTION_LIMIT }),
    () => ({ sections: relevantDocSections(repoRoot, manifest, keywords, DOC_SECTION_LIMIT) }),
  );
  const sections = result.output.sections.slice(0, DOC_SECTION_LIMIT);
  return [
    "## 참고 문서 섹션 (제목 매칭 — 전문을 읽지 말고 이 절만)",
    ...sourceLines(result, "제목 매칭"),
    ...(sections.length > 0
      ? sections.map((entry) => `- ${clamp(entry.path)} · ## ${clamp(entry.heading)}${entry.why ? ` (${clamp(entry.why)})` : ""}`)
      : ["- 없음 — 등록된 문서에서 걸리는 절이 없습니다."]),
  ];
}

export function context(repoRoot: string): string {
  // 접수 중이면 커서가 없다 — 접수에 필요한 것(초안 형식 · 규칙 · 대상 후보)을 준다
  const session = loadActive(repoRoot) ? undefined : loadRequestSession(repoRoot);
  if (session) {
    return requestContext(repoRoot, session);
  }
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
      "필수 형식: `## R<번호>` 1개 이상·중복 없음 · R 블록마다 비어 있지 않은 `근거:` · `## 가정`. 아래 접수 요구 목록을 인용의 합으로 전부 연결해야 next 가 넘어간다.",
      "```markdown",
      "## R1 · <요구 한 가지>",
      "출처: REQ-1 (아래 접수 요구 목록의 ID, 여러 개면 쉼표로 구분)",
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
      "",
      "## 확정된 접수 요구 — 빠짐없이 R에 연결",
      ...sourceItems(readFileSync(join(repoRoot, active.spec), "utf8")).map((item) => `- ${item.id}: ${item.text}`),
      "근거는 이 목록의 문장을 그대로 인용합니다. 나누어 분석하면 근거 줄을 여러 개 써서 원문 전체를 덮으세요. 제외하려면 지시서를 고쳐 다시 확정합니다.",
    );
    // 업무 규칙을 묻기 전에 먼저 찾게 한다 — analysis 시점에는 01 이 없으므로 낱말은 지시서의 접수 요구 항목에서 뽑는다
    const specItems = sourceItems(readFileSync(join(repoRoot, active.spec), "utf8")).map((item) => ({ key: item.id, text: item.text }));
    const rules = businessRuleFiles(work);
    out.push("", `- 업무 규칙 KNOWLEDGE (묻기 전에 먼저 찾는다 — 배정 inputs 에 있다): ${rules.join(", ") || "없음"}`);
    out.push("", ...docSectionLines(repoRoot, manifest, specItems, keywordsOf(specItems)));
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
      `- 공통 KNOWLEDGE (읽기만 — 키가 있어도 현재 코드와 호출자 영향을 확인하고 인용한다): ${KNOWLEDGE_KINDS.map((kind) => docPaths(manifest, kind)[0]).join(", ")}`,
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
    } else {
      // 신규(빈) 저장소 — 베낄 코드가 없다. 문서가 정하지 않은 것을 지어내지 않게 자리를 짚어 준다
      out.push(
        "",
        "## 참조 없음 — 아키텍처·컨벤션 문서로",
        "참조 표준으로 삼을 기존 코드가 없습니다 (code-agent.json 에 referenceDomain 이 없습니다).",
        `구조·이름·계층 경계는 ${manifest.docs.architecture ?? "(아키텍처 문서 없음)"} 와 ` +
          `${manifest.conventions.join(", ") || "(컨벤션 문서 없음)"} 가 정한 것을 따릅니다.`,
        `문서가 정하지 않은 것은 지어내지 말고 ① ${workDocPath(active.id, "01-requirements")} 의 \`## 가정\` 에 ` +
          `근거와 함께 적거나 ${questionsFile(active.id)} 로 물으세요.`,
      );
    }

    // 자리 둘 — 기본 구현은 등록 없이 돌고, 저장소가 선언한 플러그인이 있으면 그것이 대신 채운다.
    // 재탐색을 대신하는 자리라, 여기서 준 것으로 충분하면 서브에이전트가 저장소를 다시 훑지 않는다.
    const items = requirementItems(readWorkDoc(repoRoot, active.id, "01-requirements") ?? "");
    const keywords = keywordsOf(items);
    if (active.phase !== "plan") {
      out.push("", ...candidateLines(repoRoot, manifest, items, keywords));
    }
    out.push("", ...docSectionLines(repoRoot, manifest, items, keywords));
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
    // 제출이 세우는 종류별 규칙은 **쓰기 전에** 보여야 한다 — 거절당해서 알게 되는 규칙은 규칙이 아니라 함정이다
    const testKeys = codeStages(work).filter((stage) => stage.kind === "test").map((stage) => stage.key);
    if (order.kind === "fix") {
      out.push(
        "",
        "## fix — 재현이 먼저다 (제출이 세우는 것)",
        `- ⑦ ${workDocPath(active.id, "07-test-spec")} 에 \`## 재현\` 절을 두고 결함을 재현하는 TC id 를 \`- TC-1\` 로 한 줄씩. 수준은 무엇이든 되고, 적은 id 는 위 표에 실재해야 합니다.`,
        `- \`sequence[0].step\` 이 kind:"test" 단계의 key 여야 합니다 (받는 값: ${testKeys.join(", ") || "없음 — code-agent.json 에 kind:\"test\" 단계가 필요합니다"}).`,
        `- \`files[]\` 에 그 단계의 파일(재현 테스트)이 있어야 하고, 그 파일은 테스트 자리 안이어야 합니다: ${testRoots(work).join(", ") || "선언 없음"}.`,
        "- 구현에서는 그 테스트를 쓰고 `code-agent repro` 로 **실패**를 본 뒤에야 고칠 파일이 열립니다.",
        "- 지시서의 오류 로그가 1차 근거입니다. 로그의 발생 조건을 로컬에서 만들 수 없으면 `## 재현` 에 `- 방식: 로그 근거 — <사유>` 를 더합니다 — 그 TC 는 로그의 입력·상태를 담은 회귀 TC 로 수정 후 통과해야 합니다(지시서에 오류 로그가 있을 때만).",
      );
    }
    if (order.kind === "refactor") {
      out.push(
        "",
        "## refactor — 기존 테스트는 계획에 넣지 않는다 (제출이 세우는 것)",
        `- 기준 커밋에 이미 있던 테스트 자리(${testRoots(work).join(", ") || "선언 없음"})의 파일은 \`files[]\` 에 넣을 수 없습니다 — 동작이 보존되는지 보는 것이 그 테스트입니다.`,
        `- 테스트를 고쳐야 할 이유가 보이면 계획에 넣지 말고 ${questionsFile(active.id)} 로 물으세요.`,
        "- `preserve` 에 지시서의 보존 항목과 그것을 어떻게 지키는지를 적어야 제출됩니다.",
      );
    }
  }

  if (active.phase === "implement" && order.kind === "fix") {
    out.push(
      "",
      "## fix — 재현 먼저",
      `1. kind:"test" 단계의 계획 파일에 ⑦ ${workDocPath(active.id, "07-test-spec")} 의 \`## 재현\` 이 가리키는 TC 를 씁니다.`,
      `2. ${shellLabel()} \`code-agent repro\` — 지금 코드에서 그것이 **실패**하는 것을 봅니다(⑦ 이 로그 근거면 수정 전 결과만 남깁니다). 재현되지 않으면 고치지 말고, 출력이 안내하면 사람에게 \`{"action":"repro-log"}\` 동의로 로그 근거 전환을 확인받습니다.`,
      "3. repro 를 지난 뒤에야 고칠 파일을 쓸 수 있습니다 (hook 이 그 전에는 거부합니다). 재현 테스트는 그때 얼어붙습니다.",
    );
  }

  if (active.phase === "implement" && work.stage && work.plan) {
    const stage = work.stage;
    const currentTask = work.plan.tasks?.find(task => task.id === active.task);
    const planned = work.plan.files.filter((file) => currentTask ? currentTask.files.includes(file.path) : file.stage === stage.key);
    if (currentTask) out.push(`현재 Task: ${currentTask.id} · ${currentTask.title}`, `선행: ${currentTask.dependsOn.join(", ") || "없음"} · 완료 기준: ${currentTask.acceptance.join(", ")}`);
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
    const evidence = loadEvidence(repoRoot, active.id, active.target);
    const view = evidence ? verifyView(work, evidence) : undefined;
    // 동결 표시 셋 — 결과 미확인의 수집 수정 창, 얼어 있음, 아직 얼지 않음(결과가 인식된 test 실행부터 언다)
    const frozenNote = !evidence || !view
      ? " · kind:test (결과가 인식된 test 실행부터 언다)"
      : testFrozen(evidence) && collectWindowOpen(view)
        ? " · **결과 미확인 — 수집 수정 1회 동안 TC 이름만 고칠 수 있음**"
        : testFrozen(evidence) ? " · **얼어 있음 (kind:test)**" : " · kind:test (결과가 인식된 test 실행부터 언다)";
    out.push(
      "",
      "## 계획 파일",
      ...work.plan.files.map(
        (file) =>
          `- [${file.stage}] ${file.path} — ${file.purpose} · 요구 ${(file.requirements ?? []).join(", ") || "없음"}` +
          (frozen.includes(file.path) ? frozenNote : ""),
      ),
    );
    out.push(
      "",
      `## 검증 증거 (${validationDocFile(active.id)})`,
      evidence && view
        ? [
            `- ${evidence.rounds}회차 · ${budgetText(view.budget)}`,
            ...(["check", "test"] as const).flatMap((phase) =>
              runsOf(evidence, phase).map(
                (run) => `- ${phase}/${run.kind}: ${run.outcome}${run.logFile ? ` · 로그 ${run.logFile}` : ""}`,
              ),
            ),
          ].join("\n")
        : "- 아직 없습니다 — code-agent check",
      "",
      "동결된 테스트는 review 단계의 관찰된 독립 리뷰 지적이 해당 계획 파일을 가리킬 때만 수정할 수 있습니다. 범위는 계획 파일 목록으로 판정하며 refactor의 기준 커밋 테스트는 계속 보호합니다. 수정 후 check부터 재검증·재리뷰하세요." +
        " 결과가 하나도 인식되지 않고 실패도 없던 test 실행은 얼리지 않습니다. 일부만 인식됐으면 수집 수정 1회 동안 TC 이름을 고칠 수 있습니다.",
      `계획 밖을 고쳐야 하면 ${questionsFile(active.id)} 에 질문을 기록하고 ${askVia()} 처리 방향을 받으세요. 답이 있어도 재계획·재승인 전에는 구현하지 않습니다.`,
    );
  }

  if (active.phase === "review") {
    const review = loadReview(repoRoot, active.id, active.target);
    const last = review?.rounds[review.rounds.length - 1];
    const usage = reviewRoundUsage(work);
    out.push(
      "",
      `## ⑨ ${reviewDocFile(active.id)} — 코드 리뷰`,
      `- 회차: ${last ? `${last.round}회차 (기준 트리 ${last.treeHash})` : "없음 — code-agent review 로 먼저 여세요"} · 남은 리뷰 회차 ${Math.max(0, usage.limit - usage.used)}회`,
      "- 회차 구역(`<!-- code-agent:review:... -->`)은 코드가 렌더합니다. 손대면 게이트가 거부합니다.",
      `- ${agentName("ca-reviewer")} 에게는 위 계획 파일 목록·검증 증거·컨벤션 경로만 넘깁니다 — 저장소를 다시 훑게 하지 않습니다.`,
      ...(review?.waivers ?? []).map((waiver) => `- 사람 판단으로 기각한 지적: ${waiver.id}(${waiver.path}) — ${waiver.reason.replace(/\s+/g, " ").slice(0, 120)} · ${waiver.round}회차 — 리뷰어에게 넘겨 같은 지적을 새 번호로 다시 내지 않게 한다`),
      "",
      `${agentName("ca-reviewer")}를 호출하면 hook이 실행·완료를 관찰하고 \`## 지적\` 표를 자동 기록합니다. 메인은 결과·상태를 대신 쓰지 않습니다:`,
      "```markdown",
      "| id | 계획 파일 | 범위 | 상태 | 지적 |",
      "|---|---|---|---|---|",
      "| F1 | <계획 파일 경로> | 계획 안 | 열림 | <무엇이 어긋났나 · 근거 · 고치는 방향> |",
      "```",
      "- **열 순서는 고정입니다** — 코드가 칸 위치로 읽습니다. 상태는 `열림` · `해결` 둘뿐이고 글자 그대로 봅니다.",
      "- 계획 파일 칸은 **저장소 기준 경로 그대로** — 백틱도 `:줄번호` 도 붙이지 마세요 (줄번호·근거는 지적 칸에).",
      "- **범위는 코드가 계획과 대조해 정합니다** — 적은 것이 다르면 게이트가 알려 줍니다.",
      `- 계획 안 지적: 고친 뒤 code-agent verify 로 check·test 를 다시 돌고 code-agent review 로 다음 회차를 엽니다. 리뷰 회차는 ${usage.limit}회까지입니다.`,
      `- 계획 밖 지적: 모델이 닫을 수 없습니다. ${questionsFile(active.id)} 로 묻거나 계획을 고쳐 재승인받습니다.`,
    );
  }

  if (active.phase === "integrate") {
    out.push(
      "",
      "## 통합 검증",
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
      "**현재 호스트 세션에서 ca-answer의 deliver 동의 절차로 확인**한 뒤 작업 브랜치에 로컬 커밋합니다. 적용 뒤 ca-next 흐름을 자동으로 이어갑니다 (직접 CLI를 원하면 TTY에서 `code-agent deliver`).",
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
  requireRequestConfirmed(repoRoot, active.id, active.spec);
  requireAnswers(repoRoot, active);
  requireWorkDocs([...planningProblems(work, "plan"), ...planningDocumentProblems(work, "plan")]);
  if (active.planningVersion && canonical(resolve(process.cwd(), draft)) !== canonical(join(repoRoot, requiredOutputs(work, "plan")[0]))) throw new Stop("관찰된 계획 작업이 생성한 plan.json만 제출할 수 있습니다.");

  // 계획 검사 전에 ①~④·⑦ 을 다시 본다 — 스테이지를 지난 뒤에 문서를 고쳤을 수 있고, 승인은 이 묶음에 대한 것이다.
  const requirements = requireRequirements(repoRoot, active);
  const functional = functionalProblems(repoRoot, active.id, requirements.keys);
  const testSpec = testSpecProblems(repoRoot, active.id, functional.acceptance, manifest, order.kind, active.spec);
  requireWorkDocs([
    ...analysisProblems(repoRoot, active.id, requirements.keys, order.kind, active.spec),
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
    throw new Stop(formatPlanIssues(parsed.error.issues));
  }
  const plan = format.toPlan(parsed.data);
  // 계획 초안의 자기 완결 검사(tasks·AC·요구 커버리지·남은 질문)는 완료 hook 과 같은 함수다. 순서·경로·preserve·종류별 규칙은 여기에만 있다
  const problems: string[] = [...planShapeProblems(work, plan, functional.acceptance, requirements.keys), ...sequenceProblems(plan, work.stages, order.kind)];
  if (format.requiresPreserve) {
    problems.push(...missingPreserve(order, plan).map((item) => `preserve 가 계획에 없습니다: ${item}`));
  }
  // 검증 명령이 이 계획이 쓰는 파일을 가리키면 모델이 제 검증기를 쓰게 된다 — 그래도 묶임은
  // 전부 들어맞는다(가짜 검증기까지 함께 굳으므로). 코드가 판별할 수 있는 것이 아니라 사람이
  // 판단할 것이라, 조용히 지나가지 않게 제출을 세우고 무엇이 걸렸는지 그대로 보여 준다.
  const planned = new Set(plan.files.map((file) => file.path));
  const declared = [manifest.build, manifest.test, manifest.prepare, ...Object.values(manifest.commands)]
    .filter((argv): argv is string[] => Array.isArray(argv))
    .flat()
    .map((element) => element.replace(/^\.\//, ""));
  for (const path of [...new Set(declared.filter((element) => planned.has(element)))]) {
    problems.push(
      `검증 명령이 이 계획이 쓰는 파일을 가리킵니다: ${path} — 검증을 스스로 쓰는 계획은 증거가 되지 않습니다`,
    );
  }

  const stages = codeStages(work);
  // fix 는 재현 테스트가 먼저다 — 계획이 그 순서를 담지 않으면 강제할 자리가 없다
  if (order.kind === "fix") {
    const testKeys = stages.filter((stage) => stage.kind === "test").map((stage) => stage.key);
    if (testKeys.length === 0) {
      problems.push(
        "이 프로젝트에는 fix 로 도는 kind:\"test\" 단계가 없습니다 — code-agent.json 의 stages 에 하나 두고 " +
          "kinds 에 \"fix\" 를 넣으세요 (확인: code-agent manifest check)",
      );
    } else {
      const first = (plan.sequence[0]?.step ?? "").trim();
      if (!testKeys.includes(first)) {
        problems.push(
          `계획의 sequence[0] 이 테스트 단계가 아닙니다 (지금: "${first}") — fix 는 재현 테스트가 먼저입니다. ` +
            `받는 값: ${testKeys.join(", ")}`,
        );
      }
      if (!plan.files.some((file) => testKeys.includes(file.stage))) {
        problems.push(`fix 의 계획에 kind:"test" 단계의 파일이 없습니다 — 재현 테스트 파일을 계획에 넣으세요 (단계: ${testKeys.join(", ")})`);
      }
      // '재현 먼저' 는 **단계 이름표**로 판정된다 (hook 도 repro 의 깨끗한 트리 검사도). 그래서 고칠 파일을
      // 테스트 단계에 적어 넣으면 재현 전에 쓸 수 있고 — outputDirs 가 비면 위치 검사도 서지 않는다 —
      // 그 파일이 바뀐 채로 repro 가 통과한다. 이름표가 가리키는 자리 안에 있는지 여기서 본다.
      const roots = testRoots(work);
      const mislabeled = plan.files.filter(
        (file) => testKeys.includes(file.stage) && !roots.some((root) => file.path === root || file.path.startsWith(`${root}/`)),
      );
      for (const file of mislabeled) {
        problems.push(
          roots.length === 0
            ? `kind:"test" 단계(${file.stage})가 자리를 밝히지 않아 재현 테스트를 가려낼 수 없습니다: ${file.path} — ` +
                "code-agent.json 의 그 단계에 scope:\"project\" 의 outputDirs 나 base 를 적으세요 (확인: code-agent manifest check)"
            : `계획이 kind:"test" 단계에 테스트 자리 밖의 파일을 넣었습니다: ${file.path} (단계 ${file.stage}) — ` +
                `'재현 먼저' 는 그 자리로 잽니다. 테스트 자리: ${roots.join(", ")}`,
        );
      }
    }
  }
  // 리팩토링이 기존 테스트를 고칠 수 있으면 '동작 보존' 을 재는 자가 없어진다. 부하를 지는 자리가 여기다
  if (order.kind === "refactor") {
    const tracked = new Set(trackedTestFiles(work));
    const createsTests = plan.files.some(file => stages.some(stage => stage.key === file.stage && stage.kind === "test"));
    const knownCases = new Set([...tracked].flatMap(path => existsSync(join(repoRoot, path))
      ? readFileSync(join(repoRoot, path), "utf8").match(/\bTC-\d+\b/g) ?? [] : []));
    if (!createsTests && knownCases.size) {
      const spec = readWorkDoc(repoRoot, active.id, "07-test-spec");
      for (const entry of spec ? parseTestCases(spec) : []) if (!knownCases.has(entry.id)) {
        problems.push(`기존 테스트에 없는 ${entry.id}를 실행할 계획이 없습니다 — refactor는 기존 TC ID를 재사용하세요. 도구·파일 보존 같은 절차 확인을 실행하지 않는 TC로 만들지 않습니다`);
      }
    }
    const hit = plan.files.map((file) => file.path).filter((path) => tracked.has(path));
    if (hit.length > 0) {
      problems.push(
        `리팩토링은 기존 테스트를 고치지 않습니다 — 계획에서 빼세요: ${hit.join(", ")}. ` +
          "동작이 보존되는지 보는 것이 그 테스트입니다. " +
          `테스트를 고쳐야 할 이유가 보이면 ${questionsFile(active.id)} 로 물으세요`,
      );
    }
  }
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
    "현재 호스트 세션에서 ca-answer의 plan 동의 절차로 확인하고 적용 뒤 ca-next 흐름에서 구현을 자동으로 이어갑니다 (직접 CLI를 원하면 TTY에서 `code-agent approve`)."
  );
}

// ---- approve / reject ----

/**
 * 재판정 화면의 "이전 판정 이후 바뀐 것" 절 — 승인 화면(decide)이 현재 계획·경계·답 출처 절 뒤에 붙인다.
 * 경계 스냅샷·문서별 해시가 없는 이전 승인 기록은 차이 대신 그 사실을 적는다. 바뀐 것이 없으면 빈 배열이다.
 */
export function approvalChangeLines(state: ApprovalState): string[] {
  if (state.status === "stale-plan" && state.diff.length > 0) return ["", "이전 판정 이후 바뀐 곳:", formatDiff(state.diff)];
  if (state.status === "stale-manifest") {
    return ["", "이전 판정 이후 바뀐 경계·검증 선언:", state.diff.length
      ? state.diff.map((entry) => `  ${entry.change} ${entry.text}`).join("\n")
      : "  이전 승인 기록에 경계 스냅샷이 없어 차이를 보일 수 없습니다 — 위 현재 선언 전체를 확인하세요."];
  }
  if (state.status === "stale-docs") {
    return ["", `이전 판정 이후 바뀐 근거 문서: ${state.changed.join(" · ") || "이전 승인 기록에 문서별 해시가 없어 무엇이 바뀌었는지 보일 수 없습니다"}`];
  }
  return [];
}

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
  requireRequestConfirmed(repoRoot, active.id, active.spec);
  // 제출과 승인 사이에도 작업 폴더는 쓸 수 있다 — 제출 때 지난 게이트를 다시 본다.
  requireAnswers(repoRoot, active);
  if (decision === "approved") requireWorkDocs([...planningProblems(work, "plan"), ...planningDocumentProblems(work, "plan"), ...reviewedPlanProblems(work)]);
  // 여기서 안 보면 02·07 을 빈 파일로 덮은 상태의 docsHash 가 그대로 승인으로 굳는다 (승인 화면에는 계획만 보인다).
  const requirements = requireRequirements(repoRoot, active);
  const functional = functionalProblems(repoRoot, active.id, requirements.keys);
  requireWorkDocs([
    ...analysisProblems(repoRoot, active.id, requirements.keys, order.kind, active.spec),
    ...designProblems(repoRoot, active.id),
    ...functional.problems,
    ...testSpecProblems(repoRoot, active.id, functional.acceptance, manifest, order.kind, active.spec).problems,
  ]);
  const docs = approvalDocsState(work);

  const state = approvalOf(work);
  requireWorkDocs(sequenceProblems(plan, work.stages, order.kind));
  // 승인이 묶는 것을 화면에 모두 싣는다 — 계획·경계·검증 선언(code-agent.json)·가정·답 출처
  const shown = [formatSourceTrace(readSourceTrace(repoRoot, active.id, active.spec).rows), formatPlan(plan), "", formatBoundary(manifestBoundary(manifest))];
  const assumptions = formatAssumptions(requirements.assumptions);
  if (assumptions) shown.push("", assumptions);
  const sources = formatAnswerSources(repoRoot, active.id);
  if (sources) shown.push("", sources);
  shown.push(...approvalChangeLines(state));
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
    docsHash: docs.hash,
    docsParts: docs.parts,
  });
  return decision === "approved"
    ? `승인을 원장에 남겼습니다. 현재 호스트 세션에서는 ca-next 흐름으로 구현을 자동으로 이어갑니다 (수동 재개: ${skill("ca-next")}).`
    : "반려를 원장에 남겼습니다. 계획을 고쳐 다시 제출해야 합니다.";
}
