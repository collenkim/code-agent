import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { blockCount, readBlock, stripBlock, upsertBlock } from "../agent/blocks";
import { hashManifest, recordDecision } from "../core/approval";
import { loadManifest } from "../core/manifest";
import { abort, back, context, next, requireValidatable, status, Stop, submitPlan } from "../agent/commands";
import { start } from "./confirmedStart";
import { commitDelivery, deliver, deliverProblems, prDocFile, traceRows } from "../agent/deliver";
import { loadEvidence, outsideChanges, overFixLimit, runsOf, validationDocFile } from "../agent/evidence";
import { decide } from "../agent/hook";
import { init } from "../agent/init";
import { applyEntry, parseProposal, proposalFile } from "../agent/knowledge";
import { loadActive, saveActive } from "../agent/layout";
import { loadReview, openRound, reviewDocFile } from "../agent/review";
import { recordReviewFixture } from "./reviewFixture";
import { observeReviewer } from "../agent/reviewHook";
import { decideStop } from "../agent/stopHook";
import { changedPaths, commitOf, partialTreeHash } from "../agent/tree";
import { check, integrate, runTests } from "../agent/validate";
import { checkProjectDocs, recordDocConfirmation } from "../agent/docs";
import { approvalDocsHash, approvalOf, loadManifestIfAny, loadWork } from "../agent/work";

/**
 * P5 — 증거 코어(단계 1)와 리뷰·통합 검증·반영(단계 2).
 *
 * 임시 git 저장소에 실제 함수를 그대로 부른다. 검증 명령은 node 한 줄짜리 스크립트라
 * 통과·실패·없는 실행 파일 세 경우를 이 머신에서 재현할 수 있다.
 */
const APP = "src/main/java/com/acme/app/application";
const ORDER = `${APP}/order`;
const TEST_FILE = "src/test/java/com/acme/app/application/order/OrderTest.java";

/** 통과하는 명령 · 실패하는 명령 · 아예 없는 실행 파일 */
const PASS = ["node", "-e", "process.exit(0)"];
const FAIL = ["node", "-e", "process.exit(3)"];
const NOT_INSTALLED = ["code-agent-does-not-exist-on-this-machine"];
/** ⑦ 의 TC id 를 출력에 그대로 낸다 — 코드가 출력에서 읽는 갈래 */
const PRINT_CASES = ["node", "-e", "console.log('ok 1 - TC-1'); console.log('ok 2 - TC-2')"];
/** Order.java 에 `fixed` 가 들어가기 전에는 실패한다 — 수정 루프를 실제로 한 바퀴 돌리는 갈래 */
const FAIL_UNTIL_FIXED = [
  "node",
  "-e",
  `const ok=require('fs').readFileSync('${ORDER}/domain/Order.java','utf-8').includes('fixed'); console.log((ok?'ok':'not ok')+' 1 - TC-1'); console.log('ok 2 - TC-2'); process.exit(ok ? 0 : 3)`,
];
/** 증거 파일을 읽어 회차를 찍는다 — 회차가 실행 **전에** 올라갔는지 보는 갈래 */
const PRINT_ROUNDS = [
  "node",
  "-e",
  "console.log('rounds=' + JSON.parse(require('fs').readFileSync('.code-agent/work/ORD-1/order.verify.json','utf-8')).rounds)",
];

