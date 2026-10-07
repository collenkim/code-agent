import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

import { writeAtomic } from "../core/atomic";
import { hashManifest, hashPlan } from "../core/approval";
import { runWorkflow } from "../core/workflow";
import type { NodeEvent, WorkflowHandoff, WorkflowNode } from "../core/workflow";
import { next, requireValidatable } from "./commands";
import { bindingProblems, loadEvidence, runsOf, stageProblemEntries, stageProblems, treeHashNow, validationDocFile, verifyView } from "./evidence";
import type { Evidence } from "./evidence";
import { STATE_DIR, verifyFile } from "./layout";
import {
  budgetText,
  failure,
  guidance,
  limitExceededText,
  nodeCounter,
  POLICIES,
  RetryRefused,
  verifyNode,
  verifyRetryOf,
  verifyState,
} from "./retryPolicy";
import type { FailureRecord, VerifyBudget } from "./retryPolicy";
import { Stop } from "./stop";
import { check, runTests, verifyGuidance } from "./validate";
import { loadWork } from "./work";
import type { Work } from "./work";

interface FlowContext {
  repoRoot: string;
  problems: string[];
  summaries: string[];
  /** verify --retry — 판정에는 쓰지 않는다(같은 코드 재실행은 진입점과 무관하게 같은 카운터를 쓴다) */
  retry: boolean;
  /** 이번 노드의 실패 원인 — 결과 JSON 의 failure */
  failure?: FailureRecord;
  /** 남은 회차 — 결과 JSON 의 budget */
  budget?: VerifyBudget;
  /** 원인별 안내(task) — assess 가 정한다 */
  guide?: string;
}

export interface VerificationResult extends WorkflowHandoff {
  problems: string[];
  summaries: string[];
  evidence: string;
  plannedFiles: string[];
  resume: string;
  failure?: FailureRecord;
  budget?: VerifyBudget;
}

interface FlowAttempt {
  at: string;
  input: Pick<Evidence, "baseCommit" | "planHash" | "manifestHash" | "treeHash">;
  events: NodeEvent[];
  result?: VerificationResult;
}

export interface VerificationHistory {
  version: 1;
  id: string;
  target: string;
  attempts: FlowAttempt[];
}

export function verificationFlowFile(work: Work): string {
  return join(work.repoRoot, STATE_DIR, "work", work.active.id, `${work.active.target}.verification-flow.json`);
}

function evidenceOf(work: Work): Evidence | undefined {
  return loadEvidence(work.repoRoot, work.active.id, work.active.target);
}

function currentRuns(work: Work, phase: "check" | "test"): boolean {
  const evidence = evidenceOf(work);
  return !!evidence && bindingProblems(work, evidence).length === 0 &&
    runsOf(evidence, phase).some((run) => run.round === evidence.rounds);
}

/**
 * 판정 — 원인을 하나로 분류하고 노드를 고른다. 다시 돌려도 남는 문제(되돌리기·사람 판단·다른 명령)와 명령 미선언은
 * 노드 없이 Stop 이다. 실행은 모두 통과했고 다시 돌리면 맞춰지는 대조만 남았으면 diagnose(class precondition)다.
 */
function assess(context: FlowContext, phase: "check" | "test"): string {
  const work = requireValidatable(context.repoRoot, phase);
  const entries = stageProblemEntries(work, phase);
  context.problems = entries.map((entry) => entry.text);
  if (entries.length === 0) {
    next(context.repoRoot);
    return "passed";
  }
  const evidence = evidenceOf(work)!;
  const view = verifyView(work, evidence);
  context.budget = view.budget;
  const state = verifyState({ phase, round: evidence.rounds, runs: evidence.runs, cases: phase === "test" ? evidence.testCases : undefined });
  // 다시 돌려도 남는 문제나 명령 미선언은 Stop — 사유를 그대로 전한다
  const stops = entries.filter((entry) => entry.kind === "stop").map((entry) => entry.text);
  if (state === "precondition" || stops.length > 0) {
    throw new Stop(guidance("precondition", { problems: (stops.length ? stops : ["선언되지 않은 명령(not-run)"]).join(" / ") }));
  }
  // 실행은 모두 통과했고 남은 것은 다시 돌리면 맞춰지는 대조뿐이다(검증 명령이 계획 파일을 고침·⑧·회차·묶임) — 코드 결함이 아니다
  if (state === "passed") {
    context.failure = failure("precondition", context.problems.join(" / "));
    context.guide = guidance("precondition", { problems: context.problems.join(" / "), budget: budgetText(view.budget) }, "rerun");
    return "diagnose";
  }
  const node = verifyNode(state, view.budget);
  if (node === "decision") {
    const counter = nodeCounter(state, view.budget)!;
    context.failure = failure("limit-exceeded", context.problems.join(" / "),
      { origin: state, counter: { key: counter, used: view.budget[counter].used, limit: view.budget[counter].limit } });
    context.guide = undefined;
    return "blocked";
  }
  context.failure = failure(state, context.problems.join(" / "));
  context.guide = verifyGuidance(work, evidence, phase, state, view.budget);
  return node;
}

