/**
 * 호스트별 표기의 배선(FLOW-11·HP-5·OPT-8) — CLI·hook 의 사용자 문구가 hostText 표기 함수를 쓴다.
 *
 * Claude 표기는 배선 전 문자열과 바이트가 같다(예외 셋: setup 추천의 질문 도구 문장, setup 의 `현재 호스트 세션에서`,
 * 요구 반려의 `Claude Code 에서 ` 삭제). Codex 진입(codexHook)은 Codex 표기로 판정하고, CLI 는 설치·실행 환경으로 표기를 고른다.
 * Codex 사본(codexText)에는 Claude 도구 이름·상한값이 남지 않는다. 원인별 안내 문구는 호스트 중립이다.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { codexHook } from "../agent/codexHook";
import { checkProjectDocs, recordDocConfirmation } from "../agent/docs";
import { docsBegin, docsEnd } from "../agent/docsCommands";
import { contextHandoff } from "../agent/handoff";
import { decide } from "../agent/hook";
import { hostAssets } from "../agent/hosts";
import { useNotation, withNotation } from "../agent/hostText";
import { loadActive } from "../agent/layout";
import { decideRequest, requestContext } from "../agent/request";
import { withInteraction } from "../agent/tty";
import { FAILURE_CLASSES, GUIDE_KEYS, GUIDE_VARIANT_KEYS, guidance } from "../agent/retryPolicy";
import { interview, SCHEMAS } from "../agent/schemas";
import { recommendSetup, setupProject } from "../agent/setup";
import { decideStop } from "../agent/stopHook";
import { verify } from "../agent/verificationFlow";
import { loadManifestIfAny } from "../agent/work";
import { context, next, submitPlan } from "../agent/commands";
import { start } from "./confirmedStart";
import {
  approve, createStageRepo, DESIGN, FUNCTIONAL, IMPACT, ORDER, PLAN, removeStageRepo, repo, REQUIREMENTS, TEST_SPEC, toCheck, write,
} from "./stageFixture";

const source = join(__dirname, "..", "..", "src", "agent");
const cli = join(__dirname, "..", "agent", "cli.js");
const MARKERS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_CI", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_THREAD_ID", "CODE_AGENT_HOST", "CODE_AGENT_CROSS", "CLAUDE_PROJECT_DIR"];
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of MARKERS) delete env[key];
  return { ...env, ...extra };
}
const nextOf = (text: string): string => text.split("\n").find((line) => line.startsWith("다음: ")) ?? "";

describe("Codex 사본과 안내 문구 — 호스트 중립", () => {
  test("Codex 사본에는 Claude 도구 이름·상한값이 남지 않고 장시간 실행 문장은 문장째 바뀐다", () => {
    const bad = [/(?<![\w/])\/ca-[a-z]/, /AskUserQuestion/, /\bBash\b/, /run_in_background/, /subagent_type/, /600000ms/, /timeout 을/];
    let longRun = 0;
    for (const [file, text] of hostAssets("codex")) {
      for (const pattern of bad) assert.doesNotMatch(text, pattern, `${file}: ${pattern}`);
      if (text.includes("셸 명령의 제한 시간을 가장 길게")) longRun += 1;
    }
    assert.equal(longRun, 4, "ca-check·ca-test·ca-integrate·ca-implement 의 정본 문장이 바뀌었다");
    const claude = hostAssets("claude");
    const original = "Bash 도구의 timeout 을 최대(600000ms)로 주고, 그보다 긴 저장소는 백그라운드 실행(`run_in_background`) 뒤 완료 알림을 기다린다.";
    assert.equal([...claude.values()].filter((text) => text.includes(original)).length, 4, "Claude 원본은 정본 문장을 글자 그대로 쓴다");
  });

  test("원인별 안내(기본·변형)는 스킬·도구 이름 없이 모든 자리표시를 채운다", () => {
    const forbidden = [/\/ca-/, /\$ca-/, /AskUserQuestion/, /\bBash\b/, /run_in_background/, /600000ms/, /\{[A-Za-z]\w*\}/];
    for (const cls of FAILURE_CLASSES) {
      const values = Object.fromEntries(GUIDE_KEYS[cls].map((key) => [key, "v"]));
      for (const pattern of forbidden) assert.doesNotMatch(guidance(cls, values), pattern, `${cls}: ${pattern}`);
      for (const [variant, keys] of Object.entries(GUIDE_VARIANT_KEYS[cls] ?? {})) {
        const text = guidance(cls, Object.fromEntries(keys.map((key) => [key, "v"])), variant);
        for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${cls}/${variant}: ${pattern}`);
      }
    }
  });

  test("CLI 소스의 문자열에 Claude Bash 도구의 장시간 실행 표현이 없다", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".ts") && name !== "hosts.ts") files.push(path);
      }
    };
    walk(source);
    for (const file of files) {
      // 주석을 걷어 내고 문자열만 남은 줄을 본다
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      assert.doesNotMatch(code, /Bash timeout|Bash 도구의|run_in_background/, file);
    }
  });
});

describe("CLI 표기 — 설치·실행 환경", () => {
  let root: string;
  beforeEach(() => {
    // git 저장소가 아니면 준비 커밋을 보지 않는다 — 문서만 확정해 '작업 없음' 의 접수 안내를 보게 한다
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-notation-")));
    docsBegin(root); setupProject(root, "node"); docsEnd(root);
    for (const check of checkProjectDocs(root, loadManifestIfAny(root))) recordDocConfirmation(root, check, "test", { channel: "tty", verified: true, detail: "test" });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const hosts = (value: string[] | undefined) => {
    mkdirSync(join(root, ".code-agent"), { recursive: true });
    if (value) writeFileSync(join(root, ".code-agent", "hosts.json"), JSON.stringify(value));
    else rmSync(join(root, ".code-agent", "hosts.json"), { force: true });
  };
  const statusOf = (extra: Record<string, string> = {}) => spawnSync(process.execPath, [cli, "status"], { cwd: root, env: cleanEnv(extra), encoding: "utf8" }).stdout;

  test("status 의 다음: 이 설치 호스트·실행 환경 표기를 따른다", () => {
    hosts(["codex"]);
    const codex = nextOf(statusOf({ CLAUDECODE: "1" }));
    assert.match(codex, /^다음: \$ca-request \[ID\]/);
    assert.doesNotMatch(codex, /\/ca-/);
    hosts(undefined);
    assert.match(nextOf(statusOf()), /^다음: \/ca-request \[ID\][\s\S]*\/ca-feature/);
    hosts(["claude", "codex"]);
    assert.match(nextOf(statusOf()), /^다음: \/ca-request\(\$ca-request\) \[ID\]/, "판별할 수 없으면 중립");
    assert.match(nextOf(statusOf({ CLAUDECODE: "1" })), /^다음: \/ca-request \[ID\]/);
    assert.match(nextOf(statusOf({ CODE_AGENT_HOST: "codex" })), /^다음: \$ca-request \[ID\]/);
  });

  test("--help 는 호스트 중립이다", () => {
    const help = spawnSync(process.execPath, [cli, "--help"], { cwd: root, env: cleanEnv(), encoding: "utf8" }).stdout;
    assert.doesNotMatch(help, /Claude Code의 선택 도구/);
    assert.match(help, /\/ca-request/);
    assert.match(help, /\$ca-request/);
    assert.match(help, /code-agent takeover/);
    assert.match(help, /code-agent approve \[--comment <메모>\]/);
  });

  test("Claude 바이트 — 배선 전 문자열과 같고 예외 세 줄만 바뀐다", () => {
    // next 의 미응답 질문·context 의 계획 밖 질문은 아래 'hook·검증' 의 실제 함수 시험이, fix 재현 절은 fix-flow 가 본다
    withNotation("claude", () => {
      // 접수 출력은 질문 규칙을 다시 싣지 않는다(C7 OPT-14 — 원천은 ca-request 스킬) — 질문 도구 이름도 없다
      assert.doesNotMatch(requestContext(root, { id: "W-1", kind: "feature", startedAt: "" }), /AskUserQuestion|최대 4개 질문/);
      assert.match(interview(SCHEMAS.architecture), /추천·이유·선택지를 구성해 AskUserQuestion으로 받습니다\./);
      assert.match(decide({ cwd: root, tool_name: "Bash", tool_input: { command: "cat .code-agent/active.json" } }) ?? "", /작업 상태 · 승인과 확정 원장을 Bash 로 건드리지 않습니다/);
    });
    // 예외 — setup 추천의 질문 도구 문장(호출합니다 → 으로 묻습니다), setup 의 호스트 세션
    const empty = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-notation-empty-")));
    try {
      assert.match(recommendSetup(empty), /전체 후보를 보여 준 뒤 AskUserQuestion으로 묻습니다\./);
      docsBegin(empty);
      const made = setupProject(empty, "python");
      docsEnd(empty);
      assert.match(made, /현재 호스트 세션에서 ca-answer의 setup 동의 절차로/);
      assert.doesNotMatch(made, /현재 Claude 세션에서/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("hook·검증의 Codex 표기", () => {
  beforeEach(() => createStageRepo("ca-notation-stage-"));
  afterEach(() => removeStageRepo());

  test("세션 밖 지시서 쓰기 거부 — Codex 진입은 $ca-request, Claude 판정은 /ca-request", () => {
    const target = join(repo, "doc/work/X-1/requirement.md");
    const out = codexHook({ cwd: repo, hook_event_name: "PreToolUse", tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Add File: doc/work/X-1/requirement.md\n+x\n*** End Patch" } }) as { hookSpecificOutput?: { permissionDecisionReason?: string } };
    const reason = out.hookSpecificOutput?.permissionDecisionReason ?? "";
    assert.match(reason, /\$ca-request 로 접수하고/);
    assert.doesNotMatch(reason, /\/ca-request/);
    assert.match(decide({ cwd: repo, tool_name: "Write", tool_input: { file_path: target } }) ?? "", /요구사항은 \/ca-request 로 접수하고/);
  });

  test("Stop 의 미응답 질문 — Codex 는 질문 도구 표기로 조사까지 맞고 Claude 는 그대로다", () => {
    toCheck();
    write("doc/work/ORD-1/questions.md", "## Q1 · 검증\n무엇을 더 볼까?\n[Answer]:\n");
    const codex = (codexHook({ cwd: repo, hook_event_name: "Stop" }) as { reason?: string }).reason ?? "";
    assert.match(codex, /메인이 ca-answer 공통 절차의 Codex 질문 도구\(없으면 대화\)로 답을 받고 기록합니다/);
    assert.doesNotMatch(codex, /AskUserQuestion/);
    assert.match(decideStop({ cwd: repo }) ?? "", /메인이 ca-answer 공통 절차의 AskUserQuestion으로 답을 받고 기록합니다\. 미응답이면 멈춥니다/);
  });

  test("hook 셸 거부 문구 — Claude 는 Bash·Write/Edit, Codex 는 셸·apply_patch", () => {
    toCheck();
    const claude = decide({ cwd: repo, tool_name: "Bash", tool_input: { command: "ls" } }) ?? "";
    assert.match(claude, /^작업 중에는 Bash 로 code-agent 명령\(/);
    assert.match(claude, /파일은 Write\/Edit 로 고치고, 읽기는 Read\/Grep\/Glob 을 쓰세요\.$/);
    const codex = (codexHook({ cwd: repo, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }) as
      { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason ?? "";
    assert.match(codex, /^작업 중에는 셸로 code-agent 명령\(/);
    assert.match(codex, /파일은 apply_patch로 고치고, 읽기는 code-agent read <파일> \[시작 줄\] \[줄 수\]를 쓰세요\./);
    assert.match(codex, /Windows PowerShell.*code-agent\.cmd/);
  });

  const codexReason = (command: string): string | undefined => (codexHook({ cwd: repo, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }) as
    { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason;

  test("세션 밖 hook 설정 거부 — Claude 는 Read 도구, Codex 는 code-agent read 로 읽고 그 명령은 열린다", () => {
    const claude = decide({ cwd: repo, tool_name: "Bash", tool_input: { command: "cat .codex/hooks.json" } });
    assert.equal(claude, "호스트 hook 설정(.claude/settings.json · .claude/settings.local.json · .codex/hooks.json · .codex/config.toml)은 셸로 다루지 않습니다 — 읽기는 Read 도구로 하고, 설치·갱신은 사람이 code-agent init 또는 code-agent update --templates-only 로 합니다. 설정이 지워지면 code-agent 의 모든 판정이 꺼집니다.");
    const codex = codexReason("cat .codex/hooks.json") ?? "";
    assert.match(codex, /— 읽기는 code-agent read 로 하고, 설치·갱신은 사람이/);
    assert.doesNotMatch(codex, /Read 도구/);
    assert.equal(codexReason("code-agent read .codex/hooks.json"), undefined, "안내한 읽기 명령은 열린다");
    assert.equal(decide({ cwd: repo, tool_name: "Bash", tool_input: { command: "code-agent read .claude/settings.json" } }), undefined);
    assert.match(codexReason("code-agent read .codex/hooks.json; rm x") ?? "", /호스트 hook 설정/, "연결자가 붙으면 그대로 막는다");
    assert.match(decide({ cwd: repo, tool_name: "PowerShell", tool_input: { command: "code-agent read .codex/hooks.json $(rm x)" } }) ?? "", /호스트 hook 설정/);
  });

  test("상태·설정을 읽지 못했을 때 — Codex 는 code-agent read·apply_patch 로 안내하고 그 읽기를 연다", () => {
    toCheck();
    write("code-agent.json", "{broken");
    const claude = decide({ cwd: repo, tool_name: "Bash", tool_input: { command: "git status" } }) ?? "";
    assert.match(claude, / — Read 로 원인을 확인하고 Write\/Edit 로 code-agent\.json 을 고친 뒤 code-agent manifest check 로 확인하세요\.$/);
    const codex = codexReason("git status") ?? "";
    assert.match(codex, /^code-agent 상태·설정을 읽지 못했습니다: /);
    assert.match(codex, / — code-agent read 로 원인을 확인하고 apply_patch 로 code-agent\.json 을 고친 뒤 code-agent manifest check 로 확인하세요\.$/);
    assert.doesNotMatch(codex, /Read 로|Write\/Edit/);
    assert.equal(codexReason("code-agent read code-agent.json"), undefined, "Codex 의 유일한 읽기 길");
    assert.equal(codexReason("code-agent manifest check"), undefined);
    assert.match(codexReason("code-agent read code-agent.json && git add .") ?? "", /읽지 못했습니다/);
    const patched = codexHook({ cwd: repo, hook_event_name: "PreToolUse", tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: src/a.ts\n+x\n*** End Patch" } }) as { hookSpecificOutput?: { permissionDecisionReason?: string } };
    assert.match(patched.hookSpecificOutput?.permissionDecisionReason ?? "", /code-agent read 로 원인을 확인하고 apply_patch 로/);
  });

  test("Claude 바이트 — next 의 미응답 질문 문장이 배선 전 문자열과 같고, context 의 계획 밖 문장은 서브에이전트 제약이다", () => {
    toCheck();
    // context --file 은 서브에이전트가 읽는다 — 사람에게 묻는 것은 메인이라 질문 도구 이름이 없고 두 호스트가 같다(C7 OPT-16)
    const outside = "계획 밖을 고쳐야 하면 고치지 말고 메인에게 보고합니다 — 메인이 doc/work/ORD-1/questions.md 에 질문으로 남기고, 사람의 답과 재계획·재승인 뒤에만 구현합니다.";
    assert.ok(withNotation("claude", () => context(repo)).split("\n").includes(outside));
    assert.ok(withNotation("codex", () => context(repo)).split("\n").includes(outside));
    assert.doesNotMatch(withNotation("claude", () => context(repo)), /AskUserQuestion/);
    write("doc/work/ORD-1/questions.md", "## Q1 · 검증\n무엇을 더 볼까?\n[Answer]:\n");
    const stopOf = (run: () => unknown): string => { try { run(); } catch (error) { return (error as Error).message; } return ""; };
    const claude = stopOf(() => withNotation("claude", () => next(repo))).split("\n");
    assert.equal(claude[0], "답이 없는 질문이 1개 있어 넘어갈 수 없습니다 (doc/work/ORD-1/questions.md):");
    assert.equal(claude.at(-1), "메인은 /ca-answer 공통 절차의 AskUserQuestion으로 답을 받아 기록하세요.");
    assert.equal(stopOf(() => withNotation("codex", () => next(repo))).split("\n").at(-1), "메인은 $ca-answer 공통 절차의 Codex 질문 도구(없으면 대화)로 답을 받아 기록하세요.");
  });

  test("요구 반려 결과에서 'Claude Code 에서' 가 빠졌다(예외)", () => {
    const text = withInteraction({ confirm: () => ({ channel: "tty", verified: true, detail: "test" }), ask: () => "" },
      () => decideRequest(repo, "ORD-1", "rejected", "다시 정리", "doc/work/ORD-1.md"));
    assert.equal(text, "ORD-1 요구사항 반려를 남겼습니다. /ca-request 가 사유를 읽고 다시 정리합니다.");
  });

  test("verify 의 resume 과 context --file 의 담당이 호스트 표기다", async () => {
    toCheck();
    useNotation("codex");
    try {
      const result = await verify(repo);
      assert.equal(result.node, "review");
      assert.equal(result.resume, "$ca-review");
    } finally {
      useNotation("claude");
    }
  });

  test("implement 테스트 단계의 담당은 Codex 에서 ca_tester 다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    write("doc/work/ORD-1/01-requirements.md", REQUIREMENTS);
    write("doc/work/ORD-1/02-analysis.md", IMPACT);
    write("doc/work/ORD-1/03-design.md", DESIGN);
    write("doc/work/ORD-1/04-functional.md", FUNCTIONAL);
    write("doc/work/ORD-1/07-test-spec.md", TEST_SPEC);
    next(repo); next(repo); next(repo);
    write("doc/work/ORD-1/plan.json", JSON.stringify(PLAN));
    submitPlan(repo, join(repo, "doc/work/ORD-1/plan.json"));
    approve();
    next(repo);
    write(`${ORDER}/domain/Order.java`, "class Order {}\n");
    next(repo);
    write(`${ORDER}/repository/OrderRepository.java`, "interface OrderRepository {}\n");
    next(repo);
    assert.equal(loadActive(repo)!.stage, "test");
    assert.match(withNotation("codex", () => contextHandoff(repo)), /^- 담당: ca_tester$/m);
    assert.match(contextHandoff(repo), /^- 담당: ca-tester$/m);
  });
});
