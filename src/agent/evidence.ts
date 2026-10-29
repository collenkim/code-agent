import { COUNTER_LABEL } from "./retryPolicy";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { filePaths, fileOutcomeProblems } from "../core/fileOperations";
import { dirname, join, posix } from "path";
import { hashManifest, hashPlan } from "../core/approval";
import type { Manifest } from "../core/manifest";
import { writeAtomic } from "../core/atomic";
import { docPaths, firstListNames, sectionBody } from "./docs";
import { knowledgePath } from "./knowledge";
import { reviewFile, verifyFile, workDocsDir } from "./layout";
import {
  grantScope,
  grantText,
  runCauseOf,
  LIMITS,
  limitOf,
  nextRoundDecision,
  roundStateOf,
  runClass,
  stateGuardText,
  verifyBudget,
  verifyRetryOf,
  verifyState,
} from "./retryPolicy";
import type { RoundCause, RunCause, VerifyBudget, VerifyRetryState, VerifyRetryView, VerifyState } from "./retryPolicy";
import type { ReviewLog } from "./review";
import { KNOWLEDGE_KINDS, SCHEMAS } from "./schemas";
import { changedPaths, fileHashes, partialTreeHash } from "./tree";
import type { Change } from "./tree";
import { approvalOf } from "./work";
import type { Work } from "./work";
import { parseTestCases, readWorkDoc, reproCases, reproMode } from "./workDocs";
import { parseTestResults, resultFor, tcToken } from "./testResults";
import type { CaseStatus } from "./testResults";
import { shortCommand } from "./screenText";
import { stageTestRoots, testRoots, trackedTestFiles } from "./testFiles";

/**
 * ⑧ 의 원본 — `.code-agent/work/<ID>/<대상>.verify.json`.
 *
 * **코드만 쓴다.** hook 이 `.code-agent/` 아래 모든 도구 쓰기를 막고, Bash 허용 목록에 리다이렉트가
 * 없어 셸로도 못 쓴다. 모델이 직접 `gradlew test` 를 돌리는 것은 허용되지만 아무 효력이 없다 —
 * `next` 와 인계는 이 파일만 읽는다.
 *
 * 증거는 **무엇 위에서 났는지**와 함께 적힌다. baseCommit(시작 때 굳힌 커밋) · 계획 파일의 부분
 * 트리 해시 · manifestHash · planHash 넷이 지금 값과 하나라도 다르면 그 통과는 무효다.
 */
export const VALIDATION_DOC_FILE = "08-validation.md";

export type Outcome = "passed" | "failed" | "not-run" | "error";

/**
 * 증거를 남기는 스테이지 — fix 의 재현 · 7 정적 분석 · 8 테스트 · 10 통합 검증.
 * 넷이 한 증거 파일에 쌓인다. `repro` 만 0회차라 고쳐 쓰기 한도를 잡아먹지 않는다.
 */
export type VerifyPhase = "repro" | "check" | "test" | "integrate";

/** 검증 명령 한 번 */
export interface VerifyRun {
  /** 검증 회차. 명령을 돌리기 **전에** 올린다 — 회차를 연 원인은 `Evidence.retry.causes` */
  round: number;
  phase: VerifyPhase;
  /** 매니페스트의 명령 이름 (build · test · 선언된 commands 의 키) */
  kind: string;
  command: string;
  outcome: Outcome;
  status: number | null;
  /** `.code-agent/log/verify/<ID>/` 의 실행별 전체 로그(같은 회차를 다시 돌려도 덮지 않는다). 커밋되지 않으므로 근거는 tail 이 든다 */
  logFile?: string;
  /** 실패·error 는 마지막 40줄, 통과는 마지막 5줄 */
  tail: string;
  /** 명령을 시작한 시각 */
  at: string;
  /** 명령이 끝난 시각과 소요(ms) — 옛 기록에는 없다 */
  endedAt?: string;
  durationMs?: number;
  /** 출력이 code-agent.json 의 environmentErrors 와 맞아 환경 오류(error)로 분류됐을 때 맞은 패턴 */
  environment?: string;
  /** 실행이 끝난 원인(시간 초과·실행 실패·실행 파일 없음·환경 오류). 없는 옛 기록은 runCauseOf 가 tail 문구로 추정한다 */
  cause?: RunCause;
  /** 보고서 탐색이 상한(2만 항목·깊이 12)에서 끊겼다 — JUnit 보고서를 놓쳤을 수 있다 */
  reportScan?: "truncated";
  /** cause guard — 검증 명령이 바꿔 실행 전 내용으로 되돌린 code-agent 기록(저장소 상대 경로) */
  guarded?: string[];
}

/** ⑦ 의 TC 하나가 이번 실행에서 어떻게 확인됐는가 */
export interface TestCaseEvidence {
  id: string;
  /** 옛 기록에는 없을 수 있다. 상태 없는 기록은 미검증이며 게이트를 열지 못한다. */
  status?: CaseStatus;
  /**
   * `출력` — 파싱한 테스트 결과 행에 TC id와 상태가 있다.
   * `테스트 파일` — 출력에는 없고 kind:"test" 단계의 계획 파일이 그 id 를 들고 있다.
   * `없음` — 어디에도 없다. 통과로 세지 않는다.
   */
  source: "출력" | "테스트 파일" | "없음";
  where?: string;
}

/**
 * fix 의 재현 증거 — 무엇을, 어떤 테스트 트리 위에서 봤는가.
 *
 * "고치고 나서 쓴 테스트" 를 재현으로 세지 않으려면 *언제* 봤는지가 증거에 함께 있어야 한다.
 * 테스트 단계 계획 파일만의 부분 트리 해시가 그 자리다.
 */
export interface ReproEvidence {
  at: string;
  /** kind:"test" 단계 계획 파일만의 부분 트리 해시. 재현을 본 트리다 */
  testTreeHash: string;
  /** ⑦ 의 `## 재현` 이 가리킨 TC id 들 */
  cases: string[];
  /** 재현 대상 TC의 실제 실패 결과. 파일에 ID가 있다는 사실은 재현 증거가 아니다. */
  found: TestCaseEvidence[];
  /**
   * 로그 근거 — 로컬에서 재현되지 않는 결함을 오류 로그로 고친다. 이때 `found` 는 수정 전 결과의 기록일 뿐 실패를
   * 요구하지 않고, 같은 TC 는 회귀 TC 로 수정 후 통과해야 한다. 없으면 로컬 재현(실패를 봤다)이다.
   */
  mode?: "log";
  /** 로그 근거를 정한 자리 — 계획 승인(⑦ `방식: 로그 근거`) 또는 재현 실패 뒤 사람 확인 */
  basis?: LogBasis;
}

export interface LogBasis {
  by: "plan" | "approved";
  at: string;
  detail: string;
}

