import { existsSync, mkdirSync, readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { writeAtomic } from "../core/atomic";
import { decide, HookInput } from "./hook";
import { findRepoRoot } from "./layout";
import type { ReviewHookInput } from "./reviewHook";
import { hookFailureExit, hookFailureInput, subagentExit } from "./retryPolicy";
import { ACTIVE_FILE, DOCS_SESSION_FILE, REQUEST_SESSION_FILE, STATE_DIR } from "./layout";
import { commonAgentName, withNotation } from "./hostText";
import { CROSS_CHILD_PASS_EVENTS, crossChild } from "./crossEnv";

interface CodexHookInput extends ReviewHookInput {
  tool_name?: string;
  tool_input?: { command?: string; [key: string]: unknown };
  turn_id?: string;
  prompt?: string;
  stop_hook_active?: boolean;
  /** SessionStart 만 — startup·resume·clear·compact·fork(0.162.1 스키마) */
  source?: string;
}

/** 패치 전체를 실행하기 전에 추가·삭제·수정 및 이동 전후 경로 모두를 검사한다. */
export function patchPaths(command: string): string[] {
  const lines = command.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") throw new Error("인식할 수 없는 패치 형식입니다.");
  const paths: string[] = [];
  for (const line of lines.slice(1, -1)) {
    const match = /^\*\*\* (?:Add File|Delete File|Update File|Move to): (.+)$/.exec(line);
    if (match) paths.push(match[1]);
    else if (line.startsWith("*** ") && line !== "*** End of File") throw new Error("지원하지 않는 패치 경로 지시자입니다.");
  }
  if (!paths.length) throw new Error("패치 대상 파일이 없습니다.");
  return paths;
}

/**
 * 실제 UserPromptSubmit만 동의 응답으로 받는다. 모델이 실행할 수 있는 CLI 명령이 아니다.
 * 새 기록(format 2)은 응답 끝에 확인 코드(codexReply 마지막 질문 끝의 6자)를 요구한다 — 요약이 잘려 코드 줄이 빠지는 실수를 막는다.
 * 코드는 모델도 보는 값이라 사람 입력을 증명하지 않는다(같은 세션의 `codex exec resume` 프롬프트도 사용자 메시지로 보인다).
 * 이전 형식 기록은 코드 없이도 받는다(붙어 있으면 무시한다). 동의 응답이 아닌 사용자 메시지에는 아무것도 쓰지 않는다.
 */
export function observeCodexConsent(input: CodexHookInput, root: string): void {
  if (input.hook_event_name !== "UserPromptSubmit" || !input.prompt?.trim().startsWith("code-agent consent respond")) return;
  // 사용자 메시지마다 도는 이벤트다 — 동의 응답일 때만 consent 그래프를 읽는다(hookLoad.test)
  const { codexReplyCode, consentStatus, observeConsent } = require("./consent") as typeof import("./consent");
  const match = /^code-agent consent respond ([a-f0-9-]{36}) ([1-3](?:,[1-3]){0,3})(?: ([a-f0-9]{6}))?$/.exec(input.prompt.trim());
  if (!match || !input.turn_id) throw new Error("현재 consent status의 codexReply 형식으로 답하세요.");
  const status = JSON.parse(consentStatus(root, match[1]));
  const choices = match[2].split(",").map(Number);
  if (status.status !== "pending") throw new Error(`이미 종료했거나 응답한 동의입니다 (${status.status}). 실패한 동의는 새로 준비하고 선택 UI로 확인하세요.`);
  if (choices.length !== status.questions.length) throw new Error("현재 미응답 질문 수와 선택이 일치하지 않습니다.");
  const { required, code } = codexReplyCode(root, match[1]);
  if (required && match[3] !== code) {
    throw new Error("확인 코드가 없거나 다릅니다 — 요약과 질문 끝의 '확인 코드:' 6자를 응답 끝에 붙여 code-agent consent respond <ID> <번호> <확인 코드> 로 다시 보내세요. 요약이 줄어 코드가 보이지 않으면 메인에게 전문을 다시 보여 달라고 하세요.");
  }
  const answers: Record<string, string> = {};
  status.questions.forEach((q: { question: string; options: {label: string}[] }, index: number) => {
    const option = q.options[choices[index] - 1];
    if (!option) throw new Error("준비된 선택지 번호만 사용할 수 있습니다.");
    answers[q.question] = option.label;
  });
  const event = {
    cwd: input.cwd, session_id: input.session_id, agent_id: input.agent_id,
    tool_use_id: `codex-prompt:${input.turn_id}`, tool_name: "AskUserQuestion", tool_input: status.toolInput,
  };
  observeConsent({ ...event, hook_event_name: "PreToolUse" }, root, "codex-prompt");
  observeConsent({ ...event, hook_event_name: "PostToolUse", tool_response: {questions: status.questions, answers} }, root, "codex-prompt");
}

/**
 * Claude PreToolUse matcher(쓰기·셸·읽기·MCP)에 대응하는 Codex 도구. MCP(mcp__서버__도구)는 hook.ts 가 경로 인자를 판정한다.
 * Codex 0.161.0 의 셸 도구는 Windows 에서도 `Bash` 이고 `tool_input.command` 가 PowerShell 스크립트다(실측) — `PowerShell` 은 오지 않지만 같은 판정으로 둔다
 */
const GATED_TOOLS = ["Bash", "PowerShell", "apply_patch"];
/**
 * 판정하지 않아도 되는 Codex 도구 — 파일을 쓰지 않는 하위 에이전트 조율 도구(`collaboration` 이름공간: spawn_agent·wait_agent 등, 0.161.0 실측).
 * doctor 의 "Codex 미판정 도구" 에 세지 않는다
 */
const KNOWN_NON_FILE_TOOL = /^collaboration[a-z_]+$/;
const CODEX_TOOLS_LOG = `${STATE_DIR}/log/codex-tools.json`;

/**
 * 판정하지 않는 Codex 도구 이름을 남긴다 — 작업·접수·문서 세션이 있을 때만(상태 파일은 파싱하지 않는다 — 깨진 상태에서도 막지 않는다).
 * doctor 가 알린다(파일을 쓰는 도구라면 hook 판정 밖이다). log/ 아래라 동의 스냅샷에서 빠진다. 오류는 삼킨다.
 */
export function noteUnknownCodexTool(root: string, name: string): void {
  if (KNOWN_NON_FILE_TOOL.test(name)) return;
  try {
    if (![ACTIVE_FILE, REQUEST_SESSION_FILE, DOCS_SESSION_FILE].some((file) => existsSync(join(root, file)))) return;
    const path = join(root, CODEX_TOOLS_LOG);
    let seen: Record<string, { count: number; last: string }> = {};
    try { const value = JSON.parse(readFileSync(path, "utf8")); if (value && typeof value === "object" && !Array.isArray(value)) seen = value; } catch { /* 처음이거나 깨졌다 */ }
    const key = name.slice(0, 100);
    seen[key] = { count: (typeof seen[key]?.count === "number" ? seen[key].count : 0) + 1, last: new Date().toISOString() };
    mkdirSync(join(root, STATE_DIR, "log"), { recursive: true });
    writeAtomic(path, `${JSON.stringify(seen, null, 2)}\n`);
  } catch { /* 기록은 덤이다 */ }
}
/** doctor 가 읽는다 — 없거나 깨졌으면 빈 목록 */
export function unknownCodexTools(root: string): { name: string; count: number; last: string }[] {
  try {
    const value = JSON.parse(readFileSync(join(root, CODEX_TOOLS_LOG), "utf8")) as Record<string, { count?: unknown; last?: unknown }>;
    return Object.entries(value).map(([name, entry]) => ({ name, count: typeof entry?.count === "number" ? entry.count : 0, last: typeof entry?.last === "string" ? entry.last : "" }));
  } catch { return []; }
}

const deny = (reason?: string): object => reason ? {hookSpecificOutput: {
  hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
}} : {};

/** Codex 이벤트 하나의 판정 — 문구는 Codex 표기로 만든다(hostText.withNotation) */
export function codexHook(input: CodexHookInput): object {
  return withNotation("codex", () => codexEvent(input));
}

function codexEvent(input: CodexHookInput): object {
  // 교차 실행이 띄운 Codex 안에서는 진행 기록(Stop·담당 관찰·동의 응답·세션 시작)을 하지 않는다 — PreToolUse 판정은 그대로 한다
  if (crossChild() && (CROSS_CHILD_PASS_EVENTS as readonly string[]).includes(input.hook_event_name ?? "")) return {};
  // Codex 훅에는 matcher가 없다. 판정 대상이 아닌 도구가 상태 오류로 막히지 않게 먼저 통과시킨다(이름만 남긴다)
  if (input.hook_event_name === "PreToolUse" && !GATED_TOOLS.includes(input.tool_name ?? "") && !(input.tool_name ?? "").startsWith("mcp__")) {
    if (input.tool_name && typeof input.cwd === "string" && isAbsolute(input.cwd)) noteUnknownCodexTool(findRepoRoot(input.cwd), input.tool_name);
    return {};
  }
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) throw new Error("Codex 이벤트의 작업 경로가 없습니다.");
  const root = findRepoRoot(input.cwd);
  if (input.hook_event_name === "PreToolUse") {
    if (!input.tool_name || !input.tool_input) throw new Error("Codex 도구 입력이 없습니다.");
    if (input.tool_name === "mcp__code_agent__confirm") {
      if (crossChild() || input.agent_id !== undefined || !input.session_id) throw new Error("동의 선택 UI는 메인 세션에서만 열 수 있습니다.");
      const id = input.tool_input.id;
      if (typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)
          || Object.keys(input.tool_input).some(key => key !== "id")) throw new Error("동의 선택 UI에는 준비한 ID만 전달합니다. 답을 미리 넣을 수 없습니다.");
      const { consentCommandGuard } = require("./consent") as typeof import("./consent");
      const reason = consentCommandGuard(root, `code-agent consent finish ${id}`, input.session_id);
      if (reason) return deny(reason);
      (require("./consentTicket") as typeof import("./consentTicket")).issueTicket(root, {
        kind: "question", id, sessionId: input.session_id, host: "codex", cwd: input.cwd, command: input.tool_name,
      });
      return {};
    }
    // Windows 의 Codex 는 셸 명령을 PowerShell 로 돌린다 — 괄호·$ 평가를 같은 규칙으로 막는다.
    // 하위 에이전트 안의 호출은 agent_id·agent_type 을 싣는다(0.161.0 실측 — session_id 는 부모와 같다) — 계획 담당·읽기 전용 담당의 쓰기를 가른다
    const common = {cwd: input.cwd, session_id: input.session_id, host: "codex" as const,
      ...(input.agent_id ? {agent_id: input.agent_id} : {}), ...(input.agent_type ? {agent_type: commonAgentName(input.agent_type)} : {}),
      ...(process.platform === "win32" ? {shell: "powershell" as const} : {})};
    if (input.tool_name === "apply_patch") {
      if (typeof input.tool_input.command !== "string") throw new Error("패치 내용이 없습니다.");
      for (const path of patchPaths(input.tool_input.command)) {
        const reason = decide({...common, tool_name: "Edit", tool_input: {file_path: resolve(input.cwd, path)}}, root);
        if (reason) return deny(reason);
      }
      return {};
    }
    // Codex의 exec_command도 공식 hook 계약에서는 Bash/command로 정규화된다. MCP 도구는 decide 가 경로 인자를 판정한다
    const event: HookInput = {...common, tool_name: input.tool_name, tool_input: input.tool_input as HookInput["tool_input"]};
    if (["Bash", "PowerShell"].includes(event.tool_name) && typeof event.tool_input.command !== "string") throw new Error("셸 명령이 없습니다.");
    // 거부 문구의 스킬·도구 표기는 판정이 Codex 표기(withNotation)로 만든다 — 사후 치환은 조사가 깨진다
    return deny(decide(event, root));
  }
  if (input.hook_event_name === "SubagentStart" || input.hook_event_name === "SubagentStop") {
    // Codex transcript는 안정된 API가 아니다. 호스트가 전달한 최종 응답만 관찰한다.
    const event = {...input, agent_type: commonAgentName(input.agent_type), transcript_path: undefined, agent_transcript_path: undefined};
    // Codex 담당은 exit 2 로 되돌리지 않는다(subagentExit — 0.161.0 바이너리에는 SubagentStop exit 2 를 이어가기로 받는 문구가 있으나
    // 실제로 확인하지 않아 쓰지 않는다, HP-15) — 계획 담당의 실패는 되돌림 없이 바로 기록한다.
    // 이벤트별 모듈은 그 분기에서만 읽는다 — 모든 이벤트가 담당 관찰·Stop 판정 그래프를 함께 읽지 않게(hookLoad.test)
    (require("./planningHook") as typeof import("./planningHook")).observePlanner(event, root, {host: "codex"});
    (require("./reviewHook") as typeof import("./reviewHook")).observeReviewer(event, root, "codex");
  } else if (input.hook_event_name === "UserPromptSubmit") {
    observeCodexConsent(input, root);
  } else if (input.hook_event_name === "Stop") {
    const reason = (require("./stopHook") as typeof import("./stopHook")).decideStop(input, root);
    return reason ? {decision: "block", reason} : {};
  } else if (input.hook_event_name === "SessionStart") {
    // Claude session-event 와 같은 진행 상태를 붙이고 작업 임대를 이 세션으로 넘겨받는다(sessionAnchor — 압축 compact 은 넘겨받지 않고,
    // 다른 호스트의 신선한 임대도 넘겨받지 않는다. 임대 기록 실패는 삼킨다). Codex 0.162.1 은 source 에 startup·resume·clear·compact·fork 를
    // 싣고(수동·자동 압축 뒤에도 돈다) additionalContext 를 다음 모델 호출에 넣는다(소스 hooks.rs 시험). resume 은 같은 session_id 다(0.161.0 실측).
    // sessionHook 은 hook 누락 경고 때문에 init 을 읽는다 — 도구 호출마다 도는 이벤트가 읽지 않게 이 분기에서만 읽는다(hookLoad.test)
    const { sessionAnchor } = require("./sessionHook") as typeof import("./sessionHook");
    const text = sessionAnchor(root, typeof input.source === "string" ? input.source : undefined, input.session_id || undefined, "codex");
    return text ? {hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: text}} : {};
  }
  return {};
}

