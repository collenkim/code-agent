import { existsSync, readFileSync, realpathSync } from "fs";
import { basename, dirname, join, relative, resolve, sep } from "path";

import { hashManifest, hashPlan } from "../core/approval";
import { stripBlock } from "./blocks";
import { crossChild } from "./crossEnv";
import { agentName, withNotation } from "./hostText";
import { effectiveReviewer, materializeReviewers, REVIEWER_ID, reviewersOf, reviewerState, reviewResultProblems, type ReviewerRun } from "./crossRecord";
import { planPaths, treeHashNow } from "./evidence";
import { findRepoRoot } from "./layout";
import { grantScope, LIMITS, limitOf, subagentExit, TIMING } from "./retryPolicy";
import { loadReview, mutateReview, normalizeFindings, REVIEW_BLOCK, reviewDocFile, type ReviewLog, type ReviewRound } from "./review";
import { loadWork } from "./work";

export interface ReviewHookInput {
  cwd?: string;
  hook_event_name?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  transcript_path?: string;
  agent_transcript_path?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
}

/** 결과까지 기록한 뒤의 실패 — 담당이 다시 멈춰도 바뀌는 것이 없다 */
export class RecordedFailure extends Error {}

/** 결과를 게이트에 쓰지 않는 실행의 완료 이벤트 문구 */
const IGNORED: Record<NonNullable<ReviewerRun["ignored"]>["reason"], string> = {
  "completed-round": "이 회차의 리뷰는 이미 기록했습니다 — 같은 회차의 재호출 결과는 게이트에 쓰지 않습니다. 다시 리뷰하려면 고친 뒤 새 회차를 엽니다.",
  concurrent: "같은 회차에 먼저 시작한 리뷰어가 실행 중이었습니다 — 이 결과는 게이트에 쓰지 않습니다. 리뷰어는 한 번에 하나만 부릅니다.",
  orphaned: `${Math.round(TIMING.reviewerOrphanMs / 60_000)}분 넘게 끝나지 않아 멈춘 실행으로 처리한 리뷰어입니다 — 이 결과는 게이트에 쓰지 않습니다.`,
  "run-limit": "리뷰어 호출 한도를 넘긴 실행입니다 — 결과를 쓰지 않았습니다.",
};

/** 끝나지 않은 실행 — 완료·형식 오류 기록·무시된 실행의 결과가 없다 */
const open = (run: ReviewerRun): boolean => !run.completedAt && !run.failure && run.ignored?.result === undefined;

/** 리뷰어 보고 — 최근 Claude 는 최종 문장 대신 SubagentHandback 으로 넘길 수 있다. 이 실행(startedAt 뒤)의 것만 본다 */
function reviewerReport(input: ReviewHookInput, repoRoot: string, startedAt: string): string {
  let result = input.last_assistant_message ?? "";
  if (!input.agent_transcript_path) return result;
  if (!input.transcript_path || !/^[\w-]+$/.test(input.agent_id ?? "")) throw new Error("리뷰 transcript 경로가 유효하지 않습니다.");
  const expected = resolve(dirname(input.transcript_path), basename(input.transcript_path, ".jsonl"), "subagents", `agent-${input.agent_id}.jsonl`);
  const actual = resolve(input.agent_transcript_path);
  if (actual !== expected || !existsSync(actual)) throw new Error("리뷰 transcript가 해당 세션의 하위 에이전트 기록이 아닙니다.");
  const inside = relative(realpathSync(repoRoot), realpathSync(actual));
  if (!inside.startsWith(`..${sep}`) && inside !== ".." && !/^[A-Za-z]:/.test(inside)) throw new Error("저장소 안의 파일은 리뷰 실행 기록으로 사용할 수 없습니다.");
  for (const line of readFileSync(actual, "utf-8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    // Resumed agents keep older handbacks in the same transcript. Only this invocation counts.
    if (typeof entry.timestamp !== "string" || !(Date.parse(entry.timestamp) >= Date.parse(startedAt))) continue;
    if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content) {
      if (block.type === "tool_use" && block.name === "SubagentHandback" && typeof block.input?.message === "string") result = block.input.message;
    }
  }
  return result;
}

