/**
 * 테스트 수정 창 — 동결된 kind:test 파일의 **테스트 구현 오류**를 지정 테스트 담당이 제한 범위에서 고치는 길.
 *
 * 동결(evidence.testFreeze)은 실패한 단언을 지워 통과시키는 길을 닫는다. 그런데 테스트 자체의 결함(원인 없는 예외의 null 단언,
 * `List.of(null)`, TC 표기, 빈 디렉터리와 파일 존재의 구분)도 같은 자리에서 막혀 재계획·재승인이 유일한 길이 된다. 창은 그 사이의
 * 좁은 길이다:
 *
 * - 연다(testRepairCommand.ts): 지금 계획·증거에 묶인 동결 상태에서, 마지막 실행에서 실패(표기 원인은 미인식)한 ⑦ 의 TC 만, 그 TC 토큰이
 *   있는 kind:test 계획 파일만, 정해진 원인 분류와 근거로. 한 번에 창 하나다.
 * - 쓴다(hook freezeReason): 창의 파일은 지정 테스트 담당(ca-tester)만 쓴다 — 메인·구현 담당은 그대로 막힌다.
 * - 닫는다(validate.ts check 의 새 회차): 기계 검사(`repairProblems` — TC 토큰 유지·창의 TC 인식·건너뛰기 표지 증가 없음)를 통과하면
 *   그 파일의 동결 기준을 다시 굳힌다(`by: "repair"`). 통과하지 못하면 거부를 쌓고 창은 열어 둔다 — 지정 담당이 다시 고치거나 되돌리고,
 *   그동안 test·integrate 게이트가 바뀐 파일과 거부 사유로 막는다. 파일이 동결 기준과 같은(고치지 않았거나 되돌린) 창은 새 창이 대신한다.
 * - 검토한다: 받아들인 창은 다음 리뷰 회차의 context 에 싣고(단언 수 변화 포함), 리뷰 게이트는 받아들인 뒤 연 회차를 요구한다.
 *
 * ⑦·AC·테스트 전략은 바꾸지 않는다 — 기대 결과를 바꿔야 통과하는 것은 테스트 구현 오류가 아니라 제품 의미 변경이고 재계획 경로다.
 * 창은 고쳐 쓰기 회차 안에서 돈다(받아들이는 check 가 새 회차를 연다). 계획을 다시 승인하면 증거와 함께 버려진다.
 */
import { tcToken } from "./testResults";
import type { Evidence, TestCaseEvidence } from "./evidence";

export const REPAIR_CAUSES = ["assertion", "fixture", "notation", "filesystem"] as const;
export type RepairCause = typeof REPAIR_CAUSES[number];
export const REPAIR_CAUSE_LABEL: Readonly<Record<RepairCause, string>> = {
  assertion: "단언 형식·null 처리", fixture: "테스트 데이터·컬렉션 구성", notation: "TC 표기(결과 인식)", filesystem: "파일·디렉터리 판정",
};
/** 한 창이 여는 TC 수 상한 — 여러 원인을 한 창에 섞지 않게 */
export const REPAIR_MAX_CASES = 10;
/** 창을 연 지정 테스트 담당(공통 이름) */
export const REPAIR_AGENT = "ca-tester";

/** 파일 하나의 기계 검사 기준 — TC 토큰·건너뛰기 표지·단언 꼴의 수 */
export interface RepairFileStats { tcs: string[]; skips: number; asserts: number }
export interface TestRepair {
  /** 1부터 — 같은 증거 묶임 안의 창 번호 */
  n: number;
  at: string;
  /** 연 때의 검증 회차 */
  round: number;
  cause: RepairCause;
  reason: string;
  cases: string[];
  files: string[];
  /** 연 때의 파일별 기준 */
  baseline: Record<string, RepairFileStats>;
  accepted?: { round: number; at: string; stats: Record<string, RepairFileStats> };
  /** 기계 검사를 통과하지 못한 회차들 — 창은 열린 채다 */
  rejections?: { round: number; at: string; problems: string[] }[];
  /** 고친 것 없이 다음 창(by)이 대신했다 */
  withdrawn?: { at: string; by: number };
}

const TC_ANY = /(?<![A-Za-z0-9])TC-\d+(?![A-Za-z0-9])/g;
/**
 * 실행을 건너뛰게 하는 표지 — JUnit·TestNG·Jest/Mocha/Vitest·pytest·unittest·Go 의 흔한 꼴. 창의 파일에서 이 수가 늘면 거부한다
 * (실패하는 TC 를 끄는 것은 테스트 구현 수정이 아니다).
 */