/**
 * 판정 실패의 결과를 Claude 훅과 맞춘다(retryPolicy.hookFailureExit 표). Codex(0.161.0)는 exit 2 와 stderr 사유를 막음으로 받는다 —
 * PreToolUse·UserPromptSubmit 은 실제 호출로 확인했다(Stop·SubagentStop 의 exit 2 이어가기는 바이너리 문구로만 보았다).
 * PreToolUse 판정 실패(와 읽지 못한 입력)는 deny JSON 으로 막고, exit 2 는 판정 전 프로세스 실패의 닫힘(설치 명령의 `|| exit 2`·
 * `$LASTEXITCODE`)으로만 쓴다. Stop은 턴을 막지 않는다. UserPromptSubmit 은 동의 응답만 막고(exit 2 — 사유를 stderr 로 보인다)
 * 그 밖의 사용자 메시지는 막지 않는다. Subagent 이벤트는 subagentExit(Codex 는 언제나 0 — 되돌리지 않는다)이다.
 */
export function runCodexHook(stdin: string): number {
  // 거부·안내 문구는 Codex 표기(스킬 `$ca-x`, 역할 `ca_x`, 질문 도구·셸·파일 도구)로 만든다 — 예외 문구도 같은 범위에서 만든다
  return withNotation("codex", () => runCodexEvent(stdin));
}

