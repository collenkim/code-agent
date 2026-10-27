import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { recordDecision } from "../core/approval";
import { abort, back, context, next, requireValidatable, status, Stop, submitPlan } from "../agent/commands";
import { start } from "./confirmedStart";
import { prDocFile } from "../agent/deliver";
import { loadEvidence } from "../agent/evidence";
import { init } from "../agent/init";
import { proposalFile } from "../agent/knowledge";
import { loadActive, saveActive } from "../agent/layout";
import { loadReview, openRound, roundChanges } from "../agent/review";
import { decideStop, runStopHook, STOP_LIST_LIMIT } from "../agent/stopHook";
import { HOOK_LOG, readHookOutputs, reasonKey } from "../agent/hookLog";
import { runHook } from "../agent/hook";
import { changedPaths } from "../agent/tree";
import { check, integrate, runTests } from "../agent/validate";
import { approvalDocsHash, approvalOf, loadWork } from "../agent/work";

/**
 * 스테이지 명령 — 반려된 계획·Stop hook·새 스테이지 context·검증기·브랜치 재시작·설치 템플릿·next·back.
 *
 * p5.test 에서 describe 단위로 옮겼다(이름·본문 그대로 — 이력 추적용). 임시 git 저장소에 실제 함수를 그대로 부른다.
 * 검증 명령은 node 한 줄짜리 스크립트라 통과·실패·없는 실행 파일 세 경우를 이 머신에서 재현할 수 있다.
 */
import {
  ORDER, TEST_FILE, FAIL, PLAN, REQUIREMENTS, IMPACT, DESIGN, FUNCTIONAL, TEST_SPEC, repo, write, git, hook, writeFileHook, approve, useManifest, toCheck, toReview, writeFindings, toDeliver, createStageRepo, removeStageRepo,
} from "./stageFixture";

beforeEach(() => createStageRepo());

/** production hook 진입점의 stdout — CLAUDE_PROJECT_DIR 을 이 저장소로 둔다 */
function hookStdout(run: () => void): string {
  const saved = process.env.CLAUDE_PROJECT_DIR, out = process.stdout.write;
  let printed = "";
  process.env.CLAUDE_PROJECT_DIR = repo;
  process.stdout.write = ((chunk: string) => { printed += chunk; return true; }) as typeof process.stdout.write;
  try { run(); } finally {
    process.stdout.write = out;
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
  }
  return printed;
}

