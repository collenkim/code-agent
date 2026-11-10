/**
 * `context.docs` 의 지식 검색 연결 — contextRender `docSectionLines` 가 부른다.
 *
 * 세 모드가 있고 판단은 저장소 선언(code-agent.json `plugins`)이 한다.
 * - off(선언 없음): 어댑터를 부르지 않는다. master 인계 참조가 없으면 읽거나 쓰는 것이 없고 기본 검색의 화면 그대로다. 인계 참조가
 *   남아 있으면 생산자를 몰래 부르지 않고 모두 adapter-off 로 처리해 required 참조를 재확인 블록에 싣고 검증 기록에 남긴다(진행 게이트가
 *   그 작업만 멈춘다 — knowledgeGate.ts).
 * - enabled(`slots`): 어댑터 출력 중 출처 참조(`ref`)가 있는 섹션은 **지금 파일과 내용 해시가 맞은 범위만** 싣는다. 인덱스 항목·절과
 *   경로·줄 범위가 꼭 맞으면 그 항목(줄 범위·최신성·반드시 적용하는 정책 연결이 그대로 붙고, 구분·상태는 code-agent 문서가 정본이라
 *   어댑터 상태는 낮추는 신호만 덧붙인다), 아니면 확인한 범위만 부분 범위로 — 긴 원본 절 전체로 넓히지 않는다.
 *   참조를 쓰지 않는 어댑터의 출력은 기존 경로(fromPlugin) 그대로다.
 * - shadow(`shadow`): 반환 줄을 다 만든 뒤 따로 불러 같은 검증으로 "enabled 였다면 보였을 범위"를 계산해 비교 기록만 남긴다.
 *   화면·승인·계획 입력·동의 스냅샷에 아무것도 더하지 않는다.
 *
 * 진단·비교 기록은 `.code-agent/log/knowledge/context.jsonl` 에 쓴다 — Git 이 무시하고(init 의 `log/`) 동의 스냅샷도 빼는 자리라 작업
 * 상태를 흔들지 않는다. 본문은 싣지 않는다(항목 id·경로·줄 범위·사유·제목만). 인계 참조의 검증 결과는 진행 게이트가 읽는 검증 기록
 * (`.code-agent/master/knowledge/<작업 ID>.json`, 연동 폴더의 `.gitignore` 가 무시하고 동의 스냅샷도 뺀다)에 따로 쓴다 — 진단 로그는 근거가
 * 아니다. shadow 는 검증 기록을 쓰지 않는다.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { dirname, isAbsolute, join, posix, resolve } from "path";

import { writeAtomic } from "../core/atomic";

import type { Manifest } from "../core/manifest";
import type { Hit, KnowledgeIndex } from "./knowledgeIndex";
import { cautionLabel, commitNote, docReader, headCommit, headingAt, repoRelativePath, safeDocPath, statusLabel, verifySectionRef } from "./knowledgeRefs";
import type { DocReader, RejectedRef, VerifiedRef } from "./knowledgeRefs";
import { knowledgeGate, knowledgeRecordFile, KNOWLEDGE_RECORD_SCHEMA, KNOWLEDGE_RECORD_VERSION, rangeHash, type KnowledgeGate, type KnowledgeRecord } from "./knowledgeGate";
import { loadActive, STATE_DIR } from "./layout";
import { knowledgeRefKey } from "./master/protocol";
import { ensureMasterDir } from "./master/store";
import { managedKnowledgeOf } from "./master/workKnowledge";
import { LOG_LINES, LOG_RESPONSE_BYTES, MAX_OUTPUT_ITEMS } from "./plugins/protocol";
import type { ContextDocsPhase, DocSection, KnowledgeRef, PinnedResult, SlotInput, SlotOutput } from "./plugins/protocol";
import { callShadow, callSlot, clamp, knowledgeLink, negotiatedInput, shadowFor, type KnowledgeLink } from "./plugins/run";
import type { SlotResult } from "./plugins/run";
import { readStore, type StoredPlugin } from "./plugins/store";

/** 지식 검색 진단·비교 기록 — 끝 LOG_LINES 줄만 남긴다 */
export const KNOWLEDGE_LOG = posix.join(STATE_DIR, "log", "knowledge", "context.jsonl");
/** 성공한 shadow 비교를 같은 입력(입력·HEAD·문서·등록·어댑터 설정·색인 지문)으로 다시 쓰는 시간 — 지나면 다시 비교한다 */
export const SHADOW_SUCCESS_TTL_MS = 60 * 60 * 1000;
/** 실패한 shadow 를 같은 입력으로 다시 부르기까지 기다리는 시간 — 설정을 고치면 지문이 바뀌어 바로 다시 부른다 */
export const SHADOW_RETRY_MS = 10 * 60 * 1000;
/** 이 환경변수가 `1` 이면 같은 입력의 비교가 남아 있어도 shadow 를 다시 부른다(강제 갱신) */
export const SHADOW_REFRESH_ENV = "CODE_AGENT_SHADOW_REFRESH";

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

