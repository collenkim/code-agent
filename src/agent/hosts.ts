import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { assetKeys, assetText, CLAUDE_ASSETS } from "./assets";
import { Stop } from "./stop";

export type Host = "claude" | "codex";
export type HostSelection = Host | "both";
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
  return text.replace(/\.claude\/skills\//g, ".agents/skills/")
    .replace(/\.claude\/agents\/([\w-]+)\.md/g, ".codex/agents/$1.toml")
    .replace(/Claude Code/g, "Codex").replace(/CLAUDE\.md/g, "AGENTS.md")
    .replace(/(?<![\w/])\/ca-/g, "$ca-")
    .replace(/AskUserQuestion/g, "ca-answer의 Codex 응답 절차")
    .replace(/\$ARGUMENTS/g, "<사용자가 전달한 인자>")
    .replace(/\bBash:/g, "셸:")
    .replace(/subagent_type/g, "agent_type");
}
export function hostAssets(host: Host): Map<string, string> {
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
      files.set(`.codex/agents/${name}.toml`, [
        `name = ${JSON.stringify(name)}`, `description = ${JSON.stringify(description)}`,
        // 모델과 추론 강도는 부모 Codex 설정을 상속한다. Claude 모델 값은 이식하지 않는다.
        `developer_instructions = ${JSON.stringify("계획 배정 결과와 리뷰 결과는 최종 응답으로 반환한다. 승인 질문은 메인만 담당한다.\n\n" + body)}`, "",
      ].join("\n"));
    }
  }
  return files;
}
