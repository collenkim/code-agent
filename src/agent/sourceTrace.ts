import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { withoutErrorLog } from "../core/workOrder";
import { ruled } from "./planningRules";
import { citationText, requirementBlocks, sourceIds } from "./requirementFields";

export interface SourceItem { id: string; text: string; }
export interface SourceRow extends SourceItem { requirements: string[]; missing: string; }
const normalize = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();
const clean = (text: string) => text.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").replace(/^\[(?:REQ|DONE|CON)-\d+\]\s*/, "").trim();

/** 확정 지시서에서만 읽는다. 변경 가능한 request.json 을 추적의 원장으로 쓰지 않는다. */
export function sourceItems(text: string): SourceItem[] {
  // 오류 로그 절(로그 원문·재현 절차)은 요구가 아니다
  const body = withoutErrorLog(text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").replace(/<!--[\s\S]*?-->/g, ""));
  const sections = body.split(/^##\s+/m).slice(1);
  const structured = sections.some((section) => section.split(/\r?\n/)[0].trim() === "요구 내용");
  if (structured) {
    return sections.flatMap((section) => {
      const [heading, ...lines] = section.split(/\r?\n/);
      const prefix = ({ "요구 내용": "REQ", "완료 조건": "DONE", "제약": "CON" } as Record<string, string>)[heading.trim()];
      if (!prefix) return [];
      // 렌더된 항목은 여러 줄이어도 하나다. 표시된 ID를 유지해 뒤 항목 번호가 밀리지 않게 한다.
      const marked = /^[-*]\s+\[((?:REQ|DONE|CON)-\d+)\]\s*(.*)$/;
      if (lines.some((line) => marked.test(line))) {
        const items: SourceItem[] = [];
        for (const line of lines) {
          const match = marked.exec(line);
          if (match) items.push({ id: match[1], text: match[2].trim() });
          else if (line.trim() && items.length) items[items.length - 1].text += `\n${line.trim()}`;
        }
        return items;
      }
      return lines.map(clean).filter((line) => line && line !== "없음" && !line.startsWith("원문에 없음"))
        .map((line, index) => ({ id: `${prefix}-${index + 1}`, text: line }));
    });
  }
  // 사람이 쓴 옛 지시서는 내용 줄을 그대로 항목으로 본다. 같은 줄의 여러 문장도 인용들의 합으로 덮는다.
  return body.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).map(clean).filter(Boolean)
    .map((line, index) => ({ id: `REQ-${index + 1}`, text: line }));
}

/**
 * 인용이 덮지 않아도 되는 글자 — 문장 사이의 쉼표·마침표 같은 문장부호만, 그것도 양옆이 모두 글자·숫자가 아닐 때만이다.
 * `3.5`·`1,000`·`v1.2`·`a.ts` 의 점·쉼표는 값의 일부라 빠지면 안 된다. 하이픈(음수)·부등호·괄호·슬래시는 허용하지 않는다.
 */
const SOFT_PUNCTUATION = /^[,.;!?、。，．；！？]+$/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** 인용이 덮지 못한 조각들 — 무시해도 되는 문장부호는 뺀다 */
function uncoveredFragments(text: string, covered: boolean[]): string[] {
  const settled = [...covered];
  for (let start = 0; start < text.length;) {
    if (settled[start] || /\s/.test(text[start])) { start += 1; continue; }
    let end = start;
    while (end < text.length && !settled[end] && !/\s/.test(text[end])) end += 1;
    if (SOFT_PUNCTUATION.test(text.slice(start, end)) && !(WORD_CHAR.test(text[start - 1] ?? "") && WORD_CHAR.test(text[end] ?? ""))) {
      for (let index = start; index < end; index += 1) settled[index] = true;
    }
    start = end;
  }
  const fragments: string[] = [];
  let current = "";
  for (let index = 0; index <= text.length; index += 1) {
    if (index < text.length && !settled[index]) { current += text[index]; continue; }
    if (current.trim()) fragments.push(current.trim());
    current = "";
  }
  return fragments;
}

/**
 * 01 의 R 블록이 확정 지시서의 항목을 빠짐없이 인용하는가. `근거:`·`출처:` 는 parseRequirements 와 같은 파서(requirementFields)로 읽는다.
 * `path` 는 문구의 위치 표시에만 쓴다.
 */
export function sourceTrace(order: string, analysis: string, path = "01-requirements.md"): { rows: SourceRow[]; problems: string[] } {
  const sources = sourceItems(order);
  const items = requirementBlocks(analysis).map((block) => {
    const { ids, invalid } = sourceIds(block.sources);
    const citations = block.grounds.map((ground) => ({ quote: normalize(citationText(ground.value)), line: ground.line })).filter((citation) => citation.quote);
    return { key: block.key, sources: ids, invalid, citations };
  });
  const problems: string[] = [];
  if (!sources.length) problems.push(ruled("REQ-TRACE", "확정 지시서에 추적할 요구 내용이 없습니다 — 요구사항을 보완하고 다시 확정하세요"));
  const known = sources.map((source) => source.id).join(", ");
  for (const item of items) {
    for (const bad of item.invalid) problems.push(ruled("REQ-TRACE", `${path}:${bad.line} ${item.key}: 출처 ID 형식이 아닙니다: ${bad.value} — context 의 ID 를 글자 그대로 씁니다 (${known})`));
    for (const id of item.sources) if (!sources.some((s) => s.id === id)) problems.push(ruled("REQ-TRACE", `${item.key}: 지시서에 없는 출처 ${id} — 있는 ID: ${known}`));
    for (const { quote, line } of item.citations) {
      if (!sources.some((source) => (!item.sources.length || item.sources.includes(source.id)) && normalize(source.text).includes(quote))) {
        problems.push(ruled("REQ-TRACE", `${path}:${line} ${item.key}: 근거 인용이 확정된 요구 내용·완료 조건·제약에 없습니다: ${quote} — ` +
          `${item.sources.length ? `출처(${item.sources.join(", ")}) 항목의 ` : ""}글자를 그대로 옮기고 설명은 닫는 따옴표 뒤에 둡니다`));
      }
    }
  }
  const rows = sources.map((source) => {
    const text = normalize(source.text);
    const covered = new Array(text.length).fill(false);
    const owners = new Set<string>();
    for (const item of items) {
      if (item.sources.length && !item.sources.includes(source.id)) continue;
      for (const { quote } of item.citations) {
        for (let from = text.indexOf(quote); from >= 0; from = text.indexOf(quote, from + quote.length)) {
          owners.add(item.key);
          for (let i = from; i < from + quote.length; i++) covered[i] = true;
        }
      }
    }
    const fragments = owners.size ? uncoveredFragments(text, covered) : [];
    if (!owners.size) {
      problems.push(ruled("REQ-TRACE", `분석에서 빠진 요구 ${source.id}: ${text} — R 블록에 \`출처: ${source.id}\` 와 이 원문을 인용한 \`근거: "…"\` 를 연결하세요`));
    } else if (fragments.length) {
      problems.push(ruled("REQ-TRACE", `분석에서 빠진 요구 ${source.id}: ${fragments.map((fragment) => `"${fragment}"`).join(", ")} — ` +
        `인용(${[...owners].join(", ")})이 덮지 못한 부분입니다. 이 부분까지 근거: 로 인용하세요`));
    }
    return { ...source, requirements: [...owners], missing: fragments.join(" … ") };
  });
  return { rows, problems };
}

export function readSourceTrace(repoRoot: string, id: string, spec: string) {
  const path = `doc/work/${id}/01-requirements.md`, analysis = join(repoRoot, path);
  return sourceTrace(readFileSync(join(repoRoot, spec), "utf8"), existsSync(analysis) ? readFileSync(analysis, "utf8") : "", path);
}

export function formatSourceTrace(rows: SourceRow[]): string {
  const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return ["## 접수 요구 추적", "", "| 출처 | 확정된 내용 | 분석 항목 |", "|---|---|---|",
    ...rows.map((row) => `| ${row.id} | ${cell(row.text)} | ${row.requirements.join(", ") || "미연결"} |`)].join("\n");
}
