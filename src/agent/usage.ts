import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { canonical, readStages } from "./layout";
import type { StageTransition } from "./layout";
import { PRICES_AS_OF, priceKey, priceOf } from "./prices";
import { Stop } from "./stop";
import { selectedHosts } from "./hosts";
import { readCodexLog, type CodexTokens } from "./codexUsage";
import { retryLine, retryReports, type RetryReport } from "./retryReport";

/**
 * `code-agent usage` — 이 저장소에 쓴 토큰을 **스테이지별·에이전트별·모델별**로 센다.
 * 모델별 표는 기록의 `message.model` 을 단가표 키(날짜 접미사 제거, `priceKey`)로 묶는다.
 *
 * 세는 것은 Claude Code 가 남긴 기록(`~/.claude/projects/<인코딩한 저장소 경로>/*.jsonl`)이다.
 * 우리가 쓰는 자리가 아니라 **읽는 자리**라, 형식이 흔들려도 명령이 서지 않게 짠다 —
 * 깨진 줄은 그 줄만 버리고, 모르는 필드는 0 으로 보고, 폴더가 없으면 안내하고 끝낸다.
 *
 * 기록에 우리 스테이지는 없다. 있는 것은 시각뿐이라 `.code-agent/log/stages.jsonl`(커서가 움직일 때마다
 * `logStage` 가 남긴다)로 구간을 만들고 메시지의 `timestamp` 를 그 구간에 담는다.
 *
 * 토큰 표 뒤에 호출 통계를 더한다 — 요청 수, 도구 호출(`tool_use` 블록, id 로 한 번), 도구 결과 글자(대화에 들어간 `tool_result` 글자 —
 * 큰 결과가 파일로 빠지면 미리보기만 센다), 도구 이름별·`code-agent` 하위 명령별 호출, 스킬 파일 읽기, 작업 기록의 재시도·재배정
 * (`retryReport.ts` — 읽기만 한다). Codex 설치면 Codex 세션 기록을 같은 구간으로 센다(`codexUsage.ts` — codex-cli 0.161.0 기록 꼴, 하위 에이전트 행 따로, 비용 없음).
 * `usageReport` 가 같은 값을 객체로 돌려준다(`--json`).
 */

/** 첫 전이 이전 — 문서 작성·도입처럼 작업 커서가 없던 시간 */
const BEFORE = "(작업 전)";
/** deliver·abort 뒤 — 작업이 끝난 뒤의 대화 */
const OUTSIDE = "(작업 밖)";
/** 서브에이전트 기록에 짝 `.meta.json` 이 없거나 읽을 수 없을 때 */
const UNKNOWN_AGENT = "(알 수 없음)";
/** `message.model` 이 없는 줄. 에이전트 이름과 섞이지 않게 따로 둔다 — 꼬리의 미산정 목록에 이 이름으로 뜬다 */
const UNKNOWN_MODEL = "(모델 없음)";
/** 메인 세션 기록 */
const MAIN_AGENT = "main";

export interface Tokens {
  input: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
  output: number;
}

interface Message {
  /** ISO */
  at: string;
  agent: string;
  model: string;
  tokens: Tokens;
}

export interface UsageOptions {
  /** `--work <ID>` — 그 작업의 구간만 */
  work?: string;
  /** `--since <date>` — 그 시각 이후만 */
  since?: string;
  /**
   * 기록 폴더. 생략하면 `~/.claude/projects/<인코딩한 경로>`.
   * `homedir()` 는 바꿀 수 없어서 테스트가 합성 기록을 주입하는 자리로 열어 둔다.
   */
  transcripts?: string;
  /** Codex 세션 기록 폴더. 생략하면 `$CODEX_HOME/sessions`(없으면 `~/.codex/sessions`) — 테스트가 합성 기록을 주입하는 자리 */
  codexSessions?: string;
}

