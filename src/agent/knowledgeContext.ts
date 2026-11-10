/**
 * `context.docs` 의 지식 검색 연결 — contextRender `docSectionLines` 가 부른다.
 *
 * 세 모드가 있고 판단은 저장소 선언(code-agent.json `plugins`)이 한다.
 * - off(선언 없음): 어댑터를 부르지 않는다. master 인계 참조가 없으면 읽거나 쓰는 것이 없고 기본 검색의 화면 그대로다. 인계 참조가
 *   남아 있으면 모두 adapter-unavailable 로 처리해 required 참조를 재확인 블록에 싣고 지식 기록에 남긴다.
 * - enabled(`slots`): 어댑터 출력 중 출처 참조(`ref`)가 있는 섹션은 **지금 파일과 내용 해시가 맞은 범위만** 싣는다. 인덱스 항목·절과
 *   경로·줄 범위가 꼭 맞으면 그 항목(줄 범위·최신성·반드시 적용하는 정책 연결이 그대로 붙고, 구분·상태는 code-agent 문서가 정본이라
 *   어댑터 상태는 낮추는 신호만 덧붙인다), 아니면 확인한 범위만 부분 범위로 — 긴 원본 절 전체로 넓히지 않는다.
 *   참조를 쓰지 않는 어댑터의 출력은 기존 경로(fromPlugin) 그대로다.
 * - shadow(`shadow`): 반환 줄을 다 만든 뒤 따로 불러 같은 검증으로 "enabled 였다면 보였을 범위"를 계산해 비교 기록만 남긴다.
 *   화면·승인·계획 입력·동의 스냅샷에 아무것도 더하지 않는다.
 *
 * 기록은 `.code-agent/log/knowledge/context.jsonl` 에만 쓴다 — Git 이 무시하고(init 의 `log/`) 동의 스냅샷도 빼는 자리라 작업 상태를
 * 흔들지 않는다. 본문은 싣지 않는다(항목 id·경로·줄 범위·사유·제목만).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { dirname, join, posix } from "path";

import type { Manifest } from "../core/manifest";
import type { Hit, KnowledgeIndex } from "./knowledgeIndex";
import { cautionLabel, commitNote, docReader, headCommit, headingAt, repoRelativePath, safeDocPath, statusLabel, verifySectionRef } from "./knowledgeRefs";
import type { DocReader, RejectedRef, VerifiedRef } from "./knowledgeRefs";
import { STATE_DIR } from "./layout";
import { managedKnowledge } from "./master/workKnowledge";
import { LOG_LINES, LOG_RESPONSE_BYTES, MAX_OUTPUT_ITEMS } from "./plugins/protocol";
import type { ContextDocsPhase, DocSection, KnowledgeRef, PinnedResult, SlotInput, SlotOutput } from "./plugins/protocol";
import { callShadow, clamp, knowledgeLink, negotiatedInput, shadowFor } from "./plugins/run";
import type { SlotResult } from "./plugins/run";
import { readStore } from "./plugins/store";

/** 지식 검색 진단·비교 기록 — 끝 LOG_LINES 줄만 남긴다 */
export const KNOWLEDGE_LOG = posix.join(STATE_DIR, "log", "knowledge", "context.jsonl");
/** 같은 입력의 shadow 를 다시 부르지 않으려고 보는 기록 끝 줄 수 */
const SHADOW_RECENT_LINES = 50;
/** 실패한 shadow 를 같은 입력으로 다시 부르기까지 기다리는 시간 */
const SHADOW_RETRY_MS = 10 * 60 * 1000;

type DocsOutput = SlotOutput["context.docs"];
type DocsInput = SlotInput["context.docs"];

/** 인덱스 항목·절과 꼭 맞지 않는 확인 범위 — 그 범위만 싣는다 */
export interface PartialRange {
  path: string;
  start: number;
  end: number;
  /** 시작 줄이 제목이면 그것, 아니면 바로 위 제목 */
  heading: string;
  /** 상태 표시(승격 없음) */
  label: string;
  why: string[];
}

/** 참고 문서 한 줄의 재료 — 인덱스 항목·절(Hit), 확인한 부분 범위, 인덱스로 되찾지 못한 플러그인 절 */
export type ShownItem = Hit | DocSection | PartialRange;

