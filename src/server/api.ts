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
import { loadPlan } from "../core/state";
import { applyResponse, hasPlan, nextPrompt } from "../core/turn";
import type { JobStore } from "./jobs";

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
  /** 지금 할 차례 — plan · 단계키 · gate:단계키 · blocked · done */
  target: string;
  turn: number;
  completedStages: string[];
  questions: QuestionView[];
  openQuestionCount: number;
  /** 프롬프트가 없을 때(blocked·done) 사람에게 할 말 */
  message?: string;
  hasPrompt: boolean;
  hasPlan: boolean;
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
  const session = loadSession(job.context.outDir);
  const next = nextPrompt(job.context);
  const questions = readQuestions(job.context.outDir);

  return {
    id: job.id,
    label: job.label,
    repoRoot: job.context.repoRoot,
    outDir: job.context.outDir,
    target: next.label,
    turn: session.turn,
    completedStages: session.completedStages,
    questions: toQuestionView(questions),
    openQuestionCount: unanswered(questions).length,
    message: next.message,
    hasPrompt: Boolean(next.prompt),
    hasPlan: hasPlan(job.context.outDir),
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
    planText: outcome.planSaved ? formatPlan(loadPlan(job.context.outDir)) : undefined,
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
  const questions = readQuestions(job.context.outDir);

  const unknown = answers.filter((given) => !questions.some((q) => q.id === given.id));
  if (unknown.length > 0) {
    throw new Error(`그런 질문이 없습니다: ${unknown.map((given) => given.id).join(", ")}`);
  }

  const updated = questions.map((question) => {
    const given = answers.find((candidate) => candidate.id === question.id);
    return given ? { ...question, answer: given.answer.trim() } : question;
  });

  writeQuestions(job.context.outDir, updated);
  return status(store, id);
}

export function log(store: JobStore, id: string): { text: string } {
  const job = store.get(id);
  return { text: summarizeSession(loadSession(job.context.outDir)) };
}

/** 목록 화면용 요약. 작업마다 상태를 읽으므로 개수가 많아지면 여기가 먼저 느려진다. */
export function listJobs(store: JobStore): StatusView[] {
  return store.list().map((job) => status(store, job.id));
}
