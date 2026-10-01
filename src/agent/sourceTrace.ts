import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface SourceItem { id: string; text: string; }
export interface SourceRow extends SourceItem { requirements: string[]; missing: string; }
const normalize = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();
const clean = (text: string) => text.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").replace(/^\[(?:REQ|DONE|CON)-\d+\]\s*/, "").trim();

/** 확정 지시서에서만 읽는다. 변경 가능한 request.json 을 추적의 원장으로 쓰지 않는다. */
export function sourceItems(text: string): SourceItem[] {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").replace(/<!--[\s\S]*?-->/g, "");
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

function analysisItems(text: string) {
  return text.split(/^## /m).slice(1).filter((block) => /^R\d+\b/.test(block)).map((block) => ({
    key: /^(R\d+)\b/.exec(block)![1],
    sources: [...(block.match(/^\s*출처\s*:\s*(.*)$/m)?.[1] ?? "").matchAll(/\b(?:REQ|DONE|CON)-\d+\b/g)].map((m) => m[0]),
    citations: [...block.matchAll(/^\s*근거\s*:[ \t]*(.*)$/gm)].map((m) => normalize(m[1].replace(/^["“「]|["”」]$/g, ""))).filter(Boolean),
  }));
}

export function sourceTrace(order: string, analysis: string): { rows: SourceRow[]; problems: string[] } {
  const sources = sourceItems(order);
  const items = analysisItems(analysis);
  const problems: string[] = [];
  if (!sources.length) problems.push("확정 지시서에 추적할 요구 내용이 없습니다 — 요구사항을 보완하고 다시 확정하세요");
  for (const item of items) {
    for (const id of item.sources) if (!sources.some((s) => s.id === id)) problems.push(`${item.key}: 지시서에 없는 출처 ${id}`);
    for (const quote of item.citations) {
      if (!sources.some((source) => (!item.sources.length || item.sources.includes(source.id)) && normalize(source.text).includes(quote))) {
        problems.push(`${item.key}: 근거 인용이 확정된 요구 내용·완료 조건·제약에 없습니다: ${quote}`);
      }
    }
  }
  const rows = sources.map((source) => {
    const text = normalize(source.text);
    const covered = new Array(text.length).fill(false);
    const owners = new Set<string>();
    for (const item of items) {
      if (item.sources.length && !item.sources.includes(source.id)) continue;
      for (const quote of item.citations) {
        for (let from = text.indexOf(quote); from >= 0; from = text.indexOf(quote, from + quote.length)) {
          owners.add(item.key);
          for (let i = from; i < from + quote.length; i++) covered[i] = true;
        }
      }
    }
    const missing = text.split("").map((char, i) => covered[i] ? " " : char).join("").trim();
    if (!owners.size || /\S/u.test(missing)) problems.push(`분석에서 빠진 요구 ${source.id}: ${missing || source.text} — R 블록에 출처와 원문 근거를 연결하세요`);
    return { ...source, requirements: [...owners], missing };
  });
  return { rows, problems };
}

export function readSourceTrace(repoRoot: string, id: string, spec: string) {
  const analysis = join(repoRoot, `doc/work/${id}/01-requirements.md`);
  return sourceTrace(readFileSync(join(repoRoot, spec), "utf8"), existsSync(analysis) ? readFileSync(analysis, "utf8") : "");
}

export function formatSourceTrace(rows: SourceRow[]): string {
  const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return ["## 접수 요구 추적", "", "| 출처 | 확정된 내용 | 분석 항목 |", "|---|---|---|",
    ...rows.map((row) => `| ${row.id} | ${cell(row.text)} | ${row.requirements.join(", ") || "미연결"} |`)].join("\n");
}
