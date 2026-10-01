import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { recordDecision } from "../core/approval";
import { decide as decideApproval, next, Stop, submitPlan } from "../agent/commands";
import { start } from "./confirmedStart";
import { checkDoc, checkProjectDocs, checkSections, DOCS_LEDGER, readDocLedger, recordDocConfirmation } from "../agent/docs";
import { confirmDoc, docsBegin, docsEnd, docsLink, docsSkeleton, docsStatus } from "../agent/docsCommands";
import { decide } from "../agent/hook";
import { ARCHITECTURE, CONVENTIONS, QUALITY, skeleton, TEST_STRATEGY } from "../agent/schemas";
import { manifestCheck, survey } from "../agent/survey";
import { approvalDocsHash, approvalOf, loadManifestIfAny, loadWork } from "../agent/work";

const APP = "src/main/java/com/acme/app/application";

const MANIFEST = {
  language: "java",
  sourceExtensions: [".java"],
  domainBase: "src/main/java/com/acme/app",
  domainRoots: ["application"],
  conventions: ["doc/conventions"],
  docs: { architecture: "doc/architecture.md" },
  referenceDomain: "deal",
  build: ["gradlew", "compileJava", "-q"],
  test: ["gradlew", "test"],
  stages: [
    { key: "entity", title: "Entity", template: "01-entity.md", kinds: ["feature"], exemplars: ["domain/{Ref}.java"], outputDirs: ["domain"] },
    { key: "repository", title: "Repository", template: "02-repository.md", kinds: ["feature"], exemplars: ["repository/"], outputDirs: ["repository"] },
  ],
};

