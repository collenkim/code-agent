import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { assetKeys, assetText, CLAUDE_ASSETS } from "./assets";
import { Stop } from "./stop";
import { codexModelOf, codexModelText, type AgentName } from "./modelPolicy";

export type Host = "claude" | "codex";
export type HostSelection = Host | "both";
const ROLE_NAMES = ["ca-analyst", "ca-explorer", "ca-writer", "ca-critic", "ca-reviewer", "ca-implementer", "ca-surveyor", "ca-tester"];
export function codexAgentName(name: string): string { return ROLE_NAMES.includes(name) ? name.replace(/-/g, "_") : name; }
export function commonAgentName(name?: string): string | undefined { return ROLE_NAMES.find(role => codexAgentName(role) === name) ?? name; }
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
export function hookFile(root: string, host: Host): string {
  return join(root, host === "claude" ? ".claude/settings.json" : ".codex/hooks.json");
}

/** 업무 지침은 공유하고 호스트 도구·설치 경로만 변환한다. 승인 절차는 별도 계약이다. */
function codexText(text: string): string {
  return text.replace(/\bca-(?:analyst|explorer|writer|critic|reviewer|implementer|surveyor|tester)\b(?!\.md)/g, codexAgentName)
    .replace(/`agent`/g, "`hostAgents.codex`")
    .replace(/\.claude\/skills\//g, ".agents/skills/")
    .replace(/\.claude\/agents\/([\w-]+)\.md/g, ".codex/agents/$1.toml")
    .replace(/Claude Code/g, "Codex").replace(/CLAUDE\.md/g, "AGENTS.md")
    .replace(/(?<![\w/])\/ca-/g, "$ca-")
    .replace(/AskUserQuestion/g, "ca-answer의 Codex 응답 절차")
    .replace(/\$ARGUMENTS/g, "<사용자가 전달한 인자>")
    .replace(/\bBash:/g, "셸:")
    .replace(/subagent_type/g, "agent_type")
    // 교차 검증은 지금 호스트가 아닌 쪽이 맡는다
    .replace(/--by codex/g, "--by claude")
    // Codex hook에는 서브 에이전트 식별자가 없어 staging을 열 수 없다 — 본문을 결과에 싣는 문장으로 바꾼다
    .replace("담당은 출력 문서를 staging에 쓰고 결과 JSON에는 경로만 넣는다.", "Codex 담당은 출력 문서 전체를 결과 JSON의 artifacts에 `{path, content}`로 넣는다(staging은 Claude 전용).")
    .replace("출력 문서는 배정의 `staging` 경로에 Write로 전체 내용을 쓰고 artifacts에는 `{path, staged}`만 넣는다 — 결과 JSON에 문서 본문을 싣지 않는다. 그 쓰기가 거부되면 `{path, content}`로 낸다. staging 밖의 파일은 쓰지 않는다.", "출력 문서는 artifacts에 `{path, content}`로 전체 내용을 넣는다. 파일은 쓰지 않는다.")
    .replace("문서는 staging에 쓰고 artifacts에는 경로만 넣는다. 그 밖의 파일을 쓰거나", "문서 전체는 artifacts의 `{path, content}`로 넣는다. 파일을 쓰거나")
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
