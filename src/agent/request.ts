import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "path";
import { userInfo } from "os";
import { z } from "zod";

import { writeAtomic } from "../core/atomic";
import { APPROVALS_DIR } from "../core/approval";
import type { Presence } from "../core/approval";
import type { Manifest } from "../core/manifest";
import { KINDS, parseFrontMatter, slug, validateWorkOrder, WorkOrderError } from "../core/workOrder";
import type { WorkKind, WorkOrder } from "../core/workOrder";
import { sha } from "./docs";
import { canonical, DOCS_SESSION_FILE, loadActive, logStage, REQUEST_SESSION_FILE, STATE_DIR, workDocsDir } from "./layout";
import { Stop } from "./stop";
import { confirmOnTerminal } from "./tty";
import { loadManifestIfAny, loadWork } from "./work";
import { checkProjectDocs, docsReady } from "./docs";
import { hasUnmappedOriginal, intakeTrace } from "./intakeTrace";

/**
 * 요구사항 접수 — 13단계의 1.
 *
 * 사람은 요구사항을 **말로** 준다(서술 · 붙여넣은 티켓 · 파일). 모델이 그것을 `request.json` 으로 정리하고,
 * 코드가 지시서 규칙으로 검사해 `requirement.md` 를 렌더하고, 사람이 현재 Claude 세션의 선택으로 확정한다. 확정된 요구사항만
 * `code-agent start` 가 받는다 — 모델이 지시서를 지어내 스스로 시작하는 길과, 정리하다 원문과 뜻이 달라지는
 * 길이 같은 자리(사람의 확정)에서 닫힌다.
 *
 * 접수 동안에는 아직 작업 커서가 없다. 그래서 문서 세션처럼 **접수 세션**을 열고, hook 이 그 작업 폴더 밖과
 * 지시서 자체에 대한 쓰기를 막는다.
 */

export interface RequestSession {
  id: string;
  kind: WorkKind;
  startedAt: string;
  /**
   * 사람이 접수 때 말한 시작 인자. 접수와 시작 사이에 사람의 확정이 끼어 명령이 끊기므로,
   * 여기 남겨 두지 않으면 `/ca-feature … --base develop` 의 기준 브랜치가 확정 뒤 `start` 에서 사라진다.
   */
  base?: string;
  target?: string;
}

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

