/** 호스트 질문을 표시하기 전 영속화하고 첫 실제 응답만 소비한다. */
import { randomUUID } from "crypto";
import { PublishInteraction, type InteractionQuestion, type InteractionSubmission, validateInteractionAnswers } from "./interactionSchema";
import { bumpInteraction, contextMatches, currentInteractions, interactionContext, interactionHash, mutateInteractions, needInteraction, publishInteraction, type InteractionRecord } from "./interactions";
import { stageOf } from "./interactionSources";
import type { InteractionTicket } from "./interactionTicket";

export function publishNativeInteraction(root: string, questions: { title: string; options: string[] }[], ticket: Pick<InteractionTicket, "sessionId" | "host" | "runId">): InteractionRecord {
  const items: InteractionQuestion[] = questions.map((q, i) => ({ questionId: /^Q\d+\b/.exec(q.title)?.[0] ?? `q${i + 1}`, title: q.title, background: "호스트가 표시한 질문입니다.", mode: "single", required: true,
    options: q.options.map((label, n) => ({ optionId: `option-${n + 1}`, label, description: "호스트가 제시한 선택지", consequence: "선택한 답을 원래 세션에 전달합니다." })),
    minSelections: 0, maxSelections: 1, recommendedOptionIds: [], defaultOptionIds: [], recommendationReason: "호스트 질문에 구조화된 추천 근거가 없어 추천을 추측하지 않습니다.", evidence: [],
    input: ticket.host === "claude" ? { required: false, minLength: 1, maxLength: 2000, description: "실제 사용자의 직접 입력" } : undefined }));
  const input = PublishInteraction.parse({ key: `native:${interactionHash(questions).slice(7, 47)}`, stage: stageOf(root), title: questions[0].title, questions: items });
  const record = publishInteraction(root, input, interactionContext(root, ticket.sessionId, ticket.host, ticket.runId));
  // 새 호스트 질문 호출은 보류·만료한 화면을 다시 열 수 있다. 이미 받은 답과 취소는 되살리지 않는다.
  if (!record.response && (["deferred", "expired"].includes(record.status) || (record.status === "pending" && Date.parse(record.expiresAt) <= Date.now()))) {
    return mutateInteractions(root, state => {
      const saved = needInteraction(state, record.requestId);
      if (saved.response || !["pending", "deferred", "expired"].includes(saved.status)) return saved;
      saved.status = "pending"; saved.expiresAt = new Date(Date.now() + input.expiresInMs).toISOString(); saved.challenge = randomUUID();
      saved.nativeCallIds = [];
      bumpInteraction(state, saved); return saved;
    });
  }
  return record;
}
export function acceptNativeInteraction(root: string, id: string, sessionId: string, channel: "claude-question" | "codex-elicitation", values: string[] | undefined): InteractionRecord {
  return mutateInteractions(root, state => {
    const r = needInteraction(state, id);
    if (r.kind === "host-permission") throw new Error("호스트 실행 권한은 대시보드의 별도 권한 응답으로 처리합니다");
    if (r.context.sessionId !== sessionId) throw new Error("질문을 발행한 세션과 다릅니다");
    if (!contextMatches(root, r.context) || Date.parse(r.expiresAt) <= Date.now()) throw new Error("질문 문맥이 바뀌었거나 만료되었습니다");
    if (r.response) {
      if (r.response.channel === "dashboard-human") throw new Error(`대시보드에서 먼저 응답했습니다. code-agent interaction consume ${id}로 그 답을 사용하세요.`);
      return r;
    }
    if (r.status !== "pending") throw new Error(`응답할 수 없는 질문입니다: ${r.status}`);
    if (!values) { r.status = "deferred"; bumpInteraction(state, r); return r; }
    if (values.length !== r.questions.length) throw new Error("질문 수와 응답 수가 다릅니다");
    const submission: InteractionSubmission = { intent: "submit", explicit: true, answers: r.questions.map((q, i) => {
      const option = q.options.find(o => o.label === values[i]);
      return { questionId: q.questionId, optionIds: option ? [option.optionId] : [], optionInputs: {}, ...(!option ? { text: values[i] } : {}) };
    }) };
    validateInteractionAnswers(r.questions, submission);
    const at = new Date().toISOString();
    r.response = { receiptId: randomUUID(), commandId: `native:${id}`, at, channel, submission };
    r.consumed = { at, sessionId }; r.application = { state: "applied", at, result: { deliveredToHost: true } }; r.status = "applied"; bumpInteraction(state, r);
    return r;
  });
}

export function observeNativeQuestion(root: string, input: { tool_name?: string; tool_use_id?: string; hook_event_name?: string; session_id?: string; agent_id?: string; tool_input?: Record<string, unknown>; tool_response?: unknown }): void {
  if (input.tool_name !== "AskUserQuestion" || input.agent_id || !input.session_id || !["PreToolUse", "PostToolUse"].includes(input.hook_event_name ?? "")) return;
  if (!Array.isArray(input.tool_input?.questions) || input.tool_input?.answers) return;
  const raw = input.tool_input.questions as { question: string; options: { label: string }[]; multiSelect?: boolean }[];
  if (!input.tool_use_id || !raw.length || raw.some(q => typeof q.question !== "string" || !Array.isArray(q.options) || q.multiSelect)) return;
  const questions = raw.map(q => ({ title: q.question, options: q.options.map(o => o.label) }));
  let r: InteractionRecord;
  if (input.hook_event_name === "PreToolUse") {
    r = publishNativeInteraction(root, questions, { sessionId: input.session_id, host: "claude", runId: process.env.CODE_AGENT_MASTER_RUN });
    if (r.response) throw new Error(`이미 받은 답이 있습니다. code-agent interaction consume ${r.requestId}로 확인하고 재질문하지 마세요.`);
    mutateInteractions(root, state => { const saved = needInteraction(state, r.requestId); saved.nativeCallIds = [...new Set([...(saved.nativeCallIds ?? []), input.tool_use_id!])]; bumpInteraction(state, saved); });
    return;
  }
  const observed = currentInteractions(root).requests.find(r => r.context.sessionId === input.session_id && r.nativeCallIds?.includes(input.tool_use_id!) && r.key === `native:${interactionHash(questions).slice(7, 47)}`);
  if (!observed) return;
  r = observed;
  const result = input.tool_response as { answers?: Record<string, unknown>; afkTimeoutMs?: unknown; followUp?: unknown } | undefined;
  const answers = result?.answers;
  const values = answers && !Object.hasOwn(result!, "afkTimeoutMs") && !result?.followUp && questions.every(q => typeof answers[q.title] === "string" && (answers[q.title] as string).trim()) ? questions.map(q => answers[q.title] as string) : undefined;
  acceptNativeInteraction(root, r.requestId, input.session_id, "claude-question", values);
}