/** 행마다의 호출 통계 */
export interface CallStats { requests: number; toolCalls: number; toolResultChars: number }
export interface UsageRow { label: string; tokens: Tokens | CodexTokens; cost: number; calls: CallStats }
export interface UsageSection {
  source: "claude" | "codex";
  dir: string;
  sessions: number;
  subagents: number;
  range?: { from: string; to: string };
  stages: UsageRow[];
  agents: UsageRow[];
  /** Claude 만 — 단가표 키별 */
  models: UsageRow[];
  /** 도구 이름별 호출 수 */
  tools: Record<string, number>;
  /** 셸 도구의 code-agent 하위 명령별 호출 수 */
  commands: Record<string, number>;
  /** 읽기 도구(Codex 는 code-agent read)가 읽은 스킬 파일(<스킬>/<파일>)별 횟수 */
  skillReads: Record<string, number>;
  /** Codex 만 — 파일 변경(FileChange) 기록 수 */
  fileChanges?: number;
  unpriced: string[];
  /** 스테이지 기록(stages.jsonl)이 있는가 */
  stageLog: boolean;
  /** 기록 없음·셀 것 없음 안내 — 있으면 표가 없다 */
  note?: string[];
}
export interface UsageReport { head: string; sections: UsageSection[]; retry: RetryReport[]; pricesAsOf: string }

/**
 * Claude Code 가 저장소 경로를 폴더 이름으로 바꾸는 방식 — **영숫자가 아닌 글자 하나마다 `-` 하나**.
 *
 * 이 PC 의 실제 폴더 이름에서 뽑았다: `C:\IdeaProjects\code-agent` → `C--IdeaProjects-code-agent`,
 * `C:\Users\김우석(카이)` → `C--Users--------` (한글도 글자마다 한 개). 소문자화는 하지 않는다.
 */
export function encodeRepoPath(repoRoot: string): string {
  return repoRoot.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * `canonical()` 을 **반드시** 통과시킨다 — Windows 는 같은 폴더를 8.3 이름(`김우석~1`)과 긴 이름으로
 * 둘 다 부르고, 둘은 다르게 인코딩돼 다른 폴더를 가리킨다 (`~/.claude/projects` 에 둘 다 있다).
 */
export function transcriptDir(repoRoot: string): string {
  return join(homedir(), ".claude", "projects", encodeRepoPath(canonical(repoRoot)));
}

// ---- 기록 읽기 ----

interface Transcript {
  path: string;
  agent: string;
}

/**
 * 읽을 파일. 메인 세션은 폴더 바로 아래 `<세션>.jsonl` 이고, 서브에이전트는 **프로젝트 루트가 아니라**
 * `<세션>/subagents/agent-*.jsonl` 이다 — 짝 `.meta.json` 에 `agentType` 이 들어 있다. 그 아래 하위 폴더(워크플로가 띄운
 * 서브에이전트 `subagents/workflows/<실행>/agent-*.jsonl`)도 읽는다 — 하위 폴더에서는 `agent-*.jsonl` 만(같은 폴더의
 * `journal.jsonl` 같은 실행 기록은 대화 기록이 아니다).
 */
function transcripts(dir: string): Transcript[] {
  const found: Transcript[] = [];
  const subagentFiles = (folder: string, depth: number): void => {
    let entries;
    try { entries = readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { if (depth < 4) subagentFiles(path, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || (depth > 0 && !entry.name.startsWith("agent-"))) continue;
      found.push({ path, agent: agentTypeOf(path.replace(/\.jsonl$/, ".meta.json")) });
    }
  };
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      found.push({ path: join(dir, entry.name), agent: MAIN_AGENT });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const subagents = join(dir, entry.name, "subagents");
    if (existsSync(subagents)) subagentFiles(subagents, 0);
  }
  return found;
}

/** 값을 그대로 쓴다 — 모르는 `agentType` 을 버리면 그 에이전트의 토큰이 통째로 사라진다 */
function agentTypeOf(metaPath: string): string {
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { agentType?: unknown };
    return typeof meta.agentType === "string" && meta.agentType ? meta.agentType : UNKNOWN_AGENT;
  } catch {
    return UNKNOWN_AGENT;
  }
}

interface RawUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  output_tokens?: number;
}

interface RawBlock { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown }
interface RawLine {
  type?: string;
  timestamp?: string;
  requestId?: string;
  message?: { id?: string; model?: string; usage?: RawUsage; content?: unknown };
}
/** 도구 호출 하나 — 버킷은 그 줄의 시각과 기록 파일의 에이전트 */
interface ToolCall { at: string; agent: string; name: string; input: Record<string, unknown> }
/** 도구 결과 하나 — 대화에 들어간 글자 수 */
interface ToolResult { at: string; agent: string; chars: number }
interface Collected { messages: Message[]; calls: ToolCall[]; results: ToolResult[] }

