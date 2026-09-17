#!/usr/bin/env node
import { mkdirSync, readFileSync, readSync, writeFileSync } from "fs";
import { join } from "path";

import { buildDryRunPreviews, formatDryRunReport } from "../core/dryRun";
import { MANIFEST_FILE } from "../core/manifest";
import { emitPrompt, ingestResponse, parsePromptTarget } from "../core/manualRun";
import { formatPlan } from "../core/plan";
import { runBuild } from "../core/run";
import { ledgerPath } from "../core/approval";
import type { Decision, Presence } from "../core/approval";
import { loadSession, questionsPath, SESSION_DIR, summarizeSession } from "../core/session";
import { loadPlan } from "../core/state";
import { applyResponse, decideApproval, nextPrompt, rememberIssued } from "../core/turn";
import { describeLanes, readRunState } from "../core/targets";
import type { BuildContext, BuildOutcome } from "../core/types";
import { serve } from "../server/http";

const USAGE =
  "사용법: code-agent <명령> --repo <대상저장소> --templates <템플릿디렉토리>\n" +
  `\n템플릿 디렉토리에는 ${MANIFEST_FILE} 이 있어야 합니다 — 도메인 경로·계층·단계·검증 명령을\n` +
  "그 프로젝트가 선언하는 파일입니다. 에이전트는 언어·프레임워크를 가정하지 않습니다.\n" +
  "\n명령 (수동 모드 — API 미사용):\n" +
  "  serve                서버와 화면을 띄운다 (--port, --host, --state)\n" +
  "                       여럿이 쓰려면 --auth-header + --trust-proxy + --root 가 필요하다\n" +
  "  next                 지금 붙여넣을 프롬프트를 표준출력으로\n" +
  "  apply <응답파일>      응답을 실행하고 다음 프롬프트를 준비\n" +
  "  status               지금 무엇을 할 차례인지\n" +
  "  approve              지금 기다리는 것에 승인 (--approver, --target, --comment)\n" +
  "                       터미널에서 확인 문구를 입력해야 남는다. 스크립트는 --unattended\n" +
  "                       계획 승인(2차) 또는 단계 산출물 확정(4차) — 무엇인지는 상태가 정한다\n" +
  "  reject               같은 자리에 반려 (--approver, --target, --comment 필수)\n" +
  "                       단계를 반려하면 그 단계를 다시 돈다 — 사유가 다음 프롬프트에 실린다\n" +
  "  log                  턴 기록 — 몇 번 만에 됐는지, 어디서 막혔는지\n" +
  "\n  예)  code-agent next --repo … --templates … --spec 요구사항.md > p.txt\n" +
  "       code-agent apply answer.txt --repo … --templates …\n" +
  "\n  --spec 은 계획을 세울 때 한 번만 필요합니다. 이후에는 기억합니다.\n" +
  "\n  지시서의 target 이 여럿이면 대상마다 따로 돕니다 — 계획도 질문도 승인도 대상 단위입니다.\n" +
  "  결과는 <out>/<id>/<대상>/ 아래 갈라집니다.\n" +
  "\n  --spec 문서 중 **한 장**은 맨 첫 줄부터 작업 지시서 머리말을 담아야 합니다.\n" +
  "  없으면 프롬프트를 만들지 않습니다 (규격: doc/work-order.md):\n" +
  "    ---\n" +
  "    kind: feature        # spec | bootstrap | adopt | feature | fix | refactor\n" +
  "    id: PROJ-1\n" +
  "    title: 한 줄 요약\n" +
  "    target: 대상          # [a, b] 처럼 여럿이면 대상마다 따로 돕니다\n" +
  "    ---\n" +
  "\n단계 지정 방식 (예전 방식 — JSON 응답 · 제거 예정, 새 작업에는 쓰지 않는다):\n" +
  "  --step <plan|단계키|gate:단계키> --emit-prompt\n" +
  "  --step <plan|단계키|gate:단계키> --ingest <응답파일>\n" +
  "\nserve 옵션:\n" +
  "  --port <포트>                  기본 4319\n" +
  "  --host <주소>                  기본 127.0.0.1. 밖에 열려면 인증을 함께 켜야 한다\n" +
  "  --state <파일>                 작업 목록 파일. 기본 .code-agent-server/jobs.json\n" +
  "  --auth-header <헤더이름>        앞단 프록시가 넣어 주는 인증 주체 (예: X-Auth-User)\n" +
  "                                 그 값이 작업의 주인이자 승인 원장의 approver 가 된다\n" +
  "  --trust-proxy                  위 헤더를 신뢰한다는 선언. --auth-header 와 짝이다\n" +
  "  --root <디렉토리>               작업이 가리킬 수 있는 경로의 뿌리 (여러 번 줄 수 있다)\n" +
  "\n선택 옵션:\n" +
  `  --conventions <파일|디렉토리>   ${MANIFEST_FILE} 의 conventions 선언을 덮어씀\n` +
  `  --reference <참조도메인>        ${MANIFEST_FILE} 의 referenceDomain 을 덮어씀\n` +
  "  --out <출력디렉토리>            기본 ./out\n" +
  "  --policy <생성범위정책>         모든 단계에 공통 주입\n" +
  "  --no-gate                      단계별 자가검증 생략\n" +
  "\n자동 모드 (API 사용 · 실행 검증되지 않음 — 예전 {files:[]} 응답 형식):\n" +
  "  --plan-only · --stages · --retries · --build · --test · --dry-run";

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

