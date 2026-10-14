import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { isAbsolute, join, posix, resolve } from "path";
import { z } from "zod";

import { writeAtomic } from "../core/atomic";
import { draftFile, findingsFile, questionsFile, removeDraft, STATE_DIR, workDocsDir } from "./layout";
import { acquireLock } from "./lock";
import { loadPlanning } from "./planningState";
import { parseQuestions } from "./questions";
import { REVIEW_DOC_FILE } from "./review";
import { TIMING } from "./retryPolicy";
import { sensitiveProblems } from "./sensitiveText";
import { Stop } from "./stop";
import { loadWork } from "./work";
import type { Work } from "./work";
import { currentAttempt } from "./workAttempt";

/**
 * 진행 중 발견 보고 — 구현·테스트·리뷰 중 본 것을 구조로 남긴다. **보고이지 권한이 아니다**: 분류·차단 표시가 쓰기 경계·승인·한도를
 * 바꾸지 않는다(hook·승인 해시·재시도 한도는 이 파일을 읽지 않는다). 처리는 분류마다 이미 있는 길로 간다.
 *
 * - a 승인 범위 안의 결함·테스트 누락 → 기존 수정·검증 절차(verify)와 그 한도
 * - b 로컬 요구·계획 변경 → 사람 판단 뒤 `back plan` 의 재계획·재승인
 * - c 다른 프로젝트·공유 계약 영향 → 외부 조정이 필요하다는 보고만(다른 저장소를 고치지 않는다)
 * - d 무관한 개선 → 후속 후보. 현재 작업을 막지 않는다(차단으로 등록할 수 없다)
 *
 * 자리는 `.code-agent/work/<ID>/findings.json` — 반영 커밋에 작업 상태와 함께 들어간다. ID 는 내용의 정체(작업·분류·제목·근거)에서
 * 정한다: 같은 보고를 다시 보내면 같은 ID 라 하나로 남고, 근거가 다른 발견은 ID 가 달라 합쳐지지 않는다. 고칠 때는 ID 와 지금 버전을
 * 함께 보내야 한다(`expectVersion`) — 오래된 갱신이 새 내용을 덮지 않게. 리뷰 지적·질문·계획 시도와 같은 것은 내용을 옮기지 않고
 * `links` 로 가리킨다(진실 원천을 둘로 만들지 않는다).
 */

