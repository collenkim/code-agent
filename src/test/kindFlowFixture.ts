import { createRepo, removeRepo, repoTools, PASS } from "./repoFixture";
export { PASS, NOT_INSTALLED } from "./repoFixture";
import { strict as assert } from "node:assert";

import { readFileSync } from "node:fs";

import { join } from "node:path";

import { recordDecision } from "../core/approval";
import { next, requireValidatable } from "../agent/commands";
import { deliver, prDocFile } from "../agent/deliver";
import { withInteraction } from "../agent/tty";

import { loadEvidence } from "../agent/evidence";

import { loadActive } from "../agent/layout";
import { openRound, reviewDocFile } from "../agent/review";
import { recordReviewFixture } from "./reviewFixture";
import { check, integrate, runTests } from "../agent/validate";
import { approvalDocsHash, loadWork } from "../agent/work";

/**
 * 종류별 흐름 픽스처(p6 에서 꺼냈다) — fix·refactor·feature 흐름 시험(fix-flow·refactor-flow·deliver-scope)이 함께 쓴다.
 * `repo` 는 newRepo 가 정하는 지금 시험의 저장소다(실시간 바인딩).
 *
 * fix 의 재현 먼저 · refactor 의 동작 보존 · 종류별 단계 · 빈 저장소 ·
 * deliver 커밋 범위 · integrate 의 prepare.
 *
 * 임시 git 저장소에 실제 함수를 그대로 부르고, 검증 명령은 node 한 줄짜리
 * 스크립트라 통과·실패·없는 실행 파일을 이 머신에서 재현할 수 있다.
 */

export const FAIL = ["node", "-e", "process.exit(4)"];

export const SRC = "src/main/app/order.js";
export const REPRO_TEST = "src/test/order.test.js";
export const KEPT_TEST = "src/test/existing.test.js";

/** 고치기 전에는 실패하고 고친 뒤에는 통과한다 — 재현과 수정 확인을 한 스크립트로 */
export const FAIL_UNTIL_FIXED = [
  "node",
  "-e",
  `const fixed=require('fs').readFileSync('${SRC}','utf-8').includes('fixed');console.log((fixed?'ok':'not ok')+' 1 - TC-1'); process.exit(fixed ? 0 : 3)`,
];
/** 같은 판정인데 TC id 를 찍지 않는다 — 출력 갈래가 비는 경우 */
export const SILENT_FAIL = [
  "node",
  "-e",
  `process.exit(require('fs').readFileSync('${SRC}','utf-8').includes('fixed') ? 0 : 3)`,
];

// ---- 공통 POLICY 문서 ----

export const ARCH = [
  "# 아키텍처",
  "## 기술 스택", "Node.js",
  "## 모듈/패키지 구조", "src/main/app/<파일>.js",
  "## 계층과 책임", "- app: 애플리케이션 코드",
  "## 의존 방향", "test → app",
  "## 공통 모듈", "없음",
  "## 주요 결정", "- 식별자: 문자열",
].join("\n");

export const CONV = [
  "# 코드 컨벤션",
  "## 명명", "- 파일은 소문자",
  "## 계층별 규칙", "- app 은 순수 함수로",
  "## 예외 처리", "- Error 를 던진다",
  "## 테스트 규칙", "- 테스트 이름·주석에 TC id 를 남긴다",
].join("\n");

export const STRATEGY = ["# 테스트 전략", "## 수준과 범위", "- Unit: 필수", "## 도구와 실행 명령", "- `test`: 전체 테스트", "## 통과 기준", "- AC 마다 1케이스"].join("\n");
/** 테스트 자리에서 두 명령이 도는 전략 문서 — 하나는 통과하고 하나는 실패하는 경우를 만든다 */
export const STRATEGY_TWO = ["# 테스트 전략", "## 수준과 범위", "- Unit: 필수", "## 도구와 실행 명령", "- `test`: 전체 테스트", "- `smoke`: 연기 테스트", "## 통과 기준", "- AC 마다 1케이스"].join("\n");
/** 매니페스트에 test 선언이 없을 때 쓰는 전략 문서 — 문서가 없는 명령 이름을 부르면 확정 게이트가 먼저 막는다 */
export const STRATEGY_NO_TEST =["# 테스트 전략", "## 수준과 범위", "- Unit: 필수", "## 도구와 실행 명령", "- 없음 — 아직 자동 실행 명령이 없다", "## 통과 기준", "- AC 마다 1케이스"].join("\n");
export const QUALITY = ["# 품질·보안 기준", "## 정적 분석", "- `build`: 컴파일", "## 보안 검사", "- 없음 — 리뷰에서 본다", "## 통과 기준과 반영 차단", "- 컴파일 실패는 반영을 막는다"].join("\n");
/** 문서가 `prepare` 를 명령 이름으로 적은 경우 — 작업 트리에서 준비 명령이 풀리면 안 된다 */
export const STRATEGY_PREPARE = ["# 테스트 전략", "## 수준과 범위", "- Unit: 필수", "## 도구와 실행 명령", "- `test`: 전체 테스트", "- `prepare`: 의존성", "## 통과 기준", "- AC 마다 1케이스"].join("\n");
export const QUALITY_PREPARE = ["# 품질·보안 기준", "## 정적 분석", "- `build`: 컴파일", "- `prepare`: 의존성", "## 보안 검사", "- 없음 — 리뷰에서 본다", "## 통과 기준과 반영 차단", "- 컴파일 실패는 반영을 막는다"].join("\n");

