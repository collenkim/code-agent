import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

import { writeAtomic } from "../core/atomic";
import { hashManifest, hashPlan } from "../core/approval";
import { runWorkflow } from "../core/workflow";
import type { NodeEvent, WorkflowHandoff, WorkflowNode } from "../core/workflow";
import { next, requireValidatable } from "./commands";
import { bindingProblems, environmentBlocked, fixLimit, loadEvidence, runsOf, stageProblems, treeHashNow } from "./evidence";
import type { Evidence } from "./evidence";
import { STATE_DIR, verifyFile } from "./layout";
import { Stop } from "./stop";
import { check, runTests } from "./validate";
import { loadWork } from "./work";
import type { Work } from "./work";

interface FlowContext {
  repoRoot: string;
  problems: string[];
  summaries: string[];
}

export interface VerificationResult extends WorkflowHandoff {
  problems: string[];
  summaries: string[];
  evidence: string;
  plannedFiles: string[];
  resume: string;
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

function assess(context: FlowContext, phase: "check" | "test"): string {
  const work = requireValidatable(context.repoRoot, phase);
  context.problems = stageProblems(work, phase);
  if (context.problems.length === 0) {
    next(context.repoRoot);
    return "passed";
  }
  const evidence = evidenceOf(work)!;
  // 선언된 환경 오류로만 막혔으면 코드 수정이 아니라 환경 진단이다 — 같은 코드의 재실행은 회차를 쓰지 않아 한도와 무관하다
  if (environmentBlocked(evidence)) return "diagnose";
  // 완료되지 않은 TC도 실패다. 명령의 exit 0만 보고 수정 한도를 무시하지 않는다.
  if (evidence.rounds >= fixLimit(work, evidence) + 1) return "blocked";
  if (runsOf(evidence, phase).some((run) => run.outcome === "error" || run.outcome === "not-run") ||
      (phase === "test" && evidence.testCases.some((entry) => entry.status !== "passed" && entry.status !== "failed"))) {
    return "diagnose";
  }
  return "repair";
}

/** 고정 그래프: 실행과 판정은 코드, 실패 해석·수정과 독립 리뷰는 에이전트가 맡는다. */
export const VERIFICATION_NODES: Record<string, WorkflowNode<FlowContext>> = {
  "check.execute": {
    executor: "program",
    async run(context) {
      const work = requireValidatable(context.repoRoot, "check");
      const evidence = evidenceOf(work);
      // 중단된 실행도 check가 선반영한 회차를 소비한다. 입력 변경으로 한도를 초기화하지 않는다.
      if (evidence && evidence.baseCommit === work.active.baseCommit &&
          evidence.rounds >= fixLimit(work, evidence) + 1 && !environmentBlocked(evidence) &&
          bindingProblems(work, { ...evidence, treeHash: treeHashNow(work) }).length === 0) {
        context.problems = ["고쳐 쓰기 한도를 모두 사용했습니다. 재계획·재승인이 필요합니다."];
        return "blocked";
      }
      context.summaries.push(await check(work));
      return "done";
    },
    edges: { done: "check.assess", blocked: "decision" },
  },
  "check.assess": {
    executor: "program", run: (context) => assess(context, "check"),
    edges: { passed: "test.select", repair: "repair", diagnose: "diagnose", blocked: "decision" },
  },
  "test.select": {
    executor: "program",
    run: (context) => currentRuns(requireValidatable(context.repoRoot, "test"), "test") ? "recorded" : "execute",
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
  decision: { executor: "human", task: "수정 한도를 사용했습니다. 막힌 이유를 보고하고 ca-check의 질문·재계획·재승인 절차를 따르세요." },
};

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
  const context: FlowContext = { repoRoot, problems: [], summaries: [] };
  const handoff = await runWorkflow(VERIFICATION_NODES, entry, context, (event) => {
    attempt.events.push(event);
    persist();
  });
  const result: VerificationResult = {
    ...handoff, problems: context.problems, summaries: context.summaries,
    evidence: verifyFile(repoRoot, work.active.id, work.active.target),
    plannedFiles: work.plan!.files.map((file) => file.path),
    resume: handoff.node === "diagnose" ? "code-agent verify --retry" : handoff.node === "review" ? "/ca-review" : handoff.node === "decision" ? "/ca-answer" : "code-agent verify",
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
    result.task,
    `증거: ${result.evidence}`,
    `다음: ${result.resume}`,
  ].join("\n");
}
