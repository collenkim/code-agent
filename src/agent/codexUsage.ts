/**
 * Codex 세션 기록 집계 — `usage` 의 Codex 절.
 *
 * 형식은 codex-cli 0.161.0 의 실제 기록(rollout)으로 확인했다(2026-10-08, Windows). `$CODEX_HOME/sessions/**\/rollout-*.jsonl`,
 * 줄마다 `{timestamp, ordinal, type, payload}`.
 * - **첫 `session_meta` 가 그 파일 자신이다** — `payload.cwd` 로 저장소를 고른다. 하위 에이전트 파일은 `payload.source` 가
 *   `{subagent:{thread_spawn:{…, agent_role}}}`(code-agent 담당) 또는 `{subagent:{other:"guardian"}}` 같은 꼴이고, 두 번째 `session_meta`
 *   (부모)와 `ordinal < payload.subagent_history_start_ordinal` 줄은 부모 대화를 물려받은 사본이라 세지 않는다.
 * - 토큰은 `token_usage_record` 의 `payload.usage`(응답 하나에 한 줄, `response_id` 로 거른다)를 센다. `event_msg` `token_count` 는
 *   같은 값을 한 번 더 내거나(합계가 그대로인 줄) 압축(compaction) 요청을 빠뜨리므로, `token_usage_record` 가 없는 파일에서만
 *   `info.last_token_usage` 를 세고 합계(`info.total_token_usage`)가 앞 줄과 같은 줄은 버린다. 둘을 함께 세지 않는다(이중 집계).
 * - 도구 호출은 `response_item` 의 `function_call`·`custom_tool_call`(셸·패치는 `exec` 하나로 온다)·`local_shell_call`, 도구 결과는
 *   `function_call_output`·`custom_tool_call_output` 의 `output`(문자열·`{content}`·`[{type:"input_text", text}]`)이다.
 * - 셸 명령은 `event_msg` `item_completed` 의 `item.type:"CommandExecution"` `item.command`(`[powershell.exe 경로, "-Command", 스크립트]`
 *   꼴 — 래퍼를 벗긴다)다. 이 줄이 없는 파일만 도구 호출 인자의 `command` 를 쓴다(`exec` 의 입력은 스크립트라 명령을 뽑지 않는다).
 *   `item.type:"FileChange"` 는 파일 변경 한 건으로 센다.
 * 모르는 줄·깨진 줄은 버리고 0 으로 센다. 단가표가 없어 비용은 내지 않는다.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative } from "path";

import { commonAgentName } from "./hostText";
import { canonical } from "./layout";

export interface CodexTokens { input: number; cachedInput: number; cacheWrite: number; output: number; reasoningOutput: number }
/** 메인 세션 행의 이름 — 하위 에이전트는 공통 역할 이름(ca-explorer)이나 Codex 가 적은 출처(guardian) */
export const CODEX_MAIN_AGENT = "main";
/** 한 요청(토큰 기록) */
export interface CodexRequest { at: string; agent: string; tokens: CodexTokens; thread?: string }
/** 한 도구 호출 */
export interface CodexToolCall { at: string; agent: string; id?: string; name: string; thread?: string }
export interface CodexResult { at: string; agent: string; id?: string; chars: number; thread?: string }
/** 셸 명령 한 건(래퍼를 벗긴 문자열) */
export interface CodexCommand { at: string; agent: string; command: string }
export interface CodexLog {
  dir: string; found: boolean;
  /** 메인 세션 파일 수 */
  sessions: number;
  /** 하위 에이전트 파일 수 */
  subagents: number;
  requests: CodexRequest[]; calls: CodexToolCall[]; results: CodexResult[]; commands: CodexCommand[];
  /** 파일 변경(FileChange) 기록 */
  fileChanges: { at: string; agent: string }[];
}

/** Codex 기록 폴더 — `CODEX_HOME`(없으면 `~/.codex`) 아래 `sessions` */
export function codexSessionsDir(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
}