// ---- 저장소 헬퍼 ----

export let repo: string;

export const { write, git, hook, writeFileHook, confirmDocs } = repoTools(() => repo);

export function approve(): void {
  const work = loadWork(repo)!;
  recordDecision(repo, {
    order: work.order,
    target: work.active.target,
    plan: work.plan!,
    manifest: work.manifest,
    // 실제 `decide()` 가 늘 넣는 값이다 — 빼면 stale-docs 판정이 영영 걸리지 않아
    // 테스트의 승인이 프로덕션보다 약해진다 (checkApproval 의 `record.docsHash !== undefined`).
    docsHash: approvalDocsHash(work),
    decision: "approved",
    approver: "test",
    presence: { channel: "tty", verified: true, detail: "테스트" },
  });
}

export function newRepo(prefix: string): void {
  repo = createRepo(prefix);
  write("doc/architecture.md", ARCH);
  write("doc/conventions.md", CONV);
  write("doc/test-strategy.md", STRATEGY);
  write("doc/quality.md", QUALITY);
  write(".gitignore", "build/\n");
}

export function dropRepo(): void {
  removeRepo(repo);
}

/** 승인·리뷰 관찰만 fixture로 제공하고 검증·통합·반영은 실제 코드로 끝까지 실행한다. */
export async function finishDelivery(id: string, target: string): Promise<void> {
  await check(requireValidatable(repo, "check")); next(repo);
  await runTests(requireValidatable(repo, "test")); next(repo);
  openRound(requireValidatable(repo, "review"));
  const review = reviewDocFile(id);
  write(review, readFileSync(join(repo, review), "utf8") + "\n- 없음\n");
  recordReviewFixture(repo);
  next(repo); await integrate(requireValidatable(repo, "integrate")); next(repo);
  write(prDocFile(id), "## 요약\n회귀 수정\n## 확인 방법\n실제 테스트 실행\n## 위험·되돌리기\n테스트 fixture\n");
  const output = withInteraction({ confirm: () => ({ channel: "tty", verified: true, detail: "automated fixture" }), ask: () => "n" },
    () => deliver(requireValidatable(repo, "deliver")));
  assert.match(output, /반영했습니다/);
  assert.equal(loadActive(repo), undefined);
  assert.match(git("show", "--name-only", "--format=", "HEAD"), /10-pr\.md/);
  assert.equal(loadEvidence(repo, id, target)!.integrationTestCases!.every(entry => entry.status === "passed"), true);
}

/** 두 단계(코드·테스트)짜리 매니페스트 — 종류는 셋 다 돈다 */
export function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    language: "javascript",
    sourceExtensions: [".js"],
    domainBase: "src/main",
    domainRoots: ["app"],
    conventions: ["doc/conventions.md"],
    docs: { architecture: "doc/architecture.md" },
    build: PASS,
    test: FAIL_UNTIL_FIXED,
    // 선언 순서는 코드 → 테스트다. fix 가 테스트를 먼저 세우는지가 여기서 드러난다
    stages: [
      { key: "code", title: "코드", template: "01-code.md", kinds: ["feature", "fix", "refactor"], scope: "project", outputDirs: ["src/main"] },
      { key: "test", title: "테스트", template: "02-test.md", kind: "test", kinds: ["feature", "fix", "refactor"], scope: "project", outputDirs: ["src/test"] },
    ],
    ...overrides,
  });
}

// ==== 1. fix — 재현 먼저 ====

