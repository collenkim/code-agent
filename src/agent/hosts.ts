import { existsSync } from "fs";
import { delimiter, join } from "path";
import { assetKeys, assetText, CLAUDE_ASSETS, isPackaged } from "./assets";
import { isBatchScript, resolveExecutable } from "../core/build";
import { Stop } from "./stop";
import { codexModelOf, codexModelText, type AgentName } from "./modelPolicy";
import { codexAgentName, commonAgentName, POWERSHELL_COMMAND_GUIDE, ROLE_NAMES } from "./hostText";
import { guidance, POLICIES } from "./retryPolicy";
import { executionMode } from "./executionMode";
import { managedExecution } from "./master/workExecution";
import { readJson } from "./stateJson";

export type Host = "claude" | "codex";
export type HostSelection = Host | "both";
// 서브에이전트 역할과 이름 변환의 정본은 hostText.ts 다 — 기존 import(planning.ts 등)가 그대로 동작하게 다시 내보낸다
export { codexAgentName, commonAgentName, ROLE_NAMES };
/** codexText 의 역할 정규식 — ROLE_NAMES 로 같은 대안식을 만든다(`ca-x.md` 파일 이름은 바꾸지 않는다) */
const ROLE_PATTERN = new RegExp(String.raw`\bca-(?:${ROLE_NAMES.map((name) => name.slice(3)).join("|")})\b(?!\.md)`, "g");
export function parseHost(value?: string): HostSelection | undefined {
  if (value === undefined || value === "claude" || value === "codex" || value === "both") return value;
  throw new Stop("--host 값은 claude, codex, both 중 하나여야 합니다.");
}
export function selectedHosts(root: string, selected?: HostSelection): Host[] {
  if (selected) return selected === "both" ? ["claude", "codex"] : [selected];
  const file = join(root, ".code-agent", "hosts.json");
  if (!existsSync(file)) return ["claude"];
  return readJson(file, { parse(value) {
    if (!Array.isArray(value) || !value.length || value.some(host => host !== "claude" && host !== "codex")) throw new Stop("설치 호스트 기록이 잘못되었습니다");
    return [...new Set(value)] as Host[];
  } }, ".code-agent/hosts.json");
}
/**
 * 교차 검증이 다른 호스트를 실행할 명령. 테스트·사내 배포는 `CODE_AGENT_CLAUDE_BIN` · `CODE_AGENT_CODEX_BIN` 으로 바꾼다
 * (.js 면 node 로 — scriptRunner). 못 쓰면 그 이유(문자열)를 돌려준다 — 교차 검증은 두 호스트를 모두 실행할 수 있을 때만 돈다.
 */
const CONFIG_MISSING = "가 가리키는 파일이 없습니다";
const CONFIG_SCRIPT = "는 셸 스크립트라 직접 실행할 수 없습니다";
const CONFIG_NODE = "는 .js 라 node 가 필요한데 PATH 에서 node 실행 파일을 찾지 못했습니다(단일 실행 파일)";
/**
 * .js 진입점을 돌릴 node — npm 설치면 지금 node(process.execPath). 단일 실행 파일이면 process.execPath 가 code-agent 자신이라 다른 스크립트를
 * 돌리지 못하므로 PATH 의 node 실행 파일을 쓴다. PATH 디렉터리마다 보고 셸 스크립트 node(mise·nodist 류의 node.cmd 셰임)는 건너뛰어 뒤
 * 디렉터리의 실행 파일을 고른다(실행 파일이 하나도 없으면 undefined)
 */
export function scriptRunner(packaged: boolean = isPackaged(), env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!packaged) return process.execPath;
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    const found = resolveExecutable(process.cwd(), join(dir, "node"), env);
    if (found && !isBatchScript(found)) return found;
  }
  return undefined;
}
/** 실행 파일 변수(CODE_AGENT_*_BIN)에 지정할 것 — 단일 실행 파일은 .js 를 PATH 의 node 실행 파일로만 돌린다(scriptRunner) */
export function binHint(packaged: boolean = isPackaged()): string {
  return packaged ? "실행 파일(.exe — .js 는 PATH 에 node 실행 파일이 있을 때만)" : "실행 파일(.exe·.js)";
}
/**
 * hostCommand 의 실패 이유가 사람이 설정으로 고치는 것인가 — 실행 파일 변수(CODE_AGENT_*_BIN)가 없는 파일을 가리키거나 PATH 에
 * 셸 스크립트(.cmd·.bat)만 있거나, 단일 실행 파일에서 변수가 가리킨 .js 를 돌릴 node 가 PATH 에 없다. 교차 실패 분류에서 실행 불가(중지
 * 기록 후 진행)가 아니라 설정 오류(게이트 막힘)다 — 경로 오타 하나로 필수 교차 검증이 조용히 빠지지 않게. PATH·npm 어디에도 없는 미설치만
 * 실행 불가다.
 */
