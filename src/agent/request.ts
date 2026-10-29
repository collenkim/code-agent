import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "path";
import { actorName } from "./actor";
import { z } from "zod";

import { writeAtomic } from "../core/atomic";
import { APPROVALS_DIR } from "../core/approval";
import type { Presence } from "../core/approval";
import type { Manifest } from "../core/manifest";
import { errorLogProblems, KINDS, parseFrontMatter, slug, validateWorkOrder, WorkOrderError } from "../core/workOrder";
import type { WorkKind, WorkOrder } from "../core/workOrder";
import { sha } from "./docs";
// init(설치·hook 검사)은 접수 시작에서만 쓴다 — hook 이 이 모듈(loadRequestSession)을 읽으므로 지연 로드한다
import { canonical, DOCS_SESSION_FILE, loadActive, logStage, PHASES, REQUEST_SESSION_FILE, saveActive, STATE_DIR, workDocsDir, type ActiveWork } from "./layout";
import { PHASE_LABEL } from "./phaseInfo";
import { sourceItems } from "./sourceTrace";
import { Stop } from "./stop";
import { confirmOnTerminal } from "./tty";
import { loadManifestIfAny, loadWork } from "./work";
import { checkProjectDocs, docsReady } from "./docs";
import { hasUnmappedOriginal, intakeTrace } from "./intakeTrace";
import { aidlcBlock, aidlcWarning } from "./aidlc";
import { skill } from "./hostText";
import { loadTriage, requireNoTriage } from "./triageState";
import { isGitRepo } from "./git";
import { changedPaths, commitOf, type Change } from "./tree";
import { baselineFiles, hasBaseline, pendingBaselineFiles } from "./bootstrap";
import { rememberWorkIdentity, requireWorkKind, requireWorkOnCurrentBranch, workIdentity } from "./workIdentity";
import { acquireLock } from "./lock";
import { deliveredCycle } from "./cycles";
import { appendRevision, applyChanges, changeLine, changeSummary, initialSnapshot, legacyDocument, normalizeText, readRevisions, replaceSnapshot,
  SECTION_LABEL, SECTIONS, textHash, touchedIds, type Change as RevisionChange, type DraftChange, type OriginalText, type RequirementItem, type RevisionDocument, type RevisionRecord,
  type Section } from "./requirementRevisions";

/**
 * 요구사항 접수 — 13단계의 1.
 *
 * 사람은 요구사항을 **말로** 준다(서술 · 붙여넣은 티켓 · 파일). 모델이 그것을 `request.json` 으로 정리하고,
 * 코드가 지시서 규칙으로 검사해 `requirement.md` 를 렌더하고, 사람이 현재 호스트 세션의 선택으로 확정한다. 확정된 요구사항만
 * `code-agent start` 가 받는다 — 모델이 지시서를 지어내 스스로 시작하는 길과, 정리하다 원문과 뜻이 달라지는
 * 길이 같은 자리(사람의 확정)에서 닫힌다.
 *
 * 접수 동안에는 아직 작업 커서가 없다. 그래서 문서 세션처럼 **접수 세션**을 열고, hook 이 그 작업 폴더 밖과
 * 지시서 자체에 대한 쓰기를 막는다.
 */

export { loadRequestSession, type RequestSession } from "./requestSession";
import { loadRequestSession, type RequestSession } from "./requestSession";
import { recordEvent } from "./timeline";

/** 폴더 이름 · 브랜치 이름(`<kind>/<ID>`)이 되는 값이라 경로 조각으로 안전한 글자만 받는다 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function requestDraftFile(id: string): string {
  return posix.join(workDocsDir(id), "request.json");
}

export function requirementFile(id: string): string {
  return posix.join(workDocsDir(id), "requirement.md");
}

/** 확정 원장 — 이 작업의 승인 스냅샷 디렉토리 안이라 반영 커밋에 함께 들어간다 */
export function requestLedgerFile(repoRoot: string, id: string): string {
  return join(repoRoot, APPROVALS_DIR, slug(id), "request.jsonl");
}

export function clearRequestSession(repoRoot: string): void {
  rmSync(join(repoRoot, REQUEST_SESSION_FILE), { force: true });
}

// ---- request.json ----

const ONE_LINE = (what: string) =>
  z.string().trim().min(1).refine((text) => !/[\r\n]/.test(text), `${what} 은 한 줄로 씁니다 — 머리말에 들어가는 값입니다`);

const RequestSchema = z
  .object({
    kind: z.enum(KINDS),
    id: z.string().trim().min(1),
    title: ONE_LINE("title"),
    // 작업(ID) 하나는 대상 하나만 진행한다 — 대상마다 별도 ID 로 접수한다(start 도 진행 중이 아닌 다중 대상 지시서를 거부한다)
    target: z.array(ONE_LINE("target")).min(1).max(1, "target 은 하나만 — 대상마다 별도 ID 로 접수합니다"),
    scope: z.array(ONE_LINE("scope")).default([]),
    preserve: z.array(ONE_LINE("preserve")).default([]),
    approver: ONE_LINE("approver").optional(),
    extra: z.record(z.string(), z.union([ONE_LINE("extra"), z.array(ONE_LINE("extra"))])).default({}),
    original: z.string().optional(),
    originalFile: z.string().optional(),
    background: z.string().default(""),
    // 최초 접수·전체 교체는 목록 전체, 요구 변경(amend)은 changes 로만 — superRefine 이 가른다
    requirements: z.array(z.string().trim().min(1)).default([]),
    done: z.array(z.string().trim().min(1)).default([]),
    outOfScope: z.array(z.string().trim().min(1)).default([]),
    constraints: z.array(z.string().trim().min(1)).default([]),
    sourceMap: z.array(z.object({ quote: z.string().trim().min(1), targets: z.array(z.string().trim().min(1)).min(1), note: z.string().optional() })).optional(),
    clarifications: z.array(z.object({ question: z.string().trim().min(1), answer: z.string().trim().min(1) })).default([]),
    // fix 의 오류 로그 — 사람이 준 로그 그대로(errorLog) 또는 그 파일(errorLogFile). 없으면 사유와 재현 절차(noErrorLog)
    errorLog: z.string().optional(),
    errorLogFile: z.string().optional(),
    noErrorLog: z.object({ reason: ONE_LINE("noErrorLog.reason"), steps: z.array(z.string().trim().min(1)).min(1) }).optional(),
    // 확정된 개정이 있는 작업의 후속 요청 — parent 는 기준으로 삼은 확정 개정 번호
    revision: z.object({ parent: z.number().int().min(1), mode: z.enum(["amend", "replace"]), replaceQuote: z.string().trim().min(1).optional() }).strict().optional(),
    changes: z.array(z.discriminatedUnion("op", [
      z.object({ op: z.literal("add"), section: z.enum(SECTIONS), id: z.string().trim().min(1).optional(), text: z.string().trim().min(1) }).strict(),
      z.object({ op: z.literal("modify"), id: z.string().trim().min(1), text: z.string().trim().min(1) }).strict(),
      z.object({ op: z.literal("remove"), id: z.string().trim().min(1), reason: ONE_LINE("remove.reason") }).strict(),
    ])).optional(),
  })
  .superRefine((request, ctx) => {
    const amend = request.revision?.mode === "amend";
    if (amend) {
      const lists = (["requirements", "done", "outOfScope", "constraints"] as const).filter((key) => request[key].length > 0);
      if (lists.length) ctx.addIssue({ code: "custom", path: [lists[0]], message: "요구 변경(revision.mode amend)은 changes 로만 씁니다 — 목록 전체를 다시 주지 않습니다. 언급하지 않은 항목은 그대로 남습니다" });
      if (!request.changes) ctx.addIssue({ code: "custom", path: ["changes"], message: "요구 변경(amend)에는 changes 가 필요합니다 — 머리말만 바꾸면 빈 배열" });
    } else {
      if (request.requirements.length === 0) ctx.addIssue({ code: "custom", path: ["requirements"], message: "requirements 는 1개 이상입니다" });
      if (request.changes) ctx.addIssue({ code: "custom", path: ["changes"], message: "changes 는 요구 변경(revision.mode amend)에서만 씁니다" });
    }
    if (request.revision?.mode === "replace" && !request.revision.replaceQuote) {
      ctx.addIssue({ code: "custom", path: ["revision", "replaceQuote"], message: "전체 교체는 사람이 그 뜻으로 요청한 원문 인용(replaceQuote)이 필요합니다" });
    }
    const logs = [request.errorLog !== undefined, request.errorLogFile !== undefined, request.noErrorLog !== undefined].filter(Boolean).length;
    // 개정은 이전 개정의 오류 로그를 잇는다 — 새로 줄 때만 하나
    if (request.kind === "fix" && (request.revision ? logs > 1 : logs !== 1)) {
      ctx.addIssue({
        code: "custom",
        path: ["errorLog"],
        message: "fix 는 오류 로그로 고칩니다 — errorLog(사람이 준 로그 그대로) · errorLogFile(로그 파일 경로) · noErrorLog({reason, steps}: 로그가 없는 사유와 재현 절차) 중 정확히 하나를 줍니다",
      });
    }
    if (request.kind !== "fix" && logs > 0) {
      ctx.addIssue({ code: "custom", path: ["errorLog"], message: "오류 로그는 fix 에서만 받습니다" });
    }
    if (request.errorLog !== undefined && request.errorLog.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["errorLog"], message: "오류 로그가 비었습니다 — 사람이 준 로그를 그대로 옮깁니다" });
    }
    const given = [request.original !== undefined, request.originalFile !== undefined].filter(Boolean).length;
    if (given !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["original"],
        message: "원문은 original(사람이 준 글 그대로) 과 originalFile(사람이 준 파일 경로) 중 정확히 하나로 줍니다",
      });
    }
    if (request.original !== undefined && request.original.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["original"], message: "원문이 비었습니다 — 사람이 준 글을 그대로 옮깁니다" });
    }
  });

export type RequestDraft = z.infer<typeof RequestSchema>;

/** 예약 속성 — 확장 속성(extra)이 이 이름을 쓰면 머리말에서 겹친다 */
const RESERVED_KEYS = ["kind", "id", "title", "target", "scope", "preserve", "approver"];

type Header = Pick<RevisionDocument, "kind" | "id" | "title" | "target" | "scope" | "preserve" | "approver" | "extra">;