/** master 가 이 작업에 인계한 지식 참조(정규화한 꼴) — 없으면 undefined(읽기만 한다) */
export function handoffRefs(repoRoot: string): KnowledgeRef[] | undefined {
  try {
    return managedKnowledgeOf(repoRoot)?.refs;
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
  root: string;
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
interface PinnedRecord { itemId: string; segmentId?: string; required: boolean; ok: boolean; reason?: string; path?: string; start?: number; end?: number; how?: string; sha256?: string }
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
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref.commit) && /^[0-9a-f]{64}$/.test(ref.itemSha256);

interface Pinned {
  shown: ShownItem[];
  failed: { itemId: string; segmentId?: string; reason: string; required: boolean }[];
  records: PinnedRecord[];
}

/**
 * 참조를 어댑터에 보내지 못한 까닭 — 생산자를 부르지 않았거나 부르지 못한 경우를 가른다(진행 게이트의 어댑터 갈래).
 * off·shadow 는 인계 참조를 어댑터에 보내지 않는다(생산자를 몰래 부르지 않는다).
 */
function unavailableReason(link: KnowledgeLink, output: DocsOutput | undefined): string {
  if (link.mode !== "enabled") return "adapter-off";
  if (!link.registered) return "adapter-unregistered";
  if (!link.refs) return "adapter-unsupported";
  return output === undefined ? "adapter-failed" : "not-returned";
}

/**
 * 인계 참조마다 어댑터가 되찾은 결과를 다시 대조한다 — 같은 항목(·분할) id·세대·커밋·항목 해시·(형식 2면) 색인 식별·분할 해시이고, 그
 * 범위가 지금 파일과 맞아야 확인이다. 참조를 보내지 못한 호출이면 전부 `unavailable` 사유다(adapter-off·adapter-unregistered·
 * adapter-unsupported·adapter-failed).
 */
function pinnedOutcome(refs: readonly KnowledgeRef[], results: PinnedResult[] | undefined, unavailable: string | undefined, judge: Judge | undefined): Pinned {
  const pinned: Pinned = { shown: [], failed: [], records: [] };
  const seen = new Set<string>();
  for (const ref of refs) {
    const segment = ref.segmentId ? { segmentId: ref.segmentId } : {};
    const fail = (reason: string): void => {
      pinned.failed.push({ itemId: ref.itemId, ...segment, reason, required: ref.required });
      pinned.records.push({ itemId: ref.itemId, ...segment, required: ref.required, ok: false, reason });
    };
    // 기록에서 읽은 참조의 꼴이 깨졌으면(workKnowledge 가 빈 값으로 남긴 것) 어댑터에 묻기 전에 형식 오류다
    if (!wellFormedRef(ref)) { fail("invalid-ref"); continue; }
    if (unavailable || !judge) { fail(unavailable ?? "adapter-failed"); continue; }
    const result = results?.find((entry) => knowledgeRefKey({ itemId: entry.itemId, segmentId: entry.segmentId ?? undefined }) === knowledgeRefKey(ref));
    if (!result) { fail("not-returned"); continue; }
    if (!result.ok) { fail(reasonCode(result.reason)); continue; }
    if (!result.section) { fail("invalid-ref"); continue; }
    const found = verifySectionRef(result.section, judge.docs, judge.read);
    if (!found.ok) { fail(found.reason); continue; }
    if (found.ref.itemId !== ref.itemId) { fail("invalid-ref"); continue; }
    if (found.ref.itemSha256 !== ref.itemSha256) { fail("hash-mismatch"); continue; }
    if (found.ref.generation !== ref.generation) { fail("generation-mismatch"); continue; }
    if (found.ref.commit !== ref.commit) { fail("commit-mismatch"); continue; }
    // 형식 2 참조는 같은 DB(색인 식별)에서 되찾았을 때만 — 같은 세대 번호의 다른 DB 를 같은 근거로 보지 않는다
    if (ref.indexId !== undefined && found.ref.indexId !== ref.indexId) { fail(found.ref.indexId ? "index-mismatch" : "identity-unverifiable"); continue; }
    if ((ref.segmentId ?? null) !== (found.ref.segmentId ?? null)) { fail("invalid-ref"); continue; }
    if (ref.segmentId && found.ref.segmentSha256 !== ref.segmentSha256) { fail("hash-mismatch"); continue; }
    if (ref.path !== undefined && (found.path !== ref.path)) { fail("invalid-ref"); continue; }
    const sha = rangeHash(judge.root, found.path, found.start, found.end);
    pinned.records.push({ itemId: ref.itemId, ...segment, required: ref.required, ok: true, path: found.path, start: found.start, end: found.end, how: found.how,
      ...(typeof sha === "string" && sha !== "missing" ? { sha256: sha } : {}) });
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
    ...(required.length > 0 ? ["", RECHECK_TITLE, ...required.map((entry) => `- ${clamp(entry.segmentId ?? entry.itemId) || "(항목 id 없음)"}: ${entry.reason}`)] : []),
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
    root: request.repoRoot,
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
  const refsSent = output !== undefined && Array.isArray(negotiated?.refs);
  const pinned = pinnedOutcome(refs ?? [], output?.pinned, refsSent ? undefined : unavailableReason(link, output), judge);
  applied.pinned = { shown: pinned.shown, failed: pinned.failed };
  if (refs && refs.length > 0) recordVerification(request.repoRoot, pinned.records, "context", link);

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

// ---- 검증 기록 ----

/** 인계 참조만 다시 대조할 때 보내는 문서 수 상한 — 새 검색을 하지 않으므로 어댑터는 참조만 되찾는다 */
const VERIFY_LIMIT = 10;

/**
 * 인계 참조의 검증 결과를 진행 게이트의 검증 기록으로 남긴다 — 지금 작업이 있고, 인계가 검사를 지났고, 결과가 그 인계의 참조와 같은
 * 것일 때만(그 사이 인계가 바뀌었으면 쓰지 않는다 — 게이트가 다시 검증을 요구한다). 쓰지 못해도 던지지 않는다: 기록이 없으면 게이트는
 * 검증 전으로 보고 멈춘다.
 */
function recordVerification(root: string, records: readonly PinnedRecord[], by: KnowledgeRecord["by"], link: KnowledgeLink): void {
  let workId: string | undefined;
  try { workId = loadActive(root)?.id; } catch { workId = undefined; }
  const managed = managedKnowledgeOf(root);
  if (!workId || !managed || managed.invalid) return;
  const keys = (list: readonly { itemId: string; segmentId?: string }[]) => list.map(knowledgeRefKey).sort().join("\n");
  if (keys(managed.refs) !== keys(records)) return;
  const record: KnowledgeRecord = {
    schema: KNOWLEDGE_RECORD_SCHEMA, version: KNOWLEDGE_RECORD_VERSION, workId, digest: managed.digest, at: new Date().toISOString(), by,
    mode: link.mode, ...(link.plugin ? { plugin: link.plugin } : {}),
    refs: records.map((entry) => ({
      itemId: entry.itemId, ...(entry.segmentId ? { segmentId: entry.segmentId } : {}), required: entry.required, ok: entry.ok,
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.ok && entry.path ? { path: entry.path, start: entry.start, end: entry.end, ...(entry.sha256 ? { sha256: entry.sha256 } : {}) } : {}),
    })),
  };
  try {
    ensureMasterDir(root);
    const file = knowledgeRecordFile(root, workId);
    mkdirSync(dirname(file), { recursive: true });
    writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // 기록 실패는 삼킨다 — 게이트는 기록이 없으면 검증 전으로 본다
  }
}

/**
 * 인계 참조만 다시 검증한다(`code-agent knowledge verify`·master `knowledge verify`) — 새 검색을 하지 않는다: 요구사항 없이 인계 참조만
 * 어댑터에 보내고, 돌아온 범위를 지금 파일과 대조해 검증 기록을 쓴다. off·shadow·미등록·참조를 받지 않는 등록이면 생산자를 부르지 않고
 * 그 사유로 기록한다(게이트가 그 작업만 멈춘다). 깨진 인계는 부르지 않는다 — 재계획이 필요하다.
 */
export function verifyHandoff(root: string, manifest: Manifest, by: "verify" | "master"): KnowledgeGate {
  const managed = managedKnowledgeOf(root);
  if (!managed || managed.invalid || managed.refs.length === 0) return knowledgeGate(root);
  const link = knowledgeLink(manifest);
  const { docRefs } = require("./plugins/defaults") as typeof import("./plugins/defaults");
  const docs = docRefs(root, manifest);
  const input: DocsInput = { requirements: [], docs, limit: VERIFY_LIMIT, refs: managed.refs };
  let output: DocsOutput | undefined;
  let negotiated: Record<string, unknown> | undefined;
  if (link.mode === "enabled" && link.registered && link.refs) {
    const called = callSlot(root, manifest, "context.docs", () => input, () => ({ sections: [] }));
    output = called.source === "plugin" ? called.output : undefined;
    negotiated = negotiatedInput("context.docs", input as unknown as Record<string, unknown>, acceptsOf(link.plugin));
  }
  const judge: Judge = {
    root, docs: new Set(docs.map((doc) => doc.path)), read: docReader(root), head: headCommit(root),
    index: { entries: [], sections: [], docs: [] }, limit: VERIFY_LIMIT, fromPlugin: (section) => section,
  };
  const refsSent = output !== undefined && Array.isArray(negotiated?.refs);
  const pinned = pinnedOutcome(managed.refs, output?.pinned, refsSent ? undefined : unavailableReason(link, output), judge);
  recordVerification(root, pinned.records, by, link);
  writeKnowledgeLog(root, {
    at: new Date().toISOString(), mode: link.mode, phase: null, plugin: link.plugin ?? null, inputHash: null, head: judge.head ?? null,
    outcome: "reverified", by, verified: [], rejected: [], pinned: pinned.records, ...diagnosticsOf(output),
  });
  return knowledgeGate(root);
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
    // 등록·어댑터 설정·색인이 바뀌면(다시 등록, 설정 내용, DB 교체·재색인, 검색 설정) 같은 질의라도 다시 비교한다
    const hash = inputHash(request.repoRoot, negotiated, head, registrationFingerprint(request.repoRoot, plugin));
    if (recentShadow(request.repoRoot, hash)) return;
    const call = callShadow(request.repoRoot, request.manifest, "context.docs", () => full);
    if (!call) return;
    const judge: Judge = {
      root: request.repoRoot,
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
      ? pinnedOutcome(full.refs, output?.pinned, output !== undefined && Array.isArray(negotiated.refs) ? undefined : "adapter-off", judge).records
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
 * 같은 입력의 **가장 최근** 비교가 아직 쓸 만한가 — 성공한 비교는 SHADOW_SUCCESS_TTL_MS 동안, 실패한 비교는 SHADOW_RETRY_MS 동안만
 * 다시 부르지 않는다. 입력 해시에 등록·어댑터 설정·색인 지문이 들어 있어 설정을 고치거나 재색인하면 해시가 바뀌어 바로 다시 비교한다.
 * `CODE_AGENT_SHADOW_REFRESH=1` 이면 기록과 관계없이 다시 부른다. 갱신이 실패하면 그 실패가 최근 기록이 된다 — 옛 성공을 지금 결과로 쓰지 않는다.
 */
function recentShadow(repoRoot: string, hash: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[SHADOW_REFRESH_ENV] === "1") return false;
  const lines = logLines(repoRoot);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let record: { mode?: unknown; inputHash?: unknown; outcome?: unknown; at?: unknown };
    try { record = JSON.parse(lines[index]) as typeof record; } catch { continue; }
    if (record.mode !== "shadow" || record.inputHash !== hash) continue;
    const at = typeof record.at === "string" ? Date.parse(record.at) : Number.NaN;
    if (!Number.isFinite(at) || at > now) return false;
    return now - at < (record.outcome === "compared" ? SHADOW_SUCCESS_TTL_MS : SHADOW_RETRY_MS);
  }
  return false;
}

/** 파일 지문 — 내용 해시(작은 설정·스크립트) 또는 크기·수정 시각(DB). 없으면 missing */
function fileMark(path: string, by: "content" | "stat"): string {
  try {
    if (by === "stat") {
      const stat = statSync(path);
      return `${stat.size}:${stat.mtimeMs}`;
    }
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "missing";
  }
}

/**
 * shadow 비교의 등록 지문 — 등록(명령·어댑터 버전·describe 시각), 명령 인자 중 있는 파일의 내용, 이 저장소 경로. 기본 제공 어댑터
 * (agent-knowledge)면 어댑터 설정 파일 내용과 그 설정이 가리키는 생산자 설정 파일 내용·DB(와 WAL) 크기·수정 시각·생산자 명령 파일도 더한다
 * — 같은 경로의 설정을 고치거나 DB 를 바꾸거나 재색인하면 다른 지문이다. 생산자를 부르지 않는다(파일만 읽는다).
 */
export function registrationFingerprint(repoRoot: string, plugin: Pick<StoredPlugin, "command" | "adapter">, env: NodeJS.ProcessEnv = process.env): string {
  const parts = [`root:${resolve(repoRoot)}`, plugin.command.join("\0"), plugin.adapter.version, plugin.adapter.describedAt];
  for (const arg of plugin.command.slice(1)) {
    if (isAbsolute(arg) && existsSync(arg)) parts.push(`arg:${arg}:${fileMark(arg, "content")}`);
  }
  if (plugin.adapter.name === "agent-knowledge") {
    const at = plugin.command.indexOf("--config");
    let configPath: string;
    try {
      // 등록 명령이 넘기는 설정 위치 규칙(어댑터와 같은 순서) — `--config` → 환경변수 → 기본 자리
      const { configPathOf } = require("./plugins/agentKnowledge") as typeof import("./plugins/agentKnowledge");
      configPath = configPathOf(at >= 0 ? plugin.command[at + 1] : undefined, env).path;
    } catch {
      configPath = "";
    }
    parts.push(`config:${configPath}:${configPath ? fileMark(configPath, "content") : "missing"}`);
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(readFileSync(configPath, "utf8").replace(/^\ufeff/, "")) as Record<string, unknown>; } catch { config = {}; }
    const near = (value: unknown): string | undefined => (typeof value === "string" && value ? resolve(dirname(configPath), value) : undefined);
    for (const key of ["sourcesConfig", "retrievalConfig"]) {
      const file = near(config[key]);
      if (file) parts.push(`${key}:${fileMark(file, "content")}`);
    }
    const db = near(config.db);
    if (db) parts.push(`db:${fileMark(db, "stat")}:${fileMark(`${db}-wal`, "stat")}`);
    const command = Array.isArray(config.command) ? (config.command as unknown[]) : [];
    for (const arg of command) {
      const file = near(arg);
      if (file && existsSync(file) && statSync(file).isFile()) parts.push(`producer:${fileMark(file, "stat")}`);
    }
  }
  return parts.join("\n");
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