function manifest(overrides: Record<string, unknown> = {}): string {
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

const PLAN = {
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

const ARCH = [
  "# 아키텍처",
  "## 기술 스택", "Java 21",
  "## 모듈/패키지 구조", "com.acme.app.<분류>.<도메인>.<계층>",
  "## 계층과 책임", "- domain: 엔티티",
  "## 의존 방향", "repository → domain",
  "## 공통 모듈", "없음",
  "## 주요 결정", "- 식별자: Long",
].join("\n");

const CONV = [
  "# 코드 컨벤션",
  "## 명명", "- 저장소는 <Entity>Repository",
  "## 계층별 규칙", "- 엔티티 필드는 private",
  "## 예외 처리", "- 공통 BusinessException",
  "## 테스트 규칙", "- 테스트 이름·주석에 TC id 를 남긴다",
].join("\n");

const STRATEGY = ["# 테스트 전략", "## 수준과 범위", "- Unit: 필수", "## 도구와 실행 명령", "- `test`: 전체 테스트", "## 통과 기준", "- AC 마다 1케이스"].join("\n");
const QUALITY = ["# 품질·보안 기준", "## 정적 분석", "- `build`: 컴파일", "## 보안 검사", "- 없음 — 리뷰에서 본다", "## 통과 기준과 반영 차단", "- 컴파일 실패는 반영을 막는다"].join("\n");

const REQUIREMENTS = [
  "# ORD-1 요구사항 정의",
  "## R1 · 주문 등록", "근거: \"주문은 id 를 가진다.\"", "- 데이터: 만든다",
  "## R2 · 주문 조회", "근거: \"주문을 조회한다.\"", "- 데이터: 안 건드린다",
  "## 가정", "- 없음",
].join("\n");

const IMPACT = [
  "# 영향도 분석", "## 기존 시스템 분석", "- 주문 도메인은 아직 없다",
  "## 영향 범위", "| R 번호 | 닿는 파일/모듈 | 부르는 곳 | 파급 |", "|---|---|---|---|",
  "| R1 | 새 파일 | 없음 | 없음 — 새 도메인 |", "| R2 | 새 파일 | 없음 | 없음 — 새 도메인 |",
  "## Risk", "- 없음",
].join("\n");

const DESIGN = [
  "# 기술 설계", "## 구성 요소", "- Order · OrderRepository", "## 처리 흐름", "- 등록 → 저장",
  "## API", "해당 없음 — 도메인까지다", "## 데이터", "- Order: id(Long)", "## 설계 결정", "- 식별자는 Long",
].join("\n");

const FUNCTIONAL = [
  "# 기능 명세", "## 기능 정의", "- R1: 등록", "- R2: 조회", "## 업무 규칙", "- 없음", "## 예외", "- 없는 주문: ORDER_NOT_FOUND",
  "## 수락 기준", "- AC-R1-1: 등록하면 id 가 생긴다", "- AC-R2-1: 없는 주문은 ORDER_NOT_FOUND 다",
].join("\n");

const TEST_SPEC = [
  "# 테스트 명세", "## 테스트 케이스",
  "| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |", "|---|---|---|---|---|",
  "| TC-1 | Unit | AC-R1-1 | 주문 저장 | id 가 생긴다 |",
  "| TC-2 | Unit | AC-R2-1 | 없는 주문 조회 | ORDER_NOT_FOUND |",
].join("\n");

let repo: string;

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

function writeFileHook(path: string): string | undefined {
  return hook("Write", { file_path: join(repo, path) });
}

function confirmDocs(): void {
  for (const check_ of checkProjectDocs(repo, loadManifestIfAny(repo))) {
    recordDocConfirmation(repo, check_, "test", { channel: "tty", verified: true, detail: "테스트" });
  }
}

function approve(): void {
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
function useManifest(overrides: Record<string, unknown> = {}, quality?: string): void {
  write("code-agent.json", manifest(overrides));
  if (quality) write("doc/quality.md", quality);
  confirmDocs();
  git("add", "-A");
  git("commit", "-qm", "manifest");
}

/** 계획 파일까지 만들어 check 스테이지에 세운다 */
function toCheck(): void {
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
async function toReview(): Promise<void> {
  toCheck();
  await check(requireValidatable(repo, "check"));
  next(repo);
  await runTests(requireValidatable(repo, "test"));
  next(repo);
  assert.equal(loadActive(repo)!.phase, "review");
}

/** 모델이 ⑨ 의 `## 지적` 에 쓰는 것 — 코드 구역 밖이라 그냥 이어 붙인다 */
function writeFindings(...rows: string[]): void {
  const path = join(repo, reviewDocFile("ORD-1"));
  writeFileSync(path, `${readFileSync(path, "utf-8")}\n${rows.length > 0 ? rows.join("\n") : "- 없음"}\n`);
  recordReviewFixture(repo);
}

/** 회차가 열리기 전에 모델이 ⑨ 를 통째로 지어 쓰는 것 — 작업 폴더 안이라 hook 은 막지 않는다 */
function forgeReviewDoc(...rows: string[]): void {
  write(
    reviewDocFile("ORD-1"),
    ["# ORD-1 코드 리뷰", "", "## 지적", "", "| id | 계획 파일 | 범위 | 상태 | 지적 |", "|---|---|---|---|---|", ...rows, ""].join("\n"),
  );
}

/** 리뷰 회차를 열고 지적 없이 닫아 통합 검증까지 세운다 */
async function toIntegrate(): Promise<void> {
  await toReview();
  openRound(requireValidatable(repo, "review"));
  writeFindings();
  next(repo);
  assert.equal(loadActive(repo)!.phase, "integrate");
}

async function toDeliver(): Promise<void> {
  await toIntegrate();
  await integrate(requireValidatable(repo, "integrate"));
  next(repo);
  assert.equal(loadActive(repo)!.phase, "deliver");
}

/** 모델이 쓰는 ⑩ 의 세 섹션 */
function writePr(): void {
  write(
    prDocFile("ORD-1"),
    ["# ORD-1 변경 보고서", "", "## 요약", "주문 도메인을 더했다.", "", "## 확인 방법", "OrderRepository 를 부른다.", "", "## 위험·되돌리기", "없음 — 새 도메인이라 되돌리면 파일만 지운다.", ""].join("\n"),
  );
}

beforeEach(() => {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-p5-")));
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
  // deliver 의 커밋은 -c 없이 저장소 설정으로 돈다 — 실제 사용과 같은 경로를 밟게 여기서 심는다
  git("config", "user.name", "t");
  git("config", "user.email", "t@t");
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
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

// ---- 기준 커밋 ----

describe("기준 커밋을 굳힌다", () => {
  test("start 가 기준 브랜치를 커밋으로 박고, 그 뒤 기준 브랜치가 움직여도 대조가 흔들리지 않는다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    const pinned = loadActive(repo)!.baseCommit!;
    assert.equal(pinned, git("rev-parse", "master"));

    // 기준 브랜치가 한 커밋 더 나간다
    git("switch", "-q", "master");
    write("other.txt", "x\n");
    git("add", "other.txt");
    git("commit", "-qm", "move");
    git("switch", "-q", "feature/ORD-1");

    assert.notEqual(pinned, git("rev-parse", "master"));
    assert.equal(loadActive(repo)!.baseCommit, pinned);
    // 굳혀 둔 커밋과의 차이는 그대로다 — master 가 더한 파일은 이 작업의 변경이 아니다
    assert.equal(changedPaths(repo, pinned).some((change) => change.path === "other.txt"), false);
    assert.equal(changedPaths(repo, "master").some((change) => change.path === "other.txt"), true);
  });

  test("P5 이전에 시작된 커서(기준 커밋 없음)는 진행하지 않고 다시 시작하게 한다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    const { baseCommit, ...legacy } = loadActive(repo)!;
    assert.ok(baseCommit);
    saveActive(repo, legacy);
    assert.throws(() => next(repo), (error: Error) => error instanceof Stop && /굳혀 둔 기준 커밋이 없습니다/.test(error.message));
  });
});

describe("changedPaths · partialTreeHash", () => {
  test("추가·수정·삭제·이름변경·추적되지 않은 새 파일을 잡고 .gitignore 된 것은 잡지 않는다", () => {
    write("a.txt", "a\n");
    write("b.txt", "b\n");
    write("gone.txt", "gone\n");
    write("old.txt", "same\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = commitOf(repo, "HEAD")!;

    write("a.txt", "changed\n");
    rmSync(join(repo, "gone.txt"));
    git("mv", "old.txt", "renamed.txt");
    write("new.txt", "new\n");
    write("build/artifact.jar", "junk\n");

    const changes = new Map(changedPaths(repo, base).map((change) => [change.path, change.status]));
    assert.equal(changes.get("a.txt"), "M");
    assert.equal(changes.get("gone.txt"), "D");
    assert.equal(changes.get("old.txt"), "D");
    assert.equal(changes.get("renamed.txt"), "R");
    assert.equal(changes.get("new.txt"), "A");
    assert.equal(changes.has("b.txt"), false);
    assert.equal(changes.has("build/artifact.jar"), false);
  });

  test("계획 파일이 한 글자 바뀌거나 사라지면 부분 트리 해시가 달라진다", () => {
    write("x.java", "class X {}\n");
    const before = partialTreeHash(repo, ["x.java"]);
    write("x.java", "class X { }\n");
    assert.notEqual(before, partialTreeHash(repo, ["x.java"]));
    rmSync(join(repo, "x.java"));
    assert.notEqual(before, partialTreeHash(repo, ["x.java"]));
  });
});

// ---- check ----

describe("code-agent check", () => {
  test("계획 밖 변경이 있으면 명령을 돌리기 전에 멈춘다", async () => {
    toCheck();
    write("src/main/java/com/acme/app/application/order/domain/Sneaky.java", "class Sneaky {}\n");
    await assert.rejects(
      () => check(requireValidatable(repo, "check")),
      (error: Error) => error instanceof Stop && /계획 밖 변경 \[A\] .*Sneaky\.java/.test(error.message),
    );
    // 이 폴더에는 스테이지 전이 기록(stages.jsonl)이 이미 들어 있다 — 여기서 없어야 하는 것은
    // **검증 실행 로그**다. 명령을 하나도 돌리지 않았다는 것이 이 테스트가 보는 것이다.
    assert.deepEqual(readdirSync(join(repo, ".code-agent/log")).filter((name) => name.endsWith(".log")), []);
    assert.equal(loadEvidence(repo, "ORD-1", "order"), undefined);
  });

  test("계획 파일이 사라졌으면 멈춘다 — 지워서 통과시키는 길", async () => {
    toCheck();
    rmSync(join(repo, TEST_FILE));
    await assert.rejects(
      () => check(requireValidatable(repo, "check")),
      (error: Error) => error instanceof Stop && /계획에 있는데 없는 파일 .*OrderTest\.java/.test(error.message),
    );
  });

  test("통과하면 증거와 ⑧ 을 남기고 next 가 test 로 넘긴다", async () => {
    toCheck();
    const out = await check(requireValidatable(repo, "check"));
    assert.match(out, /build: passed/);

    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(evidence.rounds, 1);
    assert.equal(evidence.baseCommit, loadActive(repo)!.baseCommit);
    assert.equal(evidence.runs.filter((run) => run.phase === "check").length, 1);
    assert.ok(existsSync(join(repo, ".code-agent/log/check-1-build.log")));
    assert.match(readFileSync(join(repo, validationDocFile("ORD-1")), "utf-8"), /## 실행 결과/);

    next(repo);
    assert.equal(loadActive(repo)!.phase, "test");
  });

  test("회차는 명령을 돌리기 **전에** 올라간다 — 죽여서 카운터를 피할 수 없다", async () => {
    useManifest({ build: PRINT_ROUNDS });
    toCheck();
    const out = await check(requireValidatable(repo, "check"));
    assert.match(out, /build: passed/);
    assert.match(readFileSync(join(repo, ".code-agent/log/check-1-build.log"), "utf-8"), /rounds=1/);
  });

  test("돌아서 실패한 명령은 failed 다 — next 가 열리지 않는다", async () => {
    useManifest({ build: FAIL });
    toCheck();
    await check(requireValidatable(repo, "check"));
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.runs[0].outcome, "failed");
    assert.throws(() => next(repo), /build: failed/);
  });

  test("돌지 못한 명령은 error 다 — failed 와 섞지 않고, 역시 next 가 열리지 않는다", async () => {
    useManifest({ build: NOT_INSTALLED });
    toCheck();
    await check(requireValidatable(repo, "check"));
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.runs[0].outcome, "error");
    assert.throws(() => next(repo), /build: error/);
  });

  test("선언되지 않은 검증은 not-run 이고 통과로 세지 않는다", async () => {
    useManifest({ build: undefined }, QUALITY.replace("- `build`: 컴파일", "- 없음 — 아직 없다"));
    toCheck();
    const out = await check(requireValidatable(repo, "check"));
    assert.match(out, /build: not-run/);
    assert.match(out, /돌릴 명령이 하나도 선언돼 있지 않습니다/);
    assert.throws(() => next(repo), /build: not-run/);
  });
});

// ---- 증거 묶기 ----

describe("증거는 트리·매니페스트·계획에 묶인다", () => {
  test("통과 뒤 계획 파일을 한 글자 고치면 next 가 거부한다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    write(`${ORDER}/domain/Order.java`, "class Order { }\n");
    assert.throws(() => next(repo), /검증 뒤 계획 파일이 바뀌었습니다/);
  });

  test("통과 뒤 test 명령을 약한 것으로 바꾸면 next 가 거부한다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    write("code-agent.json", manifest({ test: ["node", "-e", "0"] }));
    assert.throws(() => next(repo), /경계·검증 선언이 바뀌었습니다/);
  });

  test("⑧ 을 손으로 고치면 next 가 거부하고, 모델은 애초에 쓸 수 없다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    assert.match(writeFileHook(validationDocFile("ORD-1")) ?? "", /코드가 렌더합니다/);
    write(validationDocFile("ORD-1"), "# 전부 통과했습니다\n");
    assert.throws(() => next(repo), /08-validation\.md 가 증거와 다릅니다/);
  });
});

// ---- test ----

describe("code-agent test", () => {
  test("check 를 먼저 돌리지 않으면 거부한다", async () => {
    toCheck();
    saveActive(repo, { ...loadActive(repo)!, phase: "test" });
    await assert.rejects(() => runTests(requireValidatable(repo, "test")), /code-agent check/);
  });

  test("⑦ 의 TC 를 실행 출력에서 읽는다", async () => {
    useManifest({ test: PRINT_CASES });
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.deepEqual(loadEvidence(repo, "ORD-1", "order")!.testCases.map((entry) => entry.source), ["출력", "출력"]);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "review");
  });

  test("테스트 파일에 TC가 있어도 실제 결과가 없으면 진행하지 않는다", async () => {
    useManifest({ test: PASS });
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    assert.deepEqual(evidence.testCases.map((entry) => entry.source), ["테스트 파일", "테스트 파일"]);
    assert.deepEqual(evidence.testCases.map((entry) => entry.where), [TEST_FILE, TEST_FILE]);
    assert.throws(() => next(repo), /확인되지 않았습니다/);
  });

  test("check 뒤 계획 파일이 바뀌었으면 test 를 돌리지 않는다 — 통과한 코드로 테스트한 것이 아니다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    write(`${ORDER}/domain/Order.java`, "class Order { }\n");
    await assert.rejects(() => runTests(requireValidatable(repo, "test")), /code-agent check 부터 다시/);
  });

  test("앞 회차의 test 통과로 지금 회차를 덮을 수 없다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));

    // 고쳐 쓰고 check 만 다시 돌린 뒤 test 를 건너뛰는 길
    write(`${ORDER}/domain/Order.java`, "class Order { }\n");
    saveActive(repo, { ...loadActive(repo)!, phase: "check" });
    await check(requireValidatable(repo, "check"));
    next(repo);
    assert.throws(() => next(repo), /test 결과가 2회차의 것이 아닙니다/);
  });

  test("어디에도 없는 TC 가 있으면 next 가 review 를 열지 않는다", async () => {
    useManifest({ test: ["node", "-e", "console.log('ok 1 - TC-1')"] });
    toCheck();
    write(TEST_FILE, "// TC-1 만 있다\nclass OrderTest {}\n");
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.throws(() => next(repo), /확인되지 않았습니다: TC-2/);
  });

  test("명령이 성공해도 skip TC는 테스트 게이트를 열지 않는다", async () => {
    useManifest({ test: ["node", "-e", "console.log('ok 1 - TC-1\\nok 2 - TC-2 # SKIP')"] });
    toCheck();
    await check(requireValidatable(repo, "check")); next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.throws(() => next(repo), /TC-2/);
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.testCases[1].status, "skipped");
  });

  test("깨끗한 통합 환경에서 생략된 TC를 이전 테스트 통과로 덮지 않는다", async () => {
    useManifest({ test: ["node", "-e", "console.log('ok 1 - TC-1\\nok 2 - TC-2'+(require('fs').statSync('.git').isFile()?' # SKIP':''))"] });
    await toIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(evidence.testCases[1].status, "passed");
    assert.equal(evidence.integrationTestCases![1].status, "skipped");
    assert.throws(() => next(repo), /TC-2/);
  });
});