const SKIP_MARKERS = /@Disabled\b|@Ignore\b|\b(?:it|test|describe|context)\s*\.\s*(?:skip|todo)\b|\bx(?:it|test|describe|context)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.skip\s*\(|@unittest\.skip|\bt\.Skip(?:Now|f)?\s*\(|\bassume(?:True|False|That|NotNull)\s*\(|\bAssumptions\s*\.|\bpending\s*\(/g;
/** 단언 꼴 — 수가 줄면 리뷰어에게 알린다(막지 않는다: 단언 두 줄을 한 줄로 고치는 정당한 수정이 있다) */
const ASSERT_MARKERS = /\bassert\w*\s*\(|\bexpect\s*\(|\bverify\s*\(|\.should\w*\b|\bassert\s+(?!\()/g;

export function repairFileStats(text: string): RepairFileStats {
  const tcs = [...new Set(text.match(TC_ANY) ?? [])].sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
  return { tcs, skips: (text.match(SKIP_MARKERS) ?? []).length, asserts: (text.match(ASSERT_MARKERS) ?? []).length };
}

/** 열려 있는 창 — 받아들이지도 다음 창이 대신하지도 않은 마지막 창 */
export function openRepair(evidence: Pick<Evidence, "testRepairs"> | undefined): TestRepair | undefined {
  const last = evidence?.testRepairs?.at(-1);
  return last && !last.accepted && !last.withdrawn ? last : undefined;
}

/** 이 TC 의 마지막 결과 — 통합 검증 결과가 있으면 그쪽(나중 실행)도 본다 */
export function caseResults(evidence: Pick<Evidence, "testCases" | "integrationTestCases">, id: string): TestCaseEvidence[] {
  return [...evidence.testCases, ...(evidence.integrationTestCases ?? [])].filter((entry) => entry.id === id);
}

/**
 * 창의 기계 검사 — 지금 파일 본문(읽지 못한 파일은 undefined)을 연 때의 기준과 대조한다. 셋이다:
 * 연 때 파일에 있던 TC 토큰이 그대로 있다(TC 를 지우거나 다른 파일로 옮기지 않는다), 창의 TC 가 창의 파일 어딘가에 인식되는 꼴로 있다,
 * 건너뛰기 표지가 늘지 않았다. 파일을 지운 것도 거부다.
 */
export function repairProblems(repair: TestRepair, texts: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  for (const path of repair.files) {
    const text = texts[path];
    if (text === undefined) { problems.push(`${path}: 파일이 없습니다 — 창의 테스트 파일은 지우지 않습니다`); continue; }
    const now = repairFileStats(text), before = repair.baseline[path];
    if (!before) continue;
    const lost = before.tcs.filter((id) => !now.tcs.includes(id));
    if (lost.length) problems.push(`${path}: TC 토큰이 사라졌습니다(${lost.join(", ")}) — TC 를 지우거나 옮기지 않습니다`);
    if (now.skips > before.skips) problems.push(`${path}: 건너뛰기·조건부 실행 표지가 ${before.skips} → ${now.skips}개로 늘었습니다 — 실패하는 TC 를 끄지 않습니다`);
  }
  for (const id of repair.cases) {
    if (!repair.files.some((path) => texts[path] !== undefined && tcToken(id).test(texts[path]!))) {
      problems.push(`${id}: 창의 파일 어디에도 결과 인식 꼴(${id})이 없습니다`);
    }
  }
  return problems;
}

/** 리뷰 context 의 한 창 줄 — 원인·TC·파일과 단언 꼴 수 변화 */
export function repairReviewLines(repair: TestRepair): string[] {
  const stats = repair.accepted?.stats ?? {};
  const asserts = repair.files.map((path) => {
    const before = repair.baseline[path]?.asserts, after = stats[path]?.asserts;
    return before === undefined || after === undefined ? `${path}` : `${path} (단언 꼴 ${before} → ${after}${after < before ? " — 줄었다" : ""})`;
  });
  return [
    `- 창 #${repair.n} · ${REPAIR_CAUSE_LABEL[repair.cause]} · ${repair.cases.join(", ")} — 근거: ${repair.reason.replace(/\s+/g, " ")}`,
    `  - 고친 파일: ${asserts.join(", ")}`,
  ];
}