/**
 * Runtime lifecycle events are the trust boundary; this command is not model-callable.
 *
 * 회차마다 리뷰어 실행을 append-only 로 기록한다. 한 회차에 받아들인(무시되지 않은) 끝나지 않은 실행은 많아야 하나다 —
 * 완료된 회차의 새 Start 는 무시 기록, 받아들인 실행이 끝나지 않았으면 동시 호출로 무시(15분 넘으면 고아로 보고 새 호출을 받는다),
 * 호출 한도를 넘긴 Start 도 무시 기록이다. 결과는 기록 **전에** 표 규칙(reviewResultProblems)으로 검사한다 — Claude 는 같은 담당에게
 * 한 번 돌려보내고, 그다음(Codex 는 바로) 형식 오류로 기록한다. 모든 기록은 mutateReview 잠금 안에서 다시 읽은 회차에 한다.
 */
export function observeReviewer(input: ReviewHookInput, projectDir?: string, host: "claude" | "codex" = "claude"): void {
  if (input.agent_type !== "ca-reviewer") return;
  if (!["SubagentStart", "SubagentStop"].includes(input.hook_event_name ?? "")) return;
  const repoRoot = findRepoRoot(projectDir ?? input.cwd ?? process.cwd());
  const work = loadWork(repoRoot);
  if (!work || work.active.phase !== "review" || !work.plan) return;
  const { id, target } = work.active;
  const before = loadReview(repoRoot, id, target);
  const opened = before?.rounds.at(-1);
  if (!before || !opened) throw new Error("code-agent review로 회차를 먼저 여세요.");
  if (!input.session_id || !input.agent_id) throw new Error("리뷰어 세션·agent id가 없습니다.");
  if (opened.treeHash !== treeHashNow(work) || opened.planHash !== hashPlan(work.plan) ||
      opened.manifestHash !== hashManifest(work.manifest) || opened.baseCommit !== work.active.baseCommit) {
    throw new Error("리뷰 도중 코드·계획·경계가 바뀌었습니다. check · test 뒤 새 리뷰 회차를 여세요.");
  }
  const planned = planPaths(work);
  const session = input.session_id, agent = input.agent_id;
  /** 잠금 안에서 다시 읽은 기록의 같은 회차 — 그 사이 새 회차가 열렸으면 이 실행은 그 회차의 것이 아니다 */
  const sameRound = (log: ReviewLog | undefined): { log: ReviewLog; last: ReviewRound; runs: ReviewerRun[] } => {
    const last = log?.rounds.at(-1);
    if (!log || !last || last.round !== opened.round || last.at !== opened.at) throw new Error(`리뷰 도중 회차가 바뀌었습니다 — 새 회차에서 ${agentName("ca-reviewer")} 를 다시 호출하세요.`);
    return { log, last, runs: materializeReviewers(last, planned) };
  };
  const runLimit = (log: ReviewLog, round: number) => limitOf("reviewerRuns", LIMITS.reviewerRuns, log.grants ?? [], grantScope({ file: "review", key: "reviewerRuns", round }));

  if (input.hook_event_name === "SubagentStart") {
    mutateReview(repoRoot, id, target, (current) => {
      const { log, last, runs } = sameRound(current);
      const mine = runs.filter((run) => run.sessionId === session && run.agentId === agent);
      // 같은 실행의 중복 이벤트 — 아무것도 하지 않는다
      if (mine.some(open)) return { value: undefined };
      const now = Date.now(), at = new Date(now).toISOString();
      const entry: ReviewerRun = { sessionId: session, agentId: agent, startedAt: at, host, ...(mine.length ? { resumed: true } : {}) };
      if (effectiveReviewer(last, planned)) {
        runs.push({ ...entry, ignored: { at, reason: "completed-round" } });
        return { log, value: undefined };
      }
      const running = runs.find((run) => !run.ignored && !run.failure && !run.completedAt);
      if (running) {
        // 먼저 **시작한** 실행만 결과가 된다 — 병렬로 불러 빨리 끝난 결과를 고르는 재굴림을 닫는다
        if (now - Date.parse(running.startedAt) <= TIMING.reviewerOrphanMs) {
          runs.push({ ...entry, ignored: { at, reason: "concurrent" } });
          return { log, value: undefined };
        }
        running.ignored = { at, reason: "orphaned" };
      }
      if (reviewerState(last, planned, now).runs >= runLimit(log, last.round)) {
        runs.push({ ...entry, ignored: { at, reason: "run-limit" } });
        return { log, value: undefined };
      }
      runs.push(entry);
      return { log, value: undefined };
    }, { hook: true });
    return;
  }

  // 완료 — 보고 읽기는 잠금 밖에서(transcript 는 그 실행의 시작 시각 뒤만 본다)
  const candidates = reviewersOf(opened).filter((run) => run.sessionId === session && run.agentId === agent);
  const started = [...candidates].reverse().find(open) ?? candidates.at(-1);
  if (!started) throw new Error("이 회차에서 시작한 리뷰어의 완료 이벤트가 아닙니다.");
  const report = reviewerReport(input, repoRoot, started.startedAt);
  const body = normalizeFindings(report.replace(/^##\s*지적\s*\n/, ""));
  const problems = reviewResultProblems(body, planned, REVIEWER_ID);
  const docPath = join(repoRoot, reviewDocFile(id));
  let section: string | undefined;
  const outcome = mutateReview<{ error?: Error; recorded?: string }>(repoRoot, id, target, (current) => {
    const { log, last, runs } = sameRound(current);
    const mine = runs.filter((run) => run.sessionId === session && run.agentId === agent);
    const run = [...mine].reverse().find(open) ?? mine.at(-1);
    if (!run) return { value: { error: new Error("이 회차에서 시작한 리뷰어의 완료 이벤트가 아닙니다.") } };
    const at = new Date().toISOString();
    if (run.ignored) {
      if (run.ignored.result !== undefined) return { value: { recorded: IGNORED[run.ignored.reason] } };
      run.ignored.result = report.slice(0, 2000);
      return { log, value: { recorded: IGNORED[run.ignored.reason] } };
    }
    if (run.completedAt) return { value: { recorded: "이 리뷰어의 결과는 이미 기록했습니다." } };
    if (run.failure) return { value: { recorded: `이 리뷰어의 실행은 형식 오류로 기록했습니다 — ${agentName("ca-reviewer")} 를 새로 호출하세요.` } };
    if (problems.length) {
      // 같은 회차 재리뷰가 막혀 있으므로 표 규칙은 기록 전에 본다 — Claude 는 같은 담당이 형식만 고치게 한 번 돌려보낸다
      if (host === "claude" && input.stop_hook_active !== true && (run.returns ?? 0) < LIMITS.agentReturn) {
        run.returns = (run.returns ?? 0) + 1;
        return { log, value: { error: new ReturnToReviewer(`리뷰 결과는 지적 표 또는 '- 없음'이어야 하고 표 규칙을 지켜야 합니다 — 같은 리뷰어가 형식만 고쳐 다시 반환하세요(1회): ${problems.slice(0, 3).join(" · ")}`) } };
      }
      run.failure = { class: "agent-format-error", at, detail: problems.join(" · ").slice(0, 300), raw: report.slice(0, 2000) };
      const left = Math.max(0, runLimit(log, last.round) - reviewerState(last, planned).runs);
      return { log, value: { recorded: `리뷰 결과 형식 오류를 기록했습니다(${problems[0]}) — ${agentName("ca-reviewer")} 를 새로 호출하세요(이 회차 남은 호출 ${left}회).` } };
    }
    run.result = body;
    run.completedAt = at;
    const text = existsSync(docPath) ? stripBlock(readFileSync(docPath, "utf-8"), REVIEW_BLOCK) : "";
    if (!/^## 지적\s*$/m.test(text)) return { log, value: { recorded: "리뷰 문서의 ## 지적 절이 없습니다." } };
    section = body;
    return { log, value: {} };
  }, {
    hook: true,
    // `## 지적` 절을 기록으로 다시 쓴다(회차 구역은 mutateReview 가 다시 렌더한다)
    document: (text) => section === undefined ? text
      : stripBlock(text, REVIEW_BLOCK).replace(/(^## 지적[^\S\n]*\n)[\s\S]*?(?=^## |$(?![\s\S]))/m, (_, heading: string) => `${heading}\n${section}\n\n`),
  });
  if (outcome.error) throw outcome.error;
  if (outcome.recorded) throw new RecordedFailure(outcome.recorded);
}

/** 기록 전에 같은 리뷰어에게 형식만 고치게 돌려보내는 실패(agent-format-error) — 그 밖의 예외는 hook 판정 실패다 */
export class ReturnToReviewer extends Error {}

/**
 * 완료(SubagentStop) 판정이 기록 전에 실패했을 때(리뷰 도중 트리·계획 변경, transcript 문제 등 — 담당이 고칠 수 없다) 그 실행에
 * hook 판정 실패를 기록한다. 기록하지 않으면 실행이 끝나지 않은 채 남아 게이트가 고아 기한까지 "실행 중" 을 낸다. 기록하면 true.
 */
function recordHookFailure(input: ReviewHookInput, projectDir: string | undefined, detail: string): boolean {
  if (input.hook_event_name !== "SubagentStop" || input.agent_type !== "ca-reviewer" || !input.session_id || !input.agent_id) return false;
  try {
    const repoRoot = findRepoRoot(projectDir ?? input.cwd ?? process.cwd());
    const work = loadWork(repoRoot);
    if (!work || work.active.phase !== "review" || !work.plan) return false;
    const planned = planPaths(work);
    return mutateReview(repoRoot, work.active.id, work.active.target, (current) => {
      const last = current?.rounds.at(-1);
      if (!current || !last) return { value: false };
      const runs = materializeReviewers(last, planned);
      const run = [...runs].reverse().find((item) => item.sessionId === input.session_id && item.agentId === input.agent_id && open(item));
      if (!run || run.ignored) return { value: false };
      run.failure = { class: "hook-failure", at: new Date().toISOString(), detail: detail.replace(/\s+/g, " ").slice(0, 300) };
      return { log: current, value: true };
    }, { hook: true });
  } catch { return false; }
}

export function runReviewHook(stdin: string): number {
  // 교차 실행이 띄운 다른 호스트 안에서는 리뷰어 기록을 하지 않는다
  if (crossChild()) return 0;
  let input: ReviewHookInput | undefined;
  try {
    input = JSON.parse(stdin) as ReviewHookInput;
    withNotation("claude", () => observeReviewer(input!, process.env.CLAUDE_PROJECT_DIR, "claude"));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`code-agent review-event: ${message}\n`);
    // 담당이 고칠 수 없는 판정 실패는 같은 담당에게 되돌리지 않고 그 실행에 기록한다 — 기록되면 새 호출을 받는다(§6.4 hook 종료 코드)
    const recorded = error instanceof RecordedFailure ||
      (!(error instanceof ReturnToReviewer) && input !== undefined && recordHookFailure(input, process.env.CLAUDE_PROJECT_DIR, message));
    return subagentExit({ host: "claude", event: input?.hook_event_name, stopHookActive: input?.stop_hook_active === true,
      failure: error instanceof ReturnToReviewer ? "agent-format-error" : "hook-failure", recorded });
  }
}
