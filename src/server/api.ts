/**
 * HTTP와 무관한 작업 단위. 라우팅을 바꿔도 여기는 그대로다.
 *
 * 하는 일은 CLI의 next·apply·status·log 와 같다 — 전송만 다르다.
 */
import { formatPlan } from "../core/plan";
import {
  loadSession,
  readQuestions,
  summarizeSession,
  writeQuestions,
  unanswered,
} from "../core/session";
import type { PendingQuestion } from "../core/session";
import { describeTarget } from "../core/session";
import { loadPlan } from "../core/state";
import { applyResponse, decideApproval, hasPlan, nextPrompt } from "../core/turn";
import type { JobStore } from "./jobs";

/** 지시서의 대상 하나와 그 상태 */
export interface LaneView {
  target: string;
  step: string;
  needsApproval: boolean;
}

export interface QuestionView {
  id: number;
  target: string;
  question: string;
  answer: string;
}

export interface StatusView {
  id: string;
  label: string;
  repoRoot: string;
  outDir: string;
  /** 지금 할 차례. 대상이 여럿이면 `대상:단계` 로 나온다 */
  target: string;
  /** 대상 이름을 뺀 단계만 — plan · 단계키 · gate:단계키 · approval · blocked · done */
  step: string;
  /** 지금 도는 대상 */
  lane: string;
  /** 지시서의 대상 전부. 대상마다 따로 돈다 */
  lanes: LaneView[];
  turn: number;
  completedStages: string[];
  questions: QuestionView[];
  openQuestionCount: number;
  /** 프롬프트가 없을 때(blocked·done) 사람에게 할 말 */
  message?: string;
  hasPrompt: boolean;
  hasPlan: boolean;
  /** 사람의 판정을 기다리는가 — 계획 승인(2차)이든 산출물 확정(4차)이든 */
  needsApproval: boolean;
  /** 무엇에 대한 판정인가. plan 이면 2차 게이트, stage 면 4차 게이트 */
  pending?: "plan" | "stage";
  /** pending 이 stage 일 때 그 단계 키 */
  pendingStage?: string;
  /** 앞 턴에서 남은 위반 — 다음 프롬프트에 실려 들어간다 */
  lastViolations: { item: string; file: string; detail: string }[];
}

export interface PromptView {
  target: string;
  prompt?: string;
  message?: string;
}

export interface ApplyView {
  target: string;
  planSaved?: string;
  planText?: string;
  writtenFiles: string[];
  observations: { label: string; body: string }[];
  notes: string[];
  violations: { item: string; file: string; detail: string }[];
  parseErrors: string[];
  questionsAdded: number;
  advanced: boolean;
  message?: string;
  /** 반영 직후의 상태 — UI가 한 번 더 요청하지 않아도 되게 함께 준다 */
  next: StatusView;
}

function toQuestionView(questions: PendingQuestion[]): QuestionView[] {
  return questions.map((question) => ({
    id: question.id,
    target: question.target,
    question: question.question,
    answer: question.answer,
  }));
}

export function status(store: JobStore, id: string): StatusView {
  const job = store.get(id);
  const next = nextPrompt(job.context);
  // 진행 상태와 질문은 대상마다 따로 있다 — 지금 도는 대상의 것을 본다.
  const session = loadSession(next.outDir);
  const questions = readQuestions(next.outDir);

  return {
    id: job.id,
    label: job.label,
    repoRoot: job.context.repoRoot,
    outDir: job.context.outDir,
    target: next.label,
    step: describeTarget(next.target),
    lane: next.lane,
    lanes: next.lanes.map((state) => ({
      target: state.lane.target,
      step: describeTarget(state.step),
      needsApproval: state.step.kind === "approval" || state.step.kind === "confirm",
    })),
    turn: session.turn,
    completedStages: session.completedStages,
    questions: toQuestionView(questions),
    openQuestionCount: unanswered(questions).length,
    message: next.message,
    hasPrompt: Boolean(next.prompt),
    hasPlan: hasPlan(next.outDir),
    needsApproval: next.target.kind === "approval" || next.target.kind === "confirm",
    pending:
      next.target.kind === "approval"
        ? "plan"
        : next.target.kind === "confirm"
          ? "stage"
          : undefined,
    pendingStage: next.target.kind === "confirm" ? next.target.stage.key : undefined,
    lastViolations: session.lastViolations,
  };
}