// ---- 수정 루프와 동결 ----

describe("수정 루프", () => {
  /** 실패하는 build 로 회차를 원하는 만큼 태운다 */
  async function burnRounds(times: number): Promise<void> {
    for (let round = 0; round < times; round += 1) {
      await check(requireValidatable(repo, "check"));
    }
  }

  beforeEach(() => useManifest({ build: FAIL }));

  test("한도 안에서는 계획 파일을 고칠 수 있고, 남은 회차를 알려 준다", async () => {
    toCheck();
    await burnRounds(1);
    assert.equal(writeFileHook(`${ORDER}/domain/Order.java`), undefined);
    const out = await check(requireValidatable(repo, "check"));
    assert.match(out, /남은 고쳐 쓰기 1회/);
  });

  test("한도를 넘기면 hook 이 계획 파일 쓰기를 전부 거부하고, 작업 폴더는 남는다", async () => {
    toCheck();
    await burnRounds(3);
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 3);
    assert.match(writeFileHook(`${ORDER}/domain/Order.java`) ?? "", /고쳐 쓰기 2회를 넘겨/);
    assert.equal(writeFileHook("doc/work/ORD-1/questions.md"), undefined);
    await assert.rejects(() => check(requireValidatable(repo, "check")), /덮지 않고 보고하는 자리/);
    assert.match(status(repo), /고쳐 쓰기 2회를 넘겨 막혔습니다/);
  });

  test("한도는 증거가 시작될 때 굳는다 — 루프 도중에 code-agent.json 으로 올릴 수 없다", async () => {
    toCheck();
    await burnRounds(3);
    assert.match(writeFileHook(`${ORDER}/domain/Order.java`) ?? "", /고쳐 쓰기 2회를 넘겨/);

    // fixRounds 는 hashManifest 에 들어가지 않는다(경계도 검증 선언도 아니다) — 그래서 올려도
    // 승인이 그대로라, 매번 매니페스트에서 읽으면 code-agent.json 이 계획 파일인 작업에서 뚫린다
    const before = hashManifest(loadManifest(repo));
    write("code-agent.json", manifest({ build: FAIL, fixRounds: 99 }));
    assert.equal(hashManifest(loadManifest(repo)), before, "한도를 바꿔도 승인은 흔들리지 않는다");
    assert.equal(loadWork(repo)!.manifest.fixRounds, 99);

    assert.match(writeFileHook(`${ORDER}/domain/Order.java`) ?? "", /고쳐 쓰기 2회를 넘겨/);
    assert.equal(overFixLimit(loadWork(repo)!, loadEvidence(repo, "ORD-1", "order")!), true);
  });

  test("한도를 넘긴 뒤 implement 로 되감아도 계획 파일은 열리지 않는다", async () => {
    toCheck();
    await burnRounds(3);
    assert.match(writeFileHook(`${ORDER}/domain/Order.java`) ?? "", /고쳐 쓰기 2회를 넘겨/);

    // 커서를 구현으로 빼는 것은 한도를 되사는 길이 아니다 — 막는 것은 스테이지가 아니라 증거다
    back(repo, "implement");
    assert.match(writeFileHook(`${ORDER}/domain/Order.java`) ?? "", /고쳐 쓰기 2회를 넘겨/);
  });

  test("계획이 재승인되면 회차와 동결이 함께 풀린다 — 옛 증거는 다른 계획 위의 것이다", async () => {
    toCheck();
    await burnRounds(3);
    write("doc/work/ORD-1/plan.json", JSON.stringify({ ...PLAN, reasoning: "다시 세운 계획" }));
    saveActive(repo, { ...loadActive(repo)!, phase: "plan" });
    submitPlan(repo, join(repo, "doc/work/ORD-1/plan.json"));
    approve();
    saveActive(repo, { ...loadActive(repo)!, phase: "check" });
    assert.equal(writeFileHook(`${ORDER}/domain/Order.java`), undefined);
  });
});

describe("테스트 동결", () => {
  test("테스트가 돌기 전에는 쓰고, 한 번 돈 뒤에는 hook 이 거부한다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    assert.equal(writeFileHook(TEST_FILE), undefined);

    next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.match(writeFileHook(TEST_FILE) ?? "", /테스트가 이미 돌아 얼어 있는 파일입니다/);
    // 테스트가 아닌 계획 파일은 그대로 고친다 — 얼리는 것은 단언뿐이다
    assert.equal(writeFileHook(`${ORDER}/domain/Order.java`), undefined);
  });

  test("실패한 테스트도 동결한다 — 실패를 지워 통과시키는 길이 본체다", async () => {
    useManifest({ test: FAIL });
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);
  });

  test("implement 스테이지에서는 같은 파일을 쓴다", () => {
    toCheck();
    saveActive(repo, { ...loadActive(repo)!, phase: "implement", stage: "test" });
    assert.equal(writeFileHook(TEST_FILE), undefined);
  });

  test("테스트가 돈 뒤에는 implement 로 되감아도 얼어 있다 — 동결은 커서가 아니라 증거에 묶인다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);

    // 커서를 구현으로 빼고 테스트 단계까지 걸어 와도 같다 — 단언을 지워 통과시키는 길이 여기서도 닫힌다
    back(repo, "implement");
    next(repo);
    next(repo);
    assert.equal(loadActive(repo)!.stage, "test");
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);
  });

  test("⑨ 에 그 파일을 가리키는 열린 계획 안 지적이 있으면 풀린다 — 해결로 닫으면 다시 언다", async () => {
    await toReview();
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);

    openRound(requireValidatable(repo, "review"));
    // 다른 파일을 가리키는 지적은 열쇠가 아니다 — 열쇠는 그 경로를 가리킨 줄 하나다
    writeFindings(`| F1 | ${ORDER}/domain/Order.java | 계획 안 | 열림 | 필드가 public 이다 |`);
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);

    writeFindings(`| F2 | ${TEST_FILE} | 계획 안 | 열림 | 단언이 기대 결과를 확인하지 않는다 |`);
    assert.equal(writeFileHook(TEST_FILE), undefined);

    const path = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(path, readFileSync(path, "utf-8").replace(/\| 열림 \|/g, "| 해결 |"));
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);
  });
});

// ---- 매니페스트 ----

describe("매니페스트 kind:\"test\"", () => {
  test("enum 에 값을 더해도 그 값을 쓰지 않는 매니페스트의 해시는 그대로다", () => {
    // P4 코드가 같은 매니페스트에 내던 값. 바뀌면 진행 중인 모든 계획 승인이 stale-manifest 로 떨어진다
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-hash-")));
    writeFileSync(
      join(dir, "code-agent.json"),
      JSON.stringify({
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
      }),
    );
    assert.equal(hashManifest(loadManifest(dir)), "sha256:c61b36d89e42e46e");
    rmSync(dir, { recursive: true, force: true });
  });

  test("kind:\"test\" 를 선언하면 해시가 달라진다 — 승인 뒤 동결을 끌 수 없다", () => {
    const withTest = loadManifest(repo);
    write("code-agent.json", manifest().replace(JSON.stringify({ kind: "test" }).slice(1, -1), JSON.stringify({ kind: "code" }).slice(1, -1)));
    assert.notEqual(hashManifest(withTest), hashManifest(loadManifest(repo)));
  });
});

