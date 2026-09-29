import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { recordDecision } from "../core/approval";
import { abort, context, formatAssumptions, next, start, status, Stop, submitPlan, decide as decideApproval } from "../agent/commands";
import { decide } from "../agent/hook";
import { init } from "../agent/init";
import { loadActive, saveActive } from "../agent/layout";
import { parseQuestions } from "../agent/questions";
import { parseAnalysis } from "../agent/analysis";
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
  "## 테스트 규칙", "- 슬라이스 테스트",
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
    decision: "approved",
    approver: "test",
    presence: { channel: "tty", verified: true, detail: "테스트" },
  });
}

function submit(plan: unknown = PLAN): string {
  write("doc/work/ORD-1/plan.json", JSON.stringify(plan));
  return submitPlan(repo, join(repo, "doc/work/ORD-1/plan.json"));
}

const ANALYSIS = [
  "# ORD-1 요구사항 분석",
  "## R1 · 주문 등록", "근거: \"주문은 id, 주문번호, 금액을 가진다.\"", "- 데이터: 만든다",
  "## R2 · 주문 조회", "- 데이터: 안 건드린다",
  "## 작업 문서", "- data.md",
].join("\n");

const DATA_DOC = "# 데이터 정의\n\n## 대상 엔티티\n- Order (새로, R1)\n\n## 필드\n- id: Long\n";

/** 분석 스테이지의 산출물 — analysis.md 와 그것이 부른 작업 문서 */
function analyze(analysis = ANALYSIS): void {
  write("doc/work/ORD-1/analysis.md", analysis);
  write("doc/work/ORD-1/data.md", DATA_DOC);
}