export function hostCommandConfigError(reason: string): boolean {
  return reason.includes(CONFIG_MISSING) || reason.includes(CONFIG_SCRIPT) || reason.includes(CONFIG_NODE);
}
export function hostCommand(host: Host): { file: string; prefix: string[] } | string {
  const key = host === "claude" ? "CODE_AGENT_CLAUDE_BIN" : "CODE_AGENT_CODEX_BIN";
  const configured = process.env[key];
  if (configured) {
    if (!existsSync(configured)) return `${key} ${CONFIG_MISSING}: ${configured}`;
    if (!/\.c?js$/i.test(configured)) return { file: configured, prefix: [] };
    const node = scriptRunner();
    return node ? { file: node, prefix: [configured] } : `${key} ${CONFIG_NODE}: ${configured}`;
  }
  // npm 의 .cmd 는 셸 없이 실행되지 않고 여러 줄 프롬프트를 cmd.exe 로 넘길 수 없다 — 설치된 Node 진입점을 직접 부른다
  if (process.platform === "win32" && process.env.APPDATA) {
    const script = host === "codex"
      ? join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
      : join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    // 단일 실행 파일에서 PATH 에 node 가 없으면 이 진입점을 돌리지 못한다 — 아래 PATH 해석으로 넘어간다
    const node = scriptRunner();
    if (node && existsSync(script)) return { file: node, prefix: [script] };
  }
  const found = resolveExecutable(process.cwd(), host, process.env, { skipLocal: true });
  if (!found) return `${host} 실행 파일을 PATH 에서 찾지 못했습니다`;
  if (isBatchScript(found)) return `${found} ${CONFIG_SCRIPT} — ${key} 에 ${binHint()}을 지정하세요`;
  return { file: found, prefix: [] };
}
/**
 * master 호스트 설정의 command 를 실행 파일·앞 인자로 — 호스트 이름 하나(기본값)면 hostCommand 로 찾고 아니면 그대로 쓴다.
 * 관리 실행 감독(hostArgs)과 Codex 준비 조회(codexReadiness)가 같은 해석을 써서 같은 실행 파일을 띄운다.
 */
export function hostLaunch(host: Host, command: readonly string[]): { file: string; prefix: string[] } | string {
  const [file, ...prefix] = command;
  return command.length === 1 && file === host ? hostCommand(host) : { file, prefix };
}

/**
 * 교차 검증을 선택한 프로젝트에서 교차 실행 명령을 못 쓰는 이유 — 설정 오류(hostCommandConfigError)와 실행 불가(미설치)로 나눈다.
 * 한 호스트 설치면 undefined. 교차 안내(crossNotice — init·status·doctor)와 doctor 의 표시(설정 오류는 ✗)가 같은 판정을 쓴다.
 */
export function crossHostProblems(root: string): { config: string[]; missing: string[] } | undefined {
  if (!crossEnabled(root)) return undefined;
  const reasons = (["claude", "codex"] as Host[]).map((host) => hostCommand(host)).filter((value): value is string => typeof value === "string");
  return { config: reasons.filter(hostCommandConfigError), missing: reasons.filter((reason) => !hostCommandConfigError(reason)) };
}

/**
 * 교차 게이트 줄(review.ts reviewProblems·planningState.ts crossCriticProblems)의 실행 명령 뒤 괄호 — 그 명령을 실행하면 어떻게 되는지.
 * 직전 실행의 실패가 있으면(지점 안내 hint) 그 원인별 안내(crossHintText)가 다음 일을 싣는다 — 설정 오류·샌드박스 거부는 '게이트가 막혀
 * 있다' 이므로 '실행할 수 없으면 중지' 괄호를 달지 않는다. 아직 실행 전이어도 그 호스트의 실행 파일이 설정 오류면 설정 오류 갈래 문장이고,
 * 그 밖(실행할 수 있거나 미설치)은 실행 불가 갈래다. 갈래와 문장은 crossNotice 와 같다(재시도 규약의 GUIDE_VARIANTS — notice·gate).
 */
export function crossEnabled(root: string): boolean {
  // master 가 지금 작업(또는 이 실행)에 고른 실행 방식이 있으면 그 선택이 정한다 — both 만 교차 검증
  const managed = managedExecution(root);
  if (managed) return managed.mode === "both";
  const mode = executionMode(root);
  return mode === "both" || (mode === undefined && selectedHosts(root).length > 1);
}