export const isPartialRange = (item: ShownItem): item is PartialRange => "label" in item && "start" in item;

export function partialLine(item: PartialRange): string {
  return `- ${item.path} L${item.start}-L${item.end} · ${item.heading} (부분) [${item.label}]${item.why.length ? ` (${item.why.join(" · ")})` : ""}`;
}

/** master 가 이 작업에 인계한 지식 참조 — 없으면 undefined(읽기만 한다) */
export function handoffRefs(repoRoot: string): KnowledgeRef[] | undefined {
  try {
    return managedKnowledge(repoRoot)?.refs;
  } catch {
    return undefined;
  }
}

/**
 * 선택 입력 — 단계 · 작업 파일 · 인계 참조. 어댑터가 describe `accepts` 로 받겠다고 한 것만 실제로 나간다(run.ts `negotiatedInput`).
 * 작업 파일은 저장소 기준 상대 경로만 싣는다(`repoRelativePath` — 영향 범위 표에서 뽑힌 엔드포인트·저장소 밖 경로는 뺀다).
 * 빈 목록은 싣지 않는다.
 */
export function optionalDocsInput(phase: ContextDocsPhase | undefined, files: readonly string[], refs: KnowledgeRef[] | undefined): Pick<DocsInput, "phase" | "files" | "refs"> {
  const paths = [...new Set(files.map(repoRelativePath).filter((path): path is string => path !== undefined))];
  return {
    ...(phase ? { phase } : {}),
    ...(paths.length > 0 ? { files: paths } : {}),
    ...(refs && refs.length > 0 ? { refs } : {}),
  };
}

// ---- 섹션 판정(enabled·shadow 가 같은 규칙을 쓴다) ----

interface Judge {
  /** 이번 입력이 보낸 문서 경로 — 이 밖은 읽지 않는다 */
  docs: ReadonlySet<string>;
  read: DocReader;
  head?: string;
  index: KnowledgeIndex;
  limit: number;
  fromPlugin: (section: DocSection) => Hit | DocSection;
}

interface VerifiedRecord { itemId: string; path: string; start: number; end: number; how: "exact" | "moved"; status: string }
interface RejectedRecord { itemId?: string; path: string; reason: string }
interface PinnedRecord { itemId: string; required: boolean; ok: boolean; reason?: string; path?: string; start?: number; end?: number; how?: string }
type FallbackRecord = { code: string; by: "adapter" | "host"; message?: string };

interface Judged {
  /** 출처 참조·기본 검색 요청을 쓰는 출력인가 — 아니면 기존 경로 그대로 */
  aware: boolean;
  fallback?: FallbackRecord;
  shown: ShownItem[];
  verified: VerifiedRecord[];
  rejected: RejectedRecord[];
}

const verifiedRecord = (found: VerifiedRef): VerifiedRecord =>
  ({ itemId: found.ref.itemId, path: found.path, start: found.start, end: found.end, how: found.how, status: found.ref.status });
const rejectedRecord = (found: RejectedRef): RejectedRecord =>
  ({ ...(found.itemId ? { itemId: found.itemId } : {}), path: found.path.slice(0, 512), reason: found.reason });

/**
 * 확인한 범위를 화면 항목으로 — 인덱스 항목·절과 경로·시작·끝 줄이 모두 같을 때만 그것으로 되찾는다(제목이 같다는 이유로 넓히지 않는다).
 * 인덱스로 되찾은 줄은 code-agent 의 구분·상태가 붙으므로 어댑터 상태는 낮추는 신호만(`cautionLabel`), 부분 범위는 어댑터 상태를 그대로
 * 단다(`statusLabel`). 기준 커밋 메모는 이유 끝에 붙는다.
 */