function blocks(content: unknown): RawBlock[] {
  return Array.isArray(content) ? content.filter((block): block is RawBlock => !!block && typeof block === "object") : [];
}
/** tool_result 의 content — 문자열이면 그 길이, 배열이면 text 블록 글자 합 */
function resultChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  return blocks(content).reduce((sum, block) => sum + (block.type === "text" && typeof (block as { text?: unknown }).text === "string" ? ((block as { text: string }).text).length : 0), 0);
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function tokensOf(usage: RawUsage): Tokens {
  // `cache_creation` 이 있으면 TTL 별로 갈라 적혀 있고, 없는 옛 줄은 전부 5분짜리로 본다.
  //
  // 아는 두 칸의 합이 총계(`cache_creation_input_tokens`)에 모자라면 **남은 만큼을 5분 칸에 되돌린다** —
  // 새 TTL 칸이 생겨도 그 토큰이 비용에서 조용히 사라지지 않게 하는 자리다. 지금 기록에서는 둘의 합이
  // 총계와 정확히 같아(관측한 1,920 요청 전수, 어긋남 0) 이 줄이 값을 바꾸지 않는다.
  const detail = usage.cache_creation;
  const total = number(usage.cache_creation_input_tokens);
  const known5m = detail ? number(detail.ephemeral_5m_input_tokens) : total;
  const known1h = detail ? number(detail.ephemeral_1h_input_tokens) : 0;
  return {
    input: number(usage.input_tokens),
    cacheRead: number(usage.cache_read_input_tokens),
    write5m: known5m + Math.max(0, total - known5m - known1h),
    write1h: known1h,
    output: number(usage.output_tokens),
  };
}

/**
 * 한 요청을 한 번만 센다.
 *
 * **같은 `message.id` 가 여러 줄로 나온다** — `apiBlockIndex` 만 다르고, 관측한 저장소에서 134 요청 중
 * 109 개가 그랬다. 그냥 더하면 2~3배가 된다. 같은 id 안에서 `output_tokens` 는 단조 증가하고
 * input·cache 는 불변이라(5,348 쌍 전수, 예외 0) **마지막 줄이 완성본**이다. 그래서 키마다 마지막 것이 이긴다.
 */
function collect(files: Transcript[]): Collected {
  const byKey = new Map<string, Message>();
  const calls = new Map<string, ToolCall>();
  const results = new Map<string, ToolResult>();
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file.path, "utf-8");
    } catch {
      continue; // 지워졌거나 잠긴 파일
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: RawLine;
      try {
        row = JSON.parse(line) as RawLine;
      } catch {
        continue; // 반쯤 쓰인 줄 — 기록은 지금도 쓰이는 중일 수 있다
      }
      if (typeof row.timestamp === "string") {
        // 도구 호출은 assistant 줄의 tool_use 블록(id 로 한 번), 결과는 user 줄의 tool_result 블록(tool_use_id 로 한 번)
        for (const block of blocks(row.message?.content)) {
          if (row.type === "assistant" && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string" && !calls.has(block.id)) {
            calls.set(block.id, { at: row.timestamp, agent: file.agent, name: block.name, input: block.input && typeof block.input === "object" ? block.input : {} });
          } else if (row.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string" && !results.has(block.tool_use_id)) {
            results.set(block.tool_use_id, { at: row.timestamp, agent: file.agent, chars: resultChars(block.content) });
          }
        }
      }
      const usage = row.type === "assistant" ? row.message?.usage : undefined;
      if (!usage || typeof row.timestamp !== "string") continue;
      const key = row.message?.id ?? row.requestId;
      if (!key) continue;
      byKey.set(key, {
        at: row.timestamp,
        agent: file.agent,
        model: row.message?.model ?? UNKNOWN_MODEL,
        tokens: tokensOf(usage),
      });
    }
  }
  const byTime = <T extends { at: string }>(list: T[]): T[] => list.sort((a, b) => a.at.localeCompare(b.at));
  return { messages: byTime([...byKey.values()]), calls: byTime([...calls.values()]), results: byTime([...results.values()]) };
}

// ---- 귀속 ----

interface Bucket {
  label: string;
  /** 그 구간의 작업 ID. `--work` 가 이것으로 거른다 */
  id?: string;
}

