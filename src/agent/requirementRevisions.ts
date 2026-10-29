/**
 * 요구 개정 — 같은 작업 ID 의 최초 원문과 후속 원문, 개정마다의 변경(추가·수정·삭제·전체 교체)과 현재 유효 요구 전체(스냅샷)를 남긴다.
 * `requirement.md` 는 이 기록에서 렌더한 사본이고, 확정은 요구 확정 원장(`request.jsonl`)이 그 렌더의 해시로 남긴다 —
 * 확정 원장에 해시가 있는 개정이 확정본이고, 그 뒤의 개정은 수정안이다.
 *
 * 항목 ID 는 배열 위치가 아니라 이 기록이 정한다. 수정은 같은 ID, 추가는 새 ID 이고, 삭제한 ID 는 이력에 남기고 다시 쓰지 않는다.
 * 자연어는 해석하지 않는다 — 변경안은 담당이 구조화하고, 코드는 부모 개정·항목 ID·누락·변경 범위·해시·출처만 검사한다.
 * 기록은 확정 원장처럼 append only 이고 사슬로 묶는다. 반영 커밋에 함께 들어간다(승인 디렉토리 안).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join, relative } from "path";
import { APPROVALS_DIR } from "../core/approval";
import { parseFrontMatter, slug } from "../core/workOrder";
import { sha } from "./docs";
import { sourceItems } from "./sourceTrace";
import { Stop } from "./stop";

export const SECTIONS = ["REQ", "DONE", "CON", "OUT"] as const;
export type Section = typeof SECTIONS[number];
export const SECTION_LABEL: Record<Section, string> = { REQ: "요구 내용", DONE: "완료 조건", CON: "제약", OUT: "범위 밖" };

export interface RequirementItem { id: string; text: string; since: number; updated?: number }
export interface RemovedItem { id: string; text: string; removedIn: number; reason: string }
export interface Snapshot { items: Record<Section, RequirementItem[]>; removed: RemovedItem[]; next: Record<Section, number> }
export type Change =
  | { op: "add"; id: string; text: string }
  | { op: "modify"; id: string; before: string; text: string }
  | { op: "remove"; id: string; before: string; reason: string }
  | { op: "header"; field: string; before: string; after: string };
/** 담당이 구조화한 변경 — add 의 id 는 생략하면 다음 번호를 붙인다 */
export type DraftChange =
  | { op: "add"; section: Section; id?: string; text: string }
  | { op: "modify"; id: string; text: string }
  | { op: "remove"; id: string; reason: string };
export interface OriginalText { revision: number; text: string; source: string; hash: string }
export interface RevisionDocument {
  kind: string; id: string; title: string; target: string[]; scope: string[]; preserve: string[]; approver?: string;
  extra: Record<string, string | string[]>;
  background: string; clarifications: { question: string; answer: string }[];
  errorLog?: { text: string; source: string }; noErrorLog?: { reason: string; steps: string[] };
  /** 최초 원문부터 이 개정의 후속 원문까지 — 받은 순서대로 */
  originals: OriginalText[];
  /** 이 개정에서 받은 원문(아직 확정되지 않은 원문)의 연결 */
  sourceMap?: { quote: string; targets: string[]; note?: string }[];
}
export type RevisionMode = "initial" | "amend" | "replace" | "migrated";
export interface RevisionRecord {
  workId: string;
  /** 이 기록이 확정되면 갖는 개정 번호 — 부모 + 1 */
  revision: number;
  /** 기준으로 삼은 확정 개정(최초는 0)과 그 렌더 해시 */
  parent: number; parentHash?: string;
  mode: RevisionMode;
  changes: Change[];
  snapshot: Snapshot;
  document: RevisionDocument;
  /** 확정된 앞 개정들의 요약 — 렌더의 개정 이력 */
  history: { revision: number; mode: RevisionMode; changes: number; at: string }[];
  replaceQuote?: string;
  /** 같은 변경안의 재전송을 가르는 해시(초안의 내용 + 부모) */
  draftHash: string;
  /** 렌더한 requirement.md 의 해시 — 확정 원장이 이 값으로 확정한다 */
  specHash: string;
  at: string;
  prev: string;
  /** 이전 형식으로 확정된 지시서를 이행한 기록만 — 그 지시서 그대로(수정안 반려 때 이것으로 되돌린다) */
  legacyText?: string;
}

/** 줄바꿈 · BOM 은 내용이 아니다 — autocrlf 가 확정을 무효로 만들지 않게 */
export function textHash(text: string): string {
  return sha(text.replace(/^﻿/, "").replace(/\r\n/g, "\n"));
}
export const normalizeText = (text: string): string => text.normalize("NFC").replace(/\s+/g, " ").trim();

