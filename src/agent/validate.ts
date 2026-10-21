import { execFileSync } from "child_process";
import { fileOutcomeProblems } from "../core/fileOperations";
import { createHash } from "crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "fs";
import { hostname, tmpdir } from "os";
import { basename, dirname, join } from "path";

import { hashManifest, hashPlan } from "../core/approval";
import { writeAtomic } from "../core/atomic";
import { runCommand } from "../core/build";
import { errorLogOf } from "../core/workOrder";
import type { CommandResult } from "../core/build";
import {
  boundEvidence,
  checkCommands,
  integrateCommands,
  loadEvidence,
  outsideChanges,
  planPaths,
  prepareCommand,
  preservedTestProblems,
  renderValidationDoc,
  reviewRoundUsage,
  RUN_CAUSE_LABEL,
  runsOf,
  saveEvidence,
  tcNearMisses,
  tcPrecheck,
  testCaseEvidence,
  freezingTestRun,
  guardedFiles,
  testFrozen,
  reproBasisOf,
  reproResultProblem,
  testCommands,
  testStageFiles,
  testTreeHashNow,
  treeHashNow,
  validationDocFile,
  verifyView,
} from "./evidence";
import type { CommandSpec, Evidence, LogBasis, Outcome, ReproAttemptClass, TestCaseEvidence, VerifyPhase, VerifyRun } from "./evidence";
import { skillFile } from "./hostText";
import { logDir, questionsFile, reviewFile, STATE_DIR, workDocsDir } from "./layout";
import { acquireLock, pidAlive } from "./lock";
import { PLUGIN_LOG_DIR, pluginVerifyRuns } from "./plugins/run";
import {
  budgetText,
  COUNTER_LABEL,
  ENVIRONMENT_REASON,
  environmentMatch,
  failure,
  grantable,
  grantScope,
  guidance,
  LIMITS,
  limitExceededText,
  limitOf,
  nextRoundDecision,
  runCauseOf,
  runClass,
  sameRoundDecision,
  stateGuardText,
  TIMING,
  verifyBudget,
  verifyRetryOf,
  verifyState,
  VERIFY_NOTES,
  RetryRefused,
} from "./retryPolicy";
import type { FailureRecord, RunCause, VerifyBudget, VerifyRetryState, VerifyState, WipedRuns } from "./retryPolicy";
import { reviewProblems } from "./review";
import { Stop } from "./stop";
import { shortCommand } from "./screenText";
import { confirmOnTerminal } from "./tty";
import { freshTestReports, reportSnapshot } from "./testReports";
import type { ReportScan } from "./testReports";
import { scanTestResults } from "./testResults";
import { changedPaths, fileHashes } from "./tree";
import type { Work } from "./work";
import { reproCases, readWorkDoc, workDocPath } from "./workDocs";

/**
 * 7 정적 분석·컴파일(`check`) · 8 테스트(`test`).
 *
 * 모델이 Bash 로 직접 부를 수 있다 — 결과에 손댈 수 없으므로 안전하다. 모델이 같은 명령을 제 손으로
 * 돌리는 것도 막지 않지만 아무 효력이 없다: `next` 는 여기가 적은 증거만 읽는다.
 *
 * 순서가 곧 규칙이다. **앞의 검사가 뒤의 실행을 막는다** — 계획 밖 변경 위에서 나온 통과는 증거가
 * 아니므로 대조를 실행 *전*에 두고, 회차도 실행 *전*에 올린다(뒤에 올리면 프로세스를 죽여 카운터를
 * 피하는 길이 생긴다).
 */

/** `error`(못 돌았다)와 `failed`(돌아서 실패했다)를 섞지 않는다 — expect:"fail" 은 failed 만 재현으로 인정한다 */
function outcomeOf(result: CommandResult): Outcome {
  if (result.error) {
    return "error";
  }
  return result.status === 0 ? "passed" : "failed";
}

/** 실패 꼬리의 줄·전체 상한 — 한 줄짜리 거대한 출력(압축된 스택·JSON)이 증거·출력을 채우지 않게 한다. 전문은 로그 파일에 있다 */
export const TAIL_LINE_CHARS = 300;
export const TAIL_TOTAL_CHARS = 4000;
export function tailOf(text: string, lines: number): string {
  const kept = text.split("\n").slice(-lines)
    .map((line) => line.length > TAIL_LINE_CHARS ? `${line.slice(0, TAIL_LINE_CHARS)}… (${line.length - TAIL_LINE_CHARS}자 생략)` : line);
  // 전체 상한 — 마지막 오류에 가까운 끝 줄부터 남긴다
  let start = kept.length, total = 0;
  while (start > 0 && total + kept[start - 1].length + 1 <= TAIL_TOTAL_CHARS) total += kept[--start].length + 1;
  return (start > 0 ? [`… (앞 ${start}줄 생략)`, ...kept.slice(start)] : kept).join("\n");
}

export interface ValidateOptions {
  /** 테스트에서 시간을 재현 가능하게 만들기 위한 자리 */
  now?: () => string;
}

/**
 * 검증 스테이지에 들어갈 수 있는가. git 저장소가 아니면 거부한다 —
 * 약한 대체 경로를 두면 보증의 강도가 조용히 달라지는 두 번째 코드 경로가 생긴다.
 */
function requireEvidenceBase(work: Work): string {
  const { active } = work;
  if (!active.baseCommit) {
    throw new Stop(
      "기준 커밋이 굳혀져 있지 않아 검증할 수 없습니다 — 검증 증거는 기준 커밋에 묶입니다.\n" +
        "git 저장소에서 code-agent abort 뒤 다시 시작하세요.",
    );
  }
  if (!work.plan) {
    throw new Stop("제출된 계획이 없습니다.");
  }
  return active.baseCommit;
}

/** 실행 전 대조 — 계획 밖 변경과 사라진 계획 파일, refactor 면 기존 테스트까지. 하나라도 있으면 명령을 돌리지 않는다 */
function requireCleanPlan(work: Work): void {
  const outside = outsideChanges(work);
  const missing = fileOutcomeProblems(work.plan?.files ?? [], path => existsSync(join(work.repoRoot, path)));
  // 기존 테스트 수정은 `계획 밖 변경` 으로도 잡히지만, 여기서 따로 말해야 무엇이 규칙인지가 보인다
  const preserved = preservedTestProblems(work);
  if (outside.length === 0 && missing.length === 0 && preserved.length === 0) {
    return;
  }
  throw new Stop(
    "계획과 실제 변경이 어긋나 검증을 돌리지 않았습니다 — 계획 밖 변경 위에서 나온 통과는 증거가 아닙니다:\n" +
      [
        ...outside.map((change) => `  - 계획 밖 변경 [${change.status}] ${change.path}`),
        ...missing.map((problem) => `  - ${problem}`),
        ...preserved.map((problem) => `  - ${problem}`),
      ].join("\n") +
      `\n되돌리거나, 계획을 넓혀야 하면 ${workDocsDir(work.active.id)}/questions.md 에 질문으로 남기고 사람에게 알리세요.`,
  );
}

function emptyEvidence(work: Work, baseCommit: string): Evidence {
  return {
    id: work.active.id,
    target: work.active.target,
    baseCommit,
    treeHash: treeHashNow(work),
    manifestHash: hashManifest(work.manifest),
    planHash: hashPlan(work.plan!),
    rounds: 0,
    // 한도는 여기서 굳는다 — 루프 도중에 code-agent.json 을 고쳐 늘릴 수 없게
    fixRounds: work.manifest.fixRounds,
    runs: [],
    testCases: [],
    at: new Date().toISOString(),
  };
}

/**
 * 앞 회차의 증거를 이어받는다. 묶임이 하나라도 어긋났으면(계획 재승인·매니페스트 변경·기준 커밋 변경)
 * **버리고** 처음부터 센다 — 다른 계획 위에서 난 회차를 이어 세면 고쳐 쓰기 한도가 조용히 늘어난다.
 *
 * 트리 해시는 대조하지 않는다 — 고쳐 쓰기는 트리를 바꾸는 일이고, 그것이 이 루프의 목적이다.
 * 여기서 새로 굳힌 값이 "이번 회차가 검증한 트리" 가 된다.
 */
function carry(work: Work, baseCommit: string): Evidence {
  const previous = loadEvidence(work.repoRoot, work.active.id, work.active.target);
  const stale =
    !previous ||
    previous.baseCommit !== baseCommit ||
    previous.manifestHash !== hashManifest(work.manifest) ||
    previous.planHash !== hashPlan(work.plan!);
  return stale
    ? emptyEvidence(work, baseCommit)
    : { ...previous!, treeHash: treeHashNow(work), at: new Date().toISOString() };
}

/**
 * 재현이 이어받는 증거 — carry 와 묶임 판정은 같고, **treeHash 를 바꾸지 않는다.** 재현은 계획 파일 전체를 검증하지
 * 않으므로, 여기서 treeHash 를 지금 값으로 굳히면 옛 회차의 check·test 실행이 바뀐 트리에 묶인 것처럼 보인다.
 */
function carryForRepro(work: Work, baseCommit: string): Evidence {
  const previous = loadEvidence(work.repoRoot, work.active.id, work.active.target);
  const stale =
    !previous ||
    previous.baseCommit !== baseCommit ||
    previous.manifestHash !== hashManifest(work.manifest) ||
    previous.planHash !== hashPlan(work.plan!);
  return stale ? emptyEvidence(work, baseCommit) : { ...previous!, at: new Date().toISOString() };
}

/**
 * **디스크의** 증거를 읽어 고친 뒤 저장한다(⑧ 렌더 포함). 증거가 없으면 아무것도 하지 않는다 — 사람 허용(retry.grants)을
 * 더할 때 쓴다. 이어받은 메모리 객체를 저장하면 treeHash 가 지금 값으로 바뀌는데, 이 함수는 그것을 막는다.
 * 실행 표지에는 쓰지 않는다 — 실행 중인 명령이 끝에 자기 메모리 객체를 저장하면 그 사이 디스크에 쓴 표지가 사라진다.
 */
export function patchEvidence(work: Work, change: (disk: Evidence) => void): void {
  const disk = loadEvidence(work.repoRoot, work.active.id, work.active.target);
  if (!disk) return;
  change(disk);
  persist(work, disk);
}

/** 이보다 오래된 실행 표지는 낡은 것이다 — 준비·빌드·테스트 명령 각각의 한도에 여유를 더한 값 */
function runStaleMs(work: Work): number {
  return (work.manifest.commandTimeoutMinutes * 3 + 10) * 60_000;
}

const STARTED_LABEL: Record<"test" | "integrate", string> = { test: "테스트", integrate: "통합 검증" };