function rangeItem(found: VerifiedRef, why: string, judge: Judge): Hit | PartialRange {
  const note = commitNote(found, judge.head);
  const reason = why ? [clamp(why)] : [];
  const caution = cautionLabel(found.ref);
  const indexed = [...reason, ...(caution ? [caution] : []), ...(note ? [note] : [])];
  const entry = judge.index.entries.find((candidate) => candidate.path === found.path && candidate.line === found.start && candidate.end === found.end);
  if (entry) return { entry, score: 0, why: indexed };
  const section = judge.index.sections.find((candidate) => candidate.path === found.path && candidate.line === found.start && candidate.end === found.end);
  if (section) return { section, score: 0, why: indexed };
  const heading = headingAt(judge.read(found.path) ?? [], found.start);
  return { path: found.path, start: found.start, end: found.end, heading: heading ? clamp(heading) : "(제목 없음)", label: statusLabel(found.ref), why: [...reason, ...(note ? [note] : [])] };
}

const rangeKey = (path: string, start: number, end: number): string => `${path}\n${start}\n${end}`;

function judgeOutput(output: DocsOutput, judge: Judge): Judged {
  const aware = output.fallback !== undefined || output.sections.some((section) => section.ref !== undefined);
  if (!aware) return { aware, shown: [], verified: [], rejected: [] };
  if (output.fallback) {
    return {
      aware,
      fallback: { code: output.fallback.code, by: "adapter", ...(output.fallback.message ? { message: clamp(output.fallback.message) } : {}) },
      shown: [], verified: [], rejected: [],
    };
  }
  const shown: ShownItem[] = [];
  const seen = new Set<string>();
  const verified: VerifiedRecord[] = [];
  const rejected: RejectedRecord[] = [];
  let plain = 0;
  for (const section of output.sections.slice(0, MAX_OUTPUT_ITEMS)) {
    if (shown.length >= judge.limit) break;
    if (section.ref === undefined) {
      shown.push(judge.fromPlugin(section));
      plain += 1;
      continue;
    }
    const found = verifySectionRef(section, judge.docs, judge.read);
    if (!found.ok) {
      rejected.push(rejectedRecord(found));
      continue;
    }
    verified.push(verifiedRecord(found));
    const key = rangeKey(found.path, found.start, found.end);
    if (seen.has(key)) continue;
    seen.add(key);
    shown.push(rangeItem(found, section.why, judge));
  }
  // 참조 섹션만 왔는데 하나도 확인하지 못했다 — 빈 화면 대신 기본 검색으로 돈다
  if (plain === 0 && verified.length === 0) return { aware, fallback: { code: "no-verified-items", by: "host" }, shown: [], verified, rejected };
  return { aware, shown, verified, rejected };
}

/** 어댑터가 준 실패 사유는 코드 꼴일 때만 그대로 쓴다 — 자유 글은 모델 입력에 싣지 않는다 */
const reasonCode = (reason: string | undefined): string => (reason && /^[a-z0-9][a-z0-9-]{0,63}$/.test(reason) ? reason : "adapter-rejected");

/** master 인계 참조의 꼴 — 인계 때 검사(master/protocol.ts `knowledgeHandoffOf`)와 같은 조건의 최소한 */
const wellFormedRef = (ref: KnowledgeRef): boolean =>
  ref.itemId.includes(":") && ref.itemId.includes("#") && Number.isSafeInteger(ref.generation) && ref.generation >= 1 &&
  /^[0-9a-f]{40}$/.test(ref.commit) && /^[0-9a-f]{64}$/.test(ref.itemSha256);

interface Pinned {
  shown: ShownItem[];
  failed: { itemId: string; reason: string; required: boolean }[];
  records: PinnedRecord[];
}

/**
 * 인계 참조마다 어댑터가 되찾은 결과를 다시 대조한다 — 같은 항목 id·세대·커밋·항목 해시이고, 그 범위가 지금 파일과 맞아야 확인이다.
 * 참조를 보내지 못한 호출(선언·등록 없음, 실패, 어댑터가 참조를 받지 않음)이면 전부 adapter-unavailable 이다.
 */