const ARCH = [
  "# 아키텍처",
  "## 1. 기술스택", "Java 21, Spring Boot 3", // 번호·띄어쓰기가 달라도 같은 섹션이다
  "## 패키지 구조", "com.acme.app.<분류>.<도메인>.<계층>",
  "## 계층과 책임", "### domain", "엔티티", "### repository", "저장소",
  "## 의존 방향", "repository → domain",
  "## 공통 모듈", "없음",
  "## 주요 결정", "- 식별자: Long",
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

function write(path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function hookWrite(path: string): string | undefined {
  return decide({ cwd: repo, tool_name: "Write", tool_input: { file_path: join(repo, path) } });
}

function confirmAll(): void {
  for (const check of checkProjectDocs(repo, loadManifestIfAny(repo))) {
    recordDocConfirmation(repo, check, "test", { channel: "tty", verified: true, detail: "테스트" });
  }
}

/**
 * ORD-1 의 번호 문서를 게이트 통과 최소치로 쓰고 계획까지 제출한다.
 * 이 파일의 관심은 공통 문서라 작업 문서 자체의 게이트는 agent.test.ts 가 본다.
 */
function submitOrderPlan(): void {
  write("doc/work/ORD-1/01-requirements.md", "## R1 · 주문\n근거: \"주문\"\n## 가정\n- 없음\n");
  write("doc/work/ORD-1/02-analysis.md", "## 기존 시스템 분석\n- 주문 도메인은 없다\n## 영향 범위\n| R1 | 새 파일 | 없음 | 없음 |\n## Risk\n- 없음 — 새 도메인\n");
  write("doc/work/ORD-1/03-design.md", "## 구성 요소\n- Order\n## 처리 흐름\n- 저장\n## API\n해당 없음 — 접점을 안 건드린다\n## 데이터\n- Order(id)\n## 설계 결정\n- 식별자 Long\n");
  write("doc/work/ORD-1/04-functional.md", "## 기능 정의\n- 등록\n## 업무 규칙\n- 없음\n## 예외\n- 없음\n## 수락 기준\n- AC-R1-1: 등록하면 id 가 생긴다\n");
  write("doc/work/ORD-1/07-test-spec.md", "## 테스트 케이스\n| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |\n|---|---|---|---|---|\n| TC-1 | Unit | AC-R1-1 | 저장 | id 가 생긴다 |\n");
  next(repo);
  next(repo);
  next(repo);
  write("doc/work/ORD-1/plan.json", JSON.stringify({
    domainName: "Order", domainLabel: "주문", domainRoot: "application", domainDirName: "order",
    files: [{ stage: "entity", path: `${APP}/order/domain/Order.java`, purpose: "엔티티", requirements: ["R1"] }],
    sequence: [{ step: "entity", why: "만들 것이 하나다" }],
    approach: "참조 도메인의 구조를 따라 새로 만든다",
    conventions: [], conflicts: [], openQuestions: [], reasoning: "",
  }));
  submitPlan(repo, join(repo, "doc/work/ORD-1/plan.json"));
}

beforeEach(() => {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-docs-")));
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
  write("code-agent.json", JSON.stringify(MANIFEST));
  write("doc/architecture.md", ARCH);
  // 컨벤션은 디렉토리 — 섹션이 여러 파일에 흩어져 있어도 된다
  write("doc/conventions/naming.md", "# 명명\n\n## 명명 규칙\n- <Entity>Repository\n");
  write("doc/conventions/rules.md", "## 계층별 규칙\n- private 필드\n\n## 예외 처리\n- BusinessException\n\n## 테스트\n- 슬라이스\n");
  write("doc/test-strategy.md", TEST_STRATEGY_DOC);
  write("doc/quality.md", QUALITY_DOC);
  write(`${APP}/deal/domain/Deal.java`, "public class Deal {}\n");
  write(`${APP}/deal/repository/DealRepository.java`, "public interface DealRepository {}\n");
  write(`${APP}/customer/domain/Customer.java`, "public class Customer {}\n");
  write(`${APP}/customer/repository/CustomerRepository.java`, "public interface CustomerRepository {}\n");
  write("src/test/java/com/acme/app/DealTests.java", "class DealTests {}\n");
  write("build.gradle", "plugins { id 'java' }\n");
  write("doc/work/ORD-1.md", "---\nkind: feature\nid: ORD-1\ntitle: 주문\ntarget: order\n---\n주문\n");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "files"], { cwd: repo });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("섹션 검사", () => {
  test("뼈대 그대로면 필수 섹션은 전부 비어 있다 — 확인 필요 가 남아 있으므로", () => {
    const sections = checkSections(ARCHITECTURE, skeleton(ARCHITECTURE));
    assert.ok(sections.filter((s) => s.required).every((s) => s.found && !s.filled));
  });

  test("별칭·번호·하위 제목을 받아들인다", () => {
    const sections = checkSections(ARCHITECTURE, ARCH);
    assert.ok(sections.filter((s) => s.required).every((s) => s.filled), JSON.stringify(sections));
  });

  test("주석만 있거나 확인 필요 가 남은 섹션은 채워지지 않은 것이다", () => {
    const text = ARCH.replace("없음", "<!-- 나중에 -->").replace("- 식별자: Long", "- 식별자: 확인 필요");
    const lacking = checkSections(ARCHITECTURE, text).filter((s) => s.required && !s.filled).map((s) => s.id);
    assert.deepEqual(lacking, ["common", "decisions"]);
  });

  test("내용이 있으면 옆의 확인 필요 는 막지 않고 미결로 센다", () => {
    const text = ARCH.replace("- 식별자: Long", "- 식별자: Long\n- 로깅: 확인 필요\n- 권한 모델: 확인 필요");
    const decisions = checkSections(ARCHITECTURE, text).find((s) => s.id === "decisions")!;
    assert.deepEqual([decisions.filled, decisions.open], [true, 2]);
    write("doc/architecture.md", text);
    assert.match(docsStatus(repo), /주요 결정 — 미결 2줄[\s\S]*미결\(확인 필요\) 2줄 — 막지는 않습니다/);
  });

  test("여러 파일로 나뉜 컨벤션도 한 문서로 본다", () => {
    const check = checkDoc(repo, loadManifestIfAny(repo), "conventions");
    assert.equal(check.state, "unconfirmed", check.problem ?? "");
  });

  test("섹션이 모자라면 무엇이 모자란지 알린다", () => {
    write("doc/conventions/rules.md", "## 계층별 규칙\n- private\n");
    const check = checkDoc(repo, loadManifestIfAny(repo), "conventions");
    assert.equal(check.state, "missing-sections");
    assert.match(check.problem ?? "", /예외 처리/);
  });

  test("컨벤션의 테스트 규칙은 선택이다 — 수준·명령·통과 기준은 테스트 전략이 맡는다", () => {
    write("doc/conventions/rules.md", "## 계층별 규칙\n- private\n\n## 예외 처리\n- BusinessException\n");
    assert.equal(checkDoc(repo, loadManifestIfAny(repo), "conventions").state, "unconfirmed");
  });
});

describe("명령 이름 대조 (테스트 전략 · 품질·보안 기준)", () => {
  test("매니페스트에 없는 이름을 적으면 섹션 미충족으로 막는다", () => {
    write("doc/test-strategy.md", TEST_STRATEGY_DOC.replace("- `test`: 전체 테스트", "- `itest`: 통합 테스트"));
    const check = checkDoc(repo, loadManifestIfAny(repo), "test-strategy");
    assert.equal(check.state, "missing-sections");
    assert.match(check.problem ?? "", /code-agent\.json 에 없는 명령 이름입니다: itest/);
    assert.throws(() => confirmDoc(repo, "test-strategy"), /확정할 수 없습니다/);
  });

  test("commands 에 선언한 이름은 통과하고, 최상위 선언이 없는 build·test 는 막는다", () => {
    write("code-agent.json", JSON.stringify({ ...MANIFEST, build: undefined, commands: { "check.style": ["gradlew", "checkstyleMain"] } }));
    write("doc/quality.md", QUALITY_DOC.replace("- `build`: 컴파일 경고", "- `check.style`: Checkstyle"));
    assert.equal(checkDoc(repo, loadManifestIfAny(repo), "quality").state, "unconfirmed");
    // build 를 선언하지 않았는데 문서가 적으면, 돌지 않는 명령 위에 "통과했다"가 선다
    write("doc/quality.md", QUALITY_DOC);
    assert.match(checkDoc(repo, loadManifestIfAny(repo), "quality").problem ?? "", /없는 명령 이름입니다: build/);
  });

  test("`없음` 갈래와 백틱 없는 줄은 대조하지 않는다", () => {
    write("doc/quality.md", QUALITY_DOC.replace("- `build`: 컴파일 경고", "- 없음 — 컴파일 경고만 본다\n- Checkstyle 은 쓰지 않는다"));
    assert.equal(checkDoc(repo, loadManifestIfAny(repo), "quality").state, "unconfirmed");
  });

  test("항목을 빈 줄로 띄운 목록도 끝까지 대조한다 — 빈 줄은 목록의 끝이 아니다", () => {
    write("doc/test-strategy.md", TEST_STRATEGY_DOC.replace("- `test`: 전체 테스트", "- `test`: 전체 테스트\n\n- `nope`: 없는 명령"));
    const check = checkDoc(repo, loadManifestIfAny(repo), "test-strategy");
    assert.equal(check.state, "missing-sections");
    assert.match(check.problem ?? "", /없는 명령 이름입니다: nope/);
  });

  /** 백틱을 빼면 대조가 0건이 된다 — '있다고 적고 돌지 않는' 쪽이 그대로 열린다 */
  test("백틱 이름도 `없음` 도 없으면 확정까지 가지 못한다", () => {
    write("doc/test-strategy.md", TEST_STRATEGY_DOC.replace("- `test`: 전체 테스트", "단위 테스트는 ./gradlew unitTest 로 돈다"));
    const check = checkDoc(repo, loadManifestIfAny(repo), "test-strategy");
    assert.equal(check.state, "missing-sections");
    assert.match(check.problem ?? "", /도구와 실행 명령: 실행 명령을 목록으로 적으세요/);
  });

  test("대조 대상은 첫 목록뿐이다 — 뒤에 이어지는 목록의 이름은 보지 않는다", () => {
    write(
      "doc/test-strategy.md",
      TEST_STRATEGY_DOC.replace("- `test`: 전체 테스트", "- `test`: 전체 테스트\n\n아래는 도입 예정:\n\n- `nope`: 아직 없는 명령"),
    );
    assert.equal(checkDoc(repo, loadManifestIfAny(repo), "test-strategy").state, "unconfirmed");
  });
});

describe("확정", () => {
  test("POLICY 는 넷 다 있어야 작업이 시작된다 — 둘만 확정된 저장소는 start 부터 막힌다", () => {
    rmSync(join(repo, "doc/quality.md"));
    for (const check of checkProjectDocs(repo, loadManifestIfAny(repo)).filter((entry) => entry.hash)) {
      recordDocConfirmation(repo, check, "test", { channel: "tty", verified: true, detail: "테스트" });
    }
    assert.throws(() => start(repo, join(repo, "doc/work/ORD-1.md")), /필수 문서가 갖춰지지 않아[\s\S]*품질·보안 기준/);
  });

  test("확정하면 게이트가 열리고, 줄바꿈만 바뀐 것은 무효로 보지 않는다", () => {
    confirmAll();
    assert.ok(checkProjectDocs(repo, loadManifestIfAny(repo)).every((c) => c.ok));
    write("doc/architecture.md", ARCH.replace(/\n/g, "\r\n"));
    assert.equal(checkDoc(repo, loadManifestIfAny(repo), "architecture").state, "confirmed");
  });

  test("내용이 바뀌면 다시 확정해야 한다", () => {
    confirmAll();
    write("doc/architecture.md", `${ARCH}\n- 삭제: soft delete`);
    assert.equal(checkDoc(repo, loadManifestIfAny(repo), "architecture").state, "stale");
  });

  test("원장을 손으로 고치면 읽기를 거부한다", () => {
    confirmAll();
    const path = join(repo, DOCS_LEDGER);
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    writeFileSync(path, `${lines[1]}\n`);
    assert.throws(() => readDocLedger(repo), /사슬이 끊겼습니다/);
  });

  test("터미널이 아니면 확정하지 않는다", () => {
    assert.throws(() => confirmDoc(repo, "architecture"), /TTY 가 아닙니다/);
    assert.equal(existsSync(join(repo, DOCS_LEDGER)), false);
  });

  test("필수 섹션이 비었으면 터미널을 묻기 전에 거절한다", () => {
    write("doc/architecture.md", skeleton(ARCHITECTURE));
    assert.throws(() => confirmDoc(repo, "architecture"), (error: Error) => error instanceof Stop && /확정할 수 없습니다/.test(error.message));
  });

  test("문서가 확정되지 않았으면 계획 승인도 받지 않는다", () => {
    confirmAll();
    start(repo, join(repo, "doc/work/ORD-1.md"));
    submitOrderPlan();
    rmSync(join(repo, DOCS_LEDGER));
    assert.throws(() => decideApproval(repo, "approved"), /필수 문서가 갖춰지지 않아/);
  });
});

describe("계획 승인은 문서에 묶인다", () => {
  test("승인 뒤 문서를 바꿔 다시 확정하면 그 승인은 무효다", () => {
    confirmAll();
    start(repo, join(repo, "doc/work/ORD-1.md"));
    submitOrderPlan();
    const work = loadWork(repo)!;
    recordDecision(repo, {
      order: work.order, target: "order", plan: work.plan!, manifest: work.manifest, decision: "approved",
      approver: "t", presence: { channel: "tty", verified: true, detail: "t" },
      docsHash: approvalDocsHash(work),
    });
    assert.equal(approvalOf(loadWork(repo)!).status, "approved");

    write("doc/architecture.md", `${ARCH}\n- 삭제: soft delete`);
    confirmAll();
    assert.equal(approvalOf(loadWork(repo)!).status, "stale-docs");
  });
});

describe("문서 작성 세션", () => {
  test("세션 중에는 문서 자리 밖 쓰기를 막고, 끝나면 풀린다", () => {
    docsBegin(repo);
    assert.match(hookWrite(`${APP}/deal/domain/Deal.java`) ?? "", /문서 작성 중에는/);
    assert.equal(hookWrite("doc/architecture.md"), undefined);
    assert.equal(hookWrite("doc/conventions/new.md"), undefined);
    assert.equal(hookWrite("code-agent.json"), undefined);
    assert.match(hookWrite(".code-agent/approvals/docs.jsonl") ?? "", /도구로 고칠 수 없습니다/);
    assert.ok(decide({ cwd: repo, tool_name: "Bash", tool_input: { command: "echo x > src/a.java" } }));
    assert.equal(decide({ cwd: repo, tool_name: "Bash", tool_input: { command: "code-agent survey" } }), undefined);
    docsEnd(repo);
    assert.equal(hookWrite(`${APP}/deal/domain/Deal.java`), undefined);
  });

  test("작업 중에는 문서 세션을 열지 않는다", () => {
    confirmAll();
    start(repo, join(repo, "doc/work/ORD-1.md"));
    assert.throws(() => docsBegin(repo), /작업이 진행 중입니다/);
  });

  test("상태는 섹션별로 무엇이 빠졌는지와 다음 할 일을 보여 준다", () => {
    write("doc/architecture.md", skeleton(ARCHITECTURE));
    const text = docsStatus(repo);
    assert.match(text, /✗ 기술 스택 — 내용 없음/);
    assert.match(text, /다음: \/ca-docs/);
  });
});

describe("기존 문서 연결", () => {
  test("code-agent.json 의 그 자리만 바꾼다", () => {
    write("docs/ARCHITECTURE.md", ARCH);
    docsLink(repo, "architecture", ["docs/ARCHITECTURE.md"]);
    const raw = JSON.parse(readFileSync(join(repo, "code-agent.json"), "utf-8"));
    assert.equal(raw.docs.architecture, "docs/ARCHITECTURE.md");
    assert.deepEqual(raw.stages.map((s: { key: string }) => s.key), ["entity", "repository"]);
  });

  test("테스트 전략·품질은 docs 의 제 자리에, KNOWLEDGE 는 docs.knowledge 에 적힌다", () => {
    write("docs/TESTING.md", TEST_STRATEGY_DOC);
    write("docs/entities.md", "## 엔티티\n");
    docsLink(repo, "test-strategy", ["docs/TESTING.md"]);
    const text = docsLink(repo, "data-dictionary", ["docs/entities.md"]);
    const raw = JSON.parse(readFileSync(join(repo, "code-agent.json"), "utf-8"));
    assert.equal(raw.docs.testStrategy, "docs/TESTING.md");
    assert.equal(raw.docs.knowledge.dataDictionary, "docs/entities.md");
    // KNOWLEDGE 는 확정이 없으므로 연결 결과도 있음/없음으로만 보인다
    assert.match(text, /✓ 데이터 사전: docs\/entities\.md/);
    assert.equal(checkDoc(repo, loadManifestIfAny(repo), "test-strategy").state, "unconfirmed");
  });

  test("없는 경로는 연결하지 않는다", () => {
    assert.throws(() => docsLink(repo, "conventions", ["doc/none.md"]), /없는 경로입니다/);
  });

  /** 등록 경로를 갈아끼우면 확정이 깨진다 — 작업 중에 모델이 제가 쓴 파일을 근거 문서 자리에 걸 수 있었다 */
  test("작업 중에는 연결하지 않는다", () => {
    confirmAll();
    start(repo, join(repo, "doc/work/ORD-1.md"));
    write("doc/work/ORD-1/conv.md", "## 명명 규칙\n- 내 맘대로\n");
    assert.throws(() => docsLink(repo, "conventions", ["doc/work/ORD-1/conv.md"]), /작업이 진행 중입니다/);
    assert.equal(checkDoc(repo, loadManifestIfAny(repo), "conventions").state, "confirmed");
  });

  test("매니페스트가 없으면 기본 경로를 안내한다", () => {
    rmSync(join(repo, "code-agent.json"));
    assert.throws(() => docsLink(repo, "architecture", ["doc/architecture.md"]), /기본 경로\(doc\/architecture\.md\)/);
    // 매니페스트가 없어도 기본 경로의 문서는 점검된다
    assert.equal(checkDoc(repo, undefined, "architecture").state, "unconfirmed");
    assert.equal(checkDoc(repo, undefined, "conventions").state, "missing-file");
  });
});

describe("survey · manifest check", () => {
  test("빌드 파일·언어·계층 후보·표본을 뽑는다 — .git 은 보지 않는다", () => {
    const text = survey(repo);
    assert.match(text, /- build\.gradle/);
    assert.match(text, /- \.java: 5/);
    assert.match(text, /- domain: 디렉토리 2개/);
    assert.match(text, /- repository: 디렉토리 2개/);
    assert.match(text, /customer\/domain\/Customer\.java/);
    assert.match(text, /테스트: src\/test\/java\/com\/acme\/app\/DealTests\.java/);
    assert.doesNotMatch(text, /\.git\//);
  });

  test("참조 파일을 모두 찾으면 통과, 못 찾는 단계가 있으면 실패", () => {
    assert.equal(manifestCheck(repo).ok, true);
    write("code-agent.json", JSON.stringify({ ...MANIFEST, referenceDomain: "nope" }));
    const result = manifestCheck(repo);
    assert.equal(result.ok, false);
    assert.match(result.text, /참조 표준 도메인을 찾을 수 없습니다: nope/);
  });

  test("컨벤션 스키마의 필수 섹션은 셋이다 — 테스트 규칙은 선택으로 내려갔다", () => {
    assert.deepEqual(CONVENTIONS.sections.filter((s) => s.required).map((s) => s.id), ["naming", "layerRules", "errors"]);
  });

  test("테스트 전략·품질·보안 기준의 필수 섹션", () => {
    assert.deepEqual(TEST_STRATEGY.sections.filter((s) => s.required).map((s) => s.heading), ["수준과 범위", "도구와 실행 명령", "통과 기준"]);
    assert.deepEqual(QUALITY.sections.filter((s) => s.required).map((s) => s.heading), ["정적 분석", "보안 검사", "통과 기준과 반영 차단"]);
    // 대화로 채우는 자리(수준별 필수 여부·임계·차단 정책)는 코드 어디에도 없다 — 질문이 있어야 물을 수 있다
    assert.ok(TEST_STRATEGY.sections.every((s) => !s.required || s.questions.length > 0));
    assert.ok(QUALITY.sections.every((s) => !s.required || s.questions.length > 0));
  });

  test("도구 후보를 빌드 파일·CI 설정에서 센다", () => {
    write("build.gradle", "plugins { id 'java'\n id 'checkstyle' }\ndependencies { testImplementation 'org.junit.jupiter:junit-jupiter' }\n");
    write(".github/workflows/ci.yml", "jobs:\n  build:\n    steps:\n      - run: ./gradlew dependency-check\n");
    const text = survey(repo);
    assert.match(text, /- 테스트: JUnit 5 \(build\.gradle\)/);
    assert.match(text, /- 정적 분석: Checkstyle \(build\.gradle\)/);
    assert.match(text, /- 보안: OWASP Dependency-Check \(\.github\/workflows\/ci\.yml\)/);
    assert.match(text, /- CI 설정: \.github\/workflows\/ci\.yml/);
  });
});

describe("공통 KNOWLEDGE", () => {
  test("없어도 작업을 막지 않는다 — 상태에는 없다고 보인다", () => {
    confirmAll();
    assert.match(docsStatus(repo), /데이터 사전: doc\/knowledge\/data-dictionary\.md — 없음 \(막지는 않습니다\)/);
    assert.doesNotThrow(() => start(repo, join(repo, "doc/work/ORD-1.md")));
  });

  test("docs begin 이 빈 뼈대를 만든다 — 미결 표시는 넣지 않는다", () => {
    const text = docsBegin(repo);
    assert.match(text, /빈 뼈대를 만들었습니다: doc\/knowledge\/data-dictionary\.md, doc\/knowledge\/api-catalog\.md, doc\/knowledge\/business-rules\.md/);
    const written = readFileSync(join(repo, "doc/knowledge/business-rules.md"), "utf-8");
    assert.match(written, /## 용어/);
    assert.doesNotMatch(written, /확인 필요/);
    assert.match(docsStatus(repo), /✓ 업무 규칙·용어집/);
    // 다시 열어도 덮지 않는다
    write("doc/knowledge/business-rules.md", "## 용어\n| 취소 | 주문 취소 | VOID |\n");
    docsEnd(repo);
    docsBegin(repo);
    assert.match(readFileSync(join(repo, "doc/knowledge/business-rules.md"), "utf-8"), /VOID/);
  });

  test("KNOWLEDGE 는 확정 대상이 아니다 — 승인 해시에 들어가면 남의 반영마다 남의 승인이 무효가 된다", () => {
    assert.throws(() => confirmDoc(repo, "data-dictionary"), /공통 KNOWLEDGE 라 확정 대상이 아닙니다/);
  });

  test("뼈대는 각 문서의 필수 섹션을 들고 있다", () => {
    assert.match(docsSkeleton("knowledge"), /doc\/knowledge\/api-catalog\.md[\s\S]*## 엔드포인트/);
    assert.match(docsSkeleton("data-dictionary"), /## 엔티티/);
  });
});

describe("승인 해시는 POLICY 4종을 덮는다", () => {
  test("확정된 문서는 넷이고, 테스트 전략이 바뀌면 승인이 무효가 된다", () => {
    confirmAll();
    assert.deepEqual(checkProjectDocs(repo, loadManifestIfAny(repo)).map((c) => c.kind), ["architecture", "conventions", "test-strategy", "quality"]);
    start(repo, join(repo, "doc/work/ORD-1.md"));
    submitOrderPlan();
    const work = loadWork(repo)!;
    recordDecision(repo, {
      order: work.order, target: "order", plan: work.plan!, manifest: work.manifest, decision: "approved",
      approver: "t", presence: { channel: "tty", verified: true, detail: "t" },
      docsHash: approvalDocsHash(work),
    });
    assert.equal(approvalOf(loadWork(repo)!).status, "approved");

    write("doc/test-strategy.md", `${TEST_STRATEGY_DOC}\n- 실패 경로도 1케이스`);
    confirmAll();
    assert.equal(approvalOf(loadWork(repo)!).status, "stale-docs");
  });
});
