import { existsSync } from "fs";
import { join } from "path";

import { canonical, DOCS_SESSION_FILE, findRepoRoot, workDocsDir } from "./layout";
import { loadRequestSession } from "./request";
import { approvalOf, loadWork } from "./work";

/**
 * SessionStart hook — 대화가 새로 열리거나(startup·resume) 비워지거나(clear) 압축된(compact) 뒤
 * 진행 중인 code-agent 상태를 몇 줄로 붙인다.
 *
 * 상태와 문서는 `.code-agent/`·작업 폴더에 있으므로 이전 대화 없이도 정확히 이어갈 수 있다.
 * 압축 요약이 동의 ID·단계를 잃어도 여기서 다시 잡는다. 진행 중인 것이 없으면 아무것도 붙이지 않는다.
 */
export function sessionAnchor(repoRoot: string): string {
  const work = loadWork(repoRoot);
  if (work) {
    const { active, order } = work;
    return [
      "code-agent 진행 상태 (대화 시작·재개·압축·비우기 뒤 자동으로 붙는 요약)",
      `- 작업 ${order.id} (${order.kind}) · 스테이지 ${active.phase}${active.task ? ` · Task ${active.task}` : ""} · 계획 ${work.plan ? approvalOf(work).status : "미제출"} · 작업 폴더 ${workDocsDir(active.id)}/`,
      "- 이전 대화 내용이 아니라 `code-agent status`와 그 스테이지의 스킬로 이어간다. 사용자가 이어가자고 하면 `/ca-next` 절차를 따른다.",
      "- 동의는 준비한 세션에서만 적용된다. 이전 세션의 동의 ID는 적용하지 말고 필요하면 새로 준비한다.",
    ].join("\n");
  }
  const session = loadRequestSession(repoRoot);
  if (session) {
    return [
      "code-agent 진행 상태 (대화 시작·재개·압축·비우기 뒤 자동으로 붙는 요약)",
      `- 요구사항 접수 중: ${session.id} (${session.kind}) · 작업 폴더 ${workDocsDir(session.id)}/`,
      "- 사용자가 이어가자고 하면 `code-agent status`로 확인하고 `/ca-request`(또는 `/ca-next`) 절차로 이어간다.",
    ].join("\n");
  }
  if (existsSync(join(repoRoot, DOCS_SESSION_FILE))) {
    return [
      "code-agent 진행 상태 (대화 시작·재개·압축·비우기 뒤 자동으로 붙는 요약)",
      "- 공통 문서 준비 세션이 열려 있다. 사용자가 이어가자고 하면 `/ca-docs` 또는 `/ca-adopt` 절차로 이어간다.",
    ].join("\n");
  }
  return "";
}

/** 막지 않는다 — 실패해도 대화 시작을 방해하지 않고 사유만 stderr로 남긴다 */
export function runSessionHook(stdin: string): number {
  try {
    const input = JSON.parse(stdin || "{}") as { cwd?: string };
    const projectDir = process.env.CLAUDE_PROJECT_DIR;
    const text = sessionAnchor(canonical(projectDir ?? findRepoRoot(input.cwd ?? process.cwd())));
    if (text) process.stdout.write(`${text}\n`);
  } catch (error) {
    process.stderr.write(`code-agent session-event: ${error instanceof Error ? error.message : error}\n`);
  }
  return 0;
}