/** 시작 표지의 실행이 아직 도는가 — 같은 PC 면 pid 로, 다른 PC 면 나이로 본다 */
function startedRunning(work: Work, started?: VerifyRetryState["started"]): boolean {
  if (!started || !(Date.now() - Date.parse(started.at) < runStaleMs(work))) return false;
  return started.host === hostname() ? started.pid !== process.pid && pidAlive(started.pid) : true;
}

/** 실행 중인 test·통합 검증 위에 check·test 를 돌리지 않는다 — 서로의 증거를 덮는다 */
function requireNotRunning(work: Work, retry: VerifyRetryState): void {
  const started = retry.started;
  if (!started || !startedRunning(work, started)) return;
  throw new Stop(
    `다른 ${STARTED_LABEL[started.phase]} 실행이 진행 중입니다 (pid ${started.pid}, ${started.host}, ${started.at} 시작) — 끝난 뒤 다시 실행하세요. ` +
      "실행 중인 것이 없으면 사용자가 그 프로세스를 확인합니다.",
  );
}

/**
 * 검증 명령이 건드리면 안 되는 code-agent 기록 — 리뷰 회차·리뷰어 실행·교차 지점·사람 판단(review.json)과 계획 기록(planning.json).
 * hook 은 모델 도구의 .code-agent 쓰기만 막는다. 검증 명령은 모델이 쓴 테스트 코드를 실행하므로 그 기록을 지우거나 고칠 수 있다 —
 * verify.json 은 끝 저장이 메모리 사본으로 다시 쓰지만 이 둘은 다시 쓰지 않는다. 검증·리뷰·계획 단계의 다른 쓰기는 이 실행 동안 없다
 * (review-event·교차 리뷰는 review 단계에서만, 계획 담당 hook 은 계획 단계에서만 쓴다).
 */
function guardedStateFiles(work: Work): string[] {
  const { repoRoot, active } = work;
  return [reviewFile(repoRoot, active.id, active.target), join(repoRoot, STATE_DIR, "work", active.id, `${active.target}.planning.json`)];
}
function snapshotState(paths: readonly string[]): Map<string, Buffer | undefined> {
  return new Map(paths.map((path) => [path, existsSync(path) ? readFileSync(path) : undefined]));
}
/** 바뀐 기록을 실행 전 바이트로 되돌리고 바뀐 경로를 돌려준다 */
function restoreState(work: Work, before: Map<string, Buffer | undefined>): string[] {
  const changed: string[] = [];
  for (const [path, bytes] of before) {
    const now = existsSync(path) ? readFileSync(path) : undefined;
    if (bytes === undefined ? now === undefined : now !== undefined && bytes.equals(now)) continue;
    changed.push(path.slice(work.repoRoot.length + 1).replace(/\\/g, "/"));
    if (bytes === undefined) rmSync(path, { force: true });
    else { mkdirSync(dirname(path), { recursive: true }); writeAtomic(path, bytes.toString("utf-8")); }
  }
  return changed;
}

async function runSpecs(
  work: Work,
  phase: VerifyPhase,
  round: number,
  specs: CommandSpec[],
  /** 명령을 돌릴 자리. 통합 검증만 저장소가 아니라 임시 worktree 에서 돈다 */
  cwd: string = work.repoRoot,
  // 출력은 `runs` 와 자리를 맞춰 돌려준다 — 재현이 "**실패한 실행의** 출력" 만 보려면 갈라져 있어야 한다.
  // guarded 는 검증 명령이 바꿔 되돌린 code-agent 기록 — 비어 있지 않으면 runs 는 모두 원인 guard 다
): Promise<{ runs: VerifyRun[]; outputs: string[]; guarded: string[] }> {
  const runs: VerifyRun[] = [];
  const outputs: string[] = [];
  mkdirSync(logDir(work.repoRoot), { recursive: true });
  const guarded = snapshotState(guardedStateFiles(work));

  for (const spec of specs) {
    const at = new Date().toISOString();
    if (!spec.argv) {
      // 선언되지 않은 종류는 통과가 아니다 — 안 돌린 것을 통과로 읽으면 검증하지 않은 코드가 검증된 것이 된다
      runs.push({ round, phase, kind: spec.kind, command: "", outcome: "not-run", status: null, tail: "", at });
      outputs.push("");
      continue;
    }
    // 상위 node:test의 내부 바이너리 전송 모드는 프로젝트 테스트 러너에 물려주지 않는다.
    const { NODE_TEST_CONTEXT: _parentTestContext, ...commandEnv } = process.env;
    // 보고서 탐색 기록 — 탐색이 상한에서 끊겼는지와, 새 보고서의 TC 아닌 testcase 까지 담는다(환경 분류가 쓴다)
    const scan: ReportScan = { truncated: false, cases: [] };
    const reports = phase === "repro" || phase === "test" || (phase === "integrate" && spec.kind === "test") ? reportSnapshot(cwd, scan) : undefined;
    const result = await runCommand(cwd, spec.argv, commandEnv, work.manifest.commandTimeoutMinutes * 60_000);
    const log = [result.stdout, result.stderr, reports ? freshTestReports(cwd, reports, scan) : ""].filter(Boolean).join("\n").trim();
    // 선언된 환경 오류 문구가 실패 출력에 있으면 코드 결함이 아니라 환경 오류다 — 돌지 못한 것(error)과 같이 다룬다.
    // 단 같은 실행에 실패한 테스트 결과(콘솔 결과 줄·새 보고서의 testcase, TC id 유무와 무관)가 하나라도 있으면 환경이 아니다.
    // 재현만은 예외다 — 재현에서 환경으로 보는 것은 재현으로 인정하지 않는 엄격한 쪽이라(컨텍스트 로드 실패로 빨개진
    // 재현 TC 를 결함 재현으로 받지 않는다) 실패 결과가 있어도 문구만으로 환경 오류다
    const environment = !result.error && result.status !== 0
      ? environmentMatch(log, work.manifest.environmentErrors, phase === "repro" ? [] : [...scanTestResults(log), ...scan.cases])
      : undefined;
    const cause: RunCause | undefined = result.timedOut ? "timeout" : result.notFound ? "missing-tool"
      : result.error ? "spawn" : environment ? "environment" : undefined;
    const outcome = environment ? "error" : outcomeOf(result);
    const logFile = `.code-agent/log/${phase}-${round}-${spec.kind}.log`;
    writeFileSync(
      join(work.repoRoot, logFile),
      `${spec.argv.join(" ")}\n\n${result.error ? `실행 실패: ${result.error.message}\n\n` : ""}${log}\n`,
    );
    outputs.push(log);
    runs.push({
      round,
      phase,
      kind: spec.kind,
      command: spec.argv.join(" "),
      outcome,
      status: result.status,
      logFile,
      tail: [
        result.error ? `실행 실패: ${result.error.message}` : "",
        environment ? `환경 오류: 출력에 선언된 문구 "${environment}" 가 있습니다 (code-agent.json environmentErrors) — 코드 결함으로 보지 않습니다` : "",
        tailOf(log, outcome === "passed" ? 5 : 40),
      ]
        .filter(Boolean)
        .join("\n"),
      at,
      ...(environment ? { environment } : {}),
      ...(cause ? { cause } : {}),
      ...(scan.truncated ? { reportScan: "truncated" as const } : {}),
    });
  }
  // 검증 명령이 code-agent 기록을 바꿨으면 되돌리고 이 실행을 증거로 받지 않는다 — 리뷰 회차·교차 지점을 지워 한도를 피하는 길을 닫는다.
  // 실행마다 원인 guard(전제 미충족 — runClass)로 남긴다: 게이트·status·같은 코드 재실행 거부가 같은 사실을 말하고, 결과(통과)로 세지 않는다
  const tampered = restoreState(work, guarded);
  if (tampered.length) {
    for (const run of runs) {
      run.outcome = "error";
      run.cause = "guard";
      run.guarded = tampered;
      delete run.environment;
      run.tail = [stateGuardText(tampered), run.tail].filter(Boolean).join("\n");
    }
  }
  return { runs, outputs, guarded: tampered };
}

/** 인식 규칙(`TC-<숫자>`)에 걸리지 않는 표기로 적힌 TC — 막지 않고 고칠 표기만 알린다 */
function nearMissLines(work: Work, ids: string[]): string[] {
  return [...tcNearMisses(work, ids)].map(([id, found]) =>
    `  - ${id}: 계획 파일에 ${found} 가 있습니다 — 결과는 ${id} 표기(대문자 TC, 하이픈, 숫자)만 인식합니다. 테스트 이름을 ${id} 로 고치세요.`);
}

/** ⑦ TC 미확인 이유 — 결과 미확인 안내의 {cases} */
function unconfirmedCases(cases: TestCaseEvidence[]): string {
  return cases.filter((entry) => entry.status !== "passed").map((entry) => {
    const status = entry.status ?? "unknown";
    if (status !== "unknown") return `${entry.id}(${status})`;
    if (entry.source === "테스트 파일") return `${entry.id}(unknown — 테스트 파일에는 있으나 실행 결과에 없음)`;
    if (entry.source === "없음") return `${entry.id}(unknown — 계획 파일 어디에도 없음)`;
    return `${entry.id}(unknown)`;
  }).join(", ");
}

/**
 * 원인별 안내 문구의 값 — 결과 줄(remainingNote)과 verify 의 task 가 같은 값을 쓴다. 통합 검증은 같은 회차를
 * code-agent integrate 로 다시 돌고 통합 검증 재실행을 쓰므로 integrate 변형을 고른다 — verify --retry 를 안내하면
 * check 로 되감아 같은 코드 재실행을 쓰고 그 회차의 check·test·통합 검증 기록을 지운다.
 */
