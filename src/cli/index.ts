#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { buildDryRunPreviews, formatDryRunReport } from "../core/dryRun";
import { MANIFEST_FILE } from "../core/manifest";
import { emitPrompt, ingestResponse, parsePromptTarget } from "../core/manualRun";
import { formatPlan } from "../core/plan";
import { runBuild } from "../core/run";
import { loadSession, questionsPath, SESSION_DIR, summarizeSession } from "../core/session";
import { loadPlan } from "../core/state";
import { applyResponse, hasPlan, nextPrompt } from "../core/turn";
import type { BuildContext, BuildOutcome } from "../core/types";
import { serve } from "../server/http";

const USAGE =
  "사용법: code-agent <명령> --repo <대상저장소> --templates <템플릿디렉토리>\n" +
  `\n템플릿 디렉토리에는 ${MANIFEST_FILE} 이 있어야 합니다 — 도메인 경로·계층·단계·검증 명령을\n` +
  "그 프로젝트가 선언하는 파일입니다. 에이전트는 언어·프레임워크를 가정하지 않습니다.\n" +
  "\n명령 (수동 모드 — API 미사용):\n" +
  "  serve                로컬 서버와 화면을 띄운다 (--port, --host, --state)\n" +
  "  next                 지금 붙여넣을 프롬프트를 표준출력으로\n" +
  "  apply <응답파일>      응답을 실행하고 다음 프롬프트를 준비\n" +
  "  status               지금 무엇을 할 차례인지\n" +
  "  log                  턴 기록 — 몇 번 만에 됐는지, 어디서 막혔는지\n" +
  "\n  예)  code-agent next --repo … --templates … --spec 요구사항.md > p.txt\n" +
  "       code-agent apply answer.txt --repo … --templates …\n" +
  "\n  --spec 은 계획을 세울 때 한 번만 필요합니다. 이후에는 세션이 기억합니다.\n" +
  "\n단계 지정 방식 (예전 방식 — JSON 응답):\n" +
  "  --step <plan|단계키|gate:단계키> --emit-prompt\n" +
  "  --step <plan|단계키|gate:단계키> --ingest <응답파일>\n" +
  "\n선택 옵션:\n" +
  `  --conventions <파일|디렉토리>   ${MANIFEST_FILE} 의 conventions 선언을 덮어씀\n` +
  `  --reference <참조도메인>        ${MANIFEST_FILE} 의 referenceDomain 을 덮어씀\n` +
  "  --out <출력디렉토리>            기본 ./out\n" +
  "  --policy <생성범위정책>         모든 단계에 공통 주입\n" +
  "  --no-gate                      단계별 자가검증 생략\n" +
  "\n자동 모드 (API 사용):\n" +
  "  --plan-only · --stages · --retries · --build · --test · --force · --dry-run";

/** `--spec a.md --spec b.md` 처럼 반복되는 옵션이 있어 값을 배열로 모은다. */
function parseArgs(argv: string[]): Record<string, string[]> {
  const args: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) {
      continue;
    }
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = [...(args[key] ?? []), next];
      i += 1;
    } else {
      args[key] = [...(args[key] ?? []), "true"];
    }
  }
  return args;
}

function first(args: Record<string, string[]>, key: string): string | undefined {
  return args[key]?.[0];
}

function printStages(outcome: BuildOutcome) {
  for (const stage of outcome.stages) {
    const attempts = stage.attempts > 1 ? ` (시도 ${stage.attempts}회)` : "";
    console.log(`\n## ${stage.stage}${attempts}`);

    for (const file of stage.files) {
      console.log(`  ${file.path}${file.note ? `\n    note: ${file.note}` : ""}`);
    }
    if (stage.files.length === 0) {
      console.log("  (생성된 파일 없음)");
    }

    if (stage.gate && !stage.gate.passed) {
      console.log(`  ⚠ 자가검증 미통과 — 남은 위반 ${stage.gate.violations.length}건`);
      for (const violation of stage.gate.violations) {
        console.log(`    [${violation.item}] ${violation.file}: ${violation.detail}`);
      }
    }
  }
}

/** 다음에 붙여넣을 프롬프트를 늘 같은 자리에 둔다 — 사람이 찾아 헤매지 않게. */
function stashPrompt(outDir: string, prompt: string): string {
  const path = join(outDir, SESSION_DIR, "prompt.txt");
  mkdirSync(join(outDir, SESSION_DIR), { recursive: true });
  writeFileSync(path, prompt, "utf-8");
  return path;
}

