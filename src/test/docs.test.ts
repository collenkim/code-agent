import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { recordDecision } from "../core/approval";
import { decide as decideApproval, next, start, Stop, submitPlan } from "../agent/commands";
import { checkDoc, checkProjectDocs, checkSections, DOCS_LEDGER, readDocLedger, recordDocConfirmation } from "../agent/docs";
import { confirmDoc, docsBegin, docsEnd, docsLink, docsStatus } from "../agent/docsCommands";
import { decide } from "../agent/hook";
import { ARCHITECTURE, CONVENTIONS, skeleton } from "../agent/schemas";
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

beforeEach(() => {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-docs-")));
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
  write("code-agent.json", JSON.stringify(MANIFEST));
  write("doc/architecture.md", ARCH);
  // 컨벤션은 디렉토리 — 섹션이 여러 파일에 흩어져 있어도 된다
  write("doc/conventions/naming.md", "# 명명\n\n## 명명 규칙\n- <Entity>Repository\n");
  write("doc/conventions/rules.md", "## 계층별 규칙\n- private 필드\n\n## 예외 처리\n- BusinessException\n\n## 테스트\n- 슬라이스\n");
  write(`${APP}/deal/domain/Deal.java`, "public class Deal {}\n");
  write(`${APP}/deal/repository/DealRepository.java`, "public interface DealRepository {}\n");
  write(`${APP}/customer/domain/Customer.java`, "public class Customer {}\n");
  write(`${APP}/customer/repository/CustomerRepository.java`, "public interface CustomerRepository {}\n");
  write("src/test/java/com/acme/app/DealTests.java", "class DealTests {}\n");
  write("build.gradle", "plugins { id 'java' }\n");
  write("doc/work/ORD-1.md", "---\nkind: feature\nid: ORD-1\ntitle: 주문\ntarget: order\n---\n");
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
    assert.match(check.problem ?? "", /예외 처리, 테스트 규칙/);
  });
});

describe("확정", () => {
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
    write("doc/work/ORD-1/analysis.md", "## R1 · 주문\n## 작업 문서\n- 없음\n");
    next(repo);
    next(repo);
    write("doc/work/ORD-1/plan.json", JSON.stringify({
      domainName: "Order", domainLabel: "주문", domainRoot: "application", domainDirName: "order",
      files: [{ stage: "entity", path: `${APP}/order/domain/Order.java`, purpose: "엔티티", requirements: ["R1"] }],
      conventions: [], conflicts: [], openQuestions: [], reasoning: "",
    }));
    submitPlan(repo, join(repo, "doc/work/ORD-1/plan.json"));
    rmSync(join(repo, DOCS_LEDGER));
    assert.throws(() => decideApproval(repo, "approved"), /필수 문서가 갖춰지지 않아/);
  });
});

describe("계획 승인은 문서에 묶인다", () => {
  test("승인 뒤 문서를 바꿔 다시 확정하면 그 승인은 무효다", () => {
    confirmAll();
    start(repo, join(repo, "doc/work/ORD-1.md"));
    write("doc/work/ORD-1/analysis.md", "## R1 · 주문\n## 작업 문서\n- 없음\n");
    next(repo);
    next(repo);
    write("doc/work/ORD-1/plan.json", JSON.stringify({
      domainName: "Order", domainLabel: "주문", domainRoot: "application", domainDirName: "order",
      files: [{ stage: "entity", path: `${APP}/order/domain/Order.java`, purpose: "엔티티", requirements: ["R1"] }],
      conventions: [], conflicts: [], openQuestions: [], reasoning: "",
    }));
    submitPlan(repo, join(repo, "doc/work/ORD-1/plan.json"));
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

  test("없는 경로는 연결하지 않는다", () => {
    assert.throws(() => docsLink(repo, "conventions", ["doc/none.md"]), /없는 경로입니다/);
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

  test("컨벤션 스키마의 필수 섹션은 넷이다", () => {
    assert.deepEqual(CONVENTIONS.sections.filter((s) => s.required).map((s) => s.id), ["naming", "layerRules", "errors", "tests"]);
  });
});
