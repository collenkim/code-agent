import { execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, posix } from "path";

import type { Manifest } from "../core/manifest";
import { docPaths, normalizeHeading, sectionsOf } from "./docs";
import { codeRefs, documentEntries, entryFields, keyRefs, knowledgePath, missingRefs, pathList, RULE_LEVELS } from "./knowledge";
import { WORK_DOCS_DIR } from "./layout";
import { KNOWLEDGE_KINDS, POLICY_KINDS, SCHEMAS, WORK_SCHEMAS } from "./schemas";
import type { DocKind, KnowledgeKind } from "./schemas";

/**
 * 지식 인덱스 — 공통 KNOWLEDGE 항목과 POLICY 절을 **요청할 때 계산한다.** 파일로 커밋하지 않는다:
 * 커밋한 인덱스는 갱신을 보류하면 그대로 낡고, 병렬 작업 브랜치마다 같은 파일을 고쳐 부딪친다.
 *
 * 세 가지를 한 자리에서 한다.
 * - 항목 단위 읽기 — 키·제목·필드(코드·테스트·정책·흐름·별칭·범위·구분·상태)·줄 범위.
 * - 최신성 — 항목 줄을 마지막으로 바꾼 커밋(git blame)이 기준이다. 그 뒤에 근거 코드·테스트를 바꾼 커밋이 있으면 재검토 필요.
 *   파일이 있다는 것만으로 최신이라고 하지 않는다. 판정은 안내일 뿐 승인 해시·게이트에 넣지 않는다 — 관련 없는 변경이 남의 승인을 무효로 만들지 않게.
 * - 검색 — 키 언급 · 근거 경로 겹침 · 연결 · 별칭·제목·본문 낱말. `context.docs` 기본 구현과 `knowledge find` 가 같은 점수를 쓴다.
 */

export const KIND_LABEL: Record<DocKind, string> = {
  architecture: "개발 지침",
  conventions: "개발 지침",
  "test-strategy": "개발 지침",
  quality: "개발 지침",
  "data-dictionary": "데이터",
  "api-catalog": "API",
  "business-rules": "업무 정책",
  features: "기능",
  flows: "흐름",
};

/** 검색이 읽는 본문 길이 상한 — 항목·절 하나가 문서 전체만큼 길어도 점수 계산이 그만큼 커지지 않게 */
const BODY_CHARS = 4000;

export interface IndexEntry {
  kind: KnowledgeKind;
  /** 문서 경로, 저장소 기준 */
  path: string;
  key: string;
  /** 제목 줄에서 키를 뺀 이름 */
  title: string;
  heading: string;
  line: number;
  end: number;
  body: string;
  code: string[];
  tests: string[];
  /** 최신성의 근거 경로 — 코드·테스트 필드와 본문의 `path:line` (KNOWLEDGE 문서 자신은 뺀다) */
  refs: string[];
  /** 업무 정책의 적용 범위 경로. `전체`·`*` 면 global */
  scope: string[];
  global: boolean;
  aliases: string[];
  /** 이 항목이 가리키는 다른 키(BR·FEAT·FLOW·백틱 키) */
  links: string[];
  level?: string;
  state?: string;
}

export interface PolicySection {
  kind: DocKind;
  path: string;
  heading: string;
  line: number;
  end: number;
  body: string;
}

export interface KnowledgeIndex {
  entries: IndexEntry[];
  sections: PolicySection[];
  /** 종류별 문서 경로와 존재 여부 — 빈 문서·없는 문서를 화면에서 구분한다 */
  docs: { kind: KnowledgeKind; path: string; exists: boolean }[];
}

function readText(repoRoot: string, path: string): string | undefined {
  const full = join(repoRoot, path);
  try {
    return existsSync(full) ? readFileSync(full, "utf-8").replace(/\r\n/g, "\n") : undefined;
  } catch {
    return undefined;
  }
}

function markdownUnder(repoRoot: string, path: string): string[] {
  const full = join(repoRoot, path);
  try {
    if (!existsSync(full)) return [];
    const entries = readdirSync(full, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => posix.join(path, entry.name)).sort();
  } catch {
    return existsSync(full) ? [path] : [];
  }
}

