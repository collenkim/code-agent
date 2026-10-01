import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { recordDecision } from "../core/approval";
import { abort, context, next, status, Stop, submitPlan, decide as decideApproval } from "../agent/commands";
import { start } from "./confirmedStart";
import { decide } from "../agent/hook";
import { init } from "../agent/init";
import { loadActive, saveActive } from "../agent/layout";
import type { ActiveWork } from "../agent/layout";
import { parseQuestions } from "../agent/questions";
import { formatAssumptions, parseRequirements } from "../agent/workDocs";
import { AGENTS, modelsTable, setModel } from "../agent/models";
import { docsSkeleton } from "../agent/docsCommands";
import { WORK_SCHEMAS } from "../agent/schemas";
import { checkProjectDocs, checkSections, recordDocConfirmation } from "../agent/docs";
import { approvalDocsHash, approvalOf, loadManifestIfAny, loadWork } from "../agent/work";

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
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf-8" }).trim();
}

function hook(tool: string, input: Record<string, string>): string | undefined {
  return decide({ cwd: repo, tool_name: tool, tool_input: input });
}

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

describe("hook — 진행 중인 작업이 없을 때", () => {
  test("관여하지 않는다", () => {
    assert.equal(writeFile(`${ORDER}/domain/Order.java`), undefined);
    assert.equal(bash("echo x > a.txt"), undefined);
  });
});

describe("hook — 계획 전 스테이지", () => {
  beforeEach(() => start(repo, join(repo, "doc/work/ORD-1.md")));

  test("코드는 쓸 수 없다", () => {
    assert.match(writeFile(`${ORDER}/domain/Order.java`) ?? "", /작업 폴더.* 밖은 쓸 수 없습니다/);
  });

  test("지시서는 작업 폴더 안에 있어도 쓸 수 없다 — 사람의 입력이다", () => {
    write("doc/work/ORD-1/requirement.md", readFileSync(join(repo, "doc/work/ORD-1.md"), "utf-8"));
    abort(repo);
    start(repo, join(repo, "doc/work/ORD-1/requirement.md"));
    assert.match(writeFile("doc/work/ORD-1/requirement.md") ?? "", /작업 지시서\(doc\/work\/ORD-1\/requirement\.md\)는 고칠 수 없습니다/);
    assert.equal(writeFile("doc/work/ORD-1/01-requirements.md"), undefined);
  });

  test("작업 폴더는 쓴다", () => {
    assert.equal(writeFile("doc/work/ORD-1/01-requirements.md"), undefined);
    assert.equal(writeFile("doc/work/ORD-1/07-test-spec.md"), undefined);
    assert.equal(writeFile("doc/work/ORD-1/questions.md"), undefined);
  });

  test("05-plan.md 는 작업 폴더 안에 있어도 쓸 수 없다 — 코드가 계획에서 렌더한다", () => {
    assert.match(writeFile("doc/work/ORD-1/05-plan.md") ?? "", /05-plan\.md 는 코드가 렌더합니다/);
    // 파일이 아직 없으면 canonical 이 실제 이름으로 되돌려 주지 못한다 — 대소문자만 바꾼 이름이 지나가면 안 된다
    assert.match(writeFile("doc/work/ORD-1/05-PLAN.md") ?? "", /05-plan\.md 는 코드가 렌더합니다/);
  });

  test("상태·원장은 어느 스테이지에서도 쓸 수 없다", () => {
    assert.match(writeFile(".code-agent/active.json") ?? "", /도구로 고칠 수 없습니다/);
    assert.match(writeFile(".code-agent/approvals/ORD-1.jsonl") ?? "", /도구로 고칠 수 없습니다/);
  });

  test("Read 는 관여하지 않는다", () => {
    assert.equal(hook("Read", { file_path: join(repo, "code-agent.json") }), undefined);
  });
});

describe("hook — Bash 허용 목록", () => {
  beforeEach(() => start(repo, join(repo, "doc/work/ORD-1.md")));

  test("파일 쓰기 우회는 막는다", () => {
    assert.match(bash("echo x > a.java") ?? "", /Bash 로 code-agent 명령/);
  });

  test("선언된 명령·code-agent·읽기용 git 은 허용한다", () => {
    assert.equal(bash("gradlew test"), undefined);
    assert.equal(bash("gradlew compileJava -q"), undefined);
    assert.equal(bash("code-agent next"), undefined);
    assert.equal(bash("git status"), undefined);
    assert.equal(bash("git diff --stat"), undefined);
  });

  /**
   * abort 한 줄이면 작업 커서가 사라져 hook 이 그 뒤로 아무것도 판정하지 않고,
   * init --cli 한 줄이면 hook 자체가 모델이 만든 스크립트로 갈린다. 둘 다 사람의 명령이다.
   */
  test("사람이 터미널에서 돌리는 code-agent 명령은 모델이 부를 수 없다", () => {
    for (const human of [
      "code-agent abort",
      "code-agent init --cli doc/work/ORD-1/noop.js",
      "code-agent approve",
      "code-agent reject --comment x",
      "code-agent confirm doc architecture",
      "code-agent model all sonnet",
      "echo hello next", // 앞 11글자를 무엇으로 채워도 서브명령 대조를 통과하지 못한다
    ]) {
      assert.match(bash(human) ?? "", /사람이 터미널에서 실행합니다/, human);
    }
    for (const skill of [
      "code-agent start doc/work/ORD-1.md",
      "code-agent next",
      "code-agent context",
      "code-agent status",
      "code-agent plan submit doc/work/ORD-1/plan.json",
      "code-agent docs",
      "code-agent docs begin",
      "code-agent docs skeleton 01-requirements",
      "code-agent survey",
      "code-agent manifest check",
    ]) {
      assert.equal(bash(skill), undefined, skill);
    }
  });

  test("읽기용 git 도 파일로 내보내는 것은 막는다 — --output 은 판정을 거치지 않는 쓰기다", () => {
    assert.ok(bash("git diff --output=pwned.txt"));
    assert.ok(bash("git show HEAD:code-agent.json --output=.claude/settings.json"));
    assert.ok(bash("git log -o out.txt"));
    assert.equal(bash("git log --oneline"), undefined, "이름만 비슷한 읽기 옵션은 그대로 통과한다");
  });

  test("허용된 명령 뒤에 연결해 붙이는 것은 막는다", () => {
    assert.ok(bash("git status; rm -rf src"));
    assert.ok(bash("gradlew test && echo x > a"));
    assert.ok(bash("code-agent status | tee x"));
    assert.ok(bash("git log $(rm -rf src)"));
  });

  test("브랜치를 바꾸는 git 은 막는다", () => {
    assert.ok(bash("git switch master"));
    assert.ok(bash("git checkout -b other"));
    assert.ok(bash("git commit -m x"));
  });

  test("git branch 는 목록 보기만 — 지우기·이름 바꾸기·만들기는 막는다", () => {
    for (const read of ["git branch", "git branch --show-current", "git branch -a", "git branch --list -v"]) {
      assert.equal(bash(read), undefined, read);
    }
    for (const write of ["git branch -D feature/ORD-1", "git branch -m other", "git branch other", "git branch -f master HEAD~1"]) {
      assert.ok(bash(write), write);
    }
  });
});