// ---- hook · Stop hook ----

describe("hook — 검증 명령", () => {
  test("code-agent check · test 는 Bash 로 부를 수 있고, 연결은 거부된다", () => {
    toCheck();
    assert.equal(hook("Bash", { command: "code-agent check" }), undefined);
    assert.equal(hook("Bash", { command: "code-agent test" }), undefined);
    assert.match(hook("Bash", { command: "code-agent check && git commit -m x" }) ?? "", /연결·리다이렉트/);
    // 되감기도 모델이 부를 수 있다 — 뒤로만 가고 지우는 것이 없어 건너뛸 수 있는 것이 없다
    assert.equal(hook("Bash", { command: "code-agent back design" }), undefined);
    // 커서를 지우는 abort 는 그대로 사람의 자리다 — 열어 두면 hook 이 아무것도 판정하지 않게 된다
    assert.match(hook("Bash", { command: "code-agent abort" }) ?? "", /현재 세션의 ca-answer 동의 절차/);
  });
});

describe("반려된 계획", () => {
  test("status 가 사유와 다시 볼 문서를 가리킨다 — 같은 계획을 다시 내게 하지 않는다", () => {
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
    const work = loadWork(repo)!;
    recordDecision(repo, {
      order: work.order,
      target: work.active.target,
      plan: work.plan!,
      manifest: work.manifest,
      decision: "rejected",
      approver: "test",
      comment: "R2 의 조회 범위가 04 와 다릅니다",
      presence: { channel: "tty", verified: true, detail: "테스트" },
    });
    assert.match(status(repo), /반려됐습니다: R2 의 조회 범위가 04 와 다릅니다/);
    assert.match(status(repo), /질문으로 남긴 뒤 다시 제출하세요/);
  });
});

describe("Stop hook", () => {
  test("계획 밖 변경을 한 번 막고, stop_hook_active 면 놓아 준다", () => {
    toCheck();
    assert.equal(decideStop({ cwd: repo }), undefined);
    write(`${ORDER}/domain/Sneaky.java`, "class Sneaky {}\n");
    assert.match(decideStop({ cwd: repo }) ?? "", /계획 밖의 변경이 남아 있습니다/);
    assert.equal(decideStop({ cwd: repo, stop_hook_active: true }), undefined);
  });

  test("답 없는 질문이 있으면 막는다", () => {
    toCheck();
    write("doc/work/ORD-1/questions.md", "## Q1 · 검증\n무엇을 더 볼까?\n[Answer]:\n");
    assert.match(decideStop({ cwd: repo }) ?? "", /답이 없는 질문이 1개/);
  });

  test("진행 중인 작업이 없거나 아직 코드를 쓰기 전이면 끼어들지 않는다", () => {
    assert.equal(decideStop({ cwd: repo }), undefined);
    start(repo, join(repo, "doc/work/ORD-1.md"));
    write("anywhere.txt", "x\n");
    assert.equal(decideStop({ cwd: repo }), undefined);
  });
});

describe("init — Stop hook 설치", () => {
  test("PreToolUse 와 Stop 을 둘 다 넣고, 블록 밖 설정은 건드리지 않는다", () => {
    write(".claude/settings.json", JSON.stringify({ env: { MINE: "1" }, hooks: { Stop: [{ hooks: [{ type: "command", command: "my-own thing" }] }] } }));
    init(repo);
    const settings = JSON.parse(readFileSync(join(repo, ".claude/settings.json"), "utf-8")) as {
      env: Record<string, string>;
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    assert.equal(settings.env.MINE, "1");
    assert.deepEqual(settings.hooks.PreToolUse.map((entry) => entry.hooks[0].command), ["code-agent hook", "code-agent consent-event"]);
    assert.deepEqual(settings.hooks.Stop.map((entry) => entry.hooks[0].command), ["my-own thing", "code-agent stop"]);

    // 다시 설치해도 우리 것만 하나로 유지된다
    init(repo);
    const again = JSON.parse(readFileSync(join(repo, ".claude/settings.json"), "utf-8")) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(again.hooks.Stop.length, 2);
    assert.equal(again.hooks.PreToolUse.length, 2);
  });
});

// ---- 9 코드 리뷰 ----

describe("code-agent review — 회차", () => {
  test("검증이 통과한 뒤에만 열리고, 회차 구역은 코드가 렌더한다", async () => {
    await toReview();
    // 리뷰 스테이지에서 계획 파일을 고치면 증거가 무효라 회차가 열리지 않는다
    write(`${ORDER}/domain/Order.java`, "class Order { }\n");
    assert.throws(
      () => openRound(requireValidatable(repo, "review")),
      (error: Error) => error instanceof Stop && /검증이 지금 트리 위에서 통과하지 않아/.test(error.message),
    );

    write(`${ORDER}/domain/Order.java`, "class Order {}\n");
    openRound(requireValidatable(repo, "review"));
    const log = loadReview(repo, "ORD-1", "order")!;
    assert.equal(log.rounds.length, 1);
    assert.equal(
      log.rounds[0].treeHash,
      partialTreeHash(repo, [`${ORDER}/domain/Order.java`, `${ORDER}/repository/OrderRepository.java`, TEST_FILE]),
    );
    const doc = readFileSync(join(repo, reviewDocFile("ORD-1")), "utf-8");
    assert.match(doc, /<!-- code-agent:review:start -->/);
    assert.ok(doc.includes(`| 1 | ${log.rounds[0].at} | ${log.rounds[0].treeHash} |`));
  });

  test("같은 트리에서 회차를 두 번 열지 않는다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    assert.throws(
      () => openRound(requireValidatable(repo, "review")),
      (error: Error) => error instanceof Stop && /이미 지금 트리를 보고 있습니다/.test(error.message),
    );
  });

  test("회차 없이 next 를 부르면 넘어가지 않는다", async () => {
    await toReview();
    assert.throws(() => next(repo), /리뷰 회차가 없습니다/);
  });
});