/** 고정 그래프: 실행과 판정은 코드, 실패 해석·수정과 독립 리뷰는 에이전트가 맡는다. */
export const VERIFICATION_NODES: Record<string, WorkflowNode<FlowContext>> = {
  "check.execute": {
    executor: "program",
    async run(context) {
      const work = requireValidatable(context.repoRoot, "check");
      // 회차 판정은 check() 한 곳이다. 한도 거부만 사람 판단(decision)으로 보내고, 그 밖의 거부는 사유 그대로 멈춘다
      try {
        context.summaries.push(await check(work, { retry: context.retry }));
        return "done";
      } catch (error) {
        if (!(error instanceof RetryRefused) || error.failure.class !== "limit-exceeded") throw error;
        context.failure = error.failure;
        context.problems = [error.message];
        const evidence = evidenceOf(work);
        if (evidence) context.budget = verifyView(work, evidence).budget;
        return "blocked";
      }
    },
    edges: { done: "check.assess", blocked: "decision" },
  },
  "check.assess": {
    executor: "program", run: (context) => assess(context, "check"),
    edges: { passed: "test.select", repair: "repair", diagnose: "diagnose", blocked: "decision" },
  },
  "test.select": {
    executor: "program",
    run: (context) => {
      const work = requireValidatable(context.repoRoot, "test");
      const evidence = evidenceOf(work);
      // 끊긴 test(시작 표지만 남음)는 앞 기록을 판정하지 않고 다시 실행한다 — runTests 가 그 재실행을 센다
      const started = evidence ? verifyRetryOf(evidence).started : undefined;
      if (evidence && started?.phase === "test" && started.round === evidence.rounds) return "execute";
      return currentRuns(work, "test") ? "recorded" : "execute";
    },
    edges: { recorded: "test.assess", execute: "test.execute" },
  },
  "test.execute": {
    executor: "program",
    async run(context) {
      const work = requireValidatable(context.repoRoot, "test");
      const problems = stageProblems(work, "check");
      if (problems.length) throw new Stop(problems.join("\n"));
      context.summaries.push(await runTests(work));
      return "done";
    },
    edges: { done: "test.assess" },
  },
  "test.assess": {
    executor: "program", run: (context) => assess(context, "test"),
    edges: { passed: "review", repair: "repair", diagnose: "diagnose", blocked: "decision" },
  },
  repair: { executor: "agent", task: "검증 증거와 로그를 분석하고 승인된 계획 안에서 수정하세요. ca-check의 수정 루프와 테스트 동결 규칙을 따릅니다. 수정 후 code-agent verify로 재검증하세요." },
  diagnose: { executor: "agent", task: "미실행·실행 오류·TC 결과 미확인 원인을 확인하세요. 이를 코드 결함이나 통과로 단정하지 않습니다. 환경·결과 수집 문제를 해결한 뒤 code-agent verify --retry로 다시 검증하세요. 선언된 환경 오류(environmentErrors)로 막힌 회차는 코드를 그대로 둔 재실행에 회차를 쓰지 않습니다." },
  review: { executor: "agent", task: "검증을 통과했습니다. ca-review 절차로 독립 리뷰를 진행하세요." },
  decision: { executor: "human", task: "재시도 한도에 닿았습니다. 막힌 이유를 보고하고 사람 판단(ca-answer)을 받으세요." },
};

/**
 * 결과의 task — 원인이 있으면 원인별 안내다: decision 은 한도 안내, diagnose 는 원인 안내(실행은 통과했는데 대조만
 * 어긋났으면 precondition 의 rerun 문구), repair 는 노드 문구에 남은 회차를 붙인다. 그 밖은 노드의 고정 문구다.
 */