describe("hook — 구현", () => {
  test("승인 전에는 코드를 쓸 수 없다", () => {
    toPlan();
    submit();
    // 승인 없이 스테이지만 옮겨 놓은 상태 — next 는 이렇게 두지 않지만 hook 은 스스로 확인해야 한다
    saveActive(repo, { ...loadActive(repo)!, phase: "implement", stage: "entity" });
    assert.match(writeFile(`${ORDER}/domain/Order.java`) ?? "", /승인되지 않았습니다 \(none\)/);
  });

  test("승인 뒤 지금 단계의 계획 파일은 쓴다", () => {
    toImplement();
    assert.equal(loadActive(repo)!.stage, "entity");
    assert.equal(writeFile(`${ORDER}/domain/Order.java`), undefined);
    assert.equal(hook("Edit", { file_path: join(repo, `${ORDER}/domain/Order.java`) }), undefined);
    assert.equal(hook("Write", { file_path: `${ORDER}/domain/Order.java` }), undefined, "상대 경로");
  });

  test("다음 단계 파일·계획에 없는 파일·참조 도메인은 막는다", () => {
    toImplement();
    assert.match(writeFile(`${ORDER}/repository/OrderRepository.java`) ?? "", /do-not-touch 경계/);
    assert.match(writeFile(`${ORDER}/domain/OrderStatus.java`) ?? "", /계획 준수/);
    assert.match(writeFile(`${APP}/deal/domain/Deal.java`) ?? "", /도메인 디렉토리.*밖의 파일/);
  });

  test("저장소 밖은 막는다", () => {
    toImplement();
    assert.match(hook("Write", { file_path: join(tmpdir(), "x.java") }) ?? "", /저장소 밖/);
    assert.match(hook("Write", { file_path: "../x.java" }) ?? "", /저장소 밖/);
  });

  test("계획이 바뀌면 승인이 무효가 된다", () => {
    toImplement();
    saveActive(repo, { ...loadActive(repo)!, phase: "plan", stage: undefined });
    submit({ ...PLAN, reasoning: "바꿈" });
    saveActive(repo, { ...loadActive(repo)!, phase: "implement", stage: "entity" });
    assert.match(writeFile(`${ORDER}/domain/Order.java`) ?? "", /stale-plan/);
  });

  test("검증 스테이지에서는 계획의 어느 단계 파일이든 고친다 — 계획 밖은 막는다", () => {
    toImplement();
    saveActive(repo, { ...loadActive(repo)!, phase: "check", stage: undefined });
    assert.equal(writeFile(`${ORDER}/repository/OrderRepository.java`), undefined);
    assert.match(writeFile(`${ORDER}/domain/OrderStatus.java`) ?? "", /계획에 없는 파일/);
  });
});

describe("start — 문서 게이트와 작업 브랜치", () => {
  test("아키텍처 문서가 없으면 시작하지 않는다", () => {
    rmSync(join(repo, "doc/architecture.md"));
    assert.throws(() => start(repo, join(repo, "doc/work/ORD-1.md")), (error: Error) =>
      error instanceof Stop && /아키텍처: 파일이 없습니다/.test(error.message));
  });

  test("등록한 아키텍처 경로에 파일이 없으면 시작하지 않는다", () => {
    write("code-agent.json", JSON.stringify({ ...MANIFEST, docs: { architecture: "doc/arch/overview.md" } }));
    assert.throws(() => start(repo, join(repo, "doc/work/ORD-1.md")), /아키텍처: 파일이 없습니다: doc\/arch\/overview\.md/);
  });

  test("컨벤션 문서가 없으면 시작하지 않는다", () => {
    rmSync(join(repo, "doc/conventions.md"));
    assert.throws(() => start(repo, join(repo, "doc/work/ORD-1.md")), /코드 컨벤션: 파일이 없습니다/);
  });

  test("확정되지 않은 문서로는 시작하지 않는다", () => {
    rmSync(join(repo, ".code-agent/approvals/docs.jsonl"));
    assert.throws(() => start(repo, join(repo, "doc/work/ORD-1.md")), /사람의 확정이 없습니다/);
  });

  test("확정 뒤 바뀐 문서로는 시작하지 않는다", () => {
    write("doc/architecture.md", `${ARCH}\n## 추가\n내용\n`);
    assert.throws(() => start(repo, join(repo, "doc/work/ORD-1.md")), /확정 뒤 내용이 바뀌었습니다/);
  });

  test("기준 브랜치(기본 master)에서 <종류>/<ID> 를 딴다", () => {
    const out = start(repo, join(repo, "doc/work/ORD-1.md"));
    assert.match(out, /feature\/ORD-1 를 master 에서 만들었습니다/);
    assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "feature/ORD-1");
    assert.deepEqual(
      { branch: loadActive(repo)!.branch, base: loadActive(repo)!.base },
      { branch: "feature/ORD-1", base: "master" },
    );
  });

  test("사용자가 준 기준 브랜치가 매니페스트보다 앞선다", () => {
    git("branch", "develop");
    write("code-agent.json", JSON.stringify({ ...MANIFEST, git: { base: "release" } }));
    start(repo, join(repo, "doc/work/ORD-1.md"), { base: "develop" });
    assert.equal(loadActive(repo)!.base, "develop");
  });

  test("매니페스트의 기준 브랜치를 쓴다", () => {
    git("branch", "develop");
    write("code-agent.json", JSON.stringify({ ...MANIFEST, git: { base: "develop" } }));
    start(repo, join(repo, "doc/work/ORD-1.md"));
    assert.equal(loadActive(repo)!.base, "develop");
  });

  test("없는 기준 브랜치면 멈춘다", () => {
    assert.throws(() => start(repo, join(repo, "doc/work/ORD-1.md"), { base: "nope" }), /기준 브랜치가 없습니다: nope/);
    assert.equal(loadActive(repo), undefined);
  });

  test("이미 있는 작업 브랜치로는 전환만 한다", () => {
    git("branch", "feature/ORD-1");
    assert.match(start(repo, join(repo, "doc/work/ORD-1.md")), /이미 있는 작업 브랜치 feature\/ORD-1 로 전환/);
  });

  test("지시서에 없는 대상은 거부한다", () => {
    // 사람이 읽은 계획과 판정한 계획이 달라질 수 있다 — 대상은 지시서가 정한 것뿐이다.
    assert.throws(
      () => start(repo, join(repo, "doc/work/ORD-1.md"), { target: "없는대상" }),
      /지시서의 대상이 아닙니다: 없는대상/,
    );
    assert.equal(loadActive(repo), undefined);
  });

  test("다른 작업이 진행 중이면 시작하지 않는다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    write("doc/work/ORD-2.md", "---\nkind: feature\nid: ORD-2\ntitle: 다른 것\ntarget: order\n---\n");
    assert.throws(() => start(repo, join(repo, "doc/work/ORD-2.md")), /진행 중인 작업이 있습니다: ORD-1/);
  });
});

