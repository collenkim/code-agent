import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { isPackaged } from "./assets";
import { Stop } from "./stop";
import { scriptRunner } from "./hosts";

const START = "# code-agent:choices:start", END = "# code-agent:choices:end";
function configText(root: string): string {
  const file = join(root, ".codex/config.toml");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}
export function checkChoiceConfig(root: string): void {
  const text = configText(root), start = text.indexOf(START), end = text.indexOf(END);
  if ((start < 0) !== (end < 0) || (start >= 0 && end <= start)) throw new Stop(".codex/config.toml의 code-agent 선택 UI 블록 경계가 잘못되었습니다.");
  const outside = start < 0 ? text : text.slice(0, start) + text.slice(end + END.length);
  if (/^\s*\[\s*mcp_servers\s*\.\s*["']?code_agent["']?\s*(?:\.|\])/m.test(outside)
      || /^\s*mcp_servers\s*\.\s*["']?code_agent["']?\s*[.=]/m.test(outside)) {
    throw new Stop(".codex/config.toml에 사용자가 등록한 mcp_servers.code_agent가 있습니다. 이름 충돌을 해소한 뒤 다시 설치하세요.");
  }
}
export function installChoiceConfig(root: string, cli?: string): void {
  checkChoiceConfig(root);
  const file = join(root, ".codex/config.toml"), text = configText(root);
  const command = cli ? scriptRunner() : process.execPath;
  if (!command) throw new Stop("선택 UI의 --cli 실행에 필요한 node를 PATH에서 찾지 못했습니다.");
  const args = [...(isPackaged() && !cli ? [] : [resolve(cli ?? join(__dirname, "cli.js"))]), "choice-server", "--root", resolve(root)];
  const block = `${START}\n[mcp_servers.code_agent]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\ntool_timeout_sec = 3600\n${END}`;
  const start = text.indexOf(START), end = text.indexOf(END);
  const next = start < 0 ? `${text.trimEnd()}${text.trim() ? "\n\n" : ""}${block}\n` : text.slice(0, start) + block + text.slice(end + END.length);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
}
export function choiceConfigProblem(root: string): string | undefined {
  try {
    checkChoiceConfig(root);
    const text = configText(root);
    if (!text.includes(START) || !text.includes('"choice-server"') || !text.includes("[mcp_servers.code_agent]")) return "선택 UI MCP 설정이 없습니다.";
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}