/** 스펙은 계획을 세울 때만 필요하다. 그 뒤로는 세션이 기억하므로 다시 묻지 않는다. */
function requireSpecForPlan(context: BuildContext) {
  if (hasPlan(context.outDir) || context.specPaths.length > 0) {
    return;
  }
  if (loadSession(context.outDir).specPaths.length > 0) {
    return;
  }
  throw new Error(
    "계획을 세우려면 --spec 이 필요합니다 (요구사항·데이터 정의 문서).\n" +
      "한 번만 주면 이후 단계에서는 세션이 기억합니다.",
  );
}

function runNext(context: BuildContext) {
  requireSpecForPlan(context);
  const next = nextPrompt(context);

  if (!next.prompt) {
    console.error(`## ${next.label}\n${next.message ?? ""}`);
    return;
  }

  const stashed = stashPrompt(context.outDir, next.prompt);
  // 프롬프트만 표준출력으로 — 파이프·리다이렉트로 바로 쓸 수 있게 다른 출력을 섞지 않는다.
  process.stdout.write(next.prompt);
  console.error(`\n\n[${next.label}] 이 프롬프트는 ${stashed} 에도 저장했습니다.`);
}

function runApply(context: BuildContext, responsePath: string) {
  requireSpecForPlan(context);
  const outcome = applyResponse(context, readFileSync(responsePath, "utf-8"));

  console.log(`## ${outcome.label}`);

  if (outcome.parseErrors.length > 0) {
    console.log("\n응답 형식 오류 — 아무것도 반영하지 않았습니다:");
    for (const error of outcome.parseErrors) {
      console.log(`  - ${error}`);
    }
  }

  if (outcome.planSaved) {
    console.log(`계획 저장: ${outcome.planSaved}\n`);
    console.log(formatPlan(loadPlan(context.outDir)));
  }

  const execution = outcome.execution;
  if (execution) {
    for (const path of execution.writtenFiles) {
      console.log(`  + ${path}`);
    }
    for (const observation of execution.observations) {
      console.log(`  ? ${observation.label}`);
    }
    for (const note of execution.notes) {
      console.log(`  note: ${note}`);
    }
  }

  if (outcome.violations.length > 0) {
    console.log(`\n위반 ${outcome.violations.length}건`);
    for (const violation of outcome.violations) {
      console.log(`  [${violation.item}] ${violation.file}: ${violation.detail}`);
    }
  }

  if (outcome.questionsAdded > 0) {
    console.log(`\n질문 ${outcome.questionsAdded}건 — ${questionsPath(context.outDir)}`);
  }

  if (outcome.message) {
    console.log(`\n${outcome.message}`);
  }

  const next = nextPrompt(context);
  if (next.prompt) {
    console.log(`\n다음: [${next.label}] → ${stashPrompt(context.outDir, next.prompt)}`);
  } else {
    console.log(`\n${next.message ?? ""}`);
  }
}

