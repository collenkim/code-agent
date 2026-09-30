import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join, posix } from "path";

import { hashManifest, hashPlan } from "../core/approval";
import type { Manifest, StageDef } from "../core/manifest";
import { writeAtomic } from "../core/atomic";
import { docPaths, firstListNames, sectionBody } from "./docs";
import { knowledgePath } from "./knowledge";
import { verifyFile, workDocsDir } from "./layout";
import { KNOWLEDGE_KINDS, SCHEMAS } from "./schemas";
import { changedPaths, partialTreeHash, trackedPaths } from "./tree";
import type { Change } from "./tree";
import { approvalOf } from "./work";
import type { Work } from "./work";
import { parseTestCases, readWorkDoc } from "./workDocs";

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
  /** 고쳐 쓰기 회차. 명령을 돌리기 **전에** 올린다 */
  round: number;
  phase: VerifyPhase;
  /** 매니페스트의 명령 이름 (build · test · 선언된 commands 의 키) */
  kind: string;
  command: string;
  outcome: Outcome;
  status: number | null;
  /** `.code-agent/log/` 의 전체 로그. 커밋되지 않으므로 근거는 tail 이 든다 */
  logFile?: string;
  /** 실패·error 는 마지막 40줄, 통과는 마지막 5줄 */
  tail: string;
  at: string;
}

/** ⑦ 의 TC 하나가 이번 실행에서 어떻게 확인됐는가 */
export interface TestCaseEvidence {
  id: string;
  /**
   * `출력` — 테스트 실행 출력에 TC id 가 그대로 나왔다.
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
  /** 그 id 들이 어디서 확인됐는가 — testCaseEvidence 와 같은 두 갈래 */
  found: TestCaseEvidence[];
}

export interface Evidence {
  id: string;
  target: string;
  baseCommit: string;
  /** 계획 파일만의 부분 트리 해시 */
  treeHash: string;
  manifestHash: string;
  planHash: string;
  /** 고쳐 쓰기 회차 — check 를 한 번 돌 때마다 +1 */
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
  /**
   * fix 의 재현. 있으면 (a) 비-test 계획 파일 쓰기가 열리고 (b) kind:"test" 단계 파일이 언다.
   * 옛 증거에는 없어 optional 이다. 묶임이 깨지면 증거와 함께 버려진다 — 재승인하면 다시 봐야 한다.
   */
  repro?: ReproEvidence;
  at: string;
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
  return (work.plan?.files ?? []).map((file) => file.path);
}

/** 이 작업의 계획 파일들을 지금 해시한 값 — 증거의 treeHash 와 대조한다 */
export function treeHashNow(work: Work): string {
  return partialTreeHash(work.repoRoot, planPaths(work));
}

/** kind:"test" 단계 계획 파일만의 부분 트리 해시 — 재현을 본 트리를 가리킨다 */
export function testTreeHashNow(work: Work): string {
  return partialTreeHash(work.repoRoot, testStageFiles(work));
}

/**
 * 재현 증거가 지금 계획 위의 것인가 — 없으면 왜 없는지 한 줄. 있으면 undefined.
 *
 * **스테이지가 아니라 증거로 잰다** — `code-agent back implement` 로 커서를 빼서 푸는 길을 막는다.
 * 계획을 재승인하면 planHash 가 달라져 동결과 **함께** 풀린다 (같은 규칙, 의도).
 *
 * 첫 `check` 뒤에는 테스트 트리 해시를 대조하지 않는다. ⑨ 지적으로 동결을 풀어 재현 테스트를 고친
 * 순간 고칠 파일이 다시 잠기면 수정 루프가 교착된다 — 재현은 *쓰기 순서* 규칙이지 *영구* 규칙이 아니다.
 * 루프가 시작된 뒤의 강제력은 동결과 ⑦ 대조(재현 TC 가 passed·확인돼야 한다)가 든다.
 */
export function reproMissing(work: Work, evidence: Evidence | undefined): string | undefined {
  if (!evidence || !work.plan || evidence.planHash !== hashPlan(work.plan) || !evidence.repro) {
    return "재현을 본 기록이 없습니다";
  }
  if (evidence.runs.some((run) => run.phase === "check")) {
    return undefined;
  }
  const now = testTreeHashNow(work);
  return evidence.repro.testTreeHash === now
    ? undefined
    : `재현을 본 뒤 테스트 파일이 바뀌었습니다 (${evidence.repro.testTreeHash.slice(-12)} ≠ ${now.slice(-12)}) — code-agent repro 를 다시 돌리세요`;
}

