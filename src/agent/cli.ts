#!/usr/bin/env node
import { readFileSync } from "fs";

import { abort, context, decide, next, start, status, Stop, submitPlan } from "./commands";
import { runHook } from "./hook";
import { init } from "./init";
import { findRepoRoot } from "./layout";

const USAGE = `code-agent — Claude Code 위에서 도는 코드 작성 에이전트

사람 (터미널):
  code-agent init [--cli <path>]      이 저장소에 설치 (.claude/ 스킬·에이전트·hook, CLAUDE.md 블록)
  code-agent status                   문서·작업·스테이지·질문·승인 상태
  code-agent approve                  제출된 계획 승인 (TTY 에서만)
  code-agent reject --comment <사유>  제출된 계획 반려 (TTY 에서만)
  code-agent abort                    진행 중인 작업 커서 지우기

스킬이 부른다 (Claude Code 안):
  code-agent start <지시서> [--target <대상>] [--base <기준 브랜치>]
  code-agent next                     게이트를 확인하고 다음 스테이지·단계로
  code-agent context                  지금 스테이지에 필요한 것 (참조 코드·계획·규칙)
  code-agent plan submit <초안.json>  계획 검사 후 제출

hook 이 부른다:
  code-agent hook                     PreToolUse 판정 (stdin JSON)`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(argv: string[]): number {
  const [command, ...args] = argv;
  if (command === "hook") {
    return runHook(readFileSync(0, "utf-8"));
  }

  const repoRoot = findRepoRoot(process.cwd());
  const print = (text: string) => process.stdout.write(`${text}\n`);
  switch (command) {
    case "init":
      print(init(repoRoot, { cli: option(args, "cli") }));
      return 0;
    case "status":
      print(status(repoRoot));
      return 0;
    case "start":
      if (!args[0] || args[0].startsWith("--")) {
        throw new Stop("지시서 경로가 필요합니다: code-agent start <지시서>");
      }
      print(start(repoRoot, args[0], { target: option(args, "target"), base: option(args, "base") }));
      return 0;
    case "next":
      print(next(repoRoot));
      return 0;
    case "context":
      print(context(repoRoot));
      return 0;
    case "plan":
      if (args[0] !== "submit" || !args[1]) {
        throw new Stop("사용법: code-agent plan submit <초안.json>");
      }
      print(submitPlan(repoRoot, args[1]));
      return 0;
    case "approve":
      print(decide(repoRoot, "approved", option(args, "comment")));
      return 0;
    case "reject":
      print(decide(repoRoot, "rejected", option(args, "comment")));
      return 0;
    case "abort":
      print(abort(repoRoot));
      return 0;
    default:
      print(USAGE);
      return command === undefined || command === "help" || command === "--help" ? 0 : 1;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof Stop ? 1 : 2;
}
