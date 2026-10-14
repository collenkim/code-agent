/** 테스트 러너의 결과 행만 읽는다. TC가 주석·로그에 등장했다는 사실은 실행 결과가 아니다. */
export type CaseStatus = "passed" | "failed" | "skipped" | "not-run" | "unknown";
export interface CaseResult { id: string; status: CaseStatus; format: string; }
/** 이름에 TC id 가 없어도 담는 결과 한 줄 — 환경 분류(environmentMatch)가 TC 아닌 실패까지 보려고 쓴다 */
export interface ScannedResult { name: string; status: CaseStatus; format: string; }

const TC_ID = /(?<![A-Za-z0-9])TC-\d+(?![A-Za-z0-9])/g;

/** 파일 텍스트에서 TC id 하나를 찾는 토큰 — 결과 인식(TC_ID)과 같은 경계다. `TC-6_empty` 는 걸리고 `TC-12`·`TC-1a` 는 TC-1 이 아니다 */
export function tcToken(id: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${id}(?![A-Za-z0-9])`);
}

/** 콘솔 출력의 결과 행(TAP·node spec·unittest·pytest·Go JSON·code-agent JSONL)을 하나씩 넘긴다 */
function scanLines(output: string, onResult: (name: string, status: CaseStatus, format: string) => void): void {
  for (const raw of output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^(not ok|ok)\s+\d+(?:\s+-)?\s+(.+)$/.exec(line);
    if (m) {
      onResult(m[2], /#\s*(SKIP|TODO)\b/i.test(m[2]) ? "skipped" : m[1] === "ok" ? "passed" : "failed", "TAP");
      continue;
    }
    m = /^([✔✓✖×﹣↓])\s+(.+)$/.exec(line);
    if (m) { onResult(m[2], /[﹣↓]/.test(m[1]) || /#\s*(SKIP|TODO)\b/i.test(m[2]) ? "skipped" : /[✔✓]/.test(m[1]) ? "passed" : "failed", "node-spec"); continue; }
    m = /^(.*?)\s+\.\.\.\s+(ok|FAIL|ERROR|skipped\b.*|expected failure|unexpected success)$/.exec(line);
    if (m) { onResult(m[1], m[2] === "ok" ? "passed" : /^(skipped|expected failure)/.test(m[2]) ? "skipped" : "failed", "unittest"); continue; }
    m = /^(\S+::.+?)\s+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)(?:\s+.*)?$/.exec(line);
    if (m) { onResult(m[1], m[2] === "PASSED" ? "passed" : /^(SKIPPED|XFAIL)$/.test(m[2]) ? "skipped" : "failed", "pytest-verbose"); continue; }
    if (!line.startsWith("{")) continue;
    try {
      const item = JSON.parse(line);
      if (typeof item.Test === "string" && ["pass", "fail", "skip"].includes(item.Action)) {
        onResult(item.Test, item.Action === "pass" ? "passed" : item.Action === "fail" ? "failed" : "skipped", "go-json");
      } else if (item.type === "code-agent-test" && typeof item.id === "string" && ["passed", "failed", "skipped", "not-run"].includes(item.status)) {
        onResult(item.id, item.status, "jsonl");
      }
    } catch { /* 일반 출력은 결과가 아니다 */ }
  }
}

/**
 * 콘솔 출력 속 JUnit XML 은 `<?xml` 선언이 있는 문서만 읽는다 — 앱 로그에 섞인 `<testsuite>` 조각은 결과가 아니다.
 * 보고서 파일(freshTestReports)은 parseJUnitResults 를 직접 부르므로 이 조건과 무관하다.
 */
function consoleJUnit(output: string): string | undefined {
  return /^\s*<\?xml\b/m.test(output) ? output : undefined;
}

export function parseTestResults(output: string): CaseResult[] {
  const xml = consoleJUnit(output);
  const found: CaseResult[] = xml === undefined ? [] : parseJUnitResults(xml);
  scanLines(output, (name, status, format) => {
    for (const id of new Set(name.match(TC_ID) ?? [])) found.push({ id, status, format });
  });
  return found;
}

/** 출력의 **모든** 결과 행 — 이름에 TC id 가 없어도 담는다. 환경 분류에만 쓴다(같은 실행의 실패 결과가 있으면 환경이 아니다) */
export function scanTestResults(output: string): ScannedResult[] {
  const found: ScannedResult[] = [];
  const xml = consoleJUnit(output);
  if (xml !== undefined) for (const entry of scanJUnitCases(xml)) found.push({ ...entry, format: "JUnit XML" });
  scanLines(output, (name, status, format) => found.push({ name, status, format }));
  return found;
}

/** JUnit 계열 testcase 전부(이름에 TC id 가 없어도). 외부 엔티티·DTD는 해석하지 않는다. */
export function scanJUnitCases(xml: string): { name: string; status: CaseStatus }[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<testsuites?\b/.test(xml)) return [];
  const decode = (value: string) => value.replace(/&(?:quot|apos|lt|gt|amp|#\d+|#x[\da-f]+);/gi, (entity) => {
    const known: Record<string, string> = { "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" };
    if (known[entity]) return known[entity];
    const code = entity[2].toLowerCase() === "x" ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
  // 로그·CDATA 안에 XML처럼 생긴 문자열이 있어도 결과로 인식하지 않는다.
  const body = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const cases: { name: string; status: CaseStatus }[] = [];
  for (const match of body.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase\s*>)/g)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1], decode(m[2] ?? m[3])]));
    const content = match[2] ?? "";
    const status: CaseStatus = /<(?:failure|error)\b/.test(content) ? "failed"
      : /<skipped\b/.test(content) || /^(?:skipped|disabled|notrun)$/i.test(attrs.status ?? "") ? "skipped" : "passed";
    cases.push({ name: attrs.name ?? "", status });
  }
  return cases;
}

/** JUnit 계열 결과 중 이름에 TC id 가 있는 것만 읽는다. */
export function parseJUnitResults(xml: string): CaseResult[] {
  const results: CaseResult[] = [];
  for (const entry of scanJUnitCases(xml)) {
    for (const id of new Set(entry.name.match(TC_ID) ?? [])) results.push({ id, status: entry.status, format: "JUnit XML" });
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