export function crossRunNote(host: Host | undefined, hint?: { class: string }): string {
  if (hint) return "";
  const resolved = host ? hostCommand(host) : undefined;
  if (typeof resolved === "string" && hostCommandConfigError(resolved)) {
    return ` (${POLICIES["cross-config-error"].label} — ${guidance("cross-config-error", { detail: resolved }, "notice")})`;
  }
  return ` (${guidance("cross-unavailable", {}, "gate")})`;
}

/**
 * 교차 검증 안내 한 줄 — 교차 검증을 선택한 프로젝트에서만. 둘 다 실행할 수 있을 때만 교차 검증이 실제로 돈다.
 * 못 쓰는 이유를 교차 실패 분류(crossCheck — hostCommandConfigError)와 같이 가른다: 미설치(PATH·npm 어디에도 없음)는 실행 불가라
 * 그 지점을 중지로 기록하고 진행하고, 실행 파일 변수가 없는 파일을 가리키거나 PATH 에 셸 스크립트만 있으면 설정 오류라 게이트가 막힌다.
 * 원인 이름(POLICIES label)과 갈래 문장(guidance 의 notice 변형)은 재시도 규약이 원천이다.
 */
export function crossNotice(root: string): string | undefined {
  const problems = crossHostProblems(root);
  if (!problems) return undefined;
  const { config, missing } = problems;
  if (config.length + missing.length === 0) return "교차 검증: 켜짐 — 계획 검토·코드 리뷰를 다른 호스트가 한 번 더 본다";
  const part = (cls: "cross-config-error" | "cross-unavailable", details: string[]) =>
    details.length ? [`${POLICIES[cls].label} — ${guidance(cls, { detail: details.join(" · ") }, "notice")}`] : [];
  const parts = [...part("cross-config-error", config), ...part("cross-unavailable", missing)];
  return `교차 검증: ${parts.join(" / ")}. ` +
    "두 호스트를 모두 실행할 수 있는지 확인하세요. 단독 실행은 호스트 밖 터미널에서 code-agent execution claude 또는 code-agent execution codex로 선택합니다.";
}

export function hookFile(root: string, host: Host): string {
  return join(root, host === "claude" ? ".claude/settings.json" : ".codex/hooks.json");
}

/** 업무 지침은 공유하고 호스트 도구·설치 경로만 변환한다. 승인 절차는 별도 계약이다. */
/**
 * Codex 사본의 문장째 치환 — 원문이 Claude 템플릿에 글자 그대로 있어야 걸린다(어긋나면 오류 없이 치환되지 않는다).
 * `templateText.test.ts` 가 원문마다 Claude 템플릿 하나 이상에 있고 Codex 사본 어디에도 남지 않는지 대조한다. 모든 등장을 바꾼다($ 패턴 해석 없음).
 */
export const CODEX_SENTENCES: readonly (readonly [string, string])[] = [
  ["도구가 없거나 표시가 실패하면 설치·hook·호스트 지원을 확인하고 복구 후 같은 질문을 UI로 표시한다.",
    "MCP 선택 UI가 없거나 표시가 실패하면 doctor로 설치·호스트 지원을 확인하고 복구 후 같은 질문을 UI로 표시한다."],
  // 장시간 실행 정본 문장(ca-check·ca-test·ca-integrate·ca-implement 에 글자 그대로). Codex 셸 도구의 제한 시간
  // 인자 이름·상한은 미확인이라 숫자를 옮기지 않는다. 정본이 바뀌면 이 치환이 걸리지 않고 Codex 사본 점검(Bash·600000ms 0건)이 잡는다
  ["Bash 도구의 timeout 을 최대(600000ms)로 주고, 그보다 긴 저장소는 백그라운드 실행(`run_in_background`) 뒤 완료 알림을 기다린다.",
    "셸 명령의 제한 시간을 가장 길게 주고, 그보다 긴 저장소는 백그라운드로 실행한 뒤 끝날 때까지 기다린다."],
  // 교차 실행(ca-review·ca-plan 4-1) — CLI 가 9분에 끊으므로 셸 쪽 제한은 그보다 길어야 한다는 뜻만 남긴다
  ["CLI 가 9분에 끊고 기록하므로 timeout 을 600000ms 로 주거나 백그라운드로 실행한다.",
    "CLI 가 9분에 끊고 기록하므로 셸 명령의 제한 시간을 10분 넘게 주거나 백그라운드로 실행한다."],
  ["(CLI 가 9분에 끊으므로 timeout 600000ms 또는 백그라운드)", "(CLI 가 9분에 끊으므로 셸 명령의 제한 시간을 10분 넘게 주거나 백그라운드)"],
  // 담당 호출(계획 스킬 4개 2항·ca-review·ca-implement·ca-test·ca-check·ca-docs·ca-adopt) — Claude 의 Agent 도구는 인자 없이 백그라운드로 뜰 수 있어
  // 결과를 기다리게 한다(claude 2.1.293 실측). Codex 에는 그 인자가 없다 — 결과를 기다린다는 뜻만 남긴다
  ["Agent 도구는 `run_in_background: false` 로 부른다(결과를 받아야 다음 단계로 간다).", "담당의 결과를 받을 때까지 기다린 뒤 다음 단계로 간다."],
];

