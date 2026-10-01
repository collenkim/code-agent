/** 테스트 러너의 결과 행만 읽는다. TC가 주석·로그에 등장했다는 사실은 실행 결과가 아니다. */
export type CaseStatus = "passed" | "failed" | "skipped" | "not-run" | "unknown";
export interface CaseResult { id: string; status: CaseStatus; format: string; }

export function parseTestResults(output: string): CaseResult[] {
  const found: CaseResult[] = parseJUnitResults(output);
  const add = (name: string, status: CaseStatus, format: string) => {
    for (const id of new Set(name.match(/(?<![A-Za-z0-9])TC-\d+(?![A-Za-z0-9])/g) ?? [])) found.push({ id, status, format });
  };
  for (const raw of output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^(not ok|ok)\s+\d+(?:\s+-)?\s+(.+)$/.exec(line);
    if (m) {
      add(m[2], /#\s*(SKIP|TODO)\b/i.test(m[2]) ? "skipped" : m[1] === "ok" ? "passed" : "failed", "TAP");
      continue;
    }
    m = /^([✔✓✖×﹣↓])\s+(.+)$/.exec(line);
    if (m) { add(m[2], /[﹣↓]/.test(m[1]) || /#\s*(SKIP|TODO)\b/i.test(m[2]) ? "skipped" : /[✔✓]/.test(m[1]) ? "passed" : "failed", "node-spec"); continue; }
    m = /^(.*?)\s+\.\.\.\s+(ok|FAIL|ERROR|skipped\b.*|expected failure|unexpected success)$/.exec(line);
    if (m) { add(m[1], m[2] === "ok" ? "passed" : /^(skipped|expected failure)/.test(m[2]) ? "skipped" : "failed", "unittest"); continue; }
    m = /^(\S+::.+?)\s+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)(?:\s+.*)?$/.exec(line);
    if (m) { add(m[1], m[2] === "PASSED" ? "passed" : /^(SKIPPED|XFAIL)$/.test(m[2]) ? "skipped" : "failed", "pytest-verbose"); continue; }
    if (!line.startsWith("{")) continue;
    try {
      const item = JSON.parse(line);
      if (typeof item.Test === "string" && ["pass", "fail", "skip"].includes(item.Action)) {
        add(item.Test, item.Action === "pass" ? "passed" : item.Action === "fail" ? "failed" : "skipped", "go-json");
      } else if (item.type === "code-agent-test" && typeof item.id === "string" && ["passed", "failed", "skipped", "not-run"].includes(item.status)) {
        add(item.id, item.status, "jsonl");
      }
    } catch { /* 일반 출력은 결과가 아니다 */ }
  }
  return found;
}

/** JUnit 계열 결과만 읽는다. 외부 엔티티·DTD는 해석하지 않는다. */
export function parseJUnitResults(xml: string): CaseResult[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<testsuites?\b/.test(xml)) return [];
  const decode = (value: string) => value.replace(/&(?:quot|apos|lt|gt|amp|#\d+|#x[\da-f]+);/gi, (entity) => {
    const known: Record<string, string> = { "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" };
    if (known[entity]) return known[entity];
    const code = entity[2].toLowerCase() === "x" ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
  // 로그·CDATA 안에 XML처럼 생긴 문자열이 있어도 결과로 인식하지 않는다.
  const body = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const results: CaseResult[] = [];
  for (const match of body.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase\s*>)/g)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1], decode(m[2] ?? m[3])]));
    const content = match[2] ?? "";
    const status: CaseStatus = /<(?:failure|error)\b/.test(content) ? "failed"
      : /<skipped\b/.test(content) || /^(?:skipped|disabled|notrun)$/i.test(attrs.status ?? "") ? "skipped" : "passed";
    for (const id of new Set((attrs.name ?? "").match(/(?<![A-Za-z0-9])TC-\d+(?![A-Za-z0-9])/g) ?? [])) results.push({ id, status, format: "JUnit XML" });
  }
  return results;
}

export function resultFor(id: string, results: CaseResult[]): { status: CaseStatus; format?: string } {
  const entries = results.filter((entry) => entry.id === id);
  if (!entries.length) return { status: "unknown" };
  // 매개변수화된 같은 TC의 일부 실패·생략을 성공 한 건이 덮지 못한다.
  const status = (["failed", "not-run", "skipped", "unknown", "passed"] as CaseStatus[]).find((status) => entries.some((entry) => entry.status === status))!;
  return { status, format: [...new Set(entries.map((entry) => entry.format))].join(", ") };
}
