import { createRepo, removeRepo, repoTools, PASS } from "./repoFixture";
export { PASS, NOT_INSTALLED } from "./repoFixture";
/**
 * 스테이지 흐름 픽스처 — 임시 git 저장소(주문 도메인 ORD-1, 단계 entity·repository·test)와 스테이지마다 세우는 헬퍼.
 * 검증·리뷰·통합·반영·스테이지 명령 시험(verification-flow·verification-stages·review-gate·integrate-deliver·stage-commands, 옛 p5)과 stageFlow.test 가 함께 쓴다. `repo` 는 createStageRepo 가 정하는 지금 테스트의 저장소다.
 */
import { strict as assert } from "node:assert";

import { readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { recordDecision } from "../core/approval";
import { next, requireValidatable, submitPlan } from "../agent/commands";
import { start } from "./confirmedStart";
import { prDocFile } from "../agent/deliver";

import { loadActive } from "../agent/layout";
import { openRound, reviewDocFile } from "../agent/review";
import { recordReviewFixture } from "./reviewFixture";
import { check, integrate, runTests } from "../agent/validate";

import { approvalDocsHash, loadWork } from "../agent/work";

export const APP = "src/main/java/com/acme/app/application";
export const ORDER = `${APP}/order`;
export const TEST_FILE = "src/test/java/com/acme/app/application/order/OrderTest.java";

/** 통과하는 명령 · 실패하는 명령 · 아예 없는 실행 파일 */
export const FAIL = ["node", "-e", "process.exit(3)"];
/** ⑦ 의 TC id 를 출력에 그대로 낸다 — 코드가 출력에서 읽는 갈래 */
export const PRINT_CASES = ["node", "-e", "console.log('ok 1 - TC-1'); console.log('ok 2 - TC-2')"];
/** Order.java 에 `fixed` 가 들어가기 전에는 실패한다 — 수정 루프를 실제로 한 바퀴 돌리는 갈래 */
export const FAIL_UNTIL_FIXED = [
  "node",
  "-e",
  `const ok=require('fs').readFileSync('${ORDER}/domain/Order.java','utf-8').includes('fixed'); console.log((ok?'ok':'not ok')+' 1 - TC-1'); console.log('ok 2 - TC-2'); process.exit(ok ? 0 : 3)`,
];
/** 증거 파일을 읽어 회차를 찍는다 — 회차가 실행 **전에** 올라갔는지 보는 갈래 */
export const PRINT_ROUNDS = [
  "node",
  "-e",
  "console.log('rounds=' + JSON.parse(require('fs').readFileSync('.code-agent/work/ORD-1/order.verify.json','utf-8')).rounds)",
];

export function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    language: "java",
    sourceExtensions: [".java"],
    domainBase: "src/main/java/com/acme/app",
    domainRoots: ["application"],
    conventions: ["doc/conventions.md"],
    docs: { architecture: "doc/architecture.md" },
    referenceDomain: "deal",
    build: PASS,
    test: PRINT_CASES,
    stages: [
      { key: "entity", title: "Entity", template: "01-entity.md", kinds: ["feature"], outputDirs: ["domain"] },
      { key: "repository", title: "Repository", template: "02-repository.md", kinds: ["feature"], outputDirs: ["repository"] },
      { key: "test", title: "테스트", template: "03-test.md", kind: "test", kinds: ["feature"], scope: "project", outputDirs: ["src/test"] },
    ],
    ...overrides,
  });
}

export const PLAN = {
  domainName: "Order",
  domainLabel: "주문",
  domainRoot: "application",
  domainDirName: "order",
  files: [
    { stage: "entity", path: `${ORDER}/domain/Order.java`, purpose: "주문 엔티티", requirements: ["R1"] },
    { stage: "repository", path: `${ORDER}/repository/OrderRepository.java`, purpose: "저장소", requirements: ["R2"] },
    { stage: "test", path: TEST_FILE, purpose: "테스트", requirements: ["R1", "R2"] },
  ],
  sequence: [{ step: "entity", why: "먼저" }, { step: "repository", why: "다음" }, { step: "test", why: "마지막" }],
  approach: "참조 도메인 deal 의 구조를 그대로 따른다",
  conventions: [],
  conflicts: [],
  openQuestions: [],
  reasoning: "테스트",
};

export const ARCH = [
  "# 아키텍처",
  "## 기술 스택", "Java 21",
  "## 모듈/패키지 구조", "com.acme.app.<분류>.<도메인>.<계층>",
  "## 계층과 책임", "- domain: 엔티티",
  "## 의존 방향", "repository → domain",
  "## 공통 모듈", "없음",
  "## 주요 결정", "- 식별자: Long",
].join("\n");