export function verifyGuidance(work: Work, evidence: Evidence, phase: "check" | "test" | "integrate", state: VerifyState, budget: VerifyBudget): string {
  const runs = runsOf(evidence, phase).filter((run) => run.round === evidence.rounds);
  const rerunLeft = phase === "integrate" ? budget.integrateRerun.left : budget.rerun.left;
  const variant = phase === "integrate" ? "integrate" : undefined;
  const failed = runs.filter((run) => run.outcome !== "passed");
  switch (state) {
    case "code-defect":
      return guidance("code-defect", { failed: failed.map((run) => `${run.kind}: ${run.outcome}`).join(", ") || "TC 실패", budget: budgetText(budget) });
    case "environment": {
      const run = runs.find((entry) => runClass(entry) === "environment") ?? failed[0];
      const cause = run ? runCauseOf(run) : undefined;
      const reason = run?.kind === "prepare" ? ENVIRONMENT_REASON.prepare
        : run?.environment ? `출력에 선언된 문구 "${run.environment}"`
          : cause === "missing-tool" ? ENVIRONMENT_REASON["missing-tool"]
            : cause === "spawn" ? ENVIRONMENT_REASON.spawn : run?.outcome ?? "error";
      return guidance("environment", { kind: run?.kind ?? phase, reason, rerunLeft }, variant);
    }
    case "interrupted": {
      const run = runs.find((entry) => runClass(entry) === "timeout");
      return run
        ? guidance("interrupted", { kind: run.kind, minutes: work.manifest.commandTimeoutMinutes, logFile: run.logFile ?? validationDocFile(work.active.id), rerunLeft }, variant)
        : guidance("interrupted", { round: evidence.rounds, phase, rerunLeft }, "empty");
    }
    case "result-unconfirmed": {
      const cases = phase === "test" ? evidence.testCases : phase === "integrate" ? evidence.integrationTestCases ?? [] : [];
      const listed = unconfirmedCases(cases) || "(⑦ 결과 없음)";
      // 통합 검증에는 수집 수정 창이 없다(창은 이 회차 test 의 결과 미확인에만 열린다)
      const text = variant ? guidance("result-unconfirmed", { cases: listed, rerunLeft }, variant) : guidance("result-unconfirmed", {
        cases: listed,
        collectNote: budget.collect.left > 0 ? VERIFY_NOTES.collectOpen : VERIFY_NOTES.collectUsed,
        rerunLeft,
      });
      return runs.some((run) => run.reportScan) ? `${text} ${VERIFY_NOTES.reportTruncated}` : text;
    }
    case "precondition": {
      // 검증 명령이 code-agent 기록을 바꾼 실행(guard)이면 그 사실, 아니면 명령 미선언이다
      const guarded = guardedFiles(evidence, phase);
      return guidance("precondition", { problems: guarded.length ? stateGuardText(guarded) : "선언되지 않은 명령(not-run)" });
    }
    case "passed":
      return "전부 통과했습니다 — code-agent next 로 다음 스테이지로.";
  }
}

function remainingNote(work: Work, evidence: Evidence, phase: "check" | "test" | "integrate"): string {
  const state = verifyState({
    phase, round: evidence.rounds, runs: evidence.runs,
    cases: phase === "test" ? evidence.testCases : phase === "integrate" ? evidence.integrationTestCases ?? [] : undefined,
  });
  const view = verifyView(work, evidence);
  // 통합 검증 통과는 CLI 가 커서를 deliver 로 옮기고 그 결과를 붙인다(advancePassedIntegrate)
  if (state === "passed") return phase === "integrate" ? "전부 통과했습니다." : "전부 통과했습니다 — code-agent next 로 다음 스테이지로.";
  if (state === "result-unconfirmed") {
    return "명령은 끝났지만 필수 TC의 성공이 확인되지 않았습니다. 테스트 결과 형식과 생략·실패 케이스를 확인하세요. " +
      verifyGuidance(work, evidence, phase, state, view.budget);
  }
  if (state === "code-defect") {
    // 고쳐도 다음 회차가 거부되는가 — hook 의 쓰기 차단(writeBlockReason)과 같은 판정이다
    const next = nextRoundDecision({ previous: view.state, emptyRound: view.emptyRound, treeChanged: true, budget: view.budget,
      reviewOpenFindings: view.reviewOpenFindings });
    if (next.action === "refuse" && next.failure.counter) {
      const { key, limit } = next.failure.counter;
      // 사람 선택지는 실제로 받는 동의와 같다 — 사람 허용으로 늘리지 않는 카운터(총 회차)는 허용을 싣지 않는다
      return `${key === "fix" ? `고쳐 쓰기 ${limit}회를 넘겼습니다` : `${COUNTER_LABEL[key]} 한도 ${limit}회를 모두 썼습니다`} — 덮지 않고 보고합니다. ` +
        "계획 파일은 더 고칠 수 없습니다(hook 이 거부합니다).\n" +
        `${questionsFile(work.active.id)} 에 무엇이 막혔는지 적고 사람에게 알리세요. ` +
        (grantable(key) ? "사람이 한 회차를 더 허용하거나(ca-answer 의 judgment 동의) 계획을 고쳐 재승인합니다."
          : "이 카운터는 사람 허용으로 늘리지 않습니다 — 사람이 계획을 고쳐 재승인하거나 작업을 종료(abort)합니다.");
    }
    return `계획 안에서 고치고 code-agent verify 로 다시 검증하세요 — check 부터 다시 돕니다 (${budgetText(view.budget)}).`;
  }
  return verifyGuidance(work, evidence, phase, state, view.budget);
}

/**
 * 전문을 어디서 보나. **런마다 다르다** — `logFile` 은 명령을 돌린 런만 갖는다.
 * 플러그인 런은 로그 파일을 쓰지 않으므로 그 자리에 `undefined` 를 찍는 대신 실제로 있는 자리를 가리킨다.
 */
function wholeLog(run: VerifyRun): string {
  if (run.logFile) {
    return ` — 전체는 ${run.logFile}`;
  }
  return run.kind.startsWith("plugin:") ? ` — 플러그인 런입니다. 요청·응답은 ${PLUGIN_LOG_DIR}/verify.extra.jsonl` : "";
}

/** note: false — verify 가 부를 때. 다음 할 일과 남은 회차는 verify 결과(task·budget)가 한 번만 말한다 */
function summary(work: Work, evidence: Evidence, phase: "check" | "test" | "integrate", specs: CommandSpec[], note = true): string {
  const runs = runsOf(evidence, phase);
  const lines = [
    `# code-agent ${phase} — ${work.active.id} · ${evidence.rounds}회차`,
    "",
    ...runs.map((run) =>
      `- ${run.kind}: ${run.outcome}${run.cause ? ` · ${RUN_CAUSE_LABEL[run.cause]}` : ""}` +
      `${run.command ? ` (${shortCommand(run.command)})` : " — code-agent.json 에 선언이 없습니다"}${run.logFile ? ` · 로그 ${run.logFile}` : ""}`),
  ];
  if (specs.every((spec) => !spec.argv)) {
    lines.push("", `!! ${phase} 로 돌릴 명령이 하나도 선언돼 있지 않습니다 — 검증 없이 통과할 수 없습니다.`);
  }
  if ((phase === "test" || phase === "integrate") && runs.some((run) => run.reportScan)) {
    lines.push("", "!! 보고서 탐색이 2만 항목·깊이 12에서 끊겼습니다 — JUnit 보고서를 찾지 못했을 수 있습니다.");
  }
  if (phase === "check" && !testFrozen(evidence)) {
    // FLOW-05 사전 점검 — 막지 않는다. TC id 가 어디에도 없으면 test 의 결과가 인식되지 않는다
    const missing = tcPrecheck(work);
    if (missing.length > 0) {
      lines.push("", `!! ⑦ 의 TC id 가 계획 파일 어디에도 없습니다: ${missing.join(", ")} — code-agent test 전에 테스트 이름에 넣으세요. 결과가 인식된 test 실행부터 kind:test 파일이 업니다.`);
      lines.push(...nearMissLines(work, missing));
    }
  }
  if (phase === "test") {
    const missing = evidence.testCases.filter((entry) => entry.status !== "passed");
    lines.push(
      "",
      `⑦ 테스트 케이스: ${evidence.testCases.length}개 중 ${evidence.testCases.length - missing.length}개 확인` +
        (missing.length > 0 ? ` · 확인되지 않음 ${missing.map((entry) => `${entry.id}(${entry.status ?? "unknown"})`).join(", ")}` : ""),
    );
    const unknown = missing.filter((item) => (item.status ?? "unknown") === "unknown");
    for (const entry of unknown) {
      lines.push(`  - ${entry.id}: ${entry.source === "테스트 파일"
        ? `테스트 파일에 id 는 있지만 실행 결과에 없습니다 — 러너 출력·보고서 형식을 확인하세요(러너별 이름: ${skillFile("ca-test", undefined, "tc-names.md")})`
        : "계획 파일 어디에도 id 가 없습니다 — 테스트 이름에 TC id 를 넣으세요"}`);
    }
    lines.push(...nearMissLines(work, unknown.filter((entry) => entry.source !== "테스트 파일").map((entry) => entry.id)));
    if (work.stages.every((stage) => stage.kind !== "test")) {
      lines.push(`!! kind:"test" 단계가 선언돼 있지 않습니다 — 테스트 동결이 걸리지 않습니다 (code-agent.json 의 stages[].kind).`);
    }
  }
  for (const run of runs.filter((entry) => entry.outcome === "failed" || entry.outcome === "error")) {
    lines.push("", `## ${run.kind} 실패 (마지막 40줄${wholeLog(run)})`, "```", run.tail.trimEnd() || "(출력 없음)", "```");
  }
  lines.push("", `⑧ ${validationDocFile(work.active.id)} 를 렌더했습니다.`, ...(note ? [remainingNote(work, evidence, phase)] : []));
  return lines.join("\n");
}

/**
 * 같은 회차를 다시 돌리면 앞의 기록을 **갈아 끼운다.**
 * 이어 붙이면 고쳐 쓰기 전의 실패가 같은 회차에 남아, 마지막 회차 판정이 영원히 실패로 읽힌다.
 */
function replaceRuns(evidence: Evidence, phase: VerifyPhase, round: number, runs: VerifyRun[]): void {
  evidence.runs = [...evidence.runs.filter((run) => !(run.phase === phase && run.round === round)), ...runs];
}

/**
 * 증거를 쓰고 ⑧ 을 다시 렌더한다 — 둘은 한 벌이라 따로 두지 않는다. 실행 **전** 저장도 이것으로 한다: ⑧ 은 회차 원인·재실행
 * 수를 렌더하므로, 실행 전 저장 뒤 끊기면 ⑧ 이 증거와 어긋나 다음 verify 가 끊긴 원인 대신 ⑧ 불일치를 보게 된다.
 */
function persist(work: Work, evidence: Evidence): void {
  saveEvidence(work.repoRoot, evidence);
  writeAtomic(join(work.repoRoot, validationDocFile(work.active.id)), renderValidationDoc(work, evidence));
}

/** 같은 회차 재사용이 지운 상태를 그 단계가 다시 돈 끝 저장에서 지운다 — 이제 그 단계의 실제 기록이 있다 */
function clearWiped(retry: VerifyRetryState | undefined, phase: "test" | "integrate"): void {
  if (!retry?.wiped?.[phase]) return;
  const rest: WipedRuns = { ...retry.wiped };
  delete rest[phase];
  if (rest.test || rest.integrate) retry.wiped = rest;
  else delete retry.wiped;
}

