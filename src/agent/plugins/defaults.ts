import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "fs";
import { join, posix } from "path";

import type { Manifest } from "../../core/manifest";
import { docPaths, sectionsOf } from "../docs";
import type { DocKind } from "../schemas";
import { MAX_ITEMS } from "./protocol";
import type { DocRef, DocSection, FileRef, RankedFile, RequirementRef } from "./protocol";

/**
 * 자리의 **기본 구현** 둘 — 등록이 없는 사람에게 도는 것.
 *
 * 나머지 넷(`survey.classify`·`review.prefilter`·`verify.extra`·`code.index`)의 기본 구현은
 * 이미 있는 코드다 (계층 후보 절 · reviewer 전량 열람 · 매니페스트 `commands` · 없음).
 *
 * **`rg` 가 PATH 에 있어도 쓰지 않는다.** rg 의 ignore 규칙·유니코드 단어 경계가 Node 스캔과
 * 달라 같은 저장소에서 사람마다 다른 순위가 나온다 — 순위가 계획의 출발점이라 그 흔들림이 비싸다.
 */

/** 파일 하나에서 읽는 최대 바이트 */
const MAX_READ_BYTES = 256 * 1024;

/** 본문 미리보기 — 제목 다음 이만큼만 본다 */
const PREVIEW_CHARS = 200;

/**
 * 짧은 불용어. 길이 2 미만은 이미 걸러지므로(한국어 조사 대부분이 여기서 빠진다) 남는 것만 적는다.
 */
const STOPWORDS = new Set([
  "있다", "없다", "한다", "하다", "된다", "하는", "되는", "것을", "그리고", "또는",
  "때문", "대해", "위해", "경우", "해당", "없음", "기존", "사용", "the", "and",
  "for", "with", "that", "this", "from", "not", "are", "was",
]);

/** 한글 토큰 뒤에 붙는 흔한 조사 — 떼어 낸 형태도 후보로 둔다 (형태소 분석은 이 범위 밖이다) */
const PARTICLE = /(에서|에게|으로|부터|까지|을|를|이|가|은|는|의|에|로|와|과|도|만)$/;

