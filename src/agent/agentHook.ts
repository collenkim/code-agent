/**
 * 구현·테스트 담당(`ca-implementer`·`ca-tester`)의 시작·완료 관찰 — Claude `agent-event`(SubagentStart·Stop), Codex `codex-event` 의 Subagent 분기.
 *
 * 판정하지 않는다: 담당이 쓴 결과는 다음 명령(`next`·`verify`·`test`·`repro`)의 게이트가 본다. 여기서는 담당 실행 장부(agentRuns)와
 * 실행 타임라인에 실행 구간만 남긴다 — Stop hook 이 "담당은 끝났는데 메인이 다음 명령 없이 턴을 끝내는" 자리를 가르는 근거다.
 * 진행 중인 작업이 없으면(문서 준비·도입 중의 호출) 아무것도 하지 않는다. 실패는 삼키고 막지 않는다(언제나 exit 0).
 */
import { findRepoRoot } from "./layout";
import { crossChild } from "./crossEnv";
import { noteAgentFinished, noteAgentStarted } from "./agentRuns";
import { recordEvent } from "./timeline";
import { loadWork } from "./work";

export const IMPLEMENT_AGENTS = ["ca-implementer", "ca-tester"] as const;

export interface AgentHookInput { cwd?: string; hook_event_name?: string; session_id?: string; agent_id?: string; agent_type?: string }

export function observeAgent(input: AgentHookInput, projectDir?: string, host: "claude" | "codex" = "claude"): void {
  if (!(IMPLEMENT_AGENTS as readonly string[]).includes(input.agent_type ?? "") || !input.agent_id) return;
  if (input.hook_event_name !== "SubagentStart" && input.hook_event_name !== "SubagentStop") return;
  const root = findRepoRoot(projectDir ?? input.cwd ?? process.cwd()), work = loadWork(root);
  if (!work) return;
  const { id, phase } = work.active, step = work.active.task ?? work.active.stage;
  // 작업 자리(작업·단계·개정·회차)는 타임라인이 커서에서 채운다
  const place = { ...(step ? { taskId: step } : {}), host, ...(input.session_id ? { session: input.session_id } : {}), agent: input.agent_id };
  const type = input.agent_type!;
  if (input.hook_event_name === "SubagentStart") {
    noteAgentStarted(root, id, input.agent_id, { source: "implement", type, phase, host, ...(input.session_id ? { session: input.session_id } : {}) });
    recordEvent(root, { type: "agent.started", ...place, detail: { agentType: type } });
    return;
  }
  noteAgentFinished(root, id, input.agent_id, { source: "implement", type, status: "completed", phase, host, ...(input.session_id ? { session: input.session_id } : {}), advance: true });
  recordEvent(root, { type: "agent.finished", ...place, detail: { agentType: type, status: "completed" } });
}

export function runAgentHook(stdin: string): number {
  // 교차 실행이 띄운 다른 호스트 안에서는 담당을 관찰하지 않는다
  if (crossChild()) return 0;
  try {
    observeAgent(JSON.parse(stdin) as AgentHookInput, process.env.CLAUDE_PROJECT_DIR, "claude");
  } catch (error) {
    process.stderr.write(`code-agent agent-event: ${error instanceof Error ? error.message : error} (담당은 막지 않았습니다)\n`);
  }
  return 0;
}
