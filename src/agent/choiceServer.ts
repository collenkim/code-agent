/**
 * 로컬 MCP 폼 입력. 사용자 답은 클라이언트의 elicitation 응답으로만 받는다.
 *
 * 이 프로세스는 Codex 세션이 끝날 때까지 돈다. 연결부(JSON-RPC·폼 왕복)는 시작 때의 버전이고, 질문·동의 처리(askChoice·confirmChoice)는
 * 호출마다 이 프로젝트의 **지금 적용 버전**의 것을 쓴다 — 그래야 hook 과 같은 버전이 동의를 관찰한다. 다른 릴리스의 처리기는 그 릴리스
 * 폴더(설치 뒤 바뀌지 않는다)에서 통째로 읽는다. 적용 버전을 쓸 수 없는데 진행 중인 일이 있으면 다른 버전으로 처리하지 않는다.
 * 두 함수의 이름·인자는 릴리스 사이의 계약이다(runtimeSelect.ts 머리말).
 */
import { randomUUID } from "crypto";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { createInterface } from "readline";
import { z } from "zod";
import { isPackaged, packageVersion } from "./assets";
import { consentStatus, observeConsent } from "./consent";
import type { ConsentHookInput } from "./consent";
import { takeTicket } from "./consentTicket";
import { findRepoRoot, STATE_DIR } from "./layout";
import { appliedStore, busyMarker, entryScript, installedRelease, ownRelease, readRuntime, type RuntimeState } from "./runtimeSelect";
import { QUESTION_ROWS, questionScreenProblem } from "./screenText";
import { Stop } from "./stop";
import { PublishInteraction } from "./interactionSchema";
import { takeInteractionTicket } from "./interactionTicket";
import { publishNativeInteraction, acceptNativeInteraction } from "./interactionNative";
import { publishHostInteraction } from "./interactionSources";
import { readInteractions } from "./interactions";

const Question = z.object({
  title: z.string().min(1).max(8000),
  options: z.array(z.string().min(1).max(1000)).min(2).max(8),
}).strict();
const Ask = z.object({ questions: z.array(Question).min(1).max(4), interaction: PublishInteraction.optional() }).strict();
const Confirm = z.object({ id: z.string().uuid() }).strict();
type Form = { message: string; requestedSchema: Record<string, unknown>; mode: "form" };
const CONFIRM_MESSAGE = "확인 내용 전문을 읽은 뒤 방향키로 선택하고 Enter로 확정하세요. Esc는 보류입니다.";
export type Elicit = (form: Form) => Promise<unknown>;

function formOf(message: string, questions: { title: string; options: string[] }[]): Form {
  return { mode: "form", message, requestedSchema: {
    type: "object",
    properties: Object.fromEntries(questions.map((q, index) => [`q${index + 1}`, { type: "string", title: q.title, enum: q.options }])),
    required: questions.map((_, index) => `q${index + 1}`),
  } };
}