describe("next — 질문과 승인", () => {
  test("답이 없는 질문이 있으면 넘어가지 않는다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    const questions = join(repo, "doc/work/ORD-1/questions.md");
    writeDocs();
    writeFileSync(questions, `${readFileSync(questions, "utf-8")}\n## Q1 · 요구사항 분석\n금액 타입은?\nA. Long\nB. BigDecimal\n[Answer]:\n`);
    assert.throws(() => next(repo), /답이 없는 질문이 1개/);
    writeFileSync(questions, readFileSync(questions, "utf-8").replace(/\[Answer\]:\n$/, "[Answer]: B\n"));
    next(repo);
    assert.equal(loadActive(repo)!.phase, "impact");
  });

  test("계획이 승인되지 않으면 구현으로 넘어가지 않는다", () => {
    toPlan();
    assert.throws(() => next(repo), /제출된 계획이 없습니다/);
    submit();
    assert.throws(() => next(repo), /승인되지 않았습니다 \(none\)/);
    approve();
    next(repo);
    assert.deepEqual([loadActive(repo)!.phase, loadActive(repo)!.stage], ["implement", "entity"]);
  });

  test("단계의 계획 파일이 모두 있어야 다음 단계로, 마지막 뒤에는 check 로", () => {
    toImplement();
    assert.throws(() => next(repo), /단계 entity 의 계획 파일이 아직 없습니다/);
    write(`${ORDER}/domain/Order.java`, "class Order {}\n");
    next(repo);
    assert.equal(loadActive(repo)!.stage, "repository");
    write(`${ORDER}/repository/OrderRepository.java`, "interface OrderRepository {}\n");
    next(repo);
    assert.equal(loadActive(repo)!.phase, "check");
  });

  test("계획에 파일이 없는 단계는 구현에서 건너뛴다 — 빈손으로 서브에이전트를 보내지 않는다", () => {
    toPlan();
    submit({ ...PLAN, files: [{ ...PLAN.files[1], requirements: ["R1", "R2"] }], sequence: [PLAN.sequence[1]] });
    approve();
    next(repo);
    assert.deepEqual([loadActive(repo)!.phase, loadActive(repo)!.stage], ["implement", "repository"]);
    assert.match(status(repo), /단계: \[repository\]$/m);
  });

  test("status 는 어디서 무엇을 기다리는지 보여 준다", () => {
    toPlan();
    submit();
    assert.match(status(repo), /계획: 제출됨 · 승인 none/);
    assert.match(status(repo), /별도 터미널에서 code-agent approve/);
  });
});

