import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { hashManifest, recordDecision } from "../core/approval";
import { loadManifest } from "../core/manifest";
import { back, context, next, requireReproable, requireValidatable, Stop, submitPlan } from "../agent/commands";
import { start } from "./confirmedStart";
import { commitDelivery, prDocFile } from "../agent/deliver";
import { checkProjectDocs, recordDocConfirmation } from "../agent/docs";
import {
  checkCommands,
  integrateCommands,
  loadEvidence,
  saveEvidence,
  prepareCommand,
  runsOf,
  stageProblems,
  testCommands,
  testStageFiles,
  validationDocFile,
} from "../agent/evidence";
import { decide } from "../agent/hook";
import { loadActive } from "../agent/layout";
import { openRound, reviewDocFile } from "../agent/review";
import { recordReviewFixture } from "./reviewFixture";
import { manifestCheck, survey } from "../agent/survey";
import { partialTreeHash } from "../agent/tree";
import { check, integrate, repro, runTests } from "../agent/validate";
import { approvalDocsHash, loadManifestIfAny, loadWork } from "../agent/work";
import { analysisProblems } from "../agent/workDocs";

/**
 * P6 — fix 의 재현 먼저 · refactor 의 동작 보존 · 종류별 단계 · 빈 저장소 ·
 * deliver 커밋 범위 · integrate 의 prepare.
 *
 * P5 와 같은 방식이다: 임시 git 저장소에 실제 함수를 그대로 부르고, 검증 명령은 node 한 줄짜리
 * 스크립트라 통과·실패·없는 실행 파일을 이 머신에서 재현할 수 있다.
 */

const PASS = ["node", "-e", "process.exit(0)"];
const FAIL = ["node", "-e", "process.exit(4)"];
const NOT_INSTALLED = ["code-agent-does-not-exist-on-this-machine"];

const SRC = "src/main/app/order.js";
const REPRO_TEST = "src/test/order.test.js";
const KEPT_TEST = "src/test/existing.test.js";

/** 고치기 전에는 실패하고 고친 뒤에는 통과한다 — 재현과 수정 확인을 한 스크립트로 */
const FAIL_UNTIL_FIXED = [
  "node",
  "-e",
  `const fixed=require('fs').readFileSync('${SRC}','utf-8').includes('fixed');console.log((fixed?'ok':'not ok')+' 1 - TC-1'); process.exit(fixed ? 0 : 3)`,
];
/** 같은 판정인데 TC id 를 찍지 않는다 — 출력 갈래가 비는 경우 */
const SILENT_FAIL = [
  "node",
  "-e",
  `process.exit(require('fs').readFileSync('${SRC}','utf-8').includes('fixed') ? 0 : 3)`,
];

// ---- 공통 POLICY 문서 ----

const ARCH = [
  "# 아키텍처",
  "## 기술 스택", "Node.js",
  "## 모듈/패키지 구조", "src/main/app/<파일>.js",
  "## 계층과 책임", "- app: 애플리케이션 코드",
  "## 의존 방향", "test → app",
  "## 공통 모듈", "없음",
  "## 주요 결정", "- 식별자: 문자열",
].join("\n");

const CONV = [
  "# 코드 컨벤션",
  "## 명명", "- 파일은 소문자",
  "## 계층별 규칙", "- app 은 순수 함수로",
  "## 예외 처리", "- Error 를 던진다",
  "## 테스트 규칙", "- 테스트 이름·주석에 TC id 를 남긴다",
].join("\n");

const STRATEGY = ["# 테스트 전략", "## 수준과 범위", "- Unit: 필수", "## 도구와 실행 명령", "- `test`: 전체 테스트", "## 통과 기준", "- AC 마다 1케이스"].join("\n");
/** 테스트 자리에서 두 명령이 도는 전략 문서 — 하나는 통과하고 하나는 실패하는 경우를 만든다 */
const STRATEGY_TWO = ["# 테스트 전략", "## 수준과 범위", "- Unit: 필수", "## 도구와 실행 명령", "- `test`: 전체 테스트", "- `smoke`: 연기 테스트", "## 통과 기준", "- AC 마다 1케이스"].join("\n");
/** 매니페스트에 test 선언이 없을 때 쓰는 전략 문서 — 문서가 없는 명령 이름을 부르면 확정 게이트가 먼저 막는다 */
const STRATEGY_NO_TEST =["# 테스트 전략", "## 수준과 범위", "- Unit: 필수", "## 도구와 실행 명령", "- 없음 — 아직 자동 실행 명령이 없다", "## 통과 기준", "- AC 마다 1케이스"].join("\n");
const QUALITY = ["# 품질·보안 기준", "## 정적 분석", "- `build`: 컴파일", "## 보안 검사", "- 없음 — 리뷰에서 본다", "## 통과 기준과 반영 차단", "- 컴파일 실패는 반영을 막는다"].join("\n");
/** 문서가 `prepare` 를 명령 이름으로 적은 경우 — 작업 트리에서 준비 명령이 풀리면 안 된다 */
const STRATEGY_PREPARE = ["# 테스트 전략", "## 수준과 범위", "- Unit: 필수", "## 도구와 실행 명령", "- `test`: 전체 테스트", "- `prepare`: 의존성", "## 통과 기준", "- AC 마다 1케이스"].join("\n");
const QUALITY_PREPARE = ["# 품질·보안 기준", "## 정적 분석", "- `build`: 컴파일", "- `prepare`: 의존성", "## 보안 검사", "- 없음 — 리뷰에서 본다", "## 통과 기준과 반영 차단", "- 컴파일 실패는 반영을 막는다"].join("\n");

// ---- 저장소 헬퍼 ----

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
  for (const entry of checkProjectDocs(repo, loadManifestIfAny(repo))) {
    recordDocConfirmation(repo, entry, "test", { channel: "tty", verified: true, detail: "테스트" });
  }
}

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

function newRepo(prefix: string): void {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
  git("config", "user.name", "t");
  git("config", "user.email", "t@t");
  write("doc/architecture.md", ARCH);
  write("doc/conventions.md", CONV);
  write("doc/test-strategy.md", STRATEGY);
  write("doc/quality.md", QUALITY);
  write(".gitignore", "build/\n");
}

function dropRepo(): void {
  rmSync(repo, { recursive: true, force: true });
}

