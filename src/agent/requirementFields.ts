/**
 * 01-requirements 의 `## R<n>` 블록과 그 안의 `근거:`·`출처:` 줄 — 형식 검사(parseRequirements)와 원문 추적(sourceTrace)이
 * 같은 파서를 쓴다. 한쪽만 읽는 표기가 있으면 형식 검사는 지나고 추적에서 막히거나 그 반대가 된다.
 *
 * 표시용 Markdown 은 벗긴다 — 목록 표시(`- `·`* `·`1. `), 라벨의 강조(`**근거**:`·`**근거:**`), 전각 쌍점(`：`).
 * 인용은 따옴표 안만이다 — `근거: "…" (REQ-1)` 의 닫는 따옴표 뒤는 설명이지 지시서 문장이 아니다.
 */

export interface FieldLine { value: string; line: number; }
export interface RequirementBlock { key: string; line: number; grounds: FieldLine[]; sources: FieldLine[]; }

const EMPHASIS = String.raw`(?:\*\*|__|\*|_)?`;
const fieldPattern = (label: string) =>
  new RegExp(String.raw`^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?${EMPHASIS}${label}${EMPHASIS}[ \t]*[:：]${EMPHASIS}[ \t]*(.*?)[ \t]*$`);
const GROUND = fieldPattern("근거"), SOURCE = fieldPattern("출처");

/** `## R<n>` 블록들. 줄 번호는 1부터, 문서 전체 기준이다 */
export function requirementBlocks(text: string): RequirementBlock[] {
  const blocks: RequirementBlock[] = [];
  let current: RequirementBlock | undefined;
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    if (/^## /.test(line)) {
      const key = /^## (R\d+)\b/.exec(line)?.[1];
      current = key ? { key, line: index + 1, grounds: [], sources: [] } : undefined;
      if (current) blocks.push(current);
      return;
    }
    if (!current) return;
    const ground = GROUND.exec(line), source = SOURCE.exec(line);
    if (ground) current.grounds.push({ value: ground[1], line: index + 1 });
    else if (source) current.sources.push({ value: source[1], line: index + 1 });
  });
  return blocks;
}

const CLOSERS: Record<string, string[]> = { "\"": ["\"", "”"], "“": ["”", "\""], "「": ["」"], "『": ["』"] };

/**
 * `근거:` 값에서 인용 본문만 — 여는 따옴표로 시작하면 마지막 닫는 따옴표까지(안의 따옴표는 본문이다), 값 전체를 감싼 강조·백틱은
 * 표시라 벗긴다. 따옴표가 없으면 값 전체를 인용으로 본다(닫는 따옴표 하나만 남은 경우도 벗긴다).
 */
export function citationText(value: string): string {
  let text = value.trim();
  const emphasized = /^(\*\*|__|\*|_)(.+)\1$/.exec(text);
  if (emphasized) text = emphasized[2].trim();
  const closers = CLOSERS[text[0]];
  if (closers) {
    const end = Math.max(...closers.map((closer) => text.lastIndexOf(closer)));
    return (end > 0 ? text.slice(1, end) : text.slice(1)).trim();
  }
  if (/^`[^`]+`$/.test(text)) return text.slice(1, -1).trim();
  return text.replace(/["”」』]$/, "").trim();
}

/**
 * `출처:` 줄들의 지시서 ID. `REQ-1` 꼴만 ID 다 — 대소문자·하이픈이 다른 `req-1`·`REQ1` 은 무엇을 가리키는지 코드가 추측하지 않고
 * `invalid` 로 돌려준다(조용히 버리면 그 블록이 아무 항목이나 인용할 수 있게 된다).
 */
export function sourceIds(lines: FieldLine[]): { ids: string[]; invalid: FieldLine[] } {
  const ids: string[] = [], invalid: FieldLine[] = [];
  for (const line of lines) {
    for (const match of line.value.matchAll(/(?<![A-Za-z0-9])(?:REQ|DONE|CON)-?\d+(?![A-Za-z0-9])/gi)) {
      if (/^(?:REQ|DONE|CON)-\d+$/.test(match[0])) { if (!ids.includes(match[0])) ids.push(match[0]); }
      else invalid.push({ value: match[0], line: line.line });
    }
  }
  return { ids, invalid };
}