function pinnedOutcome(refs: readonly KnowledgeRef[], results: PinnedResult[] | undefined, sent: boolean, judge: Judge | undefined): Pinned {
  const pinned: Pinned = { shown: [], failed: [], records: [] };
  const seen = new Set<string>();
  for (const ref of refs) {
    const fail = (reason: string): void => {
      pinned.failed.push({ itemId: ref.itemId, reason, required: ref.required });
      pinned.records.push({ itemId: ref.itemId, required: ref.required, ok: false, reason });
    };
    // 기록에서 읽은 참조의 꼴이 깨졌으면(workKnowledge 가 빈 값으로 남긴 것) 어댑터에 묻기 전에 형식 오류다
    if (!wellFormedRef(ref)) { fail("invalid-ref"); continue; }
    if (!sent || !judge) { fail("adapter-unavailable"); continue; }
    const result = results?.find((entry) => entry.itemId === ref.itemId);
    if (!result) { fail("not-returned"); continue; }
    if (!result.ok) { fail(reasonCode(result.reason)); continue; }
    if (!result.section) { fail("invalid-ref"); continue; }
    const found = verifySectionRef(result.section, judge.docs, judge.read);
    if (!found.ok) { fail(found.reason); continue; }
    if (found.ref.itemId !== ref.itemId) { fail("invalid-ref"); continue; }
    if (found.ref.itemSha256 !== ref.itemSha256) { fail("hash-mismatch"); continue; }
    if (found.ref.generation !== ref.generation) { fail("generation-mismatch"); continue; }
    if (found.ref.commit !== ref.commit) { fail("commit-mismatch"); continue; }
    pinned.records.push({ itemId: ref.itemId, required: ref.required, ok: true, path: found.path, start: found.start, end: found.end, how: found.how });
    const key = rangeKey(found.path, found.start, found.end);
    if (seen.has(key)) continue;
    seen.add(key);
    pinned.shown.push(rangeItem(found, result.section.why, judge));
  }
  return pinned;
}

const PINNED_TITLE = "## 인계받은 지식 근거 (master — 항목·세대·해시를 현재 파일과 대조)";
const RECHECK_TITLE = "## 근거 재확인 필요 (인계 항목 검증 실패 — 범위를 넓혀 다시 찾지 말고 이 작업의 근거를 다시 확인하거나 재계획을 요청한다)";

/** 인계 참조 블록 — 확인된 것, 그리고 실패한 required 참조 */
export function pinnedLines(pinned: DocsKnowledge["pinned"], render: (item: ShownItem) => string): string[] {
  const required = pinned.failed.filter((entry) => entry.required);
  return [
    ...(pinned.shown.length > 0 ? ["", PINNED_TITLE, ...pinned.shown.map(render)] : []),
    ...(required.length > 0 ? ["", RECHECK_TITLE, ...required.map((entry) => `- ${clamp(entry.itemId) || "(항목 id 없음)"}: ${entry.reason}`)] : []),
  ];
}

// ---- enabled ----

export interface DocsRequest {
  repoRoot: string;
  manifest: Manifest;
  index: KnowledgeIndex;
  phase?: ContextDocsPhase;
  limit: number;
  refs?: KnowledgeRef[];
  /** callSlot 이 실제로 지은 입력(협의 전) — 어댑터를 부르지 않았으면 undefined */
  sent?: DocsInput;
  result: SlotResult<DocsOutput>;
  /** 기본 검색 — contextRender 의 기본 경로와 같은 것(부르면 그쪽 순위가 채워진다) */
  runDefault: () => DocsOutput;
  /** 참조가 없는 플러그인 절을 인덱스로 되찾는 기존 경로 */
  fromPlugin: (section: DocSection) => Hit | DocSection;
}

export interface DocsKnowledge {
  /** 화면의 출처 — 기본 검색으로 돌렸으면 기본 + 알림, 아니면 받은 그대로 */
  result: SlotResult<DocsOutput>;
  /** 참조를 확인해 고른 항목. undefined 면 기존 경로(기본이면 기본 검색 순위, 플러그인이면 fromPlugin) */
  shown?: ShownItem[];
  /** 목록 뒤의 줄 — 검증 제외 수 */
  notes: string[];
  pinned: Pick<Pinned, "shown" | "failed">;
}

function acceptsOf(name: string | undefined): readonly string[] | undefined {
  if (!name) return undefined;
  try {
    return readStore().plugins[name]?.adapter.accepts;
  } catch {
    return undefined;
  }
}

function rejectedLine(rejected: RejectedRecord[]): string {
  const reasons = [...new Set(rejected.map((entry) => entry.reason))];
  return `- 검증 제외 ${rejected.length}개 (사유 ${reasons.join("·")}) — ${KNOWLEDGE_LOG}`;
}