// ---- refactor: 기존 테스트 보호 ----

/**
 * 한 단계가 **스스로 밝힌** 테스트 자리. 밝히지 않았으면 빈 목록이다.
 *
 * `domainBase` 로 물러서지 않는다 — 그러면 소스 루트 전체가 "기존 테스트" 가 되어, 테스트가 소스
 * 옆에 있는 프로젝트(`*.test.ts` · `_test.go` · pytest)에서 refactor 가 **제 파일도** 못 고친다.
 * 자리를 밝히지 않은 단계는 테스트 파일을 가려낼 수 없어 아무것도 지키지 못한다
 * (`code-agent manifest check` 가 그 사실을 경고한다).
 */
export function stageTestRoots(stage: StageDef): string[] {
  const roots =
    stage.scope === "project" && stage.outputDirs.length > 0 ? stage.outputDirs : stage.base ? [stage.base] : [];
  return roots.map((root) => root.replace(/\/+$/, "")).filter((root) => root !== "");
}

/**
 * kind:"test" 단계가 덮는 저장소 기준 경로 접두어.
 *
 * **매니페스트의 모든 `kind:"test"` 단계를 본다** — `work.stages` 는 이번 종류로 도는 단계뿐이라,
 * `kinds` 에서 `refactor` 를 뺀 테스트 단계(새 테스트를 만들지 않으니 자연스러운 선언)가 거기서
 * 사라지고 기존 테스트 보호가 세 자리(제출 · 쓰기 · 검증)에서 한꺼번에 꺼진다.
 */
export function testRoots(work: Work): string[] {
  return work.manifest.stages.filter((stage) => stage.kind === "test").flatMap(stageTestRoots);
}

/** 기준 커밋에 이미 있던 테스트 파일 — refactor 가 손대면 안 되는 것 */
export function trackedTestFiles(work: Work): string[] {
  const roots = testRoots(work);
  if (!work.active.baseCommit || roots.length === 0) {
    return [];
  }
  return trackedPaths(work.repoRoot, work.active.baseCommit).filter((path) =>
    roots.some((root) => path === root || path.startsWith(`${root}/`)),
  );
}

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
 * KNOWLEDGE 3종을 넣어 둔 이유 — `deliver` 가 사람이 고른 항목을 **코드로** 적용한 뒤 커밋한다.
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
    ...KNOWLEDGE_KINDS.map((kind) => knowledgePath(work.manifest, kind)),
  ]);
  const prefixes = [`${workDocsDir(active.id)}/`, ".code-agent/"];
  return changedPaths(repoRoot, active.baseCommit).filter(
    (change) => !allowed.has(change.path) && !prefixes.some((prefix) => change.path.startsWith(prefix)),
  );
}