afterEach(() => removeStageRepo());

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

  test("목록은 STOP_LIST_LIMIT 줄까지 싣고, 같은 세션의 같은 사유는 한 번만 막는다 — 목록이 바뀌면 다시 막는다", () => {
    toCheck();
    for (let i = 0; i < STOP_LIST_LIMIT + 3; i++) write(`${ORDER}/domain/Sneaky${String(i).padStart(2, "0")}.java`, "class Sneaky {}\n");
    const run = (session: string): string => {
      const printed = hookStdout(() => assert.equal(runStopHook(JSON.stringify({ cwd: repo, session_id: session, hook_event_name: "Stop" })), 0));
      return printed ? (JSON.parse(printed) as { reason: string }).reason : "";
    };
    const first = run("s1");
    assert.equal(first.split("\n").filter((line) => line.startsWith("  - [")).length, STOP_LIST_LIMIT);
    assert.match(first, /외 3개 — git status 로 확인하세요/);
    assert.equal(run("s1"), "", "같은 세션·같은 사유는 다시 막지 않는다");
    assert.match(run("s2"), /계획 밖의 변경이 남아 있습니다/, "다른 세션은 막는다");
    write(`${ORDER}/domain/Another.java`, "class Another {}\n");
    assert.match(run("s1"), /외 4개/, "목록이 바뀌면 다시 막는다");
    const rows = readHookOutputs(repo).filter((row) => row.event === "Stop");
    assert.deepEqual(rows.map((row) => [row.session, row.kind]), [["s1", "block"], ["s2", "block"], ["s1", "block"]]);
    assert.equal(rows[0].chars, first.length);
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

// ---- 강제 ----

describe("hook · Stop hook · context — 새 스테이지", () => {
  test("모델은 review·integrate 를 부를 수 있고 deliver 는 부를 수 없다", async () => {
    await toReview();
    assert.equal(hook("Bash", { command: "code-agent review" }), undefined);
    assert.equal(hook("Bash", { command: "code-agent integrate" }), undefined);
    assert.match(hook("Bash", { command: "code-agent deliver" }) ?? "", /현재 세션의 ca-answer 동의 절차/);
  });

  test("PreToolUse 거부는 hook 출력 기록에 길이·해시만 남긴다 — 글은 남기지 않는다", async () => {
    await toReview();
    const printed = hookStdout(() => assert.equal(runHook(JSON.stringify({ cwd: repo, session_id: "s1", tool_name: "Bash", tool_input: { command: "code-agent deliver" } })), 0));
    const reason = (JSON.parse(printed) as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason;
    const rows = readHookOutputs(repo);
    assert.deepEqual(rows.map((row) => [row.host, row.event, row.kind, row.tool, row.session, row.chars, row.key]),
      [["claude", "PreToolUse", "deny", "Bash", "s1", reason.length, reasonKey(reason)]]);
    assert.equal(readFileSync(join(repo, HOOK_LOG), "utf8").includes(reason.slice(0, 20)), false);
    hookStdout(() => runHook(JSON.stringify({ cwd: repo, tool_name: "Bash", tool_input: { command: "code-agent status" } })));
    assert.equal(readHookOutputs(repo).length, 1, "허용은 남기지 않는다");
  });

  test("Stop hook 은 implement·deliver 모두 계획 밖 변경을 보고한다", async () => {
    await toDeliver();
    write("anywhere.txt", "도구를 거치지 않고 생긴 파일\n");
    // 동의 흐름에서는 사람이 TTY 앞에 있지 않다 — 반영 동의를 묻기 전에 턴 끝에 한 번 알린다
    assert.match(decideStop({ cwd: repo }) ?? "", /계획 밖의 변경이 남아 있습니다/);

    saveActive(repo, { ...loadActive(repo)!, phase: "implement", stage: "entity" });
    assert.match(decideStop({ cwd: repo }) ?? "", /계획 밖의 변경이 남아 있습니다/);
  });

  test("구현 context 는 그 단계의 AC·업무 규칙 줄과 03·04 절 위치를 뽑아 싣는다 — 담당이 03·04 전체를 다시 읽지 않게", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    write("doc/work/ORD-1/01-requirements.md", REQUIREMENTS);
    next(repo);
    write("doc/work/ORD-1/02-analysis.md", IMPACT);
    next(repo);
    write("doc/work/ORD-1/03-design.md", DESIGN);
    write("doc/work/ORD-1/04-functional.md", FUNCTIONAL);
    next(repo);
    write("doc/work/ORD-1/07-test-spec.md", TEST_SPEC);
    write("doc/work/ORD-1/plan.json", JSON.stringify(PLAN));
    submitPlan(repo, join(repo, "doc/work/ORD-1/plan.json"));
    approve();
    next(repo);
    const text = context(repo);
    const section = text.slice(text.indexOf("## 이 Task 의 근거"));
    assert.match(section, /^doc\/work\/ORD-1\/04-functional\.md\n- \d+: - AC-R1-1: /m);
    assert.match(section, /^- doc\/work\/ORD-1\/03-design\.md · 구성 요소 \d+-\d+ · /m);
    assert.match(section, /^- doc\/work\/ORD-1\/04-functional\.md · 기능 정의 \d+-\d+ · 업무 규칙 /m);
    // 검증 단계 context 도 절 위치를 싣는다(수정 루프의 구현자)
    write(`${ORDER}/domain/Order.java`, "class Order {}\n"); next(repo);
    write(`${ORDER}/repository/OrderRepository.java`, "interface OrderRepository {}\n"); next(repo);
    write(TEST_FILE, "// TC-1 · TC-2\nclass OrderTest {}\n"); next(repo);
    assert.match(context(repo), /## 03·04 절 위치[^\n]*\n- doc\/work\/ORD-1\/04-functional\.md · /);
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
    assert.match(status(repo), /다음: 현재 호스트 세션[\s\S]*plan 동의 절차/);
    approve();
    assert.match(status(repo), /승인됨 — code-agent next 로 넘긴 뒤 \/ca-implement/);
    next(repo);
    assert.match(status(repo), /다음: \/ca-implement \(또는 \/ca-next 로 사이클\)/);
  });

  test("start·next·back 은 전체 status 대신 옮긴 자리 요약만 낸다 — 다음 줄은 status 와 같다", () => {
    const started = start(repo, join(repo, "doc/work/ORD-1.md"));
    const moved = /전체 상태는 code-agent status/;
    assert.match(started, moved);
    assert.doesNotMatch(started, /프로젝트 문서:/);
    write("doc/work/ORD-1/01-requirements.md", REQUIREMENTS);
    const advanced = next(repo);
    assert.match(advanced, moved);
    assert.match(advanced, /스테이지: .*\[impact\]/);
    assert.doesNotMatch(advanced, /프로젝트 문서:/);
    const nextLine = (text: string) => text.split("\n").find((line) => line.startsWith("다음: "));
    assert.equal(nextLine(advanced), nextLine(status(repo)));
    const rewound = back(repo, "analysis");
    assert.match(rewound, moved);
    assert.match(rewound, /스테이지: .*\[analysis\]/);
    assert.equal(nextLine(rewound), nextLine(status(repo)));
  });

  test("2회차 리뷰 context 는 직전 회차 뒤 바뀐 계획 파일과 직전 지적을 재검토 범위로 싣는다", async () => {
    await toReview();
    const first = openRound(requireValidatable(repo, "review"));
    assert.doesNotMatch(first, /재검토 범위/, "1회차는 전부 본다");
    assert.doesNotMatch(context(repo), /재검토 범위/);
    const planned = loadWork(repo)!.plan!.files.map((file) => file.path);
    const changedPath = `${ORDER}/domain/Order.java`;
    assert.ok(planned.includes(changedPath));
    writeFindings(`| F1 | ${changedPath} | 계획 안 | 열림 | 1줄: 근거 R1 · 고치는 방향 |`);
    const log = loadReview(repo, "ORD-1", "order")!;
    assert.equal(Object.keys(log.rounds[0].files ?? {}).length, planned.length, "회차가 계획 파일별 해시를 남긴다");
    write(changedPath, "class Order { long id; }\n");
    // 리뷰 수정은 check 부터 다시 — check 가 커서를 check 로 되감는다
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    next(repo);
    const second = openRound(requireValidatable(repo, "review"));
    assert.ok(second.includes(`재검토 범위: 직전 1회차 뒤 바뀐 계획 파일 1개 (${changedPath})`), second);
    const text = context(repo);
    assert.match(text, /\*\*재검토 범위\*\* — 직전 1회차 뒤 바뀐 계획 파일 1개/);
    assert.match(text, /바뀌지 않은 계획 파일은 직전 회차 판정을 이어받는다/);
    assert.match(text, /직전 1회차 ca-reviewer 지적 — 같은 id·경로로 상태를 갱신한다:\n  \| F1 \|/);
    assert.deepEqual(roundChanges(loadReview(repo, "ORD-1", "order"), planned)?.changed, [changedPath]);
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
    assert.match(status(repo), /다음: 현재 호스트 세션[\s\S]*deliver 동의 절차/);
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

  test("deliver 에서도 사용자 지시로 되감고 반영 동의 무효를 알린다", async () => {
    await toDeliver();
    // 반영 전에 고칠 것이 생기면 수정 루프로 돌아가는 유일한 길이다 — 준비해 둔 deliver 동의는 스냅샷 대조가 무효로 만든다
    assert.match(back(repo, "check"), /반영 확인\(deliver 동의\)/);
    assert.equal(loadActive(repo)!.phase, "check");
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

  test("되감아도 검증 회차·카운터는 줄지 않는다 — 증거는 planHash 에 묶여 있다", async () => {
    useManifest({ build: FAIL });
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
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.retry!.causes["2"], "fix");
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
