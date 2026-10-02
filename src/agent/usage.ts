import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { canonical, readStages } from "./layout";
import type { StageTransition } from "./layout";
import { PRICES_AS_OF, priceOf } from "./prices";
import { Stop } from "./stop";
import { selectedHosts } from "./hosts";

/**
 * `code-agent usage` — 이 저장소에 쓴 토큰을 **스테이지별·에이전트별**로 센다.
 *
 * 세는 것은 Claude Code 가 남긴 기록(`~/.claude/projects/<인코딩한 저장소 경로>/*.jsonl`)이다.
 * 우리가 쓰는 자리가 아니라 **읽는 자리**라, 형식이 흔들려도 명령이 서지 않게 짠다 —
 * 깨진 줄은 그 줄만 버리고, 모르는 필드는 0 으로 보고, 폴더가 없으면 안내하고 끝낸다.
 *
 * 기록에 우리 스테이지는 없다. 있는 것은 시각뿐이라 `.code-agent/log/stages.jsonl`(커서가 움직일 때마다
 * `logStage` 가 남긴다)로 구간을 만들고 메시지의 `timestamp` 를 그 구간에 담는다.
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
}

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
 * `<세션>/subagents/agent-*.jsonl` 이다 — 짝 `.meta.json` 에 `agentType` 이 들어 있다.
 */
function transcripts(dir: string): Transcript[] {
  const found: Transcript[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      found.push({ path: join(dir, entry.name), agent: MAIN_AGENT });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const subagents = join(dir, entry.name, "subagents");
    if (!existsSync(subagents)) continue;
    for (const name of readdirSync(subagents).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      found.push({ path: join(subagents, name), agent: agentTypeOf(join(subagents, name.replace(/\.jsonl$/, ".meta.json"))) });
    }
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

interface RawLine {
  type?: string;
  timestamp?: string;
  requestId?: string;
  message?: { id?: string; model?: string; usage?: RawUsage };
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
function collect(files: Transcript[]): Message[] {
  const byKey = new Map<string, Message>();
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
  return [...byKey.values()].sort((a, b) => a.at.localeCompare(b.at));
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

export function usage(repoRoot: string, options: UsageOptions = {}): string {
  if (!options.transcripts && !selectedHosts(repoRoot).includes("claude")) return "code-agent usage는 Claude 실행 기록을 집계합니다. Codex 토큰·비용은 아직 집계하지 않습니다. Codex의 사용량 화면을 확인하세요.";
  let since: number | undefined;
  if (options.since !== undefined) {
    since = Date.parse(options.since);
    if (Number.isNaN(since)) {
      throw new Stop(`--since 의 날짜를 읽을 수 없습니다: ${options.since} — 2026-09-28 처럼 적으세요.`);
    }
  }

  const dir = options.transcripts ?? transcriptDir(repoRoot);
  if (!existsSync(dir)) {
    return [
      `기록을 찾지 못했습니다: ${dir}`,
      "  이 저장소를 이 경로에서 Claude Code 로 연 적이 없거나, 다른 PC 의 기록입니다.",
    ].join("\n");
  }

  const files = transcripts(dir);
  const stages = readStages(repoRoot);
  const all = collect(files);
  const messages = all.filter((message) => {
    if (since !== undefined && Date.parse(message.at) < since) return false;
    return options.work === undefined || bucketOf(stages, message.at).id === options.work;
  });

  if (messages.length === 0) {
    return [
      `${dir} 에 셀 것이 없습니다.`,
      `  기록 파일 ${files.length}개를 읽었습니다 — ${options.work ? `작업 ${options.work} 의 구간이 없거나 ` : ""}거른 뒤 남은 메시지가 없습니다.`,
    ].join("\n");
  }

  const unpriced = [...new Set(messages.filter((message) => !priceOf(message.model)).map((message) => message.model))].sort();
  const subagents = files.filter((file) => file.agent !== MAIN_AGENT).length;
  const head = [
    ...(options.work ? [options.work] : []),
    repoRoot,
    `${day(messages[0].at)} ~ ${day(messages[messages.length - 1].at)}`,
  ].join(" · ");

  return [
    `Claude Code 사용량 · ${head}`,
    `기록: ${dir} (세션 ${files.length - subagents} · 서브에이전트 ${subagents})`,
    "",
    ...table("스테이지별", "스테이지", group(messages, (message) => bucketOf(stages, message.at).label)),
    ...(stages.length === 0
      ? ["  스테이지 기록이 없습니다 — 이 버전 이전에 시작한 작업이거나 아직 작업을 시작하지 않았습니다."]
      : []),
    "",
    ...table("에이전트별", "에이전트", group(messages, (message) => message.agent)),
    "",
    ...(unpriced.length > 0 ? [`비용 미산정 모델: ${unpriced.join(" · ")} — 단가표에 없어 0 으로 셌습니다.`] : []),
    `비용은 추정치입니다 — ${PRICES_AS_OF} 기준 공개 단가표로 계산했고 실제 청구와 다를 수 있습니다.`,
  ].join("\n");
}