function runStatus(context: BuildContext) {
  const session = loadSession(context.outDir);
  const next = nextPrompt(context);

  console.log(`## 지금 할 차례: ${next.label}`);
  console.log(`턴 ${session.turn} · 끝난 단계 ${session.completedStages.length}개`);
  if (session.completedStages.length > 0) {
    console.log(`  완료: ${session.completedStages.join(", ")}`);
  }
  if (next.message) {
    console.log(`\n${next.message}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : undefined;
  const args = parseArgs(argv);

  // 서버는 특정 저장소에 매이지 않는다 — 작업마다 저장소를 받으므로 --repo 를 요구하지 않는다.
  if (command === "serve") {
    serve({
      port: Number(first(args, "port") ?? 4319),
      host: first(args, "host") ?? "127.0.0.1",
      statePath: first(args, "state") ?? join(".code-agent-server", "jobs.json"),
    });
    return;
  }

  const isIngest = Boolean(first(args, "ingest"));
  const isManaged = command !== undefined;
  // 예전 방식의 --emit-prompt 는 계획이 아직 없을 때만 스펙이 필요하다.
  const needsSpec = !isIngest && !isManaged && !first(args, "step");

  if ((needsSpec && !args.spec) || !first(args, "templates") || !first(args, "repo")) {
    console.error(USAGE);
    process.exit(1);
  }

  const context: BuildContext = {
    specPaths: args.spec ?? [],
    conventionsPaths: args.conventions,
    templatesDir: first(args, "templates")!,
    policyPath: first(args, "policy"),
    repoRoot: first(args, "repo")!,
    referenceDomain: first(args, "reference"),
    outDir: first(args, "out") ?? "./out",
    onlyStages: first(args, "stages")?.split(",").map((key) => key.trim()),
    gate: first(args, "no-gate") !== "true",
    // 숫자가 아닌 값이 들어와도 생성 자체는 한 번 돌아야 하므로 0으로 떨어뜨린다
    maxRetries: Math.max(0, Number(first(args, "retries") ?? 1) || 0),
    build: first(args, "build") === "true",
    test: first(args, "test") === "true",
    force: first(args, "force") === "true",
  };

  // ---- 상태가 이끄는 수동 모드 ----

  if (command === "next") {
    runNext(context);
    return;
  }
  if (command === "apply") {
    const responsePath = argv[1];
    if (!responsePath || responsePath.startsWith("--")) {
      console.error("apply 에는 응답 파일 경로가 필요합니다: code-agent apply answer.txt --repo …");
      process.exit(1);
    }
    runApply(context, responsePath);
    return;
  }
  if (command === "status") {
    runStatus(context);
    return;
  }
  if (command === "log") {
    console.log(summarizeSession(loadSession(context.outDir)));
    return;
  }
  if (command) {
    console.error(`알 수 없는 명령: ${command}\n\n${USAGE}`);
    process.exit(1);
  }

  // ---- 단계를 직접 지정하는 방식 ----

  const step = first(args, "step");

  if (first(args, "emit-prompt") === "true") {
    if (!step) {
      console.error("--emit-prompt 에는 --step <plan|단계키|gate:단계키> 가 필요합니다.");
      process.exit(1);
    }
    process.stdout.write(emitPrompt(context, parsePromptTarget(step)));
    return;
  }

  if (isIngest) {
    if (!step) {
      console.error("--ingest 에는 --step <plan|단계키|gate:단계키> 가 필요합니다.");
      process.exit(1);
    }
    const result = ingestResponse(context, parsePromptTarget(step), first(args, "ingest")!);

    if (result.planPath) {
      console.log(`계획 저장: ${result.planPath}\n`);
      console.log(formatPlan(loadPlan(context.outDir)));
      return;
    }
    if (result.target.kind === "gate") {
      console.log(`## 검수 결과 — 위반 ${result.violations.length}건`);
      for (const violation of result.violations) {
        console.log(`  [${violation.item}] ${violation.file}: ${violation.detail}`);
      }
      return;
    }

    console.log(`## ${result.target.kind === "stage" ? result.target.key : ""} — ${result.writtenFiles.length}개 생성`);
    for (const path of result.writtenFiles) {
      console.log(`  ${path}`);
    }
    if (result.violations.length > 0) {
      console.log(`\n⚠ 코드 검사 위반 ${result.violations.length}건`);
      for (const violation of result.violations) {
        console.log(`  [${violation.item}] ${violation.file}: ${violation.detail}`);
      }
    }
    return;
  }

  // ---- API 모드 ----

  if (first(args, "dry-run") === "true") {
    console.log(formatDryRunReport(buildDryRunPreviews(context)));
    console.log("\n(API 호출 없음 — 위 프롬프트를 claude.ai 등에 직접 붙여넣어 확인하세요.)");
    return;
  }

  if (first(args, "plan-only") === "true") {
    // 계획만 뽑아 사람이 검토하는 용도 — 생성 단계는 돌리지 않는다.
    const planned = await runBuild({ ...context, planOnly: true });
    console.log(`컨벤션 문서: ${planned.conventionsSource}\n`);
    console.log(formatPlan(planned.plan));
    return;
  }

  const outcome = await runBuild(context);
  console.log(`컨벤션 문서: ${outcome.conventionsSource}\n`);
  console.log(formatPlan(outcome.plan));

  if (outcome.stages.length === 0) {
    console.log(
      "\n미결 질문이 남아 생성을 중단했습니다. 스펙을 보완하거나 --force 로 강행하세요.",
    );
    return;
  }

  printStages(outcome);
  console.log(`\n생성 결과: ${context.outDir}`);

  if (outcome.build) {
    console.log(`\n## 빌드 ${outcome.build.passed ? "통과" : "실패"}\n${outcome.build.log}`);
  }

  if (outcome.test) {
    console.log(`\n## 테스트 ${outcome.test.passed ? "통과" : "실패"}\n${outcome.test.log}`);
    if (!outcome.test.passed) {
      console.log(
        "\n테스트 실패는 자동으로 고치지 않습니다 — 테스트가 틀렸는지 코드가 틀렸는지는 " +
          "사람이 판단해야 합니다. 통과시키려고 단언을 지우지 마세요.",
      );
    }
  }

  if (outcome.build?.passed === false || outcome.test?.passed === false) {
    process.exit(1);
  }
}

main().catch((err) => {
  // 대부분 경로 오타·설정 오타 같은 사용자 실수라 메시지만 보여준다.
  // 스택이 필요하면 CODE_AGENT_DEBUG=1로 실행.
  console.error(
    process.env.CODE_AGENT_DEBUG ? err : `오류: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