describe("코드 리뷰 게이트 (review → integrate)", () => {
  test("회차와 지적 없음만 작성해서는 독립 리뷰를 대신할 수 없다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    const path = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(path, `${readFileSync(path, "utf-8")}\n- 없음\n`);
    assert.throws(() => next(repo), /독립 리뷰어 실행·완료 기록이 없습니다/);
    assert.match(hook("Bash", { command: "code-agent review-event" }) ?? "", /Bash/);
  });

  test("리뷰어의 짝이 맞는 시작·완료와 수정되지 않은 결과만 통과한다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    const event = { cwd: repo, session_id: "session", agent_id: "reviewer", agent_type: "ca-reviewer" };
    assert.throws(() => observeReviewer({ ...event, hook_event_name: "SubagentStop", last_assistant_message: "- 없음" }), /시작한 리뷰어/);
    observeReviewer({ ...event, hook_event_name: "SubagentStart" });
    assert.throws(() => observeReviewer({ ...event, agent_id: "other", hook_event_name: "SubagentStop", last_assistant_message: "- 없음" }), /시작한 리뷰어/);
    observeReviewer({ ...event, hook_event_name: "SubagentStop", last_assistant_message: `| F1 | ${TEST_FILE} | 계획 안 | 열림 | TC-1 단언을 보완해야 한다 |` });
    assert.equal(writeFileHook(TEST_FILE), undefined);
    const path = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(path, readFileSync(path, "utf-8").replace("| 열림 |", "| 해결 |"));
    assert.throws(() => next(repo), /관찰된 ca-reviewer 결과와 다릅니다/);
  });

  test("리뷰 중 바뀐 코드에는 완료 기록을 붙이지 않는다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    const event = { cwd: repo, session_id: "session", agent_id: "reviewer", agent_type: "ca-reviewer" };
    observeReviewer({ ...event, hook_event_name: "SubagentStart" });
    write(`${ORDER}/domain/Order.java`, "class Order { int changed; }\n");
    assert.throws(() => observeReviewer({ ...event, hook_event_name: "SubagentStop", last_assistant_message: "- 없음" }), /리뷰 도중/);
    assert.throws(() => next(repo), /독립 리뷰어 실행·완료 기록이 없습니다/);
  });

  test("리뷰 지적 수정은 구현 파일을 먼저 고쳐도 동결 테스트를 열 수 있다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings(`| F1 | ${TEST_FILE} | 계획 안 | 열림 | TC-1 단언 누락 |`);
    write(`${ORDER}/domain/Order.java`, "class Order { /* review fix */ }\n");
    assert.equal(writeFileHook(TEST_FILE), undefined);
    assert.throws(() => next(repo), /회차 뒤 계획 파일이 바뀌었습니다/);
  });

  test("실제 하위 transcript의 SubagentHandback 보고를 기록하며 다른 경로는 거부한다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    const transcriptRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-transcript-")));
    try {
      const session = "session", agent = "reviewer";
      const transcript = join(transcriptRoot, session, "subagents", `agent-${agent}.jsonl`);
      mkdirSync(dirname(transcript), { recursive: true });
      const event = { cwd: repo, session_id: session, agent_id: agent, agent_type: "ca-reviewer", transcript_path: join(transcriptRoot, `${session}.jsonl`) };
      observeReviewer({ ...event, hook_event_name: "SubagentStart" });
      const entry = (timestamp: string, message: string) => JSON.stringify({ timestamp, type: "assistant", message: { content: [{ type: "tool_use", name: "SubagentHandback", input: { message } }] } });
      writeFileSync(transcript, entry("2000-01-01T00:00:00.000Z", "- 없음") + "\n");
      assert.throws(() => observeReviewer({ ...event, hook_event_name: "SubagentStop", agent_transcript_path: join(repo, reviewDocFile("ORD-1")), last_assistant_message: "- 없음" }), /해당 세션의 하위/);
      assert.throws(() => observeReviewer({ ...event, hook_event_name: "SubagentStop", agent_transcript_path: transcript, last_assistant_message: "검토 완료" }), /리뷰 결과는 지적 표/);
      writeFileSync(transcript, entry(new Date().toISOString(), "- 없음") + "\n");
      observeReviewer({ ...event, hook_event_name: "SubagentStop", agent_transcript_path: transcript, last_assistant_message: "검토 완료" });
      next(repo);
      assert.equal(loadActive(repo)!.phase, "integrate");
    } finally { rmSync(transcriptRoot, { recursive: true, force: true }); }
  });
  test("마지막 회차 뒤 계획 파일이 바뀌면 거부한다 — 리뷰 뒤 고치고 반영하는 길", async () => {
    await toIntegrate();
    saveActive(repo, { ...loadActive(repo)!, phase: "review" });
    write(`${ORDER}/domain/Order.java`, "class Order { /* 몰래 */ }\n");
    assert.throws(() => next(repo), /회차 뒤 계획 파일이 바뀌었습니다/);
  });

  test("열린 지적은 메인이 닫을 수 없고 독립 재검토가 확인해야 한다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings(`| F1 | ${ORDER}/domain/Order.java | 계획 안 | 열림 | 필드가 public 이다 |`);
    assert.throws(() => next(repo), /열린 지적: F1/);

    const path = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(path, readFileSync(path, "utf-8").replace("| 열림 |", "| 해결 |"));
    assert.throws(() => next(repo), /관찰된 ca-reviewer 결과와 다릅니다/);
    recordReviewFixture(repo);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "integrate");
  });

  test("계획 밖 경로를 가리키는 지적은 해결로 적어도 거부한다 — 모델이 닫을 수 없다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings("| F1 | src/main/java/com/acme/app/common/ErrorCode.java | 계획 밖 | 해결 | 오류 코드가 없다 |");
    assert.throws(() => next(repo), /계획 밖을 가리키는 지적: F1/);
  });

  test("범위 칸은 코드가 계획과 대조해 정한다 — 모델이 다르게 적으면 드러난다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings(`| F1 | ${ORDER}/domain/Order.java | 계획 밖 | 해결 | 이름이 다르다 |`);
    assert.throws(() => next(repo), /범위 칸이 계획과 다릅니다: F1/);
  });

  test("지적을 아예 쓰지 않으면 거부한다 — 없으면 없다고 적게 한다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    assert.throws(() => next(repo), /지적이 없습니다/);
  });

  test("회차 구역을 손으로 고치면 거부한다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings();
    const path = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(path, readFileSync(path, "utf-8").replace(/\| 1 \| [^|]+ \|/, "| 1 | 방금 |"));
    assert.throws(() => next(repo), /회차 구역이 기록과 다릅니다/);
  });

  test("계획이 재승인되면 옛 회차 위에서 진행하지 않는다", async () => {
    await toIntegrate();
    // 계획을 다시 제출하고 승인하면 planHash 가 달라진다
    saveActive(repo, { ...loadActive(repo)!, phase: "plan" });
    write("doc/work/ORD-1/plan.json", JSON.stringify({ ...PLAN, reasoning: "다시 세운 계획" }));
    submitPlan(repo, join(repo, "doc/work/ORD-1/plan.json"));
    approve();
    saveActive(repo, { ...loadActive(repo)!, phase: "review" });
    assert.throws(() => next(repo), /리뷰 뒤 계획이 바뀌었습니다/);
  });
});

// ---- 10 통합 검증 ----

describe("code-agent integrate", () => {
  test("기준 커밋 위의 깨끗한 worktree 에서 돌린다 — 작업 트리의 산출물은 끼지 않는다", async () => {
    // build 는 계획 파일이 얹혔는지, test 는 gitignore 된 산출물이 따라왔는지 본다
    useManifest({
      build: ["node", "-e", `process.exit(require('fs').existsSync('${ORDER}/domain/Order.java') ? 0 : 7)`],
      test: ["node", "-e", "console.log('ok 1 - TC-1\\nok 2 - TC-2'); process.exit(require('fs').existsSync('build/stray.txt') ? 0 : 7)"],
    });
    // .gitignore 된 산출물이라 changedPaths 에 잡히지 않는다 — 작업 트리에서는 test 가 통과한다
    write("build/stray.txt", "작업 트리에만 있는 산출물\n");
    await toIntegrate();

    const out = await integrate(requireValidatable(repo, "integrate"));
    const runs = new Map(runsOf(loadEvidence(repo, "ORD-1", "order")!, "integrate").map((run) => [run.kind, run.outcome]));
    assert.equal(runs.get("build"), "passed", "계획 파일은 worktree 에 얹힌다");
    assert.equal(runs.get("test"), "failed", "작업 트리에만 있던 산출물은 따라오지 않는다");
    assert.match(out, /깨끗한 worktree/);
    assert.throws(() => next(repo), /test: failed/);
  });

  test("전부 통과하면 ⑧ 에 남고 next 가 deliver 로 넘긴다", async () => {
    await toIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    assert.equal(runsOf(loadEvidence(repo, "ORD-1", "order")!, "integrate").length, 2);
    assert.match(readFileSync(join(repo, validationDocFile("ORD-1")), "utf-8"), /\| integrate \|/);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "deliver");
  });

  test("리뷰가 지금 트리 위에서 닫혀 있지 않으면 돌리지 않는다", async () => {
    await toIntegrate();
    write(`${ORDER}/domain/Order.java`, "class Order { }\n");
    await assert.rejects(
      () => integrate(requireValidatable(repo, "integrate")),
      (error: Error) => error instanceof Stop && /코드 리뷰가 지금 트리 위에서 닫혀 있지 않아/.test(error.message),
    );
  });
});

// ---- 11 반영 ----