/** 계획에 있는데 사라진 파일 — 지워서 통과시키는 길 */
export function missingPlanFiles(work: Work): string[] {
  return planPaths(work).filter((path) => !existsSync(join(work.repoRoot, path)));
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

/** `not-run` · `error` · `skipped` 는 통과가 아니다 — passed 만 통과다 */
export function failedRuns(runs: VerifyRun[]): VerifyRun[] {
  return runs.filter((run) => run.outcome !== "passed");
}

/**
 * 고쳐 쓰기 한도를 넘겼는가. **실패한 채로** 넘긴 경우만이다 —
 * 통과한 뒤 회차가 남아 있는 것은 막을 이유가 없다.
 *
 * 1회차는 처음 돌려 본 것이라 고쳐 쓰기로 세지 않는다. 한도 2면 3회차 실패까지가 끝이다.
 */
export function fixLimit(work: Work, evidence: Evidence): number {
  return evidence.fixRounds ?? work.manifest.fixRounds;
}

export function overFixLimit(work: Work, evidence: Evidence): boolean {
  return (
    evidence.rounds > fixLimit(work, evidence) &&
    (["check", "test"] as const).some((phase) => failedRuns(runsOf(evidence, phase)).length > 0)
  );
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

/** 스테이지 하나를 마쳤다고 할 수 있는가 — 증거 · 묶임 · 계획 대조 · 결과 전부 */
export function stageProblems(work: Work, phase: VerifyPhase): string[] {
  const problems: string[] = [];
  const approval = approvalOf(work);
  if (approval.status !== "approved") {
    problems.push(`계획 승인이 ${approval.status} 입니다 — 승인 위에서 난 증거가 아니면 통과가 아닙니다`);
  }
  const evidence = loadEvidence(work.repoRoot, work.active.id, work.active.target);
  if (!evidence) {
    problems.push(`검증 증거가 없습니다 — code-agent ${phase} 를 돌리세요`);
    return problems;
  }
  problems.push(...bindingProblems(work, evidence));
  for (const change of outsideChanges(work)) {
    problems.push(`계획 밖 변경: [${change.status}] ${change.path}`);
  }
  for (const path of missingPlanFiles(work)) {
    problems.push(`계획에 있는데 없는 파일: ${path}`);
  }
  problems.push(...preservedTestProblems(work));

  // 재현은 "**그 테스트 트리 위에서** 봤다" 는 주장이다. 첫 check 뒤로는 hook 이 대조를 내려
  // (⑨ 지적으로 푼 수정 루프가 교착되지 않게) 재현 테스트를 고칠 길이 생기는데, 그러고도 ⑧·⑩ 은
  // 옛 해시를 그대로 찍는다. 반영 직전에 한 번 다시 맞춰, 반영되는 테스트가 재현을 본 그 테스트인지 본다.
  if (phase === "integrate" && evidence.repro) {
    const now = testTreeHashNow(work);
    if (evidence.repro.testTreeHash !== now) {
      problems.push(
        `재현을 본 테스트 트리가 지금과 다릅니다 (${evidence.repro.testTreeHash.slice(-12)} ≠ ${now.slice(-12)}) — ` +
          "⑧ 의 재현 줄이 반영될 테스트를 가리키지 않습니다. 재현을 본 상태로 되돌리거나, " +
          "계획을 재승인해 재현부터 다시 보세요",
      );
    }
  }

  const runs = runsOf(evidence, phase);
  if (runs.length === 0) {
    problems.push(`${phase} 를 돌린 기록이 없습니다 — code-agent ${phase} 를 돌리세요`);
  } else if (Math.max(...runs.map((run) => run.round)) !== evidence.rounds) {
    // 앞 회차의 통과로 지금 회차를 덮지 않는다 — 고쳐 쓴 뒤 check 만 다시 돌리고 test 는 건너뛰는 길
    problems.push(`${phase} 결과가 ${evidence.rounds}회차의 것이 아닙니다 — code-agent ${phase} 를 다시 돌리세요`);
  }
  for (const run of failedRuns(runs)) {
    problems.push(`${run.kind}: ${run.outcome} (${run.command})`);
  }
  if (phase === "test") {
    const uncovered = evidence.testCases.filter((entry) => entry.source === "없음").map((entry) => entry.id);
    if (uncovered.length > 0) {
      problems.push(
        `⑦ 의 테스트 케이스가 확인되지 않았습니다: ${uncovered.join(", ")} — ` +
          "테스트 출력이나 kind:\"test\" 단계의 테스트 파일에 TC id 를 남기세요",
      );
    }
  }

  // ⑧ 은 코드가 렌더한 것만 유효하다 — 손으로 고친 것은 바이트 대조에서 드러난다
  const rendered = join(work.repoRoot, validationDocFile(work.active.id));
  const expected = renderValidationDoc(work, evidence);
  if (!existsSync(rendered) || readFileSync(rendered, "utf-8") !== expected) {
    problems.push(`${validationDocFile(work.active.id)} 가 증거와 다릅니다 — code-agent ${phase} 가 다시 렌더합니다`);
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
    `- 고쳐 쓰기 회차: ${evidence.rounds}`,
    ...(evidence.repro
      ? [`- 재현: ${evidence.repro.cases.join(", ")} · 테스트 트리 ${evidence.repro.testTreeHash} (${evidence.repro.at})`]
      : []),
    "",
    "## 실행 결과",
    "",
    "| 회차 | 스테이지 | 종류 | 명령 | 결과 | exit |",
    "|---|---|---|---|---|---|",
  ];
  for (const run of evidence.runs) {
    lines.push(
      `| ${run.round} | ${run.phase} | ${run.kind} | ${run.command || "(선언 없음)"} | ${OUTCOME_LABEL[run.outcome]} | ${run.status ?? "-"} |`,
    );
  }
  if (evidence.runs.length === 0) {
    lines.push("| - | - | - | - | 아직 돌리지 않았습니다 | - |");
  }

  lines.push("", "## 테스트", "");
  if (evidence.testCases.length === 0) {
    lines.push("- ⑦ 의 테스트 케이스를 읽지 못했습니다 (07-test-spec.md 의 표를 확인하세요)");
  } else {
    lines.push("| TC | 확인된 곳 | 근거 |", "|---|---|---|");
    for (const entry of evidence.testCases) {
      lines.push(`| ${entry.id} | ${entry.source} | ${entry.where ?? "-"} |`);
    }
  }

  // 0회차(재현)는 고쳐 쓰기가 아니다 — 수정 루프 목록에 섞이면 회차 세는 자리가 어긋나 보인다
  const rounds = [...new Set(evidence.runs.filter((run) => run.round >= 1).map((run) => run.round))].sort((a, b) => a - b);
  if (rounds.length > 1) {
    lines.push("", "## 수정 루프", "");
    for (const round of rounds) {
      const failed = evidence.runs.filter((run) => run.round === round && run.outcome !== "passed");
      lines.push(
        `- ${round}회차: ${failed.length === 0 ? "전부 통과" : `실패 ${failed.map((run) => `${run.kind}(${run.outcome})`).join(", ")}`}`,
      );
    }
  }

  const failures = evidence.runs.filter((run) => run.outcome === "failed" || run.outcome === "error");
  if (failures.length > 0) {
    lines.push("", "## 실패 로그", "");
    for (const run of failures) {
      lines.push(`### ${run.round}회차 ${run.kind} — ${OUTCOME_LABEL[run.outcome]}`, "", "```", run.tail.trimEnd() || "(출력 없음)", "```", "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// ---- ⑦ 대조 ----

/**
 * ⑦ 의 TC id 가 실제로 확인됐는가.
 *
 * **두 갈래를 둔 이유** — 테스트 출력에서 TC id 를 읽어 내는 것은 프레임워크마다 형식이 달라
 * 일반적으로 되지 않는다(JUnit·pytest·go test 가 전부 다르다). 그래서 ① 실행 출력에 id 가 그대로
 * 나오면 그것으로 인정하고, ② 나오지 않으면 `kind: "test"` 단계의 계획 파일이 그 id 를 들고 있는지
 * 본다 — 컨벤션의 `테스트 규칙` 이 "테스트 이름·주석에 TC id 를 남긴다"고 정한 그 자리다.
 * 둘 다 아니면 `없음` 이고, 통과로 세지 않는다.
 */
export function testCaseEvidence(work: Work, output: string): TestCaseEvidence[] {
  const spec = readWorkDoc(work.repoRoot, work.active.id, "07-test-spec");
  const cases = spec ? parseTestCases(spec) : [];
  const testFiles = testStageFiles(work);
  const sources = testFiles.map((path) => {
    const full = join(work.repoRoot, path);
    return { path, text: existsSync(full) ? readFileSync(full, "utf-8") : "" };
  });

  return cases.map((entry) => {
    // id 가 다른 id 의 앞부분이면 안 된다 — TC-1 이 TC-12 에 걸리면 덮이지 않은 것이 덮인 것으로 읽힌다
    const token = new RegExp(`\\b${entry.id}\\b`);
    if (token.test(output)) {
      return { id: entry.id, source: "출력" as const, where: "테스트 실행 출력" };
    }
    const found = sources.find((source) => token.test(source.text));
    return found
      ? { id: entry.id, source: "테스트 파일" as const, where: found.path }
      : { id: entry.id, source: "없음" as const };
  });
}

/** `kind: "test"` 단계에 속한 계획 파일 — 동결과 ⑦ 대조가 같은 선언을 딛는다 */
export function testStageFiles(work: Work): string[] {
  const keys = new Set(work.stages.filter((stage) => stage.kind === "test").map((stage) => stage.key));
  return (work.plan?.files ?? []).filter((file) => keys.has(file.stage)).map((file) => file.path);
}
