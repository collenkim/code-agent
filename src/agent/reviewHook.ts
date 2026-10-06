import { existsSync, readFileSync, realpathSync } from "fs";
import { basename, dirname, join, relative, resolve, sep } from "path";

import { hashManifest, hashPlan } from "../core/approval";
import { writeAtomic } from "../core/atomic";
import { stripBlock, upsertBlock } from "./blocks";
import { treeHashNow } from "./evidence";
import { findRepoRoot } from "./layout";
import { loadReview, normalizeFindings, renderRoundsBlock, REVIEW_BLOCK, reviewDocFile, saveReview } from "./review";
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

/**
 * SubagentStop 의 exit 2 는 담당을 멈추지 못하게 하고 이어서 일하게 한다. 담당이 고칠 수 있는 실패(형식·식별 오류)만
 * 한 번 돌려보내고, 기록이 끝난 실패나 이미 한 번 막힌 재시도(stop_hook_active)는 기록만 남겨 무한 반복을 막는다.
 */
export function subagentExitCode(input: ReviewHookInput | undefined, error: unknown): number {
  return input?.hook_event_name === "SubagentStop" && (error instanceof RecordedFailure || input.stop_hook_active === true) ? 0 : 2;
}

/** Runtime lifecycle events are the trust boundary; this command is not model-callable. */
export function observeReviewer(input: ReviewHookInput, projectDir?: string): void {
  if (input.agent_type !== "ca-reviewer") return;
  if (!["SubagentStart", "SubagentStop"].includes(input.hook_event_name ?? "")) return;
  const repoRoot = findRepoRoot(projectDir ?? input.cwd ?? process.cwd());
  const work = loadWork(repoRoot);
  if (!work || work.active.phase !== "review" || !work.plan) return;
  const log = loadReview(repoRoot, work.active.id, work.active.target);
  const last = log?.rounds.at(-1);
  if (!log || !last) throw new Error("code-agent review로 회차를 먼저 여세요.");
  if (!input.session_id || !input.agent_id) throw new Error("리뷰어 세션·agent id가 없습니다.");
  if (last.treeHash !== treeHashNow(work) || last.planHash !== hashPlan(work.plan) ||
      last.manifestHash !== hashManifest(work.manifest) || last.baseCommit !== work.active.baseCommit) {
    throw new Error("리뷰 도중 코드·계획·경계가 바뀌었습니다. check · test 뒤 새 리뷰 회차를 여세요.");
  }
  if (input.hook_event_name === "SubagentStart") {
    last.reviewer = { sessionId: input.session_id, agentId: input.agent_id, startedAt: new Date().toISOString() };
    saveReview(repoRoot, log);
    return;
  }
  const observer = last.reviewer;
  if (!observer || observer.sessionId !== input.session_id || observer.agentId !== input.agent_id) {
    throw new Error("이 회차에서 시작한 리뷰어의 완료 이벤트가 아닙니다.");
  }
  if (observer.completedAt) throw new RecordedFailure("이 리뷰어의 결과는 이미 기록했습니다.");
  let result = input.last_assistant_message ?? "";
  // New Claude versions can return the report via SubagentHandback rather than final text.
  if (input.agent_transcript_path) {
    if (!input.transcript_path || !/^[\w-]+$/.test(input.agent_id)) throw new Error("리뷰 transcript 경로가 유효하지 않습니다.");
    const expected = resolve(dirname(input.transcript_path), basename(input.transcript_path, ".jsonl"), "subagents", `agent-${input.agent_id}.jsonl`);
    const actual = resolve(input.agent_transcript_path);
    if (actual !== expected || !existsSync(actual)) throw new Error("리뷰 transcript가 해당 세션의 하위 에이전트 기록이 아닙니다.");
    const inside = relative(realpathSync(repoRoot), realpathSync(actual));
    if (!inside.startsWith(`..${sep}`) && inside !== ".." && !/^[A-Za-z]:/.test(inside)) throw new Error("저장소 안의 파일은 리뷰 실행 기록으로 사용할 수 없습니다.");
    for (const line of readFileSync(actual, "utf-8").split("\n").filter(Boolean)) {
      const entry = JSON.parse(line);
      // Resumed agents keep older handbacks in the same transcript. Only this invocation counts.
      if (typeof entry.timestamp !== "string" || !(Date.parse(entry.timestamp) >= Date.parse(observer.startedAt))) continue;
      if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
      for (const block of entry.message.content) {
        if (block.type === "tool_use" && block.name === "SubagentHandback" && typeof block.input?.message === "string") result = block.input.message;
      }
    }
  }
  const body = normalizeFindings(result.replace(/^##\s*지적\s*\n/, ""));
  const rows = body.split("\n");
  if (body !== "- 없음" && !(rows.some((line) => /^\|\s*F\d+\s*\|/.test(line)) && rows.every((line) => /^\|.*\|$/.test(line)))) {
    throw new Error("리뷰 결과는 지적 표 또는 '- 없음'이어야 합니다. ca-reviewer를 다시 호출하세요.");
  }
  observer.result = body;
  observer.completedAt = new Date().toISOString();
  saveReview(repoRoot, log);
  const path = join(repoRoot, reviewDocFile(work.active.id));
  const text = stripBlock(readFileSync(path, "utf-8"), REVIEW_BLOCK);
  if (!/^## 지적\s*$/m.test(text)) throw new RecordedFailure("리뷰 문서의 ## 지적 절이 없습니다.");
  const rendered = text.replace(/(^## 지적[^\S\n]*\n)[\s\S]*?(?=^## |$(?![\s\S]))/m, (_, heading: string) => `${heading}\n${body}\n\n`);
  writeAtomic(path, upsertBlock(rendered, REVIEW_BLOCK, renderRoundsBlock(log)));
}

export function runReviewHook(stdin: string): number {
  let input: ReviewHookInput | undefined;
  try {
    input = JSON.parse(stdin) as ReviewHookInput;
    observeReviewer(input, process.env.CLAUDE_PROJECT_DIR);
    return 0;
  } catch (error) {
    process.stderr.write(`code-agent review-event: ${error instanceof Error ? error.message : error}\n`);
    return subagentExitCode(input, error);
  }
}