/** 기록한 담당 실패인가 — Subagent 분기에서 이미 읽은 reviewHook 의 클래스로 본다. 모듈을 읽지 못하면 기록하지 못한 실패다 */
function recordedFailure(error: unknown): boolean {
  try { return error instanceof (require("./reviewHook") as typeof import("./reviewHook")).RecordedFailure; } catch { return false; }
}

function runCodexEvent(stdin: string): number {
  let event: string | undefined;
  try {
    const input = JSON.parse(stdin) as CodexHookInput;
    event = input.hook_event_name;
    process.stdout.write(JSON.stringify(codexHook(input)));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (event === "SubagentStart" || event === "SubagentStop") {
      // 기록한 실패든 기록하지 못한 판정 실패든 Codex 담당은 되돌리지 않는다(subagentExit) — 사유만 남기고 통과한다
      process.stderr.write(`code-agent codex-event: ${message}\n`);
      process.stdout.write("{}");
      return subagentExit({host: "codex", event, recorded: recordedFailure(error)});
    }
    const result = hookFailureExit(hookFailureInput("codex-event", stdin), message);
    process.stderr.write(event === "Stop" ? `code-agent codex-event 가 Stop 판정에 실패했습니다 (턴은 막지 않았습니다): ${message}\n`
      : event === "UserPromptSubmit" && result.code === 0 ? `code-agent codex-event: 사용자 메시지 관찰에 실패했습니다(메시지는 막지 않았습니다): ${message}\n`
      : `code-agent codex-event: ${message}\n`);
    if (result.stdout) process.stdout.write(result.stdout);
    return result.code;
  }
}
