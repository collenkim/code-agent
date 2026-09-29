import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join, posix } from "path";

import { hashManifest, hashPlan } from "../core/approval";
import type { Manifest } from "../core/manifest";
import { writeAtomic } from "../core/atomic";
import { docPaths, firstListNames, sectionBody } from "./docs";
import { knowledgePath } from "./knowledge";
import { verifyFile, workDocsDir } from "./layout";
import { KNOWLEDGE_KINDS, SCHEMAS } from "./schemas";
import { changedPaths, partialTreeHash } from "./tree";
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

/** 증거를 남기는 스테이지 — 7 정적 분석 · 8 테스트 · 10 통합 검증. 셋이 한 증거 파일에 쌓인다 */
export type VerifyPhase = "check" | "test" | "integrate";

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

function specs(repoRoot: string, manifest: Manifest, always: string[], names: string[]): CommandSpec[] {
  const kinds = [...new Set([...always, ...names])];
  return kinds.map((kind) => ({ kind, argv: argvOf(manifest, kind) }));
}

/** 7 정적 분석·컴파일 — build + 품질·보안 기준이 이름으로 적은 명령 */
export function checkCommands(repoRoot: string, manifest: Manifest): CommandSpec[] {
  return specs(repoRoot, manifest, ["build"], namesFrom(repoRoot, manifest, "quality", ["static", "security"]));
}

/** 8 테스트 — test + 테스트 전략이 이름으로 적은 명령 */
export function testCommands(repoRoot: string, manifest: Manifest): CommandSpec[] {
  return specs(repoRoot, manifest, ["test"], namesFrom(repoRoot, manifest, "test-strategy", ["tools"]));
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

  const rounds = [...new Set(evidence.runs.map((run) => run.round))].sort((a, b) => a - b);
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
