#!/usr/bin/env node
import { buildDryRunPreviews, formatDryRunReport } from "../core/dryRun";
import { MANIFEST_FILE } from "../core/manifest";
import { formatPlan } from "../core/plan";
import { runBuild } from "../core/run";
import type { BuildContext, BuildOutcome } from "../core/types";

const USAGE =
  "사용법: code-agent --spec <스펙문서> [--spec <추가문서> ...]\n" +
  "                  --repo <대상저장소경로> --templates <템플릿디렉토리>\n" +
  `\n템플릿 디렉토리에는 ${MANIFEST_FILE} 이 있어야 합니다 — 도메인 경로·계층·단계·검증 명령을\n` +
  "그 프로젝트가 선언하는 파일입니다. 에이전트는 언어·프레임워크를 가정하지 않습니다.\n" +
  "\n선택 옵션:\n" +
  `  --conventions <파일|디렉토리>   ${MANIFEST_FILE} 의 conventions 선언을 덮어씀\n` +
  `  --reference <참조도메인>        ${MANIFEST_FILE} 의 referenceDomain 을 덮어씀\n` +
  "  --out <출력디렉토리>            기본 ./out\n" +
  "  --policy <생성범위정책>         모든 단계에 공통 주입\n" +
  "  --stages <키,키>               일부 단계만 실행\n" +
  "  --plan-only                    계획만 만들고 종료\n" +
  "  --no-gate                      단계별 자가검증 생략\n" +
  "  --retries <횟수>               게이트 실패 시 재생성 횟수 (기본 1)\n" +
  `  --build                        ${MANIFEST_FILE} 의 build 명령으로 컴파일 검증\n` +
  `  --test                         ${MANIFEST_FILE} 의 test 명령으로 테스트 실행 (실패는 보고만)\n` +
  "  --force                        미결 질문이 남아도 생성 강행\n" +
  "  --dry-run                      API 호출 없이 프롬프트만 출력";

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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.spec || !first(args, "templates") || !first(args, "repo")) {
    console.error(USAGE);
    process.exit(1);
  }

  const context: BuildContext = {
    specPaths: args.spec,
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