function bucketOf(stages: StageTransition[], at: string): Bucket {
  let last: StageTransition | undefined;
  for (const transition of stages) {
    if (transition.at > at) break;
    last = transition;
  }
  if (!last) return { label: BEFORE };
  if (last.by === "deliver" || last.by === "abort") return { label: OUTSIDE };
  return { label: last.stage ? `${last.phase}/${last.stage}` : last.phase, id: last.id };
}

// ---- 합계 ----

interface Row {
  label: string;
  tokens: Tokens;
  cost: number;
}

function addTo(totals: Map<string, Tokens>, label: string, tokens: Tokens): void {
  const sum = totals.get(label) ?? { input: 0, cacheRead: 0, write5m: 0, write1h: 0, output: 0 };
  sum.input += tokens.input;
  sum.cacheRead += tokens.cacheRead;
  sum.write5m += tokens.write5m;
  sum.write1h += tokens.write1h;
  sum.output += tokens.output;
  totals.set(label, sum);
}

/** 표에 없는 모델은 0 원으로 센다 — 지어낸 단가로 합계를 물들이지 않고, 이름만 꼬리에 남긴다 */
function costOf(message: Message): number {
  const price = priceOf(message.model);
  if (!price) return 0;
  const { input, cacheRead, write5m, write1h, output } = message.tokens;
  return (
    (input * price.input +
      cacheRead * price.cacheRead +
      write5m * price.cacheWrite5m +
      write1h * price.cacheWrite1h +
      output * price.output) /
    1_000_000
  );
}

function group(messages: Message[], keyOf: (message: Message) => string): Row[] {
  const tokens = new Map<string, Tokens>();
  const costs = new Map<string, number>();
  for (const message of messages) {
    const key = keyOf(message);
    addTo(tokens, key, message.tokens);
    costs.set(key, (costs.get(key) ?? 0) + costOf(message));
  }
  return [...tokens.entries()]
    .map(([label, sum]) => ({ label, tokens: sum, cost: costs.get(label) ?? 0 }))
    .sort((a, b) => b.cost - a.cost || a.label.localeCompare(b.label));
}

// ---- 출력 ----

/** 한글·한자는 터미널에서 두 칸을 먹는다 — 그냥 세면 표가 어긋난다 */
function width(text: string): number {
  let sum = 0;
  for (const char of text) sum += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60]/.test(char) ? 2 : 1;
  return sum;
}

function pad(text: string, to: number, right = false): string {
  const fill = " ".repeat(Math.max(0, to - width(text)));
  return right ? fill + text : text + fill;
}

const HEADERS = ["입력", "캐시읽기", "캐시쓰기", "출력", "비용(추정)"];

function cells(row: Row): string[] {
  return [
    row.tokens.input.toLocaleString("en-US"),
    row.tokens.cacheRead.toLocaleString("en-US"),
    (row.tokens.write5m + row.tokens.write1h).toLocaleString("en-US"),
    row.tokens.output.toLocaleString("en-US"),
    `$${row.cost.toFixed(2)}`,
  ];
}

function table(title: string, first: string, rows: Row[]): string[] {
  const total: Row = {
    label: "합계",
    tokens: rows.reduce(
      (sum, row) => ({
        input: sum.input + row.tokens.input,
        cacheRead: sum.cacheRead + row.tokens.cacheRead,
        write5m: sum.write5m + row.tokens.write5m,
        write1h: sum.write1h + row.tokens.write1h,
        output: sum.output + row.tokens.output,
      }),
      { input: 0, cacheRead: 0, write5m: 0, write1h: 0, output: 0 },
    ),
    cost: rows.reduce((sum, row) => sum + row.cost, 0),
  };
  const body = [...rows, total];
  const labelWidth = Math.max(width(first), ...body.map((row) => width(row.label)));
  const columns = HEADERS.map((header, index) =>
    Math.max(width(header), ...body.map((row) => width(cells(row)[index]))),
  );
  const line = (label: string, values: string[]) =>
    `  ${pad(label, labelWidth)}  ${values.map((value, index) => pad(value, columns[index], true)).join("  ")}`;
  return [
    title,
    line(first, HEADERS.map((header, index) => pad(header, columns[index], true))),
    ...body.map((row) => line(row.label, cells(row))),
  ];
}

function day(at: string): string {
  return at.slice(0, 10);
}

// ---- 호출 통계 ----

