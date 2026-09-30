import { existsSync, readFileSync } from "fs";
import { join, posix } from "path";

import type { Manifest } from "../core/manifest";
import { docPaths } from "./docs";
import { workDocsDir } from "./layout";
import { KNOWLEDGE_KINDS } from "./schemas";
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
}

const ENTRY_KEY = /^###\s+`([^`]+)`/;

/**
 * 항목이 끝나는 자리 — `#`~`###` 제목뿐이다.
 *
 * `####` 이상은 **항목 안의 소제목**이라 경계가 아니다. `##+` 로 보면 두 군데가 같이 깨진다:
 * `documentEntries` 가 본문을 소제목에서 잘라 그 아래의 살아 있는 근거 경로를 보지 못하고
 * (`prune` 이 멀쩡한 항목을 지우자고 묻는다), `removeEntry`·`applyEntry` 는 소제목 덩어리를
 * 문서에 고아로 남긴다.
 */
const ENTRY_END = /^#{1,3}\s/;

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
      entries.push({ kind, key, heading: block.heading, text: [block.heading, ...block.lines].join("\n").trimEnd(), requirements });
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

/** 같은 키가 있으면 그 자리에서 갈아 끼우고, 없으면 끝에 붙인다. 지우는 일은 없다 */
export function applyEntry(text: string, entry: KnowledgeEntry): string {
  const range = entryRange(text, entry.key);
  const lines = text.split("\n");
  if (range) {
    return [...lines.slice(0, range.from), ...entry.text.split("\n"), "", ...lines.slice(range.to)].join("\n").replace(/\n{3,}/g, "\n\n");
  }
  return `${text.replace(/\s*$/, "")}\n\n${entry.text}\n`;
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

/** 쌓인 문서에 든 항목 하나 — `knowledge` 목록·정리가 읽는 단위다 */
export interface DocumentEntry {
  key: string;
  /** 제목 줄 전체 */
  heading: string;
  /** 제목 줄의 번호, 1부터. git blame 으로 출처를 되찾는 자리다 */
  line: number;
  /** 제목 줄을 뺀 본문 */
  body: string;
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
    entries.push({
      key,
      heading: line.trim(),
      line: index + 1,
      body: lines.slice(index + 1, after < 0 ? lines.length : after).join("\n").trim(),
    });
  });
  return entries;
}

/** 매니페스트가 없어도 기본 경로로 답한다 — 도입 전에도 문서를 열어 볼 수 있어야 한다 */
export function knowledgePath(manifest: Manifest | undefined, kind: KnowledgeKind): string {
  return docPaths(manifest, kind)[0];
}

export function readKnowledge(repoRoot: string, manifest: Manifest, kind: KnowledgeKind): string {
  const path = join(repoRoot, knowledgePath(manifest, kind));
  return existsSync(path) ? readFileSync(path, "utf-8") : `# ${kind}\n`;
}