/** 문서 하나의 항목 — `### \`KEY\`` 덩어리마다 필드를 읽는다 */
export function indexEntries(kind: KnowledgeKind, path: string, text: string, knowledgeDocs: string[]): IndexEntry[] {
  return documentEntries(text).map((entry) => {
    const fields = entryFields(entry.body);
    const code = pathList(fields.get("코드"));
    const tests = pathList(fields.get("테스트"));
    const scopeText = fields.get("범위") ?? "";
    const scope = pathList(scopeText);
    const refs = [...new Set([...code, ...tests, ...codeRefs(entry.body, knowledgeDocs).map((ref) => ref.replace(/:\d+$/, ""))])]
      .filter((ref) => !knowledgeDocs.includes(ref)).sort();
    const linkText = [fields.get("정책"), fields.get("흐름"), fields.get("기능"), fields.get("단계"), kind === "flows" ? entry.body : ""].filter(Boolean).join(" ");
    return {
      kind,
      path,
      key: entry.key,
      title: entry.heading.replace(/^###\s+`[^`]+`\s*/, "").trim(),
      heading: entry.heading,
      line: entry.line,
      end: entry.end,
      body: entry.body,
      code,
      tests,
      refs,
      scope,
      global: /(^|\s)(전체|\*)(\s|$)/.test(scopeText),
      aliases: (fields.get("별칭") ?? "").split(/[,·]/).map((alias) => alias.replace(/`/g, "").trim()).filter(Boolean),
      links: keyRefs(linkText).filter((key) => key !== entry.key),
      level: fields.get("구분")?.trim().split(/\s/)[0],
      state: fields.get("상태")?.trim().split(/\s/)[0],
    };
  });
}

/** 인덱스를 만든다 — 없는 문서는 빈 채로 둔다(KNOWLEDGE 는 막지 않는다) */
export function buildIndex(repoRoot: string, manifest: Manifest | undefined, policyKinds: readonly DocKind[] = POLICY_KINDS): KnowledgeIndex {
  const knowledgeDocs = KNOWLEDGE_KINDS.map((kind) => knowledgePath(manifest, kind));
  const docs = KNOWLEDGE_KINDS.map((kind, index) => ({ kind, path: knowledgeDocs[index], exists: existsSync(join(repoRoot, knowledgeDocs[index])) }));
  const entries: IndexEntry[] = [];
  const sections: PolicySection[] = [];
  for (const doc of docs) {
    const text = doc.exists ? readText(repoRoot, doc.path) : undefined;
    if (text === undefined) continue;
    entries.push(...indexEntries(doc.kind, doc.path, text, knowledgeDocs));
    // 키 항목이 아닌 절(손으로 쓴 `## 반환 규칙` 등)도 찾는다 — 본문은 첫 항목 앞까지만(항목은 위에서 따로 센다)
    sections.push(...sectionList(doc.kind, doc.path, text).filter((section) => !/^`[^`]+`/.test(section.heading))
      .map((section) => {
        const cut = section.body.split("\n").findIndex((line) => /^###\s+`/.test(line));
        if (cut < 0) return section;
        const body = section.body.split("\n").slice(0, cut).join("\n").replace(/\s+$/, "");
        return { ...section, body, end: section.line + (body === "" ? 0 : body.split("\n").length) };
      })
      .filter((section) => section.body.replace(/<!--[\s\S]*?-->/g, "").trim() !== ""));
  }
  for (const kind of policyKinds) {
    for (const path of docPaths(manifest, kind).flatMap((entry) => markdownUnder(repoRoot, entry))) {
      const text = readText(repoRoot, path);
      if (text !== undefined) sections.push(...sectionList(kind, path, text));
    }
  }
  return { entries, sections, docs };
}

/** 문서의 절(수준 2 이상) — 줄 범위를 함께. 문서 제목(수준 1)은 본문이 문서 전체라 절이 아니다 */
function sectionList(kind: DocKind, path: string, text: string): PolicySection[] {
  const lines = text.split("\n");
  return sectionsOf(text).filter((entry) => entry.level >= 2).map((section) => {
    let end = section.line + section.body.split("\n").length;
    while (end > section.line && (lines[end - 1] ?? "").trim() === "") end -= 1;
    return { kind, path, heading: section.heading, line: section.line, end, body: section.body };
  });
}

// ---- 경로 ----

function clean(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** 근거 경로와 파일이 겹치는가 — 경로가 폴더면 그 아래 전부 */
export function pathTouches(ref: string, file: string): boolean {
  const a = clean(ref), b = clean(file);
  return a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}

/** 파일들을 근거로 든 항목 — 코드·테스트·본문 경로·업무 정책 범위 중 하나라도 겹치면 */
export function relatedEntries(index: KnowledgeIndex, files: string[]): IndexEntry[] {
  if (files.length === 0) return [];
  return index.entries.filter((entry) => [...entry.refs, ...entry.scope].some((ref) => files.some((file) => pathTouches(ref, file))));
}

// ---- 최신성 ----

export type FreshState = "최신" | "재검토 필요" | "참조 없음" | "미커밋" | "근거 경로 없음" | "보류";

export interface Freshness {
  state: FreshState;
  /** 항목을 마지막으로 바꾼 커밋과 그 작업 ID(커밋 제목 `[<ID>]`) */
  base?: { commit: string; id?: string };
  /** 기준 뒤에 근거 경로를 바꾼 커밋 */
  changed: { path: string; commit: string; id?: string }[];
  missing: string[];
  /** 갱신을 선언하고 반영하지 않은 작업 */
  pending: string[];
}

function gitOut(repoRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

const ZERO = /^0{40}$/;

interface BlameLine { commit: string; time: number }

/** 문서 하나의 줄별 마지막 커밋 — `--porcelain` 은 커밋마다 시각을 한 번 싣는다 */
function blameLines(repoRoot: string, path: string): Map<number, BlameLine> | undefined {
  const out = gitOut(repoRoot, ["blame", "--porcelain", "--", path]);
  if (out === undefined) return undefined;
  const times = new Map<string, number>();
  const lines = new Map<number, BlameLine>();
  let commit = "";
  for (const line of out.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (header) {
      commit = header[1];
      lines.set(Number(header[2]), { commit, time: times.get(commit) ?? 0 });
      continue;
    }
    const time = /^committer-time (\d+)/.exec(line);
    if (time) times.set(commit, Number(time[1]));
  }
  for (const [number, entry] of lines) lines.set(number, { commit: entry.commit, time: times.get(entry.commit) ?? entry.time });
  return lines;
}

/** 커밋 제목의 작업 ID — 반영 커밋은 `[<ID>] <제목>` 이다 */
function workIdOf(subject: string): string | undefined {
  return /^\[([^\]]+)\]/.exec(subject)?.[1];
}

interface LogCommit { commit: string; id?: string; files: string[] }

function commitsSince(repoRoot: string, base: string): LogCommit[] {
  const out = gitOut(repoRoot, ["log", "--no-renames", "--name-only", "--format=%x01%H%x09%s", `${base}..HEAD`]);
  if (out === undefined) return [];
  return out.split("\x01").filter((chunk) => chunk.trim() !== "").map((chunk) => {
    const [head, ...files] = chunk.split("\n");
    const [commit, subject = ""] = head.split("\t");
    return { commit, id: workIdOf(subject), files: files.map((file) => file.trim()).filter(Boolean) };
  });
}

/** 02 의 `문서 영향` 표 한 줄 */
export interface DocImpactRow {
  doc: string;
  keys: string[];
  decision?: DocDecision;
  /** 표에 적힌 판단 글자 그대로 */
  raw: string;
  reason: string;
}

export const DOC_DECISIONS = ["갱신", "신규", "삭제", "이름 변경", "영향 없음", "충돌"] as const;
export type DocDecision = (typeof DOC_DECISIONS)[number];
/** 반영에서 문서를 바꾸겠다는 판단 */
export const CHANGING_DECISIONS: readonly DocDecision[] = ["갱신", "신규", "삭제", "이름 변경"];

/** 판단 칸 — `갱신 필요` 처럼 뒤에 말을 붙여도 앞 낱말로 읽는다 */
export function docDecision(raw: string): DocDecision | undefined {
  const text = raw.replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
  return DOC_DECISIONS.find((decision) => text.startsWith(decision));
}

/** `## 문서 영향` 표를 줄로 읽는다 — 머리글·구분 줄은 뺀다 */
export function docImpactRows(body: string): DocImpactRow[] {
  return body.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("|") && !/^\|[\s|:-]+\|?$/.test(line))
    .map((line) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 3 && cells[2] !== "판단")
    .map((cells) => ({
      doc: cells[0],
      keys: cells[1] === "-" || cells[1] === "—" || cells[1] === "" ? [] : keyRefs(cells[1]).length ? keyRefs(cells[1]) : cells[1].split(/[,\s→]+/).filter(Boolean),
      decision: docDecision(cells[2]),
      raw: cells[2],
      reason: (cells[3] ?? "").trim(),
    }));
}

/** 02 의 `문서 영향` 절 본문 — 별칭 제목도 같은 절이다 */
export function docImpactBody(text: string): string | undefined {
  const section = WORK_SCHEMAS["02-analysis"].sections.find((entry) => entry.id === "docImpact")!;
  const names = [section.heading, ...section.aliases].map(normalizeHeading);
  const bodies = sectionsOf(text).filter((entry) => names.includes(normalizeHeading(entry.heading))).map((entry) => entry.body);
  return bodies.length > 0 ? bodies.join("\n") : undefined;
}

/** 작업들이 02 에 남긴 문서 영향 판단 — 작업 폴더의 02 를 읽는다. 작업 ID 와 줄 */
function declaredRows(repoRoot: string): { id: string; row: DocImpactRow }[] {
  const root = join(repoRoot, WORK_DOCS_DIR);
  let ids: string[];
  try { ids = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return []; }
  const found: { id: string; row: DocImpactRow }[] = [];
  for (const id of ids.sort()) {
    const text = readText(repoRoot, posix.join(WORK_DOCS_DIR, id, WORK_SCHEMAS["02-analysis"].defaultPath));
    const body = text === undefined ? undefined : docImpactBody(text);
    if (!body) continue;
    for (const row of docImpactRows(body)) if (row.decision) found.push({ id, row });
  }
  return found;
}

/** 갱신을 선언한 줄 */
function declaredUpdates(repoRoot: string, rows = declaredRows(repoRoot)): { id: string; row: DocImpactRow }[] {
  return rows.filter(({ row }) => row.decision && CHANGING_DECISIONS.includes(row.decision));
}

/**
 * 항목들의 최신성 — 보여 줄 항목에만 계산한다(기준 커밋마다 git 을 한 번 부른다).
 * git 저장소가 아니거나 HEAD 가 없으면 전부 미커밋이다.
 */
export function freshness(repoRoot: string, entries: IndexEntry[]): Map<IndexEntry, Freshness> {
  const result = new Map<IndexEntry, Freshness>();
  if (entries.length === 0) return result;
  const blames = new Map<string, Map<number, BlameLine> | undefined>();
  const since = new Map<string, LogCommit[]>();
  const subjects = new Map<string, string | undefined>();
  const rows = declaredRows(repoRoot);
  const declared = declaredUpdates(repoRoot, rows);
  // 근거 코드를 바꾼 작업이 그 항목을 `영향 없음` 으로 판단했으면 그 커밋은 검토를 거쳤다 — 재검토로 세지 않는다
  const reviewed = new Set(rows.filter(({ row }) => row.decision === "영향 없음").flatMap(({ id, row }) => row.keys.map((key) => `${id} ${key}`)));
  const deliveredAt = new Map<string, string | undefined>();
  const deliverCommit = (id: string): string | undefined => {
    if (!deliveredAt.has(id)) {
      const out = gitOut(repoRoot, ["log", "-1", "--format=%H", "--fixed-strings", `--grep=[${id}] `, "HEAD"]);
      deliveredAt.set(id, out?.trim() || undefined);
    }
    return deliveredAt.get(id);
  };
  const isAncestor = (a: string, b: string): boolean => {
    try { execFileSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: repoRoot, stdio: "ignore" }); return true; } catch { return false; }
  };
  for (const entry of entries) {
    if (!blames.has(entry.path)) blames.set(entry.path, blameLines(repoRoot, entry.path));
    const blame = blames.get(entry.path);
    const missing = entry.refs.length ? missingRefs(repoRoot, entry.refs) : [];
    const lines = blame ? [...Array(entry.end - entry.line + 1).keys()].map((offset) => blame.get(entry.line + offset)).filter((line): line is BlameLine => line !== undefined) : [];
    if (!blame || lines.length === 0 || lines.some((line) => ZERO.test(line.commit))) {
      result.set(entry, { state: "미커밋", changed: [], missing, pending: [] });
      continue;
    }
    const base = lines.reduce((latest, line) => (line.time > latest.time ? line : latest));
    if (!subjects.has(base.commit)) subjects.set(base.commit, gitOut(repoRoot, ["log", "-1", "--format=%s", base.commit])?.trim());
    const baseInfo = { commit: base.commit, id: workIdOf(subjects.get(base.commit) ?? "") };
    if (!since.has(base.commit)) since.set(base.commit, commitsSince(repoRoot, base.commit));
    const changed = since.get(base.commit)!.flatMap((commit) => commit.files
      .filter((file) => entry.refs.some((ref) => pathTouches(ref, file)))
      .map((path) => ({ path, commit: commit.commit, id: commit.id })))
      .filter((change) => !(change.id && reviewed.has(`${change.id} ${entry.key}`)));
    const pending = declared.filter(({ id, row }) => row.keys.includes(entry.key) && row.decision !== "삭제")
      .filter(({ id }) => { const at = deliverCommit(id); return at !== undefined && at !== base.commit && !isAncestor(at, base.commit); })
      .map(({ id }) => id);
    const state: FreshState = missing.length > 0 ? "참조 없음" : changed.length > 0 ? "재검토 필요" : pending.length > 0 ? "보류" : entry.refs.length === 0 ? "근거 경로 없음" : "최신";
    result.set(entry, { state, base: baseInfo, changed, missing, pending: [...new Set(pending)] });
  }
  return result;
}

