/**
 * Codex 세션 기록 집계 — `usage` 의 Codex 절.
 *
 * **형식은 공개 Codex 기록 형식을 가정했고 실제 기록으로 확인하기 전이다**(이 PC 에 Codex 기록이 없다). 가정:
 * `$CODEX_HOME/sessions/**\/rollout-*.jsonl`, 줄마다 `{timestamp, type, payload}`. `session_meta` 의 `payload.cwd` 로 저장소를 고르고,
 * `event_msg` 의 `payload.type:"token_count"` 에 `payload.info.last_token_usage` 가 있으면 요청 1건, `response_item` 의
 * `function_call`·`custom_tool_call`·`local_shell_call` 이 도구 호출, `function_call_output`·`custom_tool_call_output` 의 `output` 이 도구 결과다.
 * 모르는 줄·깨진 줄은 버리고 0 으로 센다. 단가표가 없어 비용은 내지 않는다.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative } from "path";

import { canonical } from "./layout";

export interface CodexTokens { input: number; cachedInput: number; output: number; reasoningOutput: number }
/** 한 요청(토큰 기록) */
export interface CodexRequest { at: string; tokens: CodexTokens }
/** 한 도구 호출 — 셸 명령이면 command 를 싣는다 */
export interface CodexToolCall { at: string; id?: string; name: string; command?: string }
export interface CodexResult { at: string; id?: string; chars: number }
export interface CodexLog { dir: string; found: boolean; sessions: number; requests: CodexRequest[]; calls: CodexToolCall[]; results: CodexResult[] }

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

/** 셸 호출의 명령 문자열 — arguments(JSON 문자열)의 command(배열이면 공백으로 잇는다) */
function shellCommand(payload: Json): string | undefined {
  let args: unknown = payload.arguments;
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { return undefined; } }
  const command = record(args)?.command ?? record(payload.action)?.command;
  if (Array.isArray(command)) return command.filter((part) => typeof part === "string").join(" ");
  return typeof command === "string" ? command : undefined;
}

/** 이 저장소의 Codex 세션 기록을 읽는다. 폴더가 없으면 found:false */
export function readCodexLog(repoRoot: string, dir: string = codexSessionsDir()): CodexLog {
  const log: CodexLog = { dir, found: existsSync(dir), sessions: 0, requests: [], calls: [], results: [] };
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
    const meta = rows.find((row) => row.type === "session_meta");
    if (!meta || !inside(root, record(meta.payload)?.cwd)) continue;
    log.sessions += 1;
    for (const row of rows) {
      const payload = record(row.payload);
      const at = typeof row.timestamp === "string" ? row.timestamp : "";
      if (!payload || !at) continue;
      if (row.type === "event_msg" && payload.type === "token_count") {
        const usage = record(record(payload.info)?.last_token_usage);
        if (!usage) continue;
        log.requests.push({ at, tokens: { input: num(usage.input_tokens), cachedInput: num(usage.cached_input_tokens), output: num(usage.output_tokens), reasoningOutput: num(usage.reasoning_output_tokens) } });
      } else if (row.type === "response_item" && ["function_call", "custom_tool_call", "local_shell_call"].includes(String(payload.type))) {
        const name = typeof payload.name === "string" && payload.name ? payload.name : String(payload.type);
        const id = typeof payload.call_id === "string" ? payload.call_id : undefined;
        const command = shellCommand(payload);
        log.calls.push({ at, ...(id ? { id } : {}), name, ...(command !== undefined ? { command } : {}) });
      } else if (row.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(String(payload.type))) {
        const output = payload.output;
        const chars = typeof output === "string" ? output.length : typeof record(output)?.content === "string" ? (record(output)!.content as string).length : 0;
        const id = typeof payload.call_id === "string" ? payload.call_id : undefined;
        log.results.push({ at, ...(id ? { id } : {}), chars });
      }
    }
  }
  return log;
}