// ---- fix 의 재현 ----

/**
 * 재현을 판정한다. **실패(failed)만 재현으로 인정한다** — `not-run`·`error` 는 아무것도 증명하지 않고,
 * `passed` 는 결함을 찌르지 못한 테스트다.
 */
function reproProblem(runs: VerifyRun[], found: TestCaseEvidence[]): { problem: string; class: ReproAttemptClass } | undefined {
  const broken = runs.find((run) => run.outcome === "error" || run.outcome === "not-run");
  if (broken?.environment) {
    return {
      class: "environment",
      problem:
        `재현 실행이 환경 오류로 실패했습니다 (${broken.kind}: 출력에 "${broken.environment}") — 결함을 찌른 실패가 아니라 ` +
        "재현으로 인정하지 않습니다. 환경을 고친 뒤 code-agent repro 를 다시 실행하세요.",
    };
  }
  if (broken) {
    const cls = runClass(broken);
    return {
      class: cls === "timeout" ? "interrupted" : cls === "precondition" ? "precondition" : "environment",
      problem:
        `재현 명령이 돌지 못했습니다 (${broken.kind}: ${broken.outcome}) — ` +
        "재현은 실패(failed)만 인정합니다. not-run·error 는 아무것도 증명하지 않습니다.",
    };
  }
  if (!runs.some((run) => run.outcome === "failed")) {
    return {
      class: "result-unconfirmed",
      problem:
        `재현하지 못했습니다 — ${runs.map((run) => `${run.kind}: ${run.outcome}`).join(", ")}. ` +
        "지금 코드에서 **실패**하는 테스트라야 결함을 재현한 것입니다. " +
        "⑦ 의 `## 재현` 케이스가 결함을 실제로 찌르는지 다시 보세요.",
    };
  }
  const uncovered = found.filter((entry) => entry.status !== "failed").map((entry) => entry.id);
  if (uncovered.length > 0) {
    return {
      class: "result-unconfirmed",
      problem:
        `재현 TC 가 실패한 실행의 출력에 없습니다: ${uncovered.join(", ")} (실제 실패 결과가 필요합니다) — ` +
        "재현은 **실패한 실행이 그 TC 를 찍어야** 증거가 됩니다. 테스트 파일에 id 가 적혀 있다는 것은 " +
        "무엇이 실패했는지 말해 주지 않습니다(다른 TC 의 실패·깨진 import 도 같은 실패로 보입니다).\n" +
        "컨벤션의 `테스트 규칙` 대로 테스트 이름에 TC id 를 남겨, 실패 보고에 그 id 가 찍히게 하세요.",
    };
  }
  return undefined;
}

/** class 가 없는 옛 재현 시도의 원인 — problem 문구로 추정한다. 종류 이름에 `-`·`:` 가 있어도(e2e-test, plugin:x) 맞는다 */
export function legacyReproClass(problem: string): ReproAttemptClass {
  if (/환경 오류로 실패했습니다/.test(problem)) return "environment";
  if (/\([^()]+: error\)/.test(problem)) return "environment";
  if (/\([^()]+: not-run\)/.test(problem)) return "precondition";
  return "result-unconfirmed";
}

/** `remainingNote` 를 쓰지 않는다 — 그 문구는 "code-agent check 부터" 라 재현 자리에서는 거짓말이 된다 */
function reproSummary(work: Work, evidence: Evidence): string {
  const runs = runsOf(evidence, "repro");
  const lines = [
    `# code-agent repro — ${work.active.id}`,
    "",
    ...runs.map(
      (run) =>
        `- ${run.kind}: ${run.outcome}${run.command ? ` (${shortCommand(run.command)})` : " — code-agent.json 에 선언이 없습니다"}` +
        `${run.logFile ? ` · 로그 ${run.logFile}` : ""}`,
    ),
    "",
    `재현 TC: ${(evidence.repro?.cases ?? []).join(", ")} · 테스트 트리 ${evidence.repro?.testTreeHash ?? "없음"}`,
    `⑧ ${validationDocFile(work.active.id)} 를 렌더했습니다.`,
    evidence.repro?.mode === "log"
      ? `로그 근거로 진행합니다(${evidence.repro.basis?.detail ?? ""}) — 수정 전 결과: ${evidence.repro.found.map((entry) => `${entry.id} ${entry.status ?? "unknown"}`).join(", ")}. ` +
        "이제 고칠 파일을 쓸 수 있고, 이 TC 는 회귀 TC 로 수정 후 통과해야 합니다. kind:\"test\" 단계의 파일은 여기서 얼었습니다."
      : "재현을 봤습니다 — 이제 고칠 파일을 쓸 수 있습니다. kind:\"test\" 단계의 파일은 여기서 얼었습니다.",
  ];
  for (const run of runs.filter((entry) => entry.outcome === "failed")) {
    lines.push("", `## ${run.kind} 실패 — 재현입니다 (마지막 40줄${wholeLog(run)})`, "```", run.tail.trimEnd() || "(출력 없음)", "```");
  }
  return lines.join("\n");
}

/**
 * fix 의 재현 — 고칠 파일을 쓰기 **전에**, 테스트만 바뀐 트리에서 재현 TC 가 실패하는 것을 본다.
 *
 * 순서가 곧 규칙이다. 재현을 본 뒤에 쓴 테스트는 결함을 재현한 적이 없으므로, 이 명령이 남기는
 * 증거는 "무엇을, 어떤 테스트 트리 위에서 봤는가" 로 묶인다 (hook 이 그 묶임을 대조한다).
 */