/** start → analysis → research → plan 까지 */
function toPlan(): void {
  start(repo, join(repo, "doc/work/ORD-1.md"));
  analyze();
  next(repo);
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
  confirmDocs();
  write(`${APP}/deal/domain/Deal.java`, "public class Deal {}\n");
  write(`${APP}/deal/repository/DealRepository.java`, "public interface DealRepository {}\n");
  write("doc/work/ORD-1.md", "---\nkind: feature\nid: ORD-1\ntitle: 주문 도메인 추가\ntarget: order\n---\n\n주문은 id, 주문번호, 금액을 가진다.\n");
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
    assert.equal(writeFile("doc/work/ORD-1/analysis.md"), undefined);
  });

  test("작업 폴더는 쓴다", () => {
    assert.equal(writeFile("doc/work/ORD-1/analysis.md"), undefined);
    assert.equal(writeFile("doc/work/ORD-1/questions.md"), undefined);
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

  test("verify 에서는 계획의 어느 단계 파일이든 고친다 — 계획 밖은 막는다", () => {
    toImplement();
    saveActive(repo, { ...loadActive(repo)!, phase: "verify", stage: undefined });
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
    analyze();
    writeFileSync(questions, `${readFileSync(questions, "utf-8")}\n## Q1 · 요구사항 분석\n금액 타입은?\nA. Long\nB. BigDecimal\n[Answer]:\n`);
    assert.throws(() => next(repo), /답이 없는 질문이 1개/);
    writeFileSync(questions, readFileSync(questions, "utf-8").replace(/\[Answer\]:\n$/, "[Answer]: B\n"));
    next(repo);
    assert.equal(loadActive(repo)!.phase, "research");
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

  test("단계의 계획 파일이 모두 있어야 다음 단계로, 마지막 뒤에는 verify 로", () => {
    toImplement();
    assert.throws(() => next(repo), /단계 entity 의 계획 파일이 아직 없습니다/);
    write(`${ORDER}/domain/Order.java`, "class Order {}\n");
    next(repo);
    assert.equal(loadActive(repo)!.stage, "repository");
    write(`${ORDER}/repository/OrderRepository.java`, "interface OrderRepository {}\n");
    next(repo);
    assert.equal(loadActive(repo)!.phase, "verify");
  });

  test("계획에 파일이 없는 단계는 구현에서 건너뛴다 — 빈손으로 서브에이전트를 보내지 않는다", () => {
    toPlan();
    submit({ ...PLAN, files: [{ ...PLAN.files[1], requirements: ["R1", "R2"] }] });
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
    write("doc/work/REF-1/analysis.md",
      ["## R1 · 경계 정리", "- 데이터: 안 건드린다", "## 작업 문서", "- 없음", ""].join("\n"));
    next(repo);
    next(repo);

    const base = {
      files: [{ stage: "restructure", path: `${DEAL}/domain/Deal.java`, purpose: "경계를 옮긴다", requirements: ["R1"] }],
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

describe("분석 · 작업 문서 · 요구 항목 대조", () => {
  const begin = () => start(repo, join(repo, "doc/work/ORD-1.md"));

  test("분석 결과가 없으면 조사로 넘어가지 않는다", () => {
    begin();
    assert.throws(() => next(repo), /요구사항 분석 결과가 없습니다: doc\/work\/ORD-1\/analysis\.md/);
  });

  test("요구 항목·작업 문서 섹션이 없으면 무엇이 틀렸는지 알린다", () => {
    begin();
    write("doc/work/ORD-1/analysis.md", "# 분석\n\n주문을 만든다.\n");
    assert.throws(() => next(repo), /요구 항목\(`## R1 · …`\)이 없습니다[\s\S]*`## 작업 문서` 섹션이 없습니다/);
    write("doc/work/ORD-1/analysis.md", "## R1 · a\n## R1 · b\n## 작업 문서\n");
    assert.throws(() => next(repo), /번호가 겹칩니다: R1[\s\S]*`## 작업 문서` 가 비어 있습니다/);
  });

  test("분석이 부른 작업 문서가 없거나 비어 있으면 계획으로 넘어가지 않는다", () => {
    begin();
    write("doc/work/ORD-1/analysis.md", ANALYSIS.replace("- data.md", "- data.md\n- doc/dictionary.md"));
    next(repo);
    write("doc/work/ORD-1/data.md", "  \n");
    assert.throws(() => next(repo), /갖춰지지 않았습니다:\n  - doc\/work\/ORD-1\/data\.md — 비어 있습니다\n  - doc\/dictionary\.md — 없습니다/);
    write("doc/work/ORD-1/data.md", "# 데이터 정의\n\n## 대상 엔티티\n- Order\n\n## 필드\n확인 필요\n");
    write("doc/dictionary.md", "# 사전\n");
    assert.throws(() => next(repo), /data\.md — 필수 섹션이 비었습니다: 필드 \(code-agent docs skeleton data\)/);
    write("doc/work/ORD-1/data.md", DATA_DOC);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "plan", "인용한 프로젝트 문서는 섹션 검사를 하지 않는다");
  });

  test("작업 문서는 섹션의 첫 목록만 읽는다 — 뒤에 붙은 설명 목록은 문서가 아니다", () => {
    // 실제 실행에서 analyst 가 목록 뒤에 "판정 근거:" 목록을 붙였다
    const analysis = parseAnalysis(
      "## R1 · 등록\n## 작업 문서\n\n- data.md\n- api.md\n\n판정 근거:\n- data.md: 새 엔티티\n- current.md: 불필요\n",
      "ORD-1",
    );
    assert.deepEqual(analysis.workDocs, ["doc/work/ORD-1/data.md", "doc/work/ORD-1/api.md"]);
  });

  test("작업 문서 제목은 별칭·괄호 설명·하위 제목으로 써도 섹션으로 인정한다", () => {
    // 실제 실행에서 writer 가 뼈대 없이 쓴 제목들
    const api = "## 엔드포인트 목록\n- POST /api/orders\n## R1 · 등록\n### 요청\n- orderNo\n### 응답 (성공, HTTP 200)\n- OrderResponse\n## 오류 응답\n- C001\n";
    assert.ok(checkSections(WORK_SCHEMAS.api, api).every((state) => state.filled));
    const data = "## 대상\n- Order (새로)\n## 엔티티 `Order`\n### 필드\n- orderNo: String\n";
    assert.ok(checkSections(WORK_SCHEMAS.data, data).filter((state) => state.required).every((state) => state.filled));
  });

  test("작업 문서 뼈대는 그 스키마의 필수 섹션을 전부 담는다", () => {
    for (const schema of Object.values(WORK_SCHEMAS)) {
      const states = checkSections(schema, docsSkeleton(schema.kind));
      assert.ok(states.every((state) => state.found), `${schema.kind} 뼈대에 빠진 섹션`);
      assert.ok(states.filter((state) => state.required).every((state) => !state.filled), `${schema.kind} 뼈대는 아직 채워지지 않은 것이다`);
    }
  });

  test("가정은 진행을 막지 않고, 제출 결과·승인 화면에 그대로 보인다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    analyze(`${ANALYSIS}\n\n## 가정\n- 목록은 id 내림차순 — 근거: 일반 관행\n- amount 는 precision 15, scale 2 — 근거: 선례 없음\n\n판정 근거:\n- 이건 가정이 아니다\n`);
    const analysis = parseAnalysis(readFileSync(join(repo, "doc/work/ORD-1/analysis.md"), "utf-8"), "ORD-1");
    assert.deepEqual(analysis.assumptions, ["목록은 id 내림차순 — 근거: 일반 관행", "amount 는 precision 15, scale 2 — 근거: 선례 없음"]);
    next(repo);
    next(repo);
    assert.match(submit(), /가정 2개 — 승인하면 계획과 함께 받아들입니다[\s\S]*- 목록은 id 내림차순/);
    assert.equal(formatAssumptions(parseAnalysis(ANALYSIS, "ORD-1")), undefined, "가정이 없으면 보이지 않는다");
  });

  test("조사 context 는 참조 도메인의 단계별 표준 파일을 준다 — 조사자가 다시 찾지 않게", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    analyze();
    next(repo);
    const text = context(repo);
    assert.match(text, /## 참조 도메인 deal — 단계별 표준 파일/);
    assert.match(text, new RegExp(`- entity \\(도메인 안\\): ${APP}/deal/domain/Deal\\.java`));
    assert.match(text, new RegExp(`- repository \\(도메인 안\\): ${APP}/deal/repository/DealRepository\\.java`));
    assert.match(text, /- 요구 항목: R1, R2/);
  });

  test("작업 문서가 필요 없으면 '없음' 으로 지난다", () => {
    begin();
    write("doc/work/ORD-1/analysis.md", "## R1 · 조회\n## 작업 문서\n- 없음\n");
    next(repo);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "plan");
  });

  test("계획 제출 — 모든 요구 항목이 어느 파일엔가 닿아야 하고, 파일마다 항목을 적는다", () => {
    toPlan();
    const [entity, repository] = PLAN.files;
    assert.throws(
      () => submit({ ...PLAN, files: [entity, { ...repository, requirements: ["R1", "R9"] }] }),
      /분석에 없는 요구 항목 R9[\s\S]*어떤 파일에도 닿지 않는 요구 항목: R2/,
    );
    assert.throws(() => submit({ ...PLAN, files: [{ ...entity, requirements: undefined }, repository] }), /Order\.java: 어느 요구 항목을 위한 파일인지/);
    submit();
  });

  test("승인 뒤 작업 문서가 바뀌면 승인이 무효다 — 계획과 한 묶음이다", () => {
    toPlan();
    submit();
    const work = loadWork(repo)!;
    recordDecision(repo, {
      order: work.order, target: work.active.target, plan: work.plan!, manifest: work.manifest,
      decision: "approved", approver: "test", presence: { channel: "tty", verified: true, detail: "테스트" },
      docsHash: approvalDocsHash(work),
    });
    assert.equal(approvalOf(loadWork(repo)!).status, "approved");
    write("doc/work/ORD-1/data.md", DATA_DOC.replace(/\n/g, "\r\n"));
    assert.equal(approvalOf(loadWork(repo)!).status, "approved", "줄바꿈만 바뀐 것은 같은 것으로 본다");
    write("doc/work/ORD-1/data.md", DATA_DOC.replace("id: Long", "id: String"));
    assert.equal(approvalOf(loadWork(repo)!).status, "stale-docs");
    assert.throws(() => next(repo), /승인되지 않았습니다 \(stale-docs\)/);
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