export const CONV = [
  "# 코드 컨벤션",
  "## 명명", "- 저장소는 <Entity>Repository",
  "## 계층별 규칙", "- 엔티티 필드는 private",
  "## 예외 처리", "- 공통 BusinessException",
  "## 테스트 규칙", "- 테스트 이름·주석에 TC id 를 남긴다",
].join("\n");

export const STRATEGY = ["# 테스트 전략", "## 수준과 범위", "- Unit: 필수", "## 도구와 실행 명령", "- `test`: 전체 테스트", "## 통과 기준", "- AC 마다 1케이스"].join("\n");
export const QUALITY = ["# 품질·보안 기준", "## 정적 분석", "- `build`: 컴파일", "## 보안 검사", "- 없음 — 리뷰에서 본다", "## 통과 기준과 반영 차단", "- 컴파일 실패는 반영을 막는다"].join("\n");

export const REQUIREMENTS = [
  "# ORD-1 요구사항 정의",
  "## R1 · 주문 등록", "근거: \"주문은 id 를 가진다.\"", "- 데이터: 만든다",
  "## R2 · 주문 조회", "근거: \"주문을 조회한다.\"", "- 데이터: 안 건드린다",
  "## 가정", "- 없음",
].join("\n");

export const IMPACT = [
  "# 영향도 분석", "## 기존 시스템 분석", "- 주문 도메인은 아직 없다",
  "## 영향 범위", "| R 번호 | 닿는 파일/모듈 | 부르는 곳 | 파급 |", "|---|---|---|---|",
  "| R1 | 새 파일 | 없음 | 없음 — 새 도메인 |", "| R2 | 새 파일 | 없음 | 없음 — 새 도메인 |",
  "## Risk", "- 없음",
  "## 문서 영향", "| 문서 | 키 | 판단 | 근거 |", "|---|---|---|---|", "| - | - | 영향 없음 | 지식 항목이 없다 |",
].join("\n");

export const DESIGN = [
  "# 기술 설계", "## 구성 요소", "- Order · OrderRepository", "## 처리 흐름", "- 등록 → 저장",
  "## API", "해당 없음 — 도메인까지다", "## 데이터", "- Order: id(Long)", "## 설계 결정", "- 식별자는 Long",
].join("\n");

export const FUNCTIONAL = [
  "# 기능 명세", "## 기능 정의", "- R1: 등록", "- R2: 조회", "## 업무 규칙", "- 없음", "## 예외", "- 없는 주문: ORDER_NOT_FOUND",
  "## 수락 기준", "- AC-R1-1: 등록하면 id 가 생긴다", "- AC-R2-1: 없는 주문은 ORDER_NOT_FOUND 다",
].join("\n");

export const TEST_SPEC = [
  "# 테스트 명세", "## 테스트 케이스",
  "| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |", "|---|---|---|---|---|",
  "| TC-1 | Unit | AC-R1-1 | 주문 저장 | id 가 생긴다 |",
  "| TC-2 | Unit | AC-R2-1 | 없는 주문 조회 | ORDER_NOT_FOUND |",
].join("\n");

export let repo: string;

export const { write, git, hook, writeFileHook, confirmDocs } = repoTools(() => repo);

export function approve(): void {
  const work = loadWork(repo)!;
  // 헬퍼가 프로덕션보다 약해지지 않았는지 그 자리에서 본다 — 확정된 문서가 없으면
  // docsHash 가 undefined 가 되고 stale-docs 판정이 다시 꺼진다.
  assert.ok(approvalDocsHash(work), "승인은 확정된 문서 묶음 위에 서야 한다");
  recordDecision(repo, {
    order: work.order,
    target: work.active.target,
    plan: work.plan!,
    manifest: work.manifest,
    // 실제 `decide()` 가 늘 넣는 값이다. 빼면 `checkApproval` 의 `record.docsHash !== undefined` 가
    // 거짓이 되어 **stale-docs 판정이 영영 걸리지 않는다** — 승인 뒤 문서를 고치는 경로가
    // 여기서만 열려 있게 된다. 테스트의 승인은 프로덕션보다 약하면 안 된다.
    docsHash: approvalDocsHash(work),
    decision: "approved",
    approver: "test",
    presence: { channel: "tty", verified: true, detail: "테스트" },
  });
}

/**
 * 검증 선언을 바꾼다. **작업을 시작하기 전에** 부른다 — 시작한 뒤에 바꾸면 승인이 stale-manifest 가
 * 되고 code-agent.json 자체가 계획 밖 변경으로 잡힌다(그 둘도 아래에서 따로 검증한다).
 */
export function useManifest(overrides: Record<string, unknown> = {}, quality?: string): void {
  write("code-agent.json", manifest(overrides));
  if (quality) write("doc/quality.md", quality);
  confirmDocs();
  git("add", "-A");
  git("commit", "-qm", "manifest");
}