/** 두 단계(코드·테스트)짜리 매니페스트 — 종류는 셋 다 돈다 */
function manifest(overrides: Record<string, unknown> = {}): string {
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

const FIX_ORDER = [
  "---", "kind: fix", "id: FIX-1", "title: 총액이 0 으로 나온다",
  `target: ${SRC}`, "scope: [src/main, src/test]", "preserve: [주문 조회 API 시그니처]",
  "---", "", "총액이 0 으로 나온다.", "",
].join("\n");

const FIX_REQ = [
  "# FIX-1 요구사항 정의",
  "## R1 · 총액이 항목 합계로 나와야 한다", "근거: \"총액이 0 으로 나온다.\"", "- 기존 코드: 고친다",
  "## 가정", "- 없음",
].join("\n");

/** ② 의 `기존 시스템 분석` 만 갈아 끼운다 — fix·refactor 의 새 규칙이 거기 걸린다 */
function analysisDoc(current: string): string {
  return [
    "# 영향도 분석",
    "## 기존 시스템 분석", current,
    "## 영향 범위", "| R 번호 | 닿는 파일/모듈 | 부르는 곳 | 파급 |", "|---|---|---|---|",
    `| R1 | ${SRC} | 없음 | 없음 — 한 함수 |`,
    "## Risk", "- 없음 — 한 함수다",
  ].join("\n");
}

const CURRENT_OK = `- ${SRC}:3 의 total 이 항목을 더하지 않고 0 을 돌려준다`;
const CURRENT_NA = "- 해당 없음 — 새로 만드는 코드다";
const CURRENT_NO_REF = "- total 이 항목을 더하지 않는다";

const FIX_DESIGN = [
  "# 기술 설계", "## 구성 요소", "- order.total", "## 처리 흐름", "- 항목을 더해 돌려준다",
  "## API", "해당 없음 — 접점을 안 건드린다", "## 데이터", "해당 없음 — 저장 구조를 안 건드린다",
  "## 설계 결정", "- reduce 로 더한다",
].join("\n");

const FIX_FUNC = [
  "# 기능 명세", "## 기능 정의", "- R1: 총액을 돌려준다", "## 업무 규칙", "- 없음 — 규칙 변경 없음",
  "## 예외", "- 없음 — 항목이 없으면 0 이다",
  "## 수락 기준", "- AC-R1-1: 항목 두 개를 담으면 합계가 나온다",
].join("\n");

/** ⑦ — `## 재현` 절의 내용만 갈아 끼운다 */
function specDoc(repro: string | null = "- TC-1"): string {
  return [
    "# 테스트 명세", "## 테스트 케이스",
    "| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |", "|---|---|---|---|---|",
    "| TC-1 | Unit | AC-R1-1 | 항목 두 개를 담고 총액을 읽는다 | 합계가 나온다 |",
    ...(repro === null ? [] : ["## 재현", repro]),
  ].join("\n");
}

const FIX_PLAN = {
  files: [
    { stage: "test", path: REPRO_TEST, purpose: "재현 테스트", requirements: ["R1"] },
    { stage: "code", path: SRC, purpose: "총액을 고친다", requirements: ["R1"] },
  ],
  preserve: [{ item: "주문 조회 API 시그니처", how: "함수 이름과 인자를 그대로 둔다" }],
  sequence: [{ step: "test", why: "재현이 먼저다" }, { step: "code", why: "재현을 본 뒤 고친다" }],
  approach: "재현 테스트를 먼저 쓰고 total 을 고친다",
  conventions: [], conflicts: [], openQuestions: [], reasoning: "재현 먼저",
};

describe("P6 · fix — 재현 먼저", () => {
  beforeEach(() => {
    newRepo("ca-p6-fix-");
    write("code-agent.json", manifest());
    write(SRC, "function total(items) {\n  // 버그: 더하지 않는다\n  return 0;\n}\nmodule.exports = { total };\n");
    write(KEPT_TEST, "// 기존 테스트\n");
    write("doc/work/FIX-1.md", FIX_ORDER);
    confirmDocs();
    git("add", "-A");
    git("commit", "-qm", "init");
  });
  afterEach(dropRepo);

  /** 매니페스트를 바꿔 끼운다 — 시작 **전에** 부른다 (뒤에 바꾸면 승인이 stale 이 된다) */
  function useManifest(overrides: Record<string, unknown>, strategy = STRATEGY): void {
    write("code-agent.json", manifest(overrides));
    write("doc/test-strategy.md", strategy);
    confirmDocs();
    git("add", "-A");
    git("commit", "-qm", "manifest");
  }

  function writeDocs(current = CURRENT_OK, repro: string | null = "- TC-1"): void {
    write("doc/work/FIX-1/01-requirements.md", FIX_REQ);
    write("doc/work/FIX-1/02-analysis.md", analysisDoc(current));
    write("doc/work/FIX-1/03-design.md", FIX_DESIGN);
    write("doc/work/FIX-1/04-functional.md", FIX_FUNC);
    write("doc/work/FIX-1/07-test-spec.md", specDoc(repro));
  }

  function submit(plan: unknown = FIX_PLAN): string {
    write("doc/work/FIX-1/plan.json", JSON.stringify(plan));
    return submitPlan(repo, join(repo, "doc/work/FIX-1/plan.json"));
  }

  /** 계획 승인까지 마치고 implement 스테이지에 세운다 */
  function toImplement(plan: unknown = FIX_PLAN): void {
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs();
    next(repo);
    next(repo);
    next(repo);
    submit(plan);
    approve();
    next(repo);
  }

  function writeReproTest(body = "// TC-1 재현\n"): void {
    write(REPRO_TEST, body);
  }

  function fixSource(): void {
    write(SRC, "function total(items) {\n  // fixed\n  return items.reduce((a, b) => a + b, 0);\n}\nmodule.exports = { total };\n");
  }

  // ---- ② 기존 시스템 분석 ----

  test("1. ② 의 기존 시스템 분석이 '해당 없음' 이면 fix 가 막힌다 — feature 는 그대로 지난다", () => {
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs(CURRENT_NA);
    next(repo);
    assert.throws(
      () => next(repo),
      (error: Error) => error instanceof Stop && /'해당 없음' 으로 비울 수 없습니다/.test(error.message),
    );
    // 같은 문서를 feature 로 보면 지난다 — 새 규칙은 고치는 작업에만 걸린다
    assert.deepEqual(analysisProblems(repo, "FIX-1", ["R1"], "feature"), []);
  });

  test("1b. 다 쓴 분석에 '해당 없음 — <근거>' 한 줄이 섞여 있는 것은 비운 것이 아니다", () => {
    write("doc/work/FIX-1/02-analysis.md", analysisDoc([CURRENT_OK, "- 해당 없음 — 이 경로는 캐시를 타지 않는다"].join("\n")));
    assert.deepEqual(analysisProblems(repo, "FIX-1", ["R1"], "fix"), []);
    // 절의 내용이 그 한 줄뿐이면 비운 것이다
    write("doc/work/FIX-1/02-analysis.md", analysisDoc(CURRENT_NA));
    assert.ok(
      analysisProblems(repo, "FIX-1", ["R1"], "fix").some((problem) => /'해당 없음' 으로 비울 수 없습니다/.test(problem)),
    );
  });

  test("2. ② 에 근거 path:line 이 없으면 fix 가 막히고, 붙이면 지난다", () => {
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs(CURRENT_NO_REF);
    next(repo);
    assert.throws(() => next(repo), /근거 path:line 이 최소 하나/);
    write("doc/work/FIX-1/02-analysis.md", analysisDoc(CURRENT_OK));
    next(repo);
    assert.equal(loadActive(repo)!.phase, "design");
  });

  // ---- ⑦ 의 `## 재현` ----

  test("3. ⑦ 에 `## 재현` 이 없거나 표에 없는 TC 를 가리키면 fix 의 계획이 제출되지 않는다", () => {
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs(CURRENT_OK, null);
    next(repo);
    next(repo);
    next(repo);
    assert.throws(() => submit(), /`## 재현` 절에 결함을 재현하는 TC id/);

    write("doc/work/FIX-1/07-test-spec.md", specDoc("- TC-9"));
    assert.throws(() => submit(), /`## 재현` 이 표에 없는 TC 를 가리킵니다: TC-9/);

    write("doc/work/FIX-1/07-test-spec.md", specDoc("- TC-1"));
    assert.match(submit(), /계획을 제출/);
  });

  test("4. fix 의 sequence[0] 이 테스트 단계가 아니면 제출되지 않는다", () => {
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs();
    next(repo);
    next(repo);
    next(repo);
    assert.throws(
      () => submit({ ...FIX_PLAN, sequence: [{ step: "code", why: "먼저" }, { step: "test", why: "나중" }] }),
      /sequence\[0\] 이 테스트 단계가 아닙니다/,
    );
    // 테스트 단계 파일이 아예 없는 계획도 막힌다
    assert.throws(
      () => submit({ ...FIX_PLAN, files: [FIX_PLAN.files[1]], sequence: [{ step: "code", why: "하나뿐" }] }),
      /sequence\[0\] 이 테스트 단계가 아닙니다/,
    );
    assert.match(submit(), /계획을 제출/);
  });

  test("4b. 고칠 파일을 kind:\"test\" 단계에 적어 넣는 계획은 제출되지 않는다 — 이름표로 재현을 비껴가는 길", () => {
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs();
    next(repo);
    next(repo);
    next(repo);
    assert.throws(
      () =>
        submit({
          ...FIX_PLAN,
          files: [
            { stage: "test", path: SRC, purpose: "고칠 파일을 테스트 단계에 넣는다", requirements: ["R1"] },
            { stage: "code", path: "src/main/app/total.js", purpose: "도우미", requirements: ["R1"] },
          ],
        }),
      /계획이 kind:"test" 단계에 테스트 자리 밖의 파일을 넣었습니다: src\/main\/app\/order\.js/,
    );
  });

  test("4c. kind:\"test\" 단계가 자리를 밝히지 않으면 fix 의 계획을 세운다 — manifest check 도 경고한다", () => {
    // 테스트가 소스 옆에 있는 모양(scope:"domain", base 없음) — 무엇이 테스트 파일인지 잴 수 없다
    useManifest({
      stages: [
        { key: "code", title: "코드", template: "01-code.md", kinds: ["feature", "fix", "refactor"], scope: "project", outputDirs: ["src/main"] },
        { key: "test", title: "테스트", template: "02-test.md", kind: "test", kinds: ["feature", "fix", "refactor"], scope: "project", outputDirs: [] },
      ],
    });
    assert.match(manifestCheck(repo).text, /test 는 kind:"test" 인데 자리를 밝히지 않았습니다/);
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs();
    next(repo);
    next(repo);
    next(repo);
    assert.throws(() => submit(), /kind:"test" 단계\(test\)가 자리를 밝히지 않아 재현 테스트를 가려낼 수 없습니다/);
  });

  test("4d. plan 스테이지의 context 가 제출이 세우는 fix 규칙을 미리 말해 준다", () => {
    start(repo, join(repo, "doc/work/FIX-1.md"));
    writeDocs();
    next(repo);
    next(repo);
    next(repo);
    const text = context(repo);
    assert.match(text, /## fix — 재현이 먼저다/);
    assert.match(text, /`## 재현` 절/);
    assert.match(text, /sequence\[0\]\.step` 이 kind:"test" 단계의 key/);
    assert.match(text, /테스트 자리 안이어야 합니다: src\/test/);
  });

  test("5. fix 는 커서를 테스트 단계에 먼저 세운다 — 매니페스트 선언 순서와 무관하게", () => {
    toImplement();
    assert.equal(loadActive(repo)!.phase, "implement");
    assert.equal(loadActive(repo)!.stage, "test");
  });

  // ---- 재현 전후의 hook ----

  test("6. 재현 전에는 고칠 파일을 쓸 수 없고 테스트 파일은 쓸 수 있다", () => {
    toImplement();
    assert.match(writeFileHook(SRC)!, /재현을 먼저 봐야 이 파일을 고칠 수 있습니다/);
    assert.equal(writeFileHook(REPRO_TEST), undefined);
  });

  test("7. 비-test 계획 파일이 이미 바뀌어 있으면 repro 가 거부한다", async () => {
    toImplement();
    writeReproTest();
    fixSource();
    await assert.rejects(
      () => repro(requireReproable(repo)),
      (error: Error) => error instanceof Stop && /재현을 보기 전에 이미 바뀐 계획 파일이 있습니다/.test(error.message),
    );
  });

  test("8. 재현 TC 가 통과하면 재현이 아니다", async () => {
    useManifest({ test: PASS });
    toImplement();
    writeReproTest();
    await assert.rejects(() => repro(requireReproable(repo)), /재현하지 못했습니다/);
  });

  test("9. 테스트 명령이 없으면 not-run, 실행 파일이 없으면 error — 둘 다 재현이 아니다", async () => {
    useManifest({ test: undefined }, STRATEGY_NO_TEST);
    toImplement();
    writeReproTest();
    await assert.rejects(() => repro(requireReproable(repo)), /재현 명령이 돌지 못했습니다 \(test: not-run\)/);
  });

  test("9b. 실행 파일이 없으면 error 로 거부한다", async () => {
    useManifest({ test: NOT_INSTALLED });
    toImplement();
    writeReproTest();
    await assert.rejects(() => repro(requireReproable(repo)), /재현 명령이 돌지 못했습니다 \(test: error\)/);
  });

  test("10. 재현 TC id 가 실패한 실행의 출력에 없으면 거부한다 — 테스트 파일에 적혀 있어도", async () => {
    useManifest({ test: SILENT_FAIL });
    toImplement();
    // 파일에는 id 가 있다. 그래도 재현이 아니다 — 파일을 grep 한 것은 *무엇이 실패했는지* 말해 주지 않는다
    writeReproTest("// TC-1 재현\n");
    await assert.rejects(() => repro(requireReproable(repo)), /재현 TC 가 실패한 실행의 출력에 없습니다: TC-1/);
    assert.equal(loadEvidence(repo, "FIX-1", SRC)!.repro, undefined);
  });

  test("10b. 다른 TC 만 실패로 찍히면 재현이 아니다 — 무관한 빨간 스위트로 고칠 파일이 열리지 않는다", async () => {
    useManifest({ test: ["node", "-e", "console.log('TC-9 FAILED'); process.exit(1)"] });
    toImplement();
    writeReproTest("// TC-1 재현\n");
    await assert.rejects(() => repro(requireReproable(repo)), /재현 TC 가 실패한 실행의 출력에 없습니다: TC-1/);
    assert.match(writeFileHook(SRC)!, /재현을 먼저 봐야 이 파일을 고칠 수 있습니다/);
  });

  test("10c. 통과한 실행이 id 를 찍어도 재현이 아니다 — 실패한 실행의 출력만 본다", async () => {
    // smoke 는 TC-1 을 찍고 통과하고, test 는 id 없이 실패한다 — 출력을 통째로 합쳐 보면 지나가던 자리다
    useManifest({ test: SILENT_FAIL, commands: { smoke: ["node", "-e", "console.log('TC-1 ok')"] } }, STRATEGY_TWO);
    toImplement();
    writeReproTest("// 재현 테스트\n");
    await assert.rejects(() => repro(requireReproable(repo)), /재현 TC 가 실패한 실행의 출력에 없습니다: TC-1/);
  });

  test("10d. 같은 실행에서 재현 TC 통과 + 다른 TC 실패는 재현이 아니다", async () => {
    useManifest({ test: ["node", "-e", "console.log('ok 1 - TC-1\\nnot ok 2 - TC-9'); process.exit(1)"] });
    toImplement();
    writeReproTest();
    await assert.rejects(() => repro(requireReproable(repo)), /실제 실패 결과가 필요합니다/);
    assert.equal(loadEvidence(repo, "FIX-1", SRC)!.repro, undefined);
  });

  test("11. 재현을 보면 증거가 테스트 트리 해시에 묶여 0회차로 남는다", async () => {
    toImplement();
    writeReproTest();
    const out = await repro(requireReproable(repo));
    assert.match(out, /재현을 봤습니다/);

    const work = loadWork(repo)!;
    const evidence = loadEvidence(repo, "FIX-1", SRC)!;
    assert.equal(evidence.rounds, 0);
    assert.equal(evidence.runs[0].phase, "repro");
    assert.equal(evidence.runs[0].round, 0);
    assert.equal(evidence.runs[0].outcome, "failed");
    assert.deepEqual(evidence.repro!.cases, ["TC-1"]);
    assert.equal(evidence.repro!.testTreeHash, partialTreeHash(repo, testStageFiles(work)));
    assert.deepEqual(testStageFiles(work), [REPRO_TEST]);

    const validation = readFileSync(join(repo, validationDocFile("FIX-1")), "utf-8");
    assert.match(validation, /- 재현: TC-1 · 테스트 트리 sha256:/);
    // 0회차는 고쳐 쓰기가 아니다 — 수정 루프 절에 실리지 않는다
    assert.equal(/## 수정 루프/.test(validation), false);

    // 같은 트리에서 다시 부르면 다시 돌리지 않는다
    assert.match(await repro(requireReproable(repo)), /이미 재현을 봤습니다/);
  });

  test("12. 재현을 본 뒤에는 고칠 파일을 쓸 수 있다", async () => {
    toImplement();
    writeReproTest();
    await repro(requireReproable(repo));
    // 재현을 봤으므로 테스트 단계를 넘길 수 있다 — 그다음 단계가 고칠 파일의 자리다
    next(repo);
    assert.equal(loadActive(repo)!.stage, "code");
    assert.equal(writeFileHook(SRC), undefined);
  });

  test("12b. 실제 실패 상태 없는 구버전 재현 기록은 쓰기·검증·캐시 재사용을 열지 않는다", async () => {
    toImplement();
    writeReproTest();
    await repro(requireReproable(repo));
    const old = loadEvidence(repo, "FIX-1", SRC)!;
    delete old.repro!.found[0].status;
    saveEvidence(repo, old);
    assert.match(writeFileHook(SRC) ?? "", /실제 실패 결과가 없습니다/);
    assert.throws(() => next(repo), /실제 실패 결과가 없습니다/);
    assert.ok(stageProblems(loadWork(repo)!, "test").some((problem) => /실제 실패 결과가 없습니다/.test(problem)));
    const rerun = await repro(requireReproable(repo));
    assert.equal(rerun.includes("이미 재현을 봤습니다"), false);
    assert.equal(loadEvidence(repo, "FIX-1", SRC)!.repro!.found[0].status, "failed");
    next(repo);
    assert.equal(writeFileHook(SRC), undefined);
  });

  test("13. 재현을 본 뒤에는 테스트 파일이 언다 — check 를 돌기 전에도", async () => {
    toImplement();
    writeReproTest();
    await repro(requireReproable(repo));
    assert.match(writeFileHook(REPRO_TEST)!, /얼어 있는 파일입니다/);
  });

  test("14. 재현을 본 뒤 테스트 파일이 바뀌면 고칠 파일이 다시 잠긴다 (첫 check 전)", async () => {
    toImplement();
    writeReproTest();
    await repro(requireReproable(repo));
    // 동결을 우회해 직접 고친 것 — hook 이 아니라 파일시스템으로
    writeReproTest("// TC-1 재현 (고쳐 씀)\n");
    assert.match(writeFileHook(SRC)!, /재현을 본 뒤 테스트 파일이 바뀌었습니다/);
  });

  test("15. 첫 check 뒤에는 테스트 트리 대조가 내려간다 — 수정 루프가 교착되지 않는다 (C2)", async () => {
    toImplement();
    writeReproTest();
    await repro(requireReproable(repo));
    fixSource();
    next(repo);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "check");
    await check(requireValidatable(repo, "check"));

    // ⑨ 지적으로 동결을 풀어 재현 테스트를 고친 상황
    writeReproTest("// TC-1 재현 (리뷰 지적으로 고침)\n");
    assert.equal(writeFileHook(SRC), undefined);
  });

  test("16. 계획을 재승인하면 재현 증거가 함께 무효가 된다", async () => {
    toImplement();
    writeReproTest();
    await repro(requireReproable(repo));
    next(repo);
    assert.equal(writeFileHook(SRC), undefined);

    back(repo, "plan");
    submit({ ...FIX_PLAN, approach: "재현 테스트를 먼저 쓰고 total 을 reduce 로 고친다" });
    approve();
    next(repo);
    assert.match(writeFileHook(SRC)!, /재현을 본 기록이 없습니다/);
  });

  test("17. 완주 — 재현(실패) → 고침 → check → test(같은 TC 가 이제 통과) → 리뷰", async () => {
    toImplement();
    writeReproTest();
    await repro(requireReproable(repo));
    fixSource();
    next(repo);
    next(repo);
    await check(requireValidatable(repo, "check"));
    next(repo);
    const tested = await runTests(requireValidatable(repo, "test"));
    assert.match(tested, /test: passed/);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "review");

    const evidence = loadEvidence(repo, "FIX-1", SRC)!;
    assert.equal(runsOf(evidence, "repro")[0].outcome, "failed");
    assert.equal(runsOf(evidence, "test")[0].outcome, "passed");
    assert.ok(evidence.repro);
  });

  /** 리뷰까지 간 뒤 한 번 더 check → test → 리뷰를 돌아 통합 검증 앞에 세운다 */
  async function toIntegrateAgain(): Promise<void> {
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    next(repo);
    openRound(requireValidatable(repo, "review"));
    const path = join(repo, reviewDocFile("FIX-1"));
    writeFileSync(path, `${readFileSync(path, "utf-8")}\n- 없음\n`);
    recordReviewFixture(repo);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "integrate");
  }

  test("17b. 리뷰 후 테스트 보완은 기준 코드에서 격리 재현하고 수정 코드를 보존한 채 통합한다", async () => {
    useManifest({ test: ["node", "--test", "--test-reporter=tap"] });
    toImplement();
    const testBody = "const test=require('node:test'),assert=require('node:assert/strict'),{total}=require('../main/app/order');test('TC-1 sum',()=>assert.equal(total([2,3]),5));\n";
    writeReproTest(testBody);
    await repro(requireReproable(repo));
    fixSource();
    next(repo);
    next(repo);
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    next(repo);

    const fixed = readFileSync(join(repo, SRC), "utf8");
    writeReproTest(testBody + "test('TC-1 empty',()=>assert.equal(total([]),0));\n");
    await toIntegrateAgain();
    assert.equal(readFileSync(join(repo, SRC), "utf8"), fixed);
    assert.equal(loadEvidence(repo, "FIX-1", SRC)!.repro!.found[0].status, "failed");
    await integrate(requireValidatable(repo, "integrate"));
    assert.deepEqual(stageProblems(loadWork(repo)!, "integrate"), []);
  });

  test("17d. 단언을 없애 기준 코드에서도 통과하는 테스트는 재현 갱신에서 차단한다", async () => {
    useManifest({ test: ["node", "--test", "--test-reporter=tap"] });
    toImplement();
    writeReproTest("const test=require('node:test'),assert=require('node:assert/strict'),{total}=require('../main/app/order');test('TC-1 sum',()=>assert.equal(total([2,3]),5));\n");
    await repro(requireReproable(repo)); fixSource(); next(repo); next(repo);
    await check(requireValidatable(repo, "check"));
    writeReproTest("require('node:test')('TC-1 weakened',()=>{});\n");
    const fixed = readFileSync(join(repo, SRC), "utf8");
    await assert.rejects(() => check(requireValidatable(repo, "check")), /재현하지 못했습니다/);
    assert.equal(readFileSync(join(repo, SRC), "utf8"), fixed);
    assert.ok(stageProblems(loadWork(repo)!, "integrate").some(p => /재현을 본 테스트 트리/.test(p)));
  });

  test("17c. 재현 뒤 테스트를 고치지 않았으면 통합 검증 앞에서 재현 묶임이 걸리지 않는다", async () => {
    toImplement();
    writeReproTest();
    await repro(requireReproable(repo));
    fixSource();
    next(repo);
    next(repo);
    await toIntegrateAgain();
    assert.equal(
      stageProblems(loadWork(repo)!, "integrate").some((problem) => /재현을 본 테스트 트리/.test(problem)),
      false,
    );
  });

  test("18. repro 는 fix 의 구현·재검증 단계에서 실행 가능하다", async () => {
    toImplement();
    writeReproTest();
    await repro(requireReproable(repo));
    fixSource();
    next(repo);
    next(repo);
    assert.equal(requireReproable(repo).active.phase, "check");
  });

  test("18b. feature 작업에서 repro 를 부르면 거부된다", () => {
    write("doc/work/FEAT-1.md", ["---", "kind: feature", "id: FEAT-1", "title: 새 도메인", "target: billing", "---", "", "새로 만든다.", ""].join("\n"));
    start(repo, join(repo, "doc/work/FEAT-1.md"));
    assert.throws(() => requireReproable(repo), /code-agent repro 는 fix 작업에서만 돕니다 \(지금: feature\)/);
  });

  test("19. 재현을 보지 않으면 next 가 테스트 단계를 넘기지 않는다", () => {
    toImplement();
    writeReproTest();
    assert.throws(() => next(repo), /code-agent repro 로 지금 코드에서 재현 TC 가 실패하는 것을 보고/);
  });
});

// ==== 2. refactor — 동작 보존 ====

const REF_ORDER = [
  "---", "kind: refactor", "id: REF-1", "title: total 을 정리한다",
  `target: ${SRC}`, "scope: [src/main]", "preserve: [total 의 공개 시그니처]",
  "---", "", "total 을 정리한다.", "",
].join("\n");

const REF_PLAN = {
  files: [{ stage: "code", path: SRC, purpose: "total 을 정리한다", requirements: ["R1"] }],
  preserve: [{ item: "total 의 공개 시그니처", how: "이름과 인자를 그대로 둔다" }],
  sequence: [{ step: "code", why: "하나뿐이다" }],
  approach: "내부만 정리한다",
  conventions: [], conflicts: [], openQuestions: [], reasoning: "동작은 그대로",
};

describe("P6 · refactor — 동작 보존", () => {
  beforeEach(() => {
    newRepo("ca-p6-ref-");
    write("code-agent.json", manifest({ test: ["node", "-e", "console.log('ok 1 - TC-1')"] }));
    write(SRC, "function total(items) {\n  return items.reduce((a, b) => a + b, 0);\n}\nmodule.exports = { total };\n");
    write(KEPT_TEST, "// TC-1 기존 테스트\n");
    write("doc/work/REF-1.md", REF_ORDER);
    confirmDocs();
    git("add", "-A");
    git("commit", "-qm", "init");
  });
  afterEach(dropRepo);

  function writeDocs(current = CURRENT_OK): void {
    write("doc/work/REF-1/01-requirements.md",
      ["# REF-1 요구사항 정의", "## R1 · 내부 구조 정리", "근거: \"total 을 정리한다.\"", "- 기존 코드: 고친다", "## 가정", "- 없음"].join("\n"));
    write("doc/work/REF-1/02-analysis.md", analysisDoc(current).replace(/# 영향도 분석/, "# REF-1 영향도 분석"));
    write("doc/work/REF-1/03-design.md", FIX_DESIGN);
    write("doc/work/REF-1/04-functional.md",
      ["# 기능 명세", "## 기능 정의", "- R1: 동작은 그대로", "## 업무 규칙", "- 없음 — 규칙 변경 없음",
        "## 예외", "- 없음 — 기존 예외 그대로", "## 수락 기준", "- AC-R1-1: 기존 테스트가 그대로 통과한다"].join("\n"));
    write("doc/work/REF-1/07-test-spec.md", specDoc());
  }

  function submit(plan: unknown = REF_PLAN): string {
    write("doc/work/REF-1/plan.json", JSON.stringify(plan));
    return submitPlan(repo, join(repo, "doc/work/REF-1/plan.json"));
  }

  function toPlan(current = CURRENT_OK): void {
    start(repo, join(repo, "doc/work/REF-1.md"));
    writeDocs(current);
    next(repo);
    next(repo);
    next(repo);
  }

  test("20. refactor 의 ② 가 '해당 없음' 이면 막힌다", () => {
    start(repo, join(repo, "doc/work/REF-1.md"));
    writeDocs(CURRENT_NA);
    next(repo);
    assert.throws(() => next(repo), /refactor 는 기존 시스템 분석에 \*\*지금 동작\*\*을 적습니다/);
  });

  test("21. 기준 커밋에 있던 테스트 파일을 계획에 넣으면 제출되지 않는다", () => {
    toPlan();
    assert.throws(
      () => submit({
        ...REF_PLAN,
        files: [...REF_PLAN.files, { stage: "test", path: KEPT_TEST, purpose: "테스트를 고친다", requirements: ["R1"] }],
      }),
      /리팩토링은 기존 테스트를 고치지 않습니다 — 계획에서 빼세요/,
    );
    assert.match(submit(), /계획을 제출/);
  });

  test("21b. 기존 테스트만 실행하는 리팩토링에서 존재하지 않는 TC는 승인 전에 막는다", () => {
    write(KEPT_TEST, "require('node:test')('TC-1 existing',()=>{});\n");
    git("add", KEPT_TEST); git("commit", "-qm", "existing test id");
    toPlan();
    const spec = "doc/work/REF-1/07-test-spec.md";
    write(spec, specDoc().replace(/TC-1/g, "TC-99"));
    assert.throws(() => submit(), /기존 테스트에 없는 TC-99를 실행할 계획이 없습니다/);
    write(spec, specDoc());
    assert.match(submit(), /계획을 제출/);
  });

  test("22. hook 이 기존 테스트 파일 쓰기를 거부한다", () => {
    start(repo, join(repo, "doc/work/REF-1.md"));
    assert.match(writeFileHook(KEPT_TEST)!, /리팩토링은 기존 테스트를 고치지 않습니다/);
    // 기준 커밋에 없던 테스트 파일은 이 규칙이 아니다 (계획·스테이지 규칙이 따로 판정한다)
    assert.equal(/리팩토링은 기존 테스트/.test(writeFileHook(REPRO_TEST) ?? ""), false);
  });

  /** 매니페스트를 바꿔 끼운다 — 시작 **전에** 부른다 */
  function useManifest(overrides: Record<string, unknown>): void {
    write("code-agent.json", manifest({ test: ["node", "-e", "console.log('ok 1 - TC-1')"], ...overrides }));
    confirmDocs();
    git("add", "-A");
    git("commit", "-qm", "manifest");
  }

  test("22b. 테스트 단계가 kinds 에서 refactor 를 뺐어도 기존 테스트는 보호된다", () => {
    // 리팩토링은 새 테스트를 만들지 않으니 kinds 에서 빼는 것이 자연스럽다. 그때 보호가 꺼지면 안 된다.
    // 코드 단계의 자리는 src 전체라 이름표만으로는 기존 테스트가 계획에 들어온다.
    useManifest({
      stages: [
        { key: "code", title: "코드", template: "01-code.md", kinds: ["feature", "fix", "refactor"], scope: "project", outputDirs: ["src"] },
        { key: "test", title: "테스트", template: "02-test.md", kind: "test", kinds: ["feature", "fix"], scope: "project", outputDirs: ["src/test"] },
      ],
    });
    toPlan();
    assert.throws(
      () => submit({
        ...REF_PLAN,
        files: [...REF_PLAN.files, { stage: "code", path: KEPT_TEST, purpose: "기존 테스트를 고친다", requirements: ["R1"] }],
      }),
      /리팩토링은 기존 테스트를 고치지 않습니다 — 계획에서 빼세요/,
    );
    assert.match(writeFileHook(KEPT_TEST)!, /리팩토링은 기존 테스트를 고치지 않습니다/);
  });

  test("22c. 테스트 단계가 자리를 밝히지 않으면 소스 루트를 테스트로 읽지 않는다 — refactor 가 제 파일을 고친다", () => {
    // 테스트가 소스 옆에 있는 모양. 옛 코드는 domainBase 로 물러서서 src/main 전체를 '기존 테스트' 로 읽었다
    useManifest({
      stages: [
        { key: "code", title: "코드", template: "01-code.md", kinds: ["feature", "fix", "refactor"], scope: "project", outputDirs: ["src/main"] },
        { key: "test", title: "테스트", template: "02-test.md", kind: "test", kinds: ["feature", "fix", "refactor"], scope: "domain", outputDirs: ["."] },
      ],
    });
    assert.match(manifestCheck(repo).text, /test 는 kind:"test" 인데 자리를 밝히지 않았습니다/);
    toPlan();
    assert.match(submit(), /계획을 제출/);
    assert.equal(/리팩토링은 기존 테스트/.test(writeFileHook(SRC) ?? ""), false);
  });

  test("22d. plan 스테이지의 context 가 기존 테스트 보호를 미리 말해 준다", () => {
    toPlan();
    const text = context(repo);
    assert.match(text, /## refactor — 기존 테스트는 계획에 넣지 않는다/);
    assert.match(text, /기준 커밋에 이미 있던 테스트 자리\(src\/test\)/);
  });

  test("23. 기존 테스트가 바뀐 채로는 check 가 돌지 않는다 — 지워도 같다", async () => {
    toPlan();
    submit();
    approve();
    next(repo);
    write(SRC, "function total(items) {\n  let sum = 0;\n  for (const item of items) sum += item;\n  return sum;\n}\nmodule.exports = { total };\n");
    next(repo);
    assert.equal(loadActive(repo)!.phase, "check");

    writeFileSync(join(repo, KEPT_TEST), "// TC-1 기존 테스트 (몰래 고침)\n");
    await assert.rejects(() => check(requireValidatable(repo, "check")), /리팩토링이 기존 테스트를 고쳤습니다: \[M\]/);

    rmSync(join(repo, KEPT_TEST));
    await assert.rejects(() => check(requireValidatable(repo, "check")), /리팩토링이 기존 테스트를 고쳤습니다: \[D\]/);
  });

  test("24. preserve 가 계획에 없으면 제출되지 않는다 (회귀)", () => {
    toPlan();
    assert.throws(() => submit({ ...REF_PLAN, preserve: [] }), /preserve 가 계획에 없습니다/);
  });

  test("25. 테스트 명령이 선언되지 않으면 test·integrate 가 not-run 으로 막힌다 (회귀)", async () => {
    write("code-agent.json", manifest({ test: undefined }));
    write("doc/test-strategy.md", STRATEGY_NO_TEST);
    confirmDocs();
    git("add", "-A");
    git("commit", "-qm", "no-test");
    toPlan();
    submit();
    approve();
    next(repo);
    write(SRC, "function total(items) {\n  let sum = 0;\n  for (const item of items) sum += item;\n  return sum;\n}\nmodule.exports = { total };\n");
    next(repo);
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.ok(stageProblems(loadWork(repo)!, "test").some((problem) => /test: not-run/.test(problem)));
    assert.throws(() => next(repo), /test: not-run/);
    // 통합 검증도 같은 선언을 딛는다 — 선언이 없으면 거기서도 통과가 아니다
    assert.equal(integrateCommands(loadManifest(repo)).find((spec) => spec.kind === "test")!.argv, undefined);
  });
});

// ==== 3. 종류별 단계 ====

describe("P6 · 종류별 단계 인식", () => {
  beforeEach(() => {
    newRepo("ca-p6-kind-");
    write(SRC, "module.exports = {};\n");
    write("doc/work/FIX-1.md", FIX_ORDER);
    write(KEPT_TEST, "// 기존 테스트\n");
  });
  afterEach(dropRepo);

  function commitWith(overrides: Record<string, unknown>): void {
    write("code-agent.json", manifest(overrides));
    confirmDocs();
    git("add", "-A");
    git("commit", "-qm", "init");
  }

  test("26. feature 만 도는 매니페스트에서 fix 를 시작하면 고치는 법을 알려 준다", () => {
    commitWith({
      stages: [
        { key: "code", title: "코드", template: "01-code.md", kinds: ["feature"], scope: "project", outputDirs: ["src/main"] },
        { key: "test", title: "테스트", template: "02-test.md", kind: "test", kinds: ["feature"], scope: "project", outputDirs: ["src/test"] },
      ],
    });
    assert.throws(
      () => start(repo, join(repo, "doc/work/FIX-1.md")),
      (error: Error) =>
        /stages\[\]\.kinds 에 "fix" 를 더하세요/.test(error.message) &&
        /code\(feature\), test\(feature\)/.test(error.message) &&
        /code-agent manifest check/.test(error.message),
    );
  });

  test("27. manifest check 가 종류별 0단계를 경고하고 종료 코드는 0 이다", () => {
    commitWith({
      stages: [
        { key: "code", title: "코드", template: "01-code.md", kinds: ["feature"], scope: "project", outputDirs: ["src/main"] },
      ],
    });
    const result = manifestCheck(repo);
    assert.equal(result.ok, true);
    assert.match(result.text, /fix 로 돌 단계가 없습니다/);
    assert.match(result.text, /refactor 로 돌 단계가 없습니다/);
  });

  test("28. manifest check 가 kind:\"test\" 단계 없음을 경고한다 (fix 는 추가 문구)", () => {
    commitWith({
      stages: [
        { key: "code", title: "코드", template: "01-code.md", kinds: [], scope: "project", outputDirs: ["src/main"] },
      ],
    });
    const result = manifestCheck(repo);
    assert.equal(result.ok, true);
    assert.match(result.text, /feature 에 kind:"test" 단계가 없습니다 — 테스트 동결이 걸리지 않습니다/);
    assert.match(result.text, /fix 는 재현 테스트를 넣을 자리가 없어 plan submit 이 거부합니다/);
  });
});

// ==== 4. 빈 저장소 ====

const NEW_ORDER = ["---", "kind: feature", "id: NEW-1", "title: 인사 기능", "target: greeting", "---", "", "이름을 받아 인사한다.", ""].join("\n");

const NEW_PLAN = {
  domainName: "Greeting",
  domainLabel: "인사",
  domainRoot: "",
  domainDirName: "greeting",
  files: [
    { stage: "code", path: "src/main/app/greeting.js", purpose: "인사 함수", requirements: ["R1"] },
    { stage: "test", path: "src/test/greeting.test.js", purpose: "테스트", requirements: ["R1"] },
  ],
  sequence: [{ step: "code", why: "먼저" }, { step: "test", why: "다음" }],
  approach: "아키텍처 문서의 구조를 따른다 — 베낄 참조 코드가 없다",
  conventions: [], conflicts: [], openQuestions: [], reasoning: "신규 저장소",
};

describe("P6 · 빈 저장소", () => {
  beforeEach(() => {
    newRepo("ca-p6-new-");
    // 소스 파일이 하나도 없다 — code-agent.json 과 POLICY 문서만 있는 저장소
    write("code-agent.json", manifest());
    write("doc/work/NEW-1.md", NEW_ORDER);
    confirmDocs();
    git("add", "-A");
    git("commit", "-qm", "도입");
  });
  afterEach(dropRepo);

  test("29. survey 가 소스 파일이 없음을 코드로 판정한다", () => {
    const text = survey(repo);
    assert.match(text, /소스 파일이 없습니다 — 신규\(빈\) 저장소입니다/);
    assert.match(text, /언어 · 소스 루트\(domainBase\)/);
  });

  test("29b. 빌드 파일이 있는데 아는 확장자의 소스만 없으면 빈 저장소라고 단정하지 않는다", () => {
    // C·Swift·Dart 처럼 SOURCE_EXT 밖의 언어로 가득 찬 저장소 — 소스 0개로 세어진다
    write("Makefile", "all:\n\techo 만든다\n");
    write("src/main/app/order.c", "int total(void) { return 0; }\n");
    const text = survey(repo);
    assert.match(text, /지원 목록 밖 언어입니다/);
    assert.match(text, /코드가 실재하는지 사람에게 확인하세요/);
    assert.equal(/소스 파일이 없습니다 — 신규\(빈\) 저장소입니다/.test(text), false);
  });

  test("30. 참조 도메인·참조 파일이 없어도 manifest check 가 통과한다", () => {
    const result = manifestCheck(repo);
    assert.equal(result.ok, true);
    assert.match(result.text, /참조 파일을 선언한 단계가 없습니다 — 신규\(빈\) 저장소면 정상입니다/);
  });

  test("31. 참조 도메인이 없으면 context 가 문서를 가리킨다 — 던지지 않는다", () => {
    start(repo, join(repo, "doc/work/NEW-1.md"));
    write("doc/work/NEW-1/01-requirements.md",
      ["# NEW-1 요구사항 정의", "## R1 · 인사한다", "근거: \"이름을 받아 인사한다.\"", "- 데이터: 안 건드린다", "## 가정", "- 없음"].join("\n"));
    next(repo);
    const text = context(repo);
    assert.match(text, /## 참조 없음 — 아키텍처·컨벤션 문서로/);
    assert.match(text, /doc\/architecture\.md/);
    assert.match(text, /doc\/conventions\.md/);
  });

  test("32. 소스가 없는 저장소에서도 start → next → plan submit 이 지난다", () => {
    start(repo, join(repo, "doc/work/NEW-1.md"));
    write("doc/work/NEW-1/01-requirements.md",
      ["# NEW-1 요구사항 정의", "## R1 · 인사한다", "근거: \"이름을 받아 인사한다.\"", "- 데이터: 만든다", "## 가정", "- 없음"].join("\n"));
    write("doc/work/NEW-1/02-analysis.md", [
      "# 영향도 분석", "## 기존 시스템 분석", "- 붙을 코드가 없다 — 새 저장소다",
      "## 영향 범위", "| R 번호 | 닿는 파일/모듈 | 부르는 곳 | 파급 |", "|---|---|---|---|",
      "| R1 | src/main/app/greeting.js | 없음 | 없음 — 새 파일 |", "## Risk", "- 없음",
    ].join("\n"));
    write("doc/work/NEW-1/03-design.md", [
      "# 기술 설계", "## 구성 요소", "- greeting", "## 처리 흐름", "- 이름을 받아 문자열을 만든다",
      "## API", "해당 없음 — 접점이 없다", "## 데이터", "해당 없음 — 저장하지 않는다", "## 설계 결정", "- 순수 함수로 둔다",
    ].join("\n"));
    write("doc/work/NEW-1/04-functional.md", [
      "# 기능 명세", "## 기능 정의", "- R1: 인사한다", "## 업무 규칙", "- 없음 — 규칙이 없다",
      "## 예외", "- 빈 이름: Error", "## 수락 기준", "- AC-R1-1: 이름을 주면 인사 문자열이 나온다",
    ].join("\n"));
    write("doc/work/NEW-1/07-test-spec.md", [
      "# 테스트 명세", "## 테스트 케이스", "| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |", "|---|---|---|---|---|",
      "| TC-1 | Unit | AC-R1-1 | 이름을 준다 | 인사 문자열이 나온다 |",
    ].join("\n"));
    next(repo);
    next(repo);
    next(repo);
    write("doc/work/NEW-1/plan.json", JSON.stringify(NEW_PLAN));
    assert.match(submitPlan(repo, join(repo, "doc/work/NEW-1/plan.json")), /계획을 제출/);
  });
});

// ==== 5·6. deliver 커밋 범위 · integrate 의 prepare ====

const FEAT_SRC = "src/main/app/greeting.js";
const FEAT_TEST = "src/test/greeting.test.js";
const PRINT_TC = ["node", "-e", "console.log('ok 1 - TC-1')"];

const FEAT_ORDER = ["---", "kind: feature", "id: ORD-9", "title: 인사 기능", "target: greeting", "---", "", "이름을 받아 인사한다.", ""].join("\n");

const FEAT_PLAN = {
  domainName: "Greeting",
  domainLabel: "인사",
  domainRoot: "",
  domainDirName: "greeting",
  files: [
    { stage: "code", path: FEAT_SRC, purpose: "인사 함수", requirements: ["R1"] },
    { stage: "test", path: FEAT_TEST, purpose: "테스트", requirements: ["R1"] },
  ],
  sequence: [{ step: "code", why: "먼저" }, { step: "test", why: "다음" }],
  approach: "순수 함수로 만든다",
  conventions: [], conflicts: [], openQuestions: [], reasoning: "단순하다",
};

describe("P6 · deliver 커밋 범위 · integrate 의 prepare", () => {
  beforeEach(() => {
    newRepo("ca-p6-int-");
    write("doc/work/ORD-9.md", FEAT_ORDER);
  });
  afterEach(dropRepo);

  /** 매니페스트를 굳히고 커밋한다 — 작업 시작 전에만 부른다 */
  function useManifest(overrides: Record<string, unknown> = {}): void {
    write("code-agent.json", manifest({ test: PRINT_TC, ...overrides }));
    confirmDocs();
    git("add", "-A");
    git("commit", "-qm", "init");
  }

  function toIntegrate(): void {
    start(repo, join(repo, "doc/work/ORD-9.md"));
    write("doc/work/ORD-9/01-requirements.md",
      ["# ORD-9 요구사항 정의", "## R1 · 인사한다", "근거: \"이름을 받아 인사한다.\"", "- 데이터: 만든다", "## 가정", "- 없음"].join("\n"));
    write("doc/work/ORD-9/02-analysis.md", [
      "# 영향도 분석", "## 기존 시스템 분석", "- 붙을 코드가 없다 — 새 파일이다",
      "## 영향 범위", "| R 번호 | 닿는 파일/모듈 | 부르는 곳 | 파급 |", "|---|---|---|---|",
      `| R1 | ${FEAT_SRC} | 없음 | 없음 — 새 파일 |`, "## Risk", "- 없음",
    ].join("\n"));
    write("doc/work/ORD-9/03-design.md", [
      "# 기술 설계", "## 구성 요소", "- greeting", "## 처리 흐름", "- 이름 → 문자열",
      "## API", "해당 없음 — 접점이 없다", "## 데이터", "해당 없음 — 저장하지 않는다", "## 설계 결정", "- 순수 함수",
    ].join("\n"));
    write("doc/work/ORD-9/04-functional.md", [
      "# 기능 명세", "## 기능 정의", "- R1: 인사한다", "## 업무 규칙", "- 없음 — 규칙이 없다",
      "## 예외", "- 빈 이름: Error", "## 수락 기준", "- AC-R1-1: 이름을 주면 인사 문자열이 나온다",
    ].join("\n"));
    write("doc/work/ORD-9/07-test-spec.md", [
      "# 테스트 명세", "## 테스트 케이스", "| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |", "|---|---|---|---|---|",
      "| TC-1 | Unit | AC-R1-1 | 이름을 준다 | 인사 문자열이 나온다 |",
    ].join("\n"));
    next(repo);
    next(repo);
    next(repo);
    write("doc/work/ORD-9/plan.json", JSON.stringify(FEAT_PLAN));
    submitPlan(repo, join(repo, "doc/work/ORD-9/plan.json"));
    approve();
    next(repo);
    write(FEAT_SRC, "module.exports = { greet: (name) => `안녕 ${name}` };\n");
    next(repo);
    write(FEAT_TEST, "// TC-1\n");
    next(repo);
  }

  async function runToIntegrate(): Promise<void> {
    toIntegrate();
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    next(repo);
    openRound(requireValidatable(repo, "review"));
    const path = join(repo, reviewDocFile("ORD-9"));
    writeFileSync(path, `${readFileSync(path, "utf-8")}\n- 없음\n`);
    recordReviewFixture(repo);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "integrate");
  }

  // ---- deliver 커밋 범위 ----

  test("33. 반영 커밋은 도입 설정을 포함하고 다른 작업 증거와 무관한 파일은 제외한다", async () => {
    useManifest();
    await runToIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    next(repo);
    write(prDocFile("ORD-9"),
      ["# ORD-9 변경 보고서", "", "## 요약", "인사 함수를 더했다.", "", "## 확인 방법", "greet 를 부른다.", "", "## 위험·되돌리기", "없음 — 새 파일이라 지우면 된다.", ""].join("\n"));

    // 같은 트리에 남의 증거와 도입 설정을 둔다. 명시된 도입 설정만 반영한다.
    write(".code-agent/work/OTHER-1/x.verify.json", "{}\n");
    write(".code-agent/models.json", "{}\n");
    write("unrelated.txt", "상관없는 파일\n");

    const work = loadWork(repo)!;
    const commit = commitDelivery(work, loadEvidence(repo, "ORD-9", "greeting")!, []);
    const files = git("show", "--name-only", "--format=", commit).split("\n").map((line) => line.trim()).filter(Boolean);

    assert.equal(files.includes(".code-agent/work/OTHER-1/x.verify.json"), false);
    assert.equal(files.includes(".code-agent/models.json"), true);
    assert.equal(files.includes("unrelated.txt"), false);
    // 커밋되지 않았을 뿐 아니라 스테이지에도 올라가지 않았다 — 여전히 미추적이다
    const untracked = git("status", "--porcelain");
    assert.doesNotMatch(untracked, /\.code-agent\/models\.json/);
    assert.match(untracked, /\?\? \.code-agent\/work\/OTHER-1\//);
  });

  test("34. 이 작업의 파일·증거·원장은 같은 커밋에 들어간다", async () => {
    useManifest();
    await runToIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    next(repo);
    write(prDocFile("ORD-9"),
      ["# ORD-9 변경 보고서", "", "## 요약", "인사 함수를 더했다.", "", "## 확인 방법", "greet 를 부른다.", "", "## 위험·되돌리기", "없음.", ""].join("\n"));

    const commit = commitDelivery(loadWork(repo)!, loadEvidence(repo, "ORD-9", "greeting")!, []);
    const files = git("show", "--name-only", "--format=", commit).split("\n").map((line) => line.trim()).filter(Boolean);
    for (const expected of [
      FEAT_SRC,
      FEAT_TEST,
      ".code-agent/work/ORD-9/greeting.verify.json",
      ".code-agent/work/ORD-9/greeting.review.json",
      ".code-agent/work/ORD-9/greeting.plan.json",
      ".code-agent/approvals/ORD-9.jsonl",
      ".code-agent/approvals/ORD-9/greeting-1.plan.json",
      validationDocFile("ORD-9"),
      reviewDocFile("ORD-9"),
      prDocFile("ORD-9"),
    ]) {
      assert.ok(files.includes(expected), `커밋에 없습니다: ${expected}`);
    }
  });

  test("34b. 이미 인덱스에 올라가 있던 남의 파일은 반영 커밋에 실리지 않는다", async () => {
    useManifest();
    await runToIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    next(repo);
    write(prDocFile("ORD-9"),
      ["# ORD-9 변경 보고서", "", "## 요약", "인사 함수를 더했다.", "", "## 확인 방법", "greet 를 부른다.", "", "## 위험·되돌리기", "없음.", ""].join("\n"));

    // 사람이 터미널에서 친 git add · 앞서 실패한 deliver 가 남긴 스테이지
    write("unrelated.txt", "상관없는 파일\n");
    write(".code-agent/work/OTHER-1/x.verify.json", "{}\n");
    git("add", "--", "unrelated.txt", ".code-agent/work/OTHER-1/x.verify.json");

    const commit = commitDelivery(loadWork(repo)!, loadEvidence(repo, "ORD-9", "greeting")!, []);
    const files = git("show", "--name-only", "--format=", commit).split("\n").map((line) => line.trim()).filter(Boolean);
    assert.equal(files.includes("unrelated.txt"), false);
    assert.equal(files.includes(".code-agent/work/OTHER-1/x.verify.json"), false);
    assert.ok(files.includes(FEAT_SRC), `이 작업의 파일이 빠졌습니다: ${files.join(", ")}`);
    // 스테이지에는 그대로 남아 있다 — 사람이 올린 것을 이 명령이 되돌리지는 않는다
    assert.match(git("status", "--porcelain"), /^A {2}unrelated\.txt$/m);
  });

  test("35. 없는 경로가 섞여도 git add 가 서지 않는다 (존재 필터 회귀)", async () => {
    useManifest();
    await runToIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    next(repo);
    write(prDocFile("ORD-9"),
      ["# ORD-9 변경 보고서", "", "## 요약", "인사 함수를 더했다.", "", "## 확인 방법", "greet 를 부른다.", "", "## 위험·되돌리기", "없음.", ""].join("\n"));

    // 판정 스냅샷 디렉토리가 없는 상태 · 아직 쓰이지 않은 KNOWLEDGE 경로
    rmSync(join(repo, ".code-agent/approvals/ORD-9"), { recursive: true, force: true });
    const commit = commitDelivery(loadWork(repo)!, loadEvidence(repo, "ORD-9", "greeting")!, ["doc/knowledge/없는-파일.md"]);
    assert.equal(commit.length, 40);
  });

  // ---- prepare ----

  test("36. prepare 가 없는 매니페스트의 해시는 그대로다 (골든 — 기존 승인 보존)", () => {
    write("code-agent.json", JSON.stringify({
      language: "java",
      sourceExtensions: [".java"],
      domainBase: "src/main/java/com/acme/app",
      domainRoots: ["application"],
      conventions: ["doc/conventions.md"],
      docs: { architecture: "doc/architecture.md" },
      referenceDomain: "deal",
      build: ["node", "-e", "process.exit(0)"],
      test: ["node", "-e", "process.exit(0)"],
      stages: [
        { key: "entity", title: "Entity", template: "01-entity.md", kinds: ["feature"], outputDirs: ["domain"] },
        { key: "repository", title: "Repository", template: "02-repository.md", kinds: ["feature"], outputDirs: ["repository"] },
        { key: "test", title: "테스트", template: "03-test.md", kind: "test", kinds: ["feature"], scope: "project", outputDirs: ["src/test"] },
      ],
    }));
    assert.equal(hashManifest(loadManifest(repo)), "sha256:d54b43e8bd896c09");
  });

  test("37. prepare 를 선언하면 해시가 달라진다 — 묶임이 실재한다", () => {
    write("code-agent.json", manifest());
    const before = hashManifest(loadManifest(repo));
    write("code-agent.json", manifest({ prepare: ["npm", "ci"] }));
    assert.notEqual(hashManifest(loadManifest(repo)), before);
  });

  test("38. commands 에 prepare 를 선언하면 형식 오류다", () => {
    write("code-agent.json", manifest({ commands: { prepare: PASS } }));
    assert.throws(() => loadManifest(repo), /prepare 은 commands 에 선언할 수 없습니다/);
  });

  test("38b. 빈 prepare 는 형식 오류다 — 돈다고 읽히는데 조용히 건너뛰는 선언을 두지 않는다", () => {
    write("code-agent.json", manifest({ prepare: [] }));
    assert.throws(() => loadManifest(repo), /prepare/);
  });

  test("38c. 문서가 `prepare` 를 명령 이름으로 적어도 check·test 가 준비 명령을 돌리지 않는다", () => {
    // 준비 명령은 깨끗한 worktree 의 것이다 — 사람이 보고 있는 작업 트리에서 돌면 스키마가 적은 약속이 깨진다
    write("code-agent.json", manifest({ test: PRINT_TC, prepare: ["npm", "ci"] }));
    write("doc/test-strategy.md", STRATEGY_PREPARE);
    write("doc/quality.md", QUALITY_PREPARE);
    const loaded = loadManifest(repo);
    for (const spec of [...testCommands(repo, loaded), ...checkCommands(repo, loaded)].filter((spec) => spec.kind === "prepare")) {
      assert.equal(spec.argv, undefined, "작업 트리에서 준비 명령이 풀렸습니다");
    }
    // 통합 검증의 자리에서는 그대로 돈다
    assert.deepEqual(prepareCommand(loaded), { kind: "prepare", argv: ["npm", "ci"] });
  });

  test("39. prepare 가 통과하면 worktree 안에서 build·test 가 이어 돈다", async () => {
    useManifest({ prepare: PASS });
    await runToIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    const runs = runsOf(loadEvidence(repo, "ORD-9", "greeting")!, "integrate");
    assert.deepEqual(runs.map((run) => `${run.kind}=${run.outcome}`), ["prepare=passed", "build=passed", "test=passed"]);
    assert.deepEqual(stageProblems(loadWork(repo)!, "integrate"), []);
  });

  test("40. prepare 가 실패하면 build·test 를 돌리지 않고 통합 검증이 막힌다", async () => {
    useManifest({ prepare: FAIL });
    await runToIntegrate();
    const out = await integrate(requireValidatable(repo, "integrate"));
    assert.match(out, /준비 명령이 실패해 build·test 를 돌리지 않았습니다/);
    const runs = runsOf(loadEvidence(repo, "ORD-9", "greeting")!, "integrate");
    assert.deepEqual(runs.map((run) => run.kind), ["prepare"]);
    assert.ok(stageProblems(loadWork(repo)!, "integrate").some((problem) => /prepare: failed/.test(problem)));
  });

  test("41. prepare 실행 파일이 없으면 error 로 막힌다", async () => {
    useManifest({ prepare: NOT_INSTALLED });
    await runToIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    const runs = runsOf(loadEvidence(repo, "ORD-9", "greeting")!, "integrate");
    assert.deepEqual(runs.map((run) => `${run.kind}=${run.outcome}`), ["prepare=error"]);
    assert.ok(stageProblems(loadWork(repo)!, "integrate").some((problem) => /prepare: error/.test(problem)));
  });

  test("42. prepare 를 선언하지 않은 매니페스트의 통합 검증은 그대로 통과한다 (C4 회귀)", async () => {
    useManifest();
    await runToIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    const runs = runsOf(loadEvidence(repo, "ORD-9", "greeting")!, "integrate");
    assert.deepEqual(runs.map((run) => `${run.kind}=${run.outcome}`), ["build=passed", "test=passed"]);
    assert.deepEqual(stageProblems(loadWork(repo)!, "integrate"), []);
  });

  test("43. 계획이 prepare 명령이 가리키는 파일을 쓰면 제출되지 않는다", () => {
    useManifest({ prepare: ["node", FEAT_SRC] });
    start(repo, join(repo, "doc/work/ORD-9.md"));
    write("doc/work/ORD-9/01-requirements.md",
      ["# ORD-9 요구사항 정의", "## R1 · 인사한다", "근거: \"이름을 받아 인사한다.\"", "- 데이터: 만든다", "## 가정", "- 없음"].join("\n"));
    write("doc/work/ORD-9/02-analysis.md", [
      "# 영향도 분석", "## 기존 시스템 분석", "- 붙을 코드가 없다 — 새 파일이다",
      "## 영향 범위", "| R 번호 | 닿는 파일/모듈 | 부르는 곳 | 파급 |", "|---|---|---|---|",
      `| R1 | ${FEAT_SRC} | 없음 | 없음 — 새 파일 |`, "## Risk", "- 없음",
    ].join("\n"));
    write("doc/work/ORD-9/03-design.md", [
      "# 기술 설계", "## 구성 요소", "- greeting", "## 처리 흐름", "- 이름 → 문자열",
      "## API", "해당 없음 — 접점이 없다", "## 데이터", "해당 없음 — 저장하지 않는다", "## 설계 결정", "- 순수 함수",
    ].join("\n"));
    write("doc/work/ORD-9/04-functional.md", [
      "# 기능 명세", "## 기능 정의", "- R1: 인사한다", "## 업무 규칙", "- 없음 — 규칙이 없다",
      "## 예외", "- 빈 이름: Error", "## 수락 기준", "- AC-R1-1: 이름을 주면 인사 문자열이 나온다",
    ].join("\n"));
    write("doc/work/ORD-9/07-test-spec.md", [
      "# 테스트 명세", "## 테스트 케이스", "| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |", "|---|---|---|---|---|",
      "| TC-1 | Unit | AC-R1-1 | 이름을 준다 | 인사 문자열이 나온다 |",
    ].join("\n"));
    next(repo);
    next(repo);
    next(repo);
    write("doc/work/ORD-9/plan.json", JSON.stringify(FEAT_PLAN));
    assert.throws(
      () => submitPlan(repo, join(repo, "doc/work/ORD-9/plan.json")),
      /검증 명령이 이 계획이 쓰는 파일을 가리킵니다/,
    );
  });
});