function taskOf(node: string, fallback: string, context: FlowContext, work: Work): string {
  const recorded = context.failure;
  if (!recorded || !["repair", "diagnose", "decision"].includes(node)) return fallback;
  if (node === "decision") return recorded.class === "limit-exceeded" ? limitExceededText(recorded, validationDocFile(work.active.id)) : fallback;
  if (node === "repair") return context.budget ? `${fallback} (${budgetText(context.budget)})` : fallback;
  return context.guide ?? fallback;
}

/** 저장된 커서는 증거가 아니다. 매 호출마다 실제 상태·승인·증거로 진입 노드를 다시 계산한다. */
export async function verify(repoRoot: string, options: { retry?: boolean } = {}): Promise<VerificationResult> {
  const initial = loadWork(repoRoot);
  if (!initial || !["check", "test", "review", "integrate"].includes(initial.active.phase)) {
    throw new Stop("code-agent verify는 check·test 또는 review·integrate의 수정 후 재검증에서 실행합니다.");
  }
  let entry: string;
  if (!options.retry && initial.active.phase === "review" &&
      stageProblems(initial, "check").length === 0 && stageProblems(initial, "test").length === 0) {
    requireValidatable(repoRoot, "review");
    entry = "review";
  } else if (!options.retry && initial.active.phase === "test" && stageProblems(initial, "check").length === 0) {
    requireValidatable(repoRoot, "test");
    entry = "test.select";
  } else {
    const work = requireValidatable(repoRoot, "check");
    entry = !options.retry && currentRuns(work, "check") ? "check.assess" : "check.execute";
  }
  const work = loadWork(repoRoot)!;
  const file = verificationFlowFile(work);
  let history: VerificationHistory = { version: 1, id: work.active.id, target: work.active.target, attempts: [] };
  if (existsSync(file)) {
    try {
      const previous = JSON.parse(readFileSync(file, "utf8")) as VerificationHistory;
      if (previous.version !== 1 || previous.id !== history.id || previous.target !== history.target || !Array.isArray(previous.attempts)) throw new Error("형식 불일치");
      history = previous;
    } catch {
      throw new Stop(`검증 노드 이력을 읽지 못했습니다: ${file}. 이력을 확인한 뒤 재개하세요.`);
    }
  }
  const attempt: FlowAttempt = {
    at: new Date().toISOString(),
    input: { baseCommit: work.active.baseCommit!, planHash: hashPlan(work.plan!), manifestHash: hashManifest(work.manifest), treeHash: treeHashNow(work) },
    events: [],
  };
  history.attempts.push(attempt);
  mkdirSync(dirname(file), { recursive: true });
  const persist = () => writeAtomic(file, `${JSON.stringify(history, null, 2)}\n`);
  const context: FlowContext = { repoRoot, problems: [], summaries: [], retry: !!options.retry };
  const handoff = await runWorkflow(VERIFICATION_NODES, entry, context, (event) => {
    attempt.events.push(event);
    persist();
  });
  const result: VerificationResult = {
    ...handoff,
    task: taskOf(handoff.node, handoff.task, context, work),
    problems: context.problems, summaries: context.summaries,
    evidence: verifyFile(repoRoot, work.active.id, work.active.target),
    plannedFiles: work.plan!.files.map((file) => file.path),
    resume: handoff.node === "diagnose" ? "code-agent verify --retry" : handoff.node === "review" ? "/ca-review" : handoff.node === "decision" ? "/ca-answer" : "code-agent verify",
    ...(context.failure ? { failure: context.failure } : {}),
    ...(context.budget ? { budget: context.budget } : {}),
  };
  attempt.result = result;
  persist();
  return result;
}

export function renderVerification(result: VerificationResult): string {
  return [
    ...result.summaries,
    `검증 노드: ${result.node} (${result.executor})`,
    ...result.problems.map((problem) => `- ${problem}`),
    ...(result.failure
      ? [`원인: ${POLICIES[result.failure.class].label}${result.failure.origin ? ` (원래 원인: ${POLICIES[result.failure.origin].label})` : ""}`]
      : []),
    ...(result.budget ? [`남은 회차: ${budgetText(result.budget)}`] : []),
    result.task,
    `증거: ${result.evidence}`,
    `다음: ${result.resume}`,
  ].join("\n");
}
