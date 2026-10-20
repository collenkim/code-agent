import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { crossReview } from "../agent/crossCheck";
import { crossAttemptsOf, effectiveReviewer } from "../agent/crossRecord";
import { planPaths } from "../agent/evidence";
import { loadActive } from "../agent/layout";
import { crossPointState } from "../agent/retryPolicy";
import { crossRequired, findingsBody, loadReview, normalizeFindings, reviewDocFile } from "../agent/review";
import { observeReviewer } from "../agent/reviewHook";
import { codexHook } from "../agent/codexHook";
import type { Host } from "../agent/hosts";
import { loadWork } from "../agent/work";

/** 호스트 판별 표지(CLAUDECODE·Codex 표지·교차 자식 표지)를 지운 뒤 지정한 호스트의 표지만 두고 실행한다 — 테스트를 어느 호스트 안에서 돌려도 같게 */
export const CALLER_KEYS = ["CLAUDECODE", "CODEX_CI", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_THREAD_ID", "CODE_AGENT_CROSS"] as const;
export function withCaller<T>(host: Host | undefined, run: () => T): T {
  const restore = setCaller(host);
  let result: T;
  try { result = run(); } catch (error) { restore(); throw error; }
  // 비동기 흐름은 끝난 뒤에 되돌린다
  if (result instanceof Promise) return result.finally(restore) as T;
  restore();
  return result;
}
/** withCaller 의 beforeEach·afterEach 꼴 — 표지를 정하고, 되돌리는 함수를 돌려준다 */
export function setCaller(host: Host | undefined): () => void {
  const saved = Object.fromEntries(CALLER_KEYS.map((key) => [key, process.env[key]]));
  for (const key of CALLER_KEYS) delete process.env[key];
  if (host === "claude") process.env.CLAUDECODE = "1";
  else if (host === "codex") process.env.CODEX_CI = "1";
  return () => {
    for (const key of CALLER_KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  };
}

/**
 * Lifecycle transport fixture, not a real model review. Negative tests omit this deliberately.
 * 마지막 회차에 유효한 리뷰어 결과가 있으면 리뷰어 단계를 건너뛰고, 교차 지점이 완료·중지면 교차도 건너뛴다(같은 회차는 다시 기록되지 않는다).
 */
export function recordReviewFixture(repo: string, host: Host = "claude", options: { cross?: boolean } = {}): void {
  const active = loadActive(repo)!;
  const last = loadReview(repo, active.id, active.target)?.rounds.at(-1);
  if (active.phase !== "review" || !last) return;
  const planned = planPaths(loadWork(repo)!);
  if (!effectiveReviewer(last, planned)) {
    const body = normalizeFindings(findingsBody(readFileSync(join(repo, reviewDocFile(active.id)), "utf-8")) ?? "");
    const result = body.includes("| F") ? body : "- 없음";
    const event = { cwd: repo, session_id: "test-session", agent_id: "test-reviewer", agent_type: "ca-reviewer" };
    const observe = host === "codex" ? codexHook : observeReviewer;
    observe({ ...event, hook_event_name: "SubagentStart" });
    observe({ ...event, hook_event_name: "SubagentStop", last_assistant_message: result });
  }
  if (options.cross !== false && crossRequired(repo)) {
    const now = loadReview(repo, active.id, active.target)!.rounds.at(-1)!;
    const state = crossPointState(crossAttemptsOf(now, planned)).state;
    if (state !== "completed" && state !== "stopped") recordCrossFixture(repo, host === "codex" ? "claude" : "codex");
  }
}

/** 두 호스트 프로젝트의 교차 리뷰 전달 fixture — 다른 호스트 실행 파일 자리에 '- 없음' 을 돌려주는 가짜를 둔다 */
function recordCrossFixture(repo: string, by: Host): void {
  const fake = mkdtempSync(join(tmpdir(), "ca-fake-cross-")), script = join(fake, "host.cjs");
  writeFileSync(script, by === "codex"
    ? "const a = process.argv; require('fs').writeFileSync(a[a.indexOf('-o') + 1], '- 없음');\n"
    : "process.stdout.write(JSON.stringify({ result: '- 없음' }));\n");
  const key = by === "codex" ? "CODE_AGENT_CODEX_BIN" : "CODE_AGENT_CLAUDE_BIN", saved = process.env[key];
  process.env[key] = script;
  try { withCaller(by === "codex" ? "claude" : "codex", () => crossReview(repo, by)); }
  finally {
    if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
    rmSync(fake, { recursive: true, force: true });
  }
}
