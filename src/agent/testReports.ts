import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { parseJUnitResults, scanJUnitCases } from "./testResults";
import type { CaseStatus } from "./testResults";

const MAX_DEPTH = 12;
const MAX_VISITED = 20000;

/**
 * 보고서 탐색 기록 — 탐색이 상한(2만 항목·깊이 12)에서 끊겼는가, 그리고 새 보고서의 **모든** testcase(TC id 가 없어도).
 * cases 는 환경 분류가 TC 아닌 실패까지 보려고 쓴다 — 보고서 파일로만 결과를 내는 러너(Gradle·Maven)는 콘솔에 실패가 없다.
 */
export interface ReportScan { truncated: boolean; cases: { name: string; status: CaseStatus }[] }

/** 기존 러너가 생성한 표준 보고서만 수집한다. 명령·도구·설정을 바꾸지 않는다. */
export function reportSnapshot(root: string, scan?: ReportScan): Map<string, string> {
  const reports = new Map<string, string>();
  let visited = 0;
  function walk(relative: string, depth: number) {
    if (depth > MAX_DEPTH || visited > MAX_VISITED) {
      if (scan) scan.truncated = true;
      return;
    }
    const dir = join(root, relative);
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++visited > MAX_VISITED) {
        if (scan) scan.truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (![".git", ".code-agent", "node_modules", ".venv", "venv", ".gradle", "__pycache__"].includes(entry.name)) walk(file, depth + 1);
      } else if (entry.isFile() && /(?:^|\/)(?:TEST-[^/]+|junit[^/]*|test-results)\.xml$/i.test(file) || entry.isFile() && /(?:^|\/)(?:test-results|surefire-reports|failsafe-reports)\/.*\.xml$/i.test(file)) {
        const stat = statSync(join(root, file));
        if (stat.size > 8 * 1024 * 1024) continue;
        reports.set(file, `${stat.mtimeMs}:${stat.ctimeMs}:${createHash("sha256").update(readFileSync(join(root, file))).digest("hex")}`);
      }
    }
  }
  walk("", 0);
  return reports;
}

/** 새(지문이 바뀐) 보고서의 TC 결과를 JSONL 로 낸다. scan 을 주면 새 보고서의 모든 testcase 와 탐색 중단을 거기 남긴다 */
export function freshTestReports(root: string, before: Map<string, string>, scan?: ReportScan): string {
  const lines: string[] = [];
  for (const [file, fingerprint] of reportSnapshot(root, scan)) {
    if (before.get(file) === fingerprint) continue;
    const text = readFileSync(join(root, file), "utf8");
    if (scan) scan.cases.push(...scanJUnitCases(text));
    for (const result of parseJUnitResults(text)) {
      lines.push(JSON.stringify({ type: "code-agent-test", id: result.id, status: result.status, report: file }));
    }
  }
  return lines.join("\n");
}