export const FIX_HEAD = [
  "---", "kind: fix", "id: FIX-1", "title: 총액이 0 으로 나온다",
  `target: ${SRC}`, "scope: [src/main, src/test]", "preserve: [주문 조회 API 시그니처]",
  "---", "", "총액이 0 으로 나온다.", "",
].join("\n");
/** 오류 로그 없는 신고 — 사유와 재현 절차를 대신 적는다 (로컬 재현만 가능하다) */
export const FIX_ORDER = `${FIX_HEAD}\n## 오류 로그 없음\n\n- 사유: 화면 증상만 신고됨\n- 재현 절차:\n  1. 항목 두 개를 담고 총액을 본다\n`;
export const LOG_LINE = "java.lang.IllegalStateException: total mismatch: expected 5 but was 0";
/** 운영 오류 로그가 붙은 신고 */
export const FIX_ORDER_LOG = `${FIX_HEAD}\n## 오류 로그\n\n\`\`\`text\n2026-10-06 10:11:12 ERROR OrderController - 주문 총액 계산 오류\n${LOG_LINE}\n    at app.order.total(order.js:3)\n\`\`\`\n`;
/** 로그 문구를 백틱으로 인용하고 원인 코드 path:line 을 백틱 밖에 둔 ② 기존 시스템 분석 */
export const CURRENT_LOG = `- \`${LOG_LINE}\` → ${SRC}:3 — total 이 항목을 더하지 않고 0 을 돌려준다`;

export const FIX_REQ = [
  "# FIX-1 요구사항 정의",
  "## R1 · 총액이 항목 합계로 나와야 한다", "근거: \"총액이 0 으로 나온다.\"", "- 기존 코드: 고친다",
  "## 가정", "- 없음",
].join("\n");

/** ② 의 `기존 시스템 분석` 만 갈아 끼운다 — fix·refactor 의 새 규칙이 거기 걸린다 */
export function analysisDoc(current: string): string {
  return [
    "# 영향도 분석",
    "## 기존 시스템 분석", current,
    "## 영향 범위", "| R 번호 | 닿는 파일/모듈 | 부르는 곳 | 파급 |", "|---|---|---|---|",
    `| R1 | ${SRC} | 없음 | 없음 — 한 함수 |`,
    "## Risk", "- 없음 — 한 함수다",
    "## 문서 영향", "| 문서 | 키 | 판단 | 근거 |", "|---|---|---|---|", "| - | - | 영향 없음 | 지식 항목이 없다 |",
  ].join("\n");
}

export const CURRENT_OK = `- ${SRC}:3 의 total 이 항목을 더하지 않고 0 을 돌려준다`;
export const CURRENT_NA = "- 해당 없음 — 새로 만드는 코드다";
export const CURRENT_NO_REF = "- total 이 항목을 더하지 않는다";

export const FIX_DESIGN = [
  "# 기술 설계", "## 구성 요소", "- order.total", "## 처리 흐름", "- 항목을 더해 돌려준다",
  "## API", "해당 없음 — 접점을 안 건드린다", "## 데이터", "해당 없음 — 저장 구조를 안 건드린다",
  "## 설계 결정", "- reduce 로 더한다",
].join("\n");

export const FIX_FUNC = [
  "# 기능 명세", "## 기능 정의", "- R1: 총액을 돌려준다", "## 업무 규칙", "- 없음 — 규칙 변경 없음",
  "## 예외", "- 없음 — 항목이 없으면 0 이다",
  "## 수락 기준", "- AC-R1-1: 항목 두 개를 담으면 합계가 나온다",
].join("\n");

/** ⑦ — `## 재현` 절의 내용만 갈아 끼운다 */
export function specDoc(repro: string | null = "- TC-1"): string {
  return [
    "# 테스트 명세", "## 테스트 케이스",
    "| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |", "|---|---|---|---|---|",
    "| TC-1 | Unit | AC-R1-1 | 항목 두 개를 담고 총액을 읽는다 | 합계가 나온다 |",
    ...(repro === null ? [] : ["## 재현", repro]),
  ].join("\n");
}

export const FIX_PLAN = {
  files: [
    { stage: "test", path: REPRO_TEST, purpose: "재현 테스트", requirements: ["R1"] },
    { stage: "code", path: SRC, purpose: "총액을 고친다", requirements: ["R1"] },
  ],
  preserve: [{ item: "주문 조회 API 시그니처", how: "함수 이름과 인자를 그대로 둔다" }],
  sequence: [{ step: "test", why: "재현이 먼저다" }, { step: "code", why: "재현을 본 뒤 고친다" }],
  approach: "재현 테스트를 먼저 쓰고 total 을 고친다",
  conventions: [], conflicts: [], openQuestions: [], reasoning: "재현 먼저",
};