function fallbackNotice(name: string | undefined, fallback: FallbackRecord): string {
  return fallback.by === "adapter"
    ? `플러그인 ${name}(context.docs) 가 기본 검색을 요청했습니다: ${fallback.code} — 기본 구현으로 돕니다.`
    : `플러그인 ${name}(context.docs) 의 항목을 현재 파일과 하나도 대조하지 못했습니다: ${fallback.code} — 기본 구현으로 돕니다.`;
}

/**
 * 어댑터 결과에 출처 참조·기본 검색 요청·인계 참조를 적용한다. 참조를 쓰지 않는 출력이고 인계도 없으면 받은 것을 그대로 돌려준다
 * (읽기·쓰기·git 호출 없음) — off 와 이전 어댑터의 화면이 바뀌지 않는다.
 */
export function applyDocsKnowledge(request: DocsRequest): DocsKnowledge {
  const { result, refs } = request;
  const legacy: DocsKnowledge = { result, notes: [], pinned: { shown: [], failed: [] } };
  const output = result.source === "plugin" ? result.output : undefined;
  const logged = output !== undefined && (output.fallback !== undefined || output.pinned !== undefined || output.diagnostics !== undefined ||
    output.sections.some((section) => section.ref !== undefined));
  if (!logged && !(refs && refs.length > 0)) return legacy;

  const link = knowledgeLink(request.manifest);
  const name = result.name ?? link.plugin;
  const head = headCommit(request.repoRoot);
  const judge: Judge = {
    docs: new Set((request.sent?.docs ?? []).map((doc) => doc.path)),
    read: docReader(request.repoRoot),
    head,
    index: request.index,
    limit: request.limit,
    fromPlugin: request.fromPlugin,
  };
  const negotiated = request.sent ? negotiatedInput("context.docs", request.sent as unknown as Record<string, unknown>, acceptsOf(name)) : undefined;
  const applied: DocsKnowledge = { ...legacy };
  const judged = output ? judgeOutput(output, judge) : undefined;
  if (judged?.fallback) {
    applied.result = { source: "default", output: request.runDefault(), notice: fallbackNotice(name, judged.fallback) };
  } else if (judged?.aware) {
    applied.shown = judged.shown;
  }
  if (judged && judged.rejected.length > 0) applied.notes = [rejectedLine(judged.rejected)];
  const pinned = pinnedOutcome(refs ?? [], output?.pinned, output !== undefined && Array.isArray(negotiated?.refs), judge);
  applied.pinned = { shown: pinned.shown, failed: pinned.failed };

  const outcome = output
    ? judged?.fallback ? "fallback" : judged?.aware ? "verified" : "plugin"
    : link.mode !== "enabled" ? "adapter-unavailable" : request.sent ? "plugin-failed" : "not-registered";
  writeKnowledgeLog(request.repoRoot, {
    at: new Date().toISOString(),
    mode: link.mode,
    phase: request.phase ?? null,
    plugin: name ?? null,
    inputHash: negotiated ? inputHash(request.repoRoot, negotiated, head) : null,
    head: head ?? null,
    outcome,
    ...(judged?.fallback ? { fallback: judged.fallback } : {}),
    verified: judged?.verified ?? [],
    rejected: judged?.rejected ?? [],
    pinned: pinned.records,
    ...diagnosticsOf(output),
  });
  return applied;
}

// ---- shadow ----

export interface ShadowRequest {
  repoRoot: string;
  manifest: Manifest;
  index: KnowledgeIndex;
  phase?: ContextDocsPhase;
  limit: number;
  /** enabled 가 보냈을 입력과 같은 것(협의 전) */
  input: () => DocsInput;
  /** 반환 줄이 실은 항목 — 비교의 기준 */
  baseline: readonly ShownItem[];
  /** 기준 항목의 출처 — "default" 또는 "plugin <이름>" */
  baselineSource: string;
  /** 기본 검색 순위 — 후보가 기본 검색으로 돌아갔을 때 보였을 항목 */
  defaults: () => Hit[];
  fromPlugin: (section: DocSection) => Hit | DocSection;
}

