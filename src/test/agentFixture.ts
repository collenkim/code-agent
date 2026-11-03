import { writeFixture as writeRepoFile, repoTools } from "./repoFixture";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { recordDecision } from "../core/approval";
import { next, submitPlan } from "../agent/commands";
import { start } from "./confirmedStart";

import { checkProjectDocs, recordDocConfirmation } from "../agent/docs";
import { approvalDocsHash, loadManifestIfAny, loadWork } from "../agent/work";

const APP = "src/main/java/com/acme/app/application";
const ORDER = `${APP}/order`;

const MANIFEST = {
  language: "java",
  sourceExtensions: [".java"],
  domainBase: "src/main/java/com/acme/app",
  domainRoots: ["application"],
  conventions: ["doc/conventions.md"],
  docs: { architecture: "doc/architecture.md" },
  referenceDomain: "deal",
  build: ["gradlew", "compileJava", "-q"],
  test: ["gradlew", "test"],
  stages: [
    { key: "entity", title: "Entity", template: "01-entity.md", kinds: ["feature"], exemplars: ["domain/{Ref}.java"], outputDirs: ["domain"] },
    { key: "repository", title: "Repository", template: "02-repository.md", kinds: ["feature"], exemplars: ["repository/"], outputDirs: ["repository"] },
  ],
};

const PLAN = {
  domainName: "Order",
  domainLabel: "주문",
  domainRoot: "application",
  domainDirName: "order",
  files: [
    { stage: "entity", path: `${ORDER}/domain/Order.java`, purpose: "주문 엔티티", requirements: ["R1"] },
    { stage: "repository", path: `${ORDER}/repository/OrderRepository.java`, purpose: "저장소", requirements: ["R1", "R2"] },
  ],
  sequence: [{ step: "entity", why: "저장소가 엔티티에 기댄다" }, { step: "repository", why: "엔티티 뒤" }],
  approach: "참조 도메인 deal 의 구조를 그대로 따라 새로 만든다",
  conventions: [],
  conflicts: [],
  openQuestions: [],
  reasoning: "테스트",
};

const ARCH = [
  "# 아키텍처",
  "## 기술 스택", "Java 21, Spring Boot 3",
  "## 모듈/패키지 구조", "com.acme.app.<분류>.<도메인>.<계층>",
  "## 계층과 책임", "- domain: 엔티티", "- repository: 저장소",
  "## 의존 방향", "repository → domain",
  "## 공통 모듈", "없음",
  "## 주요 결정", "- 식별자: Long auto increment",
].join("\n");

const CONV = [
  "# 코드 컨벤션",
  "## 명명", "- 저장소는 <Entity>Repository",
  "## 계층별 규칙", "- 엔티티 필드는 private",
  "## 예외 처리", "- 공통 BusinessException",
  "## 테스트 규칙", "- 테스트 클래스는 <Entity>Test",
].join("\n");

const TEST_STRATEGY_DOC = [
  "# 테스트 전략",
  "## 수준과 범위", "- Unit: 필수",
  "## 도구와 실행 명령", "- `test`: 전체 테스트",
  "## 통과 기준", "- 수락 기준마다 1케이스",
].join("\n");

const QUALITY_DOC = [
  "# 품질·보안 기준",
  "## 정적 분석", "- `build`: 컴파일 경고",
  "## 보안 검사", "- 없음 — 리뷰에서 본다",
  "## 통과 기준과 반영 차단", "- 컴파일 실패는 반영을 막는다",
].join("\n");

let repo: string;

/** 사람의 문서 확정을 흉내 낸다 — 원장에 쓰는 것은 실제 함수 그대로다 */
function confirmDocs(): void {
  for (const check of checkProjectDocs(repo, loadManifestIfAny(repo))) {
    recordDocConfirmation(repo, check, "test", { channel: "tty", verified: true, detail: "테스트" });
  }
}

function write(path: string, content: string): void {
  writeRepoFile(repo, path, content);
}

const { git, hook } = repoTools(() => repo);

function writeFile(path: string): string | undefined {
  return hook("Write", { file_path: join(repo, path) });
}

function bash(command: string): string | undefined {
  return hook("Bash", { command });
}

