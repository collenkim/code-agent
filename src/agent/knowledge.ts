import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, posix } from "path";

import type { Manifest } from "../core/manifest";
import { docPaths } from "./docs";
import { workDocsDir } from "./layout";
import { KNOWLEDGE_KINDS, SCHEMAS, skeleton } from "./schemas";
import type { KnowledgeKind } from "./schemas";

/**
 * 공통 KNOWLEDGE 를 **반영 때 한 번만** 키로 자라게 한다.
 *
 * 모델은 이 문서를 직접 쓰지 않는다 — 작업 중에는 hook 이 작업 폴더 밖 쓰기를 막으므로 제안을
 * `doc/work/<ID>/knowledge.proposal.md` 에 쓰고, `code-agent deliver` 가 TTY 에서 사람에게 하나씩
 * 보여 준 뒤 **코드가** 키로 upsert 한다.
 *
 * 규칙 셋이 전부다. **삭제하지 않는다**(자동 삭제는 되돌릴 근거가 없다), 같은 키에 다른 내용이
 * 오면 조용히 덮지 않고 양쪽을 보여 준다, 적용마다 **그 작업의 R 번호 1개 이상**을 요구한다 —
 * 마지막 것이 "한 작업의 범위만 자란다"를 코드로 강제하는 자리다.
 */
export const PROPOSAL_FILE = "knowledge.proposal.md";

export function proposalFile(id: string): string {
  return posix.join(workDocsDir(id), PROPOSAL_FILE);
}

/**
 * 제안 항목이 하는 일. 본문의 필드로 정한다 — `- 삭제: <이유>` 면 그 키를 지우고, `- 대체: \`옛 키\`` 면 옛 항목 자리에
 * 이 항목을 넣는다(이름 변경·이동). 둘 다 없으면 지금처럼 같은 키를 갈아 끼우거나 끝에 붙인다.
 */
export type EntryOp = "upsert" | "remove" | "replace";

export interface KnowledgeEntry {
  kind: KnowledgeKind;
  /** ``### `ORDER_ITEM` 주문 항목`` 의 백틱 안 — upsert 의 단위다 */
  key: string;
  /** 제목 줄 전체 */
  heading: string;
  /** 제목 줄을 포함한 항목 한 덩어리 */
  text: string;
  /** 이 항목이 근거로 든 이번 작업의 요구 항목 */
  requirements: string[];
  op: EntryOp;
  /** `replace` 가 지우는 옛 키 */
  replaces?: string;
}

/**
 * 항목 본문의 `- 이름: 값` 한 줄. 이름은 공백을 뺀 글자로 비교하고(`입력 · 출력` 과 `입력·출력` 은 같다)
 * 앞의 `관련` 은 뗀다(`관련 정책` 은 `정책` 이다) — 사람이 손으로 쓴 항목도 같은 연결로 읽는다
 */
const FIELD_LINE = /^\s*[-*]\s+([^:：`|\n]{1,16}?)\s*[:：]\s*(.*)$/;

/**
 * 항목 본문의 필드 — 인덱스·검색·최신성·반영 검사가 이 이름으로 읽는다(`코드`·`테스트`·`정책`·`흐름`·`별칭`·`구분`·`상태`·`출처`·`범위` 등).
 * 같은 이름이 여러 줄이면 이어 붙인다. 필드가 없는 옛 항목은 빈 맵이다 — 본문 전체가 검색 대상으로 남는다.
 */
export function entryFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of body.split("\n")) {
    const match = FIELD_LINE.exec(line.replace(/\r$/, ""));
    if (!match) continue;
    const name = match[1].replace(/\s+/g, "").replace(/^관련(?=.)/, "");
    fields.set(name, [fields.get(name), match[2].trim()].filter(Boolean).join(" "));
  }
  return fields;
}

/** 필드 값의 경로 — 백틱·쉼표·가운뎃점으로 나눈 낱말 중 경로 구분자나 확장자가 있는 것. `:줄` 은 뗀다(최신성은 파일 단위다) */
export function pathList(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.replace(/`/g, " ").split(/[\s,·]+/)
    .map((token) => token.replace(/[.;)]+$/, "").replace(/^\(/, "").replace(/^\.\//, "").replace(/:\d+(?:-\d+)?$/, ""))
    .filter((token) => token !== "" && !/^https?:/.test(token) && (token.includes("/") || /\.[A-Za-z]\w*$/.test(token))))];
}

