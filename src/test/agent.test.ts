import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { recordDecision } from "../core/approval";
import { next, start, status, Stop, submitPlan, decide as decideApproval } from "../agent/commands";
import { decide } from "../agent/hook";
import { init } from "../agent/init";
import { loadActive, saveActive } from "../agent/layout";
import { parseQuestions } from "../agent/questions";
import { loadWork } from "../agent/work";

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
    { stage: "entity", path: `${ORDER}/domain/Order.java`, purpose: "주문 엔티티" },
    { stage: "repository", path: `${ORDER}/repository/OrderRepository.java`, purpose: "저장소" },
  ],
  conventions: [],
  conflicts: [],
  openQuestions: [],
  reasoning: "테스트",
};

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

/** start → analysis → research → plan 까지 */
function toPlan(): void {
  start(repo, join(repo, "doc/work/ORD-1.md"));
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
  write("doc/architecture.md", "# 아키텍처\n");
  write("doc/conventions.md", "# 컨벤션\n");
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

  test("아키텍처가 등록되지 않았으면 시작하지 않는다", () => {
    write("code-agent.json", JSON.stringify({ ...MANIFEST, docs: {} }));
    assert.throws(() => start(repo, join(repo, "doc/work/ORD-1.md")), /docs\.architecture 에 경로가 없습니다/);
  });

  test("컨벤션이 없으면 시작하지 않는다", () => {
    write("code-agent.json", JSON.stringify({ ...MANIFEST, conventions: [] }));
    assert.throws(() => start(repo, join(repo, "doc/work/ORD-1.md")), /코드 컨벤션/);
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