describe("plan submit — 제출 전 검사", () => {
  beforeEach(toPlan);

  test("단계 위치 밖의 파일은 계획에 넣을 수 없다", () => {
    const plan = { ...PLAN, files: [{ stage: "entity", path: `${ORDER}/repository/X.java`, purpose: "x" }] };
    assert.throws(() => submit(plan), /do-not-touch 경계/);
  });

  test("모르는 단계는 거부한다", () => {
    assert.throws(() => submit({ ...PLAN, files: [{ stage: "nope", path: `${ORDER}/domain/A.java`, purpose: "x" }] }), /알 수 없는 단계 nope/);
  });

  test("남은 질문이 있으면 제출되지 않는다 — questions.md 로 보낸다", () => {
    assert.throws(() => submit({ ...PLAN, openQuestions: ["금액 타입?"] }), /남은 질문이 있습니다/);
  });

  test("형식이 틀리면 어디가 틀렸는지 알린다", () => {
    assert.throws(() => submit({ ...PLAN, files: "x" }), /계획 형식이 맞지 않습니다[\s\S]*files/);
  });

  test("plan 스테이지가 아니면 받지 않는다", () => {
    saveActive(repo, { ...loadActive(repo)!, phase: "analysis" });
    assert.throws(() => submit(), /plan 스테이지에서 제출합니다/);
  });

  /**
   * 보존 조건이 빠진 계획이 승인 화면에 올라가는 것이 고치는 작업에서 가장 위험한 실패다.
   * 문장을 그대로 옮기게 해 두면 대조를 코드가 하고, 걸린 계획은 제출 자체가 막힌다.
   */
  test("kind: refactor — 보존 조건이 빠진 계획은 제출되지 않는다", () => {
    const DEAL = `${APP}/deal`;
    abort(repo);
    // 고치는 작업은 Entity~Controller 를 순차 생성하지 않는다 — 경계는 지시서가 정한다.
    write("code-agent.json", JSON.stringify({
      ...MANIFEST,
      stages: [...MANIFEST.stages, {
        key: "restructure", title: "구조 정리", template: "90-restructure.md",
        kinds: ["refactor"], scope: "project", exemplars: [], outputDirs: [],
      }],
    }));
    write("doc/work/REF-1.md", [
      "---", "kind: refactor", "id: REF-1", "title: 거래 경계 정리",
      `target: ${DEAL}`, `scope: [${DEAL}]`,
      `preserve: [${DEAL}/repository/DealRepository.java, DealFacade 공개 시그니처]`,
      "---", "", "경계만 옮긴다.", "",
    ].join("\n"));
    start(repo, join(repo, "doc/work/REF-1.md"));
    write("doc/work/REF-1/01-requirements.md",
      ["## R1 · 경계 정리", "근거: \"경계만 옮긴다.\"", "- 데이터: 안 건드린다", "## 가정", "- 없음", ""].join("\n"));
    write("doc/work/REF-1/02-analysis.md", [
      // refactor 의 ② 는 '지금 동작' 을 근거 path:line 과 함께 적어야 지난다 (P6)
      "## 기존 시스템 분석", `- DealFacade 가 트랜잭션을 연다 — ${DEAL}/facade/DealFacade.java:42`,
      "## 영향 범위", "| R 번호 | 닿는 파일 | 부르는 곳 | 파급 |", "|---|---|---|---|", "| R1 | Deal.java | DealFacade | 없음 |",
      "## Risk", "- 없음 — 시그니처를 바꾸지 않는다", "",
    ].join("\n"));
    write("doc/work/REF-1/03-design.md", [
      "## 구성 요소", "- Deal", "## 처리 흐름", "- 그대로", "## API", "해당 없음 — 접점을 안 건드린다",
      "## 데이터", "해당 없음 — 스키마를 안 건드린다", "## 설계 결정", "- 경계만 옮긴다", "",
    ].join("\n"));
    write("doc/work/REF-1/04-functional.md", [
      "## 기능 정의", "- R1: 동작은 그대로", "## 업무 규칙", "- 없음 — 규칙 변경 없음",
      "## 예외", "- 없음 — 기존 예외 그대로", "## 수락 기준", "- AC-R1-1: 기존 테스트가 그대로 통과한다", "",
    ].join("\n"));
    write("doc/work/REF-1/07-test-spec.md", [
      "## 테스트 케이스", "| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |", "|---|---|---|---|---|",
      "| TC-1 | Unit | AC-R1-1 | 기존 테스트 | 통과 |", "",
    ].join("\n"));
    next(repo);
    next(repo);
    next(repo);

    const base = {
      files: [{ stage: "restructure", path: `${DEAL}/domain/Deal.java`, purpose: "경계를 옮긴다", requirements: ["R1"] }],
      sequence: [{ step: "restructure", why: "옮길 곳이 하나다" }],
      approach: "트랜잭션 경계만 서비스로 옮긴다",
      conventions: [], conflicts: [], openQuestions: [], reasoning: "경계만 옮긴다",
    };
    const submitRef = (plan: unknown) => {
      write("doc/work/REF-1/plan.json", JSON.stringify(plan));
      return submitPlan(repo, join(repo, "doc/work/REF-1/plan.json"));
    };

    // 문장 하나를 흘린 계획 — 요약·의역도 누락으로 본다.
    assert.throws(
      () => submitRef({ ...base, preserve: [{ item: "DealFacade 공개 시그니처", how: "그대로 둔다" }] }),
      /preserve 가 계획에 없습니다: .*DealRepository\.java/,
    );
    // 다 든 계획은 제출된다.
    submitRef({ ...base, preserve: [
      { item: `${DEAL}/repository/DealRepository.java`, how: "열지 않는다" },
      { item: "DealFacade 공개 시그니처", how: "그대로 둔다" },
    ] });
  });
});