export async function repro(work: Work): Promise<string> {
  const { repoRoot, active } = work;
  const baseCommit = requireEvidenceBase(work);

  // requireCleanPlan 을 그대로 쓰지 않는다 — 재현은 고칠 파일을 **쓰기 전에** 본다. 계획이 새 파일을
  // 만들기로 했으면 그 파일은 아직 없고, hook 이 재현 전에는 그것을 쓰지 못하게 막는다. 계획 파일이
  // 전부 있어야 한다고 걸면 그런 계획은 재현도 구현도 못 하는 교착이 된다.
  const outside = outsideChanges(work);
  const missingTests = testStageFiles(work).filter((path) => !existsSync(join(repoRoot, path)));
  if (outside.length > 0 || missingTests.length > 0) {
    throw new Stop(
      "계획과 실제 변경이 어긋나 재현을 돌리지 않았습니다:\n" +
        [
          ...outside.map((change) => `  - 계획 밖 변경 [${change.status}] ${change.path}`),
          ...missingTests.map((path) => `  - kind:"test" 단계의 계획 파일이 아직 없습니다: ${path}`),
        ].join("\n") +
        `\n재현 테스트를 먼저 쓰고 다시 돌리세요.`,
    );
  }

  // 재현은 "테스트만 바뀐 트리" 에서 봐야 증거가 된다 — 이미 고쳐 둔 코드 위의 실패는 재현이 아니다
  const tests = new Set(testStageFiles(work));
  const planned = new Set(planPaths(work));
  const dirty = changedPaths(repoRoot, baseCommit).filter((change) => planned.has(change.path) && !tests.has(change.path));
  // treeHash 를 이어받는다 — 재현은 계획 파일 전체를 검증하지 않으므로 옛 회차의 check·test 를 지금 트리에 묶지 않는다
  const evidence = carryForRepro(work, baseCommit);
  // 첫 재현은 구현 전에 한다. 검증 이후 테스트 보완은 기준 코드 위에서 다시 재현한다.
  const refreshing = !!evidence.repro && evidence.runs.some((run) => run.phase === "check");
  if (dirty.length > 0 && !refreshing) {
    throw new Stop(
      `재현을 보기 전에 이미 바뀐 계획 파일이 있습니다: ${dirty.map((change) => `[${change.status}] ${change.path}`).join(", ")}\n` +
        "재현은 \"테스트만 바뀐 트리\" 에서 봐야 증거가 됩니다 — 되돌린 뒤 다시 돌리세요.",
    );
  }

  const spec = readWorkDoc(repoRoot, active.id, "07-test-spec");
  const cases = spec ? reproCases(spec) : [];
  if (cases.length === 0) {
    throw new Stop(
      `${workDocPath(active.id, "07-test-spec")} — fix 는 \`## 재현\` 절에 결함을 재현하는 TC id 를 최소 하나 적습니다 (\`- TC-1\`). 수준은 무엇이든 됩니다.`,
    );
  }

  if (evidence.repro && evidence.repro.testTreeHash === testTreeHashNow(work) && !reproResultProblem(work, evidence)) {
    return `이미 재현을 봤습니다 (${evidence.repro.cases.join(", ")} · ${evidence.repro.at}). 고칠 파일을 쓰세요.`;
  }

  const logged = errorLogOf(readFileSync(join(repoRoot, active.spec), "utf-8"));
  const logNote = logged && "log" in logged
    ? "로컬에서 재현되지 않는 결함이면 오류 로그를 근거로 고칠 수 있습니다 — 시도 기록을 보여 주고 사람에게 확인받으세요 (ca-answer 의 repro-log 동의). 확인 없이 고칠 파일을 쓰지 않습니다."
    : "지시서에 오류 로그가 없어 로그 근거로 넘어갈 수 없습니다 — 재현 테스트를 다시 보거나 고치지 말고 보고하세요.";

  // 격리 재현은 통합 검증과 같은 체크아웃 표지를 쥔다 — 실행 중이면 아무것도 기록하지 않고 멈춘다(시도를 쓰지 않는다)
  const claim = refreshing ? claimWorktree(work, { phase: "repro", round: 0 }) : undefined;
  try {
    // 0회차 — 고쳐 쓰기 회차가 아니다. 재현이 한도를 잡아먹으면 고칠 기회가 한 번 줄어든다
    const specs = testCommands(repoRoot, work.manifest);
    const testHash = testTreeHashNow(work);

    // 시도 판정 — 실행 전에 기록한다. 같은 테스트 트리로 재현하지 못했으면 다시 돌려도 같다
    const retry = verifyRetryOf(evidence);
    const state = retry.repro ?? { trees: [], reruns: {} };
    const attemptLimit = limitOf("reproAttempt", LIMITS.reproAttempt, retry.grants, grantScope({ file: "verify", key: "reproAttempt" }));
    const rerunLimit = limitOf("reproRerun", LIMITS.reproRerun, retry.grants, grantScope({ file: "verify", key: "reproRerun", tree: testHash }));
    if (state.trees.includes(testHash)) {
      const prior = evidence.reproAttempt?.testTreeHash === testHash ? evidence.reproAttempt : undefined;
      // 트리별 원인(classes)이 정본이다 — 뒤 트리의 시도 기록이 reproAttempt 를 덮어도 남는다. 없는 옛 기록은 같은 트리의
      // 시도 기록으로 추정하고, 그것도 없으면 시도를 기록했는데 끝 기록이 없다 = 끊겼다
      const cls: ReproAttemptClass = state.classes?.[testHash] ?? (prior ? prior.class ?? legacyReproClass(prior.problem) : "interrupted");
      if (cls === "environment" || cls === "interrupted") {
        const used = state.reruns[testHash] ?? 0;
        if (used + 1 > rerunLimit) {
          const refused = failure("limit-exceeded", `${COUNTER_LABEL.reproRerun} 한도 ${rerunLimit}회 소진`, { origin: cls, counter: { key: "reproRerun", used, limit: rerunLimit } });
          throw new RetryRefused(refused, `${limitExceededText(refused, validationDocFile(active.id))}\n${logNote}`);
        }
        state.reruns[testHash] = used + 1;
      } else {
        const left = Math.max(0, attemptLimit - state.trees.length);
        const message =
          `같은 테스트 트리로 이미 재현하지 못했습니다${prior ? `(${prior.at}: ${prior.problem.split("\n")[0]})` : ""} — 다시 돌려도 같습니다. ` +
          `재현 테스트를 고쳐 새로 시도하세요(남은 재현 시도 ${left}회). ${logNote}`;
        throw new RetryRefused(failure(cls, message), message);
      }
    } else {
      if (state.trees.length >= attemptLimit) {
        const message = `재현 시도 ${attemptLimit}회(서로 다른 테스트 트리)를 모두 썼습니다 — 자동으로 더 시도하지 않습니다. ${logNote}`;
        throw new RetryRefused(
          failure("limit-exceeded", message, { origin: "result-unconfirmed", counter: { key: "reproAttempt", used: state.trees.length, limit: attemptLimit } }),
          message,
        );
      }
      state.trees.push(testHash);
    }
    retry.repro = state;
    evidence.retry = retry;
    /** 이 트리의 시도가 끝난 원인 — 다음 시도가 같은 트리면 이것으로 다시 돌릴지 가른다 */
    const classify = (cls: ReproAttemptClass) => { state.classes = { ...(state.classes ?? {}), [testHash]: cls }; };
    const attemptNote = () =>
      `(남은 재현 시도 ${Math.max(0, attemptLimit - state.trees.length)}회 · 이 트리의 재실행 ${Math.max(0, rerunLimit - (state.reruns[testHash] ?? 0))}회)`;

    const at = new Date().toISOString();
    let result: { runs: VerifyRun[]; outputs: string[]; guarded: string[] };
    if (claim) {
      result = await inCleanWorktree(work, baseCommit, async (cwd) => {
        // 시도는 명령을 돌리기 전에 기록한다 — worktree 를 만든 **뒤**라, 만들지 못해 멈추면 시도로 세지 않는다
        persist(work, evidence);
        const prep = prepareCommand(work.manifest);
        if (prep) {
          const prepared = await runSpecs(work, "repro", 0, [prep], cwd);
          if (prepared.runs.some((run) => run.outcome !== "passed")) {
            // 실패한 준비도 시도 기록에 남긴다 — 같은 트리의 다음 시도는 환경 재실행으로 센다
            evidence.reproAttempt = { at, testTreeHash: testHash, cases, found: [], problem: "격리 재현의 의존성 준비에 실패했습니다", class: "environment" };
            classify("environment");
            persist(work, evidence);
            throw new Stop("격리 재현의 의존성 준비에 실패했습니다 — 작업 코드는 보존했습니다. 준비 로그를 확인하고 code-agent repro로 다시 실행하세요.");
          }
        }
        return runSpecs(work, "repro", 0, specs, cwd);
      }, (path) => tests.has(path), claim.worktree);
    } else {
      persist(work, evidence);
      result = await runSpecs(work, "repro", 0, specs);
    }
    const { runs, outputs, guarded } = result;
    replaceRuns(evidence, "repro", 0, runs);
    if (guarded.length) {
      // 검증 명령이 code-agent 기록을 바꾼 재현은 재현이 아니다 — 같은 테스트 트리로 다시 돌려도 같다(전제 미충족)
      const problem = stateGuardText(guarded);
      evidence.reproAttempt = { at, testTreeHash: testHash, cases, found: [], problem, class: "precondition" };
      classify("precondition");
      persist(work, evidence);
      throw new Stop(`${problem}\n⑧ ${validationDocFile(active.id)} 에 실행 기록을 남겼습니다.\n${logNote} ${attemptNote()}`);
    }

    // ⑧ 의 두 갈래(출력 · 테스트 파일)를 여기서는 쓰지 않는다. 재현이 주장하는 것은 "그 TC 가 실패했다"
    // 인데, 파일 안에 id 가 있다는 것은 무엇이 실패했는지 말해 주지 않는다 — 다른 TC 의 실패도, 깨진
    // import 도 같은 `failed` 로 보인다. **실패한 실행의 출력**만 본다.
    // 같은 실행에서 다른 TC가 실패했더라도 재현 대상 TC 자체가 failed여야 한다.
    // 로그 근거는 수정 전 결과를 기록만 한다 — 통과도 남겨야 하므로 실패한 실행만이 아니라 전체 출력에서 읽는다
    const reproBasis = reproBasisOf(work, evidence);
    const failedOutput = outputs.filter((_, index) => reproBasis.mode === "log" || runs[index].outcome === "failed").join("\n");
    const found = testCaseEvidence(work, failedOutput).filter((entry) => cases.includes(entry.id));
    for (const id of cases) if (!found.some((entry) => entry.id === id)) found.push({ id, source: "없음", status: "unknown" });
    const judged = reproBasis.mode === "log" ? undefined : reproProblem(runs, found);
    if (judged) {
      // 판정에 실패해도 무엇을 돌렸는지는 남긴다 — 로그 근거 전환을 사람이 판단할 시도 기록이다
      evidence.reproAttempt = { at, testTreeHash: testHash, cases, found, problem: judged.problem, class: judged.class };
      classify(judged.class);
      persist(work, evidence);
      throw new Stop(`${judged.problem}\n⑧ ${validationDocFile(active.id)} 에 실행 기록을 남겼습니다.\n${logNote} ${attemptNote()}`);
    }

    if (testHash !== testTreeHashNow(work)) throw new Stop("재현 중 테스트 파일이 바뀌었습니다 — 다시 재현하세요.");
    evidence.repro = {
      at, testTreeHash: testHash, cases, found,
      ...(reproBasis.mode === "log" ? { mode: "log" as const, basis: reproBasis.basis } : {}),
    };
    delete evidence.reproAttempt;
    // 재현을 봤다 — 시도 카운터는 다음 갱신을 위해 비운다
    evidence.retry = { ...retry, repro: { trees: [], reruns: {} } };
    persist(work, evidence);
    return [
      reproSummary(work, evidence) + (claim ? "\n기준 코드와 수정된 테스트로 격리 재현을 갱신했습니다. 작업 코드는 그대로 보존했습니다." : ""),
      ...(claim ? claimNotes(claim) : []),
    ].join("\n");
  } finally {
    claim?.release();
  }
}

/**
 * 로컬에서 재현되지 않은 결함을 오류 로그 근거로 고치기로 사람이 확인한다 — ca-answer 의 repro-log 동의로만 온다.
 * 확인 전에는 아무것도 바꾸지 않는다(동의 준비가 확인 지점에서 끊는다).
 */
export function approveLogBasis(work: Work): string {
  if (work.order.kind !== "fix" || work.active.phase !== "implement") throw new Stop("로그 근거 전환은 fix 의 구현 단계에서만 합니다.");
  const evidence = loadEvidence(work.repoRoot, work.active.id, work.active.target);
  const attempt = evidence?.reproAttempt;
  if (evidence?.repro) throw new Stop("이미 재현(또는 로그 근거) 기록이 있습니다 — 고칠 파일을 쓰면 됩니다.");
  if (!evidence || !attempt) throw new Stop("로컬 재현 시도 기록이 없습니다 — code-agent repro 를 먼저 돌리세요.");
  if (attempt.testTreeHash !== testTreeHashNow(work)) throw new Stop("재현을 시도한 뒤 테스트 파일이 바뀌었습니다 — code-agent repro 로 다시 시도하세요.");
  const logged = errorLogOf(readFileSync(join(work.repoRoot, work.active.spec), "utf-8"));
  if (!logged || !("log" in logged)) throw new Stop("지시서에 오류 로그가 없어 로그 근거로 고칠 수 없습니다 — 재현되지 않은 결함은 보고합니다.");
  const excerpt = logged.log.replace(/\r\n/g, "\n").split("\n");
  const shown = [
    `${work.active.id} — 로컬에서 재현되지 않았습니다 (${attempt.at})`,
    `- 판정: ${attempt.problem.split("\n")[0]}`,
    `- 재현 TC 수정 전 결과: ${attempt.found.map((entry) => `${entry.id} ${entry.status ?? "unknown"}`).join(", ")}`,
    "- 오류 로그(앞부분):",
    ...excerpt.slice(0, 12).map((line) => `    ${line}`),
    ...(excerpt.length > 12 ? [`    … ${excerpt.length - 12}줄 더 (${work.active.spec})`] : []),
    "",
    "로컬 재현 없이 오류 로그를 근거로 고칠 파일을 엽니다. 위 TC 는 회귀 TC 로 남아 수정 후 통과해야 하고 테스트 파일은 지금 얼립니다.",
    "반영 기록에 '로그 근거 · 운영 확인 필요' 가 남습니다.",
  ].join("\n");
  const presence = confirmOnTerminal(shown, "로그 근거");
  const basis: LogBasis = { by: "approved", at: new Date().toISOString(), detail: presence.detail };
  evidence.logBasis = basis;
  evidence.repro = { at: attempt.at, testTreeHash: attempt.testTreeHash, cases: attempt.cases, found: attempt.found, mode: "log", basis };
  delete evidence.reproAttempt;
  // 재현을 본 것과 같다 — 시도 카운터를 비운다. 남기면 리뷰 지적으로 재현 테스트를 보완한 뒤의 격리 재현 갱신이
  // 확인 전의 시도로 재현 시도 한도에 걸려, 이미 받은 repro-log 동의를 다시 요구한다
  evidence.retry = { ...verifyRetryOf(evidence), repro: { trees: [], reruns: {} } };
  persist(work, evidence);
  return `로그 근거로 진행합니다 — 고칠 파일을 쓸 수 있습니다. ${attempt.cases.join(", ")} 는 회귀 TC 로 수정 후 통과해야 합니다.`;
}