interface RangeRecord { path: string; start?: number; end?: number; label: string }

function rangeOf(item: ShownItem): RangeRecord {
  if (isPartialRange(item)) return { path: item.path, start: item.start, end: item.end, label: `${item.heading} (부분)` };
  if ("score" in item) {
    if (item.entry) return { path: item.entry.path, start: item.entry.line, end: item.entry.end, label: `\`${item.entry.key}\` ${item.entry.title}` };
    return { path: item.section!.path, start: item.section!.line, end: item.section!.end, label: `## ${item.section!.heading}` };
  }
  return { path: clamp(item.path), label: `## ${clamp(item.heading)}` };
}

/** 같은 경로이고 줄 범위가 겹치는가 — 범위가 없는 항목(인덱스로 되찾지 못한 절)은 그 문서 전체로 본다 */
function overlaps(a: RangeRecord, b: RangeRecord): boolean {
  if (a.path !== b.path) return false;
  if (a.start === undefined || b.start === undefined) return true;
  return a.start <= b.end! && b.start <= a.end!;
}

function comparisonOf(baseline: RangeRecord[], candidate: RangeRecord[]) {
  return {
    baseline: baseline.length,
    candidate: candidate.length,
    overlap: baseline.reduce((sum, a) => sum + candidate.filter((b) => overlaps(a, b)).length, 0),
    onlyBaseline: baseline.filter((a) => !candidate.some((b) => overlaps(a, b))).length,
    onlyCandidate: candidate.filter((b) => !baseline.some((a) => overlaps(a, b))).length,
  };
}

/**
 * shadow — 반환 줄을 다 만든 뒤에 부른다. 같은 입력(협의된 입력·HEAD·등록 문서 내용)의 비교가 기록 끝에 이미 있으면 부르지 않는다.
 * 무엇이 실패해도 던지지 않고 반환 줄에 닿지 않는다.
 */
export function shadowDocs(request: ShadowRequest): void {
  try {
    const name = shadowFor(request.manifest, "context.docs");
    if (!name) return;
    const plugin = readStore().plugins[name];
    if (!plugin || !plugin.slots.includes("context.docs")) return;
    const full = request.input();
    const negotiated = negotiatedInput("context.docs", full as unknown as Record<string, unknown>, plugin.adapter.accepts);
    const head = headCommit(request.repoRoot);
    // 등록이 바뀌면(다시 등록·어댑터 갱신) 같은 질의라도 다시 비교한다
    const hash = inputHash(request.repoRoot, negotiated, head, [plugin.command.join("\0"), plugin.adapter.version, plugin.adapter.describedAt].join("\n"));
    if (recentShadow(request.repoRoot, hash)) return;
    const call = callShadow(request.repoRoot, request.manifest, "context.docs", () => full);
    if (!call) return;
    const judge: Judge = {
      docs: new Set(full.docs.map((doc) => doc.path)),
      read: docReader(request.repoRoot),
      head,
      index: request.index,
      limit: request.limit,
      fromPlugin: request.fromPlugin,
    };
    const output = call.ok ? call.output : undefined;
    const judged = output ? judgeOutput(output, judge) : undefined;
    // enabled 였다면 보였을 것 — 실패·기본 검색 요청이면 기본 검색, 참조를 쓰는 출력이면 확인한 범위, 아니면 기존 경로
    const items: ShownItem[] = !output || judged?.fallback
      ? request.defaults().slice(0, request.limit)
      : judged?.aware ? judged.shown : output.sections.slice(0, request.limit).map(request.fromPlugin);
    const baseline = request.baseline.map((item) => ({ ...rangeOf(item), source: request.baselineSource }));
    const candidate = items.map(rangeOf);
    const pinned = full.refs && full.refs.length > 0
      ? pinnedOutcome(full.refs, output?.pinned, output !== undefined && Array.isArray(negotiated.refs), judge).records
      : [];
    writeKnowledgeLog(request.repoRoot, {
      at: new Date().toISOString(),
      mode: "shadow",
      phase: request.phase ?? null,
      plugin: name,
      inputHash: hash,
      head: head ?? null,
      outcome: call.ok ? "compared" : "shadow-failed",
      ...(judged?.fallback ? { fallback: judged.fallback } : {}),
      verified: judged?.verified ?? [],
      rejected: judged?.rejected ?? [],
      pinned,
      ...diagnosticsOf(output),
      durationMs: call.durationMs,
      baseline,
      candidate: {
        ok: call.ok,
        ...(call.error ? { error: call.error } : {}),
        ...(judged?.fallback ? { fallback: judged.fallback.code } : {}),
        verified: judged?.verified ?? [],
        rejected: judged?.rejected ?? [],
        items: candidate,
      },
      comparison: comparisonOf(baseline, candidate),
    });
  } catch {
    // 비교는 조언의 조언이다 — 무엇이 깨져도 context 를 세우지 않는다
  }
}