describe("① 01-requirements.md — 요구 항목", () => {
  test("요구사항 정의가 없으면 영향도 분석으로 넘어가지 않는다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    assert.throws(() => next(repo), /요구사항 분석 결과가 없습니다: doc\/work\/ORD-1\/01-requirements\.md/);
  });

  test("요구 항목·근거·가정이 없으면 무엇이 틀렸는지 알린다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    write("doc/work/ORD-1/01-requirements.md", "# 정의\n\n주문을 만든다.\n");
    assert.throws(() => next(repo), /요구 항목\(`## R1 · …`\)이 없습니다[\s\S]*`## 가정` 섹션이 없습니다/);
    // 근거가 없는 요구는 지시서에 없는 요구다 — 모델이 보탠 것이 여기서 걸린다
    write("doc/work/ORD-1/01-requirements.md", "## R1 · 등록\n- 데이터: 만든다\n## 가정\n- 없음\n");
    assert.throws(() => next(repo), /근거: 줄이 없는 요구 항목: R1/);
    write("doc/work/ORD-1/01-requirements.md", "## R1 · a\n근거: \"x\"\n## R1 · b\n근거: \"y\"\n## 가정\n- 없음\n");
    assert.throws(() => next(repo), /번호가 겹칩니다: R1/);
    write("doc/work/ORD-1/01-requirements.md", REQUIREMENTS);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "impact");
  });

  test("가정은 진행을 막지 않고, 제출 결과·승인 화면에 그대로 보인다", () => {
    const withAssumptions = REQUIREMENTS.replace(
      "## 가정\n- 없음",
      "## 가정\n- 목록은 id 내림차순 — 근거: 일반 관행\n- amount 는 precision 15, scale 2 — 근거: 선례 없음\n\n판정 근거:\n- 이건 가정이 아니다",
    );
    start(repo, join(repo, "doc/work/ORD-1.md"));
    writeDocs({ requirements: withAssumptions });
    const parsed = parseRequirements(readFileSync(join(repo, "doc/work/ORD-1/01-requirements.md"), "utf-8"));
    assert.deepEqual(parsed.assumptions, ["목록은 id 내림차순 — 근거: 일반 관행", "amount 는 precision 15, scale 2 — 근거: 선례 없음"]);
    next(repo);
    next(repo);
    next(repo);
    assert.match(submit(), /가정 2개 — 승인하면 계획과 함께 받아들입니다[\s\S]*- 목록은 id 내림차순/);
    assert.equal(formatAssumptions([]), undefined, "가정이 없으면 보이지 않는다");
  });

  /**
   * 가정이 조용히 빈 배열이 되면 승인 화면·05-plan.md 어디에도 실리지 않는데 게이트는 통과한다 —
   * 사람이 계획과 함께 받아들이기로 한 것이 아무에게도 보이지 않는 상태다.
   */
  test("가정은 앞의 설명 줄·CRLF·별칭 제목에도 읽힌다", () => {
    const expected = ["정렬은 id 내림차순 — 근거: 일반 관행", "금액은 BigDecimal — 근거: 선례 없음"];
    const prose = REQUIREMENTS.replace(
      "## 가정\n- 없음",
      `## 가정\n아래와 같이 정했다.\n\n- ${expected[0]}\n- ${expected[1]}`,
    );
    assert.deepEqual(parseRequirements(prose).assumptions, expected, "목록 앞의 산문");
    assert.deepEqual(parseRequirements(prose.replace(/\n/g, "\r\n")).assumptions, expected, "CRLF");
    // 스키마가 선언한 별칭(가정과 근거)·번호·괄호 설명도 다른 섹션 검사와 같게 받는다
    assert.deepEqual(parseRequirements(REQUIREMENTS.replace("## 가정", "## 1. 가정과 근거 (기본값)")).assumptions, []);
  });

  test("모르는 스테이지(P3 의 research)로 남은 커서는 이어 가지 않는다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    saveActive(repo, { ...loadActive(repo)!, phase: "research" as ActiveWork["phase"] });
    assert.throws(() => next(repo), (error: Error) => error instanceof Stop && /알 수 없는 스테이지입니다: research/.test(error.message));
    assert.throws(() => status(repo), /알 수 없는 스테이지입니다: research/);
    assert.throws(() => context(repo), /알 수 없는 스테이지입니다: research/);
  });
});

describe("② 02-analysis.md — 영향 범위 표에 모든 R", () => {
  test("없거나 필수 섹션이 비면 설계로 넘어가지 않는다", () => {
    toImpact();
    assert.throws(() => next(repo), /02-analysis\.md — 없거나 비어 있습니다 \(code-agent docs skeleton 02-analysis\)/);
    write("doc/work/ORD-1/02-analysis.md", IMPACT.replace("- 없음 — 기존 경로를 건드리지 않는다", ""));
    assert.throws(() => next(repo), /필수 섹션이 비었거나 없습니다: Risk/);
  });

  test("표 첫 열에 빠진 R 이 있으면 넘어가지 않는다 — 본문에 번호가 등장하는 것으로는 안 된다", () => {
    toImpact();
    const onlyR1 = IMPACT.replace("| R2 | 새 파일 | 없음 | 없음 — 새 도메인 |\n", "")
      .replace("- 주문 도메인은 아직 없다 (참조: deal)", "- 주문 도메인은 아직 없다. R2 는 영향이 없다");
    write("doc/work/ORD-1/02-analysis.md", onlyR1);
    assert.throws(() => next(repo), /영향 범위 표에 없는 요구 항목: R2/);
    write("doc/work/ORD-1/02-analysis.md", IMPACT);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "design");
  });

  test("R 번호만 적고 나머지 칸이 빈 줄은 영향을 본 것이 아니다", () => {
    toImpact();
    write("doc/work/ORD-1/02-analysis.md", IMPACT.replace("| R2 | 새 파일 | 없음 | 없음 — 새 도메인 |", "| R2 | | | |"));
    assert.throws(() => next(repo), /영향 범위 표의 줄이 비었습니다: R2/);
  });
});

describe("③ 03-design.md · ④ 04-functional.md — 설계·정의", () => {
  test("근거 없는 `해당 없음` 은 미충족이다", () => {
    toDesign();
    write("doc/work/ORD-1/04-functional.md", FUNCTIONAL);
    // 목록 표시·강조를 붙여도 근거 없는 한 단어인 것은 같다
    for (const decorated of ["해당 없음", "- 해당 없음", "**해당 없음**", "- **해당 없음**"]) {
      write("doc/work/ORD-1/03-design.md", DESIGN.replace("해당 없음 — 이번 범위는 도메인·저장소까지다", decorated));
      assert.throws(() => next(repo), /해당 없음 에 근거가 없습니다: API/, decorated);
    }
    write("doc/work/ORD-1/03-design.md", DESIGN);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "plan");
  });

  test("R 마다 AC 가 하나는 있어야 하고, 겹치거나 없는 R 을 가리킬 수 없다", () => {
    toDesign();
    write("doc/work/ORD-1/03-design.md", DESIGN);
    write("doc/work/ORD-1/04-functional.md", FUNCTIONAL.replace("- AC-R2-1: 없는 주문을 조회하면 ORDER_NOT_FOUND 다", ""));
    assert.throws(() => next(repo), /AC 가 없는 요구 항목: R2/);
    write("doc/work/ORD-1/04-functional.md", FUNCTIONAL.replace("AC-R2-1", "AC-R9-1"));
    assert.throws(() => next(repo), /01 에 없는 요구 항목을 가리키는 수락 기준: AC-R9-1/);
    write("doc/work/ORD-1/04-functional.md", FUNCTIONAL.replace("AC-R2-1", "AC-R1-1"));
    assert.throws(() => next(repo), /수락 기준 id 가 겹칩니다: AC-R1-1/);
  });

  test("필수 섹션이 비면 넘어가지 않는다", () => {
    toDesign();
    write("doc/work/ORD-1/03-design.md", DESIGN);
    write("doc/work/ORD-1/04-functional.md", FUNCTIONAL.replace("- 없음 — 사용자 답에 규칙이 없다", ""));
    assert.throws(() => next(repo), /필수 섹션이 비었거나 없습니다: 업무 규칙/);
  });
});