// ---- 사람 존재 관측 ----

/**
 * 판정마다 사람이 입력해야 하는 낱말. **정확 일치**다.
 *
 * 아무 키나 누르면 넘어가는 확인은 확인이 아니다. 그리고 승인과 반려의 낱말이 다른 것은,
 * 무엇에 동의하는지를 손가락이 한 번 더 지나가게 하려는 것이다.
 */
const CONFIRM_WORD: Record<Decision, string> = { approved: "approve", rejected: "reject" };

/** 의존성 없이 동기 대기. TTY 가 비어 있을 때 바쁜 회전을 막는다 */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * TTY 에서 한 줄을 **동기로** 읽는다.
 *
 * 판정 경로가 전부 동기라 여기만 비동기로 만들 수 없다. 비어 있으면(`EAGAIN`) 잠깐 쉬고
 * 다시 읽는다 — 사람이 타이핑하는 동안이므로 회수는 사람의 속도에 묶인다.
 */
function readLineSync(): string {
  const buffer = Buffer.alloc(256);
  let text = "";
  for (;;) {
    let read: number;
    try {
      read = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        pause(40);
        continue;
      }
      if (code === "EOF") {
        break;
      }
      throw error;
    }
    if (read === 0) {
      break;
    }
    text += buffer.subarray(0, read).toString("utf-8");
    if (text.includes("\n")) {
      break;
    }
  }
  return text.split("\n")[0].trim();
}

/**
 * 이 판정 뒤에 사람이 있었는지 **관측한다.** 코어는 이것을 추측하지 않는다.
 *
 * 여기가 위조 방지의 실제 자리다. 모델이 셸로 명령을 돌릴 때 stdin 은 TTY 가 아니므로
 * 이 문이 닫힌다. 증명되는 것은 **존재와 시점**이고 신원이 아니다 — 신원은 로컬 도구가
 * 알 수 없고 커밋 서명·PR·티켓에 있다.
 */
function attestPresence(decision: Decision, args: Record<string, string[]>): Presence {
  if (first(args, "unattended") !== undefined) {
    return {
      channel: "unattended",
      verified: false,
      detail: "--unattended 로 사람 존재 관측을 건너뛰었습니다",
    };
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      "판정은 터미널에서 받습니다 — stdin 이 TTY 가 아닙니다.\n" +
        "  사람이 그 자리에 있었다는 것을 관측할 수 없으면, 승인은 통제가 아니라 기록일 뿐입니다.\n" +
        "  스크립트에서 불러야 한다면 --unattended 를 붙이세요. 그 판정은 원장에 " +
        "'관측되지 않음' 으로 남고,\n" +
        "  code-agent.json 에 requireVerifiedApproval 을 켠 프로젝트에서는 게이트를 열지 않습니다.",
    );
  }

  const word = CONFIRM_WORD[decision];
  process.stdout.write(`${word} 를 그대로 입력하면 판정을 남깁니다 (다른 입력은 취소): `);
  const typed = readLineSync();
  if (typed !== word) {
    throw new Error(
      `판정을 남기지 않았습니다 — ${word} 가 아니라 ${JSON.stringify(typed)} 를 입력했습니다.`,
    );
  }
  return { channel: "tty", verified: true, detail: `터미널에서 ${word} 입력` };
}