// ---- 기록 ----

/**
 * 입력 해시 — 협의된 입력 JSON · HEAD · 등록 문서(입력의 docs 경로) 내용 · (shadow 는) 등록 지문. 같은 해시면 같은 어댑터에 같은 질의를
 * 같은 문서로 한 것이다.
 */
function inputHash(repoRoot: string, negotiated: Record<string, unknown>, head: string | undefined, registration = ""): string {
  const docs = Array.isArray(negotiated.docs) ? (negotiated.docs as { path?: unknown }[]) : [];
  const contents = docs.map((doc) => {
    const path = typeof doc.path === "string" ? doc.path : "";
    if (!safeDocPath(path)) return `${path}\0invalid`;
    try {
      return `${path}\0${createHash("sha256").update(readFileSync(join(repoRoot, path))).digest("hex")}`;
    } catch {
      return `${path}\0missing`;
    }
  });
  return createHash("sha256").update([JSON.stringify(negotiated), head ?? "", ...contents, ...(registration ? [registration] : [])].join("\n"), "utf8").digest("hex");
}

/** 어댑터 진단 — 기록에만 남긴다. 64 KiB 를 넘으면 잘라 문자열로 */
function diagnosticsOf(output: DocsOutput | undefined): { diagnostics?: unknown } {
  if (!output?.diagnostics) return {};
  const text = JSON.stringify(output.diagnostics);
  return Buffer.byteLength(text, "utf8") <= LOG_RESPONSE_BYTES
    ? { diagnostics: output.diagnostics }
    : { diagnostics: `${Buffer.from(text, "utf8").subarray(0, LOG_RESPONSE_BYTES).toString("utf8")}…(잘림)` };
}

function logLines(repoRoot: string): string[] {
  try {
    return readFileSync(join(repoRoot, KNOWLEDGE_LOG), "utf-8").split("\n").filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

/**
 * 같은 입력의 비교가 끝 SHADOW_RECENT_LINES 줄 안에 있는가 — 성공한 비교는 그것으로 충분하고, 실패한 비교는 SHADOW_RETRY_MS 동안만
 * 다시 부르지 않는다(설정·색인을 고친 뒤에는 다시 비교하되, 고장 난 연결이 context 마다 마감만큼 늦추지 않게).
 */
function recentShadow(repoRoot: string, hash: string): boolean {
  const now = Date.now();
  return logLines(repoRoot).slice(-SHADOW_RECENT_LINES).some((line) => {
    try {
      const record = JSON.parse(line) as { mode?: unknown; inputHash?: unknown; outcome?: unknown; at?: unknown };
      if (record.mode !== "shadow" || record.inputHash !== hash) return false;
      if (record.outcome === "compared") return true;
      const at = typeof record.at === "string" ? Date.parse(record.at) : Number.NaN;
      return Number.isFinite(at) && now - at < SHADOW_RETRY_MS;
    } catch {
      return false;
    }
  });
}

/** 기록 한 줄을 더한다 — 끝 LOG_LINES 줄만 남긴다. 쓰지 못해도 던지지 않는다(판정은 이미 났다) */
function writeKnowledgeLog(repoRoot: string, record: Record<string, unknown>): void {
  try {
    const path = join(repoRoot, KNOWLEDGE_LOG);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
    const lines = logLines(repoRoot);
    if (lines.length > LOG_LINES) writeFileSync(path, `${lines.slice(-LOG_LINES).join("\n")}\n`, "utf-8");
  } catch {
    // 기록 실패는 삼킨다
  }
}
