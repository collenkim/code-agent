import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { recordDecision } from "../core/approval";
import { context, next, status, Stop, decide as decideApproval } from "../agent/commands";
import { start } from "./confirmedStart";
import { init } from "../agent/init";
import { parseQuestions } from "../agent/questions";
import { AGENTS, modelsTable, setModel } from "../agent/models";
import { docsSkeleton } from "../agent/docsCommands";
import { WORK_SCHEMAS } from "../agent/schemas";
import { checkSections } from "../agent/docs";
import { approvalDocsHash, approvalOf, loadWork } from "../agent/work";
import { APP, ORDER, PLAN, ARCH, repo, write, writeFile, submit, REQUIREMENTS, FUNCTIONAL, TEST_SPEC, writeDocs, toPlan, toImpact } from "./agentFixture";

import "./agentFixture";
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
  test("--help·-h 는 사용법만 내고, 모르는 깃발·남는 인자는 아무것도 쓰기 전에 멈춘다 — update·doctor 도 같다", () => {
    const cli = (...args: string[]) => spawnSync(process.execPath, [join(__dirname, "..", "agent", "cli.js"), ...args], { cwd: repo, encoding: "utf8" });
    for (const args of [["init", "--help"], ["init", "-h"], ["doctor", "--help"], ["update", "--templates-only", "--help"]]) {
      const run = cli(...args);
      assert.equal(run.status, 0, args.join(" "));
      assert.match(run.stdout, new RegExp(`^사용법: code-agent ${args[0]} `), args.join(" "));
    }
    for (const args of [["init", "--hots", "claude"], ["init", "extra"], ["update", "--templates-only", "--bogus"], ["doctor", "--crosss"]]) {
      const run = cli(...args);
      assert.equal(run.status, 1, args.join(" "));
      assert.match(run.stderr, /받지 않는 인자: /, args.join(" "));
    }
    for (const path of [".claude", ".agents", ".codex", ".code-agent/hosts.json", ".code-agent/version"]) assert.equal(existsSync(join(repo, path)), false, path);
  });

  test("모르는 명령은 사용법 전문 대신 가까운 명령과 help <명령>을 안내하고, help <명령>은 그 명령의 줄만 낸다", () => {
    const cli = (...args: string[]) => spawnSync(process.execPath, [join(__dirname, "..", "agent", "cli.js"), ...args], { cwd: repo, encoding: "utf8" });
    const typo = cli("planing");
    assert.equal(typo.status, 1);
    assert.match(typo.stderr, /^모르는 명령입니다: planing — planning 이면 code-agent help planning\n사용법: code-agent help <명령> · 전체: code-agent help/);
    assert.ok(typo.stdout.length + typo.stderr.length < 300, "사용법 전문을 싣지 않는다");
    const planning = cli("help", "planning");
    assert.equal(planning.status, 0);
    const lines = planning.stdout.trimEnd().split(/\r?\n/);
    assert.ok(lines.every((line) => /^ {2}code-agent planning |^ {10,}\S/.test(line)), "planning 줄과 이어지는 설명 줄만");
    assert.ok(lines.some((line) => line.includes("--chain 이면")), "이어지는 들여쓴 설명 줄도 함께");
    for (const args of [["help", "bogus"], ["help", "planning", "advance"]]) {
      const run = cli(...args);
      assert.equal(run.status, 1, args.join(" "));
      assert.match(run.stderr, /^모르는 명령입니다: /, args.join(" "));
    }
    for (const args of [[], ["help"], ["--help"], ["-h"]]) {
      const run = cli(...args);
      assert.equal(run.status, 0, args.join(" "));
      assert.match(run.stdout, /^code-agent — /, args.join(" "));
    }
  });

  test("역할별 model·effort가 박혀 설치된다 — 각자 PC의 기본값에 맡기지 않는다", () => {
    init(repo, { cli: "C:/tools/code-agent/dist/agent/cli.js" });
    for (const agent of AGENTS) {
      const text = readFileSync(join(repo, `.claude/agents/ca-${agent}.md`), "utf-8");
      const judgment = ["analyst", "critic", "reviewer"].includes(agent);
      assert.match(text, judgment ? /^model: opus\r?$/m : /^model: sonnet\r?$/m, agent);
      assert.match(text, judgment ? /^effort: high\r?$/m : /^effort: medium\r?$/m, agent);
    }
  });

  test("사람이 바꾼 모델은 다시 설치해도 남고, 바꾸기는 터미널에서만 된다", () => {
    init(repo, { cli: "C:/tools/code-agent/dist/agent/cli.js" });
    assert.throws(() => setModel(repo, "implementer", "sonnet"), /터미널에서만 바꿉니다/);
    assert.throws(() => setModel(repo, "nobody", "sonnet"), /에이전트는/);
    assert.throws(() => setModel(repo, "implementer", "gpt"), /모델은/);
    // 사람이 터미널에서 바꾼 결과를 흉내 낸다 — 파일은 도구로 못 쓰는 .code-agent/ 에 있다
    write(".code-agent/models.json", JSON.stringify({ implementer: "opus" }));
    init(repo, { cli: "C:/tools/code-agent/dist/agent/cli.js" });
    const implementer = readFileSync(join(repo, ".claude/agents/ca-implementer.md"), "utf-8");
    assert.match(implementer, /^model: opus\r?$/m);
    assert.match(implementer, /^effort: medium\r?$/m);
    assert.match(readFileSync(join(repo, ".claude/agents/ca-reviewer.md"), "utf-8"), /^model: opus\r?$/m);
    assert.match(modelsTable(repo), /implementer\s+opus \/ medium\s+실행\s+\(바꿈\)/);
  });

  test("Claude 모델 변경의 잘못된 값은 터미널 검사 전에 거부한다", () => {
    init(repo, { cli: "C:/tools/code-agent/dist/agent/cli.js" });
    assert.throws(() => setModel(repo, "writer", "inherit"), /inherit/);
    assert.throws(() => setModel(repo, "writer", "sonnet", { reasoning: "ultra" }), /Claude 추론 강도/);
    assert.throws(() => setModel(repo, "writer", "default", { reasoning: "high" }), /기본값 복원/);
    assert.throws(() => setModel(repo, "writer", "haiku", { reasoning: "low" }), /추론 강도\(effort\)를 받지 않습니다/);
    assert.throws(() => setModel(repo, "writer", "sonnet", { reasoning: "high" }), /터미널에서만 바꿉니다/, "검증을 통과하면 터미널 검사에 닿는다");
  });

  test("조회 표는 역할별 모델·추론 강도와 등급을 보여 준다", () => {
    init(repo, { cli: "C:/tools/code-agent/dist/agent/cli.js" });
    const table = modelsTable(repo);
    assert.match(table, /analyst\s+opus \/ high\s+판단\s+\(기본\)/);
    assert.match(table, /writer\s+sonnet \/ medium\s+실행\s+\(기본\)/);
    assert.match(table, /--effort <강도>/);
  });

  test("models.json 의 강도 변경은 그 역할의 effort 줄에만 바른다", () => {
    write(".code-agent/models.json", JSON.stringify({ effort: { reviewer: "max" } }));
    init(repo, { cli: "C:/tools/code-agent/dist/agent/cli.js" });
    const reviewer = readFileSync(join(repo, ".claude/agents/ca-reviewer.md"), "utf-8");
    assert.match(reviewer, /^model: opus\r?$/m);
    assert.match(reviewer, /^effort: max\r?$/m);
    assert.match(readFileSync(join(repo, ".claude/agents/ca-analyst.md"), "utf-8"), /^effort: high\r?$/m);
  });

  test("강도를 받지 않는 모델로 바꾼 역할은 effort 줄 없이 설치되고 표에 (지원 안 함)으로 보인다", () => {
    write(".code-agent/models.json", JSON.stringify({ reviewer: "haiku" }));
    init(repo, { cli: "C:/tools/code-agent/dist/agent/cli.js" });
    const reviewer = readFileSync(join(repo, ".claude/agents/ca-reviewer.md"), "utf-8");
    assert.match(reviewer, /^model: haiku\r?$/m);
    assert.doesNotMatch(/^---\r?\n([\s\S]*?)\r?\n---/.exec(reviewer)![1], /^effort:/m);
    assert.match(modelsTable(repo), /reviewer\s+haiku \/ \(지원 안 함\)\s+판단\s+\(바꿈\)/);
  });

  test("다른 hook 과 CLAUDE.md 의 기존 내용을 보존하고, 두 번 돌려도 하나만 남는다", () => {
    write(".claude/settings.json", JSON.stringify({ model: "x", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-check" }] }] } }));
    write("CLAUDE.md", "# 우리 프로젝트\n\n원래 내용\n");
    init(repo, { cli: "C:/tools/code-agent/dist/agent/cli.js" });
    init(repo, { cli: "C:/tools/code-agent/dist/agent/cli.js" });

    const settings = JSON.parse(readFileSync(join(repo, ".claude/settings.json"), "utf-8"));
    assert.equal(settings.model, "x");
    const commands = settings.hooks.PreToolUse.map((entry: { hooks: { command: string }[] }) => entry.hooks[0].command);
    assert.deepEqual(commands, ["other-check", 'node "C:/tools/code-agent/dist/agent/cli.js" hook', 'node "C:/tools/code-agent/dist/agent/cli.js" consent-event']);

    const claude = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    assert.match(claude, /^# 우리 프로젝트\n\n원래 내용\n/);
    assert.equal(claude.split("<!-- code-agent:start -->").length, 2);
    assert.match(readFileSync(join(repo, ".gitignore"), "utf-8"), /\.code-agent\/active\.json/);
    assert.match(readFileSync(join(repo, ".claude/skills/ca-feature/SKILL.md"), "utf-8"), /name: ca-feature/);
    assert.match(readFileSync(join(repo, ".claude/agents/ca-implementer.md"), "utf-8"), /name: ca-implementer/);
  });
});
