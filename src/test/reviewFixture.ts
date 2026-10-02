import { readFileSync } from "fs";
import { join } from "path";
import { loadActive } from "../agent/layout";
import { findingsBody, loadReview, normalizeFindings, reviewDocFile } from "../agent/review";
import { observeReviewer } from "../agent/reviewHook";
import { codexHook } from "../agent/codexHook";
import type { Host } from "../agent/hosts";

/** Lifecycle transport fixture, not a real model review. Negative tests omit this deliberately. */
export function recordReviewFixture(repo: string, host: Host = "claude"): void {
  const active = loadActive(repo)!;
  if (active.phase !== "review" || !loadReview(repo, active.id, active.target)?.rounds.length) return;
  const body = normalizeFindings(findingsBody(readFileSync(join(repo, reviewDocFile(active.id)), "utf-8")) ?? "");
  const result = body.includes("| F") ? body : "- 없음";
  const event = { cwd: repo, session_id: "test-session", agent_id: "test-reviewer", agent_type: "ca-reviewer" };
  const observe = host === "codex" ? codexHook : observeReviewer;
  observe({ ...event, hook_event_name: "SubagentStart" });
  observe({ ...event, hook_event_name: "SubagentStop", last_assistant_message: result });
}
