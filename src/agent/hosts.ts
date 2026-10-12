import { existsSync, readFileSync } from "fs";
import { delimiter, join } from "path";
import { assetKeys, assetText, CLAUDE_ASSETS, isPackaged } from "./assets";
import { isBatchScript, resolveExecutable } from "../core/build";
import { Stop } from "./stop";
import { codexModelOf, codexModelText, type AgentName } from "./modelPolicy";
import { codexAgentName, commonAgentName, ROLE_NAMES } from "./hostText";
import { guidance, POLICIES } from "./retryPolicy";

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
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(value) || !value.length || value.some(host => host !== "claude" && host !== "codex")) throw new Stop("설치 호스트 기록이 잘못되었습니다: .code-agent/hosts.json");
  return [...new Set(value)] as Host[];
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
 * 두 호스트가 설치된 프로젝트에서 교차 실행 명령을 못 쓰는 이유 — 설정 오류(hostCommandConfigError)와 실행 불가(미설치)로 나눈다.
 * 한 호스트 설치면 undefined. 교차 안내(crossNotice — init·status·doctor)와 doctor 의 표시(설정 오류는 ✗)가 같은 판정을 쓴다.
 */
export function crossHostProblems(root: string): { config: string[]; missing: string[] } | undefined {
  if (selectedHosts(root).length < 2) return undefined;
  const reasons = (["claude", "codex"] as Host[]).map((host) => hostCommand(host)).filter((value): value is string => typeof value === "string");
  return { config: reasons.filter(hostCommandConfigError), missing: reasons.filter((reason) => !hostCommandConfigError(reason)) };
}

/**
 * 교차 게이트 줄(review.ts reviewProblems·planningState.ts crossCriticProblems)의 실행 명령 뒤 괄호 — 그 명령을 실행하면 어떻게 되는지.
 * 직전 실행의 실패가 있으면(지점 안내 hint) 그 원인별 안내(crossHintText)가 다음 일을 싣는다 — 설정 오류·샌드박스 거부는 '게이트가 막혀
 * 있다' 이므로 '실행할 수 없으면 중지' 괄호를 달지 않는다. 아직 실행 전이어도 그 호스트의 실행 파일이 설정 오류면 설정 오류 갈래 문장이고,
 * 그 밖(실행할 수 있거나 미설치)은 실행 불가 갈래다. 갈래와 문장은 crossNotice 와 같다(재시도 규약의 GUIDE_VARIANTS — notice·gate).
 */
export function crossRunNote(host: Host | undefined, hint?: { class: string }): string {
  if (hint) return "";
  const resolved = host ? hostCommand(host) : undefined;
  if (typeof resolved === "string" && hostCommandConfigError(resolved)) {
    return ` (${POLICIES["cross-config-error"].label} — ${guidance("cross-config-error", { detail: resolved }, "notice")})`;
  }
  return ` (${guidance("cross-unavailable", {}, "gate")})`;
}

