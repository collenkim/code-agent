import { outsideChanges } from "./evidence";
import { canonical, findRepoRoot, questionsFile, STOP_PHASES, workDocsDir } from "./layout";
import { unansweredQuestions } from "./questions";
import { loadWork } from "./work";

/**
 * Claude Code Stop hook 의 판정 — **턴이 끝날 때 한 번만** 본다.
 *
 * PreToolUse 의 유일한 사각을 덮는다: 빌드 명령·스크립트가 Write/Edit 를 거치지 않고 만든 파일.
 * 그것을 그 턴 안에 알려 줄 수 있는 자리는 여기뿐이다.
 *
 * **절대적인 차단은 여기가 아니다** — `check`·`test`·`next` 가 이미 거부한다. 그래서 판정이
 * 실패해도 막지 않고(exit 0), `stop_hook_active` 면 즉시 통과시킨다. 그 둘이 "정확히 한 번만 막고
 * 놓아 준다" 를 만든다 — 연속 차단 캡에 닿아 울타리가 조용히 꺼지는 일이 없다.
 */
export interface StopHookInput {
  cwd?: string;
  /** 이미 이 hook 때문에 한 번 이어 붙인 턴인가. 참이면 놓아 준다 */
  stop_hook_active?: boolean;
}

export function decideStop(input: StopHookInput, projectDir?: string): string | undefined {
  if (input.stop_hook_active === true) {
    return undefined;
  }
  const repoRoot = canonical(projectDir ?? findRepoRoot(input.cwd ?? process.cwd()));
  const work = loadWork(repoRoot);
  if (!work || !work.active.baseCommit || !STOP_PHASES.includes(work.active.phase)) {
    // code-agent 작업이 아니거나 아직 코드를 쓰는 자리가 아니면 남의 턴에 끼어들지 않는다
    return undefined;
  }

  const outside = outsideChanges(work);
  const open = unansweredQuestions(repoRoot, questionsFile(work.active.id));
  if (outside.length === 0 && open.length === 0) {
    return undefined;
  }
  return [
    ...(outside.length > 0
      ? [
          "승인된 계획 밖의 변경이 남아 있습니다 (도구를 거치지 않고 생긴 파일일 수 있습니다):",
          ...outside.map((change) => `  - [${change.status}] ${change.path}`),
          "되돌리거나 사람에게 알리세요. 계획을 넓히려면 재계획·재승인입니다.",
        ]
      : []),
    ...(open.length > 0
      ? [
          `답이 없는 질문이 ${open.length}개 있습니다 (${questionsFile(work.active.id)}):`,
          ...open.map((question) => `  - ${question.title}`),
          `답을 받기 전에는 진행하지 마세요 — 사용자에게 질문을 그대로 전하고 멈춥니다. 작업 폴더는 ${workDocsDir(work.active.id)}/ 입니다.`,
        ]
      : []),
  ].join("\n");
}

/** stdin JSON → stdout JSON. 판정이 실패해도 **막지 않는다** — 고장 난 hook 이 턴을 못 끝내게 하는 것이 더 나쁘다 */
export function runStopHook(stdin: string): number {
  try {
    const reason = decideStop(JSON.parse(stdin) as StopHookInput, process.env.CLAUDE_PROJECT_DIR);
    if (reason) {
      process.stdout.write(JSON.stringify({ decision: "block", reason }));
    }
  } catch (error) {
    process.stderr.write(
      `code-agent stop 이 판정에 실패했습니다 (턴은 막지 않았습니다): ${error instanceof Error ? error.message : error}\n`,
    );
  }
  return 0;
}