export async function askChoice(args: unknown, elicit: Elicit, root?: string): Promise<unknown> {
  const { questions, interaction } = Ask.parse(args);
  for (const question of questions) if (new Set(question.options).size !== question.options.length) throw new Stop("선택지 이름은 서로 달라야 합니다.");
  // 폼은 화면 높이를 넘는 본문을 스크롤 없이 자른다 — 다 보이지 않는 질문은 표시하지 않고 모델에게 돌려보낸다
  for (const question of questions) {
    const problem = questionScreenProblem(question.title, question.options);
    if (problem) throw new Stop(problem);
  }
  const ticket = root ? takeInteractionTicket(root, "mcp-ask") : undefined;
  const durable = root && ticket ? interaction ? publishHostInteraction(root, interaction, ticket) : publishNativeInteraction(root, questions, ticket) : undefined;
  if (durable && (durable.response || interaction)) return { status: durable.status, requestId: durable.requestId, next: `code-agent interaction consume ${durable.requestId}`, message: "저장한 요청의 실제 답을 기다립니다. 추천·기본 선택은 응답이 아닙니다." };
  let timer: ReturnType<typeof setInterval> | undefined;
  const formResponse = elicit(formOf("각 질문의 선택지를 방향키로 이동하고 Enter로 확정하세요. Esc는 취소입니다.", questions));
  let response: unknown;
  try {
    response = await Promise.race([formResponse, new Promise((resolve, reject) => {
      if (durable && root) timer = setInterval(() => {
        try {
          const r = readInteractions(root)?.requests[durable.requestId];
          if (r?.response?.channel === "dashboard-human") resolve({ dashboard: r });
        } catch (error) { reject(error); }
      }, 200);
    })]);
  } finally { if (timer) clearInterval(timer); }
  if (response && typeof response === "object" && "dashboard" in response && durable && root && ticket) {
    const r = readInteractions(root)!.requests[durable.requestId];
    (require("./interactionService") as typeof import("./interactionService")).consumeInteraction(root, r.requestId, ticket.sessionId);
    return { status: "answered", source: "dashboard-human", requestId: r.requestId, answers: r.response!.submission.answers,
      next: `답을 적용한 뒤 code-agent interaction complete ${r.requestId} <결과.json>으로 소비 결과를 남깁니다.` };
  }
  const parsed = readResponse(response, questions.map(q => q.options));
  if (durable && root && ticket) acceptNativeInteraction(root, durable.requestId, ticket.sessionId, "codex-elicitation", parsed);
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
    // 요약 전문은 대화와 전문 파일에 있다 — 폼의 message 에 다시 실으면 질문 줄이 화면 밖으로 밀려 잘린다
    const result = await elicit(formOf(CONFIRM_MESSAGE, questions.map(q => ({ title: q.question, options: q.options.map(o => o.label) }))));
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

interface Handlers { id: string; askChoice: typeof askChoice; confirmChoice: typeof confirmChoice }

function load(file: string, id: string): Handlers {
  const loaded = require(file) as Partial<Handlers>;
  if (typeof loaded.askChoice !== "function" || typeof loaded.confirmChoice !== "function") throw new Stop(`${id} 의 선택 UI 처리기를 읽지 못했습니다.`);
  return { id, askChoice: loaded.askChoice, confirmChoice: loaded.confirmChoice };
}

/**
 * 이 호출을 처리할 버전 — 진입점이 hook 에 고르는 것과 같다(runtimeSelect.selectRuntime): 적용 버전이 있으면 그 릴리스, 없으면 진입점의 번들.
 * 적용 버전이 없어졌거나 기록을 읽지 못했는데 진행 중인 일이 있으면 처리하지 않는다. 연결부 자신이면 이 모듈의 함수다.
 */
export function handlersFor(root: string): Handlers {
  const own = ownRelease()?.id;
  const mine = { id: own ?? `번들 ${packageVersion()}`, askChoice, confirmChoice };
  if (isPackaged()) return mine;
  let applied: string | undefined, state: RuntimeState | undefined;
  try { state = readRuntime(root); applied = state?.applied; }
  catch (error) {
    if (busyMarker(root)) throw new Stop(`적용 버전 기록을 읽지 못해 선택 UI 를 처리하지 않습니다 — ${error instanceof Error ? error.message : String(error)}. 사람이 code-agent version 으로 확인하세요.`);
  }
  if (applied) {
    if (applied === own) return mine;
    const release = installedRelease(applied, appliedStore(state));
    if (release) return load(join(release.dir, "dist", "agent", "choiceServer.js"), applied);
    if (busyMarker(root)) throw new Stop(`이 프로젝트에 적용한 code-agent ${applied} 가 릴리스 저장소에 없어 선택 UI 를 처리하지 않습니다 — 사람이 code-agent version 으로 확인하고 code-agent update 로 다시 설치하세요.`);
  }
  const bundle = join(dirname(entryScript()), "choiceServer.js");
  return !own && resolve(bundle) === resolve(__filename) ? mine : load(bundle, "진입점 번들");
}

/** 줄 단위 JSON-RPC stdio. stdout에는 프로토콜만 쓰고 임의 실행·답 입력 인자는 제공하지 않는다. */
export async function runChoiceServer(root: string): Promise<number> {
  root = findRepoRoot(root);
  const connector = ownRelease()?.id ?? `번들 ${packageVersion()}`;
  // 실행 기록 — version 이 이 연결부와 마지막 호출의 처리 버전을 보인다(.code-agent/log 는 커밋하지 않는다)
  const recordFile = join(root, STATE_DIR, "log", "choice-server", `${process.pid}.json`);
  const started = { pid: process.pid, connector, entry: entryScript(), startedAt: new Date().toISOString() };
  const record = (extra: object = {}) => { try { mkdirSync(join(recordFile, ".."), { recursive: true }); writeFileSync(recordFile, JSON.stringify({ ...started, ...extra })); } catch { /* 기록은 조회용이다 */ } };
  record();
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
    { name: "ask", description: `업무 질문을 방향키·Enter 선택 UI로 표시하고 실제 사용자 답을 기다립니다. 문서·정책·복구 선택에 사용합니다. 폼은 화면을 넘는 본문을 자르므로 title은 ${QUESTION_ROWS}줄 이내로 쓰고 긴 배경은 호출 전에 대화에 씁니다. 실행 동의는 confirm을 사용하세요.`, inputSchema: z.toJSONSchema(Ask) },
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
        result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "code-agent-choices", version: connector } };
      } else if (!initialized) throw new Stop("초기화되지 않은 연결입니다.");
      else if (message.method === "ping") result = {};
      else if (message.method === "tools/list") result = { tools };
      else if (message.method === "tools/call") {
        if (busy) throw new Stop("현재 선택에 답하거나 취소한 뒤 다음 질문을 여세요.");
        if (!formSupported) throw new Stop("클라이언트에 MCP 폼 선택 UI가 없습니다. 대화형 Codex를 갱신하세요.");
        busy = true;
        activeCallId = message.id;
        try {
          const name = message.params?.name;
          if (name !== "ask" && name !== "confirm") throw new Stop("지원하지 않는 선택 도구입니다.");
          const handlers = handlersFor(root);
          record({ lastCall: { at: new Date().toISOString(), tool: name, handler: handlers.id } });
          const value = name === "ask" ? await handlers.askChoice(message.params.arguments, elicit, root) : await handlers.confirmChoice(root, message.params.arguments, elicit);
          // 처리한 버전을 함께 돌려준다 — 실행 중인 세션에서 새 버전 적용을 실제 결과로 확인한다
          result = { content: [{ type: "text", text: JSON.stringify(value && typeof value === "object" ? { ...value, runtime: handlers.id } : value) }] };
        } finally {
          if (pending) { send({ method: "notifications/cancelled", params: { requestId: pending.id, reason: "질문 호출이 다른 응답 채널에서 끝났습니다." } }); pending.resolve({ action: "cancel" }); pending = undefined; }
          busy = false; activeCallId = undefined;
        }
      } else { send({ id: message.id, error: { code: -32601, message: "Method not found" } }); return; }
      send({ id: message.id, result });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (message.method === "tools/call") send({ id: message.id, result: { isError: true, content: [{ type: "text", text }] } });
      else send({ id: message.id, error: { code: -32602, message: text } });
    }
  });
  await new Promise<void>(resolve => lines.once("close", () => { pending?.reject(new Stop("선택 UI 연결이 종료됐습니다.")); resolve(); }));
  try { rmSync(recordFile, { force: true }); } catch { /* 다음 조회가 살아 있는 pid 만 본다 */ }
  return 0;
}