/** 계획 파일까지 만들어 check 스테이지에 세운다 */
export function toCheck(): void {
  start(repo, join(repo, "doc/work/ORD-1.md"));
  write("doc/work/ORD-1/01-requirements.md", REQUIREMENTS);
  write("doc/work/ORD-1/02-analysis.md", IMPACT);
  write("doc/work/ORD-1/03-design.md", DESIGN);
  write("doc/work/ORD-1/04-functional.md", FUNCTIONAL);
  write("doc/work/ORD-1/07-test-spec.md", TEST_SPEC);
  next(repo);
  next(repo);
  next(repo);
  write("doc/work/ORD-1/plan.json", JSON.stringify(PLAN));
  submitPlan(repo, join(repo, "doc/work/ORD-1/plan.json"));
  approve();
  next(repo);
  write(`${ORDER}/domain/Order.java`, "class Order {}\n");
  next(repo);
  write(`${ORDER}/repository/OrderRepository.java`, "interface OrderRepository {}\n");
  next(repo);
  // 테스트 파일은 컨벤션대로 TC id 를 주석에 남긴다 — ⑦ 대조의 두 번째 갈래
  write(TEST_FILE, "// TC-1 · TC-2\nclass OrderTest {}\n");
  next(repo);
  assert.equal(loadActive(repo)!.phase, "check");
}

/** check · test 를 통과시켜 리뷰 스테이지에 세운다 */
export async function toReview(): Promise<void> {
  toCheck();
  await check(requireValidatable(repo, "check"));
  next(repo);
  await runTests(requireValidatable(repo, "test"));
  next(repo);
  assert.equal(loadActive(repo)!.phase, "review");
}

/** 모델이 ⑨ 의 `## 지적` 에 쓰는 것 — 코드 구역 밖이라 그냥 이어 붙인다(기록은 하지 않는다) */
export function writeFindingsDoc(...rows: string[]): void {
  const path = join(repo, reviewDocFile("ORD-1"));
  writeFileSync(path, `${readFileSync(path, "utf-8")}\n${rows.length > 0 ? rows.join("\n") : "- 없음"}\n`);
}

/** 문서에 쓰고 리뷰어 실행으로 기록한다(같은 회차에 이미 유효한 결과가 있으면 기록은 바뀌지 않는다) */
export function writeFindings(...rows: string[]): void {
  writeFindingsDoc(...rows);
  recordReviewFixture(repo);
}

/** 회차가 열리기 전에 모델이 ⑨ 를 통째로 지어 쓰는 것 — 작업 폴더 안이라 hook 은 막지 않는다 */
export function forgeReviewDoc(...rows: string[]): void {
  write(
    reviewDocFile("ORD-1"),
    ["# ORD-1 코드 리뷰", "", "## 지적", "", "| id | 계획 파일 | 범위 | 상태 | 지적 |", "|---|---|---|---|---|", ...rows, ""].join("\n"),
  );
}

/** 리뷰 회차를 열고 지적 없이 닫아 통합 검증까지 세운다 */
export async function toIntegrate(): Promise<void> {
  await toReview();
  openRound(requireValidatable(repo, "review"));
  writeFindings();
  next(repo);
  assert.equal(loadActive(repo)!.phase, "integrate");
}

export async function toDeliver(): Promise<void> {
  await toIntegrate();
  await integrate(requireValidatable(repo, "integrate"));
  next(repo);
  assert.equal(loadActive(repo)!.phase, "deliver");
}

/** 모델이 쓰는 ⑩ 의 세 섹션 */
export function writePr(): void {
  write(
    prDocFile("ORD-1"),
    ["# ORD-1 변경 보고서", "", "## 요약", "주문 도메인을 더했다.", "", "## 확인 방법", "OrderRepository 를 부른다.", "", "## 위험·되돌리기", "없음 — 새 도메인이라 되돌리면 파일만 지운다.", ""].join("\n"),
  );
}

/** 저장소를 만든다 — beforeEach 에서 부른다 */
export function createStageRepo(prefix = "ca-p5-"): void {
  repo = createRepo(prefix);
  write("code-agent.json", manifest());
  write("doc/architecture.md", ARCH);
  write("doc/conventions.md", CONV);
  write("doc/test-strategy.md", STRATEGY);
  write("doc/quality.md", QUALITY);
  confirmDocs();
  write(".gitignore", "build/\n");
  write("doc/work/ORD-1.md", "---\nkind: feature\nid: ORD-1\ntitle: 주문 도메인 추가\ntarget: order\n---\n\n주문은 id 를 가진다. 주문을 조회한다.\n");
  git("add", "-A");
  git("commit", "-qm", "init");
}

/** 저장소를 지운다 — afterEach 에서 부른다 */
export function removeStageRepo(): void {
  removeRepo(repo);
}