describe("code-agent deliver", () => {
  test("추적표는 R → AC → 파일 → TC → 검증을 코드가 이어 붙인다", async () => {
    await toDeliver();
    const rows = traceRows(loadWork(repo)!, loadEvidence(repo, "ORD-1", "order"));
    const first = rows.find((row) => row.requirement === "R1")!;
    assert.deepEqual(first.acceptance, ["AC-R1-1"]);
    assert.deepEqual(first.cases, ["TC-1"]);
    assert.ok(first.files.includes(`${ORDER}/domain/Order.java`));
    assert.deepEqual(first.verified, ["TC-1: passed (출력)"]);
  });

  test("TTY 가 아니면 커밋하지 않는다 — 게이트를 다 지나도 마지막 문이 닫혀 있다", async () => {
    await toDeliver();
    writePr();
    assert.throws(() => deliver(requireValidatable(repo, "deliver")), /터미널에서 받습니다/);
    // 확인 화면을 그리기 전에 코드 구역은 렌더된다
    const doc = readFileSync(join(repo, prDocFile("ORD-1")), "utf-8");
    assert.match(doc, /<!-- code-agent:trace:start -->/);
    assert.match(doc, /\| R1 \| AC-R1-1 \|/);
    assert.match(doc, /## 변경 요약/);
    assert.equal(git("log", "-1", "--format=%s"), "init");
  });

  test("코드 구역을 손으로 고치면 다시 렌더해 덮는다", async () => {
    await toDeliver();
    writePr();
    assert.throws(() => deliver(requireValidatable(repo, "deliver")), /터미널/);
    const path = join(repo, prDocFile("ORD-1"));
    writeFileSync(
      path,
      readFileSync(path, "utf-8").replace(/\| R1 \|[^\n]*\|/, "| R1 | 전부 통과 | 전부 통과 | 전부 통과 | 전부 통과 |"),
    );
    assert.throws(() => deliver(requireValidatable(repo, "deliver")), /터미널/);
    assert.match(readFileSync(path, "utf-8"), /\| R1 \| AC-R1-1 \|/);
  });

  test("모델 구역이 비었거나 추적표에 빈 칸이 있으면 커밋하지 않는다", async () => {
    await toDeliver();
    const empty = deliverProblems(loadWork(repo)!, "# 빈 문서\n");
    for (const heading of ["요약", "확인 방법", "위험·되돌리기"]) {
      assert.ok(empty.some((problem) => problem.includes(`## ${heading}`)), heading);
    }

    // AC 가 없는 요구 항목을 넣으면 추적표에 빈 칸이 생긴다
    write("doc/work/ORD-1/01-requirements.md", `${REQUIREMENTS}\n\n## R3 · 주문 취소\n근거: "주문을 조회한다."\n`);
    assert.ok(deliverProblems(loadWork(repo)!, "# x").some((problem) => /추적표의 R3 이 비어 있습니다/.test(problem)));
  });

  test("검증되지 않은 트리에서는 반영이 열리지 않는다", async () => {
    await toDeliver();
    writePr();
    write(`${ORDER}/domain/Order.java`, "class Order { /* 반영 직전 */ }\n");
    assert.throws(
      () => deliver(requireValidatable(repo, "deliver")),
      (error: Error) => error instanceof Stop && /반영할 수 없습니다/.test(error.message),
    );
  });

  test("검증된 변경 집합만 커밋한다 — 같은 트리의 무관한 파일은 들어가지 않는다", async () => {
    await toDeliver();
    writePr();
    assert.throws(() => deliver(requireValidatable(repo, "deliver")), /터미널/);

    write("unrelated.txt", "이 작업과 상관없는 파일\n");
    const commit = commitDelivery(loadWork(repo)!, loadEvidence(repo, "ORD-1", "order")!, []);
    const files = git("show", "--name-only", "--format=", commit).split("\n").map((line) => line.trim()).filter(Boolean);
    assert.ok(files.includes(`${ORDER}/domain/Order.java`));
    assert.ok(files.includes(validationDocFile("ORD-1")));
    assert.ok(files.includes(reviewDocFile("ORD-1")));
    assert.ok(files.includes(prDocFile("ORD-1")));
    assert.ok(files.includes(".code-agent/work/ORD-1/order.verify.json"));
    assert.ok(files.includes(".code-agent/work/ORD-1/order.review.json"));
    assert.equal(files.includes("unrelated.txt"), false);
    const message = git("log", "-1", "--format=%B");
    assert.match(message, /^\[ORD-1\] 주문 도메인 추가/);
    assert.match(message, /요구: R1, R2/);
  });

  test("next 는 반영을 끝내지 않는다 — 사람의 자리로 넘긴다", async () => {
    await toDeliver();
    assert.throws(() => next(repo), /code-agent deliver/);
    assert.ok(existsSync(join(repo, ".code-agent/active.json")));
  });
});

// ---- 공통 KNOWLEDGE ----

describe("KNOWLEDGE 갱신 제안", () => {
  test("이번 작업의 R 을 근거로 들지 않은 항목은 적용 후보가 아니다", () => {
    const { entries, skipped } = parseProposal(
      [
        "## data-dictionary",
        "### `ORDER` 주문",
        "- 근거: R1",
        "- id: Long",
        "",
        "### `PAYMENT` 결제",
        "- 다른 작업에서 본 것",
        "",
        "## 없는-종류",
        "### `X` x",
        "- R1",
      ].join("\n"),
      ["R1", "R2"],
    );
    assert.deepEqual(entries.map((entry) => entry.key), ["ORDER"]);
    assert.deepEqual(entries[0].requirements, ["R1"]);
    assert.ok(skipped.some((reason) => /PAYMENT/.test(reason)));
    assert.ok(skipped.some((reason) => /없는-종류/.test(reason)));
  });

  test("같은 키는 그 자리에서 갈아 끼우고, 다른 항목은 지우지 않는다", () => {
    const before = ["# 데이터 사전", "", "### `ORDER` 주문", "- id: Long", "", "### `ITEM` 항목", "- 그대로", ""].join("\n");
    const { entries } = parseProposal("## data-dictionary\n### `ORDER` 주문\n- 근거: R1\n- id: UUID\n", ["R1"]);
    const after = applyEntry(before, entries[0]);
    assert.match(after, /### `ORDER` 주문\n- 근거: R1\n- id: UUID/);
    assert.equal(after.includes("- id: Long"), false);
    assert.match(after, /### `ITEM` 항목\n- 그대로/);
  });

  test("새 키는 끝에 붙는다", () => {
    const { entries } = parseProposal("## api-catalog\n### `GET:/api/orders` 조회\n- 근거: R2\n", ["R2"]);
    const after = applyEntry("# API 목록\n", entries[0]);
    assert.match(after, /# API 목록\n\n### `GET:\/api\/orders` 조회/);
  });
});

// ---- 강제 ----

describe("hook · Stop hook · context — 새 스테이지", () => {
  test("모델은 review·integrate 를 부를 수 있고 deliver 는 부를 수 없다", async () => {
    await toReview();
    assert.equal(hook("Bash", { command: "code-agent review" }), undefined);
    assert.equal(hook("Bash", { command: "code-agent integrate" }), undefined);
    assert.match(hook("Bash", { command: "code-agent deliver" }) ?? "", /현재 세션의 ca-answer 동의 절차/);
  });

  test("Stop hook 은 implement 에서도 계획 밖 변경을 보고, deliver 에서는 끼어들지 않는다", async () => {
    await toDeliver();
    write("anywhere.txt", "도구를 거치지 않고 생긴 파일\n");
    assert.equal(decideStop({ cwd: repo }), undefined, "deliver 는 code-agent deliver 가 절대적으로 막는 자리다");

    saveActive(repo, { ...loadActive(repo)!, phase: "implement", stage: "entity" });
    assert.match(decideStop({ cwd: repo }) ?? "", /계획 밖의 변경이 남아 있습니다/);
  });

  test("context 가 리뷰·반영에서 무엇을 쓰는지 알려 준다", async () => {
    await toReview();
    assert.match(context(repo), /범위는 코드가 계획과 대조해 정합니다/);

    openRound(requireValidatable(repo, "review"));
    writeFindings();
    next(repo);
    await integrate(requireValidatable(repo, "integrate"));
    next(repo);
    const out = context(repo);
    assert.ok(out.includes(prDocFile("ORD-1")));
    assert.ok(out.includes(proposalFile("ORD-1")));
    assert.match(out, /push · MR\/PR 생성은 하지 않습니다/);
  });
});

// ---- 수정 루프의 입구 ----

describe("code-agent check 는 검증 스테이지를 되감는다", () => {
  test("test 에서 실패하고 고친 뒤 공개 명령만으로 한 바퀴를 돈다", async () => {
    useManifest({ test: FAIL_UNTIL_FIXED });
    toCheck();

    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.throws(() => next(repo), /test: failed/);

    // 계획 안 파일을 고친다 — 여기까지는 늘 되던 것이고, 막혔던 것은 그다음이다
    assert.equal(writeFileHook(`${ORDER}/domain/Order.java`), undefined);
    write(`${ORDER}/domain/Order.java`, "class Order { /* fixed */ }\n");

    // 스킬이 시키는 "code-agent check 부터 다시" — 커서를 손대는 내부 함수는 쓰지 않는다
    await check(requireValidatable(repo, "check"));
    assert.equal(loadActive(repo)!.phase, "check");
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 2);
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    next(repo);
    assert.equal(loadActive(repo)!.phase, "review");

    openRound(requireValidatable(repo, "review"));
    writeFindings();
    next(repo);
    assert.equal(loadActive(repo)!.phase, "integrate");
  });

  test("review · integrate 에서도 같은 자리로 되감고, deliver 는 되감지 않는다", async () => {
    await toDeliver();
    assert.throws(
      () => requireValidatable(repo, "check"),
      (error: Error) => error instanceof Stop && /지금: deliver/.test(error.message),
    );
    assert.equal(loadActive(repo)!.phase, "deliver");

    saveActive(repo, { ...loadActive(repo)!, phase: "integrate" });
    requireValidatable(repo, "check");
    assert.equal(loadActive(repo)!.phase, "check");
  });
});

// ---- 테스트 동결의 탈출구 ----

describe("동결을 푸는 지적은 열린 회차에 묶인다", () => {
  test("회차가 열리기 전에 제가 적어 둔 지적은 풀지 못한다 (test 스테이지)", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);

    // ⑨ 는 작업 폴더 안이라 쓰는 것 자체는 막지 않는다 — 막는 것은 그것이 열쇠가 되는 일이다
    assert.equal(writeFileHook(reviewDocFile("ORD-1")), undefined);
    forgeReviewDoc(`| F1 | ${TEST_FILE} | 계획 안 | 열림 | 단언이 틀렸다 |`);
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);
    assert.equal(loadReview(repo, "ORD-1", "order"), undefined, "회차가 없는데 기록이 생기지 않는다");
  });

  test("review 스테이지라도 회차를 열기 전에는 풀지 못한다", async () => {
    await toReview();
    forgeReviewDoc(`| F1 | ${TEST_FILE} | 계획 안 | 열림 | 단언이 틀렸다 |`);
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);
  });

  test("푼 사실은 코드가 회차 기록에 남기고, 그 줄은 지울 수 없다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings(`| F1 | ${TEST_FILE} | 계획 안 | 열림 | 단언이 기대 결과를 확인하지 않는다 |`);
    assert.equal(writeFileHook(TEST_FILE), undefined);
    assert.deepEqual(loadReview(repo, "ORD-1", "order")!.used, [{ id: "F1", path: TEST_FILE, round: 1 }]);

    // 쓰고 나서 줄을 지우면 커밋된 ⑨ 에 아무 흔적도 남지 않는다 — 게이트가 그것을 기억한다
    const path = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(path, readFileSync(path, "utf-8").replace(/^\| F1 .*$/m, "- 없음"));
    assert.throws(() => next(repo), /F1 이 표에 없습니다/);
  });

  test("상태 칸은 글자 그대로 본다 — 미해결 은 해결이 아니다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings(`| F1 | ${TEST_FILE} | 계획 안 | 미해결 | 단언이 틀렸다 |`);
    assert.throws(() => next(repo), /열린 지적: F1/);
    assert.throws(() => next(repo), /상태 칸은 열림 · 해결 둘뿐입니다/);
    // 열쇠로도 쓰이지 않는다 — 여는 쪽과 닫는 쪽이 같은 규칙을 딛는다
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/, "유효하지 않은 상태는 동결을 풀지 않는다");

    const path = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(path, readFileSync(path, "utf-8").replace("| 미해결 |", "| 해결 안 됨 |"));
    assert.throws(() => next(repo), /열린 지적: F1/);
  });
});