export function loadRequestSession(repoRoot: string): RequestSession | undefined {
  const path = join(repoRoot, REQUEST_SESSION_FILE);
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf-8")) as RequestSession;
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
    target: z.array(ONE_LINE("target")).min(1),
    scope: z.array(ONE_LINE("scope")).default([]),
    preserve: z.array(ONE_LINE("preserve")).default([]),
    approver: ONE_LINE("approver").optional(),
    extra: z.record(z.string(), z.union([ONE_LINE("extra"), z.array(ONE_LINE("extra"))])).default({}),
    original: z.string().optional(),
    originalFile: z.string().optional(),
    background: z.string().default(""),
    requirements: z.array(z.string().trim().min(1)).min(1),
    done: z.array(z.string().trim().min(1)).default([]),
    outOfScope: z.array(z.string().trim().min(1)).default([]),
    constraints: z.array(z.string().trim().min(1)).default([]),
    sourceMap: z.array(z.object({ quote: z.string().trim().min(1), targets: z.array(z.string().trim().min(1)).min(1), note: z.string().optional() })).optional(),
    clarifications: z.array(z.object({ question: z.string().trim().min(1), answer: z.string().trim().min(1) })).default([]),
  })
  .superRefine((request, ctx) => {
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

function frontMatter(request: RequestDraft): string {
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

function bullets(items: string[], none: string): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : `- ${none}`;
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

export function renderRequirement(request: RequestDraft, original: string, source: string): string {
  return [
    frontMatter(request),
    "",
    `${RENDER_MARK}${requestDraftFile(request.id)} 에서 렌더한다. 고칠 것은 request.json 에 쓰고 다시 제출한다 — ` +
      `현재 Claude 세션에서 ca-answer의 request 동의 절차로 ${request.id} 요구사항을 확정하면 ca-next 흐름이 자동으로 이어진다. -->`,
    "",
    `# ${request.id} 요구사항 — ${request.title}`,
    "",
    `## 원문`,
    "",
    `<!-- ${source} -->`,
    quoted(original),
    "",
    intakeTrace(original, request).text,
    "## 배경",
    "",
    request.background.trim() === "" ? "- 없음" : request.background.trim(),
    "",
    "## 요구 내용",
    "",
    request.requirements.map((text, index) => `- [REQ-${index + 1}] ${text.replace(/\r?\n/g, "\n  ")}`).join("\n"),
    "",
    "## 완료 조건",
    "",
    request.done.length ? request.done.map((text, index) => `- [DONE-${index + 1}] ${text.replace(/\r?\n/g, "\n  ")}`).join("\n") : "- 원문에 없음 — 분석 단계의 수락 기준(AC)에서 정한다",
    "",
    "## 범위 밖",
    "",
    bullets(request.outOfScope, "없음"),
    "",
    "## 제약",
    "",
    request.constraints.length ? request.constraints.map((text, index) => `- [CON-${index + 1}] ${text.replace(/\r?\n/g, "\n  ")}`).join("\n") : "- 없음",
    "",
    "## 접수 때 정한 것",
    "",
    request.clarifications.length > 0
      ? request.clarifications.map((entry) => `- Q: ${entry.question}\n  - A: ${entry.answer}`).join("\n")
      : "- 없음",
    "",
  ].join("\n");
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
}

/** 줄바꿈 · BOM 은 내용이 아니다 — autocrlf 가 확정을 무효로 만들지 않게 */
function textHash(text: string): string {
  return sha(text.replace(/^﻿/, "").replace(/\r\n/g, "\n"));
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
  return existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter((line) => line.trim() !== "") : [];
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
  const hash = input.hash ?? requirementHash(repoRoot, input.spec);
  if (!hash) {
    throw new Stop(`지시서가 없습니다: ${input.spec}`);
  }
  readRequestLedger(repoRoot, input.id);
  const lines = ledgerLines(repoRoot, input.id);
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
  };
  const path = requestLedgerFile(repoRoot, input.id);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
  return record;
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
  if (last.hash !== requirementHash(repoRoot, spec)) return { status: "unconfirmed", record: last };
  if (last.decision === "rejected") return { status: "rejected", record: last };
  if (requiresVerified(repoRoot) && last.presence?.verified !== true) return { status: "unverified", record: last };
  return { status: "confirmed", record: last };
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
          "/ca-request 로 사유대로 고쳐 다시 제출하세요 — 확정은 현재 Claude 세션에서 ca-answer의 request 동의 절차로 받습니다.",
      );
    case "unconfirmed":
      throw new Stop(
        (state.record.decision === "confirmed"
          ? `요구사항이 확정 뒤 바뀌었습니다 (${spec}). 다시 확정해야 진행합니다.\n`
          : `요구사항이 다시 제출돼 확정을 기다립니다 (${spec}).\n`) +
          `현재 Claude 세션에서 ca-answer의 request 동의 절차로 다시 확인하세요. 적용 뒤 ca-next 흐름을 자동으로 이어갑니다 (직접 CLI를 원하면 TTY에서 ${confirmCommand(id, spec)}).`,
      );
    case "unverified":
      throw new Stop(
        `요구사항 확정에 사람이 관측되지 않았습니다 (${spec} · ${state.record.presence?.detail ?? "기록 없음"}).\n` +
          `이 프로젝트는 관측된 판정만 받습니다 (code-agent.json 의 workOrder.requireVerifiedApproval) — 현재 Claude 세션에서 ca-answer의 request 동의 절차로 확인하세요 (직접 CLI를 원하면 TTY에서 ${confirmCommand(id, spec)}).`,
      );
    case "none":
      throw new Stop(
        `요구사항이 확정되지 않았습니다 (${spec}).\n` +
          `현재 Claude 세션에서 ca-answer의 request 동의 절차로 확정하면 ca-next 흐름을 자동으로 이어갑니다 — 요구사항 접수는 /ca-request (직접 CLI를 원하면 TTY에서 ${confirmCommand(id, spec)}).`,
      );
  }
}

