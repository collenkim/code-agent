import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { parseJUnitResults } from "./testResults";

/** 기존 러너가 생성한 표준 보고서만 수집한다. 명령·도구·설정을 바꾸지 않는다. */
export function reportSnapshot(root: string): Map<string, string> {
  const reports = new Map<string, string>();
  let visited = 0;
  function walk(relative: string, depth: number) {
    if (depth > 12 || visited > 20000) return;
    const dir = join(root, relative);
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++visited > 20000) break;
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

export function freshTestReports(root: string, before: Map<string, string>): string {
  const lines: string[] = [];
  for (const [file, fingerprint] of reportSnapshot(root)) {
    if (before.get(file) === fingerprint) continue;
    for (const result of parseJUnitResults(readFileSync(join(root, file), "utf8"))) {
      lines.push(JSON.stringify({ type: "code-agent-test", id: result.id, status: result.status, report: file }));
    }
  }
  return lines.join("\n");
}