export const FINDING_CLASSES = ["a", "b", "c", "d"] as const;
export type FindingClass = (typeof FINDING_CLASSES)[number];
export const FINDING_CLASS_LABEL: Readonly<Record<FindingClass, string>> = {
  a: "승인 범위 안 결함·테스트 누락", b: "로컬 요구·계획 변경", c: "다른 프로젝트·공유 계약 영향", d: "무관한 개선",
};
/** 처리 경로 — 기계용 고정 코드 */
export const FINDING_ROUTE: Readonly<Record<FindingClass, string>> = { a: "verify-loop", b: "replan", c: "external", d: "follow-up" };
export const FINDING_ROUTE_TEXT: Readonly<Record<FindingClass, string>> = {
  a: "기존 수정·검증 절차(verify)와 그 한도로 고칩니다 — 이 보고는 한도·쓰기 범위를 늘리지 않습니다",
  b: "사람이 판단한 뒤 code-agent back plan 으로 재계획·재승인합니다 — 등록만으로 계획 밖 파일을 쓸 수 없습니다",
  c: "외부 조정이 필요하다는 보고입니다 — 다른 저장소를 직접 고치지 않습니다",
  d: "후속 후보로 남깁니다 — 현재 작업을 막지 않습니다",
};
export const FINDING_STATUSES = ["open", "resolved", "dismissed"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export const FINDING_STATUS_LABEL: Readonly<Record<FindingStatus, string>> = { open: "열림", resolved: "해결", dismissed: "기각" };
export const EVIDENCE_KINDS = ["file", "command", "test", "review", "question", "verify", "log", "observation"] as const;
export const FINDING_ID = /^FND-[a-f0-9]{10}$/;
/** links 가 가리키는 기록 — 리뷰 지적(09-review.md)·질문(questions.md)·계획 시도(dispatchId) */
const LINK = /^(review|question|attempt):(\S+)$/;

const text = (max: number) => z.string().trim().min(1).max(max);
export const FindingDraftSchema = z.object({
  id: z.string().regex(FINDING_ID).optional(),
  expectVersion: z.number().int().min(1).optional(),
  class: z.enum(FINDING_CLASSES),
  title: text(120),
  detail: text(600),
  evidence: z.array(z.object({ kind: z.enum(EVIDENCE_KINDS), ref: text(200), note: text(200).optional() }).strict()).min(1).max(10),
  affects: z.object({
    paths: z.array(text(200)).max(20).default([]),
    features: z.array(text(80)).max(10).default([]),
    contracts: z.array(text(120)).max(10).default([]),
  }).strict().default({ paths: [], features: [], contracts: [] }),
  related: z.array(z.object({ name: text(100), source: text(200).optional() }).strict()).max(10).default([]),
  blocking: z.boolean().default(false),
  blockingReason: text(300).optional(),
  proposal: text(400),
  status: z.enum(FINDING_STATUSES).default("open"),
  resolution: text(300).optional(),
  links: z.array(z.string().regex(LINK)).max(10).default([]),
  runId: text(100).optional(),
}).strict();
export type FindingDraft = z.infer<typeof FindingDraftSchema>;

export interface RelatedProject { name: string; source?: string; state: "known" | "unconfirmed" }
export interface FindingRecord {
  id: string;
  version: number;
  /** 정체 해시 — 작업·분류·제목·근거. 같은 보고의 재전송을 가린다 */
  key: string;
  class: FindingClass;
  title: string;
  detail: string;
  evidence: FindingDraft["evidence"];
  affects: FindingDraft["affects"];
  related: RelatedProject[];
  blocking: boolean;
  blockingReason?: string;
  proposal: string;
  status: FindingStatus;
  resolution?: string;
  route: string;
  /** 사람 판단이 필요한가 — b·c 와 차단으로 등록된 열린 발견. 판단 자체는 기존 동의·되감기 길로 받는다 */
  humanDecision: boolean;
  origin: { work: string; target: string; phase: string; stage?: string; task?: string; attempt: string };
  links: string[];
  /** 외부 실행 ID 등 상관관계 메타데이터 — 판정·권한·중복 판단에 쓰지 않는다 */
  correlation?: { runId: string };
  reportedAt: string;
  updatedAt: string;
  history: { version: number; at: string; changed: string[] }[];
}
export interface FindingsLog { version: 1; id: string; findings: FindingRecord[] }

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const norm = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();

export function findingKey(work: string, draft: Pick<FindingDraft, "class" | "title" | "evidence">): string {
  const evidence = draft.evidence.map((item) => `${item.kind}:${norm(item.ref)}`).sort();
  return sha(JSON.stringify([work, draft.class, norm(draft.title), evidence]));
}

/** 읽기 — 없으면 undefined, 깨졌거나 모르는 버전이면 Stop(조용히 새로 만들지 않는다) */
export function loadFindings(repoRoot: string, id: string): FindingsLog | undefined {
  const path = findingsFile(repoRoot, id);
  if (!existsSync(path)) return undefined;
  let value: Partial<FindingsLog>;
  try { value = JSON.parse(readFileSync(path, "utf8")) as Partial<FindingsLog>; } catch (error) {
    throw new Stop(`발견 기록을 읽을 수 없습니다 (${STATE_DIR}/work/${id}/findings.json): ${(error as Error).message} — 새로 만들지 않습니다. 파일을 사람이 확인하세요.`);
  }
  if (value?.version !== 1 || value.id !== id || !Array.isArray(value.findings)) {
    throw new Stop(`발견 기록의 형식·버전을 지원하지 않습니다 (${STATE_DIR}/work/${id}/findings.json, version ${String(value?.version)}) — 새로 만들지 않습니다.`);
  }
  return value as FindingsLog;
}

function cleanPath(path: string): string | undefined {
  const value = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (isAbsolute(path) || /^[A-Za-z]:/.test(value) || value.split("/").includes("..")) return undefined;
  return posix.normalize(value);
}

/** 관련 프로젝트 — 이 저장소의 파일(source)이 그 이름을 실제로 담고 있을 때만 known. 이름·소유자를 추측해 확정하지 않는다 */
function relatedOf(repoRoot: string, related: FindingDraft["related"]): RelatedProject[] {
  return related.map((item) => {
    const source = item.source ? cleanPath(item.source) : undefined;
    let known = false;
    if (source) {
      try {
        const full = join(repoRoot, source);
        known = existsSync(full) && readFileSync(full, "utf8").toLowerCase().includes(item.name.toLowerCase());
      } catch { known = false; }
    }
    return { name: item.name, ...(item.source ? { source: item.source } : {}), state: known ? "known" as const : "unconfirmed" as const };
  });
}

/** links 가 가리키는 기록이 실제로 있는가 — 없는 것을 가리키면 거부한다 */
function linkProblems(work: Work, links: readonly string[]): string[] {
  const problems: string[] = [];
  const id = work.active.id;
  for (const link of links) {
    const [, kind, ref] = LINK.exec(link)!;
    if (kind === "review") {
      const path = join(work.repoRoot, workDocsDir(id), REVIEW_DOC_FILE);
      const body = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (!new RegExp(`(^|[^A-Za-z0-9])${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`).test(body)) problems.push(`${link} — ${workDocsDir(id)}/${REVIEW_DOC_FILE} 에 없는 지적입니다`);
    } else if (kind === "question") {
      const path = join(work.repoRoot, questionsFile(id));
      const ids = existsSync(path) ? parseQuestions(readFileSync(path, "utf8")).map((question) => question.id) : [];
      if (!ids.includes(ref)) problems.push(`${link} — ${questionsFile(id)} 에 없는 질문입니다`);
    } else if (!(work.active.planningVersion ? loadPlanning(work).tasks.some((record) => record.attempts.some((attempt) => attempt.dispatchId === ref)) : false)) {
      problems.push(`${link} — 이 작업의 계획 시도에 없는 배정입니다`);
    }
  }
  return problems;
}

/** 고칠 수 있는 칸 — 버전 이력에 바뀐 칸 이름으로 남는다 */
const MUTABLE = ["class", "title", "detail", "evidence", "affects", "related", "blocking", "blockingReason", "proposal", "status", "resolution", "links"] as const;

function recordFrom(work: Work, draft: FindingDraft, related: RelatedProject[]): Omit<FindingRecord, "id" | "version" | "reportedAt" | "updatedAt" | "history" | "origin"> {
  return {
    key: findingKey(work.active.id, draft), class: draft.class, title: draft.title, detail: draft.detail, evidence: draft.evidence,
    affects: { paths: draft.affects.paths.map((path) => cleanPath(path)!), features: draft.affects.features, contracts: draft.affects.contracts },
    related, blocking: draft.blocking, ...(draft.blockingReason ? { blockingReason: draft.blockingReason } : {}),
    proposal: draft.proposal, status: draft.status, ...(draft.resolution ? { resolution: draft.resolution } : {}),
    route: FINDING_ROUTE[draft.class],
    humanDecision: draft.status === "open" && (draft.class === "b" || draft.class === "c" || draft.blocking),
    links: [...new Set(draft.links)].sort(),
    ...(draft.runId ? { correlation: { runId: draft.runId } } : {}),
  };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function validate(work: Work, draft: FindingDraft): void {
  const problems: string[] = [];
  if (draft.class === "d" && draft.blocking) problems.push("무관한 개선(d)은 현재 작업을 막지 않습니다 — blocking 을 빼세요");
  if (draft.blocking && !draft.blockingReason) problems.push("blocking 이면 blockingReason(무엇을 왜 막는가)이 필요합니다");
  if (draft.status !== "open" && !draft.resolution) problems.push(`${draft.status} 로 닫으려면 resolution(어떻게 처리했나)이 필요합니다`);
  const outside = draft.affects.paths.filter((path) => cleanPath(path) === undefined);
  if (outside.length) problems.push(`affects.paths 는 이 저장소 안의 상대 경로만 씁니다 — 다른 저장소는 related 에 이름으로: ${outside.join(", ")}`);
  problems.push(...linkProblems(work, draft.links));
  problems.push(...sensitiveProblems({
    title: draft.title, detail: draft.detail, proposal: draft.proposal, blockingReason: draft.blockingReason, resolution: draft.resolution,
    ...Object.fromEntries(draft.evidence.flatMap((item, index) => [[`evidence.${index}.ref`, item.ref], [`evidence.${index}.note`, item.note]])),
  }));
  if (problems.length) throw new Stop(`발견을 기록하지 않았습니다:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
}

function describe(record: FindingRecord): string[] {
  return [
    `${record.id} v${record.version} · [${record.class} ${FINDING_CLASS_LABEL[record.class]}] ${FINDING_STATUS_LABEL[record.status]}` +
      `${record.blocking ? ` · 차단(${record.blockingReason})` : ""}${record.humanDecision ? " · 사람 판단 필요" : ""} — ${record.title}`,
    `  처리: ${FINDING_ROUTE_TEXT[record.class]}`,
    ...(record.related.length ? [`  관련 프로젝트: ${record.related.map((item) => `${item.name}(${item.state === "known" ? `확인: ${item.source}` : "미확정"})`).join(", ")}`] : []),
    ...(record.links.length ? [`  연결: ${record.links.join(", ")}`] : []),
  ];
}

const REPORT_NOTE = "분류는 보고일 뿐 권한이 아닙니다 — 쓰기 경계·승인·재시도 한도는 그대로입니다.";

/** `finding report <초안.json>` — 새 발견을 쓰거나(같은 보고면 그대로), id·expectVersion 으로 고친다 */
export function findingReport(repoRoot: string, file: string): string {
  const work = loadWork(repoRoot);
  if (!work) throw new Stop("진행 중인 작업이 없습니다 — 발견은 그 작업 안에서 보고합니다.");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8")); } catch (error) {
    throw new Stop(`발견 초안을 읽을 수 없습니다 (${file}): ${(error as Error).message}`);
  }
  const parsed = FindingDraftSchema.safeParse(raw);
  if (!parsed.success) throw new Stop(`발견 초안 형식이 맞지 않습니다:\n${parsed.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n")}\n\n${FINDING_FORMAT}`);
  const draft = parsed.data;
  validate(work, draft);
  const { active } = work;
  const path = findingsFile(repoRoot, active.id);
  const release = acquireLock(`${path}.lock`, { waitMs: TIMING.lockWaitMs, ageReclaim: true, label: "발견 기록", display: `${STATE_DIR}/work/${active.id}/findings.json.lock` });
  try {
    const log = loadFindings(repoRoot, active.id) ?? { version: 1 as const, id: active.id, findings: [] };
    const related = relatedOf(repoRoot, draft.related);
    const fields = recordFrom(work, draft, related);
    const at = new Date().toISOString();
    // 기록이 끝난 뒤에만 정해진 자리의 초안을 지운다(거부되면 남겨 고치게)
    const dropped = (): string => (removeDraft(repoRoot, active.id, "finding", file) ? ` · 초안 ${draftFile(active.id, "finding")} 는 지웠습니다` : "");
    if (draft.id) {
      const index = log.findings.findIndex((record) => record.id === draft.id);
      if (index < 0) throw new Stop(`고칠 발견이 없습니다: ${draft.id}`);
      const current = log.findings[index];
      if (draft.expectVersion === undefined) throw new Stop(`${draft.id} 를 고치려면 expectVersion(지금 v${current.version})이 필요합니다.`);
      if (draft.expectVersion !== current.version) throw new Stop(`오래된 갱신입니다 — ${draft.id} 는 지금 v${current.version} 입니다(보낸 기대 v${draft.expectVersion}). code-agent finding list 로 다시 읽고 고치세요.`);
      const other = log.findings.find((record) => record.key === fields.key && record.id !== current.id);
      if (other) throw new Stop(`고친 내용이 다른 발견(${other.id})과 같은 보고가 됩니다 — 그 발견을 고치세요.`);
      const changed = MUTABLE.filter((name) => !same((current as unknown as Record<string, unknown>)[name], (fields as unknown as Record<string, unknown>)[name]));
      if (changed.length === 0 && same(current.correlation, fields.correlation)) return [`변경 없음: ${current.id} v${current.version}${dropped()}`, ...describe(current), REPORT_NOTE].join("\n");
      const updated: FindingRecord = { ...current, ...fields, version: current.version + 1, updatedAt: at, history: [...current.history, { version: current.version + 1, at, changed: changed.length ? [...changed] : ["correlation"] }] };
      if (!fields.blockingReason) delete updated.blockingReason;
      if (!fields.resolution) delete updated.resolution;
      if (!fields.correlation) delete updated.correlation;
      log.findings[index] = updated;
      writeAtomic(path, `${JSON.stringify(log, null, 2)}\n`);
      return [`갱신: ${updated.id} v${updated.version} (바뀐 칸: ${changed.join(", ") || "correlation"})${dropped()}`, ...describe(updated), REPORT_NOTE].join("\n");
    }
    const existing = log.findings.find((record) => record.key === fields.key);
    if (existing) {
      const changed = MUTABLE.filter((name) => !same((existing as unknown as Record<string, unknown>)[name], (fields as unknown as Record<string, unknown>)[name]));
      if (changed.length === 0) return [`이미 같은 보고가 있습니다: ${existing.id} v${existing.version} — 새로 만들지 않았습니다.${dropped()}`, ...describe(existing), REPORT_NOTE].join("\n");
      throw new Stop(`같은 발견(${existing.id} v${existing.version})이 이미 있고 내용(${changed.join(", ")})이 다릅니다 — 고치려면 "id": "${existing.id}", "expectVersion": ${existing.version} 을 넣어 다시 보내세요.`);
    }
    let id = `FND-${fields.key.slice(0, 10)}`;
    for (let n = 11; log.findings.some((record) => record.id === id); n++) id = `FND-${fields.key.slice(n - 10, n)}`;
    const attempt = currentAttempt(work, active.planningVersion ? loadPlanning(work) : undefined);
    const record: FindingRecord = {
      id, version: 1, ...fields,
      origin: { work: active.id, target: active.target, phase: active.phase, ...(active.stage ? { stage: active.stage } : {}), ...(active.task ? { task: active.task } : {}), attempt: attempt.id },
      reportedAt: at, updatedAt: at, history: [{ version: 1, at, changed: [] }],
    };
    log.findings.push(record);
    writeAtomic(path, `${JSON.stringify(log, null, 2)}\n`);
    return [`기록: ${record.id} v1${dropped()}`, ...describe(record), REPORT_NOTE].join("\n");
  } finally {
    release();
  }
}

export interface FindingSummary { total: number; open: number; blocking: number; humanDecision: number; blockingHuman: FindingRecord[] }
export function findingSummary(log: FindingsLog | undefined): FindingSummary {
  const findings = log?.findings ?? [];
  const open = findings.filter((record) => record.status === "open");
  return {
    total: findings.length, open: open.length, blocking: open.filter((record) => record.blocking).length,
    humanDecision: open.filter((record) => record.humanDecision).length,
    blockingHuman: open.filter((record) => record.blocking && (record.class === "b" || record.class === "c")),
  };
}

/** status 한 줄 — 발견이 없으면 undefined */
export function findingStatusLine(repoRoot: string, id: string): string | undefined {
  let log: FindingsLog | undefined;
  try { log = loadFindings(repoRoot, id); } catch (error) { return `발견: 기록을 읽을 수 없습니다 — ${(error as Error).message.split("\n")[0]}`; }
  const summary = findingSummary(log);
  if (summary.total === 0) return undefined;
  return `발견: 열린 ${summary.open}건${summary.blocking ? ` (차단 ${summary.blocking})` : ""}${summary.humanDecision ? ` · 사람 판단 필요 ${summary.humanDecision}` : ""} / 전체 ${summary.total} — code-agent finding list`;
}

export const FINDING_FORMAT = `발견 초안(JSON) — doc/work/<ID>/finding.draft.json 에 쓰고 report 에 그 경로를 준다(기록하면 코드가 그 초안을 지운다). 범위 밖에서 본 것을 남긴다(보고일 뿐 권한이 아니다):
{
  "class": "a 승인 범위 안 결함·테스트 누락 | b 로컬 요구·계획 변경 | c 다른 프로젝트·공유 계약 영향 | d 무관한 개선",
  "title": "한 줄 (120자)", "detail": "무엇을 봤나 (600자)",
  "evidence": [{ "kind": "file|command|test|review|question|verify|log|observation", "ref": "src/a.ts:12 또는 명령·로그 경로", "note": "선택" }],
  "affects": { "paths": ["이 저장소 경로"], "features": ["FEAT-…"], "contracts": ["공유 API·스키마 이름"] },
  "related": [{ "name": "관련 프로젝트 이름", "source": "그 이름이 적힌 이 저장소 파일(선택 — 없으면 미확정)" }],
  "blocking": false, "blockingReason": "막는다면 무엇을 왜",
  "proposal": "제안 조치 (400자)",
  "links": ["review:F2", "question:Q3", "attempt:<dispatchId>"],
  "status": "open | resolved | dismissed (닫으면 resolution 필요)",
  "id": "FND-… (고칠 때)", "expectVersion": 1, "runId": "외부 실행 ID(선택 — 상관관계 메타데이터일 뿐)"
}
- ID 는 작업·분류·제목·근거에서 코드가 정한다 — 같은 보고를 다시 보내면 하나로 남는다. 고칠 때는 id 와 지금 버전(expectVersion)을 함께 보낸다.
- 리뷰 지적·질문·계획 시도와 같은 것이면 내용을 옮기지 말고 links 로 가리킨다. 관련 프로젝트를 모르면 이름만(미확정) — 추측해 확정하지 않는다.`;

/** `finding list [--json] [--work <ID>]` — 사람용 목록 또는 기계용 JSON(읽기 전용) */
export function findingList(repoRoot: string, options: { json?: boolean; work?: string } = {}): string {
  if (options.work !== undefined && (!/^[A-Za-z0-9._-]+$/.test(options.work) || /^\.+$/.test(options.work))) throw new Stop(`작업 ID 가 아닙니다: ${options.work.slice(0, 80)}`);
  const id = options.work ?? loadWork(repoRoot)?.active.id;
  if (!id) throw new Stop("진행 중인 작업이 없습니다 — 반영한 작업의 발견은 code-agent finding list --work <ID>");
  const log = loadFindings(repoRoot, id);
  if (options.json) return JSON.stringify({ schema: "code-agent.findings", schemaVersion: 1, work: id, findings: log?.findings ?? [] }, null, 2);
  if (!log || log.findings.length === 0) return `${id} 의 발견 보고가 없습니다.`;
  const summary = findingSummary(log);
  return [
    `${id} 발견 ${summary.total}건 · 열림 ${summary.open} · 차단 ${summary.blocking} · 사람 판단 필요 ${summary.humanDecision}`,
    "",
    ...log.findings.flatMap(describe),
    "",
    REPORT_NOTE,
  ].join("\n");
}

export function finding(repoRoot: string, args: string[]): string {
  const [action, ...rest] = args;
  if (action === undefined) return `사용법: code-agent finding report <초안.json> | list [--json] [--work <ID>]\n\n${FINDING_FORMAT}`;
  if (action === "report" && rest.length === 1) return findingReport(repoRoot, rest[0]);
  if (action === "list") {
    const json = rest.includes("--json");
    const at = rest.indexOf("--work");
    const work = at >= 0 ? rest[at + 1] : undefined;
    const known = rest.filter((arg, index) => arg === "--json" || arg === "--work" || (at >= 0 && index === at + 1));
    if (known.length === rest.length && (at < 0 || (work && !work.startsWith("--")))) return findingList(repoRoot, { json, work });
  }
  throw new Stop("사용법: code-agent finding report <초안.json> | list [--json] [--work <ID>]");
}
