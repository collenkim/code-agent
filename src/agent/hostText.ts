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
 * 서브에이전트 역할 — template/claude/agents 와 같아야 한다(테스트가 대조한다). hosts.ts 의 ROLE_NAMES 와 같은 목록이고,
 * hosts.ts 가 이 목록을 다시 내보내도록 바뀌기 전까지는 둘 다 고친다.
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
  return n === "claude" ? "AskUserQuestion으로" : n === "codex" ? "Codex 질문 도구(없으면 대화)로"
    : "질문 도구(Claude Code: AskUserQuestion · Codex: 질문 도구 또는 대화)로";
}
/** 셸 실행 — 조사까지 돌려주는 문장 조각 */
export function viaShell(n: Notation = current): string { return n === "claude" ? "Bash 로" : "셸로"; }
/** 목록 머리의 셸 표기(템플릿의 `Bash:` 와 같은 꼴) */
export function shellLabel(n: Notation = current): string { return n === "claude" ? "Bash:" : "셸:"; }
const CLAUDE_FILE_TOOLS = "파일은 Write/Edit 로 고치고, 읽기는 Read/Grep/Glob 을 쓰세요.";
export function fileToolsHint(n: Notation = current): string {
  return n === "claude" ? CLAUDE_FILE_TOOLS
    : n === "codex" ? "파일은 apply_patch로 고치고, 읽기는 code-agent read <파일> [시작 줄] [줄 수]를 쓰세요."
      : `${CLAUDE_FILE_TOOLS} (Codex: apply_patch · code-agent read)`;
}
/** 호스트 이름(임대·안내 문구용) */
export function hostLabel(host: HostName): string { return host === "claude" ? "Claude Code" : "Codex"; }