export function revisionLogFile(repoRoot: string, id: string): string {
  return join(repoRoot, APPROVALS_DIR, slug(id), "requirements.jsonl");
}

function logLines(repoRoot: string, id: string): string[] {
  const path = revisionLogFile(repoRoot, id);
  return existsSync(path) ? readFileSync(path, "utf-8").split(/\r?\n/).filter((line) => line.trim() !== "") : [];
}

/** 사슬을 검사하며 읽는다. 끊겼으면 던진다 — 나중에 고친 개정을 조용히 믿지 않는다 */
export function readRevisions(repoRoot: string, id: string): RevisionRecord[] {
  const lines = logLines(repoRoot, id);
  return lines.map((line, index) => {
    const record = JSON.parse(line) as RevisionRecord;
    if (record.prev !== (index === 0 ? "genesis" : sha(lines[index - 1]))) {
      throw new Stop(`요구 개정 기록이 나중에 고쳐졌습니다 — 읽지 않았습니다: ${relative(repoRoot, revisionLogFile(repoRoot, id)).replace(/\\/g, "/")}\n` +
        `  ${index + 1}번째 줄에서 사슬이 끊겼습니다. 기록은 append only 입니다 — git 으로 복원하세요.`);
    }
    return record;
  }).filter((record) => record.workId === id);
}

export function appendRevision(repoRoot: string, record: Omit<RevisionRecord, "prev">): RevisionRecord {
  const lines = logLines(repoRoot, record.workId);
  const full: RevisionRecord = { ...record, prev: lines.length === 0 ? "genesis" : sha(lines[lines.length - 1]) };
  const path = revisionLogFile(repoRoot, record.workId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(full)}\n`, "utf-8");
  return full;
}

// ---- 스냅샷 ----

const emptyItems = (): Record<Section, RequirementItem[]> => ({ REQ: [], DONE: [], CON: [], OUT: [] });
const ID_FORMAT = /^(REQ|DONE|CON|OUT)-(\d+)$/;

export function itemCount(snapshot: Snapshot): number {
  return SECTIONS.reduce((sum, section) => sum + snapshot.items[section].length, 0);
}

/** 최초 개정 — 목록 위치로 ID 를 붙인다(접수의 sourceMap 이 REQ-1 처럼 위치로 가리킨다) */
export function initialSnapshot(lists: Record<Section, string[]>, revision: number): Snapshot {
  const items = emptyItems(), next = { REQ: 1, DONE: 1, CON: 1, OUT: 1 };
  for (const section of SECTIONS) {
    items[section] = lists[section].map((text, index) => ({ id: `${section}-${index + 1}`, text, since: revision }));
    next[section] = lists[section].length + 1;
  }
  return { items, removed: [], next };
}

function locate(snapshot: Snapshot, id: string): { section: Section; index: number } | undefined {
  for (const section of SECTIONS) {
    const index = snapshot.items[section].findIndex((item) => item.id === id);
    if (index >= 0) return { section, index };
  }
  return undefined;
}

/**
 * 변경 적용 — 언급하지 않은 항목은 그대로 둔다(기본은 보존). 문제를 모두 모아 한 번에 거부한다.
 * 추가는 새 ID(이전에 쓴 적 없는 번호), 수정은 같은 ID, 삭제는 사유와 함께 이력으로 옮긴다.
 */
export function applyChanges(parent: Snapshot, draft: DraftChange[], revision: number): { snapshot: Snapshot; changes: Change[] } {
  const snapshot: Snapshot = { items: emptyItems(), removed: [...parent.removed], next: { ...parent.next } };
  for (const section of SECTIONS) snapshot.items[section] = parent.items[section].map((item) => ({ ...item }));
  const problems: string[] = [], changes: Change[] = [], touched = new Set<string>();
  const once = (id: string) => {
    if (touched.has(id)) { problems.push(`${id}: 한 개정에서 같은 항목을 두 번 바꿀 수 없습니다`); return false; }
    touched.add(id);
    return true;
  };
  for (const change of draft) {
    if (change.op === "add") {
      const text = change.text.trim();
      const existing = snapshot.items[change.section].find((item) => normalizeText(item.text) === normalizeText(text));
      if (existing) { problems.push(`추가하려는 내용이 이미 ${existing.id} 에 있습니다: ${text} — 같은 요구를 두 번 반영하지 않습니다`); continue; }
      let id = change.id?.trim();
      if (id) {
        const match = ID_FORMAT.exec(id);
        if (!match || match[1] !== change.section) { problems.push(`${id}: ${change.section} 절의 새 ID 는 ${change.section}-<번호> 입니다`); continue; }
        if (Number(match[2]) < snapshot.next[change.section]) { problems.push(`${id}: 이미 쓴 ID 입니다 — 새 ID 는 ${change.section}-${snapshot.next[change.section]} 부터입니다(삭제한 ID 도 다시 쓰지 않습니다)`); continue; }
      } else id = `${change.section}-${snapshot.next[change.section]}`;
      if (!once(id)) continue;
      snapshot.items[change.section].push({ id, text, since: revision });
      snapshot.next[change.section] = Math.max(snapshot.next[change.section], Number(ID_FORMAT.exec(id)![2]) + 1);
      changes.push({ op: "add", id, text });
      continue;
    }
    const at = locate(snapshot, change.id);
    if (!at) {
      const gone = snapshot.removed.find((item) => item.id === change.id);
      problems.push(gone ? `${change.id}: 개정 ${gone.removedIn} 에서 이미 삭제한 항목입니다` : `${change.id}: 확정된 개정에 없는 항목입니다`);
      continue;
    }
    if (!once(change.id)) continue;
    const item = snapshot.items[at.section][at.index];
    if (change.op === "modify") {
      const text = change.text.trim();
      if (normalizeText(text) === normalizeText(item.text)) { problems.push(`${change.id}: 수정 전후가 같습니다 — 바뀐 것이 없으면 changes 에서 뺍니다`); continue; }
      changes.push({ op: "modify", id: item.id, before: item.text, text });
      snapshot.items[at.section][at.index] = { ...item, text, updated: revision };
    } else {
      changes.push({ op: "remove", id: item.id, before: item.text, reason: change.reason.trim() });
      snapshot.items[at.section].splice(at.index, 1);
      snapshot.removed.push({ id: item.id, text: item.text, removedIn: revision, reason: change.reason.trim() });
    }
  }
  if (snapshot.items.REQ.length === 0 && !problems.length) problems.push("요구 내용이 하나도 남지 않습니다 — 작업을 그만두려면 사람이 abort 합니다");
  if (problems.length) throw new Stop(`요구 변경안을 적용하지 않았습니다:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  return { snapshot, changes };
}