/**
 * 인증을 켤 것인가, 그리고 그 전제가 실제로 선언됐는가.
 *
 * 헤더 하나로 신원을 받는 것은 **앞에 그 헤더를 덮어쓰는 프록시가 있을 때만** 인증이다.
 * 없으면 클라이언트가 스스로 아무 값이나 적어 보낼 수 있어 자기 신고에 지나지 않는다.
 * 그래서 `--trust-proxy` 를 따로 요구한다 — 잊고 켜는 일이 없도록, 그 전제를 사람이
 * 한 번 더 적게 하는 자리다.
 */
function resolveAuthHeader(args: Record<string, string[]>): string | undefined {
  const given = first(args, "auth-header");
  const header = given === "true" ? undefined : given;
  const trusted = first(args, "trust-proxy") !== undefined;

  if (given !== undefined && header === undefined) {
    throw new Error("--auth-header 에는 헤더 이름이 필요합니다 (예: --auth-header X-Auth-User).");
  }
  if (header && !trusted) {
    throw new Error(
      "--auth-header 는 --trust-proxy 와 함께 써야 합니다.\n" +
        "  이 헤더는 앞단 프록시가 덮어쓴다는 전제에서만 인증입니다 — 프록시가 없으면\n" +
        "  누구나 스스로 그 헤더를 적어 남의 이름으로 승인할 수 있습니다.\n" +
        "  프록시를 두었다면 --trust-proxy 를 붙여 그 사실을 선언하세요.",
    );
  }
  if (trusted && !header) {
    throw new Error("--trust-proxy 만으로는 인증이 켜지지 않습니다. --auth-header 로 헤더 이름을 주세요.");
  }
  return header;
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

/** 스펙 경로는 최초 한 번만 받는다. 그 뒤로는 지시서 단위 상태가 기억한다. */
function requireSpecForPlan(context: BuildContext) {
  if (context.specPaths.length > 0 || readRunState(context.outDir).specPaths.length > 0) {
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
  rememberIssued(context, next);

  if (!next.prompt) {
    console.error(`## ${next.label}\n${next.message ?? ""}`);
    return;
  }

  const stashed = stashPrompt(next.outDir, next.prompt);
  // 프롬프트만 표준출력으로 — 파이프·리다이렉트로 바로 쓸 수 있게 다른 출력을 섞지 않는다.
  process.stdout.write(next.prompt);
  console.error(`\n\n[${next.label}] 이 프롬프트는 ${stashed} 에도 저장했습니다.`);
  // 경고는 표준오류로. 프롬프트를 파이프로 넘겨도 사람 눈에는 남아야 한다.
  for (const warning of next.warnings ?? []) {
    console.error(`  ⚠ ${warning}`);
  }
}

async function runApply(context: BuildContext, responsePath: string) {
  requireSpecForPlan(context);
  const outcome = await applyResponse(context, readFileSync(responsePath, "utf-8"));

  console.log(`## ${outcome.label}`);

  if (outcome.parseErrors.length > 0) {
    console.log("\n응답 형식 오류 — 아무것도 반영하지 않았습니다:");
    for (const error of outcome.parseErrors) {
      console.log(`  - ${error}`);
    }
  }

  if (outcome.planSaved) {
    console.log(`계획 저장: ${outcome.planSaved}\n`);
    console.log(formatPlan(loadPlan(outcome.outDir)));
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
    console.log(`\n질문 ${outcome.questionsAdded}건 — ${questionsPath(outcome.outDir)}`);
  }

  if (outcome.message) {
    console.log(`\n${outcome.message}`);
  }

  const next = nextPrompt(context);
  rememberIssued(context, next);
  if (next.prompt) {
    console.log(`\n다음: [${next.label}] → ${stashPrompt(next.outDir, next.prompt)}`);
  } else {
    console.log(`\n${next.message ?? ""}`);
  }
}

function runStatus(context: BuildContext) {
  const next = nextPrompt(context);
  const session = loadSession(next.outDir);

  console.log(`## 지금 할 차례: ${next.label}`);
  console.log(`턴 ${session.turn} · 끝난 단계 ${session.completedStages.length}개`);
  if (session.completedStages.length > 0) {
    console.log(`  완료: ${session.completedStages.join(", ")}`);
  }
  if (next.lanes.length > 1) {
    console.log(`\n대상별 상태:`);
    console.log(describeLanes(next.lanes));
  }
  if (next.message) {
    console.log(`\n${next.message}`);
  }
}

/**
 * 사람이 판정을 내린다 — 계획 승인(2차)이든 단계 산출물 확정(4차)이든 같은 명령이다.
 * 무엇에 대한 판정인지는 상태가 정한다. 사람이 그것까지 지정하게 하면 읽던 것과
 * 판정하는 것이 어긋날 수 있다.
 *
 * 기록은 대상 저장소의 .code-agent/approvals/ 에 남는다. 이 파일은 신원을 증명하지 않는다 —
 * 보장하는 것은 "승인 없이는 진행되지 않는다"까지이고, 증명은 커밋·PR·티켓에 있다.
 */
function runDecision(
  input: BuildContext,
  decision: Decision,
  given: { approver?: string; comment?: string; target?: string; presence: Presence },
) {
  const { unchanged, record } = decideApproval(input, decision, given);

  if (unchanged) {
    console.log(`이미 승인되어 있습니다 — ${record.approver} · ${record.at}`);
    console.log("같은 계획에 같은 판정을 두 번 남기지 않습니다.");
    return;
  }

  const what = record.stage ? `단계 확정(${record.stage})` : "계획 승인";
  console.log(
    `${decision === "approved" ? "승인" : "반려"}: ${record.id} · ${record.target} — ${what}`,
  );
  console.log(`  판정: ${record.approver} · ${record.at}`);
  if (record.presence) {
    const mark = record.presence.verified ? "관측됨" : "관측되지 않음";
    console.log(`  사람 존재: ${mark} (${record.presence.channel}) — ${record.presence.detail}`);
  }
  console.log(`  지시서 ${record.orderHash} · 계획 ${record.planHash}`);
  if (record.filesHash) {
    console.log(`  산출물 ${record.filesHash}`);
  }
  console.log(`  원장: ${ledgerPath(input.repoRoot, record.id)}`);
  console.log(`  스냅샷: ${record.snapshot}`);

  const next = nextPrompt(input);
  rememberIssued(input, next);
  if (next.prompt) {
    console.log(`\n다음: [${next.label}] → ${stashPrompt(next.outDir, next.prompt)}`);
  } else {
    console.log(`\n${next.message ?? ""}`);
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
      authHeader: resolveAuthHeader(args),
      roots: args.root?.filter((root) => root !== "true"),
    });
    return;
  }

  const isIngest = Boolean(first(args, "ingest"));
  const isManaged = command !== undefined;
  // 작업 지시서는 --spec 문서의 머리말에 있다. 다만 예전 방식도 세션이 경로를 기억하므로
  // 최초 한 번만 주면 된다 — 기억한 것이 없으면 0차 게이트가 무엇을 넣어야 하는지 알려 준다.
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
    await runApply(context, responsePath);
    return;
  }
  if (command === "status") {
    runStatus(context);
    return;
  }
  if (command === "approve" || command === "reject") {
    const decision: Decision = command === "approve" ? "approved" : "rejected";
    runDecision(context, decision, {
      approver: first(args, "approver"),
      comment: first(args, "comment"),
      target: first(args, "target"),
      // 관측을 먼저 한다. 확인 문구를 입력하지 않으면 원장에 아무것도 닿지 않는다.
      presence: attestPresence(decision, args),
    });
    return;
  }
  if (command === "log") {
    // 턴 기록도 대상 단위다. 하나로 합치면 어느 대상에서 막혔는지가 지워진다.
    for (const lane of nextPrompt(context).lanes) {
      console.log(`## 대상: ${lane.lane.target}`);
      console.log(summarizeSession(loadSession(lane.lane.outDir)));
      console.log();
    }
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
      "\n미결 질문이 남아 생성을 중단했습니다. 스펙을 보완하고 다시 실행하세요 — " +
        "강행하는 옵션은 두지 않습니다.",
    );
    return;
  }

  printStages(outcome);
  console.log(`\n생성 결과: ${context.outDir}`);

  // 돌지 못한 것을 실패라고 하면 사람이 코드를 의심한다 — 원인은 환경에 있는데.
  const said = (result: { outcome: string; passed: boolean }) =>
    result.outcome === "error" ? "실행 오류" : result.passed ? "통과" : "실패";

  if (outcome.build) {
    console.log(`\n## 빌드 ${said(outcome.build)}\n${outcome.build.log}`);
  }

  if (outcome.test) {
    console.log(`\n## 테스트 ${said(outcome.test)}\n${outcome.test.log}`);
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