/** 회차 판정 전의 빈 예산 — 첫 회차(`none`)는 예산을 보지 않는다 */
function emptyBudget(work: Work): VerifyBudget {
  return verifyBudget({ retry: { version: 1, causes: {}, reruns: {}, integrateReruns: {}, grants: [] }, round: 0,
    fixRounds: work.manifest.fixRounds, reviewRounds: { used: 0, limit: LIMITS.reviewRounds } });
}

/** 회차 거부의 문구 — 고쳐 쓰기는 지금까지의 문구를 앞에 두고, 그 밖의 카운터는 한도 안내, 전제는 전제 안내다 */
function refusalText(work: Work, refused: FailureRecord, evidence?: Evidence): string {
  if (refused.class === "precondition") {
    // 같은 코드로 다시 돌리려는 전제 미충족 회차 — 검증 명령이 code-agent 기록을 바꾼 실행이면 그 사실을 그대로 말한다
    const guarded = evidence ? guardedFiles(evidence) : [];
    return guidance("precondition", { problems: guarded.length ? stateGuardText(guarded) : refused.detail });
  }
  if (refused.counter?.key === "fix") {
    return `고쳐 쓰기 ${refused.counter.limit}회를 이미 넘겨 다시 돌리지 않았습니다 — 덮지 않고 보고하는 자리입니다.\n` +
      `${questionsFile(work.active.id)} 에 무엇이 막혔는지 적고 사람에게 알리세요. ` +
      "사람이 고릅니다: 한 번 더 허용(ca-answer 의 judgment 동의) · 계획을 고쳐 재승인 · 작업 종료(abort).";
  }
  if (refused.class === "limit-exceeded") return limitExceededText(refused, validationDocFile(work.active.id));
  return refused.detail;
}

/**
 * 새 회차를 열 때 테스트 동결 기준을 다시 굳힌다. 받아들이는 변경은 수집 수정 회차의 kind:test 파일 전부, 또는 ⑨ 지적으로
 * 연 파일(review.json used)뿐이다. 받아들이지 않은 변경은 기준에 남아 test·integrate 게이트가 testFreezeProblems 로 잡는다.
 * review.json 은 여기서만 읽는다 — 게이트(evidence.ts)는 증거만 대조한다.
 *
 * ⑨ 지적으로 연 파일은 **리뷰 회차마다 한 번** 받아들인다. hook 은 review 단계의 열린 지적에만 그 파일을 열고, 그 뒤 첫
 * check 가 기준을 갱신한다. 같은 리뷰 회차 안에서 다시 바뀐 것(check 로 되감긴 뒤 hook 을 거치지 않은 변경)은 받아들이지
 * 않는다 — used 는 묶임 안의 모든 회차에 누적되므로 경로만 보면 한 번 열린 파일이 이후 조용히 기준이 된다.
 */
function rebaseTestFreeze(work: Work, evidence: Evidence, by: "collect" | "finding"): void {
  const freeze = evidence.testFreeze;
  if (!freeze) return;
  const now = fileHashes(work.repoRoot, testStageFiles(work));
  const changed = [...new Set([...Object.keys(freeze.files), ...Object.keys(now)])].sort().filter((path) => freeze.files[path] !== now[path]);
  const usage = by === "finding" ? reviewRoundUsage(work) : undefined;
  const opened = !usage ? changed : changed.filter((path) => usage.usedPaths.includes(path) &&
    !(freeze.rebased ?? []).some((entry) => entry.by === "finding" && entry.reviewRound === usage.used && entry.files.includes(path)));
  if (opened.length === 0) return;
  for (const path of opened) {
    if (now[path] === undefined) delete freeze.files[path];
    else freeze.files[path] = now[path];
  }
  freeze.rebased = [...(freeze.rebased ?? []),
    { round: evidence.rounds, at: new Date().toISOString(), by, files: opened, ...(usage ? { reviewRound: usage.used } : {}) }];
}

/** 7 정적 분석·컴파일 — build + 품질·보안 기준이 적은 명령 */
export async function check(work: Work, options: { retry?: boolean; note?: boolean } = {}): Promise<string> {
  const baseCommit = requireEvidenceBase(work);
  requireCleanPlan(work);

  const bound = boundEvidence(work);
  // 실행 중인 test·통합 검증 위에 돌지 않는다 — 서로의 증거를 덮는다
  if (bound) requireNotRunning(work, verifyRetryOf(bound));

  // 1) 회차 판정 — 실행 전에, 아무것도 쓰기 전에. 진입점(check 직접·verify·--retry)과 무관하게 이 한 곳이다
  const view = bound ? verifyView(work, bound) : undefined;
  const treeChanged = !bound || bound.treeHash !== treeHashNow(work);
  const decision = nextRoundDecision({
    previous: view?.state ?? "none", emptyRound: view?.emptyRound ?? false, treeChanged,
    budget: view?.budget ?? emptyBudget(work), retry: !!options.retry, reviewOpenFindings: view?.reviewOpenFindings ?? false,
  });
  if (decision.action === "refuse") {
    // 리뷰를 열지 않은 채 통과 뒤 변경으로 쓴 리뷰 회차 — 허용은 리뷰 기록에 남으므로 받지 않는다. 안내(verify 의 decision·hook·다음:)가 같은 선택지를 싣게 표지를 단다
    if (decision.failure.counter?.key === "reviewRounds" && view && !view.reviewOpened) decision.failure.kind = "no-review";
    throw new RetryRefused(decision.failure, refusalText(work, decision.failure, bound));
  }

  // 2) fix 의 격리 재현 갱신 — 다음 회차가 허용된 뒤에만
  if (work.order.kind === "fix" && bound?.repro && bound.repro.testTreeHash !== testTreeHashNow(work)) {
    await repro(work);
  }

  // 3) 회차를 실행 **전에** 기록한다 — 뒤에 올리면 프로세스를 죽여 카운터를 피하는 길이 생긴다
  const evidence = carry(work, baseCommit);
  const retry = verifyRetryOf(evidence);
  const started = retry.started;
  delete retry.started; // 끊긴 test·integrate 표지는 위 판정에 이미 반영됐다(아래 재사용은 그 상태를 wiped 로 남긴다)
  if (!evidence.testFreeze && testFrozen(evidence)) {
    // 옛 증거의 추정 동결(실행 기록·TC 기록)을 아래 재사용이 실행 기록과 함께 지우기 전에 굳힌다
    evidence.testFreeze = { round: evidence.rounds, at: new Date().toISOString(), files: fileHashes(work.repoRoot, testStageFiles(work)) };
  }
  if (decision.action === "reuse") {
    // 같은 회차를 다시 쓴다 — 그 회차의 check·test·integrate 기록을 비워 test 도 다시 돌게 한다. 지우는 test·통합 검증의
    // 상태는 남긴다 — 다시 돌기 전에 코드를 고치면 그 상태(환경·중단·결과 미확인)로 센다. 지운 뒤 앞 회차를 이어받으면
    // "test 를 끊고 → check → 고치기" 가 고쳐 쓰기 대신 통과 뒤 변경으로 세어진다
    const round = evidence.rounds;
    const wipedState = (phase: "test" | "integrate"): VerifyState | undefined =>
      started?.phase === phase && started.round === round ? "interrupted"
        : evidence.runs.some((run) => run.phase === phase && run.round === round)
          ? verifyState({ phase, round, runs: evidence.runs, cases: phase === "test" ? evidence.testCases : evidence.integrationTestCases ?? [] })
          : undefined;
    const test = wipedState("test"), integrated = wipedState("integrate");
    const keep = retry.wiped;
    const wiped = {
      ...(test ? { test: { round, state: test } } : keep?.test ? { test: keep.test } : {}),
      ...(integrated ? { integrate: { round, state: integrated } } : keep?.integrate?.round === round ? { integrate: keep.integrate } : {}),
    };
    if (wiped.test || wiped.integrate) retry.wiped = wiped;
    else delete retry.wiped;
    evidence.runs = evidence.runs.filter((run) => !(run.round === round && run.phase !== "repro"));
    if (decision.counter === "rerun") retry.reruns[String(round)] = (retry.reruns[String(round)] ?? 0) + 1;
  } else {
    evidence.rounds += 1;
    retry.causes[String(evidence.rounds)] = decision.cause;
    // 지운 통합 검증 상태는 그 회차에만 든다. 지운 test 상태는 다음 test 가 돌 때까지 남는다(앞 회차 이어받기)
    if (retry.wiped?.integrate) clearWiped(retry, "integrate");
    if (evidence.testFreeze) rebaseTestFreeze(work, evidence, decision.cause === "collect" ? "collect" : "finding");
  }
  evidence.retry = retry;
  persist(work, evidence);

  const specs = checkCommands(work.repoRoot, work.manifest);
  const { runs } = await runSpecs(work, "check", evidence.rounds, specs);
  // 플러그인 검사는 런을 **더하기만** 한다 — 실패한 빌드를 통과로 만들 수 없다.
  // 호출이 실패해도 여기는 정상 종료한다: 알림 한 줄이 늘 뿐이다.
  const extra = pluginVerifyRuns(work, evidence.rounds);
  replaceRuns(evidence, "check", evidence.rounds, [...runs, ...extra.runs]);
  persist(work, evidence);
  return [summary(work, evidence, "check", specs, options.note ?? true), ...(extra.notice ? ["", extra.notice] : [])].join("\n");
}