describe("⑦ 07-test-spec.md — 모든 AC 가 TC 에", () => {
  test("테스트 명세가 없으면 계획이 제출되지 않는다", () => {
    toPlan();
    rmSync(join(repo, "doc/work/ORD-1/07-test-spec.md"));
    assert.throws(() => submit(), /07-test-spec\.md — 없거나 비어 있습니다/);
  });

  test("표를 읽지 못하거나 AC 가 안 덮이면 제출되지 않는다", () => {
    toPlan();
    write("doc/work/ORD-1/07-test-spec.md", "## 테스트 케이스\n- TC-1: 주문 저장 (AC-R1-1)\n");
    assert.throws(() => submit(), /테스트 케이스 표를 읽지 못했습니다/);
    write("doc/work/ORD-1/07-test-spec.md", TEST_SPEC.replace("\n| TC-2 | Unit | AC-R2-1 | 없는 주문 조회 | ORDER_NOT_FOUND |", ""));
    assert.throws(() => submit(), /테스트 케이스가 없는 수락 기준: AC-R2-1/);
    write("doc/work/ORD-1/07-test-spec.md", TEST_SPEC.replace("| TC-2 | Unit | AC-R2-1", "| TC-1 | Unit | AC-R9-1"));
    assert.throws(() => submit(), /TC id 가 겹칩니다: TC-1[\s\S]*04 에 없는 수락 기준을 가리킵니다: AC-R9-1/);
  });

  test("전략이 '하지 않음' 이라 한 수준은 `안 하는 것` 에 근거가 있어야 쓴다", () => {
    write("doc/test-strategy.md", TEST_STRATEGY_DOC.replace("- Unit: 필수", "- Unit: 필수\n- E2E: 하지 않음"));
    confirmDocs();
    toPlan();
    const e2e = TEST_SPEC.replace("| TC-2 | Unit | AC-R2-1", "| TC-2 | E2E | AC-R2-1");
    write("doc/work/ORD-1/07-test-spec.md", e2e);
    assert.throws(() => submit(), /테스트 전략이 '하지 않음' 이라 한 수준을 씁니다: E2E/);
    write("doc/work/ORD-1/07-test-spec.md", `${e2e}\n## 안 하는 것\n- E2E 를 쓰는 이유: 조회 경로가 화면까지 걸린다 (사용자 답 Q1)\n`);
    submit();
  });

  /**
   * 부정을 줄 전체에서 찾으면 조건을 적은 수준 줄이 '하지 않음' 으로 분류돼, 빠져나갈 길이
   * 확정된 POLICY 문서를 고치는 것뿐인 자리에서 정상적인 제출이 막힌다.
   */
  test("수준 줄의 조건 설명은 '하지 않음' 이 아니다", () => {
    write("doc/test-strategy.md", TEST_STRATEGY_DOC.replace("- Unit: 필수", "- Unit: 분기 있는 로직만 — 단순 위임은 하지 않음"));
    confirmDocs();
    toPlan();
    assert.match(submit(), /계획을 제출하고/);
  });

  test("케이스·기대 결과가 빈 줄로는 AC 를 덮지 못한다 — 열은 다섯 개다", () => {
    toPlan();
    const header = "## 테스트 케이스\n| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |\n|---|---|---|---|---|\n";
    write("doc/work/ORD-1/07-test-spec.md", `${header}| TC-1 | Unit | AC-R1-1 AC-R2-1 | | |\n`);
    assert.throws(() => submit(), /케이스·기대 결과가 빈 테스트 케이스: TC-1/);
    // 열을 줄여 쓴 줄은 아예 케이스로 읽지 않는다
    write("doc/work/ORD-1/07-test-spec.md", `${header}| TC-1 | Unit | AC-R1-1 AC-R2-1 |\n`);
    assert.throws(() => submit(), /테스트 케이스 표를 읽지 못했습니다/);
  });

  test("전략에서 수준을 읽지 못하면 대조를 건너뛰고 그 사실을 알린다", () => {
    write("doc/test-strategy.md", TEST_STRATEGY_DOC.replace("- Unit: 필수", "- 자세한 것은 팀 위키를 따른다"));
    confirmDocs();
    toPlan();
    assert.match(submit(), /참고: 테스트 전략의 `수준과 범위` 에서 수준을 읽지 못해 수준 대조는 건너뛰었습니다/);
  });
});