function rollouts(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string, depth: number) => {
    if (depth > 6) return;
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) found.push(path);
    }
  };
  walk(dir, 0);
  return found;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const fold = (path: string): string => process.platform === "win32" ? path.toLowerCase() : path;

/** 저장소 안의 경로인가 — 대소문자는 Windows 에서만 접는다 */
function inside(root: string, cwd: unknown): boolean {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return false;
  let path: string;
  try { path = canonical(cwd); } catch { path = cwd; }
  const rel = relative(fold(root), fold(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 셸 래퍼의 실행 파일 이름(경로·`.exe` 뺀 소문자)별 스크립트 깃발 */
const SHELL_SCRIPT_FLAG: [RegExp, RegExp][] = [
  [/^(?:ba|z|da|k)?sh$/, /^-[a-z]*c$/],
  [/^(?:powershell|pwsh)$/, /^-(?:c|command)$/i],
  [/^cmd$/, /^\/c$/i],
];
/**
 * 셸 래퍼를 벗긴 명령 — Codex 셸 도구는 명령을 `["bash","-lc","code-agent next"]`·`["powershell.exe","-Command","…"]`·
 * `["cmd","/c","…"]` 처럼 감싸 보낸다(Windows 0.161.0 은 `[powershell.exe 경로, "-Command", 스크립트]` — 실측). 래퍼 꼴(셸, 그 사이의 다른 깃발, 스크립트 깃발, 스크립트 하나)이면
 * 마지막 요소, 아니면 공백으로 이은 배열이다. 벗기지 못하면 명령별 호출·스킬 읽기가 code-agent 명령으로 잡히지 않는다
 */
export function unwrapShellArgv(argv: string[]): string {
  if (argv.length >= 3) {
    const exe = (argv[0].split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
    const rule = SHELL_SCRIPT_FLAG.find(([name]) => name.test(exe));
    const flag = argv[argv.length - 2];
    const between = argv.slice(1, -2);
    if (rule && rule[1].test(flag) && between.every((part) => /^[-/]/.test(part))) return argv[argv.length - 1];
  }
  return argv.join(" ");
}

/** 셸 호출 인자의 명령 문자열 — arguments(JSON 문자열)의 command(배열이면 셸 래퍼를 벗기거나 공백으로 잇는다) */
function shellCommand(payload: Json): string | undefined {
  let args: unknown = payload.arguments;
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { return undefined; } }
  return argvText(record(args)?.command ?? record(payload.action)?.command);
}
function argvText(command: unknown): string | undefined {
  if (Array.isArray(command)) return unwrapShellArgv(command.filter((part): part is string => typeof part === "string"));
  return typeof command === "string" ? command : undefined;
}

/** 이 파일의 행 이름 — 첫 session_meta 의 출처. 하위 에이전트면 [이름, true] */
function agentOf(meta: Json): [string, boolean] {
  const subagent = record(meta.source)?.subagent;
  if (subagent === undefined) return [CODEX_MAIN_AGENT, false];
  const spawn = record(record(subagent)?.thread_spawn);
  const role = [meta.agent_role, spawn?.agent_role, record(subagent)?.other, subagent].find((value): value is string => typeof value === "string" && value !== "");
  return [commonAgentName(role) ?? "subagent", true];
}

const tokensOf = (usage: Json): CodexTokens => ({ input: num(usage.input_tokens), cachedInput: num(usage.cached_input_tokens),
  cacheWrite: num(usage.cache_write_input_tokens), output: num(usage.output_tokens), reasoningOutput: num(usage.reasoning_output_tokens) });

/** 도구 결과의 글자 수 — 문자열 · {content} · [{type:"input_text", text}] */
function outputChars(output: unknown): number {
  if (typeof output === "string") return output.length;
  if (Array.isArray(output)) return output.reduce((sum: number, part) => sum + (typeof record(part)?.text === "string" ? (record(part)!.text as string).length : 0), 0);
  const content = record(output)?.content;
  return typeof content === "string" ? content.length : Array.isArray(content) ? outputChars(content) : 0;
}

/** 이 저장소의 Codex 세션 기록을 읽는다. 폴더가 없으면 found:false */
export function readCodexLog(repoRoot: string, dir: string = codexSessionsDir()): CodexLog {
  const log: CodexLog = { dir, found: existsSync(dir), sessions: 0, subagents: 0, requests: [], calls: [], results: [], commands: [], fileChanges: [] };
  if (!log.found) return log;
  const root = canonical(repoRoot);
  for (const file of rollouts(dir)) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    const rows: Json[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { const row = record(JSON.parse(line)); if (row) rows.push(row); } catch { /* 반쯤 쓰인 줄 */ }
    }
    const meta = record(rows.find((row) => row.type === "session_meta")?.payload);
    if (!meta || !inside(root, meta.cwd)) continue;
    const [agent, isSubagent] = agentOf(meta);
    if (isSubagent) log.subagents += 1; else log.sessions += 1;
    // 하위 에이전트 파일의 thread id — usage 가 배정(계획 담당·리뷰어 기록의 agent id)과 잇는다
    const thread = isSubagent && typeof meta.id === "string" && meta.id ? { thread: meta.id } : {};
    // 하위 에이전트 파일 앞머리의 부모 대화 사본(ordinal 이 시작 번호보다 작은 줄)은 세지 않는다
    const start = num(meta.subagent_history_start_ordinal);
    const own = rows.filter((row) => !(start > 0 && typeof row.ordinal === "number" && row.ordinal < start));
    const records = own.some((row) => row.type === "token_usage_record" && record(record(row.payload)?.usage));
    const executions = own.some((row) => row.type === "event_msg" && record(row.payload)?.type === "item_completed" && record(record(row.payload)?.item)?.type === "CommandExecution");
    const responses = new Set<string>();
    let lastTotal: string | undefined;
    for (const row of own) {
      const payload = record(row.payload);
      const at = typeof row.timestamp === "string" ? row.timestamp : "";
      if (!payload || !at) continue;
      if (row.type === "token_usage_record") {
        const usage = record(payload.usage), response = typeof payload.response_id === "string" ? payload.response_id : undefined;
        if (!usage || (response && responses.has(response))) continue;
        if (response) responses.add(response);
        log.requests.push({ at, agent, tokens: tokensOf(usage), ...thread });
      } else if (row.type === "event_msg" && payload.type === "token_count") {
        const info = record(payload.info), usage = record(info?.last_token_usage);
        if (records || !usage) continue;
        const total = info?.total_token_usage === undefined ? undefined : JSON.stringify(info.total_token_usage);
        if (total !== undefined && total === lastTotal) continue;     // 같은 값을 한 번 더 낸 줄
        lastTotal = total;
        log.requests.push({ at, agent, tokens: tokensOf(usage), ...thread });
      } else if (row.type === "event_msg" && payload.type === "item_completed") {
        const item = record(payload.item);
        if (item?.type === "FileChange") log.fileChanges.push({ at, agent });
        const command = item?.type === "CommandExecution" ? argvText(item.command) : undefined;
        if (command !== undefined) log.commands.push({ at, agent, command });
      } else if (row.type === "response_item" && ["function_call", "custom_tool_call", "local_shell_call"].includes(String(payload.type))) {
        const name = typeof payload.name === "string" && payload.name ? payload.name : String(payload.type);
        const id = typeof payload.call_id === "string" ? payload.call_id : undefined;
        log.calls.push({ at, agent, ...(id ? { id } : {}), name, ...thread });
        const command = executions ? undefined : shellCommand(payload);
        if (command !== undefined) log.commands.push({ at, agent, command });
      } else if (row.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(String(payload.type))) {
        const id = typeof payload.call_id === "string" ? payload.call_id : undefined;
        log.results.push({ at, agent, ...(id ? { id } : {}), chars: outputChars(payload.output), ...thread });
      }
    }
  }
  return log;
}
