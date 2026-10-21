/** 호스트 원본과 업무 답 원장을 읽기만 한다. 답·승인·업무 문서를 만들지 않는다. */
import { readFileSync, realpathSync } from "fs";
import { answerHash, readAnswerRows, type AnswerRow } from "./answers";
import { nativeSession } from "./master/nativeSession";
import type { InteractionRecord } from "./interactions";

export function nativeEvidenceReader(root: string) {
  const workRows = new Map<string, AnswerRow[]>(), sessions = new Map<string, any[]>();
  return (r: InteractionRecord, supplied?: AnswerRow[]): boolean => {
    if (r.response || r.origin?.type !== "host" || !r.key?.startsWith("native:") || r.context.host !== "claude" ||
        r.context.root !== realpathSync(root) || !r.nativeCallIds?.length || !r.questions.length) return false;
    if (r.context.workId) {
      if (!workRows.has(r.context.workId)) workRows.set(r.context.workId, readAnswerRows(root, r.context.workId));
      const rows = supplied ?? workRows.get(r.context.workId)!;
      return r.nativeCallIds.some(id => {
        const at = rows.findIndex(row => row.type === "ask" && row.session === r.context.sessionId && row.toolId === id);
        const ask = rows[at];
        return ask?.type === "ask" && ask.prefilled === false && ask.items.length === r.questions.length && r.questions.every((q, i) =>
          ask.items[i].questionHash === answerHash(q.title) && JSON.stringify(ask.items[i].options) === JSON.stringify(q.options.map(o => o.label))) &&
          rows.slice(at + 1).some(row => row.type === "answer" && row.session === r.context.sessionId && row.toolId === id && row.items.length === r.questions.length &&
            r.questions.every(q => row.items.some(item => item.questionHash === answerHash(q.title) && item.answer.trim())));
      });
    }
    // ID가 없는 접수 전·완료 후 질문은 검증된 주 세션의 구조화된 도구 결과만 사용한다.
    if (!sessions.has(r.context.sessionId)) {
      let rows: any[] = [];
      try { const source = nativeSession(root, "claude", r.context.sessionId); rows = readFileSync(source.file, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
      catch { /* 원본을 입증할 수 없으면 대기를 유지한다. */ }
      sessions.set(r.context.sessionId, rows);
    }
    const rows = sessions.get(r.context.sessionId)!;
    return r.nativeCallIds.some(id => {
      const at = rows.findIndex(row => row.type === "assistant" && row.sessionId === r.context.sessionId && row.isSidechain !== true && Array.isArray(row.message?.content) && row.message.content.some((b: any) =>
        b.type === "tool_use" && b.name === "AskUserQuestion" && b.id === id && (!b.input?.answers || Object.keys(b.input.answers).length === 0) &&
        Array.isArray(b.input?.questions) && b.input.questions.length === r.questions.length && r.questions.every((q, i) =>
          b.input.questions[i].question === q.title && !b.input.questions[i].multiSelect && JSON.stringify(b.input.questions[i].options?.map((o: any) => o.label)) === JSON.stringify(q.options.map(o => o.label)))));
      if (at < 0) return false;
      return rows.slice(at + 1).some(row => row.type === "user" && row.isSidechain !== true && row.sessionId === r.context.sessionId &&
        Array.isArray(row.message?.content) && row.message.content.some((b: any) => b.type === "tool_result" && b.tool_use_id === id && !b.is_error) &&
        row.toolUseResult && !Object.hasOwn(row.toolUseResult, "afkTimeoutMs") && !row.toolUseResult.followUp &&
        r.questions.every(q => typeof row.toolUseResult.answers?.[q.title] === "string" && row.toolUseResult.answers[q.title].trim()));
    });
  };
}