describe("⑨ 의 지적 절", () => {
  test("`없음` 은 `## 지적` 절 안에서만 인정한다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    const path = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(path, `${readFileSync(path, "utf-8").replace("## 지적", "## 잡담")}\n- 없음\n`);
    assert.throws(() => next(repo), /`## 지적` 절이 없습니다/);
  });

  test("회차 구역 표시가 둘이면 거부한다 — 둘째 짝이 위조본을 실어 나른다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings();
    const path = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(
      path,
      `${readFileSync(path, "utf-8")}\n<!-- code-agent:review:start -->\n## 회차\n\n| 회차 | 시각 | 기준 트리 해시 (계획 파일) |\n|---|---|---|\n| 9 | 2026-09-29T00:00:00.000Z | sha256:deadbeefdeadbeef |\n<!-- code-agent:review:end -->\n`,
    );
    assert.throws(() => next(repo), /회차 구역이 기록과 다릅니다/);
  });
});

// ---- ⑩ 의 코드 구역 ----

describe("⑩ 의 추적표는 하나뿐이다", () => {
  test("표시 짝이 둘이면 하나로 합치고 위조본을 걷어 낸다", async () => {
    await toDeliver();
    writePr();
    assert.throws(() => deliver(requireValidatable(repo, "deliver")), /터미널/);

    const path = join(repo, prDocFile("ORD-1"));
    writeFileSync(
      path,
      `${readFileSync(path, "utf-8")}\n<!-- code-agent:trace:start -->\n## 추적표\n\n| R | AC | 계획 파일 | TC | 검증 |\n|---|---|---|---|---|\n| R9 | AC-R9-1 | 전부 통과 | TC-9 | TC-9: 출력 |\n<!-- code-agent:trace:end -->\n`,
    );
    assert.throws(() => deliver(requireValidatable(repo, "deliver")), /터미널/);

    const after = readFileSync(path, "utf-8");
    assert.equal(after.split("<!-- code-agent:trace:start -->").length - 1, 1, "짝은 하나만 남는다");
    assert.equal(after.includes("R9"), false, "위조된 줄은 커밋될 파일에 남지 않는다");
    assert.match(after, /\| R1 \| AC-R1-1 \|/);
  });

  test("표시 없이 쓴 추적표는 커밋을 세운다 — 재렌더가 덮지 못하고 아래에 덧붙는다", async () => {
    await toDeliver();
    write(
      prDocFile("ORD-1"),
      [
        "# ORD-1 변경 보고서",
        "",
        "## 요약", "주문 도메인을 더했다.",
        "", "## 확인 방법", "OrderRepository 를 부른다.",
        "", "## 위험·되돌리기", "없음.",
        "",
        "## 추적표",
        "",
        "| R | AC | 계획 파일 | TC | 검증 |",
        "|---|---|---|---|---|",
        "| R1 | 전부 통과 | 전부 통과 | 전부 통과 | 전부 통과 |",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => deliver(requireValidatable(repo, "deliver")),
      (error: Error) => error instanceof Stop && /`## 추적표` 이 코드 구역 밖에 있습니다/.test(error.message),
    );
    assert.equal(git("log", "-1", "--format=%s"), "init");
  });
});

// ---- 반영이 서는 자리 ----

describe("code-agent deliver — 커밋되는 자리", () => {
  test("작업 브랜치가 아니면 커밋하지 않는다", async () => {
    await toDeliver();
    writePr();
    git("switch", "-q", "-c", "elsewhere");
    assert.throws(
      () => deliver(requireValidatable(repo, "deliver")),
      (error: Error) => error instanceof Stop && /작업 브랜치가 아닙니다 \(지금 elsewhere/.test(error.message),
    );
  });

  test("커밋이 실패해 KNOWLEDGE 적용본만 남아도 다시 반영할 수 있다", async () => {
    await toDeliver();
    writePr();
    // deliver 가 사람이 고른 항목을 적용한 뒤 git commit 이 실패한 상태
    write("doc/knowledge/data-dictionary.md", "# 데이터 사전\n\n### `ORDER` 주문\n- 근거: R1\n- id: Long\n");

    const work = loadWork(repo)!;
    assert.equal(outsideChanges(work).some((change) => change.path.startsWith("doc/knowledge/")), false);
    assert.deepEqual(deliverProblems(work, readFileSync(join(repo, prDocFile("ORD-1")), "utf-8")), []);
  });
});

// ---- 계획 제출 ----

describe("계획은 제 검증기를 쓸 수 없다", () => {
  test("검증 명령이 이 계획이 쓰는 파일을 가리키면 제출하지 않는다", () => {
    useManifest({ build: ["node", TEST_FILE] });
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
    assert.throws(
      () => submitPlan(repo, join(repo, "doc/work/ORD-1/plan.json")),
      (error: Error) =>
        error instanceof Stop && /검증 명령이 이 계획이 쓰는 파일을 가리킵니다: .*OrderTest\.java/.test(error.message),
    );
  });
});

// ---- 재시작한 작업의 기준 커밋 ----

describe("이미 있는 작업 브랜치로 다시 시작할 때", () => {
  test("기준 브랜치의 지금 끝이 아니라 갈라진 자리를 굳힌다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    const first = loadActive(repo)!.baseCommit!;
    abort(repo);

    // 그 사이 기준 브랜치가 나아간다 — 내 작업과는 상관없는 커밋이다
    git("switch", "-q", "master");
    write("other.txt", "x\n");
    git("add", "other.txt");
    git("commit", "-qm", "move");
    git("switch", "-q", "feature/ORD-1");

    start(repo, join(repo, "doc/work/ORD-1.md"));
    const again = loadActive(repo)!.baseCommit!;
    assert.equal(again, first);
    assert.notEqual(again, git("rev-parse", "master"));
    // 끝을 굳혔으면 master 가 더한 파일이 전부 이 작업의 [D] 삭제로 잡힌다
    assert.equal(changedPaths(repo, again).some((change) => change.path === "other.txt"), false);
    assert.equal(changedPaths(repo, git("rev-parse", "master")).some((change) => change.path === "other.txt"), true);
  });
});

// ---- 코드 구역 ----

describe("코드 구역 표시는 한 짝뿐이다", () => {
  const S = "<!-- code-agent:t:start -->";
  const E = "<!-- code-agent:t:end -->";

  test("짝이 하나면 안쪽을 읽고, 둘이면 어느 쪽도 믿지 않는다", () => {
    assert.equal(readBlock(`앞\n${S}\n표\n${E}\n뒤`, "t"), "표");
    assert.equal(readBlock(`${S}\n진짜\n${E}\n${S}\n위조\n${E}`, "t"), undefined);
    // 짝을 못 이룬 표시가 하나 더 있는 것도 같다 — 어디까지가 코드가 쓴 것인지 알 수 없다
    assert.equal(readBlock(`${S}\n진짜\n${E}\n${S}`, "t"), undefined);
    assert.equal(readBlock("표시 없음", "t"), undefined);
  });

  test("덜어 낼 때도 갈아 끼울 때도 모든 짝을 본다", () => {
    assert.equal(stripBlock(`앞${S}a${E}가운데${S}b${E}뒤`, "t"), "앞가운데뒤");
    assert.equal(upsertBlock(`앞${S}a${E}가운데${S}b${E}뒤`, "t", "새것"), `앞${S}\n새것\n${E}가운데뒤`);
    assert.equal(upsertBlock("바깥만", "t", "새것"), `바깥만\n\n${S}\n새것\n${E}\n`);
    assert.equal(blockCount(`${S}a${E}${S}b${E}`, "t"), 2);
  });
});

// ---- 템플릿과 파서 ----

describe("설치되는 템플릿", () => {
  test("지적 표의 열은 코드가 읽는 순서 그대로다 — 문서와 파서가 갈리면 게이트가 영영 안 닫힌다", () => {
    init(repo);
    const header = "| id | 계획 파일 | 범위 | 상태 | 지적 |";
    // 리뷰 절차는 단계 스킬 `/ca-review` 하나가 들고 있다 — 사이클(`/ca-next`)은 그 파일을 읽으라고만 한다
    for (const path of [".claude/agents/ca-reviewer.md", ".claude/skills/ca-review/SKILL.md"]) {
      const text = readFileSync(join(repo, path), "utf-8");
      assert.ok(text.includes(header), `${path} 에 고정된 열 머리가 없습니다`);
      assert.equal(text.includes("고침"), false, `${path} 에 쓰이지 않는 상태값이 남아 있습니다`);
      assert.equal(text.includes("요구 충족"), false, `${path} 가 코드가 읽지 않는 절을 시킵니다`);
    }
  });

  test("init 이 스테이지마다 스킬 하나씩 + 사이클·보조 스킬을 설치한다", () => {
    const report = init(repo);
    const stages = ["request", "analyze", "impact", "design", "plan", "implement", "check", "test", "review", "integrate"];
    const skills = [...stages.map((stage) => `ca-${stage}`), "ca-next", "ca-feature", "ca-fix", "ca-refactor", "ca-answer", "ca-status", "ca-docs", "ca-adopt"];
    for (const skill of skills) {
      const text = readFileSync(join(repo, `.claude/skills/${skill}/SKILL.md`), "utf-8");
      assert.ok(text.includes(`name: ${skill}`), `${skill} 의 머리말 이름이 다릅니다`);
    }
    // 사이클은 단계 스킬의 절차를 **읽어서** 돈다 — 절차를 베껴 두면 둘이 갈린다
    const cycle = readFileSync(join(repo, ".claude/skills/ca-next/SKILL.md"), "utf-8");
    for (const stage of stages) {
      assert.ok(cycle.includes(`.claude/skills/ca-${stage}/SKILL.md`), `사이클이 ca-${stage} 의 절차를 가리키지 않습니다`);
    }
    assert.match(report, new RegExp(`스킬·에이전트 ${skills.length + 8}개`));
  });

  test("단계 스킬이 그 칸을 여는 명령을 빠뜨리지 않는다 — 없으면 모델은 게이트에 부딪혀서야 안다", () => {
    init(repo);
    // 회차를 여는 것은 `code-agent review` 이고 **첫 절차**여야 한다 — 뒤에만 있으면 모델은 next 가
    // "리뷰 회차가 없습니다" 로 막고서야 그 명령을 찾는다
    const review = readFileSync(join(repo, ".claude/skills/ca-review/SKILL.md"), "utf-8");
    const firstStep = review.split("\n").find((line) => line.startsWith("1. "));
    assert.match(firstStep ?? "", /code-agent review/, "ca-review 의 첫 절차가 회차를 열지 않습니다");
    // 승인은 커서를 옮기지 않는다 — 승인된 계획 위에서 갈래가 없으면 사이클이 plan 에서 계획을 다시 쓰며 돈다
    const plan = readFileSync(join(repo, ".claude/skills/ca-plan/SKILL.md"), "utf-8");
    assert.match(plan, /승인이 `approved`\s*면[\s\S]*code-agent next/, "승인된 계획은 다시 쓰지 않고 다음 단계로 이동해야 합니다");
  });
});

// ---- 단계별 명령과 되감기 ----

describe("스테이지 명령", () => {
  test("문서 칸의 `다음:` 이 지금 칸을 도는 스킬을 이름으로 부른다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    assert.match(status(repo), /다음: \/ca-analyze \(또는 \/ca-next 로 사이클\)/);

    write("doc/work/ORD-1/01-requirements.md", REQUIREMENTS);
    next(repo);
    assert.match(status(repo), /다음: \/ca-impact \(또는 \/ca-next 로 사이클\)/);

    write("doc/work/ORD-1/02-analysis.md", IMPACT);
    next(repo);
    assert.match(status(repo), /다음: \/ca-design \(또는 \/ca-next 로 사이클\)/);

    write("doc/work/ORD-1/03-design.md", DESIGN);
    write("doc/work/ORD-1/04-functional.md", FUNCTIONAL);
    next(repo);
    assert.match(status(repo), /다음: \/ca-plan \(또는 \/ca-next 로 사이클\)/);

    write("doc/work/ORD-1/07-test-spec.md", TEST_SPEC);
    write("doc/work/ORD-1/plan.json", JSON.stringify(PLAN));
    submitPlan(repo, join(repo, "doc/work/ORD-1/plan.json"));
    // 승인 대기는 사람의 자리라 스킬을 부르지 않는다
    assert.match(status(repo), /다음: 현재 Claude 세션[\s\S]*plan 동의 절차/);
    approve();
    assert.match(status(repo), /승인됨 — code-agent next 로 넘긴 뒤 \/ca-implement/);
    next(repo);
    assert.match(status(repo), /다음: \/ca-implement \(또는 \/ca-next 로 사이클\)/);
  });

  test("검증 칸도 제 스킬을 부르고 deliver는 같은 세션의 확인으로 이어진다", async () => {
    toCheck();
    assert.match(status(repo), /다음: \/ca-check \(또는 \/ca-next 로 사이클\)/);

    await check(requireValidatable(repo, "check"));
    assert.match(status(repo), /검증 통과 — code-agent next 로 넘긴 뒤 \/ca-test/);
    next(repo);
    assert.match(status(repo), /다음: \/ca-test \(또는 \/ca-next 로 사이클\)/);

    await runTests(requireValidatable(repo, "test"));
    next(repo);
    assert.match(status(repo), /다음: \/ca-review \(또는 \/ca-next 로 사이클\)/);

    openRound(requireValidatable(repo, "review"));
    writeFindings();
    next(repo);
    assert.match(status(repo), /다음: \/ca-integrate \(또는 \/ca-next 로 사이클\)/);

    await integrate(requireValidatable(repo, "integrate"));
    next(repo);
    assert.match(status(repo), /다음: 현재 Claude 세션[\s\S]*deliver 동의 절차/);
  });
});