/**
 * 전체 교체 — 사람이 그 뜻으로 요청했을 때만(replaceQuote 가 원문에 있어야 한다). 글자가 같은 항목은 ID 를 그대로 두고,
 * 새 목록에 없는 항목은 교체 사유로 삭제 이력에 남긴다. 목록 순서는 새 목록을 따른다.
 */
export function replaceSnapshot(parent: Snapshot, lists: Record<Section, string[]>, revision: number, reason: string): { snapshot: Snapshot; changes: Change[]; positional: Record<string, string> } {
  const snapshot: Snapshot = { items: emptyItems(), removed: [...parent.removed], next: { ...parent.next } };
  const changes: Change[] = [], positional: Record<string, string> = {};
  for (const section of SECTIONS) {
    const pool = [...parent.items[section]];
    lists[section].forEach((raw, index) => {
      const text = raw.trim();
      const found = pool.findIndex((item) => normalizeText(item.text) === normalizeText(text));
      if (found >= 0) {
        const [kept] = pool.splice(found, 1);
        snapshot.items[section].push(kept);
        positional[`${section}-${index + 1}`] = kept.id;
        return;
      }
      const id = `${section}-${snapshot.next[section]++}`;
      snapshot.items[section].push({ id, text, since: revision });
      positional[`${section}-${index + 1}`] = id;
      changes.push({ op: "add", id, text });
    });
    for (const item of pool) {
      changes.push({ op: "remove", id: item.id, before: item.text, reason });
      snapshot.removed.push({ id: item.id, text: item.text, removedIn: revision, reason });
    }
  }
  return { snapshot, changes, positional };
}

/** 변경이 건드린 항목 ID — 오래된 부모에서 온 변경안의 충돌 검사에 쓴다 */
export function touchedIds(changes: Change[]): string[] {
  return changes.filter((change) => change.op !== "header").map((change) => (change as { id: string }).id);
}

/** 변경 한 줄 — 렌더·확정 화면·상태가 같은 말을 쓴다 */
export function changeLine(change: Change): string {
  const flat = (text: string) => text.replace(/\r?\n/g, " ");
  switch (change.op) {
    case "add": return `추가 [${change.id}] ${flat(change.text)}`;
    case "modify": return `수정 [${change.id}] ${flat(change.before)} → ${flat(change.text)}`;
    case "remove": return `삭제 [${change.id}] ${flat(change.before)} — 사유: ${change.reason}`;
    case "header": return `머리말 ${change.field}: ${change.before || "(없음)"} → ${change.after || "(없음)"}`;
  }
}
export function changeSummary(changes: Change[]): string {
  const count = (op: Change["op"]) => changes.filter((change) => change.op === op).length;
  const parts = ([["add", "추가"], ["modify", "수정"], ["remove", "삭제"], ["header", "머리말"]] as const)
    .filter(([op]) => count(op) > 0).map(([op, label]) => `${label} ${count(op)}`);
  return parts.length ? parts.join(" · ") : "변경 없음";
}

