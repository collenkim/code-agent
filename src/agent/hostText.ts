/**
 * 호스트별 표기 — CLI·hook 이 사용자·모델에게 보이는 문구에서 스킬 이름·서브에이전트 이름·질문 도구·셸 이름을
 * Claude·Codex·중립 중 하나로 쓴다.
 *
 * 판정 순서(notationFor): ① CODE_AGENT_HOST(표기 전용 — 사람이 셸 설정으로 고정) ② .code-agent/hosts.json 의 설치 호스트가
 * 하나면 그것 ③ 실행 환경(crossEnv.runtimeHost) ④ 중립. 지금 호스트 판별은 여기서 정의하지 않는다(crossEnv.runtimeHost 하나).
 * hook 이 매번 읽으므로 crossEnv 말고는 import 하지 않는다 — hosts.json 은 notationFor 가 부를 때만 fs 를 지연 로드해 읽는다.
 * 파일·확인 화면에 기록되는 문자열(⑧·⑨·⑩, 원장, 동의 confirmations)에는 쓰지 않는다 — 호스트를 바꿔도 바이트 대조가 깨지지 않게.
 */
import { runtimeHost, type HostName } from "./crossEnv";

export type { HostName } from "./crossEnv";
export type Notation = HostName | "neutral";
type Env = Readonly<Record<string, string | undefined>>;

/** template/claude/skills 의 디렉터리 이름과 같아야 한다 — hostText 테스트가 대조한다 */
export const SKILL_NAMES = ["ca-adopt", "ca-analyze", "ca-answer", "ca-check", "ca-design", "ca-docs", "ca-feature", "ca-fix",
  "ca-impact", "ca-implement", "ca-integrate", "ca-next", "ca-plan", "ca-refactor", "ca-request", "ca-review", "ca-status", "ca-test"] as const;
export type SkillName = (typeof SKILL_NAMES)[number];
/**
 * 서브에이전트 역할 — template/claude/agents 와 같아야 한다(테스트가 대조한다). 정본은 이 목록 하나다 — hosts.ts 는 이것을
 * 다시 내보내고 codexText 의 역할 정규식도 여기서 만든다.
 */
export const ROLE_NAMES = ["ca-analyst", "ca-explorer", "ca-writer", "ca-critic", "ca-reviewer", "ca-implementer", "ca-surveyor", "ca-tester"] as const;
const roles: readonly string[] = ROLE_NAMES;
export function codexAgentName(name: string): string { return roles.includes(name) ? name.replace(/-/g, "_") : name; }
export function commonAgentName(name?: string): string | undefined { return roles.find((role) => codexAgentName(role) === name) ?? name; }

function readIfPresent(file: string): string | undefined {
  const { readFileSync } = require("fs") as typeof import("fs");
  try { return readFileSync(file, "utf8"); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : ""; }   // 읽지 못하면 깨진 기록으로 본다
}
/** 설치 호스트(.code-agent/hosts.json) — 없으면 ["claude"], 깨졌거나 읽지 못하면 [] */
export function installedHosts(root: string, read: (file: string) => string | undefined = readIfPresent): HostName[] {
  const text = read(`${root.replace(/[\\/]+$/, "")}/.code-agent/hosts.json`);
  if (text === undefined) return ["claude"];
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || !value.length || value.some((host) => host !== "claude" && host !== "codex")) return [];
    return [...new Set(value as HostName[])];
  } catch { return []; }
}
/** 이 저장소·환경의 표기. installed 를 주면 hosts.json 을 읽지 않는다 */
export function notationFor(root: string, env: Env = process.env, installed?: readonly HostName[]): Notation {
  const forced = env.CODE_AGENT_HOST;
  if (forced === "claude" || forced === "codex") return forced;
  const hosts = installed ?? installedHosts(root);
  if (hosts.length === 1) return hosts[0];
  return runtimeHost(env) ?? "neutral";
}