export interface Evidence {
  id: string;
  target: string;
  baseCommit: string;
  /** 계획 파일만의 부분 트리 해시 */
  treeHash: string;
  manifestHash: string;
  planHash: string;
  /** 검증 회차 — 새 회차를 열 때 +1. 같은 코드 재실행은 회차를 다시 쓴다 */
  rounds: number;
  /**
   * 이 증거가 시작될 때의 고쳐 쓰기 한도. **매니페스트를 매번 읽지 않는 이유**가 여기 있다 —
   * `fixRounds` 는 `hashManifest` 에 들어가지 않아(경계도 검증 선언도 아니다) 승인을 흔들지 않는데,
   * `code-agent.json` 이 계획 파일이면 모델이 루프 도중에 한도를 올려도 승인이 그대로다.
   * 한 번 시작한 루프는 시작할 때의 한도로 끝낸다. 옛 증거에는 없어 optional 이다.
   */
  fixRounds?: number;
  runs: VerifyRun[];
  testCases: TestCaseEvidence[];
  integrationTestCases?: TestCaseEvidence[];
  /**
   * fix 의 재현. 있으면 (a) 비-test 계획 파일 쓰기가 열리고 (b) kind:"test" 단계 파일이 언다.
   * 옛 증거에는 없어 optional 이다. 묶임이 깨지면 증거와 함께 버려진다 — 재승인하면 다시 봐야 한다.
   */
  repro?: ReproEvidence;
  /**
   * 로컬 재현이 안 된 마지막 시도 — 사람이 로그 근거 전환을 확인할 때 보여 준다. class 는 같은 테스트 트리로 다시
   * 시도할 수 있는가를 정한다(없는 옛 기록은 problem 문구로 추정한다)
   */
  reproAttempt?: ReproEvidence & { problem: string; class?: ReproAttemptClass };
  /** 재현 실패 뒤 사람이 확인한 로그 근거 전환. 테스트를 다시 쓴 뒤의 재실행에도 이어진다 */
  logBasis?: LogBasis;
  /** 원인별 재시도 카운터 — 없으면 옛 증거다. verifyRetryOf 가 읽을 때 추정하고 다음 저장 때 기록한다 */
  retry?: VerifyRetryState;
  /** 테스트 동결의 기준 — 결과가 인식된(또는 코드 결함으로 실패한) 첫 test 실행 때의 kind:test 파일별 해시 */
  testFreeze?: TestFreeze;
  at: string;
}

export type ReproAttemptClass = "environment" | "interrupted" | "result-unconfirmed" | "precondition";

export interface TestFreeze {
  round: number;
  at: string;
  files: Record<string, string>;
  /**
   * 새 회차를 열며 기준을 다시 굳힌 파일 — 수집 수정 회차의 파일과 ⑨ 지적으로 연 파일만이다. reviewRound 는 ⑨ 지적으로
   * 받아들일 때의 리뷰 회차 수다 — 같은 리뷰 회차 안에서 한 파일을 두 번 받아들이지 않는다
   */
  rebased?: { round: number; at: string; by?: "collect" | "finding"; files: string[]; reviewRound?: number }[];
}

export function loadEvidence(repoRoot: string, id: string, target: string): Evidence | undefined {
  const path = verifyFile(repoRoot, id, target);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Evidence;
  } catch {
    // 읽을 수 없는 증거는 증거가 아니다. 다시 돌리면 덮어쓰인다
    return undefined;
  }
}

/**
 * 지금 기준 커밋·계획·매니페스트에 묶인 증거 — check() 의 회차 판정과 사람 허용(retryGrant)이 같은 조건을 쓴다.
 * 묶임이 하나라도 다르면 그 증거의 카운터·허용은 지금 작업의 것이 아니다(다음 check 가 새로 시작한다).
 */
export function boundEvidence(work: Work): Evidence | undefined {
  const evidence = loadEvidence(work.repoRoot, work.active.id, work.active.target);
  if (!evidence || !work.plan || !work.active.baseCommit) return undefined;
  return evidence.baseCommit === work.active.baseCommit && evidence.manifestHash === hashManifest(work.manifest) &&
    evidence.planHash === hashPlan(work.plan) ? evidence : undefined;
}

