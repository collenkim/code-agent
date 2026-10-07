import { execFileSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { hashManifest, hashPlan } from "../core/approval";
import { writeAtomic } from "../core/atomic";
import { runCommand } from "../core/build";
import { errorLogOf } from "../core/workOrder";
import type { CommandResult } from "../core/build";
import {
  checkCommands,
  fixLimit,
  integrateCommands,
  loadEvidence,
  missingPlanFiles,
  outsideChanges,
  environmentBlocked,
  overFixLimit,
  planPaths,
  prepareCommand,
  preservedTestProblems,
  renderValidationDoc,
  runsOf,
  saveEvidence,
  testCaseEvidence,
  reproBasisOf,
  reproResultProblem,
  testCommands,
  testStageFiles,
  testTreeHashNow,
  treeHashNow,
  validationDocFile,
} from "./evidence";
import type { CommandSpec, Evidence, LogBasis, Outcome, TestCaseEvidence, VerifyPhase, VerifyRun } from "./evidence";
import { logDir, workDocsDir } from "./layout";
import { PLUGIN_LOG_DIR, pluginVerifyRuns } from "./plugins/run";
import { reviewProblems } from "./review";
import { Stop } from "./stop";
import { confirmOnTerminal } from "./tty";
import { freshTestReports, reportSnapshot } from "./testReports";
import { changedPaths } from "./tree";
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

function tailOf(text: string, lines: number): string {
  return text.split("\n").slice(-lines).join("\n");
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
  const missing = missingPlanFiles(work);
  // 기존 테스트 수정은 `계획 밖 변경` 으로도 잡히지만, 여기서 따로 말해야 무엇이 규칙인지가 보인다
  const preserved = preservedTestProblems(work);
  if (outside.length === 0 && missing.length === 0 && preserved.length === 0) {
    return;
  }
  throw new Stop(
    "계획과 실제 변경이 어긋나 검증을 돌리지 않았습니다 — 계획 밖 변경 위에서 나온 통과는 증거가 아닙니다:\n" +
      [
        ...outside.map((change) => `  - 계획 밖 변경 [${change.status}] ${change.path}`),
        ...missing.map((path) => `  - 계획에 있는데 없는 파일 ${path}`),
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

async function runSpecs(
  work: Work,
  phase: VerifyPhase,
  round: number,
  specs: CommandSpec[],
  /** 명령을 돌릴 자리. 통합 검증만 저장소가 아니라 임시 worktree 에서 돈다 */
  cwd: string = work.repoRoot,
  // 출력은 `runs` 와 자리를 맞춰 돌려준다 — 재현이 "**실패한 실행의** 출력" 만 보려면 갈라져 있어야 한다
): Promise<{ runs: VerifyRun[]; outputs: string[] }> {
  const runs: VerifyRun[] = [];
  const outputs: string[] = [];
  mkdirSync(logDir(work.repoRoot), { recursive: true });

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
    const reports = phase === "repro" || phase === "test" || (phase === "integrate" && spec.kind === "test") ? reportSnapshot(cwd) : undefined;
    const result = await runCommand(cwd, spec.argv, commandEnv, work.manifest.commandTimeoutMinutes * 60_000);
    const log = [result.stdout, result.stderr, reports ? freshTestReports(cwd, reports) : ""].filter(Boolean).join("\n").trim();
    // 선언된 환경 오류 문구가 실패 출력에 있으면 코드 결함이 아니라 환경 오류다 — 돌지 못한 것(error)과 같이 다룬다
    const environment = !result.error && result.status !== 0
      ? work.manifest.environmentErrors?.find((pattern) => log.includes(pattern))
      : undefined;
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
    });
  }
  return { runs, outputs };
}

function remainingNote(work: Work, evidence: Evidence, phase: VerifyPhase): string {
  const limit = fixLimit(work, evidence);
  const failed = runsOf(evidence, phase).filter((run) => run.outcome !== "passed");
  if (failed.length === 0) {
    const cases = phase === "test" ? evidence.testCases : phase === "integrate" ? evidence.integrationTestCases ?? [] : [];
    if (cases.some((entry) => entry.status !== "passed")) return "명령은 끝났지만 필수 TC의 성공이 확인되지 않았습니다. 테스트 결과 형식과 생략·실패 케이스를 확인하세요.";
    return "전부 통과했습니다 — code-agent next 로 다음 스테이지로.";
  }
  // 1회차는 처음 돌려 본 것이라 고쳐 쓰기로 세지 않는다 — 남는 것은 2·3회차다
  const left = limit + 1 - evidence.rounds;
  return left > 0
    ? `계획 안에서 고치고 code-agent check 부터 다시 돌리세요 (남은 고쳐 쓰기 ${left}회).`
    : `고쳐 쓰기 ${limit}회를 넘겼습니다 — 덮지 않고 보고합니다. 계획 파일은 더 고칠 수 없습니다(hook 이 거부합니다).\n` +
        `${workDocsDir(work.active.id)}/questions.md 에 무엇이 막혔는지 적고 사람에게 알리세요.`;
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

function summary(work: Work, evidence: Evidence, phase: VerifyPhase, specs: CommandSpec[]): string {
  const runs = runsOf(evidence, phase);
  const lines = [
    `# code-agent ${phase} — ${work.active.id} · ${evidence.rounds}회차`,
    "",
    ...runs.map((run) => `- ${run.kind}: ${run.outcome}${run.command ? ` (${run.command})` : " — code-agent.json 에 선언이 없습니다"}${run.logFile ? ` · 로그 ${run.logFile}` : ""}`),
  ];
  if (specs.every((spec) => !spec.argv)) {
    lines.push("", `!! ${phase} 로 돌릴 명령이 하나도 선언돼 있지 않습니다 — 검증 없이 통과할 수 없습니다.`);
  }
  if (phase === "test") {
    const missing = evidence.testCases.filter((entry) => entry.status !== "passed").map((entry) => `${entry.id}(${entry.status ?? "unknown"})`);
    lines.push(
      "",
      `⑦ 테스트 케이스: ${evidence.testCases.length}개 중 ${evidence.testCases.length - missing.length}개 확인` +
        (missing.length > 0 ? ` · 확인되지 않음 ${missing.join(", ")}` : ""),
    );
    if (work.stages.every((stage) => stage.kind !== "test")) {
      lines.push(`!! kind:"test" 단계가 선언돼 있지 않습니다 — 테스트 동결이 걸리지 않습니다 (code-agent.json 의 stages[].kind).`);
    }
  }
  for (const run of runs.filter((entry) => entry.outcome === "failed" || entry.outcome === "error")) {
    lines.push("", `## ${run.kind} 실패 (마지막 40줄${wholeLog(run)})`, "```", run.tail.trimEnd() || "(출력 없음)", "```");
  }
  lines.push("", `⑧ ${validationDocFile(work.active.id)} 를 렌더했습니다.`, remainingNote(work, evidence, phase));
  return lines.join("\n");
}

/**
 * 같은 회차를 다시 돌리면 앞의 기록을 **갈아 끼운다.**
 * 이어 붙이면 고쳐 쓰기 전의 실패가 같은 회차에 남아, 마지막 회차 판정이 영원히 실패로 읽힌다.
 */
function replaceRuns(evidence: Evidence, phase: VerifyPhase, round: number, runs: VerifyRun[]): void {
  evidence.runs = [...evidence.runs.filter((run) => !(run.phase === phase && run.round === round)), ...runs];
}

/** 증거를 쓰고 ⑧ 을 다시 렌더한다 — 둘은 한 벌이라 따로 두지 않는다 */
function persist(work: Work, evidence: Evidence): void {
  saveEvidence(work.repoRoot, evidence);
  writeAtomic(join(work.repoRoot, validationDocFile(work.active.id)), renderValidationDoc(work, evidence));
}

// ---- fix 의 재현 ----

/**
 * 재현을 판정한다. **실패(failed)만 재현으로 인정한다** — `not-run`·`error` 는 아무것도 증명하지 않고,
 * `passed` 는 결함을 찌르지 못한 테스트다.
 */
function reproProblem(runs: VerifyRun[], found: TestCaseEvidence[]): string | undefined {
  const broken = runs.find((run) => run.outcome === "error" || run.outcome === "not-run");
  if (broken?.environment) {
    return (
      `재현 실행이 환경 오류로 실패했습니다 (${broken.kind}: 출력에 "${broken.environment}") — 결함을 찌른 실패가 아니라 ` +
      "재현으로 인정하지 않습니다. 환경을 고친 뒤 code-agent repro 를 다시 실행하세요."
    );
  }
  if (broken) {
    return (
      `재현 명령이 돌지 못했습니다 (${broken.kind}: ${broken.outcome}) — ` +
      "재현은 실패(failed)만 인정합니다. not-run·error 는 아무것도 증명하지 않습니다."
    );
  }
  if (!runs.some((run) => run.outcome === "failed")) {
    return (
      `재현하지 못했습니다 — ${runs.map((run) => `${run.kind}: ${run.outcome}`).join(", ")}. ` +
      "지금 코드에서 **실패**하는 테스트라야 결함을 재현한 것입니다. " +
      "⑦ 의 `## 재현` 케이스가 결함을 실제로 찌르는지 다시 보세요."
    );
  }
  const uncovered = found.filter((entry) => entry.status !== "failed").map((entry) => entry.id);
  if (uncovered.length > 0) {
    return (
      `재현 TC 가 실패한 실행의 출력에 없습니다: ${uncovered.join(", ")} (실제 실패 결과가 필요합니다) — ` +
      "재현은 **실패한 실행이 그 TC 를 찍어야** 증거가 됩니다. 테스트 파일에 id 가 적혀 있다는 것은 " +
      "무엇이 실패했는지 말해 주지 않습니다(다른 TC 의 실패·깨진 import 도 같은 실패로 보입니다).\n" +
      "컨벤션의 `테스트 규칙` 대로 테스트 이름에 TC id 를 남겨, 실패 보고에 그 id 가 찍히게 하세요."
    );
  }
  return undefined;
}

/** `remainingNote` 를 쓰지 않는다 — 그 문구는 "code-agent check 부터" 라 재현 자리에서는 거짓말이 된다 */
function reproSummary(work: Work, evidence: Evidence): string {
  const runs = runsOf(evidence, "repro");
  const lines = [
    `# code-agent repro — ${work.active.id}`,
    "",
    ...runs.map(
      (run) =>
        `- ${run.kind}: ${run.outcome}${run.command ? ` (${run.command})` : " — code-agent.json 에 선언이 없습니다"}` +
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
  const evidence = carry(work, baseCommit);
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

  // 0회차 — 고쳐 쓰기 회차가 아니다. 재현이 한도를 잡아먹으면 고칠 기회가 한 번 줄어든다
  const specs = testCommands(repoRoot, work.manifest);
  const testHash = testTreeHashNow(work);
  const { runs, outputs } = refreshing
    ? await inCleanWorktree(work, baseCommit, async (cwd) => {
      const prep = prepareCommand(work.manifest);
      if (prep) {
        const prepared = await runSpecs(work, "repro", 0, [prep], cwd);
        if (prepared.runs.some((run) => run.outcome !== "passed")) {
          throw new Stop("격리 재현의 의존성 준비에 실패했습니다 — 작업 코드는 보존했습니다. 준비 로그를 확인하고 code-agent repro로 다시 실행하세요.");
        }
      }
      return runSpecs(work, "repro", 0, specs, cwd);
    }, (path) => tests.has(path))
    : await runSpecs(work, "repro", 0, specs);
  replaceRuns(evidence, "repro", 0, runs);

  // ⑧ 의 두 갈래(출력 · 테스트 파일)를 여기서는 쓰지 않는다. 재현이 주장하는 것은 "그 TC 가 실패했다"
  // 인데, 파일 안에 id 가 있다는 것은 무엇이 실패했는지 말해 주지 않는다 — 다른 TC 의 실패도, 깨진
  // import 도 같은 `failed` 로 보인다. **실패한 실행의 출력**만 본다.
  // 같은 실행에서 다른 TC가 실패했더라도 재현 대상 TC 자체가 failed여야 한다.
  // 로그 근거는 수정 전 결과를 기록만 한다 — 통과도 남겨야 하므로 실패한 실행만이 아니라 전체 출력에서 읽는다
  const reproBasis = reproBasisOf(work, evidence);
  const failedOutput = outputs.filter((_, index) => reproBasis.mode === "log" || runs[index].outcome === "failed").join("\n");
  const found = testCaseEvidence(work, failedOutput).filter((entry) => cases.includes(entry.id));
  for (const id of cases) if (!found.some((entry) => entry.id === id)) found.push({ id, source: "없음", status: "unknown" });
  const at = new Date().toISOString();
  const problem = reproBasis.mode === "log" ? undefined : reproProblem(runs, found);
  if (problem) {
    // 판정에 실패해도 무엇을 돌렸는지는 남긴다 — 로그 근거 전환을 사람이 판단할 시도 기록이다
    evidence.reproAttempt = { at, testTreeHash: testHash, cases, found, problem };
    persist(work, evidence);
    const logged = errorLogOf(readFileSync(join(repoRoot, active.spec), "utf-8"));
    throw new Stop(
      `${problem}\n⑧ ${validationDocFile(active.id)} 에 실행 기록을 남겼습니다.\n` +
        (logged && "log" in logged
          ? "로컬에서 재현되지 않는 결함이면 오류 로그를 근거로 고칠 수 있습니다 — 시도 기록을 보여 주고 사람에게 확인받으세요 (ca-answer 의 repro-log 동의). 확인 없이 고칠 파일을 쓰지 않습니다."
          : "지시서에 오류 로그가 없어 로그 근거로 넘어갈 수 없습니다 — 재현 테스트를 다시 보거나 고치지 말고 보고하세요."),
    );
  }

  if (testHash !== testTreeHashNow(work)) throw new Stop("재현 중 테스트 파일이 바뀌었습니다 — 다시 재현하세요.");
  evidence.repro = {
    at, testTreeHash: testHash, cases, found,
    ...(reproBasis.mode === "log" ? { mode: "log" as const, basis: reproBasis.basis } : {}),
  };
  delete evidence.reproAttempt;
  persist(work, evidence);
  return reproSummary(work, evidence) + (refreshing ? "\n기준 코드와 수정된 테스트로 격리 재현을 갱신했습니다. 작업 코드는 그대로 보존했습니다." : "");
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
  persist(work, evidence);
  return `로그 근거로 진행합니다 — 고칠 파일을 쓸 수 있습니다. ${attempt.cases.join(", ")} 는 회귀 TC 로 수정 후 통과해야 합니다.`;
}

/** 7 정적 분석·컴파일 — build + 품질·보안 기준이 적은 명령 */
export async function check(work: Work): Promise<string> {
  const baseCommit = requireEvidenceBase(work);
  requireCleanPlan(work);

  const previous = loadEvidence(work.repoRoot, work.active.id, work.active.target);
  if (work.order.kind === "fix" && previous?.repro && previous.repro.testTreeHash !== testTreeHashNow(work)) {
    await repro(work);
  }

  const evidence = carry(work, baseCommit);
  // 계획 파일이 그대로인 재실행 중 둘은 같은 회차를 다시 쓴다 — 코드를 고치지 않아 카운터를 피할 이득이 없다.
  //  · 직전 회차가 실행 기록 하나 없이 끊겼다(도구 타임아웃·강제 종료)
  //  · 직전 회차가 선언된 환경 오류(environmentErrors)로만 막혔다 — 그 회차 기록을 비우고 다시 돈다
  const unchanged = !!previous && evidence.rounds > 0 && previous.treeHash === evidence.treeHash;
  const interrupted = unchanged && !evidence.runs.some((run) => run.round === evidence.rounds);
  const environmentRetry = unchanged && environmentBlocked(evidence);
  if (!interrupted && !environmentRetry && overFixLimit(work, evidence)) {
    throw new Stop(
      `고쳐 쓰기 ${fixLimit(work, evidence)}회를 이미 넘겨 다시 돌리지 않았습니다 — 덮지 않고 보고하는 자리입니다.\n` +
        `${workDocsDir(work.active.id)}/questions.md 에 무엇이 막혔는지 적고 사람에게 알리세요. ` +
        "계획 자체를 고쳐야 하면 사람이 재승인해야 합니다.",
    );
  }
  // 회차는 실행 **전에** 올리고 저장한다 — 뒤에 올리면 프로세스를 죽여 카운터를 피하는 길이 생긴다.
  if (environmentRetry) evidence.runs = evidence.runs.filter((run) => run.round !== evidence.rounds);
  else if (!interrupted) evidence.rounds += 1;
  saveEvidence(work.repoRoot, evidence);

  const specs = checkCommands(work.repoRoot, work.manifest);
  const { runs } = await runSpecs(work, "check", evidence.rounds, specs);
  // 플러그인 검사는 런을 **더하기만** 한다 — 실패한 빌드를 통과로 만들 수 없다.
  // 호출이 실패해도 여기는 정상 종료한다: 알림 한 줄이 늘 뿐이다.
  const extra = pluginVerifyRuns(work, evidence.rounds);
  replaceRuns(evidence, "check", evidence.rounds, [...runs, ...extra.runs]);
  persist(work, evidence);
  return [summary(work, evidence, "check", specs), ...(extra.notice ? ["", extra.notice] : [])].join("\n");
}

/** 8 테스트 — test + 테스트 전략이 적은 명령. ⑦ 의 TC id 가 전부 확인돼야 넘어간다 */
export async function runTests(work: Work): Promise<string> {
  const baseCommit = requireEvidenceBase(work);
  requireCleanPlan(work);

  // carry 가 트리 해시를 다시 굳히기 **전에** 본다 — check 가 검증한 트리와 지금이 같아야
  // "정적 분석을 통과한 코드로 테스트했다" 가 성립한다.
  const before = loadEvidence(work.repoRoot, work.active.id, work.active.target);
  if (before && before.treeHash !== treeHashNow(work)) {
    throw new Stop("정적 분석·컴파일 뒤 계획 파일이 바뀌었습니다 — code-agent check 부터 다시 돌리세요.");
  }

  const evidence = carry(work, baseCommit);
  if (runsOf(evidence, "check").length === 0) {
    throw new Stop("정적 분석·컴파일을 먼저 돌려야 합니다: code-agent check");
  }

  const specs = testCommands(work.repoRoot, work.manifest);
  const { runs, outputs } = await runSpecs(work, "test", evidence.rounds, specs);
  replaceRuns(evidence, "test", evidence.rounds, runs);
  evidence.testCases = testCaseEvidence(work, outputs.join("\n"));
  persist(work, evidence);
  return summary(work, evidence, "test", specs);
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
async function inCleanWorktree<T>(work: Work, baseCommit: string, run: (cwd: string) => Promise<T>, include: (path: string) => boolean = () => true): Promise<T> {
  const worktree = mkdtempSync(join(tmpdir(), "code-agent-integrate-"));
  // mkdtemp 가 만든 빈 디렉토리를 git 이 거부하므로 경로만 쓰고 생성은 git 에 맡긴다
  rmSync(worktree, { recursive: true, force: true });
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

  const specs = integrateCommands(work.manifest);
  // 준비 명령은 선언됐을 때만, build·test 앞에 한 번. 기준 커밋을 뜬 트리에는 의존성처럼
  // 커밋되지 않는 것이 없어서 두는 자리다.
  const prep = prepareCommand(work.manifest);
  const { runs, outputs } = await inCleanWorktree(work, baseCommit, async (cwd) => {
    const first = prep
      ? await runSpecs(work, "integrate", evidence.rounds, [prep], cwd)
      : { runs: [] as VerifyRun[], outputs: [] as string[] };
    // 준비되지 않은 트리 위의 build·test 통과는 증거가 아니다 — 돌리지 않고 끝낸다
    if (first.runs.some((run) => run.outcome !== "passed")) {
      return first;
    }
    const rest = await runSpecs(work, "integrate", evidence.rounds, specs, cwd);
    return { runs: [...first.runs, ...rest.runs], outputs: [...first.outputs, ...rest.outputs] };
  });
  replaceRuns(evidence, "integrate", evidence.rounds, runs);
  evidence.integrationTestCases = testCaseEvidence(work, outputs.filter((_, index) => runs[index].kind === "test").join("\n"));
  persist(work, evidence);
  const stopped = runs.some((run) => run.kind === "prepare" && run.outcome !== "passed");
  return [
    summary(work, evidence, "integrate", specs),
    "",
    `기준 커밋 ${baseCommit.slice(0, 12)} 위의 깨끗한 worktree 에서 돌렸습니다 — 작업 트리에 남아 있던 산출물은 끼지 않았습니다.`,
    ...(stopped ? ["준비 명령이 실패해 build·test 를 돌리지 않았습니다 — 준비되지 않은 트리 위의 통과는 증거가 아닙니다."] : []),
  ].join("\n");
}
