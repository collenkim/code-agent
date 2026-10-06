import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { crossReview } from "../agent/crossCheck";
import { loadActive } from "../agent/layout";
import { crossRequired, findingsBody, loadReview, normalizeFindings, reviewDocFile } from "../agent/review";
import { observeReviewer } from "../agent/reviewHook";
import { codexHook } from "../agent/codexHook";
import type { Host } from "../agent/hosts";

/** Lifecycle transport fixture, not a real model review. Negative tests omit this deliberately. */
export function recordReviewFixture(repo: string, host: Host = "claude", options: { cross?: boolean } = {}): void {
  const active = loadActive(repo)!;
  if (active.phase !== "review" || !loadReview(repo, active.id, active.target)?.rounds.length) return;
  const body = normalizeFindings(findingsBody(readFileSync(join(repo, reviewDocFile(active.id)), "utf-8")) ?? "");
  const result = body.includes("| F") ? body : "- 없음";
  const event = { cwd: repo, session_id: "test-session", agent_id: "test-reviewer", agent_type: "ca-reviewer" };
  const observe = host === "codex" ? codexHook : observeReviewer;
  observe({ ...event, hook_event_name: "SubagentStart" });
  observe({ ...event, hook_event_name: "SubagentStop", last_assistant_message: result });
  if (options.cross !== false && crossRequired(repo)) recordCrossFixture(repo, host === "codex" ? "claude" : "codex");
}

/** 두 호스트 프로젝트의 교차 리뷰 전달 fixture — 다른 호스트 실행 파일 자리에 '- 없음' 을 돌려주는 가짜를 둔다 */
function recordCrossFixture(repo: string, by: Host): void {
  const fake = mkdtempSync(join(tmpdir(), "ca-fake-cross-")), script = join(fake, "host.cjs");
  writeFileSync(script, by === "codex"
    ? "const a = process.argv; require('fs').writeFileSync(a[a.indexOf('-o') + 1], '- 없음');\n"
    : "process.stdout.write(JSON.stringify({ result: '- 없음' }));\n");
  const key = by === "codex" ? "CODE_AGENT_CODEX_BIN" : "CODE_AGENT_CLAUDE_BIN", saved = process.env[key];
  process.env[key] = script;
  try { crossReview(repo, by); }
  finally {
    if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
    rmSync(fake, { recursive: true, force: true });
  }
}