describe("⑤ 05-plan.md — 코드가 렌더한다", () => {
  test("제출하면 계획·작업 순서·구현 방법·가정이 파일로 남는다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    writeDocs({ requirements: REQUIREMENTS.replace("## 가정\n- 없음", "## 가정\n- 목록은 id 내림차순 — 근거: 일반 관행") });
    next(repo);
    next(repo);
    next(repo);
    assert.match(submit(), /doc\/work\/ORD-1\/05-plan\.md 를 렌더했습니다/);
    const rendered = readFileSync(join(repo, "doc/work/ORD-1/05-plan.md"), "utf-8");
    assert.match(rendered, /### 작업 순서\n1\. entity — 저장소가 엔티티에 기댄다/);
    assert.match(rendered, /### 구현 방법\n참조 도메인 deal 의 구조를 그대로 따라 새로 만든다/);
    assert.match(rendered, /### 가정 \(01-requirements\.md\)\n- 목록은 id 내림차순/);
  });

  test("sequence · approach 가 없는 계획은 제출되지 않는다", () => {
    toPlan();
    const { sequence, ...withoutSequence } = PLAN;
    assert.throws(() => submit(withoutSequence), /계획 형식이 맞지 않습니다[\s\S]*sequence/);
    assert.throws(() => submit({ ...PLAN, approach: "" }), /계획 형식이 맞지 않습니다[\s\S]*approach/);
  });

  /**
   * `<대상>.plan.json` 은 커밋되는 파일이라 옛 형식이 남아 있을 수 있다. 검사 없이 읽으면
   * 승인 화면이 없는 필드를 읽다 죽어(TypeError) 재승인 경로가 통째로 닫힌다.
   */
  test("옛 형식으로 남아 있던 제출본은 다시 제출하게 한다", () => {
    toPlan();
    submit();
    const { sequence, approach, ...outdated } = PLAN;
    write(".code-agent/work/ORD-1/order.plan.json", JSON.stringify(outdated));
    assert.throws(() => status(repo), (error: Error) =>
      error instanceof Stop && /제출된 계획의 형식이 지금 스키마와 맞지 않습니다[\s\S]*plan submit 으로 다시 제출/.test(error.message));
    assert.throws(() => decideApproval(repo, "approved"), /제출된 계획의 형식이 지금 스키마와 맞지 않습니다/);
  });
});

describe("승인 묶음 — 지시서 본문 · 01 · 02 · 03 · 04 · 07 고정 목록", () => {
  const approveWithDocs = (): void => {
    const work = loadWork(repo)!;
    recordDecision(repo, {
      order: work.order, target: work.active.target, plan: work.plan!, manifest: work.manifest,
      decision: "approved", approver: "test", presence: { channel: "tty", verified: true, detail: "테스트" },
      docsHash: approvalDocsHash(work),
    });
  };

  test("승인 뒤 번호 문서가 바뀌면 무효다 — 줄바꿈만 바뀐 것은 아니다", () => {
    toPlan();
    submit();
    approveWithDocs();
    assert.equal(approvalOf(loadWork(repo)!).status, "approved");
    write("doc/work/ORD-1/04-functional.md", FUNCTIONAL.replace(/\n/g, "\r\n"));
    assert.equal(approvalOf(loadWork(repo)!).status, "approved", "줄바꿈만 바뀐 것은 같은 것으로 본다");
    // ⑦ 을 고쳐 기대치를 낮추는 길 — 수정 루프 중 테스트 동결의 절반이 여기다
    write("doc/work/ORD-1/07-test-spec.md", TEST_SPEC.replace("id 가 생긴다", "아무거나"));
    assert.equal(approvalOf(loadWork(repo)!).status, "stale-docs");
    assert.throws(() => next(repo), /승인되지 않았습니다 \(stale-docs\)/);
  });

  /**
   * 확정이 깨진 것을 "묶을 근거가 없다"로 읽어 대조를 끄면, 확정된 POLICY 문서 한 글자를 고치는 것만으로
   * 문서 묶음 대조가 통째로 꺼진다 — 그 뒤엔 번호 문서를 고쳐도 승인이 그대로 남는다.
   */
  test("확정이 깨지면 승인은 무효다 — 대조가 꺼지는 것이 아니다", () => {
    toPlan();
    submit();
    approveWithDocs();
    next(repo);
    write("doc/architecture.md", `${ARCH}\n## 추가\n- 삭제는 soft delete\n`);
    assert.equal(approvalOf(loadWork(repo)!).status, "stale-docs");
    assert.match(writeFile(`${ORDER}/domain/Order.java`) ?? "", /stale-docs/);
  });

  test("지시서 본문이 바뀌면 stale-docs, 머리말이 바뀌면 stale-order", () => {
    toPlan();
    submit();
    approveWithDocs();
    const spec = readFileSync(join(repo, "doc/work/ORD-1.md"), "utf-8");
    write("doc/work/ORD-1.md", `${spec}\n금액은 원 단위다.\n`);
    assert.equal(approvalOf(loadWork(repo)!).status, "stale-docs", "본문은 어느 해시에도 없던 구멍이었다");
    write("doc/work/ORD-1.md", spec);
    assert.equal(approvalOf(loadWork(repo)!).status, "approved");
    write("doc/work/ORD-1.md", spec.replace("title: 주문 도메인 추가", "title: 주문 도메인 개편"));
    assert.equal(approvalOf(loadWork(repo)!).status, "stale-order");
  });
});

describe("작업 문서 뼈대와 context", () => {
  test("뼈대는 그 스키마의 필수 섹션을 전부 담는다", () => {
    for (const schema of Object.values(WORK_SCHEMAS)) {
      const states = checkSections(schema, docsSkeleton(schema.kind));
      assert.ok(states.every((state) => state.found), `${schema.kind} 뼈대에 빠진 섹션`);
      assert.ok(states.filter((state) => state.required).every((state) => !state.filled), `${schema.kind} 뼈대는 아직 채워지지 않은 것이다`);
    }
  });

  test("별칭·번호·괄호 설명으로 쓴 제목도 섹션으로 인정한다", () => {
    // 실제 실행에서 writer 가 뼈대 없이 쓴 제목들
    const text = "## 1. 현행 분석\n- OrderService (src/…:12)\n## 영향 (도메인 밖 포함)\n| R1 | a | b | 없음 |\n## 위험\n- 없음\n";
    assert.ok(checkSections(WORK_SCHEMAS["02-analysis"], text).filter((state) => state.required).every((state) => state.filled));
  });

  test("영향도·설계 context 는 참조 도메인의 표준 파일과 요구 항목을 준다", () => {
    toImpact();
    const text = context(repo);
    assert.match(text, /## 참조 도메인 deal — 단계별 표준 파일/);
    assert.match(text, new RegExp(`- entity \\(도메인 안\\): ${APP}/deal/domain/Deal\\.java`));
    assert.match(text, new RegExp(`- repository \\(도메인 안\\): ${APP}/deal/repository/DealRepository\\.java`));
    assert.match(text, /- 요구 항목: R1, R2/);
    assert.match(text, /## ② 02-analysis\.md — 영향도 분석/);
  });

  test("계획 context 는 AC 와 TC 를 요약해 준다 — 메인이 04·07 을 다시 읽지 않게", () => {
    toPlan();
    const text = context(repo);
    assert.match(text, /- 수락 기준 \(doc\/work\/ORD-1\/04-functional\.md\): AC-R1-1, AC-R2-1/);
    assert.match(text, /- 테스트 케이스 \(doc\/work\/ORD-1\/07-test-spec\.md\): TC-1\(Unit → AC-R1-1\), TC-2\(Unit → AC-R2-1\)/);
    assert.match(text, /05-plan\.md 를 렌더한다/);
  });

  test("계획 제출 — 모든 요구 항목이 어느 파일엔가 닿아야 하고, 파일마다 항목을 적는다", () => {
    toPlan();
    const [entity, repository] = PLAN.files;
    assert.throws(
      () => submit({ ...PLAN, files: [entity, { ...repository, requirements: ["R1", "R9"] }] }),
      /01-requirements\.md 에 없는 요구 항목 R9[\s\S]*어떤 파일에도 닿지 않는 요구 항목: R2/,
    );
    assert.throws(() => submit({ ...PLAN, files: [{ ...entity, requirements: undefined }, repository] }), /Order\.java: 어느 요구 항목을 위한 파일인지/);
    submit();
  });
});

describe("approve — 사람만", () => {
  test("stdin 이 TTY 가 아니면 판정을 남기지 않는다", () => {
    toPlan();
    submit();
    assert.throws(() => decideApproval(repo, "approved"), /TTY 가 아닙니다/);
    assert.equal(loadWork(repo)!.plan !== undefined, true);
  });

  test("반려에는 사유가 필요하다", () => {
    toPlan();
    submit();
    assert.throws(() => decideApproval(repo, "rejected"), /사유가 필요합니다/);
  });

  /**
   * 제출과 승인 사이에도 작업 폴더는 쓸 수 있다. 다시 보지 않으면 비워진 상태의 문서 해시가
   * 그대로 승인으로 굳는다 — 승인 화면에는 계획과 가정만 보여 사람은 그 사실을 알 수 없다.
   */
  test("제출 뒤 비운 작업 문서는 승인 화면 앞에서 걸린다", () => {
    toPlan();
    submit();
    write("doc/work/ORD-1/07-test-spec.md", "");
    assert.throws(() => decideApproval(repo, "approved"), /작업 문서가 게이트를 지나지 못했습니다[\s\S]*07-test-spec\.md/);
    write("doc/work/ORD-1/02-analysis.md", "");
    assert.throws(() => decideApproval(repo, "rejected", "사유"), /작업 문서가 게이트를 지나지 못했습니다[\s\S]*02-analysis\.md/);
  });
});

describe("questions", () => {
  test("[Answer]: 뒤가 비어 있으면 답이 없는 것이다 — 다음 줄에 써도 된다", () => {
    const parsed = parseQuestions(
      "# 질문\n\n## Q1 · 분석\n무엇?\n[Answer]: A\n\n## Q2 · 분석\n어디?\n[Answer]:\n\n## Q3 · 조사\n왜?\n[Answer]:\n다음 줄의 답\n",
    );
    assert.deepEqual(parsed.map((q) => [q.id, q.answer]), [["Q1", "A"], ["Q2", ""], ["Q3", "다음 줄의 답"]]);
  });
});

describe("init", () => {
  test("에이전트 8개 모두 model: opus 가 박혀 설치된다 — 각자 PC 의 기본 모델에 맡기지 않는다", () => {
    init(repo, { cli: "C:/tools/code-agent/dist/agent/cli.js" });
    for (const agent of AGENTS) {
      assert.match(readFileSync(join(repo, `.claude/agents/ca-${agent}.md`), "utf-8"), /^model: opus$/m, agent);
    }
  });

  test("사람이 바꾼 모델은 다시 설치해도 남고, 바꾸기는 터미널에서만 된다", () => {
    init(repo, { cli: "C:/tools/code-agent/dist/agent/cli.js" });
    assert.throws(() => setModel(repo, "implementer", "sonnet"), /터미널에서만 바꿉니다/);
    assert.throws(() => setModel(repo, "nobody", "sonnet"), /에이전트는/);
    assert.throws(() => setModel(repo, "implementer", "gpt"), /모델은/);
    // 사람이 터미널에서 바꾼 결과를 흉내 낸다 — 파일은 도구로 못 쓰는 .code-agent/ 에 있다
    write(".code-agent/models.json", JSON.stringify({ implementer: "sonnet" }));
    init(repo, { cli: "C:/tools/code-agent/dist/agent/cli.js" });
    assert.match(readFileSync(join(repo, ".claude/agents/ca-implementer.md"), "utf-8"), /^model: sonnet$/m);
    assert.match(readFileSync(join(repo, ".claude/agents/ca-reviewer.md"), "utf-8"), /^model: opus$/m);
    assert.match(modelsTable(repo), /implementer\s+sonnet\s+\(바꿈\)/);
  });

  test("다른 hook 과 CLAUDE.md 의 기존 내용을 보존하고, 두 번 돌려도 하나만 남는다", () => {
    write(".claude/settings.json", JSON.stringify({ model: "x", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-check" }] }] } }));
    write("CLAUDE.md", "# 우리 프로젝트\n\n원래 내용\n");
    init(repo, { cli: "C:/tools/code-agent/dist/agent/cli.js" });
    init(repo, { cli: "C:/tools/code-agent/dist/agent/cli.js" });

    const settings = JSON.parse(readFileSync(join(repo, ".claude/settings.json"), "utf-8"));
    assert.equal(settings.model, "x");
    const commands = settings.hooks.PreToolUse.map((entry: { hooks: { command: string }[] }) => entry.hooks[0].command);
    assert.deepEqual(commands, ["other-check", 'node "C:/tools/code-agent/dist/agent/cli.js" hook']);

    const claude = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    assert.match(claude, /^# 우리 프로젝트\n\n원래 내용\n/);
    assert.equal(claude.split("<!-- code-agent:start -->").length, 2);
    assert.match(readFileSync(join(repo, ".gitignore"), "utf-8"), /\.code-agent\/active\.json/);
    assert.match(readFileSync(join(repo, ".claude/skills/ca-feature/SKILL.md"), "utf-8"), /name: ca-feature/);
    assert.match(readFileSync(join(repo, ".claude/agents/ca-implementer.md"), "utf-8"), /name: ca-implementer/);
  });
});