/** 다른 항목을 가리키는 키 — 백틱 안의 키와 `BR-`·`FEAT-`·`FLOW-` 낱말 */
export function keyRefs(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/`([^`\r\n]+)`/g)) if (match[1].trim()) found.add(match[1]);
  for (const match of text.matchAll(/\b(?:BR|FEAT|FLOW)-[A-Za-z0-9_-]*[A-Za-z0-9]/g)) found.add(match[0]);
  return [...found];
}

function entryOp(body: string): { op: EntryOp; replaces?: string } {
  const fields = entryFields(body);
  if (fields.has("삭제")) return { op: "remove" };
  const replaced = fields.get("대체");
  if (replaced !== undefined) return { op: "replace", replaces: keyRefs(replaced)[0] ?? (replaced.trim() || undefined) };
  return { op: "upsert" };
}

const ENTRY_KEY = /^###\s+`([^`]+)`/;

/**
 * 항목이 끝나는 자리 — `#`·`##` 제목과 백틱 키가 있는 `###` 제목이다.
 *
 * `####` 이상은 **항목 안의 소제목**이라 경계가 아니다. `##+` 로 보면 두 군데가 같이 깨진다:
 * `documentEntries` 가 본문을 소제목에서 잘라 그 아래의 살아 있는 근거 경로를 보지 못하고
 * (`prune` 이 멀쩡한 항목을 지우자고 묻는다), `removeEntry`·`applyEntry` 는 소제목 덩어리를
 * 문서에 고아로 남긴다.
 */
const ENTRY_END = /^(?:#{1,2}\s|###\s+`[^`]+`)/;

/**
 * 제안 파일을 항목으로 가른다. `## <종류>` 아래의 `### \`키\` 이름` 이 항목 하나다.
 * R 번호가 없거나 이번 작업의 것이 아닌 항목은 담지 않고 왜 걸렀는지 돌려준다.
 */
export function parseProposal(text: string, keys: string[]): { entries: KnowledgeEntry[]; skipped: string[] } {
  const entries: KnowledgeEntry[] = [];
  const skipped: string[] = [];
  let kind: KnowledgeKind | undefined;
  let current: { heading: string; lines: string[] } | undefined;

  const flush = (): void => {
    if (!current || !kind) {
      current = undefined;
      return;
    }
    const block = current;
    const key = ENTRY_KEY.exec(block.heading)![1];
    const body = block.lines.join("\n");
    const requirements = [...new Set([...body.matchAll(/\bR\d+\b/g)].map((match) => match[0]))].filter((key) =>
      keys.includes(key),
    );
    if (requirements.length === 0) {
      skipped.push(`${key} — 이번 작업의 요구 항목(${keys.join(", ")})을 근거로 들지 않았습니다`);
    } else {
      entries.push({ kind, key, heading: block.heading, text: [block.heading, ...block.lines].join("\n").trimEnd(), requirements, ...entryOp(body) });
    }
    current = undefined;
  };

  for (const line of text.split("\n").map((line) => line.replace(/\r$/, ""))) {
    // `###` 은 `##` 뒤에 공백이 오지 않아 여기 걸리지 않는다 — 종류 제목과 항목 제목이 갈리는 자리다
    const section = /^##\s+(\S+)/.exec(line);
    if (section) {
      flush();
      const named = KNOWLEDGE_KINDS.find((candidate) => candidate === section[1]);
      if (!named) {
        skipped.push(`${section[1]} — 공통 KNOWLEDGE 종류가 아닙니다 (${KNOWLEDGE_KINDS.join(" · ")})`);
      }
      kind = named;
      continue;
    }
    if (ENTRY_KEY.test(line)) {
      flush();
      current = { heading: line, lines: [] };
      continue;
    }
    current?.lines.push(line);
  }
  flush();
  return { entries, skipped };
}

function entryRange(text: string, key: string): { from: number; to: number } | undefined {
  const lines = text.split("\n");
  const from = lines.findIndex((line) => ENTRY_KEY.exec(line)?.[1] === key);
  if (from < 0) {
    return undefined;
  }
  const after = lines.findIndex((line, index) => index > from && ENTRY_END.test(line));
  return { from, to: after < 0 ? lines.length : after };
}

/** 이미 있는 같은 키의 항목 — 사람에게 양쪽을 보여 주기 위해 읽는다 */
export function existingEntry(text: string, key: string): string | undefined {
  const range = entryRange(text, key);
  return range ? text.split("\n").slice(range.from, range.to).join("\n").trimEnd() : undefined;
}

/** 같은 키는 그 자리에서 갈아 끼우고 새 키는 해당 종류 절의 끝에 넣는다. */
export function applyEntry(text: string, entry: KnowledgeEntry): string {
  const range = entryRange(text, entry.key);
  const lines = text.split("\n");
  if (range) {
    return [...lines.slice(0, range.from), ...entry.text.split("\n"), "", ...lines.slice(range.to)].join("\n").replace(/\n{3,}/g, "\n\n");
  }
  const section = lines.findIndex(line => /^##\s+(\S+)/.exec(line)?.[1] === entry.kind);
  const next = lines.findIndex((line, index) => index > section && /^#{1,2}\s/.test(line));
  const at = section >= 0 ? (next < 0 ? lines.length : next) : lines.findIndex(line => /^##\s+변경 이력/.test(line));
  const index = at < 0 ? lines.length : at;
  const insert = `${section < 0 ? `## ${entry.kind}\n\n` : ""}${entry.text}`;
  return [...lines.slice(0, index), "", insert, "", ...lines.slice(index)].join("\n").replace(/\n{3,}/g, "\n\n");
}

/** 반영이 지운 적은 없지만 **사람은 지운다** — `knowledge prune` 이 고른 항목 하나를 잘라 낸다 */
export function removeEntry(text: string, key: string): string {
  const range = entryRange(text, key);
  if (!range) {
    return text;
  }
  const lines = text.split("\n");
  return [...lines.slice(0, range.from), ...lines.slice(range.to)].join("\n").replace(/\n{3,}/g, "\n\n");
}

/** 본문에서 한 필드 줄을 뺀다 — `대체:` 는 반영의 지시라 문서(현재 상태)에 남기지 않는다. 경위는 작업 문서와 커밋에 있다 */
function withoutField(text: string, name: string): string {
  return text.split("\n").filter((line) => FIELD_LINE.exec(line)?.[1].replace(/\s+/g, "") !== name).join("\n");
}

/** 제안 하나를 문서에 적용한다 — 삭제는 지우고, 대체는 옛 항목 자리에 새 항목을 넣고, 나머지는 `applyEntry` 다 */
export function applyProposal(text: string, entry: KnowledgeEntry): string {
  if (entry.op === "remove") return removeEntry(text, entry.key);
  if (entry.op !== "replace" || !entry.replaces) return applyEntry(text, entry);
  const next = { ...entry, text: withoutField(entry.text, "대체").trimEnd() };
  const range = entryRange(text, entry.replaces);
  if (!range || entryRange(text, entry.key)) return applyEntry(removeEntry(text, entry.replaces), next);
  const lines = text.split("\n");
  return [...lines.slice(0, range.from), ...next.text.split("\n"), "", ...lines.slice(range.to)].join("\n").replace(/\n{3,}/g, "\n\n");
}

/** `path/to/File.java:31` · `src/x/y.ts` — 확장자가 있고 경로 구분자가 있는 것만 참조로 본다 */
const REF = /[\w./-]+\.[A-Za-z]\w*(?::\d+)?/g;

/**
 * 항목 본문이 닻으로 든 저장소 경로.
 *
 * 세 가지를 뺀다. **URL** 은 저장소 경로가 아니고(`example.com/a.md` 가 그대로 걸린다),
 * 경로 구분자 없는 **홑이름**(`Order.java`)은 어디를 가리키는지 모르며,
 * **KNOWLEDGE 문서 자신**을 가리키는 줄은 늘 존재해 판정을 무의미하게 만든다.
 */
export function codeRefs(body: string, knowledgeDocs: string[]): string[] {
  const withoutUrls = body.replace(/https?:\/\/\S+/g, " ");
  const refs = new Set<string>();
  for (const match of withoutUrls.matchAll(REF)) {
    const ref = match[0];
    const path = ref.replace(/:\d+$/, "");
    if (!path.includes("/") || knowledgeDocs.includes(path)) continue;
    refs.add(ref);
  }
  return [...refs].sort();
}

/** 트리에 없는 참조. `existsSync` 가 아니라고 하면 git 에게 한 번 더 묻는다 (경로 형식·대소문자 차이) */
export function missingRefs(repoRoot: string, refs: string[]): string[] {
  return refs.filter((ref) => {
    const path = ref.replace(/:\d+$/, "");
    if (existsSync(join(repoRoot, path))) return false;
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", "--", path], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      return false;
    } catch {
      return true;
    }
  });
}

/** 업무 정책의 값 — 구분은 필수·권장, 상태는 확정(요구·사용자 결정)·관찰(코드에서 본 현재 동작) */
export const RULE_LEVELS = ["필수", "권장"] as const;
export const RULE_STATES = ["확정", "관찰"] as const;

/** 출처가 확정 근거인가 — 이번 작업의 R 번호나 사용자 결정(답변된 질문 Q 번호 포함)을 든다 */
function confirmedSource(source: string, keys: string[]): boolean {
  return keys.some((key) => new RegExp(`\\b${key}\\b`).test(source)) || /사용자\s*결정|\bQ\d+\b/.test(source);
}

export interface ProposalCheck {
  /** 있으면 적용 후보에서 뺀다 — 이유 한 줄 */
  skip?: string;
  /** 사람이 고를 때 볼 확인 사항 — 막지 않는다 */
  notes: string[];
}

/**
 * 반영 전에 제안 하나를 본다. 막는 것은 둘이다 — 계획만 있고 구현되지 않은 것을 사실로 적는 길(기능·흐름이 든 코드·테스트 경로가
 * 지금 트리에 없다)과 코드 관찰을 확정 정책으로 올리는 길(업무 정책 `상태: 확정` 의 출처가 경로뿐이다).
 * `strict` 는 문서 영향 판단이 켜진 작업(`knowledgeVersion`) — 업무 정책에 구분·상태·출처를 요구한다. knowledgeVersion이 없는 작업은 이 추가 필드를 요구하지 않는다.
 */
export function proposalCheck(
  repoRoot: string,
  entry: KnowledgeEntry,
  current: string,
  options: { keys: string[]; strict: boolean; known: (key: string) => boolean },
): ProposalCheck {
  const notes: string[] = [];
  if (entry.op === "remove") {
    return existingEntry(current, entry.key) ? { notes } : { skip: `${entry.key} — 지울 항목이 문서에 없습니다`, notes };
  }
  if (entry.op === "replace") {
    if (!entry.replaces || entry.replaces === entry.key) return { skip: `${entry.key} — \`- 대체:\` 에 옛 키를 백틱으로 적으세요`, notes };
    if (!existingEntry(current, entry.replaces)) return { skip: `${entry.key} — 대체할 항목 \`${entry.replaces}\` 이 문서에 없습니다`, notes };
  }
  const fields = entryFields(entry.text.split("\n").slice(1).join("\n"));
  if (entry.kind === "features" || entry.kind === "flows") {
    const code = pathList(fields.get("코드"));
    if (entry.kind === "features" && code.length === 0) {
      return { skip: `${entry.key} — 기능 항목은 \`- 코드:\` 에 구현 경로가 있어야 합니다(지금 상태의 근거)`, notes };
    }
    const missing = missingRefs(repoRoot, [...code, ...pathList(fields.get("테스트"))]);
    if (missing.length > 0) {
      return { skip: `${entry.key} — 지금 트리에 없는 경로: ${missing.join(", ")} (구현되지 않은 동작은 기록하지 않습니다)`, notes };
    }
  }
  if (entry.kind === "business-rules") {
    const level = fields.get("구분"), state = fields.get("상태"), source = fields.get("출처") ?? "";
    if (options.strict && (!level || !state || !source)) {
      return { skip: `${entry.key} — 업무 정책에는 \`- 구분:\`(필수·권장) · \`- 상태:\`(확정·관찰) · \`- 출처:\` 가 있어야 합니다`, notes };
    }
    if (level && !RULE_LEVELS.some((value) => level.startsWith(value))) return { skip: `${entry.key} — 구분은 필수 · 권장 중 하나입니다: ${level}`, notes };
    if (state && !RULE_STATES.some((value) => state.startsWith(value))) return { skip: `${entry.key} — 상태는 확정 · 관찰 중 하나입니다: ${state}`, notes };
    if (state?.startsWith("확정") && source && !confirmedSource(source, options.keys)) {
      return { skip: `${entry.key} — 코드에서 관찰한 동작은 확정 정책이 아닙니다 — \`- 상태: 관찰\` 로 쓰거나 출처에 R 번호·사용자 결정을 적으세요`, notes };
    }
    if (state?.startsWith("관찰")) notes.push("관찰 — 코드에서 본 현재 동작입니다. 승인된 업무 정책으로 쓰이지 않습니다");
  }
  const unknown = keyRefs([fields.get("정책"), fields.get("흐름"), fields.get("기능"), fields.get("단계"), entry.kind === "flows" ? entry.text : ""].filter(Boolean).join(" "))
    .filter((key) => /^(?:BR|FEAT|FLOW)-/.test(key) && key !== entry.key && !options.known(key));
  if (unknown.length > 0) notes.push(`가리키는 항목이 문서에 없습니다: ${[...new Set(unknown)].join(", ")}`);
  return { notes };
}

/** 쌓인 문서에 든 항목 하나 — `knowledge` 목록·정리가 읽는 단위다 */
export interface DocumentEntry {
  key: string;
  /** 제목 줄 전체 */
  heading: string;
  /** 제목 줄의 번호, 1부터. git blame 으로 출처를 되찾는 자리다 */
  line: number;
  /** 제목 줄을 뺀 본문 */
  body: string;
  /** 항목의 마지막 내용 줄 번호, 1부터(뒤의 빈 줄은 뺀다). context 가 `L<line>-L<end>` 로 읽을 범위를 짚는다 */
  end: number;
}

/**
 * 쌓인 문서를 항목으로 가른다. `parseProposal` 과 나누는 이유: 저쪽은 **제안**을 읽고 R 번호를
 * 요구하지만, 이쪽은 **이미 반영된 것**을 그냥 센다 — 걸러 내면 목록에서 항목이 사라진다.
 */
export function documentEntries(text: string): DocumentEntry[] {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const entries: DocumentEntry[] = [];
  lines.forEach((line, index) => {
    const key = ENTRY_KEY.exec(line)?.[1];
    if (key === undefined) {
      return;
    }
    const after = lines.findIndex((candidate, at) => at > index && ENTRY_END.test(candidate));
    let end = after < 0 ? lines.length : after;
    while (end > index + 1 && lines[end - 1].trim() === "") end -= 1;
    entries.push({
      key,
      heading: line.trim(),
      line: index + 1,
      body: lines.slice(index + 1, after < 0 ? lines.length : after).join("\n").trim(),
      end,
    });
  });
  return entries;
}

/** 매니페스트가 없어도 기본 경로로 답한다 — 도입 전에도 문서를 열어 볼 수 있어야 한다 */
export function knowledgePath(manifest: Manifest | undefined, kind: KnowledgeKind): string {
  return docPaths(manifest, kind)[0];
}

/** 없는 문서는 그 종류의 빈 뼈대에서 자란다 — 첫 반영이 파일을 만든다 */
export function readKnowledge(repoRoot: string, manifest: Manifest, kind: KnowledgeKind): string {
  const path = join(repoRoot, knowledgePath(manifest, kind));
  return existsSync(path) ? readFileSync(path, "utf-8") : skeleton(SCHEMAS[kind]);
}