/** 상태를 바꾸지 않는다. 몇 번을 불러도 같은 프롬프트가 나온다. */
export function prompt(store: JobStore, id: string): PromptView {
  const job = store.get(id);
  const next = nextPrompt(job.context);
  return { target: next.label, prompt: next.prompt, message: next.message };
}

/** 채팅 응답을 반영한다. 상태를 움직이는 유일한 지점이다. */
export function respond(store: JobStore, id: string, responseText: string): ApplyView {
  const job = store.get(id);

  if (responseText.trim() === "") {
    throw new Error("빈 응답입니다. Console 응답을 통째로 붙여넣으세요.");
  }

  const outcome = applyResponse(job.context, responseText);

  return {
    target: outcome.label,
    planSaved: outcome.planSaved,
    planText: outcome.planSaved ? formatPlan(loadPlan(outcome.outDir)) : undefined,
    writtenFiles: outcome.execution?.writtenFiles ?? [],
    observations: outcome.execution?.observations ?? [],
    notes: outcome.execution?.notes ?? [],
    violations: outcome.violations,
    parseErrors: outcome.parseErrors,
    questionsAdded: outcome.questionsAdded,
    advanced: outcome.advanced,
    message: outcome.message,
    next: status(store, id),
  };
}

/**
 * 질문에 답한다. 답이 채워지면 다음 프롬프트에 그대로 실려 들어간다.
 * 답하지 않은 질문이 하나라도 남으면 어느 단계도 진행되지 않는다.
 */
export function answer(
  store: JobStore,
  id: string,
  answers: { id: number; answer: string }[],
): StatusView {
  const job = store.get(id);
  const outDir = nextPrompt(job.context).outDir;
  const questions = readQuestions(outDir);

  const unknown = answers.filter((given) => !questions.some((q) => q.id === given.id));
  if (unknown.length > 0) {
    throw new Error(`그런 질문이 없습니다: ${unknown.map((given) => given.id).join(", ")}`);
  }

  const updated = questions.map((question) => {
    const given = answers.find((candidate) => candidate.id === question.id);
    return given ? { ...question, answer: given.answer.trim() } : question;
  });

  writeQuestions(outDir, updated);
  return status(store, id);
}

/**
 * 화면에서 판정을 내린다 — 계획 승인(2차)이든 산출물 확정(4차)이든 같은 자리다.
 * 무엇에 대한 판정인지는 상태가 정하고, 검사는 코어의 decideApproval 이 한다. 여기는 전송일 뿐이다.
 */
export function decide(
  store: JobStore,
  id: string,
  input: { decision?: string; approver?: string; comment?: string; target?: string },
): { message: string; next: StatusView } {
  const job = store.get(id);
  if (input.decision !== "approved" && input.decision !== "rejected") {
    throw new Error("판정은 approved 또는 rejected 여야 합니다.");
  }

  const { unchanged, record } = decideApproval(job.context, input.decision, {
    approver: input.approver?.trim() || undefined,
    comment: input.comment?.trim() || undefined,
    target: input.target?.trim() || undefined,
  });

  return {
    message: unchanged
      ? `이미 승인되어 있습니다 — ${record.approver} · ${record.at}`
      : `${record.stage ? "확정" : "승인"} 판정(${record.decision === "approved" ? "승인" : "반려"})을 ` +
        `원장에 남겼습니다 — ${record.target}${record.stage ? ` · 단계 ${record.stage}` : ""} · ` +
        `${record.approver} · 계획 ${record.planHash}`,
    next: status(store, id),
  };
}

export function log(store: JobStore, id: string): { text: string } {
  const job = store.get(id);
  // 대상마다 따로 쌓인다. 합치면 어느 대상에서 막혔는지가 지워진다.
  const lanes = nextPrompt(job.context).lanes;
  return {
    text: lanes
      .map(
        (state) =>
          `## 대상: ${state.lane.target}\n${summarizeSession(loadSession(state.lane.outDir))}`,
      )
      .join("\n\n"),
  };
}

/** 목록 화면용 요약. 작업마다 상태를 읽으므로 개수가 많아지면 여기가 먼저 느려진다. */
export function listJobs(store: JobStore): StatusView[] {
  return store.list().map((job) => status(store, job.id));
}