function frontMatter(request: Header): string {
  const lines = ["---", `kind: ${request.kind}`, `id: ${request.id}`, `title: ${request.title}`];
  const list = (key: string, values: string[]) => {
    if (values.length > 0) lines.push(`${key}:`, ...values.map((value) => `  - ${value}`));
  };
  list("target", request.target);
  list("scope", request.scope);
  list("preserve", request.preserve);
  if (request.approver) lines.push(`approver: ${request.approver}`);
  for (const [key, value] of Object.entries(request.extra)) {
    if (Array.isArray(value)) list(key, value);
    else lines.push(`${key}: ${value}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/** 원문은 한 글자도 바꾸지 않고 인용으로만 감싼다 — 확정하는 사람이 정리본과 나란히 읽는 자리다 */
function quoted(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\s+$/, "")
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

/** 렌더한 지시서의 표시 — 사람이 쓴 지시서와 가른다 (`request submit` 은 표시가 없는 파일을 덮지 않는다) */
const RENDER_MARK = "<!-- 이 파일은 code-agent request submit 이 ";

/** 로그는 한 글자도 바꾸지 않고 코드 블록으로 감싼다 — 로그 안의 백틱보다 긴 울타리를 쓴다 */
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text.replace(/\r\n/g, "\n").replace(/\s+$/, "")}\n${fence}`;
}

/** fix 의 오류 로그 절 — 원문 다음, 사람이 확정하는 지시서 안에 둔다 */
function errorLogSection(log: { text: string; source: string } | undefined, noErrorLog: RevisionDocument["noErrorLog"]): string[] {
  if (log) return ["## 오류 로그", "", `<!-- ${log.source} -->`, fenced(log.text), ""];
  if (noErrorLog) {
    return ["## 오류 로그 없음", "", `- 사유: ${noErrorLog.reason}`, "- 재현 절차:",
      ...noErrorLog.steps.map((step, index) => `  ${index + 1}. ${step.replace(/\r?\n/g, " ")}`), ""];
  }
  return [];
}

const listOf = (snapshot: RevisionRecord["snapshot"], section: Section): string[] => snapshot.items[section].map((item) => item.text);
const itemLines = (items: RequirementItem[], none: string): string =>
  items.length ? items.map((item) => `- [${item.id}] ${item.text.replace(/\r?\n/g, "\n  ")}`).join("\n") : `- ${none}`;

/**
 * 원문 대조 — 최초 개정은 최초 원문을 목록 위치(REQ-1…)로, 그 뒤 개정은 이번에 받은 후속 원문을 안정 ID 로 대조한다.
 * 이번 개정에서 삭제한 항목도 연결 대상이다(원문이 지우라고 한 곳).
 */
function revisionTrace(record: Pick<RevisionRecord, "revision" | "mode" | "snapshot" | "document" | "changes">) {
  const { document: doc, snapshot } = record;
  const input = { title: doc.title, background: doc.background, requirements: listOf(snapshot, "REQ"), done: listOf(snapshot, "DONE"),
    constraints: listOf(snapshot, "CON"), outOfScope: listOf(snapshot, "OUT"), sourceMap: doc.sourceMap };
  if (record.mode === "initial") return intakeTrace(doc.originals[0]?.text ?? "", input);
  const targets: Record<string, string> = {};
  for (const section of SECTIONS) for (const item of snapshot.items[section]) targets[item.id] = item.text;
  for (const change of record.changes) if (change.op === "remove") targets[change.id] = `삭제: ${change.reason}`;
  const fresh = doc.originals.filter((original) => original.revision === record.revision).map((original) => original.text).join("\n\n");
  const trace = intakeTrace(fresh, input, targets);
  return { ...trace, text: trace.text.replace("원문을 어디에 반영했는지 확인합니다.", `개정 ${record.revision}에서 받은 후속 원문을 어디에 반영했는지 확인합니다.`) };
}

/** 확정 원장이 확정하는 바이트 — 이행한 이전 형식 지시서는 그 글 그대로 */
export function revisionText(record: RevisionRecord): string {
  return record.legacyText ?? renderRevision(record);
}

export function renderRevision(record: Pick<RevisionRecord, "revision" | "parent" | "mode" | "snapshot" | "document" | "changes" | "history">): string {
  const { document: doc, snapshot } = record;
  const [first, ...later] = doc.originals;
  const originalBlock = (original: OriginalText | undefined) => [`<!-- ${original?.source ?? "원문 없음"} -->`, quoted(original?.text ?? ""), ""];
  const amended = record.revision > 1 && record.mode !== "initial";
  return [
    frontMatter(doc),
    "",
    `${RENDER_MARK}${requestDraftFile(doc.id)} 에서 렌더한다. 고칠 것은 request.json 에 쓰고 다시 제출한다 — ` +
      `현재 호스트 세션에서 ca-answer의 request 동의 절차로 ${doc.id} 요구사항을 확정하면 ca-next 흐름이 자동으로 이어진다. -->`,
    "",
    `# ${doc.id} 요구사항 — ${doc.title}`,
    "",
    ...(amended ? [`개정 ${record.revision} · 부모 개정 ${record.parent} · ${record.mode === "replace" ? "전체 교체 · " : ""}${changeSummary(record.changes)}`, ""] : []),
    `## 원문`,
    "",
    ...originalBlock(first),
    ...later.flatMap((original) => [`## 후속 원문 — 개정 ${original.revision}`, "", ...originalBlock(original)]),
    ...errorLogSection(doc.errorLog, doc.noErrorLog),
    revisionTrace(record).text,
    ...(amended ? ["## 이번 개정의 변경", "", record.changes.map((change) => `- ${changeLine(change)}`).join("\n"), ""] : []),
    "## 배경",
    "",
    doc.background.trim() === "" ? "- 없음" : doc.background.trim(),
    "",
    "## 요구 내용",
    "",
    itemLines(snapshot.items.REQ, "없음"),
    "",
    "## 완료 조건",
    "",
    itemLines(snapshot.items.DONE, "원문에 없음 — 분석 단계의 수락 기준(AC)에서 정한다"),
    "",
    "## 범위 밖",
    "",
    itemLines(snapshot.items.OUT, "없음"),
    "",
    "## 제약",
    "",
    itemLines(snapshot.items.CON, "없음"),
    "",
    ...(snapshot.removed.length ? ["## 삭제된 요구", "",
      snapshot.removed.map((item) => `- [${item.id}] ${item.text.replace(/\r?\n/g, " ")} — 개정 ${item.removedIn}에서 삭제: ${item.reason}`).join("\n"), ""] : []),
    "## 접수 때 정한 것",
    "",
    doc.clarifications.length > 0
      ? doc.clarifications.map((entry) => `- Q: ${entry.question}\n  - A: ${entry.answer}`).join("\n")
      : "- 없음",
    "",
    ...(amended ? ["## 개정 이력", "",
      [...record.history, { revision: record.revision, mode: record.mode, changes: record.changes.length, at: "" }]
        .map((entry) => `- 개정 ${entry.revision} · ${entry.mode === "initial" ? "최초 접수" : entry.mode === "migrated" ? "이전 형식 이행" : entry.mode === "replace" ? `전체 교체 ${entry.changes}건` : `변경 ${entry.changes}건`}` +
          (entry.at ? ` · ${entry.at.slice(0, 10)}` : " · 이 문서")).join("\n"), ""] : []),
  ].join("\n");
}

function draftLists(request: RequestDraft): Record<Section, string[]> {
  return { REQ: request.requirements, DONE: request.done, CON: request.constraints, OUT: request.outOfScope };
}

/** 최초 접수의 렌더 — 접수 초안 하나로 개정 1 을 만든다 */
export function renderRequirement(request: RequestDraft, original: string, source: string, log?: { text: string; source: string }): string {
  return renderRevision({ revision: 1, parent: 0, mode: "initial", changes: [], history: [], snapshot: initialSnapshot(draftLists(request), 1),
    document: draftDocument(request, [{ revision: 1, text: original, source, hash: textHash(original) }], log) });
}

function draftDocument(request: RequestDraft, originals: OriginalText[], log: { text: string; source: string } | undefined, base?: RevisionDocument): RevisionDocument {
  const clarifications = [...(base?.clarifications ?? [])];
  for (const entry of request.clarifications) {
    if (!clarifications.some((known) => known.question === entry.question && known.answer === entry.answer)) clarifications.push(entry);
  }
  const errorLog = log ?? (request.noErrorLog ? undefined : base?.errorLog);
  const noErrorLog = request.noErrorLog ?? (log ? undefined : base?.noErrorLog);
  return {
    kind: request.kind, id: request.id, title: request.title, target: request.target, scope: request.scope, preserve: request.preserve,
    ...(request.approver ? { approver: request.approver } : {}), extra: request.extra,
    background: request.background.trim() === "" && base ? base.background : request.background,
    clarifications, ...(errorLog ? { errorLog } : {}), ...(noErrorLog ? { noErrorLog } : {}), originals,
    ...(request.sourceMap ? { sourceMap: request.sourceMap } : {}),
  };
}

// ---- 확정 원장 ----

export type RequestDecision = "confirmed" | "rejected";

export interface RequestRecord {
  id: string;
  /** 확정한 지시서 경로, 저장소 기준 */
  spec: string;
  hash: string;
  decision: RequestDecision;
  comment?: string;
  approver: string;
  at: string;
  presence: Presence;
  prev: string;
  /** 판정한 요구 개정 번호 — 개정 기록(requirements.jsonl)에 같은 해시의 개정이 있을 때만 */
  revision?: number;
}

export function requirementHash(repoRoot: string, spec: string): string | undefined {
  const path = join(repoRoot, spec);
  if (!existsSync(path)) return undefined;
  return textHash(readFileSync(path, "utf-8"));
}

/** 확정 명령 — 지시서가 정해진 자리에 없으면 경로까지 적어 준다 (그래야 확정하는 쪽과 시작하는 쪽이 같은 파일을 본다) */
function confirmCommand(id: string, spec: string): string {
  return `code-agent confirm request ${id}${spec === requirementFile(id) ? "" : ` ${spec}`}`;
}

function ledgerLines(repoRoot: string, id: string): string[] {
  const path = requestLedgerFile(repoRoot, id);
  // autocrlf 체크아웃이 붙인 CR 은 쓰인 바이트가 아니다 — 원장은 LF 로만 쓴다
  return existsSync(path) ? readFileSync(path, "utf-8").split(/\r?\n/).filter((line) => line.trim() !== "") : [];
}

/** 사슬을 검사하며 읽는다. 끊겼으면 던진다 — 나중에 고친 확정을 조용히 믿지 않는다 */
export function readRequestLedger(repoRoot: string, id: string): RequestRecord[] {
  const lines = ledgerLines(repoRoot, id);
  return lines.map((line, index) => {
    const record = JSON.parse(line) as RequestRecord;
    const expected = index === 0 ? "genesis" : sha(lines[index - 1]);
    if (record.prev !== expected) {
      throw new Stop(
        `요구사항 확정 원장이 나중에 고쳐졌습니다 — 읽지 않았습니다: ${relative(repoRoot, requestLedgerFile(repoRoot, id)).replace(/\\/g, "/")}\n` +
          `  ${index + 1}번째 줄에서 사슬이 끊겼습니다. 원장은 append only 입니다 — git 으로 복원하세요.`,
      );
    }
    return record;
  });
}

/**
 * 판정 한 줄을 남긴다. `hash` 는 **사람에게 보여 준 바이트**의 해시다 — 프롬프트 뒤에 파일을 다시 읽어
 * 해시하면, 사람이 읽는 사이 다시 제출된 다른 내용이 확정된 것으로 남는다. 주지 않으면 지금 파일을 해시한다.
 */
export function recordRequestDecision(
  repoRoot: string,
  input: { id: string; spec: string; decision: RequestDecision; approver: string; presence: Presence; comment?: string; hash?: string },
): RequestRecord {
  return recordDecision(repoRoot, input).record;
}

/** 판정을 남기고, 진행 중인 같은 작업이면 확정한 개정에 흐름을 맞춘다 — 되감았으면 `flow` 가 그 안내다 */
function recordDecision(
  repoRoot: string,
  input: { id: string; spec: string; decision: RequestDecision; approver: string; presence: Presence; comment?: string; hash?: string },
): { record: RequestRecord; flow?: string } {
  const hash = input.hash ?? requirementHash(repoRoot, input.spec);
  if (!hash) {
    throw new Stop(`지시서가 없습니다: ${input.spec}`);
  }
  readRequestLedger(repoRoot, input.id);
  const lines = ledgerLines(repoRoot, input.id);
  const revisions = readRevisions(repoRoot, input.id);
  const judged = [...revisions].reverse().find((revision) => revision.specHash === hash);
  const record: RequestRecord = {
    id: input.id,
    spec: input.spec,
    hash,
    decision: input.decision,
    ...(input.comment ? { comment: input.comment } : {}),
    approver: input.approver,
    at: new Date().toISOString(),
    presence: input.presence,
    prev: lines.length === 0 ? "genesis" : sha(lines[lines.length - 1]),
    ...(judged ? { revision: judged.revision } : {}),
  };
  const path = requestLedgerFile(repoRoot, input.id);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
  const active = loadActive(repoRoot);
  const place = { workId: input.id, phase: active?.id === input.id ? active.phase : "request" };
  recordEvent(repoRoot, { type: "request.decided", ...place,
    detail: { decision: input.decision, channel: input.presence.channel, hash: hash.slice(0, 12), ...(judged ? { revision: judged.revision } : {}) } });
  // 확정된 개정이 있는데 그 뒤의 변경안을 반려하면 지시서를 직전 확정본으로 되돌린다 — 확정본과 진행 상태가 어긋난 채 남지 않게
  if (input.decision === "rejected" && judged && judged.parent > 0 && requirementHash(repoRoot, input.spec) === hash) {
    const confirmed = revisionHeads(repoRoot, input.id, input.spec).confirmed;
    if (confirmed) {
      writeAtomic(join(repoRoot, input.spec), revisionText(confirmed));
      recordEvent(repoRoot, { type: "request.restored", ...place, reason: `변경안(개정 ${judged.revision}) 반려 — 확정 개정 ${confirmed.revision} 으로 되돌림`,
        detail: { rejected: judged.revision, restored: confirmed.revision } });
    }
  }
  const flow = input.decision === "confirmed" && active?.id === input.id && active.spec === input.spec ? syncRequestRevision(repoRoot, active).notice : undefined;
  return { record, ...(flow ? { flow } : {}) };
}

export interface RevisionHeads {
  /** 확정 원장의 마지막 확정이 가리키는 개정 */
  confirmed?: RevisionRecord;
  /** 지시서가 지금 보이는 확정 전 변경안(확정본이 아닌 개정) */
  pending?: RevisionRecord;
  records: RevisionRecord[];
}

/** 확정본과 수정안 — 개정 기록이 없으면(손으로 쓴 지시서·이전 형식) 둘 다 없다 */
export function revisionHeads(repoRoot: string, id: string, spec: string): RevisionHeads {
  const records = readRevisions(repoRoot, id);
  if (!records.length) return { records };
  const lastConfirmed = readRequestLedger(repoRoot, id).filter((record) => record.id === id && record.spec === spec && record.decision === "confirmed").pop();
  const confirmed = lastConfirmed ? [...records].reverse().find((record) => record.specHash === lastConfirmed.hash) : undefined;
  const now = requirementHash(repoRoot, spec);
  const after = confirmed ? records.slice(records.lastIndexOf(confirmed) + 1) : records;
  const pending = now === confirmed?.specHash ? undefined : [...after].reverse().find((record) => record.specHash === now);
  return { confirmed, ...(pending ? { pending } : {}), records };
}

// ---- 흐름이 따르는 개정 ----

/** 흐름(커서)이 따르는 확정 요구 — `ActiveWork.request` */
export type RequestPlace = NonNullable<ActiveWork["request"]>;

/** 요구 항목(요구 내용·완료 조건·제약·범위 밖)의 ID 와 글 — 머리말·원문·이력만 바뀐 개정은 흐름을 되감지 않는다 */
function requestItemsHash(text: string): string {
  const out = text.split(/^##\s+/m).slice(1).filter((section) => section.split(/\r?\n/)[0].trim() === "범위 밖")
    .flatMap((section) => section.split(/\r?\n/).slice(1).map((line) => line.trim()).filter((line) => /^[-*]\s/.test(line)));
  return sha(JSON.stringify({ items: sourceItems(text).map((item) => [item.id, item.text]), out }));
}

/** 지금 확정된 요구의 자리 — 확정 전(변경안 대기·반려)이면 없다 */
export function requestPlace(repoRoot: string, id: string, spec: string): RequestPlace | undefined {
  const state = requestState(repoRoot, id, spec);
  if (state.status !== "confirmed") return undefined;
  const revision = state.record.revision ?? revisionHeads(repoRoot, id, spec).confirmed?.revision;
  return { hash: state.record.hash, items: requestItemsHash(readFileSync(join(repoRoot, spec), "utf-8")), ...(revision ? { revision } : {}) };
}

/** 두 확정 개정 사이에 확정된 변경 — 개정 기록이 없으면(손으로 쓴 지시서·이전 형식) 비어 있다 */
function changesBetween(repoRoot: string, id: string, spec: string, from: number | undefined, to: number | undefined): RevisionChange[] {
  if (!to) return [];
  const confirmed = new Set(readRequestLedger(repoRoot, id).filter((record) => record.id === id && record.spec === spec && record.decision === "confirmed").map((record) => record.hash));
  return readRevisions(repoRoot, id).filter((record) => record.revision > (from ?? 0) && record.revision <= to && record.parent > 0 && confirmed.has(record.specHash))
    .flatMap((record) => record.changes);
}

/**
 * 흐름을 확정된 요구 개정에 맞춘다. 커서가 따르던 확정 요구와 지금 확정본이 다르면 커서에 새 개정을 남기고, 요구 항목이 바뀌었으면
 * 요구사항 분석으로 되감는다 — 브랜치·코드·작업 문서는 그대로 두고 분석부터 바뀐 요구를 반영해 게이트를 다시 지난다. 되감았으면 그 안내를 돌려준다.
 * 확정 전(변경안 대기)이면 아무것도 하지 않는다 — 진행 명령이 확정 대기로 멈춘다. 따르던 기록이 없는 커서(이 기능 전에 시작한 작업)는
 * 지금 확정본을 기록만 한다. 커서를 바꿨으면 바꾼 커서를 돌려준다 — 호출자는 들고 있던 커서로 다시 저장하지 않는다.
 */
export function syncRequestRevision(repoRoot: string, active: ActiveWork): { active: ActiveWork; notice?: string } {
  const place = requestPlace(repoRoot, active.id, active.spec);
  if (!place || active.request?.hash === place.hash) return { active };
  const before = active.request;
  const rewind = !!before && before.items !== place.items && PHASES.indexOf(active.phase) > PHASES.indexOf("analysis");
  const next: ActiveWork = rewind ? { ...active, phase: "analysis", stage: undefined, task: undefined, request: place } : { ...active, request: place };
  saveActive(repoRoot, next, rewind ? "back" : undefined);
  if (!before) return { active: next };
  const changes = changesBetween(repoRoot, active.id, active.spec, before.revision, place.revision);
  const label = place.revision ? `요구 개정 ${place.revision}` : "바뀐 요구";
  recordEvent(repoRoot, { type: "revision.applied", workId: active.id, target: active.target, phase: next.phase, ...(place.revision ? { revision: place.revision } : {}),
    reason: `${label} 확정${rewind ? ` — ${active.phase} 에서 analysis 로 되감음` : before.items === place.items ? " — 요구 항목은 그대로" : " — 분석 중 반영"}`,
    detail: { from: active.phase, to: next.phase, rewound: rewind, ...(before.revision ? { previous: before.revision } : {}), ...(changes.length ? { changes: changeSummary(changes) } : {}) } });
  if (!rewind) return { active: next };
  const shown = changes.filter((change) => change.op !== "header");
  return { active: next, notice: [
    `${label} 확정 — 흐름을 ${PHASE_LABEL[active.phase]} 에서 ${PHASE_LABEL.analysis} 으로 되감았습니다${before.revision ? ` (따르던 개정 ${before.revision})` : ""}.`,
    ...shown.slice(0, 5).map((change) => `  - ${changeLine(change)}`),
    ...(shown.length > 5 ? [`  - 외 ${shown.length - 5}건 — ${active.spec} 의 '이번 개정의 변경'`] : []),
    "브랜치·코드·작업 문서는 그대로입니다. 분석부터 바뀐 요구만 반영해 게이트를 다시 지납니다 — 계획 문서가 바뀌면 계획을 다시 승인받습니다.",
    `다음: ${skill("ca-next")}`,
  ].join("\n") };
}

/**
 * status 의 개정·회차 줄 — 흐름이 따르는 개정과 그 개정의 변경(앞 3건), 아직 따르지 않은 확정 개정, 실행 회차. 첫 개정·첫 회차이고
 * 확정본을 따르고 있으면 없다(요구사항 줄의 개정 번호로 충분하다).
 */
export function flowRevisionLines(repoRoot: string, active: ActiveWork): string[] {
  const lines: string[] = [];
  const followed = active.request?.revision;
  const place = existsSync(join(repoRoot, active.spec)) ? requestPlace(repoRoot, active.id, active.spec) : undefined;
  if (followed && followed > 1) {
    const changes = readRevisions(repoRoot, active.id).find((record) => record.revision === followed)?.changes.filter((change) => change.op !== "header") ?? [];
    lines.push(`흐름이 따르는 개정: ${followed}${changes.length ? ` — 변경 ${changeSummary(changes)}` : ""}`,
      ...changes.slice(0, 3).map((change) => `  - ${changeLine(change)}`), ...(changes.length > 3 ? [`  - 외 ${changes.length - 3}건 — ${active.spec} 의 '이번 개정의 변경'`] : []));
  }
  if (place && active.request && place.hash !== active.request.hash) {
    lines.push(`확정 개정 ${place.revision ?? "?"} 은 다음 진행 명령 때 흐름에 반영합니다${followed ? ` (지금 따르는 개정 ${followed})` : ""}`);
  }
  if (active.cycle) {
    lines.push(`실행 회차: ${active.cycle.number} (회차 ${active.cycle.number - 1} 반영 커밋 ${active.cycle.delivered.slice(0, 12)}${active.cycle.revision ? ` · 개정 ${active.cycle.revision}` : ""}) — 이전 회차의 변경·증거·Task 통과는 이번 회차에 세지 않습니다`);
  }
  return lines;
}

export type RequestState =
  /** 판정 기록이 없다 */
  | { status: "none" }
  /** 지금 내용 그대로 확정돼 있다 */
  | { status: "confirmed"; record: RequestRecord }
  /** 지금 내용 그대로 반려돼 있다 */
  | { status: "rejected"; record: RequestRecord }
  /** 마지막 판정 뒤 내용이 바뀌었다 — 확정 뒤 고쳤거나, 반려 뒤 다시 제출했다 */
  | { status: "unconfirmed"; record: RequestRecord }
  /** 확정은 있는데 사람이 관측되지 않았다 — 프로젝트가 관측된 판정만 받는다고 선언했을 때 */
  | { status: "unverified"; record: RequestRecord };

/** 프로젝트가 관측된 판정만 받는가. 매니페스트를 읽지 못하면 받는 쪽으로 닫는다 */
function requiresVerified(repoRoot: string): boolean {
  try {
    return loadManifestIfAny(repoRoot)?.workOrder.requireVerifiedApproval ?? false;
  } catch {
    return true;
  }
}

export function requestState(repoRoot: string, id: string, spec: string): RequestState {
  // 원장은 slug(id) 마다 하나라 다른 id 가 같은 파일에 섞일 수 있다 — 사슬은 전체로 보고, 판정은 이 id · 이 지시서 것만
  const records = readRequestLedger(repoRoot, id).filter((record) => record.id === id && record.spec === spec);
  const last = records[records.length - 1];
  if (!last) return { status: "none" };
  const now = requirementHash(repoRoot, spec);
  // 변경안을 반려해 직전 확정본으로 되돌린 자리 — 마지막 확정 뒤로 다른 내용의 반려만 있으면 그 확정이 지금 내용이다
  const confirmedAt = records.map((record) => record.decision).lastIndexOf("confirmed");
  const restored = last.hash !== now && confirmedAt >= 0 && records[confirmedAt].hash === now &&
    records.slice(confirmedAt + 1).every((record) => record.decision === "rejected" && record.hash !== now);
  const current = restored ? records[confirmedAt] : last;
  if (current.hash !== now) return { status: "unconfirmed", record: last };
  if (current.decision === "rejected") return { status: "rejected", record: current };
  if (requiresVerified(repoRoot) && current.presence?.verified !== true) return { status: "unverified", record: current };
  return { status: "confirmed", record: current };
}

/** 사람이 지금 내용으로 확정하지 않은 요구사항 위에서는 아무것도 진행하지 않는다 */
export function requireRequestConfirmed(repoRoot: string, id: string, spec: string): void {
  const state = requestState(repoRoot, id, spec);
  switch (state.status) {
    case "confirmed":
      return;
    case "rejected":
      throw new Stop(
        `요구사항이 반려됐습니다 (${spec}): ${state.record.comment ?? "(사유 없음)"}\n` +
          `${skill("ca-request")} 로 사유대로 고쳐 다시 제출하세요 — 확정은 현재 호스트 세션에서 ca-answer의 request 동의 절차로 받습니다.`,
      );
    case "unconfirmed": {
      const pending = revisionHeads(repoRoot, id, spec).pending;
      throw new Stop(
        (pending && pending.parent > 0
          ? `요구사항이 확정 뒤 바뀌었습니다 — 변경안 ${pendingLabel(pending)}이 확정을 기다립니다 (${spec}). 확정 전에는 진행·계획 배정을 하지 않습니다(확정 개정 ${pending.parent} 의 결과는 그대로 둡니다).\n`
          : state.record.decision === "confirmed"
          ? `요구사항이 확정 뒤 바뀌었습니다 (${spec}). 다시 확정해야 진행합니다.\n`
          : `요구사항이 다시 제출돼 확정을 기다립니다 (${spec}).\n`) +
          `현재 호스트 세션에서 ca-answer의 request 동의 절차로 다시 확인하세요. 적용 뒤 ca-next 흐름을 자동으로 이어갑니다 (직접 CLI를 원하면 TTY에서 ${confirmCommand(id, spec)}).`,
      );
    }
    case "unverified":
      throw new Stop(
        `요구사항 확정에 사람이 관측되지 않았습니다 (${spec} · ${state.record.presence?.detail ?? "기록 없음"}).\n` +
          `이 프로젝트는 관측된 판정만 받습니다 (code-agent.json 의 workOrder.requireVerifiedApproval) — 현재 호스트 세션에서 ca-answer의 request 동의 절차로 확인하세요 (직접 CLI를 원하면 TTY에서 ${confirmCommand(id, spec)}).`,
      );
    case "none":
      throw new Stop(
        `요구사항이 확정되지 않았습니다 (${spec}).\n` +
          `현재 호스트 세션에서 ca-answer의 request 동의 절차로 확정하면 ca-next 흐름을 자동으로 이어갑니다 — 요구사항 접수는 ${skill("ca-request")} (직접 CLI를 원하면 TTY에서 ${confirmCommand(id, spec)}).`,
      );
  }
}

/** 변경안 이름 — `개정 3(부모 2 · 추가 1 · 삭제 1)` */
export function pendingLabel(pending: RevisionRecord): string {
  return `개정 ${pending.revision}(부모 ${pending.parent} · ${pending.mode === "replace" ? "전체 교체 · " : ""}${changeSummary(pending.changes)})`;
}

/** status 한 줄 */
export function requestStateLine(repoRoot: string, id: string, spec: string): string {
  if (!existsSync(join(repoRoot, spec))) return "요구사항: 아직 렌더되지 않음";
  const state = requestState(repoRoot, id, spec);
  switch (state.status) {
    case "confirmed": {
      const revision = state.record.revision ?? revisionHeads(repoRoot, id, spec).confirmed?.revision;
      return `요구사항: 확정됨 (${revision ? `개정 ${revision} · ` : ""}${state.record.hash.slice(-12)} · ${state.record.at.slice(0, 10)})`;
    }
    case "rejected":
      return `요구사항: 반려됨 — ${state.record.comment ?? "(사유 없음)"}`;
    case "unconfirmed": {
      const pending = revisionHeads(repoRoot, id, spec).pending;
      if (pending && pending.parent > 0) return `요구사항: 변경안 확정 대기 — ${pendingLabel(pending)}. 확정 전에는 진행·계획 배정을 멈춥니다`;
      return state.record.decision === "confirmed" ? "요구사항: 확정 뒤 바뀜 — 다시 확정 필요" : "요구사항: 다시 제출됨 — 확정 대기";
    }
    case "unverified":
      return "요구사항: 확정에 사람이 관측되지 않음 — 현재 호스트 세션에서 ca-answer의 request 동의 절차로 다시 확정 필요";
    case "none":
      return "요구사항: 확정 대기";
  }
}

/** 그 상태에서 사람 또는 모델이 할 일 한 줄 — status · context · 거부문이 같은 말을 하게 */
export function requestHint(repoRoot: string, id: string, spec: string): string {
  if (!existsSync(join(repoRoot, spec))) {
    return `${skill("ca-request")} — 초안을 ${requestDraftFile(id)} 에 쓰고 code-agent request submit ${requestDraftFile(id)}`;
  }
  const state = requestState(repoRoot, id, spec);
  switch (state.status) {
    case "confirmed":
      return `확정됨 — ${skill("ca-next")} 또는 ${skill("ca-analyze")} 가 code-agent start ${spec} 로 분석을 시작합니다`;
    case "rejected":
      return `${skill("ca-request")} — 반려됐습니다: ${state.record.comment ?? "(사유 없음)"} — 사유대로 초안을 고쳐 다시 제출하세요`;
    default:
      if (hasUnmappedOriginal(readFileSync(join(repoRoot, spec), "utf8"))) return `${skill("ca-request")} — 원문 대조의 미연결 내용을 sourceMap으로 정리한 뒤 다시 제출합니다`;
      return `현재 호스트 세션에서 ca-answer의 request 동의 절차로 확인한 뒤 ca-next 흐름을 자동으로 이어갑니다 (직접 CLI를 원하면 TTY에서 ${confirmCommand(id, spec)}, 반려는 code-agent reject request ${id} --comment "사유").`;
  }
}

// ---- begin ----

function requireIntakeAllowed(repoRoot: string): Manifest {
  const manifest = loadManifestIfAny(repoRoot);
  if (!manifest) {
    throw new Stop(`code-agent.json 이 없습니다. ${skill("ca-adopt")} 로 프로젝트를 먼저 도입하세요.`);
  }
  if (existsSync(join(repoRoot, DOCS_SESSION_FILE))) {
    throw new Stop("문서 작성 세션이 열려 있습니다 — code-agent docs end 로 닫은 뒤 요구사항을 접수하세요.");
  }
  return manifest;
}

export function requestBegin(
  repoRoot: string,
  id: string | undefined,
  kind: string | undefined,
  options: { base?: string; target?: string; triageId?: string } = {},
): string {
  const triage = loadTriage(repoRoot);
  if (triage && !(options.triageId === triage.id && triage.report?.codeChange === "required" && triage.jira?.key === id && kind === "fix")) requireNoTriage(repoRoot);
  if (existsSync(join(repoRoot, DOCS_SESSION_FILE))) throw new Stop("문서 작성 세션이 열려 있습니다 — code-agent docs end 로 닫은 뒤 요구사항을 접수하세요.");
  const aidlc = aidlcBlock(repoRoot);
  if (aidlc) throw new Stop(aidlc);
  if (!id) {
    id = loadRequestSession(repoRoot)?.id ?? loadActive(repoRoot)?.id;
    for (let n = 1; !id; n++) {
      const candidate = `WORK-${String(n).padStart(4, "0")}`;
      if (!existsSync(join(repoRoot, workDocsDir(candidate))) && !existsSync(requestLedgerFile(repoRoot, candidate)) && !workIdentity(repoRoot, candidate)) id = candidate;
    }
  }
  if (!ID_PATTERN.test(id)) {
    throw new Stop(
      `작업 ID 가 필요합니다: ${id || "(없음)"} — 사람이 준 티켓 키를 그대로 씁니다 (영문·숫자로 시작, [A-Za-z0-9._-] 64자 이하).\n` +
        "ID 를 생략하면 WORK-0001 형식으로 자동 발급합니다. 사용법: code-agent request begin [ID] --kind <feature|fix|refactor>",
    );
  }
  if (!kind || !(KINDS as readonly string[]).includes(kind)) {
    throw new Stop(`작업 종류가 필요합니다: ${kind || "(없음)"} — ${KINDS.join(" | ")} (code-agent request begin ${id} --kind <종류>)`);
  }
  const active = loadActive(repoRoot);
  if (active) {
    throw new Stop(
      active.id === id
        ? `${id} 는 이미 시작된 작업입니다 (${active.phase}). 요구사항을 고치려면 code-agent request 가 보여 주는 요구 변경 형식(revision · changes)으로 ${requestDraftFile(id)} 를 써서 code-agent request submit 으로 제출하고, 사람이 변경안을 확정합니다.`
        : `진행 중인 작업이 있습니다: ${active.id} (${active.phase}). 끝내거나 현재 호스트 세션에서 ca-answer의 abort 동의 절차로 종료한 뒤 접수하세요.`,
    );
  }
  const current = loadRequestSession(repoRoot);
  // 새 접수는 실행 중인 호스트의 hook 이 설치돼 있어야 연다(이어서 정리하는 접수는 붙잡지 않는다)
  const hooks = current ? undefined : (require("./init") as typeof import("./init")).requireStartHooks(repoRoot);
  if (current && current.id !== id) {
    throw new Stop(
      `접수 중인 요구사항이 있습니다: ${current.id} (${current.kind}). 그것을 끝내거나 현재 호스트 세션에서 ca-answer의 abort 동의 절차로 종료한 뒤 접수하세요.`,
    );
  }
  if (current && current.kind !== kind) {
    throw new Stop(`${id} 는 ${current.kind} 로 접수 중입니다 — 후속 수정도 기존 종류와 ID를 유지합니다. 종료 후 다른 종류로 다시 접수하지 않습니다.`);
  }
  requireWorkOnCurrentBranch(repoRoot, id);
  requireWorkKind(repoRoot, id, kind as WorkKind);
  rememberWorkIdentity(repoRoot, id, kind as WorkKind);
  const session: RequestSession = {
    ...(current ?? { id, kind: kind as WorkKind, startedAt: new Date().toISOString() }),
    ...(options.base ? { base: options.base } : {}),
    ...(options.target ? { target: options.target } : {}),
  };
  mkdirSync(join(repoRoot, STATE_DIR), { recursive: true });
  writeFileSync(join(repoRoot, REQUEST_SESSION_FILE), `${JSON.stringify(session, null, 2)}\n`);
  if (!current) {
    logStage(repoRoot, { id, target: "", phase: "request" }, "request");
  }
  recordEvent(repoRoot, { type: "request.received", workId: id, phase: "request", detail: { kind, resumed: !!current } });
  mkdirSync(join(repoRoot, workDocsDir(id)), { recursive: true });
  // 시작 전 정리 — 새 접수이고 작업 브랜치가 아직 없거나 반영된 ID(새 회차)일 때만 미리 알린다(거부하지 않는다. 확정 뒤 start 가 거부한다)
  const branch = `${kind}/${id}`;
  const delivered = !current && isGitRepo(repoRoot)
    ? deliveredCycle(repoRoot, id, requirementFile(id), commitOf(repoRoot, branch) ? branch : options.base ?? loadManifestIfAny(repoRoot)?.git.base ?? "master") : undefined;
  const blockers = !current && (delivered || !commitOf(repoRoot, branch)) ? startBlockers(repoRoot, id) : [];
  return [
    current
      ? `이미 접수 중입니다: ${id} (${kind}) — 이어서 정리합니다.`
      : `요구사항 접수를 열었습니다: ${id} (${kind}). 끝날 때까지 ${workDocsDir(id)}/ 밖은 쓸 수 없고, 지시서(requirement.md)는 코드만 씁니다.`,
    ...(delivered
      ? [`${id} 는 회차 ${delivered.cycle} 에서 반영했습니다 (커밋 ${delivered.commit.slice(0, 12)}) — 후속 요청은 확정 요구에 대한 변경안으로 올리고, 확정하면 실행 회차 ${delivered.cycle + 1} 로 시작합니다.`]
      : []),
    ...[aidlcWarning(repoRoot)].filter((line): line is string => !!line),
    ...(blockers.length > 0
      ? [`시작 전 정리 필요: 커밋하지 않은 변경 ${blockers.length}개(${blockerList(blockers)}) — 요구사항 확정 뒤 시작할 때 이 변경이 남아 있으면 start 가 거부합니다. 사람이 커밋·stash 하거나 되돌려 둡니다(모델은 되돌리지 않습니다).`]
      : []),
    "",
    requestContext(repoRoot, session),
    ...(hooks ? ["", hooks] : []),
  ].join("\n");
}

// ---- context ----

/** 대상 후보 — 도메인 디렉토리. 대상은 사람이 정하지만 고를 목록은 코드가 준다 */
function domainCandidates(repoRoot: string, manifest: Manifest, limit = 40): { name: string; path: string }[] {
  const found: { name: string; path: string }[] = [];
  for (const root of manifest.domainRoots) {
    const dir = join(repoRoot, manifest.domainBase, root);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      if (!statSync(join(dir, name)).isDirectory()) continue;
      found.push({ name, path: posix.join(manifest.domainBase, root, name).replace(/\\/g, "/") });
      if (found.length >= limit) return found;
    }
  }
  return found;
}

/**
 * 커서가 있어도 접수 형식을 본다 — 이미 시작한 작업의 요구사항을 고칠 때 초안 형식이 필요하다.
 * (`code-agent context` 는 그때 스테이지 컨텍스트를 준다.)
 */
export function requestFormat(repoRoot: string): string {
  const session = loadRequestSession(repoRoot);
  const active = loadActive(repoRoot);
  if (active) {
    const kind = loadWork(repoRoot)?.order.kind;
    if (!kind) throw new Stop(`진행 중인 작업(${active.id})의 지시서를 읽지 못했습니다: ${active.spec}`);
    return requestContext(repoRoot, { id: active.id, kind, startedAt: "" }, active.spec);
  }
  if (session) return requestContext(repoRoot, session);
  throw new Stop(`접수 중인 요구사항이 없습니다 — code-agent request begin [ID] --kind <feature|fix|refactor> 로 접수를 여세요 (${skill("ca-request")}).`);
}

export function requestContext(repoRoot: string, session: RequestSession, specPath?: string): string {
  const manifest = loadManifestIfAny(repoRoot);
  const { id, kind } = session;
  const spec = specPath ?? requirementFile(id);
  const pathKind = kind !== "feature";
  const attributes = manifest?.workOrder.attributes ?? [];
  const domains = manifest ? domainCandidates(repoRoot, manifest) : [];
  const example = {
    kind,
    id,
    title: "<사람이 목록에서 알아볼 한 줄>",
    target: [pathKind ? "<저장소 경로 — 고칠 코드가 있는 곳>" : "<만들 도메인 · 기능 이름>"],
    scope: pathKind ? ["<건드려도 되는 저장소 경로>"] : [],
    preserve: pathKind ? ["<바뀌면 안 되는 것 — 공개 시그니처 · 테이블 스키마 · 동작>"] : [],
    original: "<사람이 준 글 그대로 — 요약 · 교정하지 않는다>",
    background: "<왜 필요한가 — 원문에 있는 것만>",
    requirements: ["<요구 한 가지 — 원문에 근거가 있는 것만>"],
    done: ["<원문이 말한 완료 조건 — 없으면 비운다>"],
    outOfScope: ["<원문이나 답이 이번에 하지 않는다고 한 것>"],
    constraints: ["<기한 · 호환 · 성능 등 원문의 제약>"],
    clarifications: [{ question: "<접수 때 물은 것>", answer: "<사람의 답 그대로>" }],
    sourceMap: [{ quote: "<원문 일부 그대로>", targets: ["REQ-1"], note: "<반영·제외 이유가 필요하면 작성>" }],
    ...(kind === "fix"
      ? { errorLog: "<사람이 준 오류 로그 그대로 — 스택 트레이스·메시지·발생 시각. 파일이면 대신 errorLogFile, 로그가 없으면 대신 noErrorLog: {reason, steps}>" }
      : {}),
  };
  // 확정된 개정이 있으면 후속 요청은 그 개정 기준의 변경안이다 — 이전 형식으로 확정된 지시서도 표시된 ID 로 보인다(제출 때 기록으로 옮긴다)
  const heads = existsSync(join(repoRoot, spec)) ? revisionHeads(repoRoot, id, spec) : { records: [] as RevisionRecord[] } as RevisionHeads;
  const base = heads.confirmed ?? (existsSync(join(repoRoot, spec)) ? migratedRevision(repoRoot, id, spec, heads.records) : undefined);
  const out = [
    `# code-agent request — ${id} 접수 (${kind})`,
    "",
    `- 초안: ${requestDraftFile(id)} — 모델이 쓴다`,
    `- 지시서: ${spec} — code-agent request submit 이 초안에서 렌더한다 (모델 쓰기 거부)`,
    `- 확정: 현재 호스트 세션에서 ca-answer의 request 동의 절차로 확인하고 적용 뒤 ca-next 흐름을 자동으로 이어갑니다 (직접 CLI를 원하면 TTY에서 ${confirmCommand(id, spec)}, 반려는 code-agent reject request ${id} --comment "사유").`,
    `- 지금: ${requestStateLine(repoRoot, id, spec).replace(/^요구사항: /, "")}`,
    "",
    ...(base ? amendmentFormat(base, heads.pending) : [
      "## request.json",
      "```json",
      JSON.stringify(example, null, 2),
      "```",
      "- 원문은 `original`(사람이 준 글) 또는 `originalFile`(사람이 준 파일의 저장소 경로 — 코드가 그 파일을 그대로 옮긴다) 중 하나.",
      "- `requirements` 는 1개 이상. 원문에 없는 요구를 더하지 않는다 — 있으면 좋을 것 같은 것은 질문으로.",
      // 연결·질문 규칙의 원천은 ca-request 스킬이다(정리 절·질문 절) — 여기에는 형식과 데이터만 싣는다
      "- `sourceMap`: 원문 인용 quote → REQ-1 / DONE-1 / CON-1 / OUT-1 / TITLE / BACKGROUND. 연결 규칙은 ca-request 의 정리 절.",
    ]),
    "- 머리말에 들어가는 값(title · target · scope · preserve · approver · extra)은 한 줄씩. 따옴표나 [ ] 로 감싸지 않는다.",
    pathKind
      ? `- ${kind}: target 은 **저장소에 있는 경로**, scope · preserve 는 필수다. scope 도 실재하는 경로여야 한다. scope 는 바꿀 제품 코드의 경계라 테스트 경로는 적지 않아도 된다(테스트 단계 위치 안에서 계획한다).`
      : "- feature: target 은 이제부터 만들 도메인·기능 이름이라 경로가 아니어도 된다. scope 를 적으면 실재하는 경로여야 한다.",
    "- target 은 **하나**다. 대상이 여럿이면 사용자에게 나눌 ID 를 물어 대상마다 따로 접수한다 — 작업 하나는 대상 하나만 진행한다.",
  ];
  if (manifest?.workOrder.requireApprover) {
    out.push("- 이 프로젝트는 approver(승인자)가 필수다.");
  }
  if (attributes.length > 0) {
    out.push(
      "- 프로젝트 확장 속성(extra):",
      ...attributes.map(
        (attribute) =>
          `  - ${attribute.name}${attribute.required ? " (필수)" : ""}${attribute.values ? ` — 값: ${attribute.values.join(" | ")}` : ""}`,
      ),
    );
  }
  out.push(
    "",
    pathKind
      ? "## 대상 후보 (도메인 디렉토리 — target 은 이 경로나 그 아래 경로)"
      : "## 대상 후보 (이미 있는 도메인 — target 에는 **이름**만 쓴다. 새 이름은 명명 규칙에 따라 제안한다)",
    ...(domains.length > 0
      ? domains.map((domain) => (pathKind ? `- ${domain.path}` : `- ${domain.name} (${domain.path})`))
      : ["- 없음 — 빈 저장소이거나 domainBase 아래에 디렉토리가 없습니다"]),
    "",
    `다음: ${preparationHint(repoRoot) ?? requestHint(repoRoot, id, spec)}`,
  );
  return out.join("\n");
}

/** 요구 변경 형식 — 확정 개정의 항목(안정 ID)과 다음 새 ID, 대기 중 변경안, 그 개정 기준의 초안 예시 */
function amendmentFormat(base: Omit<RevisionRecord, "prev">, pending: RevisionRecord | undefined): string[] {
  const doc = base.document, next = base.snapshot.next;
  const example = {
    kind: doc.kind, id: doc.id, title: doc.title, target: doc.target, scope: doc.scope, preserve: doc.preserve,
    ...(doc.approver ? { approver: doc.approver } : {}), extra: doc.extra,
    original: "<사람이 이번에 준 글 그대로 — 후속 요청 원문>",
    revision: { parent: base.revision, mode: "amend" },
    changes: [
      { op: "add", section: "REQ", id: `REQ-${next.REQ}`, text: "<새 요구 — 이번 원문에 근거가 있는 것만>" },
      { op: "modify", id: "<바꿀 항목 ID>", text: "<고친 뒤의 문장 전체>" },
      { op: "remove", id: "<지울 항목 ID>", reason: "<사람이 지우라고 한 이유>" },
    ],
    clarifications: [],
    sourceMap: [{ quote: "<이번 원문 일부 그대로>", targets: [`REQ-${next.REQ}`] }],
  };
  const flat = (text: string) => { const line = text.replace(/\s+/g, " ").trim(); return line.length > 120 ? `${line.slice(0, 119)}…` : line; };
  return [
    `## 확정된 요구 — 개정 ${base.revision} (후속 요청은 이 개정 기준의 변경안으로 낸다)`,
    ...SECTIONS.filter((section) => base.snapshot.items[section].length > 0)
      .map((section) => `- ${SECTION_LABEL[section]}: ${base.snapshot.items[section].map((item) => `[${item.id}] ${flat(item.text)}`).join(" · ")}`),
    `- 새 ID 는 ${SECTIONS.map((section) => `${section}-${next[section]}`).join(" · ")} 부터 — 삭제한 ID 는 다시 쓰지 않는다`,
    ...(pending && pending.parent === base.revision
      ? [`- 대기 중 변경안: ${pendingLabel(pending)} — 다시 낼 때는 그 변경까지 포함해 개정 ${base.revision} 기준으로 쓴다(대기안은 대체되고 그 원문은 함께 남는다)`] : []),
    "",
    `## request.json — 요구 변경 (확정 개정 ${base.revision} 기준)`,
    "```json",
    JSON.stringify(example, null, 2),
    "```",
    "- `original` 은 사람이 **이번에** 준 글 그대로다. 최초 원문과 앞 개정의 원문은 코드가 그대로 보존한다.",
    "- 언급하지 않은 항목은 그대로 남는다 — 초안에서 빠뜨려도 지워지지 않는다. 지우려면 `remove` 에 사람이 말한 사유를 쓴다. 수정은 같은 ID, 추가는 새 ID(`section`: REQ · DONE · CON · OUT).",
    "- 사람이 전체 교체를 요청했을 때만 `revision.mode` 를 \"replace\" 로, 그 원문 인용을 `replaceQuote` 에 쓰고 requirements · done · constraints · outOfScope 전체 목록을 준다.",
    "- `sourceMap`: 이번 원문 인용 quote → 바뀐 항목 ID(새 항목은 add 의 id). 이미 있는 요구를 다시 말한 부분은 그 항목 ID 로 잇는다.",
    "- 같은 변경안·같은 원문을 다시 내면 새 개정을 만들지 않는다. 오래된 parent 의 변경안은 그 뒤 확정된 개정이 바꾼 항목과 겹치지 않을 때만 최신 개정 위에 적용된다.",
    "- 머리말 값은 바꿀 때만 고친다 — 진행 중인 작업의 target 은 요구 변경으로 바꾸지 않는다.",
  ];
}

/**
 * 준비 단계의 다음 할 일 — 접수(`intake`)는 보존하고 준비를 먼저 한다. 분석은 start 의 문서 확정 게이트 뒤에서만 열린다.
 * 확정이 필요하면 기준 커밋 상태를 보고 동의 하나를 고른다: 문서 확정과 준비 커밋이 둘 다 필요하면 setup, 문서만이면 docs,
 * 준비 커밋만이면 baseline(그 커밋이 없으면 start 가 거부한다). git 저장소가 아니면 준비 커밋은 보지 않는다(start 도 git 없이 시작한다).
 */
export function preparationHint(repoRoot: string, intake = true): string | undefined {
  const manifest = loadManifestIfAny(repoRoot);
  const session = existsSync(join(repoRoot, DOCS_SESSION_FILE));
  if (!manifest) {
    // ca-adopt 도중(docs begin 뒤 code-agent.json 작성 전) — 세션을 이어 쓴다. 문서 세션 중에는 접수(request begin)가 거부된다
    return session
      ? `${skill("ca-adopt")} 로 설정(code-agent.json)·공통 문서를 마저 준비합니다 — 문서 세션이 열려 있습니다. 다 쓰면 code-agent docs end`
      : `${skill("ca-adopt")} 로 프로젝트 준비 — 접수 ID와 원문 초안을 유지합니다. 추천 설정은 code-agent docs recommend. 선택: 조사하여 준비 / 기존 설정·문서 연결 / 보류`;
  }
  const checks = checkProjectDocs(repoRoot, manifest);
  const missing = checks.some((entry) => entry.state === "missing-file" || entry.state === "missing-sections");
  if (session) {
    if (missing) return `${skill("ca-docs")} 로 공통 문서를 마저 씁니다 — 문서 세션이 열려 있습니다. 다 쓰면 code-agent docs end`;
    return `code-agent docs end 로 문서 세션을 닫은 뒤 ${preparationConsent(repoRoot, checks) ?? (intake ? "접수를 이어갑니다" : "준비를 마칩니다")}`;
  }
  if (missing) return `${skill("ca-docs")} 로 빠진 공통 문서 준비 — ${intake ? "접수를 취소하지 않고 " : ""}code-agent docs begin 으로 이어갑니다. 선택: 문서 작성 / 기존 문서 연결 / 보류`;
  return preparationConsent(repoRoot, checks);
}

/** 문서 확정·준비 커밋에 맞는 동의(setup·docs·baseline) 안내 — 둘 다 필요 없으면 undefined */
function preparationConsent(repoRoot: string, checks: ReturnType<typeof checkProjectDocs>): string | undefined {
  const needDocs = !docsReady(checks);
  // 작업 중에는 준비 커밋을 만들지 않는다(setupBaseline 이 거부한다) — 진행 중인 작업의 안내에 섞지 않는다
  const pending = isGitRepo(repoRoot) && !loadActive(repoRoot) ? safePending(repoRoot) : [];
  const needBase = isGitRepo(repoRoot) && !loadActive(repoRoot) && (!hasBaseline(repoRoot) || pending.length > 0);
  if (needDocs && needBase) return "현재 호스트 세션에서 ca-answer의 setup 동의 절차로 공통 문서 확정과 준비 커밋을 한 번에 확인받고 적용 뒤 ca-next 흐름을 자동으로 이어갑니다";
  if (needDocs) return "현재 호스트 세션에서 ca-answer의 docs 동의 절차로 공통 문서를 확정하고 적용 뒤 ca-next 흐름을 자동으로 이어갑니다";
  if (needBase) return `현재 호스트 세션에서 ca-answer의 baseline 동의 절차로 준비 커밋(도입 파일 ${pending.length}개)을 확인받고 적용 뒤 ca-next 흐름을 자동으로 이어갑니다 — 이 커밋이 없으면 start 가 거부합니다`;
  return undefined;
}
/** 준비 커밋에 아직 반영되지 않은 도입 파일 — git 실패는 빈 목록(안내 하나로 접수를 세우지 않는다) */
function safePending(repoRoot: string): string[] {
  try { return pendingBaselineFiles(repoRoot); } catch { return []; }
}

/**
 * 새 작업 브랜치를 딸 때 따라갈 미커밋·미추적 변경 — start 는 거부하고, 접수 begin·접수 중 status 는 미리 알린다.
 * 작업 폴더(`doc/work/<ID>/`)·`.code-agent/`·지시서와, 준비 커밋에 담을 도입 파일(start 가 requirePreparedBranch 로 먼저 따로 본다)은 뺀다.
 * git 저장소가 아니거나 HEAD 가 없으면, 또는 git 이 실패하면 빈 목록이다.
 */
export function startBlockers(repoRoot: string, id: string, spec?: string): Change[] {
  try {
    if (!isGitRepo(repoRoot) || !commitOf(repoRoot, "HEAD")) return [];
    const folder = `${workDocsDir(id)}/`;
    const baseline = new Set(baselineFiles(repoRoot));
    return changedPaths(repoRoot, "HEAD").filter((change) =>
      !change.path.startsWith(folder) && !change.path.startsWith(`${STATE_DIR}/`) && change.path !== spec && !baseline.has(change.path));
  } catch {
    return [];
  }
}
/** 경고 줄의 변경 목록 — 앞 5개와 나머지 수 */
function blockerList(changes: Change[]): string {
  return changes.slice(0, 5).map((change) => `[${change.status}] ${change.path}`).join(", ") + (changes.length > 5 ? ` 외 ${changes.length - 5}개` : "");
}

// ---- submit ----

/**
 * 명령 인자는 지금 자리 기준이고, 초안 안의 경로는 저장소 기준이다. 상대 경로가 지금 자리에서 없으면
 * 저장소 기준으로 한 번 더 본다 — Claude Code 가 하위 폴더에서 돌 때도 같은 인자가 통하게.
 */
function toRepoPath(repoRoot: string, path: string, base: "cwd" | "repo" = "cwd"): string {
  const fromCwd = isAbsolute(path) ? path : resolve(base === "cwd" ? process.cwd() : repoRoot, path);
  const absolute = existsSync(fromCwd) || isAbsolute(path) ? fromCwd : resolve(repoRoot, path);
  return relative(repoRoot, canonical(absolute)).replace(/\\/g, "/");
}

/** 머리말에 옮긴 값이 그대로 읽히는가 — 따옴표 · 괄호로 감싼 값은 파서가 벗기거나 배열로 읽는다 */
function roundTripProblems(request: RequestDraft, order: WorkOrder): string[] {
  const problems: string[] = [];
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
  if (order.title !== request.title) problems.push("title");
  if (!same(order.target, request.target)) problems.push("target");
  if (!same(order.scope, request.scope)) problems.push("scope");
  if (!same(order.preserve, request.preserve)) problems.push("preserve");
  if ((order.approver ?? "") !== (request.approver ?? "")) problems.push("approver");
  for (const [key, value] of Object.entries(request.extra)) {
    const read = order.extra[key];
    const expected = Array.isArray(value) ? value : [value];
    const actual = read === undefined ? [] : Array.isArray(read) ? read : [read];
    if (!same(actual, expected)) problems.push(key);
  }
  return problems;
}

export function requestSubmit(repoRoot: string, draftArg: string | undefined): string {
  const manifest = requireIntakeAllowed(repoRoot);
  if (!draftArg) {
    throw new Stop("사용법: code-agent request submit <request.json>");
  }
  const active = loadActive(repoRoot);
  const session = loadRequestSession(repoRoot);
  // 접수 중이거나, 이미 시작한 작업의 요구사항을 고칠 때만 — 고치면 사람이 다시 확정한다
  let owner: { id: string; kind?: WorkKind } | undefined = session;
  if (active) {
    const kind = workIdentity(repoRoot, active.id)?.kind ?? loadWork(repoRoot)?.order.kind;
    if (!kind) throw new Stop(`기존 작업 ${active.id}의 접수 종류를 확인할 수 없습니다. 지시서를 복구한 뒤 다시 제출하세요.`);
    owner = { id: active.id, kind };
  }
  if (!owner) {
    throw new Stop(`접수 중인 요구사항이 없습니다 — code-agent request begin [ID] --kind <종류> 로 접수를 여세요 (${skill("ca-request")}).`);
  }

  const draftPath = toRepoPath(repoRoot, draftArg);
  if (draftPath.startsWith("..") || !existsSync(join(repoRoot, draftPath))) {
    throw new Stop(`초안이 없습니다: ${draftArg}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(repoRoot, draftPath), "utf-8"));
  } catch (error) {
    throw new Stop(`초안이 JSON 이 아닙니다 (${draftPath}): ${error instanceof Error ? error.message : error}`);
  }
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) {
    // 대상 여럿인 지시서로 이미 시작한 작업(진행 중 작업은 잇는다)의 재제출 — 그 작업을 잇는 길은 진행 중인 대상 하나만 남기는 것이다.
    // '대상마다 별도 ID' 만 보이면 진행 중인 작업을 두고 새로 접수하는 쪽으로 읽힌다
    const draftId = raw && typeof raw === "object" ? (raw as { id?: unknown }).id : undefined;
    const keep = active && draftId === active.id && parsed.error.issues.some((issue) => issue.path[0] === "target" && issue.code === "too_big")
      ? `\n진행 중인 작업(${active.id})의 요구사항을 고치는 중이면 target 에 진행 중인 대상(${active.target}) 하나만 남겨 다시 제출합니다 — 나머지 대상은 이 작업을 끝낸 뒤 대상마다 별도 ID 로 접수합니다.`
      : "";
    throw new Stop(
      "접수 초안의 형식이 맞지 않습니다:\n" +
        parsed.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n") +
        keep +
        "\n형식은 code-agent request 가 보여 줍니다.",
    );
  }
  const request = parsed.data;
  if (request.id !== owner.id) {
    throw new Stop(`초안의 id(${request.id}) 가 접수 중인 작업(${owner.id}) 과 다릅니다 — ID 는 사람이 준 그대로 씁니다.`);
  }
  if (owner.kind && request.kind !== owner.kind) {
    throw new Stop(`초안의 kind(${request.kind}) 가 접수한 종류(${owner.kind}) 와 다릅니다 — 종류는 사람이 명령으로 고른 것입니다.`);
  }
  requireWorkOnCurrentBranch(repoRoot, request.id);
  requireWorkKind(repoRoot, request.id, request.kind);
  const spec = requirementFile(request.id);
  if (active && active.spec !== spec) {
    throw new Stop(`이 작업은 ${active.spec} 로 시작됐습니다 — 그 지시서는 사람이 직접 고치고 다시 확정합니다.`);
  }
  const reserved = Object.keys(request.extra).filter((key) => RESERVED_KEYS.includes(key));
  if (reserved.length > 0) {
    throw new Stop(`extra 에 예약 속성을 쓸 수 없습니다: ${reserved.join(", ")} — 그 값은 같은 이름의 자리에 씁니다.`);
  }
  // 머리말 속성 이름은 영문으로 시작하는 [A-Za-z0-9_-] 뿐이다 (지시서 파서의 규칙) — 프로젝트가 선언한 이름을 쓴다
  const badKeys = Object.keys(request.extra).filter((key) => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(key));
  if (badKeys.length > 0) {
    throw new Stop(
      `extra 의 속성 이름은 영문으로 시작하는 [A-Za-z0-9_-] 입니다: ${badKeys.join(", ")} — code-agent.json 의 workOrder.attributes 에 선언된 이름을 씁니다.`,
    );
  }

  // 원문 — 파일을 줬으면 코드가 그 파일을 그대로 옮긴다. 모델이 옮겨 적다 바뀌는 길을 막는다
  let original = request.original ?? "";
  let source = "원문: 사람이 준 글 (접수 초안의 original)";
  if (request.originalFile !== undefined) {
    const file = toRepoPath(repoRoot, request.originalFile, "repo");
    if (file.startsWith("..") || !existsSync(join(repoRoot, file)) || !statSync(join(repoRoot, file)).isFile()) {
      throw new Stop(`originalFile 이 저장소 안의 파일이 아닙니다: ${request.originalFile}`);
    }
    original = readFileSync(join(repoRoot, file), "utf-8").replace(/^﻿/, "");
    if (original.trim() === "") {
      throw new Stop(`originalFile 이 비었습니다: ${file}`);
    }
    source = `원문: ${file} 그대로`;
  }

  // 오류 로그도 원문처럼 코드가 옮긴다 — 파일을 줬으면 그 파일 그대로
  let log: { text: string; source: string } | undefined;
  if (request.errorLog !== undefined) log = { text: request.errorLog, source: "오류 로그: 사람이 준 로그 그대로 (접수 초안의 errorLog)" };
  if (request.errorLogFile !== undefined) {
    const file = toRepoPath(repoRoot, request.errorLogFile, "repo");
    if (file.startsWith("..") || !existsSync(join(repoRoot, file)) || !statSync(join(repoRoot, file)).isFile()) {
      throw new Stop(`errorLogFile 이 저장소 안의 파일이 아닙니다: ${request.errorLogFile}`);
    }
    const text = readFileSync(join(repoRoot, file), "utf-8").replace(/^﻿/, "");
    if (text.trim() === "") throw new Stop(`errorLogFile 이 비었습니다: ${file}`);
    log = { text, source: `오류 로그: ${file} 그대로` };
  }
  if (log && log.text.length > 200_000) {
    throw new Stop("오류 로그가 20만 자를 넘습니다 — 발생 시각 앞뒤의 스택 트레이스·오류 메시지 구간만 남긴 파일을 사람에게 받아 다시 제출하세요.");
  }

  // 사람이 편집기로 쓴 지시서는 덮지 않는다 — 렌더한 파일에는 코드가 남긴 표시가 있다
  const existing = existsSync(join(repoRoot, spec)) ? readFileSync(join(repoRoot, spec), "utf-8") : undefined;
  if (existing !== undefined && !existing.includes(RENDER_MARK)) {
    throw new Stop(
      `사람이 쓴 지시서가 이미 있습니다: ${spec} — 덮어쓰지 않았습니다.\n` +
        `그 지시서로 하려면 현재 호스트 세션에서 ca-answer의 request 동의 절차로 확정하세요 (직접 CLI를 원하면 TTY에서 ${confirmCommand(request.id, spec)}). 적용 뒤 ca-next 흐름에서 code-agent start ${spec} 로 자동으로 이어갑니다. ` +
        "접수로 새로 받으려면 사람이 그 파일을 옮기거나 지웁니다.",
    );
  }
  // 같은 ID 의 제출·판정은 한 번에 하나 — 동시에 들어온 변경안이 서로의 부모를 덮지 않게
  const lockDir = join(repoRoot, STATE_DIR, "work", request.id);
  mkdirSync(lockDir, { recursive: true });
  const release = acquireLock(join(lockDir, "requirements.lock"), { waitMs: 5_000, ageReclaim: true, label: "요구 개정 기록",
    display: `${STATE_DIR}/work/${request.id}/requirements.lock` });
  try {
    return submitRevision(repoRoot, { request, original, source, log, spec, active, manifest, existing });
  } finally { release(); }
}

interface Submission {
  request: RequestDraft; original: string; source: string; log?: { text: string; source: string }; spec: string;
  active: ReturnType<typeof loadActive>; manifest: Manifest; existing?: string;
}

/** 이전 형식으로 렌더·확정된 지시서 — 개정 기록의 첫 줄(이행)로 옮길 내용. 확정본이 아니거나 손으로 쓴 지시서면 없다 */
function migratedRevision(repoRoot: string, id: string, spec: string, records: RevisionRecord[]): Omit<RevisionRecord, "prev"> | undefined {
  const path = join(repoRoot, spec);
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf-8");
  if (!text.includes(RENDER_MARK) || requestState(repoRoot, id, spec).status !== "confirmed") return undefined;
  const confirmations = readRequestLedger(repoRoot, id).filter((record) => record.id === id && record.spec === spec && record.decision === "confirmed")
    .filter((record, index, all) => index === 0 || all[index - 1].hash !== record.hash).length;
  const revision = Math.max(records.reduce((max, record) => Math.max(max, record.revision), 0) + 1, confirmations, 1);
  const { snapshot, document } = legacyDocument(text, revision);
  return { workId: id, revision, parent: 0, mode: "migrated", changes: [], snapshot, document, history: [], draftHash: "", specHash: textHash(text),
    at: new Date().toISOString(), legacyText: text };
}

/** 머리말·배경·오류 로그의 변경 — 요구 항목 변경과 같은 목록에 남긴다 */
function headerChanges(base: RevisionDocument, next: RevisionDocument): RevisionChange[] {
  const show = (value: unknown) => value === undefined ? "" : Array.isArray(value) ? value.join(", ") : typeof value === "string" ? value.replace(/\r?\n/g, " ") : JSON.stringify(value);
  const fields: [string, unknown, unknown][] = [["title", base.title, next.title], ["target", base.target, next.target], ["scope", base.scope, next.scope],
    ["preserve", base.preserve, next.preserve], ["approver", base.approver, next.approver], ["background", base.background.trim(), next.background.trim()],
    ["errorLog", base.errorLog?.text, next.errorLog?.text], ["noErrorLog", base.noErrorLog, next.noErrorLog]];
  for (const key of new Set([...Object.keys(base.extra), ...Object.keys(next.extra)])) fields.push([`extra.${key}`, base.extra[key], next.extra[key]]);
  return fields.filter(([, before, after]) => JSON.stringify(before ?? null) !== JSON.stringify(after ?? null))
    .map(([field, before, after]) => ({ op: "header" as const, field, before: show(before).slice(0, 200), after: show(after).slice(0, 200) }));
}

/**
 * 개정 하나를 만든다 — 확정본이 없으면 최초 접수(목록 전체), 있으면 그 확정 개정을 부모로 한 변경안(amend·replace)이다.
 * 같은 변경안·같은 원문의 재전송은 새 개정을 만들지 않는다. 오래된 부모의 변경안은 그 뒤 확정된 개정이 건드린 항목과 겹치지 않을 때만
 * 최신 확정본 위에 적용한다. 기록을 먼저 남기고 지시서를 렌더한다 — 그 사이에 멈추면 같은 제출이 지시서를 다시 렌더한다.
 */
function submitRevision(repoRoot: string, input: Submission): string {
  const { request, original, source, log, spec, active, manifest } = input;
  const id = request.id;
  const records = readRevisions(repoRoot, id);
  let heads = revisionHeads(repoRoot, id, spec);
  const notes: string[] = [];
  if (!heads.confirmed) {
    const migrated = migratedRevision(repoRoot, id, spec, records);
    if (migrated) {
      const appended = appendRevision(repoRoot, migrated);
      records.push(appended);
      heads = { confirmed: appended, records };
      notes.push(`이전 형식으로 확정된 지시서를 개정 ${appended.revision} 으로 옮겼습니다 — 표시된 ID 를 그대로 씁니다.`);
    }
  }
  const draftHash = sha(JSON.stringify({ request: { ...request, original: undefined, originalFile: undefined, errorLogFile: undefined }, original, log: log?.text }));
  const base = heads.confirmed;
  const fileHash = input.existing === undefined ? undefined : textHash(input.existing);
  const confirmedHashes = new Set(readRequestLedger(repoRoot, id).filter((record) => record.id === id && record.spec === spec && record.decision === "confirmed").map((record) => record.hash));
  const tail = base ? records.slice(records.lastIndexOf(base) + 1) : records;
  const latest = tail.at(-1);
  // 기록은 남았는데 렌더 전에 멈춘 같은 제출 — 지시서를 다시 렌더해 기록과 맞춘다
  if (latest && latest.draftHash === draftHash && latest.specHash !== fileHash && !readRequestLedger(repoRoot, id).some((record) => record.hash === latest.specHash)) {
    writeAtomic(join(repoRoot, spec), revisionText(latest));
    return `이전 제출이 지시서 렌더 전에 멈췄습니다 — 기록된 ${latest.parent > 0 ? `변경안 ${pendingLabel(latest)}` : "접수 초안"} 으로 ${spec} 를 다시 렌더했습니다. 새 개정을 만들지 않았습니다.\n` +
      `현재 호스트 세션에서 ca-answer의 request 동의 절차로 확정합니다 (직접 CLI를 원하면 TTY에서 \`${confirmCommand(id, spec)}\`).`;
  }
  if (heads.pending && heads.pending.draftHash === draftHash) {
    const rejected = readRequestLedger(repoRoot, id).filter((record) => record.id === id && record.spec === spec).pop();
    if (rejected?.decision === "rejected" && rejected.hash === heads.pending.specHash) {
      throw new Stop(`반려된 내용과 같습니다 — 다시 제출하지 않았습니다. 반려 사유: ${rejected.comment ?? "(사유 없음)"}\n` +
        "사유가 가리키는 곳을 초안에서 고치고, 사유만으로 정할 수 없으면 사람에게 물으세요.");
    }
    return `같은 ${heads.pending.parent > 0 ? `변경안 ${pendingLabel(heads.pending)}` : "접수 초안"}이 이미 제출돼 확정을 기다립니다 — 새 개정을 만들지 않았습니다.\n` +
      `현재 호스트 세션에서 ca-answer의 request 동의 절차로 확정합니다 (직접 CLI를 원하면 TTY에서 \`${confirmCommand(id, spec)}\`).`;
  }
  const now = new Date().toISOString();
  let proposal: Omit<RevisionRecord, "prev">;
  if (!base) {
    if (request.revision) {
      throw new Stop(`${id} 에는 확정된 요구 개정이 없습니다 — 최초 접수 형식(requirements · done · constraints · outOfScope 전체 목록)으로 제출합니다. 형식은 code-agent request 가 보여 줍니다.`);
    }
    const snapshot = initialSnapshot(draftLists(request), 1);
    proposal = { workId: id, revision: 1, parent: 0, mode: "initial", changes: [], snapshot,
      document: draftDocument(request, [{ revision: 1, text: original, source, hash: textHash(original) }], log), history: [], draftHash, specHash: "", at: now };
  } else {
    // 같은 변경안이 이미 확정된 개정 — 다시 반영하지 않는다
    const done = records.find((record) => record.draftHash === draftHash && confirmedHashes.has(record.specHash));
    if (done) return `같은 변경안이 이미 개정 ${done.revision} 으로 확정돼 있습니다 — 새 개정을 만들지 않았습니다. 지금 확정 개정은 ${base.revision} 입니다.`;
    if (!request.revision) {
      const lists = draftLists(request);
      const missing = SECTIONS.flatMap((section) => base.snapshot.items[section]
        .filter((item) => !lists[section].some((text) => normalizeText(text) === normalizeText(item.text))).map((item) => item.id));
      const added = SECTIONS.reduce((sum, section) => sum + lists[section].filter((text) => !base.snapshot.items[section].some((item) => normalizeText(item.text) === normalizeText(text))).length, 0);
      const header = headerChanges(base.document, draftDocument(request, base.document.originals, log, base.document)).flatMap((change) => change.op === "header" ? [change.field] : []);
      if (!missing.length && !added && !header.length && textHash(original) === base.document.originals[0]?.hash) {
        return `바뀐 것이 없습니다 — 확정 개정 ${base.revision} 그대로입니다(항목 순서가 달라도 ID 는 그대로입니다). 새 개정을 만들지 않았습니다.`;
      }
      throw new Stop([
        `${id} 에는 확정된 요구 개정 ${base.revision} 이 있습니다 — 후속 요청은 요구 변경 형식으로 제출합니다(전체 목록을 다시 내면 빠뜨린 요구가 지워질 수 있어 받지 않습니다).`,
        ...(missing.length ? [`  - 이 초안에 없는 확정 항목: ${missing.join(", ")} — 초안에서 빠졌다는 이유로 지우지 않습니다. 지우려면 changes 의 remove 에 사람이 말한 사유를 씁니다.`] : []),
        ...(header.length ? [`  - 바뀐 머리말: ${header.join(", ")} — 변경안에 그 값과 바꾸라고 한 원문을 함께 씁니다.`] : []),
        `  - 형식: "revision": {"parent": ${base.revision}, "mode": "amend"}, "changes": [{"op":"add","section":"REQ","text":"…"}, {"op":"modify","id":"REQ-1","text":"…"}, {"op":"remove","id":"REQ-2","reason":"…"}], "original": 이번에 받은 글 그대로.`,
        "  - 사람이 전체 교체를 요청했을 때만 \"mode\": \"replace\" 와 그 원문 인용(replaceQuote), 전체 목록을 씁니다. code-agent request 가 현재 항목과 형식을 보여 줍니다.",
      ].join("\n"));
    }
    const revision = base.revision + 1;
    const { parent, mode, replaceQuote } = request.revision;
    if (parent > base.revision) throw new Stop(`개정 ${parent} 은 확정되지 않았습니다 — 지금 확정 개정은 ${base.revision} 입니다. revision.parent 를 ${base.revision} 으로 씁니다.`);
    if (base.document.originals.some((entry) => entry.hash === textHash(original))) {
      const seen = base.document.originals.find((entry) => entry.hash === textHash(original))!;
      return `같은 원문이 이미 개정 ${seen.revision} 에 반영돼 있습니다 — 새 개정을 만들지 않았습니다. 사람이 새로 요청한 내용이 있으면 그 글을 original 로 씁니다.`;
    }
    if (parent < base.revision) {
      // 그 뒤 확정된 개정들이 건드린 항목과 겹치면 받지 않는다 — 겹치지 않으면 최신 확정본 위에 적용한다
      const confirmedLater = records.filter((record) => record.revision > parent && record.revision <= base.revision && confirmedHashes.has(record.specHash));
      const theirs = new Set(confirmedLater.flatMap((record) => touchedIds(record.changes)));
      const mine = (request.changes ?? []).map((change) => change.id).filter((value): value is string => !!value);
      const clash = mine.filter((value) => theirs.has(value));
      if (mode === "replace" || clash.length) {
        throw new Stop(`개정 ${parent} 기준 변경안이 그 뒤 확정된 개정 ${base.revision} 과 ${clash.length ? `겹칩니다(${clash.join(", ")})` : "충돌합니다(전체 교체)"} — 적용하지 않았습니다.\n` +
          `code-agent request 로 지금 확정 개정 ${base.revision} 의 항목을 보고 그 개정 기준으로 다시 작성합니다. 같은 항목을 두고 뜻이 갈리면 사람에게 묻습니다.`);
      }
      notes.push(`개정 ${parent} 기준 변경안을 그 뒤 확정된 개정 ${base.revision} 위에 적용했습니다 — 겹치는 항목이 없습니다.`);
    }
    // 아직 확정하지 않은 대기 변경안을 대체할 때 그 원문은 함께 남긴다 — 대조표가 미연결로 보여 빠뜨린 변경을 잡는다
    const carried = heads.pending && heads.pending.parent === base.revision
      ? heads.pending.document.originals.filter((entry) => entry.revision === revision && entry.hash !== textHash(original)) : [];
    if (carried.length) notes.push(`대기 중이던 변경안 ${pendingLabel(heads.pending!)} 을 이 변경안으로 대체합니다 — 그 원문 ${carried.length}개를 함께 남겼습니다.`);
    const originals = [...base.document.originals, ...carried, { revision, text: original, source, hash: textHash(original) }];
    let applied: { snapshot: RevisionRecord["snapshot"]; changes: RevisionChange[] };
    let sourceMap = request.sourceMap;
    if (mode === "replace") {
      const fresh = originals.filter((entry) => entry.revision === revision).map((entry) => normalizeText(entry.text)).join(" ");
      if (!fresh.includes(normalizeText(replaceQuote!))) throw new Stop(`replaceQuote 가 이번 원문에 없습니다: ${replaceQuote} — 사람이 전체 교체를 요청한 글을 그대로 인용합니다.`);
      const replaced = replaceSnapshot(base.snapshot, draftLists(request), revision, `전체 교체 — "${replaceQuote}"`);
      applied = replaced;
      sourceMap = request.sourceMap?.map((entry) => ({ ...entry, targets: entry.targets.map((target) => replaced.positional[target] ?? target) }));
    } else applied = applyChanges(base.snapshot, (request.changes ?? []) as DraftChange[], revision);
    const document = draftDocument({ ...request, sourceMap }, originals, log, base.document);
    const header = headerChanges(base.document, document);
    if (active?.id === id && document.target[0] !== active.target) {
      throw new Stop(`진행 중인 작업(${id})의 대상은 ${active.target} 입니다 — 대상 변경(${document.target.join(", ")})은 같은 작업의 요구 변경으로 받지 않습니다. ` +
        "대상을 바꾸는 것이 맞는지 사람에게 묻고, 다른 대상이면 그 대상의 ID 로 따로 접수합니다(같은 대상의 추가 요구는 이 ID 로 이어갑니다).");
    }
    const changes = [...applied.changes, ...header];
    const newAnswers = document.clarifications.length > base.document.clarifications.length;
    if (!changes.length && !newAnswers) throw new Stop(`바뀐 것이 없습니다 — changes 와 머리말이 확정 개정 ${base.revision} 과 같습니다. 새 개정을 만들지 않았습니다.`);
    proposal = { workId: id, revision, parent: base.revision, parentHash: base.specHash, mode, changes, snapshot: applied.snapshot, document,
      history: [...base.history, { revision: base.revision, mode: base.mode, changes: base.changes.length, at: base.at }],
      ...(replaceQuote ? { replaceQuote } : {}), draftHash, specHash: "", at: now };
  }

  const traced = revisionTrace(proposal);
  if (traced.problems.length) throw new Stop(`원문 연결이 올바르지 않습니다:\n${traced.problems.join("\n")}`);
  const text = renderRevision(proposal);
  // 지시서 규칙은 하나다 — 손으로 쓴 지시서와 같은 검사를 렌더한 결과에 그대로 건다
  let order: WorkOrder;
  try {
    order = validateWorkOrder(repoRoot, parseFrontMatter(text) ?? {}, spec, {
      attributes: manifest.workOrder.attributes,
      requireApprover: manifest.workOrder.requireApprover,
    });
  } catch (error) {
    if (error instanceof WorkOrderError) {
      throw new Stop(
        "접수 내용이 지시서 규격에 맞지 않아 렌더하지 않았습니다:\n" +
          error.problems.map((problem) => `  - [${problem.attribute}] ${problem.detail}`).join("\n") +
          "\n원문으로 정할 수 없는 값이면 사람에게 물으세요.",
      );
    }
    throw error;
  }
  const bent = roundTripProblems(request, order);
  if (bent.length > 0) {
    throw new Stop(
      `머리말로 옮기면 값이 달라집니다: ${bent.join(", ")} — 따옴표나 [ ] 로 감싼 값, 빈 항목은 쓰지 않습니다.`,
    );
  }
  const hash = textHash(text);
  const before = requestState(repoRoot, id, spec);
  // 반려된 그 내용을 그대로 다시 내지 않는다 — 사유를 읽지 않은 제출은 사람에게 같은 화면을 한 번 더 보일 뿐이다
  const rejected = readRequestLedger(repoRoot, id).filter((record) => record.id === id && record.spec === spec && record.decision === "rejected" && record.hash === hash).pop();
  if (rejected) {
    throw new Stop(
      `반려된 내용과 같습니다 — 다시 제출하지 않았습니다. 반려 사유: ${rejected.comment ?? "(사유 없음)"}\n` +
        "사유가 가리키는 곳을 초안에서 고치고, 사유만으로 정할 수 없으면 사람에게 물으세요.",
    );
  }
  // 렌더가 지금 지시서와 같으면 기록할 것이 없다(같은 내용의 다른 초안 표기)
  if (hash !== fileHash) {
    appendRevision(repoRoot, { ...proposal, specHash: hash });
    writeAtomic(join(repoRoot, spec), text);
  }
  const after = requestState(repoRoot, id, spec);
  const place = { workId: id, phase: active?.id === id ? active.phase : "request" };
  recordEvent(repoRoot, { type: "request.submitted", ...place, detail: { revision: proposal.revision, parent: proposal.parent, mode: proposal.mode,
    changes: proposal.changes.length, requirements: proposal.snapshot.items.REQ.length, done: proposal.snapshot.items.DONE.length,
    hash: hash.slice(0, 12), before: before.status, after: after.status } });
  // 확정한 지시서를 바꿨으면 그 확정(과 거기 묶인 계획 승인)은 변경안을 확정할 때까지 쓰이지 않는다
  if (before.status === "confirmed" && after.status !== "confirmed") {
    recordEvent(repoRoot, { type: "invalidated", ...place, reason: proposal.parent > 0 ? `요구 변경안 개정 ${proposal.revision} 제출 — 확정해야 진행` : "확정 뒤 요구사항 재제출 — 다시 확정해야 진행" });
  }
  const amended = proposal.parent > 0;
  const note =
    after.status === "confirmed"
      ? "지금 내용은 이미 확정돼 있습니다 — 바뀐 것이 없습니다."
      : amended
        ? `요구 변경안을 받았습니다 — 확정 개정 ${proposal.parent} 의 결과는 그대로 두고, 변경안을 확정하기 전에는 진행·계획 배정을 멈춥니다.`
        : before.status === "confirmed"
          ? "확정 뒤 내용이 바뀌었습니다 — 사람이 다시 확정해야 진행합니다."
          : "사람이 확정해야 분석이 시작됩니다.";
  const { items } = proposal.snapshot;
  return [
    amended
      ? `요구 변경안을 렌더했습니다: ${spec} — ${pendingLabel(proposal as RevisionRecord)}`
      : `요구사항을 렌더했습니다: ${spec} (${request.kind} · ${request.title})`,
    `  - 대상: ${proposal.document.target.join(", ")}`,
    ...(proposal.document.scope.length > 0 ? [`  - 범위: ${proposal.document.scope.join(", ")}`] : []),
    ...(proposal.document.preserve.length > 0 ? [`  - 보존: ${proposal.document.preserve.join(" / ")}`] : []),
    `  - 요구 내용 ${items.REQ.length}개 · 완료 조건 ${items.DONE.length}개 · 제약 ${items.CON.length}개 · 범위 밖 ${items.OUT.length}개 · 접수 때 정한 것 ${proposal.document.clarifications.length}개`,
    ...proposal.changes.map((change) => `  - ${changeLine(change)}`),
    ...notes.map((line) => `  - ${line}`),
    "",
    traced.missing ? `원문 대조에 미연결 내용이 있습니다: ${traced.missing}\n에이전트가 sourceMap으로 반영·제외를 연결하고 다시 제출하세요. 아직 사용자에게 확정을 요청하지 않습니다.` : note,
    after.status === "confirmed" || traced.missing
      ? ""
      : `현재 호스트 세션에서 원문과 정리를 나란히 읽고 ca-answer의 request 동의 절차로 확정합니다. 적용 뒤 ca-next 흐름을 자동으로 이어갑니다 (직접 CLI를 원하면 TTY에서 \`${confirmCommand(id, spec)}\`, 반려는 \`code-agent reject request ${id} --comment "사유"\`).`,
  ]
    .filter((line, index, all) => !(line === "" && index === all.length - 1))
    .join("\n");
}

// ---- confirm / reject (검증된 세션 선택 또는 수동 TTY) ----

/** 확정할 지시서 자리 — 사람이 경로를 주면 그것, 진행 중인 작업이면 그 지시서, 아니면 접수가 렌더하는 자리 */
export function requestSpecPath(repoRoot: string, id: string, specArg?: string): string {
  if (specArg) return toRepoPath(repoRoot, specArg);
  const active = loadActive(repoRoot);
  return active && active.id === id ? active.spec : requirementFile(id);
}

/**
 * 요구 확정 동의를 적용하면 그 자리에서 작업을 시작하는가 — 진행 중인 작업이 없고 이 ID 를 접수 중일 때(시작 인자인 기준 브랜치·대상이
 * 접수 세션에 있다). 동의 화면의 시작 안내와 적용 뒤 시작이 이 판정 하나를 쓴다. 진행 중인 작업의 재확정은 시작하지 않는다
 */
export function confirmStartsWork(repoRoot: string, id: string): RequestSession | undefined {
  if (loadActive(repoRoot)) return undefined;
  const session = loadRequestSession(repoRoot);
  return session?.id === id ? session : undefined;
}

/** 요구 확정 동의 화면의 시작 안내 — 만들 작업 브랜치와 기준, 시작을 막을 미커밋 변경 */
export function confirmStartNotice(repoRoot: string, session: RequestSession, spec: string): string {
  const branch = `${session.kind}/${session.id}`;
  const exists = isGitRepo(repoRoot) && Boolean(commitOf(repoRoot, branch));
  const base = session.base ?? loadManifestIfAny(repoRoot)?.git.base ?? "master";
  const where = !isGitRepo(repoRoot) ? "git 저장소가 아니라 브랜치는 만들지 않고"
    : exists ? `이미 있는 작업 브랜치 ${branch} 로 전환하고`
    : `작업 브랜치 ${branch} 를 ${base} 에서 만들고`;
  const delivered = isGitRepo(repoRoot) ? deliveredCycle(repoRoot, session.id, spec, exists ? branch : base) : undefined;
  const blockers = exists && !delivered ? [] : startBlockers(repoRoot, session.id, spec);
  return [
    `확정을 적용하면 ${delivered ? `실행 회차 ${delivered.cycle + 1} 로 ` : ""}작업을 시작합니다 — ${where} 분석 단계로 갑니다.` +
      (delivered ? ` 회차 ${delivered.cycle} 반영 커밋 ${delivered.commit.slice(0, 12)} 이 이번 회차의 기준입니다.` : ""),
    ...(blockers.length > 0 ? [`시작 전 정리 필요: ${blockerList(blockers)} — 이대로면 확정만 남고 시작은 막힙니다(사람이 커밋·stash 한 뒤 시작)`] : []),
  ].join("\n");
}

export function decideRequest(
  repoRoot: string,
  id: string | undefined,
  decision: RequestDecision,
  comment?: string,
  specArg?: string,
): string {
  const word = decision === "confirmed" ? "confirm" : "reject";
  if (!id) {
    throw new Stop(`사용법: code-agent ${word} request <ID> [<지시서>]${decision === "rejected" ? ' --comment "사유"' : ""}`);
  }
  if (decision === "rejected" && !comment) {
    throw new Stop(`반려에는 사유가 필요합니다: code-agent reject request ${id} --comment "사유"`);
  }
  const manifest = loadManifestIfAny(repoRoot);
  if (!manifest) {
    throw new Stop(`code-agent.json 이 없습니다. ${skill("ca-adopt")} 로 프로젝트를 먼저 도입하세요.`);
  }
  const spec = requestSpecPath(repoRoot, id, specArg);
  if (spec.startsWith("..") || !existsSync(join(repoRoot, spec))) {
    throw new Stop(
      `지시서가 없습니다: ${spec} — ${skill("ca-request")} 로 접수하면 code-agent request submit 이 ${requirementFile(id)} 에 렌더합니다.\n` +
        `다른 자리에 손으로 쓴 지시서면 경로를 함께 주세요: code-agent ${word} request ${id} <지시서>`,
    );
  }
  // 사람에게 보여 줄 바이트 — 확정하는 것은 이것이다
  const text = readFileSync(join(repoRoot, spec), "utf-8");
  if (decision === "confirmed" && hasUnmappedOriginal(text)) {
    throw new Stop("원문 대조에 미연결 내용이 있습니다 — request.json의 sourceMap으로 반영 항목(REQ/DONE/CON) 또는 명시적인 제외(OUT)를 연결한 뒤 다시 제출하세요. 별도 사용자 질문을 늘리지 말고 원문에 근거해 정리합니다.");
  }
  // 확정하는 것은 규격을 지난 지시서뿐이다 — 손으로 쓴 지시서도 같은 검사를 지난다
  let order: WorkOrder;
  try {
    order = validateWorkOrder(repoRoot, parseFrontMatter(text) ?? {}, spec, {
      attributes: manifest.workOrder.attributes,
      requireApprover: manifest.workOrder.requireApprover,
    });
  } catch (error) {
    if (error instanceof WorkOrderError) throw new Stop(error.message);
    throw error;
  }
  if (order.id !== id) {
    throw new Stop(`지시서의 id(${order.id}) 가 ${id} 와 다릅니다: ${spec}`);
  }
  const missingLog = decision === "confirmed" ? errorLogProblems(order.kind, text) : [];
  if (missingLog.length > 0) throw new Stop(`${spec}: ${missingLog.map((problem) => problem.detail).join("\n")}`);
  const state = requestState(repoRoot, id, spec);
  if (decision === "confirmed" && state.status === "confirmed") {
    return `${id} 요구사항은 지금 내용으로 이미 확정돼 있습니다 (${state.record.hash}).`;
  }
  const pending = revisionHeads(repoRoot, id, spec).pending;
  const amended = pending && pending.parent > 0 && pending.specHash === textHash(text) ? pending : undefined;
  const shown = [
    text.replace(/\s+$/, ""),
    "",
    "----",
    ...(amended ? [`요구 변경안 ${pendingLabel(amended)} — 확정 개정 ${amended.parent} 에서 바뀌는 것:`, ...amended.changes.map((change) => `- ${changeLine(change)}`), ""] : []),
    decision === "confirmed"
      ? amended
        ? `확정하면 이 개정이 분석 · 설계 · 계획의 근거가 됩니다. 언급하지 않은 항목은 그대로 남습니다 — 변경과 최종 전체를 직접 읽고 확인하세요 (${spec}).`
        : `확정하면 이 요구사항이 분석 · 설계 · 계획의 근거가 됩니다. 원문과 정리가 같은 뜻인지 직접 읽고 확인하세요 (${spec}).`
      : amended
        ? `반려 사유: ${comment}\n반려하면 지시서를 확정 개정 ${amended.parent} 으로 되돌리고 그 개정으로 이어갑니다.`
        : `반려 사유: ${comment}`,
  ].join("\n");
  const presence = confirmOnTerminal(shown, word);
  // 사람이 읽는 사이에 다시 제출됐으면 남기지 않는다 — 보여 준 것과 남는 것이 같아야 한다
  const hash = textHash(text);
  if (requirementHash(repoRoot, spec) !== hash) {
    throw new Stop(`확정하는 동안 지시서가 바뀌었습니다 — 판정을 남기지 않았습니다. 다시 읽고 판정하세요: ${spec}`);
  }
  const { record, flow } = recordDecision(repoRoot, {
    id,
    spec,
    decision,
    approver: order.approver ?? actorName(),
    presence,
    comment,
    hash,
  });
  if (decision === "rejected") {
    return amended
      ? `${id} 요구 변경안 ${pendingLabel(amended)} 반려를 남기고 지시서를 확정 개정 ${amended.parent} 으로 되돌렸습니다. 진행 중이던 흐름은 그 개정으로 이어갑니다.`
      : `${id} 요구사항 반려를 남겼습니다. ${skill("ca-request")} 가 사유를 읽고 다시 정리합니다.`;
  }
  if (amended) {
    return `${id} 요구 변경안을 개정 ${amended.revision} 으로 확정했습니다 (${record.hash}).${flow ? `\n${flow}` : " 현재 호스트 세션에서는 ca-next 흐름으로 이어갑니다."}`;
  }
  return `${id} 요구사항을 확정했습니다 (${record.hash}). 현재 호스트 세션에서는 ca-next 흐름으로 분석을 자동으로 이어갑니다 (수동 재개: ${skill("ca-next")} 또는 ${skill("ca-analyze")}).`;
}

// ---- status (작업이 없을 때) ----

export function requestStatusLines(repoRoot: string, session: RequestSession): { lines: string[]; hint: string } {
  const spec = requirementFile(session.id);
  const draft = existsSync(join(repoRoot, requestDraftFile(session.id)));
  const starting = [session.base ? `기준 브랜치 ${session.base}` : "", session.target ? `대상 ${session.target}` : ""].filter(Boolean);
  const lines = [
    `접수: ${session.id} (${session.kind}) — 작업 폴더 ${workDocsDir(session.id)}/${starting.length > 0 ? ` · 시작할 때 ${starting.join(" · ")}` : ""}`,
    `초안: ${draft ? requestDraftFile(session.id) : "없음"}`,
    requestStateLine(repoRoot, session.id, spec),
  ];
  // 작업 브랜치가 아직 없으면 시작 때 따라갈 미커밋 변경을 미리 알린다 — 다음: 은 바꾸지 않는다(접수·확정은 그대로 진행한다)
  const blockers = commitOf(repoRoot, `${session.kind}/${session.id}`) ? [] : startBlockers(repoRoot, session.id, spec);
  if (blockers.length > 0) lines.push(`시작 전 정리 필요: ${blockerList(blockers)} — 사람이 커밋·stash 한 뒤 시작합니다`);
  return { lines, hint: preparationHint(repoRoot) ?? requestHint(repoRoot, session.id, spec) };
}