/** 8 테스트 — test + 테스트 전략이 적은 명령. ⑦ 의 TC id 가 전부 확인돼야 넘어간다 */
export async function runTests(work: Work, options: { note?: boolean } = {}): Promise<string> {
  const baseCommit = requireEvidenceBase(work);
  requireCleanPlan(work);

  // carry 가 트리 해시를 다시 굳히기 **전에** 본다 — check 가 검증한 트리와 지금이 같아야
  // "정적 분석을 통과한 코드로 테스트했다" 가 성립한다.
  const before = loadEvidence(work.repoRoot, work.active.id, work.active.target);
  // 실행 중인 test·통합 검증 위에 돌지 않는다 — 서로의 증거를 덮는다
  if (before) requireNotRunning(work, verifyRetryOf(before));
  if (before && before.treeHash !== treeHashNow(work)) {
    throw new Stop("정적 분석·컴파일 뒤 계획 파일이 바뀌었습니다 — code-agent check 부터 다시 돌리세요.");
  }

  const evidence = carry(work, baseCommit);
  if (runsOf(evidence, "check").length === 0) {
    throw new Stop("정적 분석·컴파일을 먼저 돌려야 합니다: code-agent check");
  }

  // 같은 회차 재실행 판정 — 끊긴 test(시작 표지만 남음)나 이미 돈 test 를 같은 코드로 다시 돌린다.
  // code-agent test 를 직접 반복해 상한을 피하는 길을 막는다. 거부는 저장 전이다
  const round = evidence.rounds;
  const retry = verifyRetryOf(evidence);
  const interrupted = retry.started?.phase === "test" && retry.started.round === round;
  if (interrupted || evidence.runs.some((run) => run.phase === "test" && run.round === round)) {
    const state: VerifyState = interrupted ? "interrupted" : verifyState({ phase: "test", round, runs: evidence.runs, cases: evidence.testCases });
    const decision = sameRoundDecision({ previous: state, budget: verifyView(work, evidence).budget, key: "rerun" });
    if (decision.action === "refuse") throw new RetryRefused(decision.failure, refusalText(work, decision.failure, evidence));
    if (decision.counter) retry.reruns[String(round)] = (retry.reruns[String(round)] ?? 0) + 1;
  }
  // 시작 표지 — 명령을 돌리기 **전에** 저장한다. 앞 명령의 로그를 보고 끊어도 표지가 남아 끊긴 test 로 센다.
  // ⑧ 도 함께 렌더한다 — 재실행 수가 ⑧ 수정 루프 줄에 들어가므로, 저장만 하고 끊기면 ⑧ 이 증거와 어긋난다
  retry.started = { phase: "test", round, pid: process.pid, host: hostname(), at: new Date().toISOString() };
  evidence.retry = retry;
  persist(work, evidence);

  const specs = testCommands(work.repoRoot, work.manifest);
  const { runs, outputs, guarded } = await runSpecs(work, "test", round, specs);
  replaceRuns(evidence, "test", round, runs);
  // 기록을 바꾼 실행의 출력은 증거가 아니다 — TC 결과로 읽지 않고(미확인), 그 실행으로 테스트를 얼리지 않는다(runClass 가 전제 미충족)
  evidence.testCases = testCaseEvidence(work, guarded.length ? "" : outputs.join("\n"));
  delete evidence.retry.started;
  clearWiped(evidence.retry, "test");
  // 동결은 결과가 인식된(또는 코드 결함·시간 초과·선언된 환경 문구로 끝난 — 테스트가 실제로 돈) test 실행부터 — 그때의 kind:test 파일 해시를 기준으로 굳힌다
  const frozenBefore = testFrozen(before ?? evidence);
  if (!evidence.testFreeze && (frozenBefore || runs.some(freezingTestRun) || evidence.testCases.some((entry) => entry.source === "출력"))) {
    evidence.testFreeze = { round, at: new Date().toISOString(), files: fileHashes(work.repoRoot, testStageFiles(work)) };
  }
  persist(work, evidence);
  return summary(work, evidence, "test", specs, options.note ?? true);
}

// ---- 10 통합 검증 ----

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * 굳혀 둔 기준 커밋 위에 **깨끗한 worktree** 를 만들고 이 작업의 변경만 얹는다.
 *
 * `check`·`test` 는 사람이 보고 있는 작업 트리에서 돌아, 거기 남아 있던 산출물·부산물이 결과를
 * 떠받칠 수 있다. 통합 검증이 보는 것은 "기준 커밋 + 이 작업의 변경, 그것뿐일 때도 도는가" 다.
 * (`verifyByBuild` 를 쓰지 않는 이유 — 그것은 커밋을 검증하는데 새 흐름은 반영 전까지 아무것도
 * 커밋하지 않아, 수정이 하나도 없는 트리를 통과시킨다.)
 */
async function inCleanWorktree<T>(
  work: Work,
  baseCommit: string,
  run: (cwd: string) => Promise<T>,
  include: (path: string) => boolean = () => true,
  /** 표지(claimWorktree)가 정한 경로 — 스스로 만들지 않는다. 남은 것은 같은 체크아웃의 다음 실행이 정리한다 */
  worktree: string,
): Promise<T> {
  try {
    git(work.repoRoot, ["worktree", "add", "--detach", worktree, baseCommit]);
  } catch (error) {
    throw new Stop(
      `기준 커밋 위에 임시 worktree 를 만들지 못했습니다 (${baseCommit.slice(0, 12)}): ` +
        `${error instanceof Error ? error.message : error}`,
    );
  }
  try {
    for (const change of changedPaths(work.repoRoot, baseCommit)) {
      if (!include(change.path)) continue;
      const target = join(worktree, change.path);
      if (change.status === "D") {
        rmSync(target, { force: true });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(work.repoRoot, change.path), target);
    }
    return await run(worktree);
  } finally {
    removeWorktree(work.repoRoot, worktree);
  }
}

/**
 * 임시 worktree 정리는 결과를 잃게 하지 않는다 — Windows 에서는 남은 빌드 데몬·백신이 파일·디렉토리를 잡고 있어
 * 지우기가 EBUSY·EPERM 으로 실패할 수 있다. 여기서 던지면 이미 끝난 build·test 결과가 저장되기 전에 사라진다.
 */
