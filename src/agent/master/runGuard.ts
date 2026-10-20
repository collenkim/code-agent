/**
 * master 실행 세션의 hook 판정 — 감독 프로세스가 호스트에 넣은 `CODE_AGENT_MASTER_RUN=<runId>` 가 있을 때만 본다. 그 밖의 세션에는
 * 아무것도 하지 않는다(연동하지 않은 프로젝트·작업은 기존 판정 그대로).
 *
 * - 정지·취소가 요청됐거나 실행이 끝난 것으로 기록됐으면 모든 도구를 막는다 — 모델은 보고하고 턴을 끝낸다(협력 정지).
 * - 질문 도구는 막는다: 사람이 없는 실행이라 답을 받을 수 없다. 동의는 준비까지만, 업무 질문은 questions.md 에 적고 멈춘다.
 * - `code-agent takeover`·`code-agent master` 는 막는다: 실행 세션이 임대·제어를 스스로 바꾸지 않는다.
 *
 * hook 경로 모듈이다 — fs·path·표기 함수와 순수 계약 모듈(protocol.ts)만 읽는다(명령 모듈을 import 하지 않는다).
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { askVia, skill } from "../hostText";
import { STATE_DIR } from "../layout";
import { TERMINAL_RUN_STATES } from "./protocol";

export const MASTER_RUN_ENV = "CODE_AGENT_MASTER_RUN";
const RUN_ID = /^run-[A-Za-z0-9-]+$/;
const TERMINAL: readonly string[] = TERMINAL_RUN_STATES;

interface GuardInput { tool_name: string; session_id?: string; tool_input: { command?: string; [key: string]: unknown } }
interface RunView { runId: string; state: string; sessionId?: string; hostProfile?: { kind: string }; sessionConfirmed?: boolean; stop?: { mode: "pause" | "cancel"; reason?: string } }

/** 이 세션이 master 실행이면 그 기록 — 아니면 undefined */
export function masterRun(root: string, env: Readonly<Record<string, string | undefined>> = process.env): RunView | undefined {
  const runId = env[MASTER_RUN_ENV];
  if (!runId || !RUN_ID.test(runId)) return undefined;
  const file = join(root, STATE_DIR, "master", "runs", `${runId}.json`);
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, "utf8")) as RunView; } catch { return undefined; }
}

const MASTER_COMMAND = /(?:^|[\s&;|("'\\/])(?:code-agent(?:\.cmd|\.ps1)?|cli\.js)["']?\s+(?:master|takeover)(?=\s|$)/i;
/** master 제어 명령 — 어느 호스트 세션의 셸에서도 부르지 않는다(러너와 사람의 터미널이 부른다). hook.decideOutside 가 쓴다 */
export const MASTER_CONTROL_COMMAND = /(?:^|[\s&;|("'\\/])(?:code-agent(?:\.cmd|\.ps1)?|cli\.js)["']?\s+master(?=\s|$)/i;
export const MASTER_CONTROL_DENIED = "master 제어 명령(code-agent master …)은 master 러너와 사람의 터미널이 부릅니다 — 호스트 세션의 셸에서 부르지 않습니다. 연동 상태는 code-agent status 로 봅니다.";

export function masterRunGuard(input: GuardInput, root: string, env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const run = masterRun(root, env);
  if (!run) return undefined;
  // 세션이 기록과 다르면(감독이 세션 ID 를 정해 넘긴다) 이 실행의 도구 호출이 아니다 — 판단하지 않는다
  if (run.sessionId && input.session_id && run.sessionId !== input.session_id) {
    if (run.hostProfile?.kind === "codex") return "관리 실행의 Codex thread ID를 아직 확인하지 못했거나 다른 세션입니다. 도구 실행을 멈추고 감독 상태를 확인하세요.";
    return undefined;
  }
  if (run.stop || TERMINAL.includes(run.state)) {
    const why = run.stop ? `master 가 이 실행(${run.runId})의 ${run.stop.mode === "cancel" ? "취소" : "일시 정지"}를 요청했습니다${run.stop.reason ? ` — ${run.stop.reason}` : ""}`
      : `이 실행(${run.runId})은 ${run.state} 로 끝난 것으로 기록됐습니다`;
    return `${why}. 도구를 더 쓰지 말고, 지금까지 한 일과 멈춘 자리를 짧게 보고한 뒤 턴을 끝내세요. 파일을 되돌리지 않습니다.`;
  }
  if (["AskUserQuestion", "request_user_input", "mcp__code_agent__ask", "mcp__code_agent__confirm"].includes(input.tool_name)) {
    return `이 세션은 master 실행이라 ${askVia()} 사람에게 묻지 않습니다 — 동의는 code-agent consent prepare 까지만 하고 동의 ID·요약을 보고한 뒤 턴을 끝냅니다. ` +
      "업무 질문은 code-agent interaction publish <질문.json>으로 영속화하고 human-input 대기를 보고한 뒤 턴을 끝냅니다. 작업 ID가 없는 설정·운영 질문도 같은 경로입니다. 추천으로 대신 답하지 않습니다.";
  }
  if (["Bash", "PowerShell"].includes(input.tool_name) && MASTER_COMMAND.test(String(input.tool_input.command ?? ""))) {
    return "master 실행 세션은 작업 임대(takeover)·master 제어 명령을 부르지 않습니다 — 제어는 master 와 사람이 합니다.";
  }
  return undefined;
}

/** SessionStart 에 붙는 줄 — master 실행 세션의 규칙(실행 프롬프트 머리에도 같은 규칙이 있다) */
export function masterRunNote(root: string, env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const run = masterRun(root, env);
  if (!run) return undefined;
  return [
    `- 이 세션은 master 실행(${run.runId})이다. 사람이 이 대화를 보지 않는다.`,
    `- 질문·동의를 ${askVia()} 묻지 않는다: 동의는 ${skill("ca-answer")} 의 consent prepare 까지만 하고 동의 ID·요약을 보고한 뒤 턴을 끝낸다. 일반 질문은 interaction publish로 저장하고 human-input 대기한다.`,
    "- 승인·확정 기록을 만들거나 고치지 않는다. 판단은 master 가 사람이 준 위임 범위에서 하거나 사람에게 넘긴다.",
    "- code-agent 명령은 code-agent 로 부른다(node 경로로 부르지 않는다). 정지 요청을 받으면 도구를 더 쓰지 않고 보고 뒤 끝낸다.",
    ...(run.hostProfile?.kind === "codex" ? ["- Git 쓰기가 필요한 start·verify·repro의 샌드박스 실패는 같은 명령의 단건 실행 권한을 호스트 셸 도구로 요청한다. 감독이 사람 응답을 전달하며 업무 동의와 구분한다."] : []),
  ].join("\n");
}