describe("code-agent back", () => {
  test("앞으로도 제자리로도 가지 않고, 진행 중인 작업이 없으면 아무것도 하지 않는다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    assert.throws(() => back(repo, "impact"), (error: Error) => error instanceof Stop && /뒤로만 갑니다/.test(error.message));
    assert.throws(() => back(repo, "analysis"), /뒤로만 갑니다/);
    assert.equal(loadActive(repo)!.phase, "analysis");
    // deliver 는 마지막 칸이라 되감아 갈 자리가 아니고, 없는 이름은 받지 않는다
    assert.throws(() => back(repo, "deliver"), /되감을 수 없는 스테이지/);
    assert.throws(() => back(repo, "verify"), /되감을 수 없는 스테이지/);
    assert.throws(() => back(repo, ""), /되감을 수 없는 스테이지/);

    abort(repo);
    assert.throws(() => back(repo, "analysis"), /진행 중인 작업이 없습니다/);
  });

  test("deliver 에서는 되감지 않는다 — 사람이 확인 화면 앞에 서 있는 자리다", async () => {
    await toDeliver();
    // REWINDABLE 이 code-agent check 에 대해 닫아 둔 것과 같은 자리다 — 모델이 커서를 빼면 사람이 보던 화면이 무효가 된다
    assert.throws(
      () => back(repo, "check"),
      (error: Error) => error instanceof Stop && /사용자가 내용을 확인하는 단계/.test(error.message),
    );
    assert.equal(loadActive(repo)!.phase, "deliver");
  });

  test("design 으로 되감아 03 을 고치면 승인이 무효가 되고 코드 쓰기가 막힌다", () => {
    toCheck();
    // 이 파일의 approve() 는 문서 해시를 묶지 않는다 — 문서 묶임을 보는 자리라 실제 decide() 와 같게 다시 남긴다
    const work = loadWork(repo)!;
    recordDecision(repo, {
      order: work.order,
      target: work.active.target,
      plan: work.plan!,
      manifest: work.manifest,
      decision: "approved",
      approver: "test",
      presence: { channel: "tty", verified: true, detail: "테스트" },
      docsHash: approvalDocsHash(work),
    });
    assert.equal(approvalOf(loadWork(repo)!).status, "approved");

    const printed = back(repo, "design");
    assert.equal(loadActive(repo)!.phase, "design");
    assert.match(printed, /승인이 무효가 됩니다\(stale-docs\)/);

    write("doc/work/ORD-1/03-design.md", `${DESIGN}\n- 정렬은 최신순\n`);
    assert.equal(approvalOf(loadWork(repo)!).status, "stale-docs");
    // 이 칸에서는 hook 이 작업 폴더 밖 쓰기를 통째로 막는다 — 코드는 승인 뒤 implement 에서만 쓴다
    assert.match(writeFileHook(`${ORDER}/domain/Order.java`) ?? "", /design 스테이지라/);
    // 되감았다고 승인이 되살아나지 않는다 — 다시 앞으로 와도 게이트가 같은 자리에서 막는다
    next(repo);
    assert.equal(loadActive(repo)!.phase, "plan");
    assert.throws(() => next(repo), /승인되지 않았습니다 \(stale-docs\)/);
  });

  test("되감아도 고쳐 쓰기 회차는 줄지 않는다 — 증거는 planHash 에 묶여 있다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 1);

    back(repo, "implement");
    // implement 로 되감으면 계획의 첫 단계부터 — 단계 키가 비면 hook 이 지금 단계를 못 찾는다
    assert.equal(loadActive(repo)!.stage, "entity");
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 1, "되감기는 증거를 지우지 않는다");

    next(repo);
    next(repo);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "check");
    await check(requireValidatable(repo, "check"));
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 2, "되감기로 한도를 다시 벌 수는 없다");
  });

  test("plan 으로 되감아 같은 계획을 다시 제출하면 승인은 그대로다", () => {
    toCheck();
    back(repo, "plan");
    assert.equal(loadActive(repo)!.phase, "plan");

    submitPlan(repo, join(repo, "doc/work/ORD-1/plan.json"));
    assert.equal(approvalOf(loadWork(repo)!).status, "approved", "같은 문서 위의 같은 계획은 해시가 같다");
    next(repo);
    assert.equal(loadActive(repo)!.phase, "implement");
  });
});
