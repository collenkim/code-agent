import { spawnSync } from "child_process";
import { existsSync, readFileSync, realpathSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { z } from "zod";

import { isBatchScript, quoteForCmd, resolveExecutable } from "../../core/build";
import { packageVersion } from "../assets";
import { MAX_KNOWLEDGE_REFS } from "../master/protocol";
import { CONTEXT_DOCS_PHASES, HANDSHAKE_LIMIT, INDEXED_REFS, PROTOCOL, VERSION } from "./protocol";
import type { DescribeOutput, DocSection, DocsFallback, PinnedResult, ProbeOutput } from "./protocol";
import { storeDir } from "./store";

/**
 * `code-agent plugin agent-knowledge [--config <파일>]` — 로컬 agent-knowledge CLI 를 `context.docs` 자리에 잇는 어댑터.
 *
 * 플러그인 계약(code-agent.plugin v1) 그대로 stdin 요청 한 벌을 받아 stdout 에 응답 봉투 **하나만** 쓴다. 어떤 실패든
 * exit 0 + `ok:false` 봉투다 — 호스트는 그것을 실패로 읽고 기본 검색으로 돈다(봉투 밖의 출력·비정상 종료는 사유가 흐려진다).
 *
 * agent-knowledge 의 **읽기 명령만** 부른다(capabilities·search·get·status). index·eval 같은 쓰기 명령은 부르지 않고 원본 문서도 바꾸지 않는다.
 * 요청 스키마가 엄격해(모르는 키 거부) 이 어댑터는 agent-knowledge 가 이미 아는 필드만 보낸다.
 *
 * 응답 형식은 협의한다(`negotiate`). capabilities 가 search·get 의 형식 2를 알리고 `status --response-version 2` 가 스키마 2 DB 를
 * 확인하면 형식 2(질의 묶음 한 번·문서 필터·출력 예산·색인 식별 고정)로, 아니면 형식 1(질의마다 한 번)로 부른다. 형식 2에서 형식 1로
 * 내려가는 것은 생산자가 형식 2를 모른다고 답한 경우뿐이다 — 해시·색인 식별·세대·커밋·범위 불일치는 같은 근거가 아니라는 답이라
 * 형식 1로 다시 묻지 않는다.
 *
 * 자식 프로세스에는 `AGENT_KNOWLEDGE_*` 환경변수를 넘기지 않는다 — 상속된 값이 설정과 다른 DB·설정 파일을 가리키지 못하게.
 *
 * 결과에는 항목 본문·발췌를 싣지 않는다 — 호스트가 현재 작업 트리 파일을 읽어 내용 해시로 대조한 범위만 쓴다. 어댑터가 넘기는 것은
 * 경로·제목·줄 범위·해시·상태(출처 참조)뿐이다.
 */

export const ADAPTER_NAME = "agent-knowledge";

/** 설정 파일 위치를 바꾸는 환경변수 — `--config` 다음 순서 */
export const CONFIG_ENV = "CODE_AGENT_KNOWLEDGE_CONFIG";

/** 기본 설정 파일 — 등록 스토어와 같은 개인 자리(`<storeDir>/agent-knowledge.json`) */
export const CONFIG_FILE = "agent-knowledge.json";

/** 받는 선택 입력 — describe `accepts` */
export const AGENT_KNOWLEDGE_ACCEPTS = ["context.docs.phase", "context.docs.files", "context.docs.refs", INDEXED_REFS] as const;

/** 생산자 경로를 바꾸는 환경변수의 접두사 — 자식 프로세스 환경에서 지운다(`producerEnv`) */
export const PRODUCER_ENV_PREFIX = "AGENT_KNOWLEDGE_";

/**
 * 한 번의 요청 전체 마감. 호스트의 자리 상한(20초) 안에서 응답 봉투를 쓸 여유를 남긴다 — 마감을 넘기면 남은 질의를 건너뛰고
 * 이미 받은 결과를 쓴다(호스트 상한에 걸려 통째로 실패하는 것보다 낫다).
 */
export const OVERALL_DEADLINE_MS = 15_000;

/** 남은 시간이 이보다 짧으면 호출을 시작하지 않는다 — 프로세스 기동(질의당 약 0.2초)과 검색을 마칠 여유가 없다 */
const MIN_CALL_MS = 1000;

/** probe 의 전체 마감 — 호스트의 handshake 상한(10초)보다 짧게 둬, 넘으면 호스트가 끊기 전에 어댑터가 사유를 담아 답한다 */
const PROBE_DEADLINE_MS = HANDSHAKE_LIMIT.timeoutMs - 2000;

/** agent-knowledge 요청 limit 의 범위(1..50) */
const SEARCH_LIMIT_MAX = 50;

/** 형식 2 `budget.maxResponseBytes` 의 하한(생산자 스키마) */
const RESPONSE_BYTES_MIN = 4096;

/** 형식 2 응답 예산을 출력 상한(maxOutputBytes)보다 이만큼 작게 둔다 — 봉투·여백 때문에 생산자가 자식 출력 상한을 넘지 않게 */
const RESPONSE_BYTES_MARGIN = 65_536;

/** 형식 2 `filters.documents` 의 개수 상한(생산자 스키마) — 넘으면 필터 없이 받아 어댑터가 거른다 */
const DOCUMENT_FILTER_MAX = 256;

/** 질의마다 호스트 limit 의 몇 배를 받는가 — 등록 문서 밖·다른 원본 항목을 거른 뒤에도 limit 을 채우려고 */
const SEARCH_OVERFETCH = 2;

/** 오류 문장 하나의 길이 — 호스트가 다시 200자로 자른다 */
const MESSAGE_CHARS = 160;

const LIMIT_RANGES = {
  timeoutMs: { min: 1000, max: 15_000, fallback: 8000 },
  maxOutputBytes: { min: 65_536, max: 16_777_216, fallback: 8_388_608 },
  maxQueries: { min: 1, max: 8, fallback: 4 },
  queryChars: { min: 50, max: 1000, fallback: 400 },
  maxPaths: { min: 0, max: 200, fallback: 50 },
} as const;

type LimitKey = keyof typeof LIMIT_RANGES;
export type AdapterLimits = Record<LimitKey, number>;

const limitField = (key: LimitKey) => z.number().int().min(LIMIT_RANGES[key].min).max(LIMIT_RANGES[key].max).optional();

/** agent-knowledge 의 원본·프로젝트 ID 규칙 그대로 */
const AK_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 순위 방식·조각 점수 — 생산자 기본(legacy·조각 없음)을 바꾸는 것은 설정에 적은 프로젝트뿐이다 */
const RETRIEVAL_SCHEMA = z.strictObject({
  ranker: z.enum(["legacy", "bm25"]).optional(),
  segments: z.boolean().optional(),
});
export type RetrievalOptions = z.infer<typeof RETRIEVAL_SCHEMA>;

/** 응답 형식 — auto 는 협의, 1 은 형식 1만(capabilities 도 부르지 않는다), 2 는 형식 2만(못 쓰면 오류) */
export type ResponseVersionMode = "auto" | 1 | 2;

/**
 * 어댑터 설정 — 엄격하다(모르는 키 거부). 오타 난 키가 조용히 무시되면 사람은 그 값이 적용된 줄 안다.
 * 상대 경로(command 의 실행 파일·sourcesConfig·retrievalConfig·db·projects[].root)는 **이 설정 파일의 폴더** 기준이다 —
 * 어댑터는 저장소마다 다른 cwd 에서 돌므로 cwd 기준이면 저장소가 실행 파일과 색인을 고르게 된다.
 */
const CONFIG_SCHEMA = z.strictObject({
  schemaVersion: z.literal(1),
  command: z.array(z.string().min(1)).min(1),
  sourcesConfig: z.string().min(1).optional(),
  retrievalConfig: z.string().min(1).optional(),
  db: z.string().min(1).optional(),
  responseVersion: z.union([z.literal("auto"), z.literal(1), z.literal(2)]).optional(),
  retrieval: RETRIEVAL_SCHEMA.optional(),
  projects: z
    .array(
      z.strictObject({
        root: z.string().min(1),
        project: z.string().regex(AK_NAME, "project 는 agent-knowledge 프로젝트 ID 형식입니다"),
        sources: z.array(z.string().regex(AK_NAME, "sources 는 agent-knowledge 원본 ID 형식입니다")).min(1).optional(),
        retrieval: RETRIEVAL_SCHEMA.optional(),
      }),
    )
    .min(1),
  limits: z
    .strictObject({
      timeoutMs: limitField("timeoutMs"),
      maxOutputBytes: limitField("maxOutputBytes"),
      maxQueries: limitField("maxQueries"),
      queryChars: limitField("queryChars"),
      maxPaths: limitField("maxPaths"),
    })
    .optional(),
});

export interface ProjectMapping {
  /** 맞춘 꼴(normalizeRoot) */
  root: string;
  project: string;
  sources?: string[];
  /** 설정 최상위 retrieval 위에 이 프로젝트의 retrieval 을 덮은 값(키마다) — 둘 다 없으면 없음 */
  retrieval?: RetrievalOptions;
}

export interface AdapterConfig {
  path: string;
  dir: string;
  command: string[];
  sourcesConfig?: string;
  retrievalConfig?: string;
  db?: string;
  responseVersion: ResponseVersionMode;
  projects: ProjectMapping[];
  limits: AdapterLimits;
}

/** 어댑터가 내는 실패 — 봉투 error 는 `<code>: <설명>` 꼴이다 */
interface Failure {
  code: string;
  message: string;
}

type Loaded = { ok: true; config: AdapterConfig } | ({ ok: false } & Failure);

const ERROR_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function oneLine(text: string, max = MESSAGE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 저장소 루트를 비교할 꼴로 — 실제 경로(링크·8.3 이름 풀기) · 슬래시 · 끝 슬래시 없음 · Windows 는 소문자.
 * 없는 경로는 글자만 맞춘다.
 */
export function normalizeRoot(path: string, platform: NodeJS.Platform = process.platform): string {
  let full = resolve(path);
  try {
    full = realpathSync.native(full);
  } catch {
    // 없는 경로 — 글자만 맞춘다(대응되지 않을 뿐이다)
  }
  const slashed = full.replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
  return platform === "win32" ? slashed.toLowerCase() : slashed;
}

/** 설정 파일 자리 — `--config` → `CODE_AGENT_KNOWLEDGE_CONFIG` → `<storeDir>/agent-knowledge.json` */
export function configPathOf(explicit: string | undefined, env: NodeJS.ProcessEnv): { path: string; from: string } {
  if (explicit !== undefined) return { path: explicit, from: "--config" };
  const fromEnv = env[CONFIG_ENV];
  if (fromEnv && fromEnv.trim() !== "") return { path: fromEnv, from: CONFIG_ENV };
  return { path: join(storeDir(), CONFIG_FILE), from: "기본 위치" };
}

export function loadAdapterConfig(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): Loaded {
  const { path, from } = configPathOf(explicit, env);
  // 상대 경로는 어댑터가 도는 저장소마다 다른 파일을 가리킨다 — 저장소가 설정(곧 실행 파일)을 고르게 두지 않는다
  if (!isAbsolute(path)) {
    return { ok: false, code: "adapter-config-invalid", message: `${from} 의 설정 파일 경로는 절대 경로로 적습니다: ${path}` };
  }
  if (!existsSync(path)) {
    return { ok: false, code: "adapter-config-missing", message: `어댑터 설정 파일이 없습니다(${from}): ${path}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8").replace(/^﻿/, ""));
  } catch (error) {
    return { ok: false, code: "adapter-config-invalid", message: `어댑터 설정이 JSON 이 아닙니다: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = CONFIG_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      code: "adapter-config-invalid",
      message: `어댑터 설정 형식이 다릅니다: ${issue ? `${issue.path.join(".") || "(root)"} ${issue.message}` : "(사유 없음)"}`,
    };
  }
  const dir = dirname(path);
  const fromDir = (value: string | undefined) => (value === undefined ? undefined : resolve(dir, value));
  const projects = parsed.data.projects.map((entry) => {
    const retrieval = { ...parsed.data.retrieval, ...entry.retrieval };
    return {
      root: normalizeRoot(resolve(dir, entry.root)),
      project: entry.project,
      ...(entry.sources ? { sources: entry.sources } : {}),
      ...(Object.keys(retrieval).length > 0 ? { retrieval } : {}),
    };
  });
  const seen = new Set<string>();
  for (const entry of projects) {
    // 한 저장소가 두 프로젝트로 대응되면 무엇을 검색할지 정해지지 않는다
    if (seen.has(entry.root)) {
      return { ok: false, code: "adapter-config-invalid", message: `projects 에 같은 root 가 두 번 있습니다: ${entry.root}` };
    }
    seen.add(entry.root);
  }
  const limits = Object.fromEntries(
    (Object.keys(LIMIT_RANGES) as LimitKey[]).map((key) => [key, parsed.data.limits?.[key] ?? LIMIT_RANGES[key].fallback]),
  ) as AdapterLimits;
  return {
    ok: true,
    config: {
      path,
      dir,
      command: parsed.data.command,
      ...(parsed.data.sourcesConfig ? { sourcesConfig: fromDir(parsed.data.sourcesConfig) } : {}),
      ...(parsed.data.retrievalConfig ? { retrievalConfig: fromDir(parsed.data.retrievalConfig) } : {}),
      ...(parsed.data.db ? { db: fromDir(parsed.data.db) } : {}),
      responseVersion: parsed.data.responseVersion ?? "auto",
      projects,
      limits,
    },
  };
}

export function mapProject(config: AdapterConfig, root: string): ProjectMapping | undefined {
  const normalized = normalizeRoot(root);
  return config.projects.find((entry) => entry.root === normalized);
}

// ---- 질의 ----

export interface QueryPlan {
  queries: string[];
  /** 공백 정리·같은 글 제거 뒤 남은 요구 항목 수 */
  distinct: number;
  /** 둘 이상의 항목을 이어 붙인 질의 수 */
  bundled: number;
  /** queryChars 를 넘어 잘라 낸 글자 수(코드 포인트) 합 */
  clipped: number;
}

/** 코드 포인트 기준으로 자른다 — 가능하면 공백에서(앞 절반 안에 공백이 없으면 그 자리에서) */
function clip(text: string, max: number): { text: string; clipped: number } {
  const points = [...text];
  if (points.length <= max) return { text, clipped: 0 };
  const head = points.slice(0, max);
  const space = head.lastIndexOf(" ");
  const kept = (space >= Math.floor(max / 2) ? head.slice(0, space) : head).join("").trimEnd();
  return { text: kept, clipped: points.length - [...kept].length };
}

/**
 * 요구 항목 문장 → 검색 질의. 공백을 정리하고 같은 글을 지운 뒤, maxQueries 이하이면 항목마다 하나, 넘으면 순서를 지켜
 * maxQueries 묶음으로 이어 붙인다(뒤 항목을 버리지 않는다). 질의마다 queryChars 이하로 자른다.
 */
export function buildQueries(requirements: readonly { text: string }[], limits: Pick<AdapterLimits, "maxQueries" | "queryChars">): QueryPlan {
  const { groups, distinct } = groupRequirements(requirements, limits.maxQueries);
  let clipped = 0;
  const queries = groups.map((group) => {
    const cut = clip(group.map((entry) => entry.text).join(" "), limits.queryChars);
    clipped += cut.clipped;
    return cut.text;
  });
  return { queries, distinct, bundled: groups.filter((group) => group.length > 1).length, clipped };
}

/** 공백 정리·같은 글 제거(앞의 것을 남긴다) 뒤 maxQueries 이하의 묶음으로 — 넘으면 순서를 지켜 고르게 나눈다 */
function groupRequirements<T extends { text: string }>(requirements: readonly T[], maxQueries: number): { groups: (T & { text: string })[][]; distinct: number } {
  const entries: (T & { text: string })[] = [];
  for (const requirement of requirements) {
    const text = requirement.text.replace(/\s+/g, " ").trim();
    if (text !== "" && !entries.some((entry) => entry.text === text)) entries.push({ ...requirement, text });
  }
  const groups: (T & { text: string })[][] = [];
  if (entries.length <= maxQueries) {
    for (const entry of entries) groups.push([entry]);
  } else {
    for (let index = 0; index < maxQueries; index += 1) {
      const from = Math.floor((index * entries.length) / maxQueries);
      const to = Math.floor(((index + 1) * entries.length) / maxQueries);
      groups.push(entries.slice(from, to));
    }
  }
  return { groups, distinct: entries.length };
}

/** 형식 2 질의 키 규칙(생산자 그대로) */
const QUERY_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;

export type QueryV2 = string | { key: string; text: string };

export interface QueryPlanV2 extends Omit<QueryPlan, "queries"> {
  queries: QueryV2[];
}

/**
 * 요구 항목 → 형식 2 `queries`. 묶음·자르기는 형식 1(`buildQueries`)과 같다. 항목 하나짜리 질의는 요구 키를 질의 키로 쓰고(키 규칙에
 * 맞고 앞에서 쓰지 않았을 때), 아니면 글만 보낸다 — 생산자가 `q<위치>` 를 붙인다. 그 자동 키가 다른 질의의 키와 겹치면
 * `q<위치>-<n>` 을 직접 붙인다(생산자는 키가 겹치면 요청 전체를 거부한다).
 */
export function buildQueriesV2(requirements: readonly { key: string; text: string }[], limits: { maxQueries: number; queryChars: number }): QueryPlanV2 {
  const { groups, distinct } = groupRequirements(requirements, limits.maxQueries);
  let clipped = 0;
  const texts = groups.map((group) => {
    const cut = clip(group.map((entry) => entry.text).join(" "), limits.queryChars);
    clipped += cut.clipped;
    return cut.text;
  });
  const used = new Set<string>();
  const keys = groups.map((group) => {
    const key = group.length === 1 ? group[0].key : undefined;
    if (key === undefined || !QUERY_KEY.test(key) || used.has(key)) return undefined;
    used.add(key);
    return key;
  });
  const queries = texts.map((text, index): QueryV2 => {
    const key = keys[index];
    if (key !== undefined) return { key, text };
    const implicit = `q${index + 1}`;
    if (!used.has(implicit)) {
      used.add(implicit);
      return text;
    }
    let n = 1;
    while (used.has(`${implicit}-${n}`)) n += 1;
    used.add(`${implicit}-${n}`);
    return { key: `${implicit}-${n}`, text };
  });
  return { queries, distinct, bundled: groups.filter((group) => group.length > 1).length, clipped };
}

// ---- agent-knowledge 호출 ----

type Sub = "search" | "get" | "status" | "capabilities";

/** 생산자 응답 형식 번호 */
type ResponseVersion = 1 | 2;

interface Context {
  config: AdapterConfig;
  /** 실행 파일을 찾는 환경(PATH) */
  env: NodeJS.ProcessEnv;
  /** 자식 프로세스 환경 — `AGENT_KNOWLEDGE_*` 를 지운 사본 */
  childEnv: NodeJS.ProcessEnv;
  now: () => number;
  deadline: number;
  calls: number;
}

interface InvokeOptions {
  /** 성공 응답의 schemaVersion 으로 기대하는 형식(기본 1). 오류 봉투는 형식과 상관없이 schemaVersion 1이다 */
  responseVersion?: ResponseVersion;
  /** 공통 옵션 뒤에 붙일 인자(`--response-version 2` 등) */
  flags?: string[];
}

/** 자식 프로세스 환경 — `AGENT_KNOWLEDGE_` 로 시작하는 키(대소문자 무시: Windows 는 환경변수 이름을 가리지 않는다)를 지운 사본 */
export function producerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith(PRODUCER_ENV_PREFIX)));
}

