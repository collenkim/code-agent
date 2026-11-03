import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { abort } from "../agent/commands";
import { start } from "./confirmedStart";

import { loadActive, saveActive } from "../agent/layout";
import { APP, ORDER, PLAN, repo, write, writeFile, bash, submit, toPlan, toImplement, hook } from "./agentFixture";

import "./agentFixture";
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
    // 읽기 전용 조회(doctor)와 작업 임대 해제(takeover — 사용자 확인 뒤, 스킬 규칙)도 연다
    for (const command of ["code-agent doctor", "code-agent doctor --host codex", "code-agent doctor --cross", "code-agent takeover"]) assert.equal(bash(command), undefined, command);
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
      "code-agent model writer gpt-6-luna --host codex --reasoning high",
      "code-agent model writer sonnet --host claude --effort high",
    ]) {
      assert.match(bash(human) ?? "", /현재 세션의 ca-answer 동의 절차/, human);
    }
    // 앞 11글자를 무엇으로 채워도 서브명령 대조를 통과하지 못한다 — code-agent 명령이 아니므로 동의 문장은 붙지 않는다
    assert.match(bash("echo hello next") ?? "", /^작업 중에는 /);
    assert.doesNotMatch(bash("echo hello next") ?? "", /ca-answer/);
    for (const skill of [
      "code-agent start doc/work/ORD-1.md",
      "code-agent next",
      "code-agent context",
      "code-agent status",
      "code-agent model",
      "code-agent model --host codex",
      "code-agent model --host claude",
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