/** 갱신을 선언한 작업이 반영됐는데 문서에 없는 키(신규·갱신을 거부·보류한 것) — `knowledge` 목록이 따로 보여 준다 */
export function pendingWithoutEntry(repoRoot: string, index: KnowledgeIndex): { id: string; key: string; decision: string }[] {
  const keys = new Set(index.entries.map((entry) => entry.key));
  return declaredUpdates(repoRoot)
    .filter(({ row }) => row.decision !== "삭제")
    .flatMap(({ id, row }) => row.keys.filter((key) => !keys.has(key) && /^(?:BR|FEAT|FLOW)-|^[A-Z_]+$|:\//.test(key)).map((key) => ({ id, key, decision: row.raw })))
    .filter(({ id }) => gitOut(repoRoot, ["log", "-1", "--format=%H", "--fixed-strings", `--grep=[${id}] `, "HEAD"])?.trim());
}

/** 최신성 한 줄 — 최신이면 비운다(화면을 아낀다) */
export function freshnessText(fresh: Freshness | undefined): string {
  if (!fresh || fresh.state === "최신") return "";
  const who = (id?: string, commit?: string) => id ?? commit?.slice(0, 7) ?? "";
  switch (fresh.state) {
    case "재검토 필요": {
      const first = fresh.changed[0];
      const more = fresh.changed.length > 1 ? ` 외 ${fresh.changed.length - 1}건` : "";
      return `재검토 필요: ${who(first.id, first.commit)} 가 ${first.path} 를 바꿈${more}`;
    }
    case "참조 없음":
      return `참조 없음: ${fresh.missing.slice(0, 3).join(", ")}${fresh.missing.length > 3 ? ` 외 ${fresh.missing.length - 3}개` : ""}`;
    case "보류":
      return `보류: ${fresh.pending.join(", ")} 가 갱신을 선언하고 반영하지 않음`;
    case "미커밋":
      return "미커밋";
    default:
      return "근거 경로 없음";
  }
}

// ---- 검색 ----

export interface SearchQuery {
  keywords: string[];
  /** 질의·요구에 나온 키 */
  keys: string[];
  /** 이 작업이 닿는 파일(후보·계획 파일) — 근거 경로가 겹치면 점수가 높다 */
  files: string[];
}

export interface Hit {
  entry?: IndexEntry;
  section?: PolicySection;
  score: number;
  why: string[];
}

function sortHits(a: Hit, b: Hit): number {
  const pathA = a.entry?.path ?? a.section!.path, pathB = b.entry?.path ?? b.section!.path;
  const lineA = a.entry?.line ?? a.section!.line, lineB = b.entry?.line ?? b.section!.line;
  return b.score - a.score || (pathA < pathB ? -1 : pathA > pathB ? 1 : 0) || lineA - lineB;
}

/**
 * 점수 — 키 언급 10 · 근거 경로 겹침 6 · 언급된 키와 연결 4 · 낱말이 키·제목·별칭에 3 · 본문에 1.
 * 같은 저장소·같은 질의면 언제나 같은 순서다(동점은 경로·줄 순서).
 */
export function search(index: KnowledgeIndex, query: SearchQuery): Hit[] {
  const hits: Hit[] = [];
  const keySet = new Set(query.keys);
  for (const entry of index.entries) {
    let score = 0;
    const why: string[] = [];
    if (keySet.has(entry.key)) { score += 10; why.push("키"); }
    const touched = query.files.find((file) => [...entry.refs, ...entry.scope].some((ref) => pathTouches(ref, file)));
    if (touched) { score += 6; why.push(`경로 ${touched}`); }
    const linked = entry.links.find((key) => keySet.has(key));
    if (linked) { score += 4; why.push(`연결 ${linked}`); }
    const name = [entry.key, entry.title, ...entry.aliases].join(" ").toLowerCase();
    const body = entry.body.slice(0, BODY_CHARS).toLowerCase();
    const words: string[] = [];
    for (const keyword of query.keywords) {
      if (name.includes(keyword)) { score += 3; words.push(keyword); } else if (body.includes(keyword)) { score += 1; words.push(keyword); }
    }
    if (words.length) why.push(`낱말 ${words.slice(0, 4).join(" · ")}`);
    if (score > 0) hits.push({ entry, score, why });
  }
  for (const section of index.sections) {
    const heading = section.heading.toLowerCase();
    const body = section.body.slice(0, BODY_CHARS).toLowerCase();
    let score = 0;
    const words: string[] = [];
    for (const keyword of query.keywords) {
      if (heading.includes(keyword)) { score += 3; words.push(keyword); } else if (body.includes(keyword)) { score += 1; words.push(keyword); }
    }
    if (score > 0) hits.push({ section, score, why: [`낱말 ${words.slice(0, 4).join(" · ")}`] });
  }
  return hits.sort(sortHits);
}

/**
 * 반드시 적용하는 업무 정책 — 순위와 관계없이 넣는다. `구분: 필수` 이고 관찰이 아닌 업무 정책 중
 * 질의가 키를 들었거나, 함께 나온 항목·관련 항목이 가리키거나, 범위가 이 작업의 파일과 겹치거나 `전체` 인 것.
 */
export function mandatoryPolicies(index: KnowledgeIndex, query: SearchQuery, shown: IndexEntry[]): { entry: IndexEntry; why: string }[] {
  const linkedBy = new Map<string, string>();
  for (const entry of [...shown, ...relatedEntries(index, query.files)]) for (const key of entry.links) if (!linkedBy.has(key)) linkedBy.set(key, entry.key);
  return index.entries
    .filter((entry) => entry.kind === "business-rules" && entry.level === RULE_LEVELS[0] && entry.state !== "관찰")
    .flatMap((entry) => {
      const why = query.keys.includes(entry.key) ? "요구가 언급"
        : linkedBy.has(entry.key) ? `${linkedBy.get(entry.key)} 가 가리킴`
          : entry.global ? "범위 전체"
            : query.files.some((file) => entry.scope.some((ref) => pathTouches(ref, file))) ? "범위가 이 작업의 파일과 겹침" : undefined;
      return why ? [{ entry, why }] : [];
    });
}

/** 컨벤션의 `[필수]` 줄 — 참조 코드보다 앞선다. 줄 번호와 함께 */
export function requiredConventionLines(repoRoot: string, manifest: Manifest | undefined): { path: string; line: number; text: string }[] {
  const found: { path: string; line: number; text: string }[] = [];
  for (const path of docPaths(manifest, "conventions").flatMap((entry) => markdownUnder(repoRoot, entry))) {
    const text = readText(repoRoot, path);
    if (text === undefined) continue;
    text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " ")).split("\n").forEach((line, index) => {
      if (/\[필수\]/.test(line)) found.push({ path, line: index + 1, text: line.replace(/^\s*[-*]\s*/, "").trim() });
    });
  }
  return found;
}