/** 테스트는 함수를 프로세스 안에서 바로 부르므로 환경에 따라 바뀌지 않게 기본값은 claude 다. 프로세스 전체 설정은 CLI 진입만 한다 */
let current: Notation = "claude";
export function notation(): Notation { return current; }
/** CLI 프로세스 전체의 표기 */
export function useNotation(value: Notation): void { current = value; }
/** hook 진입 함수 — 끝나면(예외가 나도) 이전 값으로 되돌린다 */
export function withNotation<T>(value: Notation, run: () => T): T {
  const previous = current;
  current = value;
  try { return run(); } finally { current = previous; }
}

export function skill(name: SkillName, n: Notation = current): string {
  return n === "claude" ? `/${name}` : n === "codex" ? `$${name}` : `/${name}($${name})`;
}
/** 서브에이전트 이름. 역할 이름이 아니면 그대로 */
export function agentName(name: string, n: Notation = current): string {
  if (n === "claude" || !roles.includes(name)) return name;
  return n === "codex" ? codexAgentName(name) : `${name}(${codexAgentName(name)})`;
}
/** 질문 도구 — 조사까지 돌려주는 문장 조각(`…절차의 ${askVia()} 답을 받아`) */
export function askVia(n: Notation = current): string {
  return n === "claude" ? "AskUserQuestion으로" : n === "codex" ? "Codex MCP 선택 UI로"
    : "질문 도구(Claude Code: AskUserQuestion · Codex: MCP 선택 UI)로";
}
/** 셸 실행 — 조사까지 돌려주는 문장 조각 */
export function viaShell(n: Notation = current): string { return n === "claude" ? "Bash 로" : "셸로"; }
/** 목록 머리의 셸 표기(템플릿의 `Bash:` 와 같은 꼴) */
export function shellLabel(n: Notation = current): string { return n === "claude" ? "Bash:" : "셸:"; }
/** 파일 읽기 — 조사까지 돌려주는 문장 조각(`${readVia()} 원인을 확인하고`). Codex 에는 전용 읽기 도구가 없다 */
export function readVia(n: Notation = current): string {
  return n === "claude" ? "Read 로" : n === "codex" ? "code-agent read 로" : "Read(Codex: code-agent read)로";
}
/** 파일 읽기 — 도구라고 밝히는 꼴(`읽기는 ${readToolVia()} 하고`) */
export function readToolVia(n: Notation = current): string {
  return n === "claude" ? "Read 도구로" : n === "codex" ? "code-agent read 로" : "Read 도구(Codex: code-agent read)로";
}
/** 파일 고치기 — 조사까지 돌려주는 문장 조각 */
export function editVia(n: Notation = current): string {
  return n === "claude" ? "Write/Edit 로" : n === "codex" ? "apply_patch 로" : "Write/Edit(Codex: apply_patch)로";
}
const CLAUDE_FILE_TOOLS = "파일은 Write/Edit 로 고치고, 읽기는 Read/Grep/Glob 을 쓰세요.";
/** 실행 정책을 바꾸지 않고 npm의 PowerShell 스크립트 대신 명령 파일을 호출한다. 대화 응답은 셸 명령이 아니다. */
export const POWERSHELL_COMMAND_GUIDE = "Windows PowerShell에서는 본문·CLI 출력의 code-agent 셸 호출을 code-agent.cmd로 실행한다(.ps1 실행 정책 오류 방지). 그 밖의 셸은 code-agent를 쓴다. 사용자 대화 메시지인 code-agent consent respond는 바꾸지 않는다.";
export function fileToolsHint(n: Notation = current): string {
  return n === "claude" ? CLAUDE_FILE_TOOLS
    : n === "codex" ? `파일은 apply_patch로 고치고, 읽기는 code-agent read <파일> [시작 줄] [줄 수]를 쓰세요. ${POWERSHELL_COMMAND_GUIDE}`
      : `${CLAUDE_FILE_TOOLS} (Codex: apply_patch · code-agent read)`;
}
/** 호스트 이름(임대·안내 문구용) */
export function hostLabel(host: HostName): string { return host === "claude" ? "Claude Code" : "Codex"; }
