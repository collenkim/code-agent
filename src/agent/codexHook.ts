import { isAbsolute, resolve } from "path";
import { decide, HookInput } from "./hook";
import { findRepoRoot } from "./layout";
import { observePlanner } from "./planningHook";
import { observeReviewer, ReviewHookInput } from "./reviewHook";
import { decideStop } from "./stopHook";
import { consentStatus, observeConsent } from "./consent";
import { commonAgentName } from "./hosts";

interface CodexHookInput extends ReviewHookInput {
  tool_name?: string;
  tool_input?: { command?: string; [key: string]: unknown };
  turn_id?: string;
  prompt?: string;
  stop_hook_active?: boolean;
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

/** 실제 UserPromptSubmit만 동의 응답으로 받는다. 모델이 실행할 수 있는 CLI 명령이 아니다. */
export function observeCodexConsent(input: CodexHookInput, root: string): void {
  if (input.hook_event_name !== "UserPromptSubmit" || !input.prompt?.trim().startsWith("code-agent consent respond")) return;
  const match = /^code-agent consent respond ([a-f0-9-]{36}) ([1-3](?:,[1-3]){0,3})$/.exec(input.prompt.trim());
  if (!match || !input.turn_id) throw new Error("현재 consent status의 codexReply 형식으로 답하세요.");
  const status = JSON.parse(consentStatus(root, match[1]));
  const choices = match[2].split(",").map(Number);
  if (status.status !== "pending" || choices.length !== status.questions.length) throw new Error("현재 미응답 질문 수와 선택이 일치하지 않습니다.");
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

/** Claude PreToolUse matcher(쓰기·셸·읽기)에 대응하는 Codex 도구. 그 밖의 도구는 Claude처럼 판정하지 않는다. */
const GATED_TOOLS = ["Bash", "PowerShell", "apply_patch"];

const deny = (reason?: string): object => reason ? {hookSpecificOutput: {
  hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
}} : {};

export function codexHook(input: CodexHookInput): object {
  // Codex 훅에는 matcher가 없다. 판정 대상이 아닌 도구가 상태 오류로 막히지 않게 먼저 통과시킨다.
  if (input.hook_event_name === "PreToolUse" && !GATED_TOOLS.includes(input.tool_name ?? "")) return {};
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) throw new Error("Codex 이벤트의 작업 경로가 없습니다.");
  const root = findRepoRoot(input.cwd);
  if (input.hook_event_name === "PreToolUse") {
    if (!input.tool_name || !input.tool_input) throw new Error("Codex 도구 입력이 없습니다.");
    // Windows 의 Codex 는 셸 명령을 PowerShell 로 돌린다 — 괄호·$ 평가를 같은 규칙으로 막는다
    const common = {cwd: input.cwd, session_id: input.session_id, ...(process.platform === "win32" ? {shell: "powershell" as const} : {})};
    if (input.tool_name === "apply_patch") {
      if (typeof input.tool_input.command !== "string") throw new Error("패치 내용이 없습니다.");
      for (const path of patchPaths(input.tool_input.command)) {
        const reason = decide({...common, tool_name: "Edit", tool_input: {file_path: resolve(input.cwd, path)}}, root);
        if (reason) return deny(reason);
      }
      return {};
    }
    // Codex의 exec_command도 공식 hook 계약에서는 Bash/command로 정규화된다.
    const event: HookInput = {...common, tool_name: input.tool_name, tool_input: input.tool_input};
    if (["Bash", "PowerShell"].includes(event.tool_name) && typeof event.tool_input.command !== "string") throw new Error("셸 명령이 없습니다.");
    const reason = decide(event, root);
    return deny(reason?.replace("파일은 Write/Edit 로 고치고, 읽기는 Read/Grep/Glob 을 쓰세요.", "파일은 apply_patch로 고치고, 읽기는 code-agent read <파일> [시작 줄] [줄 수]를 쓰세요."));
  }
  if (input.hook_event_name === "SubagentStart" || input.hook_event_name === "SubagentStop") {
    // Codex transcript는 안정된 API가 아니다. 호스트가 전달한 최종 응답만 관찰한다.
    const event = {...input, agent_type: commonAgentName(input.agent_type), transcript_path: undefined, agent_transcript_path: undefined};
    observePlanner(event, root);
    observeReviewer(event, root);
  } else if (input.hook_event_name === "UserPromptSubmit") {
    observeCodexConsent(input, root);
  } else if (input.hook_event_name === "Stop") {
    const reason = decideStop(input, root);
    return reason ? {decision: "block", reason: reason.replace(/AskUserQuestion/g, "Codex 질문 절차")} : {};
  }
  return {};
}

/**
 * 판정 실패의 결과를 Claude 훅과 맞춘다. Codex는 exit 2로 도구를 막거나 턴을 이어가지 않는다.
 * PreToolUse는 `runHook`처럼 막는 쪽으로 닫고, Stop은 `runStopHook`처럼 턴을 막지 않는다.
 */
export function runCodexHook(stdin: string): number {
  let event: string | undefined;
  try {
    const input = JSON.parse(stdin) as CodexHookInput;
    event = input.hook_event_name;
    process.stdout.write(JSON.stringify(codexHook(input)));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (event === "PreToolUse") {
      process.stdout.write(JSON.stringify(deny(`code-agent codex-event 가 판정에 실패해 막았습니다: ${message}`)));
      return 0;
    }
    if (event === "Stop") {
      process.stderr.write(`code-agent codex-event 가 Stop 판정에 실패했습니다 (턴은 막지 않았습니다): ${message}\n`);
      process.stdout.write("{}");
      return 0;
    }
    process.stderr.write(`code-agent codex-event: ${message}\n`);
    return 2;
  }
}