function removeWorktree(repoRoot: string, worktree: string): void {
  try {
    git(repoRoot, ["worktree", "remove", "--force", worktree]);
    return;
  } catch {
    // 아래에서 직접 지우고 등록을 정리한다
  }
  try {
    rmSync(worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
  } catch (error) {
    process.stderr.write(`임시 worktree 를 지우지 못했습니다 — 잡고 있는 프로세스가 끝난 뒤 지우세요: ${worktree} (${error instanceof Error ? error.message : error})\n`);
  }
  try {
    git(repoRoot, ["worktree", "prune"]);
  } catch {
    // 등록만 남은 worktree 는 다음 prune 이 치운다
  }
}

// ---- 통합 검증·격리 재현의 임시 worktree 표지 ----

/** 임시 worktree 이름의 공통 접두어. 체크아웃 키를 붙여 `code-agent-integrate-<키 8자>-XXXXXX` 로 만든다 */
export const WORKTREE_PREFIX = "code-agent-integrate-";

/**
 * 체크아웃 키 — 저장소 실제 경로의 sha256 앞 8자(구분자는 `/`, Windows 는 소문자). git worktree 등록부는 저장소 하나에
 * 하나라 형제 체크아웃이 만든 임시 worktree 도 목록에 나온다. 이 키로 자기 체크아웃이 남긴 것만 가려 지운다.
 */
export function checkoutKey(repoRoot: string): string {
  let real = repoRoot;
  try { real = realpathSync.native(repoRoot); } catch { /* 없는 경로면 그대로 쓴다 */ }
  const normal = real.replace(/\\/g, "/");
  return createHash("sha256").update(process.platform === "win32" ? normal.toLowerCase() : normal).digest("hex").slice(0, 8);
}

/** `.code-agent/log/worktree.lock` — 체크아웃마다 하나인 통합 검증·격리 재현 실행 표지. 증거(verify.json) 저장과 섞지 않는다 */
export interface WorktreeMarker {
  pid: number; host: string; at: string; id: string; target: string; phase: "integrate" | "repro"; round: number; worktree: string;
}

export interface WorktreeClaim {
  worktree: string;
  /** 회수한 낡은 표지 */
  previous?: WorktreeMarker;
  /** 이 체크아웃이 남긴(끊긴 실행의) 임시 worktree 중 지운 것 */
  cleaned: string[];
  /** 다른 체크아웃·이전 버전 이름의 임시 worktree — 지우지 않고 보고만 한다 */
  foreign: string[];
  release(): void;
}

export function worktreeMarkerFile(repoRoot: string): string {
  return join(logDir(repoRoot), "worktree.lock");
}

/** 주인 기록 없는 표지(깨진 JSON)를 쓰는 중으로 보는 시간 */
const MARKER_WRITE_GRACE_MS = 10_000;

function readMarker(file: string): { text: string; owner?: WorktreeMarker; ageMs: number } | undefined {
  try {
    const text = readFileSync(file, "utf-8");
    try {
      const owner = JSON.parse(text) as WorktreeMarker;
      if (owner && typeof owner.pid === "number" && typeof owner.at === "string") return { text, owner, ageMs: Date.now() - Date.parse(owner.at) };
    } catch { /* 주인 없는 표지 */ }
    return { text, ageMs: Date.now() - statSync(file).mtimeMs };
  } catch {
    return undefined; // 그사이 지워졌다
  }
}

/**
 * 통합 검증·격리 재현의 표지를 쥐고 남은 임시 worktree 를 정리한다 — 카운터를 기록하기 **전에** 부른다.
 * 실행 중인 다른 실행이 있으면 아무것도 쓰지 않고 멈춘다. 낡은 표지는 회수하고 그 worktree 를 지운다(자기 키일 때만).
 */
function claimWorktree(work: Work, mark: { phase: "integrate" | "repro"; round: number }): WorktreeClaim {
  const { repoRoot } = work;
  const prefix = `${WORKTREE_PREFIX}${checkoutKey(repoRoot)}-`;
  const worktree = mkdtempSync(join(tmpdir(), prefix));
  // mkdtemp 가 만든 빈 디렉토리를 git 이 거부하므로 경로만 쓰고 생성은 git 에 맡긴다
  rmSync(worktree, { recursive: true, force: true });
  mkdirSync(logDir(repoRoot), { recursive: true });
  const file = worktreeMarkerFile(repoRoot);
  const marker: WorktreeMarker = {
    pid: process.pid, host: hostname(), at: new Date().toISOString(), id: work.active.id, target: work.active.target,
    phase: mark.phase, round: mark.round, worktree,
  };
  const create = (): boolean => {
    try {
      const fd = openSync(file, "wx");
      try { writeSync(fd, JSON.stringify(marker)); } finally { closeSync(fd); }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  };
  const label = (owner: WorktreeMarker) => owner.phase === "repro" ? "격리 재현" : "통합 검증";
  const running = (owner: WorktreeMarker) =>
    `(pid ${owner.pid}, ${owner.at} 시작, ${owner.id}) — 끝난 뒤 다시 실행하세요. 실행 중인 것이 없으면 사용자가 그 프로세스를 확인합니다.`;
  const cleaned: string[] = [];
  let previous: WorktreeMarker | undefined;
  if (!create()) {
    const found = readMarker(file);
    const staleMs = runStaleMs(work);
    const owner = found?.owner;
    if (found && owner && owner.host === hostname() && owner.pid !== process.pid && pidAlive(owner.pid) && found.ageMs < staleMs) {
      throw new Stop(`다른 ${label(owner)}이 이 체크아웃에서 실행 중입니다 ${running(owner)}`);
    }
    if (found && owner && owner.host !== hostname() && found.ageMs < staleMs) {
      throw new Stop(`다른 PC(${owner.host})의 ${label(owner)} 표지가 있습니다 ${running(owner)}`);
    }
    if (found && !owner && found.ageMs < MARKER_WRITE_GRACE_MS) {
      throw new Stop("통합 검증·격리 재현 표지를 쓰는 중입니다 — 잠시 뒤 다시 실행하세요.");
    }
    // 낡은 표지 — 끊긴 실행이다. 회수는 가드(lock.ts acquireLock) 안에서 다시 읽어 **본 표지 그대로일 때만** 지운다.
    // 가드 없이 읽기 → 지우기 → 만들기를 하면, 같은 낡은 표지를 둘이 회수할 때 한쪽이 새로 쥔 표지를 다른 쪽이 지워
    // 둘 다 표지를 쥐고, 뒤쪽의 자기 키 정리가 앞쪽의 실행 중 worktree 를 지운다
    const raced = "다른 통합 검증·격리 재현이 같은 표지를 방금 쥐었습니다 — 끝난 뒤 다시 실행하세요.";
    const releaseGuard = acquireLock(`${file}.reclaim`, {
      waitMs: TIMING.lockWaitMs, ageReclaim: true, label: "통합 검증·격리 재현 표지 회수", display: `${file}.reclaim`,
    });
    try {
      const again = readMarker(file);
      if (again && again.text !== found?.text) throw new Stop(raced);
      if (again) {
        try { unlinkSync(file); } catch { /* 이미 지워졌다 */ }
      }
      if (!create()) throw new Stop(raced);
    } finally {
      releaseGuard();
    }
    previous = owner;
    // 그 worktree 가 이 체크아웃의 것이고 **실제로 남아 있으면** 지운다. 만들기 전에 끊겼거나 이미 지운 뒤 끊긴 것은
    // 정리한 것이 아니다(등록만 남았으면 아래 목록 정리가 맡는다)
    if (owner?.worktree && basename(owner.worktree).startsWith(prefix) && existsSync(owner.worktree)) {
      removeWorktree(repoRoot, owner.worktree);
      if (!existsSync(owner.worktree)) cleaned.push(owner.worktree);
    }
  }
  // 정리 — 표지를 쥐고 있으므로 자기 키의 임시 worktree 는 실행 중인 것이 아니다. 다른 키·이전 버전 이름은 보고만 한다
  const foreign: string[] = [];
  let listed: string[] = [];
  try {
    listed = git(repoRoot, ["worktree", "list", "--porcelain"]).split(/\r?\n/)
      .filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
  } catch { /* 목록을 못 읽으면 정리 없이 진행한다 */ }
  for (const path of listed) {
    const name = basename(path);
    if (!name.startsWith(WORKTREE_PREFIX)) continue;
    if (name.startsWith(prefix)) {
      if (cleaned.some((done) => basename(done) === name)) continue;
      removeWorktree(repoRoot, path);
      if (!existsSync(path)) cleaned.push(path);
    } else {
      foreign.push(path);
    }
  }
  return {
    worktree, previous, cleaned, foreign,
    release() {
      try {
        const current = JSON.parse(readFileSync(file, "utf-8")) as WorktreeMarker;
        if (current.pid === process.pid && current.worktree === worktree) unlinkSync(file);
      } catch { /* 다음 실행이 낡은 표지로 회수한다 */ }
    },
  };
}

/** 표지의 정리·보고 줄 — integrate·격리 repro 결과에 덧붙인다 */
function claimNotes(claim: WorktreeClaim): string[] {
  return [
    ...(claim.cleaned.length ? [`이전에 끊긴 통합 검증·격리 재현의 임시 worktree ${claim.cleaned.length}개를 정리했습니다: ${claim.cleaned.join(", ")}`] : []),
    ...(claim.foreign.length
      ? [`이 체크아웃이 만들지 않은 임시 worktree ${claim.foreign.length}개는 지우지 않았습니다(다른 체크아웃에서 실행 중이거나 이전 버전이 남긴 것): ` +
          `${claim.foreign.join(", ")} — 실행 중인 것이 없으면 사용자가 git worktree remove --force <경로> 로 지웁니다.`]
      : []),
  ];
}

/** 10 통합 검증 — 깨끗한 worktree 에서 전체 build · test. 회차는 올리지 않는다 (올리는 것은 check 다) */
export async function integrate(work: Work): Promise<string> {
  const baseCommit = requireEvidenceBase(work);
  requireCleanPlan(work);

  // 리뷰가 본 트리와 지금이 같아야 한다 — 리뷰 뒤에 고친 코드를 통합 검증만 통과시켜 반영하는 길을 막는다
  const stale = reviewProblems(work);
  if (stale.length > 0) {
    throw new Stop(
      "코드 리뷰가 지금 트리 위에서 닫혀 있지 않아 통합 검증을 돌리지 않았습니다:\n" +
        stale.map((problem) => `  - ${problem}`).join("\n"),
    );
  }

  const before = loadEvidence(work.repoRoot, work.active.id, work.active.target);
  if (before && before.treeHash !== treeHashNow(work)) {
    throw new Stop("검증 뒤 계획 파일이 바뀌었습니다 — code-agent check 부터 다시 돌리세요.");
  }
  const evidence = carry(work, baseCommit);
  if (runsOf(evidence, "test").length === 0) {
    throw new Stop("테스트를 먼저 돌려야 합니다: code-agent test");
  }

  // 순서가 규칙이다 — 표지를 쥐는 것이 카운터 기록보다 앞이다. 실행 중이라 멈출 때는 아무것도 기록하지 않는다
  const claim = claimWorktree(work, { phase: "integrate", round: evidence.rounds });
  try {
    const round = evidence.rounds;
    const retry = verifyRetryOf(evidence);
    // 시작 표지가 이 회차의 integrate 로 남아 있다 = 끝 기록 없이 끊겼다. 실행 중인 것은 표지가 이미 막았다
    const interrupted = retry.started?.phase === "integrate" && retry.started.round === round;
    const interruptedAt = interrupted ? retry.started!.at : undefined;
    const integrateRuns = evidence.runs.filter((run) => run.phase === "integrate" && run.round === round);
    const previousState: VerifyState | undefined = interrupted ? "interrupted"
      : integrateRuns.length ? verifyState({ phase: "integrate", round, runs: evidence.runs, cases: evidence.integrationTestCases ?? [] }) : undefined;
    if (previousState) {
      const decision = sameRoundDecision({ previous: previousState, budget: verifyView(work, evidence).budget, key: "integrateRerun" });
      // 거부는 정리 뒤·저장 전이다 — 남은 worktree 는 정리되고 카운터·표지는 바뀌지 않는다
      if (decision.action === "refuse") throw new RetryRefused(decision.failure, refusalText(work, decision.failure, evidence));
      if (decision.counter) retry.integrateReruns[String(round)] = (retry.integrateReruns[String(round)] ?? 0) + 1;
    }
    retry.started = { phase: "integrate", round, pid: process.pid, host: hostname(), at: new Date().toISOString() };
    evidence.retry = retry;

    const specs = integrateCommands(work.manifest);
    // 준비 명령은 선언됐을 때만, build·test 앞에 한 번. 기준 커밋을 뜬 트리에는 의존성처럼
    // 커밋되지 않는 것이 없어서 두는 자리다.
    const prep = prepareCommand(work.manifest);
    const { runs, outputs } = await inCleanWorktree(work, baseCommit, async (cwd) => {
      // 명령을 돌리기 전에 카운터·시작 표지를 기록한다 — worktree 를 만든 **뒤**라, 만들지 못해 멈추면 아무것도 기록하지 않는다
      // (인프라 실패가 끊긴 실행으로 세어 재실행 카운터를 쓰지 않게). 트리가 같아야 돌므로 이어받은 treeHash 는 디스크와 같다
      persist(work, evidence);
      const first = prep
        ? await runSpecs(work, "integrate", round, [prep], cwd)
        : { runs: [] as VerifyRun[], outputs: [] as string[], guarded: [] as string[] };
      // 준비되지 않은 트리 위의 build·test 통과는 증거가 아니다 — 돌리지 않고 끝낸다
      if (first.runs.some((run) => run.outcome !== "passed")) {
        // 준비 실패는 계획이 아니라 매니페스트·환경의 문제다 — 결과(failed)는 그대로 두고 원인만 환경으로 단다
        for (const run of first.runs) if (run.outcome !== "passed" && !run.cause) run.cause = "environment";
        return first;
      }
      const rest = await runSpecs(work, "integrate", round, specs, cwd);
      return { runs: [...first.runs, ...rest.runs], outputs: [...first.outputs, ...rest.outputs], guarded: [...first.guarded, ...rest.guarded] };
    }, undefined, claim.worktree);
    replaceRuns(evidence, "integrate", round, runs);
    // 기록을 바꾼 실행(guard)의 출력은 증거가 아니다 — TC 결과로 읽지 않는다
    evidence.integrationTestCases = testCaseEvidence(work, runs.some((run) => run.cause === "guard") ? "" : outputs.filter((_, index) => runs[index].kind === "test").join("\n"));
    delete evidence.retry.started;
    clearWiped(evidence.retry, "integrate");
    persist(work, evidence);
    // 기록 변경(guard)으로 받지 않은 준비 명령은 환경 실패가 아니다 — 그 사실은 결과 줄(전제 미충족)이 말한다
    const stopped = runs.some((run) => run.kind === "prepare" && run.outcome !== "passed" && run.cause !== "guard");
    const left = verifyView(work, evidence).budget.integrateRerun.left;
    return [
      summary(work, evidence, "integrate", specs),
      "",
      `기준 커밋 ${baseCommit.slice(0, 12)} 위의 깨끗한 worktree 에서 돌렸습니다 — 작업 트리에 남아 있던 산출물은 끼지 않았습니다.`,
      // 다시 돌리는 안내(code-agent integrate·남은 통합 검증 재실행)는 위 결과 줄(remainingNote)이 한 번만 낸다
      ...(stopped
        ? ["준비 명령이 실패해 build·test 를 돌리지 않았습니다 — 준비되지 않은 트리 위의 통과는 증거가 아닙니다. 계획 파일이 아니라 환경 문제로 분류했습니다."]
        : []),
      ...(interrupted
        ? [`직전 통합 검증(${interruptedAt})이 끝 기록 없이 끊겼습니다 — 같은 회차로 다시 돌렸습니다(남은 통합 검증 재실행 ${left}회). ` +
            "오래 걸리면 셸 명령의 제한 시간을 가장 길게 주거나 백그라운드로 실행하세요."]
        : []),
      ...claimNotes(claim),
    ].join("\n");
  } finally {
    claim.release();
  }
}