function splitCamel(token: string): string[] {
  const parts = token.split(/(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
  return parts.length > 1 ? [token, ...parts] : [token];
}

/** ① 의 `## R<n> · <제목>` 제목 + `근거:` 인용문 */
export function requirementItems(text: string): RequirementRef[] {
  return text
    .split(/^## /m)
    .slice(1)
    .filter((block) => /^R\d+\b/.test(block))
    .map((block) => {
      const key = /^(R\d+)/.exec(block)![1];
      const title = block.split("\n")[0].replace(/^R\d+\s*[·.\-—]?\s*/, "").trim();
      const grounds = [...block.matchAll(/^\s*근거\s*:\s*(.+)$/gm)].map((match) => match[1].trim());
      return { key, text: [title, ...grounds].join(" ") };
    });
}

/** 요구 항목에서 뽑은 검색어. 같은 문서면 언제나 같은 목록이다 */
export function keywordsOf(items: RequirementRef[]): string[] {
  const found = new Set<string>();
  for (const item of items) {
    for (const raw of item.text.split(/[^\p{L}\p{N}]+/u)) {
      if (!raw) continue;
      for (const part of splitCamel(raw)) {
        const word = part.toLowerCase();
        if (word.length >= 2 && !STOPWORDS.has(word)) found.add(word);
        const stripped = word.replace(PARTICLE, "");
        if (stripped.length >= 2 && stripped !== word && !STOPWORDS.has(stripped)) found.add(stripped);
      }
    }
  }
  return [...found].sort();
}

function readCapped(path: string): string {
  try {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(MAX_READ_BYTES);
      const read = readSync(fd, buffer, 0, MAX_READ_BYTES, 0);
      return buffer.subarray(0, read).toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/**
 * 내장 키워드 스캔 — 경로·파일명 히트는 3, 내용 히트는 1.
 * 동점은 경로 사전순이라 **같은 트리에서 항상 같은 결과**가 나온다 (`localeCompare` 를 쓰지 않는
 * 이유가 그것이다 — 로캘마다 순서가 갈린다).
 */
export function rankCandidates(repoRoot: string, files: FileRef[], keywords: string[], limit: number): RankedFile[] {
  if (keywords.length === 0) {
    return [];
  }
  const scored: RankedFile[] = [];
  for (const file of files.slice(0, MAX_ITEMS)) {
    const path = file.path.toLowerCase();
    const content = readCapped(join(repoRoot, file.path)).toLowerCase();
    let hits = 0;
    const why: string[] = [];
    for (const keyword of keywords) {
      const inPath = path.includes(keyword);
      const inContent = content.includes(keyword);
      if (inPath) hits += 3;
      if (inContent) hits += 1;
      if (inPath || inContent) why.push(keyword);
    }
    if (hits === 0) continue;
    scored.push({
      path: file.path,
      score: Math.min(1, hits / (keywords.length * 3)),
      why: why.slice(0, 6).join(" · "),
    });
  }
  return scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, limit);
}

// ---- context.docs ----

/** 등록된 문서 — 아키텍처 · 컨벤션 · KNOWLEDGE 3종. 테스트 전략·품질은 검증 자리의 것이라 뺀다 */
const DOC_KINDS: DocKind[] = ["architecture", "conventions", "data-dictionary", "api-catalog", "business-rules"];

function markdownIn(repoRoot: string, path: string): string[] {
  const full = join(repoRoot, path);
  if (!existsSync(full)) {
    return [];
  }
  if (!statSync(full).isDirectory()) {
    return [path];
  }
  return readdirSync(full)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => posix.join(path, name));
}

interface Section {
  kind: string;
  path: string;
  heading: string;
  line: number;
  preview: string;
}

function allSections(repoRoot: string, manifest: Manifest | undefined): Section[] {
  const found: Section[] = [];
  for (const kind of DOC_KINDS) {
    for (const path of docPaths(manifest, kind).flatMap((entry) => markdownIn(repoRoot, entry))) {
      // 문서 제목(level 1)은 절이 아니다 — 본문이 문서 전체라 "이 절만 읽으라" 가 성립하지 않는다
      for (const section of sectionsOf(readCapped(join(repoRoot, path))).filter((entry) => entry.level >= 2)) {
        found.push({
          kind,
          path,
          heading: section.heading,
          line: section.line,
          preview: section.body.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS),
        });
      }
    }
  }
  return found;
}

/** 플러그인에게 보낼 문서 목차 — 제목과 줄 번호만. 본문은 보내지 않는다 */
export function docRefs(repoRoot: string, manifest: Manifest | undefined): DocRef[] {
  const byPath = new Map<string, DocRef>();
  for (const section of allSections(repoRoot, manifest)) {
    const entry = byPath.get(section.path) ?? { kind: section.kind, path: section.path, headings: [] };
    entry.headings.push({ heading: section.heading, line: section.line });
    byPath.set(section.path, entry);
  }
  return [...byPath.values()];
}

/** 제목 매칭 — 제목과 본문 첫 200자에 든 키워드 수로. 동점은 경로·줄 순서 */
export function relevantDocSections(
  repoRoot: string,
  manifest: Manifest | undefined,
  keywords: string[],
  limit: number,
): DocSection[] {
  if (keywords.length === 0) {
    return [];
  }
  const scored = allSections(repoRoot, manifest)
    .map((section) => {
      const heading = section.heading.toLowerCase();
      const preview = section.preview.toLowerCase();
      const hit = keywords.filter((keyword) => heading.includes(keyword) || preview.includes(keyword));
      // 제목에 걸린 것이 본문에 스친 것보다 무겁다
      const score = hit.reduce((sum, keyword) => sum + (heading.includes(keyword) ? 3 : 1), 0);
      return { section, score, why: hit.slice(0, 4).join(" · ") };
    })
    .filter((entry) => entry.score > 0);
  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.section.path < b.section.path ? -1 : a.section.path > b.section.path ? 1 : 0) ||
        a.section.line - b.section.line,
    )
    .slice(0, limit)
    .map((entry) => ({ path: entry.section.path, heading: entry.section.heading, why: entry.why }));
}