/** status 한 줄 */
export function requestStateLine(repoRoot: string, id: string, spec: string): string {
  if (!existsSync(join(repoRoot, spec))) return "요구사항: 아직 렌더되지 않음";
  const state = requestState(repoRoot, id, spec);
  switch (state.status) {
    case "confirmed":
      return `요구사항: 확정됨 (${state.record.hash.slice(-12)} · ${state.record.at.slice(0, 10)})`;
    case "rejected":
      return `요구사항: 반려됨 — ${state.record.comment ?? "(사유 없음)"}`;
    case "unconfirmed":
      return state.record.decision === "confirmed" ? "요구사항: 확정 뒤 바뀜 — 다시 확정 필요" : "요구사항: 다시 제출됨 — 확정 대기";
    case "unverified":
      return "요구사항: 확정에 사람이 관측되지 않음 — 현재 Claude 세션에서 ca-answer의 request 동의 절차로 다시 확정 필요";
    case "none":
      return "요구사항: 확정 대기";
  }
}

/** 그 상태에서 사람 또는 모델이 할 일 한 줄 — status · context · 거부문이 같은 말을 하게 */
export function requestHint(repoRoot: string, id: string, spec: string): string {
  if (!existsSync(join(repoRoot, spec))) {
    return `/ca-request — 초안을 ${requestDraftFile(id)} 에 쓰고 code-agent request submit ${requestDraftFile(id)}`;
  }
  const state = requestState(repoRoot, id, spec);
  switch (state.status) {
    case "confirmed":
      return `확정됨 — /ca-next 또는 /ca-analyze 가 code-agent start ${spec} 로 분석을 시작합니다`;
    case "rejected":
      return `/ca-request — 반려됐습니다: ${state.record.comment ?? "(사유 없음)"} — 사유대로 초안을 고쳐 다시 제출하세요`;
    default:
      if (hasUnmappedOriginal(readFileSync(join(repoRoot, spec), "utf8"))) return "/ca-request — 원문 대조의 미연결 내용을 sourceMap으로 정리한 뒤 다시 제출합니다";
      return `현재 Claude 세션에서 ca-answer의 request 동의 절차로 확인한 뒤 ca-next 흐름을 자동으로 이어갑니다 (직접 CLI를 원하면 TTY에서 ${confirmCommand(id, spec)}, 반려는 code-agent reject request ${id} --comment "사유").`;
  }
}

// ---- begin ----