export function saveEvidence(repoRoot: string, evidence: Evidence): void {
  const path = verifyFile(repoRoot, evidence.id, evidence.target);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${JSON.stringify(evidence, null, 2)}\n`);
}

export function validationDocFile(id: string): string {
  return posix.join(workDocsDir(id), VALIDATION_DOC_FILE);
}

// ---- 지금 값 ----

export function planPaths(work: Work): string[] {
  return (work.plan?.files ?? []).flatMap(filePaths);
}

/** 이 작업의 계획 파일들을 지금 해시한 값 — 증거의 treeHash 와 대조한다 */
export function treeHashNow(work: Work): string {
  return partialTreeHash(work.repoRoot, planPaths(work));
}

/** kind:"test" 단계 계획 파일만의 부분 트리 해시 — 재현을 본 트리를 가리킨다 */
export function testTreeHashNow(work: Work): string {
  return partialTreeHash(work.repoRoot, testStageFiles(work));
}

/** ⑧ · 반영 보고 · 커밋에 쓰는 재현 한 줄 — 로그 근거면 수정 전 결과와 운영 확인 필요를 함께 남긴다 */
export function reproLine(repro: ReproEvidence): string {
  const where = `${repro.cases.join(", ")} · 테스트 트리 ${repro.testTreeHash} (${repro.at})`;
  if (repro.mode !== "log") return `로컬 재현 ${where}`;
  const before = repro.found.map((entry) => `${entry.id} ${entry.status ?? "unknown"}`).join(", ");
  const reproduced = repro.found.some((entry) => entry.status === "failed");
  return `로그 근거(${repro.basis?.by === "approved" ? "로컬 재현 실패 뒤 사람 확인" : "계획 승인"}) ${where} · 수정 전 ${before} · ` +
    (reproduced ? "수정 전 실패 확인됨" : "로컬 재현 없음 — 운영 로그로 확인 필요");
}

/**
 * 이 작업의 재현 방식 — ⑦ 이 `방식: 로그 근거` 로 계획했거나(계획 승인), 로컬 재현이 안 된 뒤 사람이 확인했으면
 * 로그 근거다. 그 밖에는 로컬 재현이다.
 */
export function reproBasisOf(work: Work, evidence: Evidence | undefined): { mode: "local" } | { mode: "log"; basis: LogBasis } {
  const spec = readWorkDoc(work.repoRoot, work.active.id, "07-test-spec");
  const declared = spec ? reproMode(spec) : { mode: "local" as const };
  if (declared.mode === "log") return { mode: "log", basis: { by: "plan", at: evidence?.repro?.basis?.at ?? new Date().toISOString(), detail: `계획 승인 — ${declared.reason ?? "사유 없음"}` } };
  if (evidence?.logBasis) return { mode: "log", basis: evidence.logBasis };
  return { mode: "local" };
}

/** 현재 재현 TC마다 실제 실패 결과가 있는지 확인한다. 구버전의 ID만 있는 기록은 인정하지 않는다. */
export function reproResultProblem(work: Work, evidence: Evidence): string | undefined {
  const spec = readWorkDoc(work.repoRoot, work.active.id, "07-test-spec");
  const cases = spec ? reproCases(spec) : [];
  // 로그 근거는 수정 전 실패를 요구하지 않는다 — 같은 TC 들의 수정 전 실행 기록만 있으면 된다
  if (reproBasisOf(work, evidence).mode === "log") {
    const unseen = cases.filter((id) => !evidence.repro?.cases.includes(id));
    if (!cases.length || unseen.length || evidence.repro?.mode !== "log") {
      return `로그 근거의 수정 전 실행 기록이 없습니다: ${unseen.join(", ") || "재현 TC 미정의"} — code-agent repro 로 다시 돌리세요`;
    }
    return undefined;
  }
  const missing = cases.filter((id) => !evidence.repro?.cases.includes(id) ||
    !evidence.repro?.found.some((entry) => entry.id === id && entry.status === "failed"));
  if (!cases.length || missing.length) return `재현 TC의 실제 실패 결과가 없습니다: ${missing.join(", ") || "재현 TC 미정의"} — 구버전 기록을 재사용하지 말고 code-agent repro로 다시 확인하세요`;
  return undefined;
}

/**
 * 재현 증거를 현재 계획과 대조한다. 되감기로 재현 검사를 피할 수 없다.
 * 첫 check 뒤에는 수정 루프를 위해 테스트 트리 대조를 내려놓지만 실제 실패 결과는 계속 요구한다.
 * 반영 전에는 stageProblems가 테스트 트리도 다시 확인한다.
 */
export function reproMissing(work: Work, evidence: Evidence | undefined): string | undefined {
  if (!evidence || !work.plan || evidence.planHash !== hashPlan(work.plan) || !evidence.repro) {
    return "재현을 본 기록이 없습니다";
  }
  const resultProblem = reproResultProblem(work, evidence);
  if (resultProblem) return resultProblem;
  if (evidence.runs.some((run) => run.phase === "check")) {
    return undefined;
  }
  const now = testTreeHashNow(work);
  return evidence.repro.testTreeHash === now
    ? undefined
    : `재현을 본 뒤 테스트 파일이 바뀌었습니다 (${evidence.repro.testTreeHash.slice(-12)} ≠ ${now.slice(-12)}) — code-agent repro 를 다시 돌리세요`;
}

// ---- refactor: 기존 테스트 보호 ----

// 테스트 자리·기존 테스트 파일은 testFiles.ts 가 원천이다(planningState 가 순환 없이 쓴다) — 기존 import 경로를 위해 다시 내보낸다
export { stageTestRoots, testRoots, trackedTestFiles };

/**
 * refactor 가 기존 테스트를 고쳤는가. 동작이 보존되는지 보는 것이 그 테스트라,
 * 그것을 고칠 수 있으면 "동작 보존" 은 선언일 뿐이다.
 */
export function preservedTestProblems(work: Work): string[] {
  if (work.order.kind !== "refactor" || !work.active.baseCommit) {
    return [];
  }
  const tracked = new Set(trackedTestFiles(work));
  return changedPaths(work.repoRoot, work.active.baseCommit)
    .filter((change) => tracked.has(change.path))
    .map(
      (change) =>
        `리팩토링이 기존 테스트를 고쳤습니다: [${change.status}] ${change.path} — 되돌리세요 ` +
        "(동작이 보존되는지 보는 것이 그 테스트입니다)",
    );
}

/**
 * 계획이 허락한 자리 밖의 변경. 계획 파일 · 작업 폴더 · `.code-agent/` · 공통 KNOWLEDGE 가 전부다.
 *
 * 검증 명령을 돌리기 **전에** 본다. 빌드가 산출물을 남기면 실행 뒤의 대조는 제 쓰레기를
 * 계획 위반으로 읽는다.
 *
 * KNOWLEDGE 5종을 넣어 둔 이유 — `deliver` 가 사람이 고른 항목을 **코드로** 적용한 뒤 커밋한다.
 * 그 커밋이 실패하면(pre-commit hook · user.email 미설정 · 서명) 적용본만 남는데, 그것을 계획 밖
 * 변경으로 읽으면 사람이 손으로 되돌리기 전에는 `deliver` 도 `check` 도 영영 열리지 않는다.
 */
export function outsideChanges(work: Work): Change[] {
  const { repoRoot, active } = work;
  if (!active.baseCommit) {
    return [];
  }
  const allowed = new Set([
    ...planPaths(work),
    // KNOWLEDGE 예외는 .md 경로만 — .md 가 아닌(코드 파일을 가리키는) KNOWLEDGE 경로는 반영도 고치지 않으므로 예외가 아니다
    ...KNOWLEDGE_KINDS.map((kind) => knowledgePath(work.manifest, kind)).filter((path) => path.toLowerCase().endsWith(".md")),
  ]);
  const prefixes = [`${workDocsDir(active.id)}/`, ".code-agent/"];
  return changedPaths(repoRoot, active.baseCommit).filter(
    (change) => !allowed.has(change.path) && !prefixes.some((prefix) => change.path.startsWith(prefix)),
  );
}

// ---- 무엇을 돌릴 것인가 ----

export interface CommandSpec {
  kind: string;
  /** 매니페스트에 선언이 없으면 undefined — 그 항목은 `not-run` 이고 통과가 아니다 */
  argv?: string[];
}

/**
 * `prepare` 는 여기서 풀지 않는다 — `prepareCommand` 가 제 자리에서 직접 만든다.
 * 여기 두면 품질·테스트 문서가 첫 목록에 `prepare` 라고 적기만 해도 `check`·`test`·`repro` 가
 * 사람이 보고 있는 작업 트리에서 준비 명령을 돌린다(스키마가 "거기서는 돌지 않는다"고 적은 그것).
 * 그 이름은 `commands.prepare` 로 내려가고, 거기 선언하는 것은 superRefine 이 이미 막는다.
 */
function argvOf(manifest: Manifest, kind: string): string[] | undefined {
  const argv = kind === "build" ? manifest.build : kind === "test" ? manifest.test : manifest.commands[kind];
  return argv && argv.length > 0 ? argv : undefined;
}

/** 문서가 첫 목록의 백틱으로 적은 명령 이름 — 문서와 매니페스트를 잇는 자리는 이미 확정 게이트가 대조했다 */
function namesFrom(repoRoot: string, manifest: Manifest, kind: "quality" | "test-strategy", sections: string[]): string[] {
  const path = join(repoRoot, docPaths(manifest, kind)[0]);
  if (!existsSync(path)) {
    return [];
  }
  const text = readFileSync(path, "utf-8");
  return sections.flatMap((section) => firstListNames(sectionBody(SCHEMAS[kind], text, section)).names);
}

function specs(manifest: Manifest, always: string[], names: string[]): CommandSpec[] {
  const kinds = [...new Set([...always, ...names])];
  return kinds.map((kind) => ({ kind, argv: argvOf(manifest, kind) }));
}

/** 7 정적 분석·컴파일 — build + 품질·보안 기준이 이름으로 적은 명령 */
export function checkCommands(repoRoot: string, manifest: Manifest): CommandSpec[] {
  return specs(manifest, ["build"], namesFrom(repoRoot, manifest, "quality", ["static", "security"]));
}

/** 8 테스트 — test + 테스트 전략이 이름으로 적은 명령 */
export function testCommands(repoRoot: string, manifest: Manifest): CommandSpec[] {
  return specs(manifest, ["test"], namesFrom(repoRoot, manifest, "test-strategy", ["tools"]));
}

/**
 * 10 통합 검증 — 전체 `build` 와 전체 `test` 둘뿐이다.
 *
 * 품질·보안 기준이 적은 부분 명령은 넣지 않는다. 통합 검증이 보는 것은 "깨끗한 트리에서 처음부터
 * 전부 도는가" 이고, 그 물음에 필터 걸린 명령은 답하지 않는다.
 */
export function integrateCommands(manifest: Manifest): CommandSpec[] {
  return ["build", "test"].map((kind) => ({ kind, argv: argvOf(manifest, kind) }));
}

/**
 * 통합 검증의 깨끗한 worktree 에서 build·test **앞에** 한 번 도는 준비 명령.
 *
 * `integrateCommands` 에 넣지 않는 이유 — 선언이 없으면 `not-run` 이 되고 `failedRuns` 가 그것을
 * 실패로 세어, prepare 를 선언하지 않은 **모든** 프로젝트의 통합 검증이 깨진다. 선언됐을 때만 돈다.
 */
export function prepareCommand(manifest: Manifest): CommandSpec | undefined {
  return manifest.prepare && manifest.prepare.length > 0 ? { kind: "prepare", argv: manifest.prepare } : undefined;
}

// ---- 게이트 ----

/** 그 스테이지의 마지막 회차 실행만 — 앞 회차의 통과로 지금을 덮지 않는다 */
export function runsOf(evidence: Evidence, phase: VerifyPhase): VerifyRun[] {
  const rounds = evidence.runs.filter((run) => run.phase === phase).map((run) => run.round);
  if (rounds.length === 0) {
    return [];
  }
  const last = Math.max(...rounds);
  return evidence.runs.filter((run) => run.phase === phase && run.round === last);
}

/** 지금 회차(rounds)의 기록 변경(guard) 실행이 되돌린 파일 — phase 를 주면 그 단계만. 없으면 빈 목록 */
export function guardedFiles(evidence: Evidence, phase?: VerifyPhase): string[] {
  const runs = evidence.runs.filter((run) => run.cause === "guard" && run.round === evidence.rounds && (!phase || run.phase === phase));
  return [...new Set(runs.flatMap((run) => run.guarded ?? []))];
}

/** `not-run` · `error` · `skipped` 는 통과가 아니다 — passed 만 통과다 */
export function failedRuns(runs: VerifyRun[]): VerifyRun[] {
  return runs.filter((run) => run.outcome !== "passed");
}

/**
 * 고쳐 쓰기 한도 — 증거가 시작될 때 굳은 값(`fixRounds`), 없으면 매니페스트 값이다.
 * 1회차는 처음 돌려 본 것이라 고쳐 쓰기로 세지 않는다. 고쳐 쓰기는 실패를 고쳐 연 회차만 센다(retry.causes 의 fix).
 */
export function fixLimit(work: Work, evidence: Evidence): number {
  return evidence.fixRounds ?? work.manifest.fixRounds;
}

// ---- 원인별 재시도 카운터 (판정은 retryPolicy.ts, 여기는 증거를 그 입력으로 바꾼다) ----

/** 리뷰 회차 사용량 — 리뷰 회차 한도의 판정은 이 값 하나다(openRound·check()·hook·verify 가 같이 쓴다) */
export interface ReviewRoundUsage {
  used: number; base: number; limit: number; usedPaths: string[]; stale: boolean;
  /** 마지막 회차에 기각되지 않은 열린 지적(F·X)이 있는가 — 한도 거부의 원래 원인(blocking-finding)만 고른다 */
  openFindings?: boolean;
}
/** 결과 표의 열린 지적 줄 — `| F1 | 파일 | 범위 | 열림 | 지적 |` */
const OPEN_ROW = /^\|\s*([FX]\d+)\s*\|[^|\n]*\|[^|\n]*\|\s*열림\s*\|/gm;
function openFindingsOf(log: ReviewLog): boolean {
  const last = log.rounds.at(-1);
  if (!last) return false;
  const waived = new Set((log.waivers ?? []).filter((waiver) => waiver.round === last.round).map((waiver) => waiver.id));
  const results = [
    ...(last.reviewers ?? []).filter((run) => !run.ignored && !run.failure && run.result !== undefined).map((run) => run.result!),
    ...(last.reviewers === undefined && last.reviewer?.result !== undefined ? [last.reviewer.result] : []),
    ...(last.crossAttempts ?? []).filter((attempt) => attempt.class === "completed" && attempt.result !== undefined).map((attempt) => attempt.result!),
    ...(last.crossAttempts === undefined && last.cross?.completedAt && last.cross.result !== undefined ? [last.cross.result] : []),
  ];
  return results.some((text) => [...text.matchAll(OPEN_ROW)].some((match) => !waived.has(match[1])));
}

/**
 * 리뷰 회차 사용량. 순수 함수다 — 파일을 읽지 않으므로 review.json 잠금 안에서 다시 읽은 log 로도 부른다.
 * log 가 없거나 회차 하나라도 지금 묶임(기준 커밋·계획·매니페스트)과 다르면 openRound 가 회차를 버리므로
 * 사용량 0 이다(사람 허용도 함께 버려진다). `limit` 이 없는 옛 log 는 이미 3회차 이상이면 한 회차 유예를 받고,
 * 다음 openRound 가 limit 을 기록하면서 유예가 끝난다.
 */
export function reviewRoundUsageOf(log: ReviewLog | undefined, binding: { baseCommit: string; planHash: string; manifestHash: string }): ReviewRoundUsage {
  const stale = !log || !Array.isArray(log.rounds) || log.rounds.some((round) =>
    round.baseCommit !== binding.baseCommit || round.planHash !== binding.planHash || round.manifestHash !== binding.manifestHash);
  if (stale) return { used: 0, base: LIMITS.reviewRounds, limit: LIMITS.reviewRounds, usedPaths: [], stale: true };
  const used = log!.rounds.length;
  const base = log!.limit ?? (used >= LIMITS.reviewRounds ? used + 1 : LIMITS.reviewRounds);
  return {
    used,
    base,
    limit: limitOf("reviewRounds", base, log!.grants ?? [], grantScope({ file: "review", key: "reviewRounds" })),
    usedPaths: (log!.used ?? []).map((entry) => entry.path),
    stale: false,
    openFindings: openFindingsOf(log!),
  };
}

/** review.json 을 읽어 지금 묶임의 리뷰 회차 사용량을 낸다. 읽지 못하면 없는 것으로 본다 */
export function reviewRoundUsage(work: Work): ReviewRoundUsage {
  const path = reviewFile(work.repoRoot, work.active.id, work.active.target);
  let log: ReviewLog | undefined;
  try {
    log = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) as ReviewLog : undefined;
  } catch {
    log = undefined;
  }
  if (!work.plan || !work.active.baseCommit) return reviewRoundUsageOf(undefined, { baseCommit: "", planHash: "", manifestHash: "" });
  return reviewRoundUsageOf(log, { baseCommit: work.active.baseCommit, planHash: hashPlan(work.plan), manifestHash: hashManifest(work.manifest) });
}

/**
 * 지금 묶임의 리뷰 기록(review.json)에 연 회차가 있는가 — 리뷰 회차 허용(judgment retry-grant reviewRounds)은 그 기록에 남으므로 없으면 받지 않는다.
 * 허용(retryGrant)·한도 안내(check() 거부의 kind no-review·hook·status 다음:)가 이 판정 하나를 쓴다
 */
export function reviewOpened(work: Work): boolean {
  const usage = reviewRoundUsage(work);
  return !usage.stale && usage.used > 0;
}

/**
 * 리뷰 회차 **예산**의 사용량 — review.json 회차 수와, 통과 뒤 변경으로 연 검증 회차 수(지금 묶임 증거의 retry.causes 의 review) 중
 * 큰 값이다. 리뷰를 열지 않고 '통과 → 수정 → verify' 를 되풀이해도 리뷰 회차를 쓴다(규약: 통과 뒤 변경은 리뷰 회차). review.json 이
 * 지워지거나 깨져도 검증 기록 쪽 수가 남는다. 한도·사람 허용은 review.json 의 값 그대로다. 검증 예산(verifyView)·리뷰 회차 허용
 * (retryGrant·reviewBudgets)이 쓴다 — openRound 는 review.json 회차만 본다(리뷰를 받는 길은 막지 않는다).
 */
export function reviewRoundBudget(work: Work, evidence?: Evidence): ReviewRoundUsage {
  const usage = reviewRoundUsage(work);
  const bound = evidence ?? loadEvidence(work.repoRoot, work.active.id, work.active.target);
  const same = !!bound && !!work.plan && bound.baseCommit === work.active.baseCommit && bound.planHash === hashPlan(work.plan) &&
    bound.manifestHash === hashManifest(work.manifest);
  const opened = same ? Object.values(verifyRetryOf(bound!).causes).filter((cause) => cause === "review").length : 0;
  return opened > usage.used ? { ...usage, used: opened } : usage;
}

/** 회차 전체 상태 — check() 의 다음 회차 판정과 hook 이 쓴다(앞 회차 test 상태를 이어받는다) */
export function roundState(evidence: Evidence): { state: VerifyState | "none"; emptyRound: boolean } {
  const retry = verifyRetryOf(evidence);
  return roundStateOf({
    rounds: evidence.rounds, runs: evidence.runs, started: retry.started, wiped: retry.wiped,
    testCases: evidence.testCases, integrationTestCases: evidence.integrationTestCases,
  });
}

export interface VerifyView {
  round: number;
  state: VerifyState | "none";
  emptyRound: boolean;
  /** 이 회차 test 의 상태 — 끊긴 test 표지·이 회차 test 실행·이 회차 재사용이 지운 test 가 있을 때만(앞 회차를 이어받지 않는다) */
  testState?: VerifyState;
  retry: VerifyRetryView;
  budget: VerifyBudget;
  /** 마지막 리뷰 회차에 기각되지 않은 열린 지적이 있는가 — 통과 뒤 변경 거부의 원래 원인(blocking-finding·code-defect)을 고른다 */
  reviewOpenFindings: boolean;
  /** 지금 묶임의 리뷰 기록(review.json)에 연 회차가 있는가 — 없으면 리뷰 회차 허용을 받지 않는다(reviewOpened) */
  reviewOpened: boolean;
}

/** 증거 하나의 판정 입력 — 상태·카운터·예산. check()·verify·hook·status·context 가 같은 값을 본다 */
export function verifyView(work: Work, evidence: Evidence): VerifyView {
  const retry = verifyRetryOf(evidence);
  const reviewRounds = reviewRoundBudget(work, evidence);
  const budget = verifyBudget({
    retry, round: evidence.rounds, fixRounds: fixLimit(work, evidence),
    // 재현·코드 결함으로 얼린 테스트는 수집 수정으로 다시 열지 않는다.
    collectLimit: evidence.repro || evidence.runs.some(run => run.phase === "test" && runClass(run) === "defect") ? 0 : LIMITS.collect,
    reviewRounds,
  });
  const { state, emptyRound } = roundState(evidence);
  const r = evidence.rounds;
  const testState: VerifyState | undefined = retry.started?.phase === "test" && retry.started.round === r ? "interrupted"
    : evidence.runs.some((run) => run.phase === "test" && run.round === r)
      ? verifyState({ phase: "test", round: r, runs: evidence.runs, cases: evidence.testCases })
      : retry.wiped?.test?.round === r ? retry.wiped.test.state : undefined;
  return { round: r, state, emptyRound, ...(testState ? { testState } : {}), retry, budget, reviewOpenFindings: !!reviewRounds.openFindings,
    reviewOpened: reviewOpened(work) };
}

/**
 * kind:test 파일이 얼어 있는가 — 결과가 인식된(또는 코드 결함으로 실패한) test 실행, 또는 재현부터다.
 * 앞의 둘(testFreeze·repro)은 새 기록이고, 뒤의 둘은 testFreeze 가 없는 옛 증거를 위한 추정이다.
 * 결과가 하나도 인식되지 않고 실패도 없던 test 실행(결과 미확인)은 얼리지 않는다.
 */
export function testFrozen(evidence: Evidence): boolean {
  return !!evidence.testFreeze || !!evidence.repro || evidence.runs.some(freezingTestRun) ||
    evidence.testCases.some((entry) => entry.source === "출력");
}

/**
 * 동결을 시작하는 test 실행 — 테스트가 실제로 돈 실행이다: 코드 결함으로 실패, 제한 시간 초과(걸려 멈춘 테스트도 지우거나 약하게
 * 고치지 못하게), 선언된 환경 문구로 실패. 실행 파일 없음·실행 실패(spawn)·명령 미선언은 테스트가 돌지 않아 얼리지 않는다.
 * 결과가 인식된 실행(TC 결과 줄)은 testCases 쪽이 언다. 결과 미확인(exit 0, TC 없음)은 수집 수정 창 때문에 얼리지 않는다.
 */
export function freezingTestRun(run: VerifyRun): boolean {
  if (run.phase !== "test") return false;
  const cls = runClass(run);
  return cls === "defect" || cls === "timeout" || (cls === "environment" && runCauseOf(run) === "environment");
}

/** 결과 미확인 회차의 수집 수정 창 — 그동안 kind:test 파일의 TC 이름을 고칠 수 있다. fix 작업은 수집 한도가 0 이라 없다 */
export function collectWindowOpen(view: VerifyView): boolean {
  return view.testState === "result-unconfirmed" && view.budget.collect.left > 0 && view.budget.totalRounds.left > 0;
}

/** ⑦ 의 TC id 중 찾는 파일 어디에도 `TC-n` 토큰이 없는 것 — test 전 사전 점검(막지 않는다) */
export function tcPrecheck(work: Work): string[] {
  const spec = readWorkDoc(work.repoRoot, work.active.id, "07-test-spec");
  const cases = spec ? parseTestCases(spec) : [];
  if (cases.length === 0) return [];
  const texts = tcSearchTexts(work);
  return cases.map((entry) => entry.id).filter((id) => !texts.some((text) => tcToken(id).test(text)));
}

/** TC id 를 찾는 파일 — kind:test 단계의 계획 파일(refactor 는 기존 테스트까지), 테스트 단계가 없으면 계획 파일 전체 */
function tcSearchFiles(work: Work): string[] {
  const files = work.stages.some((stage) => stage.kind === "test") || work.order.kind === "refactor"
    ? [...testStageFiles(work), ...(work.order.kind === "refactor" ? trackedTestFiles(work) : [])]
    : planPaths(work);
  return [...new Set(files)];
}
function tcSearchTexts(work: Work): string[] {
  return tcSearchFiles(work).map((path) => {
    const full = join(work.repoRoot, path);
    return existsSync(full) ? readFileSync(full, "utf-8") : "";
  });
}

/**
 * 결과 인식(`TC-<숫자>`)에 걸리지 않게 적은 TC id — `TC_3`·`TC3`·`tc-3`·`TC 3`·`TC-3a`. id → 찾은 표기(없으면 빠진다).
 * 막지 않는다 — 사전 점검·결과 미확인 문구의 고칠 방향에만 쓴다.
 */
export function tcNearMisses(work: Work, ids: string[]): Map<string, string> {
  const texts = tcSearchTexts(work), found = new Map<string, string>();
  for (const id of ids) {
    const variant = new RegExp(`(?<![A-Za-z0-9])TC[-_ ]?${id.slice(3)}(?![0-9])[A-Za-z]*`, "gi");
    const near = texts.flatMap((text) => [...text.matchAll(variant)].map((match) => match[0])).find((text) => text !== id);
    if (near) found.set(id, near);
  }
  return found;
}

/**
 * 테스트 동결 뒤 바뀐 kind:test 파일 — 증거의 기준(testFreeze)과 지금 파일 해시를 대조한다.
 * review.json 을 읽지 않는다: ⑨ 지적으로 연 파일과 수집 수정 회차의 파일은 check() 가 새 회차를 열 때 기준을 다시 굳힌다.
 */
export function testFreezeProblems(work: Work, evidence: Evidence): string[] {
  const freeze = evidence.testFreeze;
  if (!freeze) return [];
  const now = fileHashes(work.repoRoot, testStageFiles(work));
  const paths = [...new Set([...Object.keys(freeze.files), ...Object.keys(now)])].sort();
  return paths.filter((path) => freeze.files[path] !== now[path]).map((path) =>
    `테스트 동결 뒤 바뀐 kind:test 파일: ${path} — 동결(${freeze.round}회차) 뒤에는 ⑨ 지적으로 연 파일만 바뀔 수 있고, ` +
    "바꾼 뒤에는 code-agent verify 로 check 부터 다시 돌아야 기준이 갱신됩니다. 지적 없이 바꿨으면 되돌리세요");
}

/** 다음 수정 회차가 고쳐 쓰기 한도로 거부되는가 — hook·check() 와 같은 판정(nextRoundDecision)이다 */
export function overFixLimit(work: Work, evidence: Evidence): boolean {
  const view = verifyView(work, evidence);
  const decision = nextRoundDecision({ previous: view.state, emptyRound: view.emptyRound, treeChanged: true, budget: view.budget,
    reviewOpenFindings: view.reviewOpenFindings });
  return decision.action === "refuse" && decision.failure.counter?.key === "fix";
}

/**
 * 증거가 지금 트리를 가리키는가. 하나라도 어긋나면 그 통과는 무효다.
 *
 * `next` 와 `check`·`test` 가 같은 함수를 지난다 — 한 곳만 대조를 빠뜨리면 거기가 구멍이 된다.
 */
export function bindingProblems(work: Work, evidence: Evidence): string[] {
  const problems: string[] = [];
  if (evidence.baseCommit !== work.active.baseCommit) {
    problems.push(`증거의 기준 커밋이 지금과 다릅니다 (${evidence.baseCommit.slice(0, 12)} ≠ ${(work.active.baseCommit ?? "없음").slice(0, 12)})`);
  }
  if (evidence.treeHash !== treeHashNow(work)) {
    problems.push("검증 뒤 계획 파일이 바뀌었습니다 — 통과는 그 트리에 묶입니다. code-agent check 부터 다시 돌리세요");
  }
  if (evidence.manifestHash !== hashManifest(work.manifest)) {
    problems.push("검증 뒤 code-agent.json 의 경계·검증 선언이 바뀌었습니다 — 다시 돌려야 합니다");
  }
  if (work.plan && evidence.planHash !== hashPlan(work.plan)) {
    problems.push("검증 뒤 계획이 바뀌었습니다 — 재승인된 계획 위에서 다시 돌려야 합니다");
  }
  return problems;
}

/**
 * 게이트 문제 한 줄과 그 종류 — 다시 돌려서 풀리는가로 나눈다(verify 의 assess 만 종류를 쓴다).
 * stop: 다시 돌려도 남는다(되돌리기·사람 판단·다른 명령이 필요). rerun: 다시 돌리면 맞춰진다(증거·묶임·회차·⑧).
 * result: 실행 결과(실패한 실행·확인되지 않은 TC).
 */
export interface StageProblem { kind: "stop" | "rerun" | "result"; text: string }

/** 스테이지 하나를 마쳤다고 할 수 있는가 — 증거 · 묶임 · 계획 대조 · 결과 전부 */
export function stageProblems(work: Work, phase: VerifyPhase): string[] {
  return stageProblemEntries(work, phase).map((entry) => entry.text);
}

export function stageProblemEntries(work: Work, phase: VerifyPhase): StageProblem[] {
  const problems: StageProblem[] = [];
  const add = (kind: StageProblem["kind"], text: string) => problems.push({ kind, text });
  const approval = approvalOf(work);
  if (approval.status !== "approved") {
    add("stop", `계획 승인이 ${approval.status} 입니다 — 승인 위에서 난 증거가 아니면 통과가 아닙니다`);
  }
  const evidence = loadEvidence(work.repoRoot, work.active.id, work.active.target);
  if (!evidence) {
    add("rerun", `검증 증거가 없습니다 — code-agent ${phase} 를 돌리세요`);
    return problems;
  }
  for (const problem of bindingProblems(work, evidence)) add("rerun", problem);
  for (const change of outsideChanges(work)) {
    add("stop", `계획 밖 변경: [${change.status}] ${change.path}`);
  }
  for (const problem of fileOutcomeProblems(work.plan?.files ?? [], path => existsSync(join(work.repoRoot, path)))) add("stop", problem);
  for (const problem of preservedTestProblems(work)) add("stop", problem);
  // 동결 뒤 바뀐 테스트 파일 — 게이트가 증거(testFreeze)로 다시 대조한다. 되돌리거나 ⑨ 지적으로 연 뒤 다시 돌아야 한다
  if (phase === "test" || phase === "integrate") {
    for (const problem of testFreezeProblems(work, evidence)) add("stop", problem);
  }
  if (work.order.kind === "fix") {
    const problem = reproResultProblem(work, evidence);
    if (problem) add("stop", problem);
  }

  // 재현은 "**그 테스트 트리 위에서** 봤다" 는 주장이다. 첫 check 뒤로는 hook 이 대조를 내려
  // (⑨ 지적으로 푼 수정 루프가 교착되지 않게) 재현 테스트를 고칠 길이 생기는데, 그러고도 ⑧·⑩ 은
  // 옛 해시를 그대로 찍는다. 반영 직전에 한 번 다시 맞춰, 반영되는 테스트가 재현을 본 그 테스트인지 본다.
  if (phase === "integrate" && evidence.repro) {
    const now = testTreeHashNow(work);
    if (evidence.repro.testTreeHash !== now) {
      // check() 가 격리 재현을 갱신하므로 다시 돌리면 맞춰진다
      add(
        "rerun",
        `재현을 본 테스트 트리가 지금과 다릅니다 (${evidence.repro.testTreeHash.slice(-12)} ≠ ${now.slice(-12)}) — ` +
          "code-agent check로 기준 코드 위의 격리 재현부터 갱신하세요. 작업 코드는 보존됩니다",
      );
    }
  }

  const runs = runsOf(evidence, phase);
  if (runs.length === 0) {
    add("rerun", `${phase} 를 돌린 기록이 없습니다 — code-agent ${phase} 를 돌리세요`);
  } else if (Math.max(...runs.map((run) => run.round)) !== evidence.rounds) {
    // 앞 회차의 통과로 지금 회차를 덮지 않는다 — 고쳐 쓴 뒤 check 만 다시 돌리고 test 는 건너뛰는 길
    add("rerun", `${phase} 결과가 ${evidence.rounds}회차의 것이 아닙니다 — code-agent ${phase} 를 다시 돌리세요`);
  }
  // 검증 명령이 code-agent 기록을 바꾼 실행은 결과가 아니라 전제 미충족이다 — 같은 코드로 다시 돌려도 같다
  const guarded = guardedFiles(evidence, phase);
  if (guarded.length) add("stop", stateGuardText(guarded));
  for (const run of failedRuns(runs)) {
    if (guarded.length && run.cause === "guard" && run.round === evidence.rounds) continue;
    add("result", `${run.kind}: ${run.outcome} (${shortCommand(run.command)})`);
  }
  // 기록 변경(guard) 실행의 출력은 TC 결과로 읽지 않았다 — 그 회차의 ⑦ 미확인 줄('TC id 를 남기세요')은 틀린 할 일이라 싣지 않는다.
  // 게이트는 위 stop 줄로 막혀 있고, 고친 뒤 새 회차에서 TC 대조가 다시 돈다
  if ((phase === "test" || phase === "integrate") && guarded.length === 0) {
    const records = phase === "test" ? evidence.testCases : evidence.integrationTestCases ?? [];
    const spec = readWorkDoc(work.repoRoot, work.active.id, "07-test-spec");
    const statuses = (spec ? parseTestCases(spec) : []).map((item) => ({ id: item.id, status: records.find((entry) => entry.id === item.id)?.status ?? "unknown" }))
      .filter((item) => item.status !== "passed");
    if (statuses.length > 0) {
      // 결과가 인식돼 실패한 TC 만 있으면 할 일은 코드 수정이다 — 'TC id 를 남기세요' 는 결과가 인식되지 않은 TC 에만 맞는 안내다
      const allFailed = statuses.every((item) => item.status === "failed");
      add(
        "result",
        `⑦ 의 테스트 케이스가 확인되지 않았습니다: ${statuses.map((item) => `${item.id}(${item.status})`).join(", ")} — ` +
          (allFailed ? "필수 TC가 실제 실행되어 passed여야 합니다. 실패한 TC는 테스트를 약하게 하지 않고 계획 안의 코드를 고칩니다"
            : "필수 TC가 실제 실행되어 passed여야 합니다. TAP·unittest verbose·pytest verbose·Go JSON·code-agent-test JSONL 결과에 TC id를 남기세요. 파일의 주석만으로는 통과하지 않습니다"),
      );
    }
  }

  // ⑧ 은 코드가 렌더한 것만 유효하다 — 손으로 고친 것은 바이트 대조에서 드러난다
  const rendered = join(work.repoRoot, validationDocFile(work.active.id));
  const expected = renderValidationDoc(work, evidence);
  if (!existsSync(rendered) || readFileSync(rendered, "utf-8") !== expected) {
    add("rerun", `${validationDocFile(work.active.id)} 가 증거와 다릅니다 — code-agent ${phase} 가 다시 렌더합니다`);
  }
  return problems;
}

// ---- ⑧ 08-validation.md (코드가 렌더한다) ----

const OUTCOME_LABEL: Record<Outcome, string> = {
  passed: "passed",
  failed: "failed",
  "not-run": "not-run (선언 없음)",
  error: "error (돌지 못함)",
};

/** 실행 원인 표지 — 결과 칸·실패 로그 머리에 붙는다. 원인 필드가 없는 옛 기록은 표지가 없다 */
export const RUN_CAUSE_LABEL: Record<RunCause, string> = {
  timeout: "시간 초과",
  spawn: "실행 실패",
  "missing-tool": "실행 파일 없음",
  environment: "환경 오류",
  guard: "code-agent 기록 변경 — 되돌림",
};

/** 회차를 연 원인 — ⑧ 수정 루프 줄에 붙는다 */
const CAUSE_LABEL: Record<RoundCause, string> = { first: "첫 실행", fix: COUNTER_LABEL.fix, collect: COUNTER_LABEL.collect, review: "통과 뒤 변경" };

function outcomeText(run: VerifyRun): string {
  // 기록 변경(guard)은 돈 실행이다 — "돌지 못함" 대신 증거로 받지 않았다고 쓴다
  const outcome = run.cause === "guard" ? "error (증거로 받지 않음)" : OUTCOME_LABEL[run.outcome];
  return `${outcome}${run.cause ? ` · ${RUN_CAUSE_LABEL[run.cause]}` : ""}`;
}

/**
 * 회차 줄 — ⑧ 검증 기준과 ⑩ 검증 절이 같이 쓴다. rounds 는 고쳐 쓰기 수가 아니라 검증 회차 총수(첫 실행·통과 뒤 변경·
 * 수집 수정 포함)라, 회차 원인 기록(retry)이 있으면 검증 회차와 고쳐 쓰기 사용/한도를 따로 적는다. 입력은 증거뿐이다
 * (review.json 을 읽으면 리뷰 회차가 열릴 때 ⑧ 이 증거와 어긋난다). retry 가 없는 옛 증거는 옛 문구 그대로다(⑧ 바이트 유지).
 */
export function roundsText(work: Work, evidence: Evidence): string {
  if (!evidence.retry) return `고쳐 쓰기 회차: ${evidence.rounds}`;
  const retry = verifyRetryOf(evidence);
  const used = Object.values(retry.causes).filter((cause) => cause === "fix").length;
  const limit = limitOf("fix", fixLimit(work, evidence), retry.grants, grantScope({ file: "verify", key: "fix" }));
  return `검증 회차: ${evidence.rounds} · 고쳐 쓰기 ${used}/${limit}회`;
}

/**
 * 증거를 사람이 읽는 문서로. **입력은 증거뿐이다** — 로그 파일이나 지금 시각을 읽으면 다시 렌더할 때
 * 바이트가 달라져, 손으로 고친 것을 잡아내는 대조가 무너진다.
 */
export function renderValidationDoc(work: Work, evidence: Evidence): string {
  const { active } = work;
  const lines = [
    `# ${active.id} 검증 보고서`,
    "",
    `<!-- 이 파일은 code-agent check · test 가 .code-agent/work/${active.id}/${active.target}.verify.json 에서 렌더한다. 손으로 고치면 게이트가 거부한다. -->`,
    "",
    "## 검증 기준",
    "",
    `- 기준 커밋: ${evidence.baseCommit}`,
    `- 계획 파일 부분 트리 해시: ${evidence.treeHash}`,
    `- planHash: ${evidence.planHash}`,
    `- manifestHash: ${evidence.manifestHash}`,
    `- 대상: ${evidence.target} · 계획 파일 ${planPaths(work).length}개`,
    `- ${roundsText(work, evidence)}`,
    ...(evidence.repro
      ? [`- 재현: ${reproLine(evidence.repro)}`]
      : []),
    "",
    "## 실행 결과",
    "",
    "| 회차 | 스테이지 | 종류 | 명령 | 결과 | exit |",
    "|---|---|---|---|---|---|",
  ];
  for (const run of evidence.runs) {
    lines.push(
      `| ${run.round} | ${run.phase} | ${run.kind} | ${run.command || "(선언 없음)"} | ${outcomeText(run)} | ${run.status ?? "-"} |`,
    );
  }
  if (evidence.runs.length === 0) {
    lines.push("| - | - | - | - | 아직 돌리지 않았습니다 | - |");
  }

  lines.push("", "## 테스트", "");
  if (evidence.testCases.length === 0) {
    lines.push("- ⑦ 의 테스트 케이스를 읽지 못했습니다 (07-test-spec.md 의 표를 확인하세요)");
  } else {
    lines.push("| TC | 결과 | 확인된 곳 | 근거 |", "|---|---|---|---|");
    for (const entry of evidence.testCases) {
      lines.push(`| ${entry.id} | ${entry.status ?? "unknown"} | ${entry.source} | ${entry.where ?? "-"} |`);
    }
  }
  if (evidence.testFreeze) {
    lines.push("", `- 테스트 동결: ${evidence.testFreeze.round}회차부터 · kind:test 파일 ${Object.keys(evidence.testFreeze.files).length}개`);
  }

  if (evidence.integrationTestCases) {
    lines.push("", "## 통합 테스트", "", ...evidence.integrationTestCases.map((entry) => `- ${entry.id}: ${entry.status ?? "unknown"} (${entry.where ?? entry.source})`));
  }

  // 0회차(재현)는 고쳐 쓰기가 아니다 — 수정 루프 목록에 섞이면 회차 세는 자리가 어긋나 보인다
  const rounds = [...new Set(evidence.runs.filter((run) => run.round >= 1).map((run) => run.round))].sort((a, b) => a - b);
  if (rounds.length > 1) {
    lines.push("", "## 수정 루프", "");
    for (const round of rounds) {
      const failed = evidence.runs.filter((run) => run.round === round && run.outcome !== "passed");
      // 원인·재실행·기준 갱신은 새 기록(retry·testFreeze)이 있을 때만 붙인다 — 옛 증거의 ⑧ 은 바이트가 그대로다
      const cause = evidence.retry?.causes?.[String(round)];
      const reruns = evidence.retry?.reruns?.[String(round)] ?? 0;
      const rebased = (evidence.testFreeze?.rebased ?? []).filter((entry) => entry.round === round);
      lines.push(
        `- ${round}회차${cause ? ` (${CAUSE_LABEL[cause]})` : ""}: ` +
          `${failed.length === 0 ? "전부 통과" : `실패 ${failed.map((run) => `${run.kind}(${run.outcome})`).join(", ")}`}` +
          (reruns ? ` · 같은 코드 재실행 ${reruns}회` : "") +
          rebased.map((entry) => ` · ${entry.by === "finding" ? "⑨ 지적" : COUNTER_LABEL.collect}으로 바뀐 테스트 파일: ${entry.files.join(", ")}`).join(""),
      );
    }
  }

  // 사람이 늘린 한도(judgment retry-grant) — 기록이 있을 때만 절이 붙는다(옛 증거의 ⑧ 은 바이트가 그대로다)
  const grants = evidence.retry?.grants ?? [];
  if (grants.length > 0) lines.push("", "## 사람 허용", "", ...grants.map((grant) => `- ${grantText(grant)}`));

  const failures = evidence.runs.filter((run) => run.outcome === "failed" || run.outcome === "error");
  if (failures.length > 0) {
    lines.push("", "## 실패 로그", "");
    for (const run of failures) {
      lines.push(`### ${run.round}회차 ${run.kind} — ${outcomeText(run)}`, "", "```", run.tail.trimEnd() || "(출력 없음)", "```", "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// ---- ⑦ 대조 ----

/**
 * ⑦ 의 TC id 가 실제로 확인됐는가.
 *
 * 실행 결과의 상태만 통과·실패 증거다. 테스트 단계가 있으면 통과한 id는 테스트 파일에도 있어야 한다.
 * 실제 결과가 없으면 unknown으로 남긴다. skip·누락·미지원 출력은 통과가 아니다.
 */
export function testCaseEvidence(work: Work, output: string): TestCaseEvidence[] {
  const spec = readWorkDoc(work.repoRoot, work.active.id, "07-test-spec");
  const cases = spec ? parseTestCases(spec) : [];
  const testFiles = tcSearchFiles(work);
  const requireTestSource = work.stages.some(stage => stage.kind === "test") || work.order.kind === "refactor";
  const results = parseTestResults(output);
  const sources = testFiles.map((path) => {
    const full = join(work.repoRoot, path);
    return { path, text: existsSync(full) ? readFileSync(full, "utf-8") : "" };
  });

  return cases.map((entry) => {
    // id 가 다른 id 의 앞부분이면 안 된다 — TC-1 이 TC-12 에 걸리면 덮이지 않은 것이 덮인 것으로 읽힌다
    const token = tcToken(entry.id);
    const result = resultFor(entry.id, results);
    const found = sources.find((source) => token.test(source.text));
    if (result.status === "passed" && requireTestSource && !found) {
      return { id: entry.id, status: "unknown", source: "출력" as const, where: "출력에만 있음 — 테스트 파일에 같은 TC 토큰을 넣고 실제 테스트를 실행하세요" };
    }
    if (result.status !== "unknown") {
      return { id: entry.id, status: result.status, source: "출력" as const, where: `테스트 실행 결과 (${result.format})` };
    }
    return found
      ? { id: entry.id, status: "unknown", source: "테스트 파일" as const, where: found.path }
      : { id: entry.id, status: "unknown", source: "없음" as const };
  });
}

/** `kind: "test"` 단계에 속한 계획 파일 — 동결과 ⑦ 대조가 같은 선언을 딛는다 */
export function testStageFiles(work: Work): string[] {
  const keys = new Set(work.stages.filter((stage) => stage.kind === "test").map((stage) => stage.key));
  return (work.plan?.files ?? []).filter((file) => keys.has(file.stage)).flatMap(filePaths);
}