/**
 * Codex 사본. footer 는 PowerShell `.cmd` 호출·`code-agent read` 안내 꼬리말이다 — 하위 에이전트 지침(TOML)에만 붙인다. 스킬은 메인이 읽고,
 * 메인에는 같은 두 문장이 든 AGENTS.md 블록(CODEX.block.md)이 늘 실려 있다(스킬마다 붙이면 한 흐름에 같은 문장이 열 번 넘게 쌓인다).
 */
function codexText(text: string, footer: boolean): string {
  const body = CODEX_SENTENCES.reduce((out, [from, to]) => out.split(from).join(to), text).replace(ROLE_PATTERN, codexAgentName)
    .replace(/`agent`/g, "`hostAgents.codex`")
    .replace(/\.claude\/skills\//g, ".agents/skills/")
    .replace(/\.claude\/agents\/([\w-]+)\.md/g, ".codex/agents/$1.toml")
    .replace(/Claude Code/g, "Codex").replace(/CLAUDE\.md/g, "AGENTS.md")
    .replace(/(?<![\w/])\/ca-/g, "$ca-")
    .replace(/AskUserQuestion/g, "code_agent.ask MCP 선택 UI")
    .replace(/\$ARGUMENTS/g, "<사용자가 전달한 인자>")
    .replace(/\bBash:/g, "셸:")
    .replace(/\bBash 로 /g, "셸로 ")
    .replace(/\bBash 등으로/g, "셸 등으로")
    .replace(/subagent_type/g, "agent_type")
    .replace(/--for claude/g, "--for codex")
    // 교차 검증은 지금 호스트가 아닌 쪽이 맡는다
    .replace(/--by codex/g, "--by claude")
    // Codex 메인의 교차 명령은 다른 호스트를 띄우고 네트워크를 쓴다 — 샌드박스 밖(권한 상승)으로 실행하게 한다(`Bash:`·`--by` 치환 뒤의 글자)
    .replace(/셸: `code-agent (review|planning) cross --by claude`/g,
      "셸(Codex 샌드박스 밖 — 다른 호스트를 띄우고 네트워크를 쓰므로 권한 상승을 요청해 실행한다): `code-agent $1 cross --by claude`");
  return footer ? `${body}\n\n${CODEX_AGENT_FOOTER}\n` : body;
}
/** 하위 에이전트 지침의 꼬리말 — 메인의 AGENTS.md 블록(CODEX.block.md 3·8행)과 같은 뜻이다 */
const CODEX_AGENT_FOOTER = `${POWERSHELL_COMMAND_GUIDE}\n파일 읽기는 code-agent read <파일> [시작 줄] [줄 수](최대 400)로 한다. Windows PowerShell 예: code-agent.cmd read .agents/skills/ca-adopt/SKILL.md 1 300. 전용 읽기 도구가 없으면 배정 inputs·survey의 경로를 읽는다. 일반 셸 읽기·연결 명령은 게이트가 거부한다.`;
export function hostAssets(host: Host, root?: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const key of assetKeys(CLAUDE_ASSETS)) {
    const tail = key.slice(CLAUDE_ASSETS.length + 1), source = assetText(key);
    if (host === "claude") { files.set(`.claude/${tail}`, source); continue; }
    if (tail.startsWith("skills/")) {
      const text = tail === "skills/ca-answer/SKILL.md" ? assetText("template/codex/ca-answer.md") : codexText(source, false);
      files.set(`.agents/${tail}`, text);
    } else {
      const header = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
      if (!header) throw new Stop(`에이전트 머리말이 없습니다: ${key}`);
      const name = /^name: (.+)$/m.exec(header[1])?.[1].trim();
      const description = /^description: (.+)$/m.exec(header[1])?.[1].trim();
      if (!name || !description) throw new Stop(`에이전트 이름·설명이 없습니다: ${key}`);
      const body = codexText(source.slice(header[0].length), true);
      files.set(`.codex/agents/${name}.toml`, codexModelText([
        `name = ${JSON.stringify(codexAgentName(name))}`, `description = ${JSON.stringify(description)}`,
        `developer_instructions = ${JSON.stringify("계획 배정 결과와 리뷰 결과는 최종 응답으로 반환한다. 승인 질문은 메인만 담당한다.\n\n" + body)}`, "",
      ].join("\n"), codexModelOf(root, name.replace(/^ca-/, "") as AgentName)));
    }
  }
  return files;
}