// ---- 이전 형식 이행 ----

const QUOTE_LINE = /^>(?: (.*))?$/;

/**
 * 이전 형식으로 렌더·확정된 지시서를 개정 기록으로 옮긴다 — 표시된 ID(`[REQ-n]`)를 그대로 쓰고, 범위 밖은 위치로 OUT-n 을 붙인다.
 * 원문·오류 로그·배경·접수 때 정한 것은 렌더 형식에서 그대로 읽는다. 읽지 못한 절은 비워 두고 지시서 그대로를 legacyText 로 남긴다.
 */
export function legacyDocument(text: string, revision: number): { snapshot: Snapshot; document: RevisionDocument } {
  const values = parseFrontMatter(text) ?? {};
  const list = (key: string): string[] => { const value = values[key]; return value === undefined ? [] : Array.isArray(value) ? value : [value]; };
  const one = (key: string): string => { const value = values[key]; return Array.isArray(value) ? value.join(", ") : value ?? ""; };
  const extra: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(values)) if (!["kind", "id", "title", "target", "scope", "preserve", "approver"].includes(key)) extra[key] = value;
  const body = text.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "");
  const sections = new Map<string, string[]>();
  for (const part of body.split(/^## /m).slice(1)) {
    const [heading, ...lines] = part.split("\n");
    sections.set(heading.trim(), lines);
  }
  const comment = (lines: string[]) => /^<!-- (.*) -->$/.exec(lines.find((line) => line.startsWith("<!--")) ?? "")?.[1] ?? "";
  const originalLines = sections.get("원문") ?? [];
  const quotedText = originalLines.filter((line) => QUOTE_LINE.test(line)).map((line) => QUOTE_LINE.exec(line)![1] ?? "").join("\n");
  const originals: OriginalText[] = quotedText ? [{ revision, text: quotedText, source: comment(originalLines) || "원문: 이전 형식 지시서", hash: textHash(quotedText) }] : [];
  const bullets = (heading: string) => (sections.get(heading) ?? []).filter((line) => /^- /.test(line)).map((line) => line.slice(2).trim())
    .filter((line) => line !== "없음" && !line.startsWith("원문에 없음"));
  const background = (sections.get("배경") ?? []).join("\n").trim();
  const logLines = sections.get("오류 로그");
  let errorLog: RevisionDocument["errorLog"];
  if (logLines) {
    const raw = logLines.join("\n"), fence = /^(`{3,})text\n([\s\S]*?)\n\1$/m.exec(raw);
    if (fence) errorLog = { text: fence[2], source: comment(logLines) || "오류 로그: 이전 형식 지시서" };
  }
  const noLog = sections.get("오류 로그 없음");
  const noErrorLog = noLog ? {
    reason: noLog.find((line) => line.startsWith("- 사유: "))?.slice(6).trim() ?? "",
    steps: noLog.filter((line) => /^ {2}\d+\. /.test(line)).map((line) => line.replace(/^ {2}\d+\. /, "")),
  } : undefined;
  const clarifications: RevisionDocument["clarifications"] = [];
  for (const line of sections.get("접수 때 정한 것") ?? []) {
    if (line.startsWith("- Q: ")) clarifications.push({ question: line.slice(5).trim(), answer: "" });
    else if (line.startsWith("  - A: ") && clarifications.length) clarifications[clarifications.length - 1].answer = line.slice(7).trim();
  }
  const items = emptyItems(), next = { REQ: 1, DONE: 1, CON: 1, OUT: 1 };
  for (const item of sourceItems(text)) {
    const match = ID_FORMAT.exec(item.id);
    if (!match) continue;
    const section = match[1] as Section;
    items[section].push({ id: item.id, text: item.text, since: revision });
    next[section] = Math.max(next[section], Number(match[2]) + 1);
  }
  bullets("범위 밖").forEach((line) => {
    const marked = /^\[(OUT-\d+)\]\s*(.*)$/.exec(line);
    const id = marked ? marked[1] : `OUT-${next.OUT}`;
    items.OUT.push({ id, text: marked ? marked[2] : line, since: revision });
    next.OUT = Math.max(next.OUT, Number(id.slice(4)) + 1);
  });
  return {
    snapshot: { items, removed: [], next },
    document: {
      kind: one("kind"), id: one("id"), title: one("title"), target: list("target"), scope: list("scope"), preserve: list("preserve"),
      ...(values.approver ? { approver: one("approver") } : {}), extra,
      background: background === "- 없음" ? "" : background, clarifications: clarifications.filter((entry) => entry.answer),
      ...(errorLog ? { errorLog } : {}), ...(noErrorLog && noErrorLog.reason ? { noErrorLog } : {}), originals,
    },
  };
}