type Called = { ok: true; json: Record<string, unknown>; exit: number } | ({ ok: false; detail?: Record<string, unknown> } & Failure);

/** 오류 출력의 마지막 의미 있는 줄 — Node 가 끝에 붙이는 버전 줄(`Node.js v…`)은 원인이 아니라 건너뛴다 */
function lastLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !/^Node\.js v\d/.test(line));
  return lines[lines.length - 1] ?? "";
}

function commonOptions(config: AdapterConfig): string[] {
  return [
    ...(config.sourcesConfig ? ["--config", config.sourcesConfig] : []),
    ...(config.retrievalConfig ? ["--retrieval-config", config.retrievalConfig] : []),
    ...(config.db ? ["--db", config.db] : []),
  ];
}

const ERROR_ENVELOPE = z.object({
  error: z.object({ code: z.string(), message: z.string().optional(), detail: z.unknown().optional() }),
});

/**
 * agent-knowledge 한 번. 셸 없이 돌리고(`.cmd` 는 cmd.exe 에 한 줄로) 호출마다 제한 시간·출력 상한을 건다. 요청 본문은 stdin 으로만
 * 보낸다(`--request -`) — 질의 문장이 argv(프로세스 목록)에 보이지 않는다.
 */
function invoke(ctx: Context, sub: Sub, body?: Record<string, unknown>, invokeOptions: InvokeOptions = {}): Called {
  const left = ctx.deadline - ctx.now();
  if (left < MIN_CALL_MS) {
    return { ok: false, code: "timeout", message: `전체 마감 ${OVERALL_DEADLINE_MS / 1000}초에 닿아 agent-knowledge ${sub} 를 부르지 않았습니다`, detail: { deadline: true } };
  }
  const timeout = Math.min(ctx.config.limits.timeoutMs, left);
  const maxBytes = ctx.config.limits.maxOutputBytes;
  const [name, ...prefix] = ctx.config.command;
  // 저장소가 실행 파일을 고르지 못하게 PATH 만 본다(경로를 적었으면 설정 파일 폴더 기준)
  const file = resolveExecutable(ctx.config.dir, name, ctx.env, { skipLocal: true });
  if (!file) return { ok: false, code: "not-installed", message: `agent-knowledge 실행 파일을 찾을 수 없습니다: ${name}` };
  const args = [...prefix, sub, ...commonOptions(ctx.config), ...(invokeOptions.flags ?? []), ...(body ? ["--request", "-"] : [])];
  ctx.calls += 1;
  const options = {
    cwd: ctx.config.dir,
    env: ctx.childEnv,
    input: body ? JSON.stringify(body) : "",
    encoding: "utf-8" as const,
    timeout,
    maxBuffer: maxBytes,
    windowsHide: true,
  };
  const result = isBatchScript(file)
    ? spawnSync(ctx.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[file, ...args].map(quoteForCmd).join(" ")}"`], { ...options, windowsVerbatimArguments: true })
    : spawnSync(file, args, options);
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const stdout = result.stdout ?? "";
  // 상한 초과를 제한 시간보다 먼저 본다 — 둘 다 신호로 끝나 signal 만으로는 갈라지지 않는다
  if (code === "ENOBUFS" || Buffer.byteLength(stdout, "utf-8") > maxBytes) {
    return { ok: false, code: "output-too-large", message: `agent-knowledge ${sub} 응답이 상한 ${Math.round(maxBytes / 1024)} KiB 를 넘었습니다` };
  }
  if (code === "ETIMEDOUT" || (result.error && result.signal !== null)) {
    // 전체 마감 때문에 줄인 제한 시간에 걸렸으면 마감이다 — 앞 질의에서 받은 결과는 쓴다(searchDocs)
    const deadline = timeout < ctx.config.limits.timeoutMs;
    return {
      ok: false,
      code: "timeout",
      message: `agent-knowledge ${sub} 가 제한 시간 ${timeout / 1000}초를 넘겨 중단했습니다${deadline ? ` (전체 마감 ${OVERALL_DEADLINE_MS / 1000}초)` : ""}`,
      ...(deadline ? { detail: { deadline: true } } : {}),
    };
  }
  if (code === "ENOENT") return { ok: false, code: "not-installed", message: `agent-knowledge 를 실행하지 못했습니다: ${name}` };
  if (result.error) return { ok: false, code: "spawn-failed", message: `agent-knowledge ${sub} 를 실행하지 못했습니다: ${result.error.message}` };
  // 실행 파일(node)은 있는데 설정이 가리킨 agent-knowledge 스크립트가 없다 — 응답 형식이 아니라 설치 문제다
  if (result.status !== 0 && stdout.trim() === "" && /\bCannot find module\b|\bMODULE_NOT_FOUND\b/.test(result.stderr ?? "")) {
    return { ok: false, code: "not-installed", message: `agent-knowledge 를 실행하지 못했습니다(모듈을 찾을 수 없음): ${ctx.config.command.join(" ")}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    const tail = lastLine(result.stderr ?? "");
    return { ok: false, code: "invalid-json", message: `agent-knowledge ${sub} 응답이 JSON 이 아닙니다 (exit ${result.status}${tail ? ` · ${tail}` : ""})` };
  }
  if (!isRecord(json)) return { ok: false, code: "invalid-response", message: `agent-knowledge ${sub} 응답이 객체가 아닙니다` };
  if (json.schema === "agent-knowledge.error") {
    if (json.schemaVersion !== 1) {
      return { ok: false, code: "unsupported-version", message: `agent-knowledge 오류 봉투 schemaVersion ${JSON.stringify(json.schemaVersion)} 은 이 어댑터가 아는 버전이 아닙니다 (1)` };
    }
    const envelope = ERROR_ENVELOPE.safeParse(json);
    if (!envelope.success) return { ok: false, code: "invalid-response", message: `agent-knowledge ${sub} 오류 봉투의 구조가 다릅니다` };
    const { error } = envelope.data;
    const detail = isRecord(error.detail) ? error.detail : undefined;
    const reason = typeof detail?.reason === "string" ? ` (${detail.reason})` : "";
    return {
      ok: false,
      code: ERROR_CODE.test(error.code) ? error.code : "agent-knowledge-error",
      message: `agent-knowledge ${sub} 오류 — ${error.message ?? error.code}${reason}`,
      ...(detail ? { detail } : {}),
    };
  }
  const expected = invokeOptions.responseVersion ?? 1;
  if (json.schema !== `agent-knowledge.${sub}` || json.schemaVersion !== expected) {
    return {
      ok: false,
      code: "unsupported-version",
      message: `agent-knowledge ${sub} 응답 형식 ${JSON.stringify(json.schema)} v${JSON.stringify(json.schemaVersion)} 은 이 어댑터가 아는 형식이 아닙니다 (agent-knowledge.${sub} v${expected})`,
    };
  }
  // search 의 결과 없음(3)만 정상 종료로 본다 — 다른 0 아닌 종료는 오류 봉투로 왔어야 한다
  if (result.status !== 0 && !(sub === "search" && result.status === 3)) {
    return { ok: false, code: "invalid-response", message: `agent-knowledge ${sub} 가 오류 봉투 없이 exit ${result.status} 로 끝났습니다` };
  }
  return { ok: true, json, exit: result.status ?? 0 };
}

// ---- 응답 구조 ----

/** 커밋·blob SHA — 저장소 해시 방식에 따라 40자리(SHA-1) 또는 64자리(SHA-256) */
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** 생산자 DB 식별(`indexId`) */
const INDEX_ID = /^[0-9a-f]{32}$/;

export const KNOWLEDGE_STATUSES = ["confirmed_policy", "observed_behavior", "verified_experience", "unverified", "deprecated", "conflicted"] as const;
const UNITS = ["document", "section", "entry"] as const;

/** 직접 검색 결과의 이유 — 필수 지정·의존·연결은 직접 결과가 아니다(필수 정책은 호스트가 따로 붙인다) */
const DIRECT_REASONS = ["explicit-key", "path-overlap", "keyword-match"] as const;

const INDEX_SCHEMA = z.object({
  generation: z.number().int().min(1),
  parserVersion: z.string(),
  chunkerVersion: z.string(),
  tokenizerVersion: z.string(),
  resolverVersion: z.string(),
  sources: z.array(z.object({ sourceId: z.string(), projectId: z.string(), commit: z.string() })),
});
type IndexInfo = z.infer<typeof INDEX_SCHEMA>;

const SEARCH_SCHEMA = z.object({
  ok: z.literal(true),
  status: z.enum(["ok", "no-results"]),
  index: INDEX_SCHEMA,
  retrieval: z.object({ directCount: z.number().int().min(0) }),
  items: z.array(z.unknown()),
  limitations: z.array(z.object({ code: z.string() })).optional(),
});

const GET_SCHEMA = z.object({
  ok: z.literal(true),
  index: INDEX_SCHEMA,
  item: z.unknown(),
  limitations: z.array(z.object({ code: z.string() })).optional(),
});

// ---- 형식 2 응답 구조 — 쓰는 필드만 본다(같은 형식 안에서 생산자가 필드를 더하는 것은 호환 변경이다) ----

const CAPABILITIES_SCHEMA = z.object({
  ok: z.literal(true),
  commands: z.record(z.string(), z.unknown()),
  rankers: z.array(z.object({ name: z.string(), version: z.string() })).optional(),
  segments: z.object({ maxChars: z.number().int().optional(), defaultEnabled: z.boolean().optional() }).optional(),
  queryLimits: z.object({ maxQueries: z.number().int().min(1), maxQueryChars: z.number().int().min(1) }).optional(),
  profiles: z.record(z.string(), z.object({ configHash: z.string() })).optional(),
});

const COMMAND_VERSIONS = z.object({ responseVersions: z.array(z.number().int()) });

const STATUS_V2_SCHEMA = z.object({
  ok: z.literal(true),
  indexId: z.string().regex(INDEX_ID).nullable(),
  // 활성화한 세대가 아직 없는 DB(`index --no-activate` 로만 게시)면 null
  activeGeneration: z.number().int().min(1).nullable(),
  databaseSchemaVersion: z.number().int(),
});

const INDEX_V2_SCHEMA = INDEX_SCHEMA.extend({ indexId: z.string().regex(INDEX_ID).nullable() });
type IndexInfoV2 = z.infer<typeof INDEX_V2_SCHEMA>;

const SEARCH_V2_SCHEMA = z.object({
  ok: z.literal(true),
  status: z.enum(["ok", "no-results"]),
  index: INDEX_V2_SCHEMA,
  retrieval: z.object({
    directCount: z.number().int().min(0),
    outcome: z.enum(["matched", "supplementary-only", "no-results"]),
    ranker: z.object({ name: z.string(), version: z.string() }),
    queryVersion: z.string(),
    configHash: z.string(),
    segments: z.object({ requested: z.boolean(), effective: z.boolean() }).optional(),
  }),
  items: z.array(z.unknown()),
  budget: z.object({ truncated: z.boolean(), exceeded: z.boolean().optional(), omittedCount: z.number().int().min(0) }),
  digests: z.object({ request: z.string(), items: z.string().optional(), result: z.string() }),
  limitations: z.array(z.object({ code: z.string() })).optional(),
});

const GET_V2_SCHEMA = z.object({
  ok: z.literal(true),
  index: INDEX_V2_SCHEMA,
  item: z.unknown(),
});

/** 형식 2 항목 참조(`items[].ref`) — 생산자 필드 이름 그대로 */
const ITEM_REF_V2_SCHEMA = z.object({
  handle: z.string().min(1).max(64),
  indexId: z.string().regex(INDEX_ID).nullable(),
  indexGeneration: z.number().int().min(1),
  sourceId: z.string(),
  projectId: z.string(),
  commit: z.string(),
  itemId: z.string(),
  itemSha256: z.string(),
  documentSha256: z.string(),
  blobSha: z.string(),
  path: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  segmentId: z.string().min(1).nullable(),
  segmentSha256: z.string().nullable(),
  segmentStartLine: z.number().int().nullable(),
  segmentEndLine: z.number().int().nullable(),
});

const SEGMENT_V2_SCHEMA = z.object({ id: z.string().min(1), startLine: z.number().int(), endLine: z.number().int(), sha256: z.string() });

const STATUS_SCHEMA = z.object({
  ok: z.literal(true),
  activeGeneration: z.number().int().min(1),
  sources: z.array(z.object({ sourceId: z.string(), projectId: z.string(), commit: z.string().nullable() })),
});

const SELECTION_SCHEMA = z.object({ section: z.string(), rank: z.number().optional(), reasons: z.array(z.string()) });

const ITEM_SCHEMA = z.object({
  id: z.string().min(1),
  key: z.string().nullable().optional(),
  projectId: z.string(),
  sourceId: z.string(),
  kind: z.string().min(1),
  unit: z.enum(UNITS),
  title: z.string(),
  provenance: z.object({
    path: z.string(),
    startLine: z.number().int(),
    endLine: z.number().int(),
    commit: z.string(),
    blobSha: z.string(),
    documentSha256: z.string(),
    itemSha256: z.string(),
    generation: z.number().int(),
  }),
  knowledge: z.object({
    status: z.enum(KNOWLEDGE_STATUSES),
    confirmed: z.boolean(),
    declaredStatus: z.string().nullable(),
    reason: z.string().optional(),
  }),
});
type Item = z.infer<typeof ITEM_SCHEMA>;

/** 형식 2 항목 — 형식 1 필드에 묶음(`group`)·조각(`segment`)·참조(`ref`)를 더한다 */
const ITEM_V2_SCHEMA = ITEM_SCHEMA.extend({ group: z.string(), segment: SEGMENT_V2_SCHEMA.nullable(), ref: ITEM_REF_V2_SCHEMA });
type ItemV2 = z.infer<typeof ITEM_V2_SCHEMA>;

/** 섹션 출처 참조 — agent-knowledge 항목 필드 이름 그대로. 호스트(knowledgeRefs.ts)가 같은 모양을 엄격히 검사한다(모르는 키 거부) */
export interface DocSectionRef {
  engine: "agent-knowledge";
  itemId: string;
  projectId: string;
  sourceId: string;
  generation: number;
  commit: string;
  blobSha: string;
  documentSha256: string;
  itemSha256: string;
  startLine: number;
  endLine: number;
  unit: (typeof UNITS)[number];
  kind: string;
  status: (typeof KNOWLEDGE_STATUSES)[number];
  confirmed: boolean;
  declaredStatus: string | null;
  reason?: string;
  pinned?: boolean;
  /** 형식 2 — DB 식별(스키마 2 이전 DB 면 null). 형식 1 결과에는 없다 */
  indexId?: string | null;
  /** 형식 2 — 인용용 짧은 이름(대조에는 쓰지 않는다) */
  handle?: string;
  /** 형식 2 — 결과가 조각을 가리킬 때만: 조각 식별·내용 해시·줄 범위(항목 범위 안) */
  segmentId?: string;
  segmentSha256?: string;
  segmentStartLine?: number;
  segmentEndLine?: number;
}

/** 작업 파일 하나를 agent-knowledge `task.paths` 꼴로 — 역슬래시·앞 `./`·끝 `/` 를 맞추고, 저장소 기준 상대 경로가 아니면 undefined */
function taskPath(file: string): string | undefined {
  const path = file.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  return safeRelative(path) ? path : undefined;
}

/** 저장소 기준 상대 경로만 — 절대·`..`·`\`·빈 마디는 원격 결과가 저장소 밖을 가리키는 길이다 */
function safeRelative(path: string): boolean {
  return (
    path !== "" &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:/.test(path) &&
    !/[\u0000-\u001f]/.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

type Verdict = { ok: true; item: Item } | { ok: false; drop: DropReason };

type DropReason = "otherProject" | "outOfDocs" | "invalid" | "deprecated";

interface Scope {
  project: string;
  sources?: string[];
  docs: Set<string>;
}

/** 항목 하나를 이 저장소·이 세대·이번 문서 목록과 대조한다 — 형식·일관성이 어긋나면 쓰지 않는다 */
function checkItem(raw: unknown, index: IndexInfo, scope: Scope): Verdict {
  const parsed = ITEM_SCHEMA.safeParse(raw);
  if (!parsed.success) return { ok: false, drop: "invalid" };
  return checkParsed(parsed.data, index, scope);
}

/** checkItem 의 대조 — `consistentToo` 는 형식별로 더 볼 일관성(형식 2 참조) */
function checkParsed<T extends Item>(item: T, index: IndexInfo, scope: Scope, consistentToo: (item: T) => boolean = () => true): { ok: true; item: T } | { ok: false; drop: DropReason } {
  if (item.projectId !== scope.project || (scope.sources && !scope.sources.includes(item.sourceId))) return { ok: false, drop: "otherProject" };
  const p = item.provenance;
  if (!safeRelative(p.path)) return { ok: false, drop: "invalid" };
  if (!scope.docs.has(p.path)) return { ok: false, drop: "outOfDocs" };
  const source = index.sources.find((entry) => entry.sourceId === item.sourceId);
  const consistent =
    item.id.startsWith(`${item.sourceId}:${p.path}#`) &&
    p.generation === index.generation &&
    source !== undefined &&
    source.projectId === item.projectId &&
    source.commit === p.commit &&
    GIT_SHA.test(p.commit) &&
    GIT_SHA.test(p.blobSha) &&
    HEX64.test(p.documentSha256) &&
    HEX64.test(p.itemSha256) &&
    p.startLine >= 1 &&
    p.startLine <= p.endLine;
  if (!consistent || !consistentToo(item)) return { ok: false, drop: "invalid" };
  if (item.knowledge.status === "deprecated") return { ok: false, drop: "deprecated" };
  return { ok: true, item };
}

/**
 * 형식 2 항목의 `ref` 가 항목·응답 색인과 같은 근거를 가리키는가 — 항목 ID·DB 식별·세대·원본·커밋·해시·범위가 모두 같고, 조각이면
 * 조각 식별(`<itemId>#…`)·해시·줄 범위(항목 범위 안)가 `segment` 와 같다. 조각은 조각 점수를 켠 요청(`segmentsAllowed`)에서만 받는다.
 */
function consistentV2(item: ItemV2, index: IndexInfoV2, segmentsAllowed: boolean): boolean {
  const r = item.ref;
  const p = item.provenance;
  const same =
    r.itemId === item.id &&
    r.indexId === index.indexId &&
    r.indexGeneration === index.generation &&
    r.sourceId === item.sourceId &&
    r.projectId === item.projectId &&
    r.commit === p.commit &&
    r.itemSha256 === p.itemSha256 &&
    r.documentSha256 === p.documentSha256 &&
    r.blobSha === p.blobSha &&
    r.path === p.path &&
    r.startLine === p.startLine &&
    r.endLine === p.endLine;
  if (!same) return false;
  if (r.segmentId === null) return item.segment === null && r.segmentSha256 === null && r.segmentStartLine === null && r.segmentEndLine === null;
  const s = item.segment;
  return (
    segmentsAllowed &&
    s !== null &&
    s.id === r.segmentId &&
    s.sha256 === r.segmentSha256 &&
    s.startLine === r.segmentStartLine &&
    s.endLine === r.segmentEndLine &&
    r.segmentId.startsWith(`${item.id}#`) &&
    HEX64.test(s.sha256) &&
    p.startLine <= s.startLine &&
    s.startLine <= s.endLine &&
    s.endLine <= p.endLine
  );
}

/** 형식 2 항목의 섹션 참조 — 형식 1 필드에 DB 식별·핸들, 조각이면 조각 필드를 더한다 */
function refOfV2(item: ItemV2, pinned?: boolean): DocSectionRef {
  const r = item.ref;
  return {
    ...refOf(item, pinned),
    indexId: r.indexId,
    handle: r.handle,
    ...(r.segmentId !== null && r.segmentSha256 !== null && r.segmentStartLine !== null && r.segmentEndLine !== null
      ? { segmentId: r.segmentId, segmentSha256: r.segmentSha256, segmentStartLine: r.segmentStartLine, segmentEndLine: r.segmentEndLine }
      : {}),
  };
}

function refOf(item: Item, pinned?: boolean): DocSectionRef {
  const p = item.provenance;
  return {
    engine: "agent-knowledge",
    itemId: item.id,
    projectId: item.projectId,
    sourceId: item.sourceId,
    generation: p.generation,
    commit: p.commit,
    blobSha: p.blobSha,
    documentSha256: p.documentSha256,
    itemSha256: p.itemSha256,
    startLine: p.startLine,
    endLine: p.endLine,
    unit: item.unit,
    kind: item.kind,
    status: item.knowledge.status,
    confirmed: item.knowledge.confirmed,
    declaredStatus: item.knowledge.declaredStatus,
    ...(item.knowledge.reason !== undefined ? { reason: item.knowledge.reason } : {}),
    ...(pinned ? { pinned: true } : {}),
  };
}

function headingOf(item: Item): string {
  const title = item.title.replace(/\s+/g, " ").trim();
  return item.key ? `\`${item.key}\` ${title}` : title;
}

function sectionOf(item: Item, why: string, pinned?: boolean): DocSection {
  return { path: item.provenance.path, heading: headingOf(item), why, ref: refOf(item, pinned) };
}

function sectionOfV2(item: ItemV2, why: string, pinned?: boolean): DocSection {
  return { path: item.provenance.path, heading: headingOf(item), why, ref: refOfV2(item, pinned) };
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
}

// ---- 요청 봉투 ----

const REQUEST_SCHEMA = z.object({
  protocol: z.string(),
  version: z.string(),
  op: z.string(),
  requestId: z.string(),
  repoRoot: z.string().optional(),
  slot: z.string().optional(),
  input: z.unknown().optional(),
});

const RUN_INPUT = z.object({
  requirements: z.array(z.object({ key: z.string(), text: z.string() })),
  docs: z.array(z.object({ kind: z.string(), path: z.string() })),
  limit: z.number().int().min(1),
  phase: z.string().optional(),
  files: z.array(z.string()).optional(),
  refs: z.array(z.unknown()).optional(),
});
type RunInput = z.infer<typeof RUN_INPUT>;

/**
 * 인계 참조(protocol.ts `KnowledgeRef`) — 형식 1의 다섯 필드에, 등록이 `context.docs.refs.indexed` 를 협의했으면 색인 식별·원본 범위·
 * 조각 식별이 더해진다. 조각 식별은 해시와 함께여야 하고(`<itemId>#…`), 원본은 itemId 의 접두사와 같아야 한다.
 */
const REF_SCHEMA = z
  .object({
    itemId: z.string().min(1),
    generation: z.number().int().min(1),
    commit: z.string().regex(GIT_SHA),
    itemSha256: z.string().regex(HEX64),
    required: z.boolean(),
    indexId: z.string().regex(INDEX_ID).optional(),
    sourceId: z.string().regex(AK_NAME).optional(),
    path: z.string().min(1).optional(),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    segmentId: z.string().min(1).optional(),
    segmentSha256: z.string().regex(HEX64).optional(),
    segmentStartLine: z.number().int().min(1).optional(),
    segmentEndLine: z.number().int().min(1).optional(),
  })
  .refine((ref) => ref.sourceId === undefined || ref.itemId.startsWith(`${ref.sourceId}:`))
  .refine((ref) => ref.startLine === undefined || ref.endLine === undefined || ref.startLine <= ref.endLine)
  .refine((ref) =>
    ref.segmentId === undefined
      ? ref.segmentSha256 === undefined && ref.segmentStartLine === undefined && ref.segmentEndLine === undefined
      : ref.segmentSha256 !== undefined && ref.segmentId.startsWith(`${ref.itemId}#`),
  );
type Ref = z.infer<typeof REF_SCHEMA>;

export interface AdapterOptions {
  /** `plugin agent-knowledge` 뒤의 인자 */
  args: string[];
  /** probe 가 대응을 볼 저장소 루트(실행 위치) */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** 시험용 — 시계와 전체 마감을 바꾼다 */
  now?: () => number;
  deadlineMs?: number;
}

function envelope(requestId: string, body: { ok: true; output: unknown } | { ok: false; error: string; diagnostics?: Record<string, unknown> }): string {
  return JSON.stringify({ protocol: PROTOCOL, version: VERSION, requestId, ...body });
}

function failed(requestId: string, failure: Failure, diagnostics?: Record<string, unknown>): string {
  return envelope(requestId, { ok: false, error: `${failure.code}: ${oneLine(failure.message)}`, ...(diagnostics ? { diagnostics } : {}) });
}

/** `--config <파일>` 하나만 받는다 */
function parseArgs(args: string[]): { ok: true; config?: string } | ({ ok: false } & Failure) {
  const usage = "사용법: code-agent plugin agent-knowledge [--config <파일>] (stdin 요청 → stdout 응답)";
  if (args.length === 0) return { ok: true };
  if (args.length === 2 && args[0] === "--config" && args[1] !== "" && !args[1].startsWith("--")) return { ok: true, config: args[1] };
  return { ok: false, code: "usage", message: usage };
}

export function describeOutput(): DescribeOutput {
  return {
    name: ADAPTER_NAME,
    adapterVersion: packageVersion(),
    slots: ["context.docs"],
    sendsCode: false,
    accepts: [...AGENT_KNOWLEDGE_ACCEPTS],
    note: "로컬 agent-knowledge CLI 읽기 전용(capabilities·search·get·status) — 색인·DB 쓰기 없음",
  };
}

/**
 * 요청 한 벌 → 응답 봉투 한 줄. 던지지 않는다 — 예상하지 못한 예외도 `ok:false` 봉투가 된다.
 */
export function agentKnowledgeAdapter(stdin: string, options: AdapterOptions): string {
  let requestId = "";
  try {
    let raw: unknown;
    try {
      raw = JSON.parse(stdin);
    } catch {
      return failed("", { code: "invalid-request", message: "요청이 JSON 이 아닙니다" });
    }
    const request = REQUEST_SCHEMA.safeParse(raw);
    if (!request.success) {
      if (isRecord(raw) && typeof raw.requestId === "string") requestId = raw.requestId;
      return failed(requestId, { code: "invalid-request", message: "요청 봉투가 계약과 다릅니다 (protocol·version·op·requestId)" });
    }
    requestId = request.data.requestId;
    if (request.data.protocol !== PROTOCOL || request.data.version !== VERSION) {
      return failed(requestId, {
        code: "invalid-request",
        message: `요청 protocol·version 이 ${JSON.stringify(request.data.protocol)} ${JSON.stringify(request.data.version)} 입니다 (${PROTOCOL} ${VERSION})`,
      });
    }
    const args = parseArgs(options.args);
    if (!args.ok) return failed(requestId, args);
    const env = options.env ?? process.env;
    switch (request.data.op) {
      case "describe":
        return envelope(requestId, { ok: true, output: describeOutput() });
      case "probe":
        return envelope(requestId, { ok: true, output: probe(args.config, env, options) });
      case "run": {
        if (request.data.slot !== "context.docs") {
          return failed(requestId, { code: "unsupported-slot", message: `이 어댑터는 context.docs 만 채웁니다: ${request.data.slot ?? "(없음)"}` });
        }
        return run(requestId, request.data.repoRoot, request.data.input, args.config, env, options);
      }
      default:
        return failed(requestId, { code: "unsupported-op", message: `모르는 op 입니다: ${request.data.op}` });
    }
  } catch (error) {
    return failed(requestId, { code: "adapter-error", message: error instanceof Error ? error.message : String(error) });
  }
}

function contextOf(config: AdapterConfig, env: NodeJS.ProcessEnv, options: AdapterOptions): Context {
  const now = options.now ?? Date.now;
  return { config, env, childEnv: producerEnv(env), now, deadline: now() + (options.deadlineMs ?? OVERALL_DEADLINE_MS), calls: 0 };
}

// ---- probe ----

function probe(explicit: string | undefined, env: NodeJS.ProcessEnv, options: AdapterOptions): ProbeOutput {
  const loaded = loadAdapterConfig(explicit, env);
  if (!loaded.ok) return { ready: false, detail: `${loaded.code}: ${oneLine(loaded.message)}` };
  const ctx = contextOf(loaded.config, env, { ...options, deadlineMs: options.deadlineMs ?? PROBE_DEADLINE_MS });
  const called = invoke(ctx, "status");
  if (!called.ok) return { ready: false, detail: `${called.code}: ${oneLine(called.message)}` };
  const status = STATUS_SCHEMA.safeParse(called.json);
  if (!status.success) return { ready: false, detail: "invalid-response: agent-knowledge status 응답 구조가 다릅니다" };
  const generation = status.data.activeGeneration;
  const mapping = mapProject(loaded.config, options.cwd);
  if (!mapping) {
    return {
      ready: true,
      detail: `agent-knowledge 활성 세대 ${generation} · 실행 위치의 저장소는 설정 projects 에 없습니다 — 대응된 저장소에서만 결과를 냅니다 · 읽기 전용(capabilities·search·get·status)`,
    };
  }
  const indexed = status.data.sources.filter(
    (source) => source.projectId === mapping.project && source.commit !== null && (!mapping.sources || mapping.sources.includes(source.sourceId)),
  );
  if (indexed.length === 0) {
    return {
      ready: false,
      detail: `project-not-indexed: 프로젝트 ${mapping.project} 가 활성 세대 ${generation} 색인에 없습니다 — agent-knowledge index 를 먼저 돌리세요`,
    };
  }
  return {
    ready: true,
    detail: `agent-knowledge 활성 세대 ${generation} · 이 저장소 → 프로젝트 ${mapping.project} (원본 ${indexed.length}개 색인됨) · 읽기 전용(capabilities·search·get·status)`,
  };
}

// ---- run ----

interface Dropped {
  mandatory: Set<string>;
  linked: Set<string>;
  otherProject: Set<string>;
  outOfDocs: Set<string>;
  invalid: Set<string>;
  deprecated: Set<string>;
}

interface Candidate {
  item: Item;
  score: number;
  reasons: Set<string>;
}

interface SearchOutcome {
  sections: DocSection[];
  fallback?: DocsFallback;
  error?: Failure;
}

/** 협의한 형식 2 정보 — capabilities 와 `status --response-version 2` 에서 */
interface V2Info {
  indexId: string | null;
  activeGeneration: number | null;
  databaseSchemaVersion: number;
  /** capabilities 가 알린 순위 방식 이름 — 없으면 순위 방식을 보내지 않는다 */
  rankers: string[];
  /** capabilities 가 조각 점수를 알렸는가 */
  segments: boolean;
  queryLimits?: { maxQueries: number; maxQueryChars: number };
}

/** 이번 run 의 응답 형식 — 형식 2로 시작했다가 생산자가 형식 2를 모른다고 답하면 형식 1로 내려간다(`downgrade`) */
interface Wire {
  mode: ResponseVersionMode;
  version: ResponseVersion;
  v2?: V2Info;
  /** 형식 2에서 내려왔으면 그 사유 */
  fallbackFrom?: { responseVersion: 2; reason: string };
  retrieval: RetrievalOptions;
  /** 설정에 적었지만 이번 요청에 싣지 못한 기능(형식 1이거나 생산자가 알리지 않았다) */
  featuresDropped: Set<string>;
}

/**
 * 형식 1로 내려가도 되는 생산자 답(`code` → `detail.reason`) — 형식 2를 모르거나 DB 가 스키마 2 이전인 경우뿐이다. 해시·색인 식별·세대·
 * 커밋 불일치, 없음, 범위 오류는 같은 근거가 아니라는 답이라 형식 1로 다시 묻지 않는다.
 */
const DOWNGRADE_REASONS: Record<string, readonly string[]> = {
  "invalid-request": ["unsupported-response-version", "response-version-2-required"],
  "index-missing": ["schema-upgrade-required"],
};

function downgradeReason(called: Failure & { detail?: Record<string, unknown> }): string | undefined {
  const reason = called.detail?.reason;
  return typeof reason === "string" && DOWNGRADE_REASONS[called.code]?.includes(reason) ? reason : undefined;
}

/** 형식 2를 쓸 수 없다 — auto 면 형식 1로 내려가고(undefined), 설정이 2면 실패를 돌려준다 */
function downgrade(wire: Wire, reason: string): Failure | undefined {
  if (wire.mode === 2) {
    return { code: "response-version-unavailable", message: `agent-knowledge 형식 2를 쓸 수 없습니다 (${reason}) — 어댑터 설정 responseVersion 이 2입니다` };
  }
  wire.version = 1;
  delete wire.v2;
  wire.fallbackFrom ??= { responseVersion: 2, reason };
  return undefined;
}

/**
 * 응답 형식 협의 — responseVersion 1 이면 부르지 않는다. capabilities 가 없거나(`usage`, 이 기능 이전 빌드) search·get·status 의 형식 2를
 * 알리지 않거나, `status --response-version 2` 가 스키마 2 이전 DB(`schema-upgrade-required`)라고 답하면 형식 1(auto) 또는 실패(2)다.
 * 그 밖의 실패(설치·마감·응답 형식)는 그대로 실패다 — 형식 1로도 같은 생산자를 부른다.
 */
function negotiate(ctx: Context, wire: Wire): Failure | undefined {
  if (wire.mode === 1) return undefined;
  const capabilities = invoke(ctx, "capabilities");
  if (!capabilities.ok) {
    if (capabilities.code === "usage") return downgrade(wire, "capabilities-missing");
    return { code: sanitizedCode(capabilities.code), message: capabilities.message };
  }
  const caps = CAPABILITIES_SCHEMA.safeParse(capabilities.json);
  if (!caps.success) return { code: "invalid-response", message: "agent-knowledge capabilities 응답 구조가 다릅니다" };
  const offersV2 = (command: string) => {
    const parsed = COMMAND_VERSIONS.safeParse(caps.data.commands[command]);
    return parsed.success && parsed.data.responseVersions.includes(2);
  };
  if (!["search", "get", "status"].every(offersV2)) return downgrade(wire, "response-version-2-not-offered");
  const status = invoke(ctx, "status", undefined, { responseVersion: 2, flags: ["--response-version", "2"] });
  if (!status.ok) {
    const reason = downgradeReason(status);
    if (reason) return downgrade(wire, reason);
    return { code: sanitizedCode(status.code), message: status.message };
  }
  const parsed = STATUS_V2_SCHEMA.safeParse(status.json);
  if (!parsed.success) return { code: "invalid-response", message: "agent-knowledge status 형식 2 응답 구조가 다릅니다" };
  wire.version = 2;
  wire.v2 = {
    indexId: parsed.data.indexId,
    activeGeneration: parsed.data.activeGeneration,
    databaseSchemaVersion: parsed.data.databaseSchemaVersion,
    rankers: (caps.data.rankers ?? []).map((ranker) => ranker.name),
    segments: caps.data.segments !== undefined,
    ...(caps.data.queryLimits ? { queryLimits: { maxQueries: caps.data.queryLimits.maxQueries, maxQueryChars: caps.data.queryLimits.maxQueryChars } } : {}),
  };
  return undefined;
}

/** 형식 2 요청에 싣는 순위 방식·조각 점수 — 설정에 적고 생산자가 알린 것만. 못 싣는 기본값 밖의 값은 featuresDropped 에 남긴다 */
function requestFeatures(wire: Wire): { ranker?: "legacy" | "bm25"; segments?: boolean } {
  const { ranker, segments } = wire.retrieval;
  const out: { ranker?: "legacy" | "bm25"; segments?: boolean } = {};
  if (ranker !== undefined) {
    if (wire.v2?.rankers.includes(ranker)) out.ranker = ranker;
    else if (ranker !== "legacy") wire.featuresDropped.add("ranker");
  }
  if (segments !== undefined) {
    if (wire.v2?.segments) out.segments = segments;
    else if (segments) wire.featuresDropped.add("segments");
  }
  return out;
}

function run(
  requestId: string,
  repoRoot: string | undefined,
  rawInput: unknown,
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  options: AdapterOptions,
): string {
  const loaded = loadAdapterConfig(explicit, env);
  if (!loaded.ok) return failed(requestId, loaded);
  if (!repoRoot) return failed(requestId, { code: "invalid-request", message: "run 요청에 repoRoot 가 없습니다" });
  const mapping = mapProject(loaded.config, repoRoot);
  if (!mapping) {
    return failed(requestId, {
      code: "project-not-mapped",
      message: `이 저장소는 어댑터 설정 projects 에 대응돼 있지 않습니다: ${normalizeRoot(repoRoot)}`,
    });
  }
  const parsedInput = RUN_INPUT.safeParse(rawInput);
  if (!parsedInput.success) {
    const issue = parsedInput.error.issues[0];
    return failed(requestId, { code: "invalid-input", message: `context.docs 입력이 계약과 다릅니다: ${issue ? `${issue.path.join(".")} ${issue.message}` : ""}` });
  }
  const input = parsedInput.data;
  const ctx = contextOf(loaded.config, env, options);
  const started = ctx.now();
  const scope: Scope = {
    project: mapping.project,
    ...(mapping.sources ? { sources: mapping.sources } : {}),
    docs: new Set(input.docs.map((doc) => doc.path).filter(safeRelative)),
  };
  const diagnostics: Record<string, unknown> = { engine: ADAPTER_NAME, schemaVersion: 1, project: mapping.project };
  const wire: Wire = { mode: loaded.config.responseVersion, version: 1, retrieval: mapping.retrieval ?? {}, featuresDropped: new Set() };
  const refs = input.refs && input.refs.length > 0 ? input.refs : undefined;

  // 형식 협의가 먼저다 — 인계 참조를 어느 형식으로 대조할지가 여기서 정해진다. 같은 전체 마감 안이다. 참조도 질의도 없으면
  // 아무것도 부르지 않는다(no-query)
  const calling = refs !== undefined || input.requirements.some((requirement) => requirement.text.trim() !== "");
  const blocked = calling ? negotiate(ctx, wire) : undefined;
  if (wire.v2) diagnostics.indexId = wire.v2.indexId;
  let pinned: PinnedResult[] | undefined;
  let search: SearchOutcome;
  if (blocked) {
    diagnostics.negotiationError = blocked.code;
    pinned = refs ? resolveRefs(refs, diagnostics, (ref) => refFailure(ref.itemId, blocked.code, ref.segmentId)) : undefined;
    search = { sections: [], error: blocked };
  } else {
    // 인계 참조를 먼저 되찾는다 — 개수가 정해져 있고(≤ MAX_KNOWLEDGE_REFS) 실패가 근거 재확인으로 이어진다. 마감에 걸려 건너뛰는 것은
    // 뒤의 검색 쪽이다(호스트가 기본 검색으로 돌아갈 수 있다)
    pinned = refs ? resolveRefs(refs, diagnostics, (ref) => resolveOne(ctx, wire, ref, scope)) : undefined;
    search = searchAny(ctx, wire, input, scope, diagnostics);
  }
  // 부르지 않았으면 형식을 정하지 않았다(null)
  diagnostics.responseVersion = calling ? wire.version : null;
  if (wire.fallbackFrom) diagnostics.fallbackFrom = wire.fallbackFrom;
  if (calling && wire.version === 1) {
    if (wire.retrieval.ranker !== undefined && wire.retrieval.ranker !== "legacy") wire.featuresDropped.add("ranker");
    if (wire.retrieval.segments) wire.featuresDropped.add("segments");
  }
  if (wire.featuresDropped.size > 0) diagnostics.featuresDropped = [...wire.featuresDropped].sort();
  diagnostics.calls = ctx.calls;
  diagnostics.durationMs = ctx.now() - started;

  if (search.error) {
    diagnostics.searchError = search.error.code;
    // 인계 참조 결과는 검색 실패와 따로 낸다 — 검색 실패는 기본 검색 요청(fallback)으로 바꿔 싣는다
    if (!pinned) return failed(requestId, search.error, diagnostics);
    return envelope(requestId, {
      ok: true,
      output: { sections: [], fallback: { code: search.error.code, message: oneLine(search.error.message) }, pinned, diagnostics },
    });
  }
  return envelope(requestId, {
    ok: true,
    output: {
      sections: search.sections,
      ...(search.fallback ? { fallback: search.fallback } : {}),
      ...(pinned ? { pinned } : {}),
      diagnostics,
    },
  });
}

function sanitizedCode(code: string): string {
  return ERROR_CODE.test(code) ? code : "agent-knowledge-error";
}

/** 협의한 형식으로 검색한다 — 형식 2 검색이 형식 2를 모른다는 답을 받으면 auto 에서만 형식 1로 다시 검색한다 */
function searchAny(ctx: Context, wire: Wire, input: RunInput, scope: Scope, diagnostics: Record<string, unknown>): SearchOutcome {
  if (wire.version === 2) {
    const v2 = searchDocsV2(ctx, wire, input, scope);
    if (!("downgrade" in v2)) {
      Object.assign(diagnostics, v2.diagnostics);
      return v2.outcome;
    }
    const blocked = downgrade(wire, v2.downgrade);
    if (blocked) return { sections: [], error: blocked };
  }
  return searchDocs(ctx, input, scope, diagnostics);
}

/** agent-knowledge `task` — analysis~plan 단계와 저장소 기준 상대 경로(maxPaths 까지)만. 뺀 경로 수는 진단에 */
function taskOf(input: RunInput, limits: AdapterLimits, diagnostics: Record<string, unknown>): { phase?: string; paths?: string[] } {
  const phase = (CONTEXT_DOCS_PHASES as readonly string[]).includes(input.phase ?? "") ? input.phase : undefined;
  // agent-knowledge 는 저장소 기준 상대 경로가 아닌 것이 하나라도 있으면 요청 전체를 거부한다(invalid-path) — 영향 범위 표에서 뽑힌
  // URL·저장소 밖 경로는 빼고 그 수만 진단에 남긴다
  const files = (input.files ?? []).map(taskPath);
  const paths = [...new Set(files.filter((file): file is string => file !== undefined))].slice(0, limits.maxPaths);
  const pathsDropped = files.filter((file) => file === undefined).length;
  if (pathsDropped > 0) diagnostics.pathsDropped = pathsDropped;
  return { ...(phase ? { phase } : {}), ...(paths.length > 0 ? { paths } : {}) };
}

function searchDocs(ctx: Context, input: RunInput, scope: Scope, diagnostics: Record<string, unknown>): SearchOutcome {
  const limits = ctx.config.limits;
  const plan = buildQueries(input.requirements, limits);
  diagnostics.queries = plan.queries.length;
  diagnostics.requirements = plan.distinct;
  diagnostics.bundled = plan.bundled;
  diagnostics.queryChars = plan.clipped;
  if (plan.queries.length === 0) {
    diagnostics.queriesSkipped = 0;
    return { sections: [], fallback: { code: "no-query", message: "요구 항목 문장이 비어 질의를 만들지 못했습니다" } };
  }

  const task = taskOf(input, limits, diagnostics);
  // 받은 뒤 등록 문서·원본·일관성으로 거르므로 넉넉히 받고, 합친 뒤 input.limit 으로 자른다
  const limit = Math.min(SEARCH_LIMIT_MAX, input.limit * SEARCH_OVERFETCH);
  diagnostics.requestLimit = limit;
  const dropped: Dropped = { mandatory: new Set(), linked: new Set(), otherProject: new Set(), outOfDocs: new Set(), invalid: new Set(), deprecated: new Set() };
  const merged = new Map<string, Candidate>();
  const limitations: string[] = [];
  let generation: number | undefined;
  let executed = 0;
  let skipped = 0;
  let noResults = 0;
  let directCount = 0;
  let directSeen = 0;

  for (const [position, query] of plan.queries.entries()) {
    const body: Record<string, unknown> = {
      profile: "code",
      query,
      scope: { projects: [scope.project] },
      // 둘째 질의부터는 첫 응답의 세대에 고정한다 — 질의 사이에 새 세대가 게시돼도 한 세대의 결과만 합친다
      ...(generation !== undefined ? { version: { generation } } : {}),
      ...(Object.keys(task).length > 0 ? { task } : {}),
      limit,
    };
    const called = invoke(ctx, "search", body);
    if (!called.ok) {
      if (called.detail?.deadline === true && executed > 0) {
        // 마감 — 받은 결과는 쓴다
        skipped = plan.queries.length - position;
        break;
      }
      diagnostics.queriesSkipped = plan.queries.length - position - 1;
      return { sections: [], error: { code: sanitizedCode(called.code), message: called.message } };
    }
    const response = SEARCH_SCHEMA.safeParse(called.json);
    if (!response.success) {
      diagnostics.queriesSkipped = plan.queries.length - position - 1;
      const issue = response.error.issues[0];
      return { sections: [], error: { code: "invalid-response", message: `agent-knowledge search 응답 구조가 다릅니다: ${issue?.path.join(".") ?? ""}` } };
    }
    const data = response.data;
    if (called.exit === 3 && data.status !== "no-results") {
      return { sections: [], error: { code: "invalid-response", message: "agent-knowledge search 가 exit 3 인데 status 가 no-results 가 아닙니다" } };
    }
    if (generation !== undefined && data.index.generation !== generation) {
      return { sections: [], error: { code: "invalid-response", message: `agent-knowledge search 가 고정한 세대 ${generation} 가 아닌 ${data.index.generation} 을 돌려줬습니다` } };
    }
    if (generation === undefined) {
      generation = data.index.generation;
      diagnostics.generation = generation;
      diagnostics.commits = Object.fromEntries(data.index.sources.filter((source) => source.projectId === scope.project).map((source) => [source.sourceId, source.commit]));
      diagnostics.versions = {
        parser: data.index.parserVersion,
        chunker: data.index.chunkerVersion,
        tokenizer: data.index.tokenizerVersion,
        resolver: data.index.resolverVersion,
      };
    }
    executed += 1;
    directCount += data.retrieval.directCount;
    if (data.status === "no-results") noResults += 1;
    for (const limitation of data.limitations ?? []) {
      const code = sanitizedCode(limitation.code);
      if (!limitations.includes(code)) limitations.push(code);
    }

    // 직접 결과만 순위에 쓴다 — 필수 지정·의존·연결 항목은 세기만 한다
    const direct: { raw: unknown; rank: number; order: number; reasons: string[] }[] = [];
    for (const [order, raw] of data.items.entries()) {
      const selection = SELECTION_SCHEMA.safeParse(isRecord(raw) ? raw.selection : undefined);
      const id = isRecord(raw) && typeof raw.id === "string" ? raw.id : `(항목 ${position}:${order})`;
      if (!selection.success) {
        dropped.invalid.add(id);
        continue;
      }
      const reasons = DIRECT_REASONS.filter((reason) => selection.data.reasons.includes(reason));
      if (reasons.length === 0) {
        if (selection.data.section === "mandatory" || selection.data.reasons.includes("mandatory")) dropped.mandatory.add(id);
        else dropped.linked.add(id);
        continue;
      }
      direct.push({ raw, rank: selection.data.rank ?? order + 1, order, reasons });
    }
    direct.sort((a, b) => a.rank - b.rank || a.order - b.order);
    directSeen += direct.length;
    let usable = 0;
    for (const entry of direct) {
      const verdict = checkItem(entry.raw, data.index, scope);
      if (!verdict.ok) {
        const id = isRecord(entry.raw) && typeof entry.raw.id === "string" ? entry.raw.id : `(항목 ${position}:${entry.order})`;
        dropped[verdict.drop].add(id);
        continue;
      }
      // 질의별 순번 p(0부터)의 역수 합(RRF, k=10)
      const score = 1 / (10 + usable);
      usable += 1;
      const existing = merged.get(verdict.item.id);
      if (existing) {
        existing.score += score;
        for (const reason of entry.reasons) existing.reasons.add(reason);
      } else {
        merged.set(verdict.item.id, { item: verdict.item, score, reasons: new Set(entry.reasons) });
      }
    }
  }

  const ranked = [...merged.values()].sort((a, b) => b.score - a.score || byteOrder(a.item.id, b.item.id)).slice(0, input.limit);
  const sections = ranked.map((candidate) =>
    sectionOf(candidate.item, `agent-knowledge ${DIRECT_REASONS.filter((reason) => candidate.reasons.has(reason)).join("·")}`),
  );
  diagnostics.queriesSkipped = skipped;
  diagnostics.directCount = directCount;
  diagnostics.returned = sections.length;
  diagnostics.dropped = Object.fromEntries(Object.entries(dropped).map(([key, ids]) => [key, (ids as Set<string>).size]));
  diagnostics.limitations = limitations;

  if (executed > 0 && noResults === executed) {
    return { sections: [], fallback: { code: "no-results", message: "agent-knowledge 가 모든 질의에 결과 없음을 돌려줬습니다" } };
  }
  if (directCount === 0 && directSeen === 0) {
    return dropped.mandatory.size > 0
      ? { sections: [], fallback: { code: "mandatory-only", message: "질의에 직접 걸린 항목 없이 필수 지정 자료만 왔습니다" } }
      : { sections: [], fallback: { code: "no-results", message: "질의에 직접 걸린 항목이 없습니다" } };
  }
  if (sections.length === 0) {
    return { sections: [], fallback: { code: "no-usable-items", message: "직접 결과가 모두 이 저장소·문서 목록·일관성 검사에서 빠졌습니다" } };
  }
  return { sections };
}

// ---- 형식 2 검색 ----

type V2Search = { outcome: SearchOutcome; diagnostics: Record<string, unknown> } | { downgrade: string };

const SELECTION_V2_SCHEMA = z.object({ rank: z.number().optional(), directRank: z.number().nullable().optional(), reasons: z.array(z.string()) });

/**
 * 형식 2 검색 한 번 — 요구 항목을 `queries` 로 묶어 보내고(질의마다 부르지 않는다), 입력 문서로 `filters.documents` 를 좁히고, 필수 정책은
 * 호스트가 따로 붙이므로 `include.mandatory: false`, 받는 수는 `limit`·`budget.maxItems`, 응답 크기는 자식 출력 상한 아래로
 * `budget.maxResponseBytes` 를 둔다. status 의 활성 세대·DB 식별에 정확히 고정한다(`version.exact`). 결과는 `direct` 묶음만 쓴다.
 */
function searchDocsV2(ctx: Context, wire: Wire, input: RunInput, scope: Scope): V2Search {
  const d: Record<string, unknown> = {};
  const v2 = wire.v2 as V2Info;
  const limits = ctx.config.limits;
  const plan = buildQueriesV2(input.requirements, {
    maxQueries: Math.min(limits.maxQueries, v2.queryLimits?.maxQueries ?? limits.maxQueries),
    queryChars: Math.min(limits.queryChars, v2.queryLimits?.maxQueryChars ?? limits.queryChars),
  });
  d.queries = plan.queries.length;
  d.requirements = plan.distinct;
  d.bundled = plan.bundled;
  d.queryChars = plan.clipped;
  if (plan.queries.length === 0) {
    return { outcome: { sections: [], fallback: { code: "no-query", message: "요구 항목 문장이 비어 질의를 만들지 못했습니다" } }, diagnostics: d };
  }
  const task = taskOf(input, limits, d);
  const limit = Math.min(SEARCH_LIMIT_MAX, input.limit * SEARCH_OVERFETCH);
  d.requestLimit = limit;
  const documents = [...scope.docs];
  const features = requestFeatures(wire);
  const pin = v2.activeGeneration !== null ? { generation: v2.activeGeneration, ...(v2.indexId !== null ? { indexId: v2.indexId } : {}), exact: true } : undefined;
  const body: Record<string, unknown> = {
    responseVersion: 2,
    profile: "code",
    queries: plan.queries,
    overflow: "truncate",
    scope: { projects: [scope.project] },
    ...(documents.length > 0 && documents.length <= DOCUMENT_FILTER_MAX ? { filters: { documents } } : {}),
    include: { mandatory: false },
    ...(Object.keys(task).length > 0 ? { task } : {}),
    limit,
    budget: { maxItems: limit, maxResponseBytes: Math.max(RESPONSE_BYTES_MIN, limits.maxOutputBytes - RESPONSE_BYTES_MARGIN) },
    ...features,
    ...(pin ? { version: pin } : {}),
  };
  const called = invoke(ctx, "search", body, { responseVersion: 2 });
  if (!called.ok) {
    const reason = downgradeReason(called);
    if (reason) return { downgrade: reason };
    return { outcome: { sections: [], error: { code: sanitizedCode(called.code), message: called.message } }, diagnostics: d };
  }
  const failure = (message: string): V2Search => ({ outcome: { sections: [], error: { code: "invalid-response", message } }, diagnostics: d });
  const response = SEARCH_V2_SCHEMA.safeParse(called.json);
  if (!response.success) return failure(`agent-knowledge search 형식 2 응답 구조가 다릅니다: ${response.error.issues[0]?.path.join(".") ?? ""}`);
  const data = response.data;
  if (called.exit === 3 && data.status !== "no-results") return failure("agent-knowledge search 가 exit 3 인데 status 가 no-results 가 아닙니다");
  if (pin && (data.index.generation !== pin.generation || (pin.indexId !== undefined && data.index.indexId !== pin.indexId))) {
    return failure(`agent-knowledge search 가 고정한 색인(세대 ${pin.generation}) 이 아닌 결과를 돌려줬습니다`);
  }
  d.generation = data.index.generation;
  d.indexId = data.index.indexId;
  d.commits = Object.fromEntries(data.index.sources.filter((source) => source.projectId === scope.project).map((source) => [source.sourceId, source.commit]));
  d.versions = { parser: data.index.parserVersion, chunker: data.index.chunkerVersion, tokenizer: data.index.tokenizerVersion, resolver: data.index.resolverVersion };
  d.configHash = data.retrieval.configHash;
  d.ranker = { name: data.retrieval.ranker.name, version: data.retrieval.ranker.version };
  d.queryVersion = data.retrieval.queryVersion;
  d.segments = data.retrieval.segments?.effective ?? false;
  d.outcome = data.retrieval.outcome;
  d.digests = { request: data.digests.request, result: data.digests.result };
  d.budget = { truncated: data.budget.truncated, omittedCount: data.budget.omittedCount };
  d.directCount = data.retrieval.directCount;
  const limitations: string[] = [];
  for (const limitation of data.limitations ?? []) {
    const code = sanitizedCode(limitation.code);
    if (!limitations.includes(code)) limitations.push(code);
  }

  // 직접 결과(`group: direct`)만 쓴다 — 필수·의존·연결 묶음은 세기만 한다
  const dropped: Dropped = { mandatory: new Set(), linked: new Set(), otherProject: new Set(), outOfDocs: new Set(), invalid: new Set(), deprecated: new Set() };
  const direct: { raw: unknown; rank: number; order: number; reasons: string[] }[] = [];
  for (const [order, raw] of data.items.entries()) {
    const id = isRecord(raw) && typeof raw.id === "string" ? raw.id : `(항목 ${order})`;
    const group = isRecord(raw) && typeof raw.group === "string" ? raw.group : undefined;
    const selection = SELECTION_V2_SCHEMA.safeParse(isRecord(raw) ? raw.selection : undefined);
    if (group === undefined || !selection.success) {
      dropped.invalid.add(id);
      continue;
    }
    if (group !== "direct") {
      (group === "mandatory" ? dropped.mandatory : dropped.linked).add(id);
      continue;
    }
    const reasons = DIRECT_REASONS.filter((reason) => selection.data.reasons.includes(reason));
    direct.push({ raw, rank: selection.data.directRank ?? selection.data.rank ?? order + 1, order, reasons });
  }
  direct.sort((a, b) => a.rank - b.rank || a.order - b.order);
  const sections: DocSection[] = [];
  const seen = new Set<string>();
  for (const entry of direct) {
    const id = isRecord(entry.raw) && typeof entry.raw.id === "string" ? entry.raw.id : `(항목 ${entry.order})`;
    const parsed = ITEM_V2_SCHEMA.safeParse(entry.raw);
    const verdict = parsed.success
      ? checkParsed(parsed.data, data.index, scope, (item) => consistentV2(item, data.index, features.segments === true))
      : ({ ok: false, drop: "invalid" } as const);
    if (!verdict.ok || seen.has(verdict.item.id)) {
      dropped[verdict.ok ? "invalid" : verdict.drop].add(id);
      continue;
    }
    seen.add(verdict.item.id);
    if (sections.length < input.limit) {
      sections.push(sectionOfV2(verdict.item, `agent-knowledge ${entry.reasons.length > 0 ? entry.reasons.join("·") : "direct"}`));
    }
  }
  d.returned = sections.length;
  d.dropped = Object.fromEntries(Object.entries(dropped).map(([key, ids]) => [key, (ids as Set<string>).size]));
  d.limitations = limitations;

  const fallback = (code: string, message: string): V2Search => ({ outcome: { sections: [], fallback: { code, message } }, diagnostics: d });
  if (data.retrieval.outcome === "no-results" || data.status === "no-results") return fallback("no-results", "agent-knowledge 가 결과 없음을 돌려줬습니다");
  if (data.retrieval.outcome === "supplementary-only") return fallback("supplementary-only", "질의에 직접 걸린 항목 없이 필수·의존·연결 자료만 왔습니다");
  if (direct.length === 0) {
    return data.budget.truncated
      ? fallback("budget-truncated", "출력 예산으로 직접 결과가 모두 빠졌습니다")
      : fallback("no-results", "질의에 직접 걸린 항목이 없습니다");
  }
  if (sections.length === 0) return fallback("no-usable-items", "직접 결과가 모두 이 저장소·문서 목록·일관성 검사에서 빠졌습니다");
  return { outcome: { sections }, diagnostics: d };
}

// ---- 인계 참조 ----

function refFailure(itemId: string, reason: string, segmentId?: string): PinnedResult {
  return { itemId, ...(segmentId !== undefined ? { segmentId } : {}), ok: false, reason };
}

/**
 * 인계 참조마다 형식·상한·중복((itemId, segmentId) 기준)을 보고 `resolve` 로 되찾는다. 결과는 참조 순서 그대로이고, 조각을 가리킨
 * 참조의 결과에는 segmentId 가 있다(호스트가 (itemId, segmentId) 로 맞춘다).
 */
function resolveRefs(refs: unknown[], diagnostics: Record<string, unknown>, resolve: (ref: Ref) => PinnedResult): PinnedResult[] {
  const results: PinnedResult[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of refs.entries()) {
    const fallbackId = isRecord(raw) && typeof raw.itemId === "string" && raw.itemId !== "" ? raw.itemId : `refs[${index}]`;
    const fallbackSegment = isRecord(raw) && typeof raw.segmentId === "string" && raw.segmentId !== "" ? raw.segmentId : undefined;
    if (index >= MAX_KNOWLEDGE_REFS) {
      results.push(refFailure(fallbackId, "too-many-refs", fallbackSegment));
      continue;
    }
    const ref = REF_SCHEMA.safeParse(raw);
    const key = ref.success ? `${ref.data.itemId}\u0000${ref.data.segmentId ?? ""}` : "";
    if (!ref.success || seen.has(key)) {
      results.push(refFailure(fallbackId, "invalid-ref", fallbackSegment));
      continue;
    }
    seen.add(key);
    results.push(resolve(ref.data));
  }
  const failures: Record<string, number> = {};
  for (const result of results) {
    if (!result.ok && result.reason) failures[result.reason] = (failures[result.reason] ?? 0) + 1;
  }
  diagnostics.refs = { requested: refs.length, ok: results.filter((result) => result.ok).length, failed: failures };
  return results;
}

/**
 * 참조 하나 — 형식 2면 get 형식 2의 정확한 조회로, 아니면 형식 1 get 으로 되찾는다. 색인 식별·조각 식별을 가진 참조는 형식 1 get 이
 * 그것을 대조하지 못하므로 형식 1로 확인했다고 하지 않는다(`identity-unverifiable`).
 */
function resolveOne(ctx: Context, wire: Wire, ref: Ref, scope: Scope): PinnedResult {
  const colon = ref.itemId.indexOf(":");
  const sourceId = colon > 0 ? ref.itemId.slice(0, colon) : "";
  const fail = (reason: string) => refFailure(ref.itemId, reason, ref.segmentId);
  if (!AK_NAME.test(sourceId) || !ref.itemId.slice(colon + 1).includes("#")) return fail("invalid-ref");
  if (scope.sources && !scope.sources.includes(sourceId)) return fail("out-of-scope");
  if (wire.version === 2) {
    const result = resolveRefV2(ctx, ref, sourceId, scope);
    if (!("downgrade" in result)) return result;
    const blocked = downgrade(wire, result.downgrade);
    if (blocked) return fail(blocked.code);
  }
  if (ref.indexId !== undefined || ref.segmentId !== undefined) return fail("identity-unverifiable");
  return resolveRef(ctx, ref, scope);
}

/** 참조가 적은 원본 범위(있을 때만)가 되찾은 항목과 같은가 */
function rangeMatches(ref: Ref, p: Item["provenance"], segment?: { startLine: number | null; endLine: number | null }): boolean {
  return (
    (ref.path === undefined || ref.path === p.path) &&
    (ref.startLine === undefined || ref.startLine === p.startLine) &&
    (ref.endLine === undefined || ref.endLine === p.endLine) &&
    (ref.segmentStartLine === undefined || ref.segmentStartLine === segment?.startLine) &&
    (ref.segmentEndLine === undefined || ref.segmentEndLine === segment?.endLine)
  );
}

/** get 형식 2 오류 → 인계 참조 사유. 표에 없는 코드는 그대로(정리한 꼴) */
function getV2Failure(called: Failure & { detail?: Record<string, unknown> }): string {
  const reason = called.detail?.reason;
  if (called.code === "invalid-request" && reason === "hash-mismatch") return "hash-mismatch";
  if (called.code === "index-missing") {
    if (reason === "index-id-mismatch") return "index-mismatch";
    if (reason === "generation-not-found") return "generation-expired";
    if (reason === "commit-not-in-generation") return "commit-mismatch";
  }
  if (called.code === "not-found") return "not-found";
  if (called.code === "invalid-scope") return "out-of-scope";
  return sanitizedCode(called.code);
}

/**
 * get 형식 2 — 참조의 세대·DB 식별·원본 커밋에 정확히 고정하고(`version.exact`·`commits`) 기대 해시(`expect`)를 함께 보낸다. 조각
 * 참조는 조각 식별로 묻는다. 돌아온 항목도 참조와 같은지(항목·DB 식별·세대·커밋·해시·조각·범위) 다시 본다.
 */
function resolveRefV2(ctx: Context, ref: Ref, sourceId: string, scope: Scope): PinnedResult | { downgrade: string } {
  const fail = (reason: string) => refFailure(ref.itemId, reason, ref.segmentId);
  const called = invoke(
    ctx,
    "get",
    {
      responseVersion: 2,
      id: ref.segmentId ?? ref.itemId,
      profile: "code",
      scope: { projects: [scope.project] },
      version: { generation: ref.generation, ...(ref.indexId !== undefined ? { indexId: ref.indexId } : {}), exact: true, commits: { [sourceId]: ref.commit } },
      expect: { itemSha256: ref.itemSha256, ...(ref.segmentSha256 !== undefined ? { segmentSha256: ref.segmentSha256 } : {}) },
    },
    { responseVersion: 2 },
  );
  if (!called.ok) {
    const reason = downgradeReason(called);
    return reason ? { downgrade: reason } : fail(getV2Failure(called));
  }
  const response = GET_V2_SCHEMA.safeParse(called.json);
  if (!response.success) return fail("invalid-response");
  const index = response.data.index;
  if (index.generation !== ref.generation) return fail("generation-expired");
  if (ref.indexId !== undefined && index.indexId !== ref.indexId) return fail("index-mismatch");
  const parsed = ITEM_V2_SCHEMA.safeParse(response.data.item);
  if (!parsed.success || parsed.data.id !== ref.itemId) return fail("invalid-response");
  const item = parsed.data;
  if (item.ref.itemId !== ref.itemId || item.ref.indexId !== index.indexId || item.ref.indexGeneration !== index.generation) return fail("invalid-response");
  // 이 저장소·이번 문서 목록에 속하는지를 내용 대조보다 먼저 본다 — 쓸 수 없는 자리의 항목이면 해시가 맞아도 쓰지 않는다
  if (item.projectId !== scope.project || item.sourceId !== sourceId || (scope.sources && !scope.sources.includes(item.sourceId))) return fail("out-of-scope");
  const p = item.provenance;
  if (!safeRelative(p.path)) return fail("invalid-response");
  if (!scope.docs.has(p.path)) return fail("not-in-docs");
  if (p.commit !== ref.commit || item.ref.commit !== ref.commit) return fail("commit-mismatch");
  if (p.itemSha256 !== ref.itemSha256 || item.ref.itemSha256 !== ref.itemSha256) return fail("hash-mismatch");
  if (ref.segmentId !== undefined) {
    if (item.ref.segmentId !== ref.segmentId || item.segment?.id !== ref.segmentId) return fail("invalid-response");
    if (item.ref.segmentSha256 !== ref.segmentSha256) return fail("hash-mismatch");
  } else if (item.ref.segmentId !== null) {
    return fail("invalid-response");
  }
  if (!rangeMatches(ref, p, { startLine: item.ref.segmentStartLine, endLine: item.ref.segmentEndLine })) return fail("range-mismatch");
  // 폐기 항목도 되찾은 그대로 낸다 — 상태 표시는 호스트가 한다(인계한 근거가 폐기됐다는 사실 자체가 정보다)
  const verdict = checkParsed(item, index, { ...scope, docs: new Set([p.path]) }, (it) => consistentV2(it, index, ref.segmentId !== undefined));
  if (!verdict.ok && verdict.drop !== "deprecated") return fail("invalid-response");
  return { itemId: ref.itemId, ...(ref.segmentId !== undefined ? { segmentId: ref.segmentId } : {}), ok: true, section: sectionOfV2(item, "agent-knowledge 인계 참조", true) };
}

/** 형식 1 get — 같은 세대에서 되찾아 항목·프로젝트·문서·커밋·해시를 대조한다(색인 식별·조각이 없는 참조만 여기로 온다) */
function resolveRef(ctx: Context, ref: Ref, scope: Scope): PinnedResult {
  const colon = ref.itemId.indexOf(":");
  const sourceId = colon > 0 ? ref.itemId.slice(0, colon) : "";
  if (!AK_NAME.test(sourceId) || !ref.itemId.slice(colon + 1).includes("#")) return refFailure(ref.itemId, "invalid-ref");
  if (scope.sources && !scope.sources.includes(sourceId)) return refFailure(ref.itemId, "out-of-scope");
  const called = invoke(ctx, "get", {
    id: ref.itemId,
    profile: "code",
    scope: { projects: [scope.project] },
    version: { generation: ref.generation },
  });
  if (!called.ok) {
    if (called.code === "index-missing" && called.detail?.reason === "generation-not-found") return refFailure(ref.itemId, "generation-expired");
    return refFailure(ref.itemId, sanitizedCode(called.code));
  }
  const response = GET_SCHEMA.safeParse(called.json);
  if (!response.success) return refFailure(ref.itemId, "invalid-response");
  if (response.data.index.generation !== ref.generation) return refFailure(ref.itemId, "generation-expired");
  const parsed = ITEM_SCHEMA.safeParse(response.data.item);
  if (!parsed.success || parsed.data.id !== ref.itemId) return refFailure(ref.itemId, "invalid-response");
  const item = parsed.data;
  // 이 저장소·이번 문서 목록에 속하는지를 내용 대조보다 먼저 본다 — 쓸 수 없는 자리의 항목이면 해시가 맞아도 쓰지 않는다
  if (item.projectId !== scope.project || item.sourceId !== sourceId || (scope.sources && !scope.sources.includes(item.sourceId))) {
    return refFailure(ref.itemId, "out-of-scope");
  }
  if (!safeRelative(item.provenance.path)) return refFailure(ref.itemId, "invalid-response");
  if (!scope.docs.has(item.provenance.path)) return refFailure(ref.itemId, "not-in-docs");
  if (item.provenance.commit !== ref.commit) return refFailure(ref.itemId, "commit-mismatch");
  if (item.provenance.itemSha256 !== ref.itemSha256) return refFailure(ref.itemId, "hash-mismatch");
  if (!rangeMatches(ref, item.provenance)) return refFailure(ref.itemId, "range-mismatch");
  // 폐기 항목도 되찾은 그대로 낸다 — 상태 표시는 호스트가 한다(인계한 근거가 폐기됐다는 사실 자체가 정보다)
  const verdict = checkItem(item, response.data.index, { ...scope, docs: new Set([item.provenance.path]) });
  if (!verdict.ok && verdict.drop !== "deprecated") return refFailure(ref.itemId, "invalid-response");
  return { itemId: ref.itemId, ok: true, section: sectionOf(item, "agent-knowledge 인계 참조", true) };
}
