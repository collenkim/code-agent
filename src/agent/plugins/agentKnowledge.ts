import { spawnSync } from "child_process";
import { existsSync, readFileSync, realpathSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { z } from "zod";

import { isBatchScript, quoteForCmd, resolveExecutable } from "../../core/build";
import { packageVersion } from "../assets";
import { MAX_KNOWLEDGE_REFS } from "../master/protocol";
import { CONTEXT_DOCS_PHASES, HANDSHAKE_LIMIT, PROTOCOL, VERSION } from "./protocol";
import type { DescribeOutput, DocSection, DocsFallback, PinnedResult, ProbeOutput } from "./protocol";
import { storeDir } from "./store";

/**
 * `code-agent plugin agent-knowledge [--config <파일>]` — 로컬 agent-knowledge CLI 를 `context.docs` 자리에 잇는 어댑터.
 *
 * 플러그인 계약(code-agent.plugin v1) 그대로 stdin 요청 한 벌을 받아 stdout 에 응답 봉투 **하나만** 쓴다. 어떤 실패든
 * exit 0 + `ok:false` 봉투다 — 호스트는 그것을 실패로 읽고 기본 검색으로 돈다(봉투 밖의 출력·비정상 종료는 사유가 흐려진다).
 *
 * agent-knowledge 의 **읽기 명령만** 부른다(search·get·status). index·eval 같은 쓰기 명령은 부르지 않고 원본 문서도 바꾸지 않는다.
 * 요청 스키마가 엄격해(모르는 키 거부) 이 어댑터는 agent-knowledge 가 이미 아는 필드만 보낸다.
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
export const AGENT_KNOWLEDGE_ACCEPTS = ["context.docs.phase", "context.docs.files", "context.docs.refs"] as const;

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
  projects: z
    .array(
      z.strictObject({
        root: z.string().min(1),
        project: z.string().regex(AK_NAME, "project 는 agent-knowledge 프로젝트 ID 형식입니다"),
        sources: z.array(z.string().regex(AK_NAME, "sources 는 agent-knowledge 원본 ID 형식입니다")).min(1).optional(),
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
}

export interface AdapterConfig {
  path: string;
  dir: string;
  command: string[];
  sourcesConfig?: string;
  retrievalConfig?: string;
  db?: string;
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
  const projects = parsed.data.projects.map((entry) => ({
    root: normalizeRoot(resolve(dir, entry.root)),
    project: entry.project,
    ...(entry.sources ? { sources: entry.sources } : {}),
  }));
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
  const texts: string[] = [];
  for (const requirement of requirements) {
    const text = requirement.text.replace(/\s+/g, " ").trim();
    if (text !== "" && !texts.includes(text)) texts.push(text);
  }
  const groups: string[][] = [];
  if (texts.length <= limits.maxQueries) {
    for (const text of texts) groups.push([text]);
  } else {
    for (let index = 0; index < limits.maxQueries; index += 1) {
      const from = Math.floor((index * texts.length) / limits.maxQueries);
      const to = Math.floor(((index + 1) * texts.length) / limits.maxQueries);
      groups.push(texts.slice(from, to));
    }
  }
  let clipped = 0;
  const queries = groups.map((group) => {
    const cut = clip(group.join(" "), limits.queryChars);
    clipped += cut.clipped;
    return cut.text;
  });
  return { queries, distinct: texts.length, bundled: groups.filter((group) => group.length > 1).length, clipped };
}

// ---- agent-knowledge 호출 ----

type Sub = "search" | "get" | "status";

interface Context {
  config: AdapterConfig;
  env: NodeJS.ProcessEnv;
  now: () => number;
  deadline: number;
  calls: number;
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
function invoke(ctx: Context, sub: Sub, body?: Record<string, unknown>): Called {
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
  const args = [...prefix, sub, ...commonOptions(ctx.config), ...(body ? ["--request", "-"] : [])];
  ctx.calls += 1;
  const options = {
    cwd: ctx.config.dir,
    env: ctx.env,
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
  if (json.schema !== `agent-knowledge.${sub}` || json.schemaVersion !== 1) {
    return {
      ok: false,
      code: "unsupported-version",
      message: `agent-knowledge ${sub} 응답 형식 ${JSON.stringify(json.schema)} v${JSON.stringify(json.schemaVersion)} 은 이 어댑터가 아는 형식이 아닙니다 (agent-knowledge.${sub} v1)`,
    };
  }
  // search 의 결과 없음(3)만 정상 종료로 본다 — 다른 0 아닌 종료는 오류 봉투로 왔어야 한다
  if (result.status !== 0 && !(sub === "search" && result.status === 3)) {
    return { ok: false, code: "invalid-response", message: `agent-knowledge ${sub} 가 오류 봉투 없이 exit ${result.status} 로 끝났습니다` };
  }
  return { ok: true, json, exit: result.status ?? 0 };
}

// ---- 응답 구조 ----

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

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

/** 섹션 출처 참조 — agent-knowledge 항목 필드 이름 그대로. 호스트(knowledgeRefs.ts)가 같은 모양을 엄격히 검사한다 */
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
}