/** 질의 문장에서 키·경로·낱말을 가른다 — `knowledge find` 의 인자 */
export function parseQuery(text: string, index: KnowledgeIndex, keywordsOf: (text: string) => string[]): SearchQuery {
  const tokens = text.split(/\s+/).map((token) => token.replace(/^`|`$/g, "")).filter(Boolean);
  const known = new Set(index.entries.map((entry) => entry.key));
  const keys = [...new Set([...tokens.filter((token) => known.has(token)), ...keyRefs(text).filter((key) => known.has(key) || /^(?:BR|FEAT|FLOW)-/.test(key))])];
  const files = tokens.filter((token) => !known.has(token) && (token.includes("/") || /\.[A-Za-z]\w*$/.test(token))).map(clean);
  return { keys, files, keywords: keywordsOf(tokens.filter((token) => !keys.includes(token) && !files.includes(clean(token))).join(" ")) };
}

/** 검색 결과 한 줄 — `경로 L시작-L끝 · 키 제목 [종류 · 상태] (이유)` */
export function hitLine(hit: Hit, fresh?: Freshness): string {
  if (hit.entry) {
    // 업무 정책은 사람의 결정에서 오므로 근거 경로가 없는 것이 정상이다 — 그 상태는 줄에 싣지 않는다
    const rule = hit.entry.kind === "business-rules";
    const state = rule && fresh?.state === "근거 경로 없음" ? "" : freshnessText(fresh);
    const status = [KIND_LABEL[hit.entry.kind], rule ? [hit.entry.level, hit.entry.state].filter(Boolean).join(" ") : "", state].filter(Boolean).join(" · ");
    return `- ${hit.entry.path} L${hit.entry.line}-L${hit.entry.end} · \`${hit.entry.key}\` ${hit.entry.title} [${status}]${hit.why.length ? ` (${hit.why.join(" · ")})` : ""}`;
  }
  const section = hit.section!;
  return `- ${section.path} L${section.line}-L${section.end} · ## ${section.heading} [${KIND_LABEL[section.kind]} · ${SCHEMAS[section.kind].label}]${hit.why.length ? ` (${hit.why.join(" · ")})` : ""}`;
}

/** 항목의 연결 한 줄 — 코드·테스트·정책·흐름·기능. 비면 undefined */
export function linkLine(entry: IndexEntry): string | undefined {
  const fields = entryFields(entry.body);
  const parts = [
    entry.code.length ? `코드 ${entry.code.join(", ")}` : "",
    entry.tests.length ? `테스트 ${entry.tests.join(", ")}` : "",
    fields.get("정책") ? `정책 ${keyRefs(fields.get("정책")!).join(", ") || fields.get("정책")}` : "",
    fields.get("흐름") ? `흐름 ${keyRefs(fields.get("흐름")!).join(", ") || fields.get("흐름")}` : "",
    entry.kind === "flows" ? `기능 ${entry.links.filter((key) => key.startsWith("FEAT-")).join(", ")}` : "",
    fields.get("상세") ? `상세 ${pathList(fields.get("상세")).join(", ")}` : "",
  ].filter((part) => part !== "" && !/ $/.test(part));
  return parts.length ? `  ${parts.join(" · ")}` : undefined;
}