/** 둘째 낱말이 이것이면 셋째 낱말까지 명령 이름이다(`planning advance`·`consent finish`) */
const NESTED = ["planning", "consent", "docs", "request", "review", "plan", "plugin", "setup", "manifest", "knowledge", "model"];
/** 키 뒤에 그대로 붙이는 깃발 — 같은 명령의 다른 동작이다 */
const KEY_FLAGS = ["--chain", "--json", "--retry"];

/** 셸 명령의 code-agent 하위 명령 이름. code-agent 명령이 아니면 undefined */
export function commandKey(command: string): string | undefined {
  const words = command.trim().split(/\s+/);
  if (words[0] !== "code-agent") return undefined;
  if (words.length === 1) return "(도움말)";
  const [, second, third] = words;
  const base = NESTED.includes(second) && third !== undefined && !third.startsWith("--") ? `${second} ${third}` : second;
  const flags = KEY_FLAGS.filter((flag) => words.includes(flag));
  return [base, ...flags].join(" ");
}

/** 스킬 파일 경로의 `<스킬>/<파일>` — `.claude/skills/` 또는 `.agents/skills/` 아래가 아니면 undefined */
export function skillReadKey(path: string): string | undefined {
  const normal = path.split("\\").join("/");
  for (const marker of ["/.claude/skills/", "/.agents/skills/"]) {
    const at = `/${normal}`.indexOf(marker);
    if (at >= 0) return `/${normal}`.slice(at + marker.length) || undefined;
  }
  return undefined;
}

/** 도구 호출 한 건이 셸 명령이면 그 문자열 */
function shellOf(call: { name: string; input?: Record<string, unknown>; command?: string }): string | undefined {
  if (call.command !== undefined) return call.command;
  return ["Bash", "PowerShell"].includes(call.name) && typeof call.input?.command === "string" ? call.input.command : undefined;
}