/** 저장소 기준 상대 경로만 — 절대·`..`·`\`·빈 마디는 원격 결과가 저장소 밖을 가리키는 길이다 */
/** 작업 파일 하나를 agent-knowledge `task.paths` 꼴로 — 역슬래시·앞 `./`·끝 `/` 를 맞추고, 저장소 기준 상대 경로가 아니면 undefined */
function taskPath(file: string): string | undefined {
  const path = file.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  return safeRelative(path) ? path : undefined;
}

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
  const item = parsed.data;
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
    HEX40.test(p.commit) &&
    HEX40.test(p.blobSha) &&
    HEX64.test(p.documentSha256) &&
    HEX64.test(p.itemSha256) &&
    p.startLine >= 1 &&
    p.startLine <= p.endLine;
  if (!consistent) return { ok: false, drop: "invalid" };
  if (item.knowledge.status === "deprecated") return { ok: false, drop: "deprecated" };
  return { ok: true, item };
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

const REF_SCHEMA = z.object({
  itemId: z.string().min(1),
  generation: z.number().int().min(1),
  commit: z.string().regex(HEX40),
  itemSha256: z.string().regex(HEX64),
  required: z.boolean(),
});

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
    note: "로컬 agent-knowledge CLI 읽기 전용(search·get·status) — 색인·DB 쓰기 없음",
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
  return { config, env, now, deadline: now() + (options.deadlineMs ?? OVERALL_DEADLINE_MS), calls: 0 };
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
      detail: `agent-knowledge 활성 세대 ${generation} · 실행 위치의 저장소는 설정 projects 에 없습니다 — 대응된 저장소에서만 결과를 냅니다 · 읽기 전용(search·get·status)`,
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
    detail: `agent-knowledge 활성 세대 ${generation} · 이 저장소 → 프로젝트 ${mapping.project} (원본 ${indexed.length}개 색인됨) · 읽기 전용(search·get·status)`,
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

  // 인계 참조를 먼저 되찾는다 — 개수가 정해져 있고(≤ MAX_KNOWLEDGE_REFS) 실패가 근거 재확인으로 이어진다. 마감에 걸려 건너뛰는 것은
  // 뒤의 검색 질의 쪽이다(호스트가 기본 검색으로 돌아갈 수 있다)
  const pinned = input.refs && input.refs.length > 0 ? resolveRefs(ctx, input.refs, scope, diagnostics) : undefined;
  const search = searchDocs(ctx, input, scope, diagnostics);
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

  const phase = (CONTEXT_DOCS_PHASES as readonly string[]).includes(input.phase ?? "") ? input.phase : undefined;
  // agent-knowledge 는 저장소 기준 상대 경로가 아닌 것이 하나라도 있으면 요청 전체를 거부한다(invalid-path) — 영향 범위 표에서 뽑힌
  // URL·저장소 밖 경로는 빼고 그 수만 진단에 남긴다
  const files = (input.files ?? []).map(taskPath);
  const paths = [...new Set(files.filter((file): file is string => file !== undefined))].slice(0, limits.maxPaths);
  const pathsDropped = files.filter((file) => file === undefined).length;
  if (pathsDropped > 0) diagnostics.pathsDropped = pathsDropped;
  const task = { ...(phase ? { phase } : {}), ...(paths.length > 0 ? { paths } : {}) };
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

// ---- 인계 참조 ----

function refFailure(itemId: string, reason: string): PinnedResult {
  return { itemId, ok: false, reason };
}

function resolveRefs(ctx: Context, refs: unknown[], scope: Scope, diagnostics: Record<string, unknown>): PinnedResult[] {
  const results: PinnedResult[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of refs.entries()) {
    const fallbackId = isRecord(raw) && typeof raw.itemId === "string" && raw.itemId !== "" ? raw.itemId : `refs[${index}]`;
    if (index >= MAX_KNOWLEDGE_REFS) {
      results.push(refFailure(fallbackId, "too-many-refs"));
      continue;
    }
    const ref = REF_SCHEMA.safeParse(raw);
    if (!ref.success || seen.has(ref.data.itemId)) {
      results.push(refFailure(fallbackId, "invalid-ref"));
      continue;
    }
    seen.add(ref.data.itemId);
    results.push(resolveRef(ctx, ref.data, scope));
  }
  const failures: Record<string, number> = {};
  for (const result of results) {
    if (!result.ok && result.reason) failures[result.reason] = (failures[result.reason] ?? 0) + 1;
  }
  diagnostics.refs = { requested: refs.length, ok: results.filter((result) => result.ok).length, failed: failures };
  return results;
}

function resolveRef(ctx: Context, ref: z.infer<typeof REF_SCHEMA>, scope: Scope): PinnedResult {
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
  // 폐기 항목도 되찾은 그대로 낸다 — 상태 표시는 호스트가 한다(인계한 근거가 폐기됐다는 사실 자체가 정보다)
  const verdict = checkItem(item, response.data.index, { ...scope, docs: new Set([item.provenance.path]) });
  if (!verdict.ok && verdict.drop !== "deprecated") return refFailure(ref.itemId, "invalid-response");
  return { itemId: ref.itemId, ok: true, section: sectionOf(item, "agent-knowledge 인계 참조", true) };
}
