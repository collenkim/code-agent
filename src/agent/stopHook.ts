import { outsideChanges } from "./evidence";
import { existsSync } from "fs";
import { join } from "path";
import { loadActive, DOCS_SESSION_FILE, REQUEST_SESSION_FILE, findRepoRoot, questionsFile, STOP_PHASES, workDocsDir } from "./layout";
import { openQuestions } from "./answers";
import { loadWork } from "./work";
import { crossChild } from "./crossEnv";
import { askVia, withNotation } from "./hostText";
import { questionPresentationProblem } from "./questionPresentation";
import { blockedBefore, noteHookOutput, reasonKey } from "./hookLog";
import { recordEvent } from "./timeline";

/**
 * Claude Code Stop hook 의 판정 — **턴이 끝날 때 한 번만** 본다.
 *
 * PreToolUse 의 유일한 사각을 덮는다: 빌드 명령·스크립트가 Write/Edit 를 거치지 않고 만든 파일.
 * 그것을 그 턴 안에 알려 줄 수 있는 자리는 여기뿐이다.
 *
 * **절대적인 차단은 여기가 아니다** — `check`·`test`·`next` 가 이미 거부한다. 그래서 판정이
 * 실패해도 막지 않고(exit 0), `stop_hook_active` 면 즉시 통과시킨다. 그 둘이 "정확히 한 번만 막고
 * 놓아 준다" 를 만든다 — 연속 차단 캡에 닿아 울타리가 조용히 꺼지는 일이 없다.
 * 같은 세션에서 같은 사유(글이 같은 차단)로 이미 막았으면 다시 막지 않는다(hookLog 기록) — 상기는 한 번이면 되고, 막을 때마다
 * 모델이 한 턴을 더 돈다. 목록이 바뀌면(새 파일·새 질문) 사유가 달라져 다시 막는다.
 */
export interface StopHookInput {
  cwd?: string;
  session_id?: string;
  /** 이미 이 hook 때문에 한 번 이어 붙인 턴인가. 참이면 놓아 준다 */
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

/** 차단 사유에 싣는 목록 줄 수 — 나머지는 개수만 적는다(빌드 산출물 수백 개가 턴마다 붙지 않게) */
export const STOP_LIST_LIMIT = 10;
const listed = <T>(items: readonly T[], line: (item: T) => string, rest: (count: number) => string): string[] =>
  [...items.slice(0, STOP_LIST_LIMIT).map(line), ...(items.length > STOP_LIST_LIMIT ? [rest(items.length - STOP_LIST_LIMIT)] : [])];

export function decideStop(input: StopHookInput, projectDir?: string, host?: "claude" | "codex"): string | undefined {
  // 하위 폴더에서 연 세션도 저장소 루트로 본다(PreToolUse hook·CLI 와 같은 루트)
  const repoRoot = findRepoRoot(projectDir ?? input.cwd ?? process.cwd());
  const reason = stopReason(input, repoRoot);
  // 턴이 끝난 시각 — 완료 뒤 다음 행동 없이 멈춘 구간(호스트 재개 대기)을 가르는 근거다. 막은 턴은 이어진다
  recordEvent(repoRoot, { type: "host.stopped", ...(host ? { host } : {}), ...(input.session_id ? { session: input.session_id } : {}),
    ...(reason ? { reason: `Stop 차단: ${reason.split("\n")[0]}` } : {}), detail: { blocked: !!reason, continued: input.stop_hook_active === true } });
  return reason;
}

function stopReason(input: StopHookInput, repoRoot: string): string | undefined {
  if (input.stop_hook_active === true) {
    return undefined;
  }
  // 준비·접수·전체 단계에 공통 적용한다. 작업 로딩 전에 검사하여 문서·계획 미완성도 포함한다.
  if (loadActive(repoRoot) || [DOCS_SESSION_FILE, REQUEST_SESSION_FILE].some(file => existsSync(join(repoRoot, file)))) {
    const presentation = questionPresentationProblem(input.last_assistant_message);
    if (presentation) return presentation;
  }
  const work = loadWork(repoRoot);
  if (!work || !work.active.baseCommit || !STOP_PHASES.includes(work.active.phase)) {
    // code-agent 작업이 아니거나 아직 코드를 쓰는 자리가 아니면 남의 턴에 끼어들지 않는다
    return undefined;
  }

  const outside = outsideChanges(work);
  const { unanswered, unverified } = openQuestions(repoRoot, questionsFile(work.active.id));
  const open = [...unanswered, ...unverified];
  if (outside.length === 0 && open.length === 0) {
    return undefined;
  }
  const questions = [
    ...unanswered.map((question) => `  - ${question.title}`),
    ...unverified.map((question) => `  - ${question.title} (답 출처 미확인)`),
  ];
  const reason = [
    ...(outside.length > 0
      ? [
          "승인된 계획 밖의 변경이 남아 있습니다 (도구를 거치지 않고 생긴 파일일 수 있습니다):",
          ...listed(outside, (change) => `  - [${change.status}] ${change.path}`, (count) => `  - 외 ${count}개 — git status 로 확인하세요`),
          "되돌리거나 사람에게 알리세요. 계획을 넓히려면 재계획·재승인입니다.",
        ]
      : []),
    ...(open.length > 0
      ? [
          `답이 없는 질문이 ${open.length}개 있습니다 (${questionsFile(work.active.id)}):`,
          ...listed(questions, (line) => line, (count) => `  - 외 ${count}개`),
          `답을 받기 전에는 진행하지 마세요 — 메인이 ca-answer 공통 절차의 ${askVia()} 답을 받고 기록합니다. 미응답이면 멈춥니다. 작업 폴더는 ${workDocsDir(work.active.id)}/ 입니다.`,
        ]
      : []),
  ].join("\n");
  return blockedBefore(repoRoot, input.session_id, "Stop", reasonKey(reason)) ? undefined : reason;
}

/** stdin JSON → stdout JSON. 판정이 실패해도 **막지 않는다** — 고장 난 hook 이 턴을 못 끝내게 하는 것이 더 나쁘다 */
export function runStopHook(stdin: string): number {
  // 교차 실행이 띄운 다른 호스트 안에서는 진행 판정을 하지 않는다
  if (crossChild()) return 0;
  try {
    const input = JSON.parse(stdin) as StopHookInput;
    const root = findRepoRoot(process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd());
    const reason = withNotation("claude", () => decideStop(input, root, "claude"));
    if (reason) {
      process.stdout.write(JSON.stringify({ decision: "block", reason }));
      noteHookOutput(root, { host: "claude", event: "Stop", kind: "block", text: reason, session: input.session_id });
    }
  } catch (error) {
    process.stderr.write(
      `code-agent stop 이 판정에 실패했습니다 (턴은 막지 않았습니다): ${error instanceof Error ? error.message : error}\n`,
    );
  }
  return 0;
}