/** 사람의 터미널 승인을 흉내 낸다 — 원장에 쓰는 것은 코어 함수 그대로다 */
function approve(): void {
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

function submit(plan: unknown = PLAN): string {
  write("doc/work/ORD-1/plan.json", JSON.stringify(plan));
  return submitPlan(repo, join(repo, "doc/work/ORD-1/plan.json"));
}

// ---- 작업 폴더의 번호 문서 (①②③④⑦) ----

const REQUIREMENTS = [
  "# ORD-1 요구사항 정의",
  "## R1 · 주문 등록", "근거: \"주문은 id, 주문번호, 금액을 가진다.\"", "- 데이터: 만든다",
  "## R2 · 주문 조회", "근거: \"주문을 조회한다.\"", "- 데이터: 안 건드린다",
  "## 가정", "- 없음",
].join("\n");

const IMPACT = [
  "# 영향도 분석",
  "## 기존 시스템 분석", "- 주문 도메인은 아직 없다 (참조: deal)",
  "## 영향 범위",
  "| R 번호 | 닿는 파일/모듈 | 부르는 곳 | 파급 |",
  "|---|---|---|---|",
  "| R1 | 새 파일 | 없음 | 없음 — 새 도메인 |",
  "| R2 | 새 파일 | 없음 | 없음 — 새 도메인 |",
  "## Risk", "- 없음 — 기존 경로를 건드리지 않는다",
  "## 문서 영향", "| 문서 | 키 | 판단 | 근거 |", "|---|---|---|---|", "| - | - | 영향 없음 | 지식 항목이 없다 |",
].join("\n");

const DESIGN = [
  "# 기술 설계",
  "## 구성 요소", "- Order 엔티티 · OrderRepository",
  "## 처리 흐름", "- 등록 → 저장소 저장",
  "## API", "해당 없음 — 이번 범위는 도메인·저장소까지다",
  "## 데이터", "- Order: id(Long) · orderNo(String) · amount(BigDecimal)",
  "## 설계 결정", "- 식별자는 Long auto increment (아키텍처의 주요 결정)",
].join("\n");

const FUNCTIONAL = [
  "# 기능 명세",
  "## 기능 정의", "- R1: 주문을 등록한다", "- R2: 주문을 조회한다",
  "## 업무 규칙", "- 없음 — 사용자 답에 규칙이 없다",
  "## 예외", "- 없는 주문 조회: ORDER_NOT_FOUND (404)",
  "## 수락 기준", "- AC-R1-1: 주문을 등록하면 id 가 생긴다", "- AC-R2-1: 없는 주문을 조회하면 ORDER_NOT_FOUND 다",
].join("\n");

const TEST_SPEC = [
  "# 테스트 명세",
  "## 테스트 케이스",
  "| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |",
  "|---|---|---|---|---|",
  "| TC-1 | Unit | AC-R1-1 | 주문 저장 | id 가 생긴다 |",
  "| TC-2 | Unit | AC-R2-1 | 없는 주문 조회 | ORDER_NOT_FOUND |",
].join("\n");

/** 번호 문서를 한꺼번에 쓴다 — 스테이지마다 하나씩 쓰는 테스트는 인자로 갈아 끼운다 */
function writeDocs(docs: { requirements?: string; impact?: string; design?: string; functional?: string; testSpec?: string } = {}): void {
  write("doc/work/ORD-1/01-requirements.md", docs.requirements ?? REQUIREMENTS);
  write("doc/work/ORD-1/02-analysis.md", docs.impact ?? IMPACT);
  write("doc/work/ORD-1/03-design.md", docs.design ?? DESIGN);
  write("doc/work/ORD-1/04-functional.md", docs.functional ?? FUNCTIONAL);
  write("doc/work/ORD-1/07-test-spec.md", docs.testSpec ?? TEST_SPEC);
}

/** start → analysis → impact → design → plan 까지 */
function toPlan(): void {
  start(repo, join(repo, "doc/work/ORD-1.md"));
  writeDocs();
  next(repo);
  next(repo);
  next(repo);
}

/** ① 만 쓰고 영향도 분석 스테이지까지 — 스테이지별 게이트를 따로 보는 테스트용 */
function toImpact(requirements = REQUIREMENTS): void {
  start(repo, join(repo, "doc/work/ORD-1.md"));
  write("doc/work/ORD-1/01-requirements.md", requirements);
  next(repo);
}

/** ①② 를 쓰고 설계 스테이지까지 */
function toDesign(impact = IMPACT): void {
  toImpact();
  write("doc/work/ORD-1/02-analysis.md", impact);
  next(repo);
}

function toImplement(): void {
  toPlan();
  submit();
  approve();
  next(repo);
}

beforeEach(() => {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-agent-")));
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
  write("code-agent.json", JSON.stringify(MANIFEST));
  write("doc/architecture.md", ARCH);
  write("doc/conventions.md", CONV);
  write("doc/test-strategy.md", TEST_STRATEGY_DOC);
  write("doc/quality.md", QUALITY_DOC);
  confirmDocs();
  write(`${APP}/deal/domain/Deal.java`, "public class Deal {}\n");
  write(`${APP}/deal/repository/DealRepository.java`, "public interface DealRepository {}\n");
  write("doc/work/ORD-1.md", "---\nkind: feature\nid: ORD-1\ntitle: 주문 도메인 추가\ntarget: order\n---\n\n주문은 id, 주문번호, 금액을 가진다. 주문을 조회한다.\n");
  git("add", "-A");
  git("commit", "-qm", "init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

export { APP, ORDER, MANIFEST, PLAN, ARCH, CONV, TEST_STRATEGY_DOC, QUALITY_DOC, repo, confirmDocs, write, writeFile, bash, approve, submit, REQUIREMENTS, IMPACT, DESIGN, FUNCTIONAL, TEST_SPEC, writeDocs, toPlan, toImpact, toDesign, toImplement, git, hook };
