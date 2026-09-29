import { execFileSync } from "child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { hashManifest, hashPlan } from "../core/approval";
import { writeAtomic } from "../core/atomic";
import { runCommand } from "../core/build";
import type { CommandResult } from "../core/build";
import {
  checkCommands,
  fixLimit,
  integrateCommands,
  loadEvidence,
  missingPlanFiles,
  outsideChanges,
  overFixLimit,
  renderValidationDoc,
  runsOf,
  saveEvidence,
  testCaseEvidence,
  testCommands,
  treeHashNow,
  validationDocFile,
} from "./evidence";
import type { CommandSpec, Evidence, Outcome, VerifyPhase, VerifyRun } from "./evidence";
import { logDir, workDocsDir } from "./layout";
import { reviewProblems } from "./review";
import { Stop } from "./stop";
import { changedPaths } from "./tree";
import type { Work } from "./work";

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

/** 실행 전 대조 — 계획 밖 변경과 사라진 계획 파일. 하나라도 있으면 명령을 돌리지 않는다 */
function requireCleanPlan(work: Work): void {
  const outside = outsideChanges(work);
  const missing = missingPlanFiles(work);
  if (outside.length === 0 && missing.length === 0) {
    return;
  }
  throw new Stop(
    "계획과 실제 변경이 어긋나 검증을 돌리지 않았습니다 — 계획 밖 변경 위에서 나온 통과는 증거가 아닙니다:\n" +
      [
        ...outside.map((change) => `  - 계획 밖 변경 [${change.status}] ${change.path}`),
        ...missing.map((path) => `  - 계획에 있는데 없는 파일 ${path}`),
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
): Promise<{ runs: VerifyRun[]; output: string }> {
  const runs: VerifyRun[] = [];
  const outputs: string[] = [];
  mkdirSync(logDir(work.repoRoot), { recursive: true });

  for (const spec of specs) {
    const at = new Date().toISOString();
    if (!spec.argv) {
      // 선언되지 않은 종류는 통과가 아니다 — 안 돌린 것을 통과로 읽으면 검증하지 않은 코드가 검증된 것이 된다
      runs.push({ round, phase, kind: spec.kind, command: "", outcome: "not-run", status: null, tail: "", at });
      continue;
    }
    const result = await runCommand(cwd, spec.argv);
    const log = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const outcome = outcomeOf(result);
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
      tail: [result.error ? `실행 실패: ${result.error.message}` : "", tailOf(log, outcome === "passed" ? 5 : 40)]
        .filter(Boolean)
        .join("\n"),
      at,
    });
  }
  return { runs, output: outputs.join("\n") };
}

function remainingNote(work: Work, evidence: Evidence, phase: VerifyPhase): string {
  const limit = fixLimit(work, evidence);
  const failed = runsOf(evidence, phase).filter((run) => run.outcome !== "passed");
  if (failed.length === 0) {
    return "전부 통과했습니다 — code-agent next 로 다음 스테이지로.";
  }
  // 1회차는 처음 돌려 본 것이라 고쳐 쓰기로 세지 않는다 — 남는 것은 2·3회차다
  const left = limit + 1 - evidence.rounds;
  return left > 0
    ? `계획 안에서 고치고 code-agent check 부터 다시 돌리세요 (남은 고쳐 쓰기 ${left}회).`
    : `고쳐 쓰기 ${limit}회를 넘겼습니다 — 덮지 않고 보고합니다. 계획 파일은 더 고칠 수 없습니다(hook 이 거부합니다).\n` +
        `${workDocsDir(work.active.id)}/questions.md 에 무엇이 막혔는지 적고 사람에게 알리세요.`;
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
    const missing = evidence.testCases.filter((entry) => entry.source === "없음").map((entry) => entry.id);
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
    lines.push("", `## ${run.kind} 실패 (마지막 40줄 — 전체는 ${run.logFile})`, "```", run.tail.trimEnd() || "(출력 없음)", "```");
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

/** 7 정적 분석·컴파일 — build + 품질·보안 기준이 적은 명령 */
export async function check(work: Work): Promise<string> {
  const baseCommit = requireEvidenceBase(work);
  requireCleanPlan(work);

  const evidence = carry(work, baseCommit);
  if (overFixLimit(work, evidence)) {
    throw new Stop(
      `고쳐 쓰기 ${fixLimit(work, evidence)}회를 이미 넘겨 다시 돌리지 않았습니다 — 덮지 않고 보고하는 자리입니다.\n` +
        `${workDocsDir(work.active.id)}/questions.md 에 무엇이 막혔는지 적고 사람에게 알리세요. ` +
        "계획 자체를 고쳐야 하면 사람이 재승인해야 합니다.",
    );
  }
  // 회차는 실행 **전에** 올리고 저장한다 — 뒤에 올리면 프로세스를 죽여 카운터를 피하는 길이 생긴다
  evidence.rounds += 1;
  saveEvidence(work.repoRoot, evidence);

  const specs = checkCommands(work.repoRoot, work.manifest);
  const { runs } = await runSpecs(work, "check", evidence.rounds, specs);
  replaceRuns(evidence, "check", evidence.rounds, runs);
  persist(work, evidence);
  return summary(work, evidence, "check", specs);
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
  const { runs, output } = await runSpecs(work, "test", evidence.rounds, specs);
  replaceRuns(evidence, "test", evidence.rounds, runs);
  evidence.testCases = testCaseEvidence(work, output);
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
async function inCleanWorktree<T>(work: Work, baseCommit: string, run: (cwd: string) => Promise<T>): Promise<T> {
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
    try {
      git(work.repoRoot, ["worktree", "remove", "--force", worktree]);
    } catch {
      // 지우지 못해도 검증 결과는 이미 증거에 남았다 — 여기서 던지면 통과를 잃는다
      rmSync(worktree, { recursive: true, force: true });
    }
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
  const { runs } = await inCleanWorktree(work, baseCommit, (cwd) =>
    runSpecs(work, "integrate", evidence.rounds, specs, cwd),
  );
  replaceRuns(evidence, "integrate", evidence.rounds, runs);
  persist(work, evidence);
  return [
    summary(work, evidence, "integrate", specs),
    "",
    `기준 커밋 ${baseCommit.slice(0, 12)} 위의 깨끗한 worktree 에서 돌렸습니다 — 작업 트리에 남아 있던 산출물은 끼지 않았습니다.`,
  ].join("\n");
}
