export interface IntakeMapping { quote: string; targets: string[]; note?: string; }
export interface IntakeInput {
  title: string; background: string; requirements: string[]; done: string[]; constraints: string[]; outOfScope: string[];
  sourceMap?: IntakeMapping[];
}
const normalize = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/**
 * 의미를 자동 판정하지 않는다. 원문의 각 부분이 어디에 반영/제외됐는지를 확정 전에 보여준다.
 * `explicit` 는 요구 개정의 연결 대상(안정 ID → 내용)이다 — 없으면 목록 위치로 REQ-1 처럼 붙인다.
 */
export function intakeTrace(original: string, request: IntakeInput, explicit?: Record<string, string>) {
  const targets: Record<string, string> = { TITLE: request.title, BACKGROUND: request.background };
  if (explicit) Object.assign(targets, explicit);
  else for (const [prefix, values] of [["REQ", request.requirements], ["DONE", request.done], ["CON", request.constraints], ["OUT", request.outOfScope]] as const) {
    values.forEach((value, index) => { targets[`${prefix}-${index + 1}`] = value; });
  }
  const raw = normalize(original);
  const covered = new Array(raw.length).fill(false);
  // 원문은 보존한다. 첫 줄의 독립 호출만 분리하며 인용·문장 안의 같은 문자열은 요구 추적에 남긴다.
  const invocation = /^\s*([/$]ca-request)[ \t]*(?:\r?\n|$)/.exec(original)?.[1];
  if (invocation) for (let i = 0; i < invocation.length; i++) covered[i] = true;
  // 한 줄 요청은 호출과 업무 문장을 자동으로 구분하지 않는다. 접수자가 호출임을 명시한 선두 토큰만 허용한다.
  const inlineInvocation = /^([/$]ca-request)(?=\s|$)/.exec(raw)?.[1];
  if (inlineInvocation) targets.INVOCATION = "접수 호출 표식 — 원문 보존";
  const problems: string[] = [];
  const mappings: IntakeMapping[] = request.sourceMap?.length ? request.sourceMap : Object.entries(targets)
    .filter(([, value]) => value.trim() && raw.includes(normalize(value)))
    .map(([key, value]) => ({ quote: value, targets: [key] }));
  for (const mapping of mappings) {
    const quote = normalize(mapping.quote);
    if (mapping.targets.includes("INVOCATION") && (quote !== inlineInvocation || mapping.targets.length !== 1)) {
      problems.push("호출 표식 연결은 원문 맨 앞의 독립 호출 토큰만 INVOCATION 하나로 지정합니다");
      continue;
    }
    if (mapping.targets[0] === "INVOCATION") {
      for (let i = 0; i < quote.length; i++) covered[i] = true;
      continue;
    }
    if (!quote || !raw.includes(quote)) problems.push(`원문에 없는 인용: ${mapping.quote}`);
    if (!mapping.targets.length) problems.push(`연결 대상이 없는 인용: ${mapping.quote}`);
    for (const target of mapping.targets) if (!targets[target]?.trim()) problems.push(`존재하지 않거나 비어 있는 연결 대상: ${target}`);
    for (let from = quote ? raw.indexOf(quote) : -1; from >= 0; from = raw.indexOf(quote, from + quote.length)) {
      for (let i = from; i < from + quote.length; i++) covered[i] = true;
    }
  }
  const missing = raw.split("").map((char, index) => covered[index] ? " " : char).join("").trim();
  const rows = mappings.map(mapping => `| ${cell(mapping.quote)} | ${mapping.targets.join(", ")} | ${cell(mapping.targets.map(target => targets[target] ?? "미정").join(" / "))} | ${cell(mapping.note ?? (mapping.targets.some(target => target.startsWith("OUT-")) ? "범위에서 제외 — 확정 시 확인" : "반영 — 의미 보존 확인"))} |`);
  if (invocation) rows.unshift(`| ${invocation} | 호출 표식 | 요구 항목 아님 | 원문 보존 · 첫 줄의 독립 호출만 추적 제외 |`);
  if (missing) rows.push(`| ${cell(missing)} | 미연결 | 확인 필요 | 정리본에 반영하거나 명시적으로 제외하고 연결하세요 |`);
  return { missing, problems, text: ["## 원문 대조", "", `<!-- code-agent-original-unmapped: ${missing ? 1 : 0} -->`,
    "원문을 어디에 반영했는지 확인합니다. 연결이 있어도 같은 의미인지는 확정 시 검토합니다.", "",
    "| 원문 근거 | 연결 | 정리된 내용 | 처리 |", "|---|---|---|---|", ...rows, ""].join("\n") };
}

export function hasUnmappedOriginal(text: string): boolean {
  return /<!-- code-agent-original-unmapped: [1-9]\d* -->/.test(text);
}
