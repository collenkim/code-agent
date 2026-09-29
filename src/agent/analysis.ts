import { existsSync, readFileSync, statSync } from "fs";
import { join, posix } from "path";

import { checkSections, sha } from "./docs";
import { workDocsDir } from "./layout";
import { workSchemaFor } from "./schemas";

/**
 * 작업 폴더의 `analysis.md` — 분석 스테이지의 산출물.
 *
 * ```
 * ## R1 · 주문 등록
 * 근거: "주문을 등록·조회한다."
 * ...
 *
 * ## 작업 문서
 * - data.md
 * - api.md
 * - doc/data-dictionary.md   ← 이미 있는 프로젝트 문서를 인용
 * ```
 *
 * 코드가 읽는 것은 셋이다 — 요구 항목 번호(`## R<n>`) · `## 작업 문서` 목록 · `## 가정`.
 * 게이트는 앞의 둘이다: 번호는 계획이 모든 항목을 덮는지 대조하는 데, 목록은 필요한 작업 문서가
 * 실제로 생겼는지 막는 데 쓴다. 필요 없으면 `- 없음`. 가정은 막지 않고 승인 화면에 실린다.
 */
export const ANALYSIS_FILE = "analysis.md";

export interface Analysis {
  /** 요구 항목 번호, 쓴 순서대로 (R1, R2 …) */
  requirements: string[];
  /** 필요한 작업 문서 — 저장소 기준 경로. 이름만 쓴 것은 작업 폴더 안이다 */
  workDocs: string[];
  /**
   * 질문하지 않고 기본값으로 정한 것 (`## 가정`). 진행을 막지 않는 대신 승인 화면에 그대로 보여
   * 사람이 계획과 함께 받아들인다 — 모든 모호함을 질문으로 막으면 한 줄짜리 요구에도 왕복이 세 번이다.
   */
  assumptions: string[];
}

export function analysisFile(id: string): string {
  return posix.join(workDocsDir(id), ANALYSIS_FILE);
}

/** 형식이 틀리면 무엇이 틀렸는지 던진다 */
export function parseAnalysis(text: string, id: string): Analysis {
  const blocks = text.split(/^## /m).slice(1);
  const requirements = blocks
    .map((block) => /^(R\d+)\b/.exec(block)?.[1])
    .filter((key): key is string => key !== undefined);
  const docsBlock = section(blocks, "작업 문서");

  const problems: string[] = [];
  if (requirements.length === 0) problems.push("요구 항목(`## R1 · …`)이 없습니다");
  const duplicated = requirements.filter((key, index) => requirements.indexOf(key) !== index);
  if (duplicated.length > 0) problems.push(`요구 항목 번호가 겹칩니다: ${[...new Set(duplicated)].join(", ")}`);
  if (!docsBlock) problems.push("`## 작업 문서` 섹션이 없습니다 — 필요 없으면 `- 없음`");

  const entries = firstList(docsBlock).map((item) => /^`?([^`\s]+)`?/.exec(item)![1]);
  if (docsBlock && entries.length === 0) problems.push("`## 작업 문서` 가 비어 있습니다 — 필요 없으면 `- 없음`");
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }

  const workDocs = entries
    .filter((entry) => entry !== "없음")
    .map((entry) => (entry.includes("/") ? entry : posix.join(workDocsDir(id), entry)));
  const assumptions = firstList(section(blocks, "가정")).filter((item) => item !== "없음");
  return { requirements, workDocs, assumptions };
}

function section(blocks: string[], heading: string): string | undefined {
  return blocks.find((block) => block.split("\n")[0].trim() === heading);
}

/** 섹션의 첫 목록 한 덩어리의 항목들 — 그 뒤에 판정 근거 같은 설명 목록이 붙어도 읽지 않는다 */
function firstList(block: string | undefined): string[] {
  const items: string[] = [];
  for (const line of (block ?? "").split("\n").slice(1)) {
    const item = /^\s*[-*]\s+(\S.*)$/.exec(line)?.[1];
    if (item !== undefined) {
      items.push(item.trim());
    } else if (line.trim() !== "" || items.length > 0) {
      break;
    }
  }
  return items;
}

/** 없으면 undefined. 있는데 형식이 틀리면 던진다 */
export function loadAnalysis(repoRoot: string, id: string): Analysis | undefined {
  const path = join(repoRoot, analysisFile(id));
  return existsSync(path) ? parseAnalysis(readFileSync(path, "utf-8"), id) : undefined;
}

/**
 * 분석이 필요하다고 한 작업 문서의 문제 — 없거나 비었거나, 스키마가 있는 문서(data·api·current)는 필수 섹션이 비었거나.
 * `확인 필요` 가 남은 것은 막지 않는다 (프로젝트 문서와 같은 이유) — 질문으로 돌리는 것은 스킬의 일이다.
 */
export function workDocProblems(repoRoot: string, id: string, analysis: Analysis): string[] {
  return analysis.workDocs.flatMap((path) => {
    const full = join(repoRoot, path);
    if (!existsSync(full) || !statSync(full).isFile()) return [`${path} — 없습니다`];
    const text = readFileSync(full, "utf-8");
    if (text.trim() === "") return [`${path} — 비어 있습니다`];
    const schema = posix.dirname(path) === workDocsDir(id) ? workSchemaFor(posix.basename(path)) : undefined;
    const empty = schema ? checkSections(schema, text).filter((section) => section.required && !section.filled) : [];
    return empty.length > 0
      ? [`${path} — 필수 섹션이 비었습니다: ${empty.map((section) => section.heading).join(", ")} (code-agent docs skeleton ${schema!.kind})`]
      : [];
  });
}

/**
 * 계획과 한 묶음으로 승인되는 작업 문서의 해시 — 분석과 분석이 부른 작업 문서.
 * 줄바꿈만 다른 것은 같은 것으로 본다 (프로젝트 문서 확정과 같은 이유 — autocrlf).
 */
export function workDocsHash(repoRoot: string, id: string, analysis: Analysis): string {
  const paths = [analysisFile(id), ...analysis.workDocs];
  return sha(
    paths
      .map((path) => {
        const full = join(repoRoot, path);
        const text = existsSync(full) ? readFileSync(full, "utf-8").replace(/\r\n/g, "\n") : "";
        return `${path}:${sha(text)}`;
      })
      .join("\n"),
  );
}