function requireIntakeAllowed(repoRoot: string): Manifest {
  const manifest = loadManifestIfAny(repoRoot);
  if (!manifest) {
    throw new Stop("code-agent.json 이 없습니다. /ca-adopt 로 프로젝트를 먼저 도입하세요.");
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
  options: { base?: string; target?: string } = {},
): string {
  if (existsSync(join(repoRoot, DOCS_SESSION_FILE))) throw new Stop("문서 작성 세션이 열려 있습니다 — code-agent docs end 로 닫은 뒤 요구사항을 접수하세요.");
  if (!id) {
    id = loadRequestSession(repoRoot)?.id;
    for (let n = 1; !id; n++) {
      const candidate = `WORK-${String(n).padStart(4, "0")}`;
      if (!existsSync(join(repoRoot, workDocsDir(candidate))) && !existsSync(requestLedgerFile(repoRoot, candidate))) id = candidate;
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
        ? `${id} 는 이미 시작된 작업입니다 (${active.phase}). 요구사항을 고치려면 ${requestDraftFile(id)} 를 고쳐 code-agent request submit 으로 다시 제출하고, 사람이 다시 확정합니다.`
        : `진행 중인 작업이 있습니다: ${active.id} (${active.phase}). 끝내거나 현재 Claude 세션에서 ca-answer의 abort 동의 절차로 종료한 뒤 접수하세요.`,
    );
  }
  const current = loadRequestSession(repoRoot);
  if (current && current.id !== id) {
    throw new Stop(
      `접수 중인 요구사항이 있습니다: ${current.id} (${current.kind}). 그것을 끝내거나 현재 Claude 세션에서 ca-answer의 abort 동의 절차로 종료한 뒤 접수하세요.`,
    );
  }
  if (current && current.kind !== kind) {
    throw new Stop(`${id} 는 ${current.kind} 로 접수 중입니다 — 종류를 바꾸려면 현재 Claude 세션에서 ca-answer의 abort 동의 절차로 종료하고 다시 접수합니다.`);
  }
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
  mkdirSync(join(repoRoot, workDocsDir(id)), { recursive: true });
  return [
    current
      ? `이미 접수 중입니다: ${id} (${kind}) — 이어서 정리합니다.`
      : `요구사항 접수를 열었습니다: ${id} (${kind}). 끝날 때까지 ${workDocsDir(id)}/ 밖은 쓸 수 없고, 지시서(requirement.md)는 코드만 씁니다.`,
    "",
    requestContext(repoRoot, session),
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
  throw new Stop("접수 중인 요구사항이 없습니다 — code-agent request begin [ID] --kind <feature|fix|refactor> 로 접수를 여세요 (/ca-request).");
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
  };
  const out = [
    `# code-agent request — ${id} 접수 (${kind})`,
    "",
    `- 초안: ${requestDraftFile(id)} — 모델이 쓴다`,
    `- 지시서: ${spec} — code-agent request submit 이 초안에서 렌더한다 (모델 쓰기 거부)`,
    `- 확정: 현재 Claude 세션에서 ca-answer의 request 동의 절차로 확인하고 적용 뒤 ca-next 흐름을 자동으로 이어갑니다 (직접 CLI를 원하면 TTY에서 ${confirmCommand(id, spec)}, 반려는 code-agent reject request ${id} --comment "사유").`,
    `- 지금: ${requestStateLine(repoRoot, id, spec).replace(/^요구사항: /, "")}`,
    "",
    "## request.json",
    "```json",
    JSON.stringify(example, null, 2),
    "```",
    "- 원문은 `original`(사람이 준 글) 또는 `originalFile`(사람이 준 파일의 저장소 경로 — 코드가 그 파일을 그대로 옮긴다) 중 하나.",
    "- `requirements` 는 1개 이상. 원문에 없는 요구를 더하지 않는다 — 있으면 좋을 것 같은 것은 질문으로.",
    "- `sourceMap`: 원문 인용 quote → REQ-1 / DONE-1 / CON-1 / OUT-1 / TITLE / BACKGROUND. 그대로 옮긴 문장은 자동 연결. 바꿔 쓴 문장·명시적 제외는 연결을 적고 미연결 원문을 남기지 않습니다. 추가 사용자 선택이 아니라 에이전트의 정리 작업입니다.",
    "- 머리말에 들어가는 값(title · target · scope · preserve · approver · extra)은 한 줄씩. 따옴표나 [ ] 로 감싸지 않는다.",
    pathKind
      ? `- ${kind}: target 은 **저장소에 있는 경로**, scope · preserve 는 필수다. scope 도 실재하는 경로여야 한다.`
      : "- feature: target 은 이제부터 만들 도메인·기능 이름이라 경로가 아니어도 된다. scope 를 적으면 실재하는 경로여야 한다.",
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
    "## 질문 — 접수에서 물을 것",
    "- 기술값은 기존 구성·명명 규칙을 근거로 제안한다. 원문으로 정할 수 없는 의미·범위·보존 조건과 두 가지로 읽히는 곳만 묻는다.",
    "- ca-answer 공통 절차의 AskUserQuestion으로 최대 4개 질문씩 받는다. 추천·이유를 붙이고 5개 이상 후보는 페이지를 나눈다. 질문과 선택지는 questions.md, 실제 답은 해당 질문과 clarifications 에 그대로 남긴다.",
    "- 업무 규칙의 세부 · 설계 · 테스트는 여기서 묻지 않는다 — 분석 단계가 맡는다.",
    "",
    `다음: ${preparationHint(repoRoot) ?? requestHint(repoRoot, id, spec)}`,
  );
  return out.join("\n");
}

/** 접수는 보존하고 준비를 먼저 한다. 분석은 start 의 문서 확정 게이트 뒤에서만 열린다. */
export function preparationHint(repoRoot: string): string | undefined {
  const manifest = loadManifestIfAny(repoRoot);
  if (!manifest) return "/ca-adopt 로 프로젝트 준비 — 접수 ID와 원문 초안을 유지합니다. 추천 설정은 code-agent docs recommend";
  const checks = checkProjectDocs(repoRoot, manifest);
  if (!docsReady(checks)) return checks.some((entry) => entry.state === "missing-file" || entry.state === "missing-sections")
    ? "/ca-docs 로 빠진 공통 문서 준비 — 접수를 취소하지 않고 code-agent docs begin 으로 이어갑니다"
    : "현재 Claude 세션에서 ca-answer의 docs 동의 절차로 공통 문서를 확정하고 적용 뒤 ca-next 흐름을 자동으로 이어갑니다";
  if (existsSync(join(repoRoot, DOCS_SESSION_FILE))) return "code-agent docs end 로 준비를 마치고 접수를 이어갑니다";
  return undefined;
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
    let kind: WorkKind | undefined;
    try {
      kind = loadWork(repoRoot)?.order.kind;
    } catch {
      kind = undefined;
    }
    owner = { id: active.id, kind };
  }
  if (!owner) {
    throw new Stop("접수 중인 요구사항이 없습니다 — code-agent request begin [ID] --kind <종류> 로 접수를 여세요 (/ca-request).");
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
    throw new Stop(
      "접수 초안의 형식이 맞지 않습니다:\n" +
        parsed.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n") +
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

  const traced = intakeTrace(original, request);
  if (traced.problems.length) throw new Stop(`원문 연결이 올바르지 않습니다:\n${traced.problems.join("\n")}`);
  const text = renderRequirement(request, original, source);
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

  // 사람이 편집기로 쓴 지시서는 덮지 않는다 — 렌더한 파일에는 코드가 남긴 표시가 있다
  const existing = existsSync(join(repoRoot, spec)) ? readFileSync(join(repoRoot, spec), "utf-8") : undefined;
  if (existing !== undefined && !existing.includes(RENDER_MARK)) {
    throw new Stop(
      `사람이 쓴 지시서가 이미 있습니다: ${spec} — 덮어쓰지 않았습니다.\n` +
        `그 지시서로 하려면 현재 Claude 세션에서 ca-answer의 request 동의 절차로 확정하세요 (직접 CLI를 원하면 TTY에서 ${confirmCommand(request.id, spec)}). 적용 뒤 ca-next 흐름에서 code-agent start ${spec} 로 자동으로 이어갑니다. ` +
        "접수로 새로 받으려면 사람이 그 파일을 옮기거나 지웁니다.",
    );
  }
  const before = requestState(repoRoot, request.id, spec);
  // 반려된 그 내용을 그대로 다시 내지 않는다 — 사유를 읽지 않은 제출은 사람에게 같은 화면을 한 번 더 보일 뿐이다
  const lastDecision = readRequestLedger(repoRoot, request.id)
    .filter((record) => record.id === request.id && record.spec === spec)
    .pop();
  if (lastDecision?.decision === "rejected" && lastDecision.hash === textHash(text)) {
    throw new Stop(
      `반려된 내용과 같습니다 — 다시 제출하지 않았습니다. 반려 사유: ${lastDecision.comment ?? "(사유 없음)"}\n` +
        "사유가 가리키는 곳을 초안에서 고치고, 사유만으로 정할 수 없으면 사람에게 물으세요.",
    );
  }
  writeAtomic(join(repoRoot, spec), text);
  const after = requestState(repoRoot, request.id, spec);
  const note =
    after.status === "confirmed"
      ? "지금 내용은 이미 확정돼 있습니다 — 바뀐 것이 없습니다."
      : before.status === "confirmed"
        ? "확정 뒤 내용이 바뀌었습니다 — 사람이 다시 확정해야 진행합니다."
        : "사람이 확정해야 분석이 시작됩니다.";
  return [
    `요구사항을 렌더했습니다: ${spec} (${request.kind} · ${request.title})`,
    `  - 대상: ${request.target.join(", ")}`,
    ...(request.scope.length > 0 ? [`  - 범위: ${request.scope.join(", ")}`] : []),
    ...(request.preserve.length > 0 ? [`  - 보존: ${request.preserve.join(" / ")}`] : []),
    `  - 요구 내용 ${request.requirements.length}개 · 완료 조건 ${request.done.length}개 · 접수 때 정한 것 ${request.clarifications.length}개`,
    "",
    traced.missing ? `원문 대조에 미연결 내용이 있습니다: ${traced.missing}\n에이전트가 sourceMap으로 반영·제외를 연결하고 다시 제출하세요. 아직 사용자에게 확정을 요청하지 않습니다.` : note,
    after.status === "confirmed" || traced.missing
      ? ""
      : `현재 Claude 세션에서 원문과 정리를 나란히 읽고 ca-answer의 request 동의 절차로 확정합니다. 적용 뒤 ca-next 흐름을 자동으로 이어갑니다 (직접 CLI를 원하면 TTY에서 \`${confirmCommand(request.id, spec)}\`, 반려는 \`code-agent reject request ${request.id} --comment "사유"\`).`,
  ]
    .filter((line, index, all) => !(line === "" && index === all.length - 1))
    .join("\n");
}

// ---- confirm / reject (검증된 세션 선택 또는 수동 TTY) ----

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
    throw new Stop("code-agent.json 이 없습니다. /ca-adopt 로 프로젝트를 먼저 도입하세요.");
  }
  // 지시서 자리 — 사람이 경로를 주면 그것, 진행 중인 작업이면 그 지시서, 아니면 접수가 렌더하는 자리
  const active = loadActive(repoRoot);
  const spec = specArg
    ? toRepoPath(repoRoot, specArg)
    : active && active.id === id
      ? active.spec
      : requirementFile(id);
  if (spec.startsWith("..") || !existsSync(join(repoRoot, spec))) {
    throw new Stop(
      `지시서가 없습니다: ${spec} — /ca-request 로 접수하면 code-agent request submit 이 ${requirementFile(id)} 에 렌더합니다.\n` +
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
  const state = requestState(repoRoot, id, spec);
  if (decision === "confirmed" && state.status === "confirmed") {
    return `${id} 요구사항은 지금 내용으로 이미 확정돼 있습니다 (${state.record.hash}).`;
  }
  const shown = [
    text.replace(/\s+$/, ""),
    "",
    "----",
    decision === "confirmed"
      ? `확정하면 이 요구사항이 분석 · 설계 · 계획의 근거가 됩니다. 원문과 정리가 같은 뜻인지 직접 읽고 확인하세요 (${spec}).`
      : `반려 사유: ${comment}`,
  ].join("\n");
  const presence = confirmOnTerminal(shown, word);
  // 사람이 읽는 사이에 다시 제출됐으면 남기지 않는다 — 보여 준 것과 남는 것이 같아야 한다
  const hash = textHash(text);
  if (requirementHash(repoRoot, spec) !== hash) {
    throw new Stop(`확정하는 동안 지시서가 바뀌었습니다 — 판정을 남기지 않았습니다. 다시 읽고 판정하세요: ${spec}`);
  }
  const record = recordRequestDecision(repoRoot, {
    id,
    spec,
    decision,
    approver: order.approver ?? userInfo().username,
    presence,
    comment,
    hash,
  });
  return decision === "confirmed"
    ? `${id} 요구사항을 확정했습니다 (${record.hash}). 현재 Claude 세션에서는 ca-next 흐름으로 분석을 자동으로 이어갑니다 (수동 재개: /ca-next 또는 /ca-analyze).`
    : `${id} 요구사항 반려를 남겼습니다. Claude Code 에서 /ca-request 가 사유를 읽고 다시 정리합니다.`;
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
  return { lines, hint: preparationHint(repoRoot) ?? requestHint(repoRoot, session.id, spec) };
}
