/** 로컬 MCP 폼 입력. 사용자 답은 클라이언트의 elicitation 응답으로만 받는다. */
import { randomUUID } from "crypto";
import { createInterface } from "readline";
import { z } from "zod";
import { consentStatus, observeConsent } from "./consent";
import type { ConsentHookInput } from "./consent";
import { takeTicket } from "./consentTicket";
import { findRepoRoot } from "./layout";
import { Stop } from "./stop";

const Question = z.object({
  title: z.string().min(1).max(8000),
  options: z.array(z.string().min(1).max(1000)).min(2).max(8),
}).strict();
const Ask = z.object({ questions: z.array(Question).min(1).max(4) }).strict();
const Confirm = z.object({ id: z.string().uuid() }).strict();
type Form = { message: string; requestedSchema: Record<string, unknown>; mode: "form" };
export type Elicit = (form: Form) => Promise<unknown>;

function formOf(message: string, questions: { title: string; options: string[] }[]): Form {
  return { mode: "form", message, requestedSchema: {
    type: "object",
    properties: Object.fromEntries(questions.map((q, index) => [`q${index + 1}`, { type: "string", title: q.title, enum: q.options }])),
    required: questions.map((_, index) => `q${index + 1}`),
  } };
}

export async function askChoice(args: unknown, elicit: Elicit): Promise<unknown> {
  const { questions } = Ask.parse(args);
  for (const question of questions) if (new Set(question.options).size !== question.options.length) throw new Stop("선택지 이름은 서로 달라야 합니다.");
  const response = await elicit(formOf("각 질문의 선택지를 방향키로 이동하고 Enter로 확정하세요. Esc는 취소입니다.", questions));
  const parsed = readResponse(response, questions.map(q => q.options));
  return parsed ? { status: "answered", answers: questions.map((q, i) => ({ question: q.title, answer: parsed[i] })) }
    : { status: "cancelled", message: "사용자가 선택을 취소했습니다. 기본값으로 진행하지 마세요." };
}

function readResponse(response: unknown, choices: string[][]): string[] | undefined {
  const result = z.object({ action: z.enum(["accept", "decline", "cancel"]), content: z.record(z.string(), z.unknown()).nullish() }).strict().parse(response);
  if (result.action !== "accept") return undefined;
  const content = result.content;
  if (!content || Object.keys(content).length !== choices.length) throw new Stop("모든 질문에 명시적으로 선택해야 합니다.");
  return choices.map((options, index) => {
    const value = content[`q${index + 1}`];
    if (typeof value !== "string" || !options.includes(value)) throw new Stop("표시한 선택지 밖의 응답은 받지 않습니다.");
    return value;
  });
}

export async function confirmChoice(root: string, args: unknown, elicit: Elicit): Promise<unknown> {
  const { id } = Confirm.parse(args);
  const ticket = takeTicket(root, "question", id);
  if (!ticket || ticket.host !== "codex" || ticket.command !== "mcp__code_agent__confirm") throw new Stop("동의 선택 UI 호출을 현재 세션의 hook이 관찰하지 못했습니다. hook을 확인하고 같은 세션에서 다시 호출하세요.");
  const status = JSON.parse(consentStatus(root, id));
  if (status.status !== "pending") throw new Stop(`응답 가능한 동의가 아닙니다 (${status.status}). 실패한 동의는 새로 준비하세요.`);
  const questions = status.questions as { question: string; options: { label: string; description: string }[] }[];
  const event: ConsentHookInput = {
    cwd: ticket.cwd, session_id: ticket.sessionId, tool_use_id: `codex-elicitation:${randomUUID()}`,
    tool_name: "AskUserQuestion", tool_input: status.toolInput,
  };
  observeConsent({ ...event, hook_event_name: "PreToolUse" }, root, "codex-elicitation");
  let answers: Record<string, string> = {};
  try {
    const result = await elicit(formOf(status.summary, questions.map(q => ({ title: q.question, options: q.options.map(o => o.label) }))));
    const selected = readResponse(result, questions.map(q => q.options.map(o => o.label)));
    if (selected) answers = Object.fromEntries(questions.map((q, i) => [q.question, selected[i]]));
    else answers = Object.fromEntries(questions.map(q => [q.question, "보류"]));
  } catch (error) {
    // 전송 중단·잘못된 응답은 동의를 승인하지 않고 호출을 소비한다.
    observeConsent({ ...event, hook_event_name: "PostToolUse", tool_response: { questions, answers: {} } }, root, "codex-elicitation");
    throw error;
  }
  observeConsent({ ...event, hook_event_name: "PostToolUse", tool_response: { questions, answers } }, root, "codex-elicitation");
  const after = JSON.parse(consentStatus(root, id));
  return { id: after.id, status: after.status, failure: after.failure };
}