/**
 * 교차 검증 안내 한 줄 — 두 호스트가 설치된 프로젝트에서만. 둘 다 실행할 수 있을 때만 교차 검증이 실제로 돈다.
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
    "두 호스트를 모두 설치·로그인해 쓸 수 있을 때만 교차 검증을 쓰고, 한쪽만 쓸 거면 .code-agent/hosts.json 에서 쓰지 않는 호스트를 빼세요(doc/codex.md 의 제거 절 — init 은 호스트를 줄이지 않는다)";
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
  // Codex 계획 담당의 배정 계약은 staging 이 아니라 결과의 {path, content} 다(hook 이 실행 중인 Codex 계획 담당의 파일 쓰기를 거부한다)
  // — 본문을 결과에 싣는 문장으로 바꾼다(계획 스킬 4개 3항·담당 에이전트)
  ["담당은 출력 문서를 staging에 쓰고 결과 JSON에는 경로만 넣는다.", "Codex 담당은 출력 문서 전체를 결과 JSON의 artifacts에 `{path, content}`로 넣는다(staging은 Claude 전용)."],
  ["출력 문서는 배정의 `staging` 경로에 Write로 전체 내용을 쓰고 artifacts에는 `{path, staged}`만 넣는다 — 결과 JSON에 문서 본문을 싣지 않는다. 그 쓰기가 거부되면 `{path, content}`로 낸다. staging 밖의 파일은 쓰지 않는다.",
    "출력 문서는 artifacts에 `{path, content}`로 전체 내용을 넣는다. 파일은 쓰지 않는다."],
  ["문서는 staging에 쓰고 artifacts에는 경로만 넣는다. 그 밖의 파일을 쓰거나", "문서 전체는 artifacts의 `{path, content}`로 넣는다. 파일을 쓰거나"],
];

function codexText(text: string): string {
  return CODEX_SENTENCES.reduce((out, [from, to]) => out.split(from).join(to), text).replace(ROLE_PATTERN, codexAgentName)
    .replace(/`agent`/g, "`hostAgents.codex`")
    .replace(/\.claude\/skills\//g, ".agents/skills/")
    .replace(/\.claude\/agents\/([\w-]+)\.md/g, ".codex/agents/$1.toml")
    .replace(/Claude Code/g, "Codex").replace(/CLAUDE\.md/g, "AGENTS.md")
    .replace(/(?<![\w/])\/ca-/g, "$ca-")
    .replace(/AskUserQuestion/g, "Codex 업무 질문 도구")
    .replace(/\$ARGUMENTS/g, "<사용자가 전달한 인자>")
    .replace(/\bBash:/g, "셸:")
    .replace(/\bBash 로 /g, "셸로 ")
    .replace(/\bBash 등으로/g, "셸 등으로")
    .replace(/subagent_type/g, "agent_type")
    // 교차 검증은 지금 호스트가 아닌 쪽이 맡는다
    .replace(/--by codex/g, "--by claude")
    // Codex 메인의 교차 명령은 다른 호스트를 띄우고 네트워크를 쓴다 — 샌드박스 밖(권한 상승)으로 실행하게 한다(`Bash:`·`--by` 치환 뒤의 글자)
    .replace(/셸: `code-agent (review|planning) cross --by claude`/g,
      "셸(Codex 샌드박스 밖 — 다른 호스트를 띄우고 네트워크를 쓰므로 권한 상승을 요청해 실행한다): `code-agent $1 cross --by claude`")
    + "\n\n파일 읽기는 셸에서 `code-agent read <파일> [시작 줄] [줄 수]`를 사용한다. 줄 수는 최대 400이다. Read/Grep/Glob 전용 도구가 없으면 배정 inputs와 `code-agent survey`의 경로를 이 명령으로 읽는다. 일반 셸 읽기·연결 명령은 작업 게이트가 거부한다.\n";
}
export function hostAssets(host: Host, root?: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const key of assetKeys(CLAUDE_ASSETS)) {
    const tail = key.slice(CLAUDE_ASSETS.length + 1), source = assetText(key);
    if (host === "claude") { files.set(`.claude/${tail}`, source); continue; }
    if (tail.startsWith("skills/")) {
      const text = tail === "skills/ca-answer/SKILL.md" ? assetText("template/codex/ca-answer.md") : codexText(source);
      files.set(`.agents/${tail}`, text);
    } else {
      const header = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
      if (!header) throw new Stop(`에이전트 머리말이 없습니다: ${key}`);
      const name = /^name: (.+)$/m.exec(header[1])?.[1].trim();
      const description = /^description: (.+)$/m.exec(header[1])?.[1].trim();
      if (!name || !description) throw new Stop(`에이전트 이름·설명이 없습니다: ${key}`);
      const body = codexText(source.slice(header[0].length));
      files.set(`.codex/agents/${name}.toml`, codexModelText([
        `name = ${JSON.stringify(codexAgentName(name))}`, `description = ${JSON.stringify(description)}`,
        `developer_instructions = ${JSON.stringify("계획 배정 결과와 리뷰 결과는 최종 응답으로 반환한다. 승인 질문은 메인만 담당한다. Codex에서는 staging에 쓰지 않는다 — 배정의 resultShape가 artifacts를 {path, staged}로 보여 줘도 {path, content}로 전체 내용을 넣는다.\n\n" + body)}`, "",
      ].join("\n"), codexModelOf(root, name.replace(/^ca-/, "") as AgentName)));
    }
  }
  return files;
}
