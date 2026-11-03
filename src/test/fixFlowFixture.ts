import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { next, submitPlan } from "../agent/commands";
import { start } from "./confirmedStart";
import { SRC, REPRO_TEST, KEPT_TEST, STRATEGY, repo, write, git, confirmDocs, approve, newRepo, dropRepo, manifest, FIX_ORDER, FIX_REQ, analysisDoc, CURRENT_OK, FIX_DESIGN, FIX_FUNC, specDoc, FIX_PLAN } from "./kindFlowFixture";

export function setupFixFlow(): void {
  beforeEach(() => {
    newRepo("ca-p6-fix-");
    write("code-agent.json", manifest());
    write(SRC, "function total(items) {\n  // 버그: 더하지 않는다\n  return 0;\n}\nmodule.exports = { total };\n");
    write(KEPT_TEST, "// 기존 테스트\n");
    write("doc/work/FIX-1.md", FIX_ORDER);
    confirmDocs();
    git("add", "-A");
    git("commit", "-qm", "init");
  });
  afterEach(dropRepo);
}

export function useManifest(overrides: Record<string, unknown>, strategy = STRATEGY): void {
  write("code-agent.json", manifest(overrides));
  write("doc/test-strategy.md", strategy);
  confirmDocs();
  git("add", "-A");
  git("commit", "-qm", "manifest");
}

export function writeDocs(current = CURRENT_OK, repro: string | null = "- TC-1"): void {
  write("doc/work/FIX-1/01-requirements.md", FIX_REQ);
  write("doc/work/FIX-1/02-analysis.md", analysisDoc(current));
  write("doc/work/FIX-1/03-design.md", FIX_DESIGN);
  write("doc/work/FIX-1/04-functional.md", FIX_FUNC);
  write("doc/work/FIX-1/07-test-spec.md", specDoc(repro));
}

export function submit(plan: unknown = FIX_PLAN): string {
  write("doc/work/FIX-1/plan.json", JSON.stringify(plan));
  return submitPlan(repo, join(repo, "doc/work/FIX-1/plan.json"));
}

/** 계획 승인까지 마치고 implement 스테이지에 세운다 */
export function toImplement(plan: unknown = FIX_PLAN): void {
  start(repo, join(repo, "doc/work/FIX-1.md"));
  writeDocs();
  next(repo);
  next(repo);
  next(repo);
  submit(plan);
  approve();
  next(repo);
}

export function writeReproTest(body = "// TC-1 재현\n"): void {
  write(REPRO_TEST, body);
}

export function fixSource(): void {
  write(SRC, "function total(items) {\n  // fixed\n  return items.reduce((a, b) => a + b, 0);\n}\nmodule.exports = { total };\n");
}