/** 줄 단위 JSON-RPC stdio. stdout에는 프로토콜만 쓰고 임의 실행·답 입력 인자는 제공하지 않는다. */
export async function runChoiceServer(root: string): Promise<number> {
  root = findRepoRoot(root);
  const lines = createInterface({ input: process.stdin });
  const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  let formSupported = false, initialized = false, busy = false;
  let activeCallId: string | number | undefined;
  let pending: { id: string; resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
  const elicit: Elicit = form => new Promise((resolve, reject) => {
    if (!formSupported) return reject(new Stop("이 Codex 클라이언트는 MCP 폼 선택 UI를 지원하지 않습니다. 대화형 Codex를 갱신하세요."));
    const id = `choice:${randomUUID()}`;
    pending = { id, resolve, reject };
    send({ id, method: "elicitation/create", params: form });
  });
  const tools = [
    { name: "ask", description: "업무 질문을 방향키·Enter 선택 UI로 표시하고 실제 사용자 답을 기다립니다. 문서·정책·복구 선택에 사용합니다. 실행 동의는 confirm을 사용하세요.", inputSchema: z.toJSONSchema(Ask) },
    { name: "confirm", description: "현재 세션에서 준비한 code-agent 동의를 선택 UI로 표시합니다. ID만 전달하며 응답은 사용자가 직접 선택합니다. 반환 후 승인 상태에서 consent finish로 진행합니다.", inputSchema: z.toJSONSchema(Confirm) },
  ];
  lines.on("line", async line => {
    let message: any;
    try { message = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: "Invalid JSON" } }); return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) { send({ id: null, error: { code: -32600, message: "Invalid request" } }); return; }
    if (pending && message.id === pending.id && !message.method) {
      const current = pending; pending = undefined;
      if (message.error) current.reject(new Stop("선택 UI 호출이 실패했습니다.")); else current.resolve(message.result);
      return;
    }
    if (message.method === "notifications/cancelled") {
      if (activeCallId !== undefined && message.params?.requestId === activeCallId) { pending?.reject(new Stop("선택 요청이 취소됐습니다.")); pending = undefined; }
      return;
    }
    if (message.id === undefined) return;
    try {
      let result: unknown;
      if (message.method === "initialize") {
        if (initialized) throw new Stop("이미 초기화한 연결입니다.");
        initialized = true;
        formSupported = !!message.params?.capabilities?.elicitation?.form;
        result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "code-agent-choices", version: "1.0.0" } };
      } else if (!initialized) throw new Stop("초기화되지 않은 연결입니다.");
      else if (message.method === "ping") result = {};
      else if (message.method === "tools/list") result = { tools };
      else if (message.method === "tools/call") {
        if (busy) throw new Stop("현재 선택에 답하거나 취소한 뒤 다음 질문을 여세요.");
        if (!formSupported) throw new Stop("클라이언트에 MCP 폼 선택 UI가 없습니다. 대화형 Codex를 갱신하세요.");
        busy = true;
        activeCallId = message.id;
        try {
          const value = message.params?.name === "ask" ? await askChoice(message.params.arguments, elicit)
            : message.params?.name === "confirm" ? await confirmChoice(root, message.params.arguments, elicit)
            : (() => { throw new Stop("지원하지 않는 선택 도구입니다."); })();
          result = { content: [{ type: "text", text: JSON.stringify(value) }] };
        } finally { busy = false; activeCallId = undefined; }
      } else { send({ id: message.id, error: { code: -32601, message: "Method not found" } }); return; }
      send({ id: message.id, result });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (message.method === "tools/call") send({ id: message.id, result: { isError: true, content: [{ type: "text", text }] } });
      else send({ id: message.id, error: { code: -32602, message: text } });
    }
  });
  await new Promise<void>(resolve => lines.once("close", () => { pending?.reject(new Stop("선택 UI 연결이 종료됐습니다.")); resolve(); }));
  return 0;
}
