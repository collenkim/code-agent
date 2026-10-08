/**
 * 교차 실행과 실행 환경의 표지 — 지금 셸이 어느 호스트 안인가, 교차 실행이 띄운 자식인가.
 *
 * hook 이 매번 읽으므로 어떤 모듈도 import 하지 않는다(fs·zod·child_process 없음 — 순수성 테스트가 지킨다).
 * **지금 호스트 판별은 runtimeHost 하나다.** 표기 선택(hostText.notationFor)은 CODE_AGENT_HOST 를 먼저 보지만,
 * 게이트(같은 호스트 `--by` 거부·임대)는 이 함수의 환경 표지로만 판단한다.
 */

export type HostName = "claude" | "codex";
type Env = Readonly<Record<string, string | undefined>>;

/** 교차 자식 환경에서 지우는 부른 Claude 세션의 값 — 메시지 통로·세션 id·자식 세션 표지·pid·추론 강도·사람 응대 표지 */
export const CLAUDE_SESSION_ENV = ["CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_CODE_SESSION_ATTENDED"] as const;
/** 교차 실행이 자식 환경에 넣는 표지 — 값은 실행한 호스트 이름이다 */
export const CROSS_CHILD_ENV = "CODE_AGENT_CROSS";
/**
 * Codex 셸의 환경 표지. Windows Codex 0.161.0 실측(2026-10-08): 모든 모드에 CODEX_CI=1·CODEX_THREAD_ID 가 있고, workspace-write·read-only·
 * 실제 권한 상승 셸에 CODEX_SANDBOX_NETWORK_DISABLED=1 이 있으며 CODEX_SANDBOX 는 어느 모드에도 없다(macOS·Linux 용 표지로 남긴다)
 */
export const CODEX_MARKERS = ["CODEX_CI", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_THREAD_ID"] as const;
/** 교차 실행 자식 안에서는 아무것도 하지 않고 통과하는 Codex hook 이벤트(PreToolUse 판정은 그대로 한다) */
export const CROSS_CHILD_PASS_EVENTS = ["Stop", "SubagentStart", "SubagentStop", "UserPromptSubmit", "SessionStart"] as const;
/** 교차 실행 자식이 진행 명령·쓰기를 시도했을 때의 거부 문구 — 작업 임대를 읽지도 쓰지도 않는다 */
export const CROSS_CHILD_DENY = "교차 실행(CODE_AGENT_CROSS) 안에서는 작업을 진행하거나 파일을 고치지 않습니다 — 읽기 전용 검토만 합니다.";

/** 교차 실행이 띄운 다른 호스트 안인가 */
export function crossChild(env: Env = process.env): boolean { return !!env[CROSS_CHILD_ENV]; }

/**
 * Codex 샌드박스 표지가 있는가 — 다른 호스트를 띄우거나 네트워크를 쓰면 막힐 수 있다. Windows 의 권한 상승 셸에도 남으므로 이것만으로
 * 샌드박스 안이라고 단정하지 않는다(사전 판정은 연결 확인 결과로 가른다 — crossCheck.crossNetProbe·retryPolicy.crossPreflight)
 */
export function sandboxMarkers(env: Env = process.env): boolean {
  return !!env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED === "1";
}

/** 셸 환경에 호스트 표지가 하나라도 있는가 — 사람의 터미널(표지 없음)과 호스트 셸을 가른다 */
export function hostMarked(env: Env = process.env): boolean {
  return env.CLAUDECODE === "1" || CODEX_MARKERS.some((key) => env[key] !== undefined);
}

/**
 * 셸 환경으로 본 지금 호스트. 두 호스트 표지가 함께 보이거나(예: Claude Code 터미널에서 띄운 Codex) 아무것도 없으면
 * undefined(판별 불가)다. CODE_AGENT_HOST 는 보지 않는다 — 표기 전용 값이 교차 거부·임대 판정에 새지 않게 한다.
 */
export function runtimeHost(env: Env = process.env): HostName | undefined {
  const claude = env.CLAUDECODE === "1";
  const codex = CODEX_MARKERS.some((key) => env[key] !== undefined);
  return claude && !codex ? "claude" : codex && !claude ? "codex" : undefined;
}

export function otherHost(host: HostName): HostName { return host === "claude" ? "codex" : "claude"; }

/**
 * 교차 실행 자식에게 넘길 환경 — 부른 쪽 호스트의 표지(CLAUDECODE 등)와 테스트 문맥을 지우고 교차 자식 표지를 넣는다.
 * 원본은 바꾸지 않는다.
 */
export function crossChildEnv(base: Env, host: HostName): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; delete env.NODE_TEST_CONTEXT;
  // 부른 Claude 세션에 묶인 값(claude 2.1.293 의 Bash 셸·hook 환경에 있다) — 교차 자식이 부모 세션에 붙거나 그 세션의 추론 강도를 물려받지 않게
  // 한다(강도는 역할 모델 설정이 주는 --effort 를 따른다). 세션에 묶이지 않은 CLAUDE_CODE_EXECPATH(실행 파일 경로)·AI_AGENT(일반 표지)는 남긴다
  for (const key of CLAUDE_SESSION_ENV) delete env[key];
  env[CROSS_CHILD_ENV] = host;
  return env;
}