function countCalls(calls: { name: string; input?: Record<string, unknown>; command?: string }[]): Pick<UsageSection, "tools" | "commands" | "skillReads"> {
  const tools: Record<string, number> = {}, commands: Record<string, number> = {}, skillReads: Record<string, number> = {};
  const add = (table: Record<string, number>, key: string | undefined) => { if (key) table[key] = (table[key] ?? 0) + 1; };
  for (const call of calls) {
    add(tools, call.name);
    const shell = shellOf(call);
    if (shell !== undefined) {
      add(commands, commandKey(shell));
      // Codex 는 전용 읽기 도구가 없다 — code-agent read <경로> 를 스킬 읽기로 센다
      const read = /^code-agent read\s+("[^"]+"|'[^']+'|\S+)/.exec(shell.trim());
      if (read) add(skillReads, skillReadKey(read[1].replace(/^["']|["']$/g, "")));
    }
    if (call.name === "Read" && typeof call.input?.file_path === "string") add(skillReads, skillReadKey(call.input.file_path));
  }
  return { tools, commands, skillReads };
}

/** 행 라벨마다 요청·도구 호출·도구 결과 글자 */
function callStats(labels: string[], requests: string[], calls: string[], results: { label: string; chars: number }[]): Map<string, CallStats> {
  const stats = new Map<string, CallStats>(labels.map((label) => [label, { requests: 0, toolCalls: 0, toolResultChars: 0 }]));
  const of = (label: string) => { if (!stats.has(label)) stats.set(label, { requests: 0, toolCalls: 0, toolResultChars: 0 }); return stats.get(label)!; };
  for (const label of requests) of(label).requests += 1;
  for (const label of calls) of(label).toolCalls += 1;
  for (const result of results) of(result.label).toolResultChars += result.chars;
  return stats;
}

function withCalls(rows: Row[], stats: Map<string, CallStats>): UsageRow[] {
  const out: UsageRow[] = rows.map((row) => ({ ...row, calls: stats.get(row.label) ?? { requests: 0, toolCalls: 0, toolResultChars: 0 } }));
  // 토큰이 없는데 호출만 있는 구간(그 구간의 요청 기록이 잘렸을 때)도 버리지 않는다
  for (const [label, calls] of stats) if (!rows.some((row) => row.label === label)) out.push({ label, tokens: { input: 0, cacheRead: 0, write5m: 0, write1h: 0, output: 0 }, cost: 0, calls });
  return out;
}

// ---- 집계 ----

interface Filter { since?: number; work?: string; stages: StageTransition[] }
const kept = (filter: Filter) => (at: string): boolean =>
  (filter.since === undefined || Date.parse(at) >= filter.since) && (filter.work === undefined || bucketOf(filter.stages, at).id === filter.work);

function claudeSection(repoRoot: string, options: UsageOptions, filter: Filter): UsageSection {
  const dir = options.transcripts ?? transcriptDir(repoRoot);
  const empty = { source: "claude" as const, dir, sessions: 0, subagents: 0, stages: [], agents: [], models: [], tools: {}, commands: {}, skillReads: {}, unpriced: [], stageLog: filter.stages.length > 0 };
  if (!existsSync(dir)) {
    return { ...empty, note: [`기록을 찾지 못했습니다: ${dir}`, "  이 저장소를 이 경로에서 Claude Code 로 연 적이 없거나, 다른 PC 의 기록입니다."] };
  }
  const files = transcripts(dir);
  const subagents = files.filter((file) => file.agent !== MAIN_AGENT).length;
  const all = collect(files);
  const keep = kept(filter);
  const messages = all.messages.filter((message) => keep(message.at));
  if (messages.length === 0) {
    return { ...empty, sessions: files.length - subagents, subagents, note: [
      `${dir} 에 셀 것이 없습니다.`,
      `  기록 파일 ${files.length}개를 읽었습니다 — ${options.work ? `작업 ${options.work} 의 구간이 없거나 ` : ""}거른 뒤 남은 메시지가 없습니다.`,
    ] };
  }
  const calls = all.calls.filter((call) => keep(call.at));
  const results = all.results.filter((result) => keep(result.at));
  const stageOf = (at: string) => bucketOf(filter.stages, at).label;
  // 사용량이 0 인 모델(`<synthetic>` 같은 합성 줄)은 비용에 닿지 않으므로 미산정 목록에 적지 않는다
  const used = (message: Message) => Object.values(message.tokens).some((count) => count > 0);
  const stageRows = group(messages, (message) => stageOf(message.at));
  const agentRows = group(messages, (message) => message.agent);
  return {
    ...empty,
    sessions: files.length - subagents,
    subagents,
    range: { from: messages[0].at, to: messages[messages.length - 1].at },
    stages: withCalls(stageRows, callStats(stageRows.map((row) => row.label), messages.map((m) => stageOf(m.at)), calls.map((c) => stageOf(c.at)),
      results.map((r) => ({ label: stageOf(r.at), chars: r.chars })))),
    agents: withCalls(agentRows, callStats(agentRows.map((row) => row.label), messages.map((m) => m.agent), calls.map((c) => c.agent),
      results.map((r) => ({ label: r.agent, chars: r.chars })))),
    models: modelRows(messages),
    ...countCalls(calls),
    unpriced: [...new Set(messages.filter((message) => !priceOf(message.model) && used(message)).map((message) => message.model))].sort(),
  };
}

/** 모델별 행 — 요청 수만 센다(도구 호출은 모델에 묶이지 않는다) */
function modelRows(messages: Message[]): UsageRow[] {
  const rows = group(messages, (message) => priceKey(message.model));
  return withCalls(rows, callStats(rows.map((row) => row.label), messages.map((message) => priceKey(message.model)), [], []));
}

const zeroCodex = (): CodexTokens => ({ input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoningOutput: 0 });
function codexSection(repoRoot: string, options: UsageOptions, filter: Filter): UsageSection {
  const log = readCodexLog(repoRoot, options.codexSessions);
  const empty = { source: "codex" as const, dir: log.dir, sessions: log.sessions, subagents: log.subagents, stages: [], agents: [], models: [], tools: {}, commands: {}, skillReads: {}, unpriced: [], stageLog: filter.stages.length > 0 };
  if (!log.found) return { ...empty, note: [`Codex 기록을 찾지 못했습니다: ${log.dir}`] };
  const keep = kept(filter);
  const requests = log.requests.filter((request) => keep(request.at));
  const calls = log.calls.filter((call) => keep(call.at));
  const results = log.results.filter((result) => keep(result.at));
  if (log.sessions + log.subagents === 0 || requests.length + calls.length === 0) return { ...empty, note: [`${log.dir} 에 이 저장소의 Codex 세션이 없습니다.`] };
  const stageOf = (item: { at: string }) => bucketOf(filter.stages, item.at).label;
  const rows = (labelOf: (item: { at: string; agent: string }) => string): UsageRow[] => {
    const tokens = new Map<string, CodexTokens>();
    for (const request of requests) {
      const label = labelOf(request);
      const sum = tokens.get(label) ?? zeroCodex();
      for (const key of Object.keys(sum) as (keyof CodexTokens)[]) sum[key] += request.tokens[key];
      tokens.set(label, sum);
    }
    const stats = callStats([...tokens.keys()], requests.map(labelOf), calls.map(labelOf), results.map((r) => ({ label: labelOf(r), chars: r.chars })));
    return [...stats.entries()].map(([label, calls]) => ({ label, tokens: tokens.get(label) ?? zeroCodex(), cost: 0, calls }))
      .sort((a, b) => b.calls.requests - a.calls.requests || a.label.localeCompare(b.label));
  };
  const times = [...requests, ...calls].map((item) => item.at).sort();
  // 도구 이름은 호출에서, code-agent 명령·스킬 읽기는 셸 명령 기록에서 센다(이름 없는 항목은 도구 표에 들어가지 않는다)
  const { tools } = countCalls(calls.map((call) => ({ name: call.name })));
  const { commands, skillReads } = countCalls(log.commands.filter((entry) => keep(entry.at)).map((entry) => ({ name: "", command: entry.command })));
  return { ...empty, range: { from: times[0], to: times[times.length - 1] }, stages: rows(stageOf), agents: rows((item) => item.agent),
    tools, commands, skillReads, fileChanges: log.fileChanges.filter((change) => keep(change.at)).length };
}

/**
 * `code-agent usage --json` — 호스트별 절(Claude 기록·Codex 세션 기록)과 작업 기록의 재시도 보고.
 * Claude 절은 `transcripts` 를 줬거나 Claude 설치일 때, Codex 절은 `codexSessions` 를 줬거나 Codex 설치일 때 만든다.
 */
export function usageReport(repoRoot: string, options: UsageOptions = {}): UsageReport {
  let since: number | undefined;
  if (options.since !== undefined) {
    since = Date.parse(options.since);
    if (Number.isNaN(since)) {
      throw new Stop(`--since 의 날짜를 읽을 수 없습니다: ${options.since} — 2026-09-28 처럼 적으세요.`);
    }
  }
  const hosts = selectedHosts(repoRoot);
  const filter: Filter = { since, work: options.work, stages: readStages(repoRoot) };
  const sections: UsageSection[] = [];
  if (options.transcripts || hosts.includes("claude")) sections.push(claudeSection(repoRoot, options, filter));
  if (options.codexSessions || hosts.includes("codex")) sections.push(codexSection(repoRoot, options, filter));
  return { head: [...(options.work ? [options.work] : []), repoRoot].join(" · "), sections, retry: retryReports(repoRoot, options.work), pricesAsOf: PRICES_AS_OF };
}

// ---- 출력(텍스트) ----

function countLine(title: string, counts: Record<string, number>): string[] {
  const items = Object.entries(counts).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  return items.length ? [`${title}: ${items.map(([name, count]) => `${name} ${count}`).join(" · ")}`] : [];
}

/** 열 사이 공백 2칸 이상, `$` 없음 — 토큰 표 파서(`$숫자` 줄)가 읽지 않는다 */
function plainTable(title: string, first: string, headers: string[], rows: { label: string; values: number[] }[]): string[] {
  const total = { label: "합계", values: headers.map((_, index) => rows.reduce((sum, row) => sum + row.values[index], 0)) };
  const body = [...rows, total].map((row) => ({ label: row.label, cells: row.values.map((value) => value.toLocaleString("en-US")) }));
  const labelWidth = Math.max(width(first), ...body.map((row) => width(row.label)));
  const columns = headers.map((header, index) => Math.max(width(header), ...body.map((row) => width(row.cells[index]))));
  const line = (label: string, values: string[]) => `  ${pad(label, labelWidth)}  ${values.map((value, index) => pad(value, columns[index], true)).join("  ")}`;
  return [title, line(first, headers), ...body.map((row) => line(row.label, row.cells))];
}
const CALL_HEADERS = ["요청", "도구 호출", "도구 결과(자)"];
const callValues = (row: UsageRow): number[] => [row.calls.requests, row.calls.toolCalls, row.calls.toolResultChars];

function retryBlock(retry: RetryReport[]): string[] {
  return retry.length ? ["재시도·재배정 (작업 기록, 읽기 전용)", ...retry.map(retryLine)] : [];
}
function countLines(section: UsageSection): string[] {
  return [...countLine("도구별 호출", section.tools), ...countLine("code-agent 명령별 호출", section.commands), ...countLine("스킬 읽기", section.skillReads)];
}
const rangeText = (section: UsageSection): string => section.range ? `${day(section.range.from)} ~ ${day(section.range.to)}` : "";

function renderClaude(report: UsageReport, section: UsageSection, retry: string[]): string[] {
  if (section.note) return [...section.note, ...(retry.length ? ["", ...retry] : [])];
  const toRow = (row: UsageRow): Row => ({ label: row.label, tokens: row.tokens as Tokens, cost: row.cost });
  const extra = [...countLines(section), ...retry];
  return [
    `Claude Code 사용량 · ${[report.head, rangeText(section)].join(" · ")}`,
    `기록: ${section.dir} (세션 ${section.sessions} · 서브에이전트 ${section.subagents})`,
    "",
    ...table("스테이지별", "스테이지", section.stages.filter((row) => row.calls.requests > 0).map(toRow)),
    ...(section.stageLog ? [] : ["  스테이지 기록이 없습니다 — 이 버전 이전에 시작한 작업이거나 아직 작업을 시작하지 않았습니다."]),
    "",
    ...table("에이전트별", "에이전트", section.agents.filter((row) => row.calls.requests > 0).map(toRow)),
    "",
    ...table("모델별", "모델", section.models.map(toRow)),
    "",
    ...plainTable("호출별 (스테이지)", "스테이지", CALL_HEADERS, section.stages.map((row) => ({ label: row.label, values: callValues(row) }))),
    "",
    ...plainTable("호출별 (에이전트)", "에이전트", CALL_HEADERS, section.agents.map((row) => ({ label: row.label, values: callValues(row) }))),
    "",
    ...(extra.length ? [...extra, ""] : []),
    ...(section.unpriced.length > 0 ? [`비용 미산정 모델: ${section.unpriced.join(" · ")} — 단가표에 없어 0 으로 셌습니다.`] : []),
    `비용은 추정치입니다 — ${report.pricesAsOf} 기준 공개 단가표로 계산했고 실제 청구와 다를 수 있습니다.`,
  ];
}

function renderCodex(report: UsageReport, section: UsageSection, retry: string[]): string[] {
  if (section.note) return [...section.note, ...(retry.length ? ["", ...retry] : [])];
  const headers = ["입력", "캐시 입력", "캐시 쓰기", "출력", "추론 출력", ...CALL_HEADERS];
  const values = (row: UsageRow): number[] => { const t = row.tokens as CodexTokens; return [t.input, t.cachedInput, t.cacheWrite, t.output, t.reasoningOutput, ...callValues(row)]; };
  const extra = [...countLines(section), ...(section.fileChanges ? [`파일 변경(FileChange): ${section.fileChanges}회`] : []), ...retry];
  return [
    `Codex 사용량 · ${[report.head, rangeText(section)].join(" · ")}`,
    `기록: ${section.dir} (세션 ${section.sessions} · 하위 에이전트 ${section.subagents}) — codex-cli 0.161.0 의 기록 꼴로 읽습니다(입력은 캐시 입력을 포함합니다)`,
    "",
    ...plainTable("스테이지별", "스테이지", headers, section.stages.map((row) => ({ label: row.label, values: values(row) }))),
    "",
    ...plainTable("에이전트별", "에이전트", headers, section.agents.map((row) => ({ label: row.label, values: values(row) }))),
    "",
    ...(extra.length ? [...extra, ""] : []),
    "Codex 비용은 단가표가 없어 산정하지 않습니다.",
  ];
}

export function usage(repoRoot: string, options: UsageOptions = {}): string {
  const report = usageReport(repoRoot, options);
  const retry = retryBlock(report.retry);
  if (!report.sections.length) return retry.length ? retry.join("\n") : "집계할 호스트 기록이 없습니다.";
  // 재시도 절은 첫 절에 한 번만 싣는다(저장소 기록이라 호스트와 무관하다)
  return report.sections.map((section, index) => (section.source === "claude" ? renderClaude : renderCodex)(report, section, index === 0 ? retry : []).join("\n")).join("\n\n");
}
