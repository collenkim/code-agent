import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import "./consentFixture";
import { next } from "../agent/commands";
import { decide as hook } from "../agent/hook";
import "./reviewFixture";
import { sessionAnchor } from "../agent/sessionHook";
import { planningNextLine } from "../agent/planningChain";
import { loadActive } from "../agent/layout";
import { preparePlanning, repairPlanning } from "../agent/planning";
import { codexHook } from "../agent/codexHook";
import { loadPlanning } from "../agent/planningState";
import { loadWork } from "../agent/work";
import { ID, REQUIREMENTS, FUNCTIONAL, TESTS, PLAN, root, advance, write, dispatch, finish, handed, throughDesign, malformed, editPlanning, ago, toDesign, chain, chainedWithoutGate, DIR } from "./planningFixture";

test("C7 advance 출력의 next 줄 — 배정·대기·게이트·제출, 기존 키(problems)는 그대로", async () => {
  const dispatched = (await chain(false)).view;
  assert.equal(dispatched.action, "dispatch");
  assert.ok("problems" in dispatched);
  assert.match(dispatched.next, /assignmentFile 경로만 넘기고, 완료 알림을 받으면 code-agent planning advance$/);
  assert.equal((await chain(false)).view.action, "wait");
  assert.match((await chain(false)).view.next, /기다린다[\s\S]*planning cancel/);
  finish(handed(dispatched.assignments[0]), { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
  const gate = (await chain(false));
  assert.equal(gate.view.action, "ready-for-gate");
  assert.match(gate.view.next, /^게이트 — code-agent next\./);
  assert.equal(gate.view.chain, undefined);
  assert.equal(loadActive(root)!.phase, "analysis", "연쇄가 아니면 게이트를 시도하지 않는다");
});

test("C7 연쇄 — --chain 안내는 --chain 을 유지하고, 결과가 준비되면 같은 호출로 게이트만 지나며 다음 단계는 배정하지 않는다", async () => {
  const first = (await chain());
  assert.equal(first.view.action, "dispatch");
  assert.match(first.view.next, /code-agent planning advance --chain$/);
  finish(handed(first.view.assignments[0]), { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
  const second = (await chain());
  assert.equal(second.exit, 0);
  assert.equal(second.view.phase, "analysis");
  assert.equal(second.view.action, "ready-for-gate");
  assert.deepEqual(second.view.chain, { from: "analysis", gate: "passed", to: "impact" });
  assert.equal(loadActive(root)!.phase, "impact");
  assert.match(second.view.next, /^게이트 통과\(analysis→impact\)[\s\S]*ca-impact 절차를 읽고 그 1항부터/);
  const state = loadPlanning(loadWork(root)!);
  assert.ok(state.tasks.filter((record) => record.task.role !== "analysis").every((record) => record.attempts.length === 0), "다음 단계 배정이 생기면 안 된다");
});

test("C7 연쇄 — 게이트 거부면 exit 1·chain.rejected·사유 그대로, 커서는 제자리, 자동으로 다시 시도하지 않는다", async () => {
  preparePlanning(root); finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
  // 같은 브랜치의 AI-DLC 작업 — next 가 막고 advance 는 막지 않는다
  write("aidlc/spaces/default/intents/x/aidlc-state.md", "# 상태\n- **Status**: in-progress\n");
  let expected = "";
  try { next(root); } catch (error) { expected = (error as Error).message; }
  assert.ok(expected, "next 가 거부해야 한다");
  const out = (await chain());
  assert.equal(out.view.action, "ready-for-gate", JSON.stringify(out.view));
  assert.equal(out.exit, 1);
  assert.equal(out.view.chain.gate, "rejected");
  assert.equal(out.view.chain.reason, expected);
  assert.equal(out.view.chain.questions, undefined);
  assert.match(out.view.next, /^게이트 거부\(analysis\)/);
  assert.equal(loadActive(root)!.phase, "analysis");
});

test("C7 연쇄 — 답 없는 질문으로 게이트가 거부되면 질문 수를 싣고 ca-answer 뒤 연쇄 advance 로 돌아가게 한다", async () => {
  write(`${DIR}/questions.md`, "# 질문\n## Q1 · 확인\n값은?\n[Requirements]: R1\n[Answer]:\n");
  preparePlanning(root); finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
  const out = (await chain());
  assert.equal(out.view.action, "ready-for-gate");
  assert.equal(out.exit, 1);
  assert.equal(out.view.chain.gate, "rejected");
  assert.equal(out.view.chain.questions, 1);
  assert.match(out.view.next, /질문 1개 때문에 게이트\(analysis\)를 지나지 못했다 — ca-answer 절차로 실제 답을 받아 기록한 뒤 code-agent planning advance --chain$/);
  assert.equal(loadActive(root)!.phase, "analysis");
});

test("C7 연쇄 — 질문이 열려 있어도 다른 사유(AI-DLC)로 거부되면 질문 수를 싣지 않고 그 사유를 전하게 한다", async () => {
  write(`${DIR}/questions.md`, "# 질문\n## Q1 · 확인\n값은?\n[Requirements]: R1\n[Answer]:\n");
  preparePlanning(root); finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
  write("aidlc/spaces/default/intents/x/aidlc-state.md", "# 상태\n- **Status**: in-progress\n");
  let expected = "";
  try { next(root); } catch (error) { expected = (error as Error).message; }
  assert.doesNotMatch(expected, /질문/, "next 는 질문보다 AI-DLC 를 먼저 본다");
  const out = (await chain());
  assert.equal(out.view.action, "ready-for-gate", JSON.stringify(out.view));
  assert.equal(out.exit, 1);
  assert.equal(out.view.chain.reason, expected);
  assert.equal(out.view.chain.questions, undefined);
  assert.match(out.view.next, /^게이트 거부\(analysis\) — chain\.reason/);
  assert.doesNotMatch(out.view.next, /ca-answer/);
});

test("C7 연쇄 — 실패로 막히면 게이트를 시도하지 않고 advance 가 적은 원인·재배정 안내를 낸다", async () => {
  const item = (await advance()).assignments[0]; malformed(item);
  malformed(JSON.parse(repairPlanning(root, "analysis")));
  const out = (await chain());
  assert.equal(out.view.action, "blocked");
  assert.equal(out.exit, 0);
  assert.equal(out.view.chain, undefined);
  assert.match(out.view.next, /^analysis: [\s\S]*planning dispatch로 명시적으로 재배정하세요\.$/);
  assert.equal(loadActive(root)!.phase, "analysis");
});

test("C7 실제 출력 — 되감기(rewind-required)는 rewind.phase·command·auto 로 next 를 만든다", async () => {
  toDesign();
  write("src/current.ts", "export const current = 2;\n");
  const first = await chainedWithoutGate("rewind-required");
  assert.match(first.next, /^앞 단계\(impact\) 계획 작업이 지금 입력과 맞지 않는다 — code-agent back impact 를 실행하고\(같은 사유의 첫 자동 되감기라 사용자 지시 없이 한다\) ca-impact 절차로 잇는다$/);
  const again = await chainedWithoutGate("rewind-required");
  assert.equal(again.rewind.auto, true);
  assert.equal(again.next, first.next);
  assert.equal(loadActive(root)!.phase, "design");
});

test("C7 실제 출력 — stale 은 stale[].id·reason 으로 고아 안내를 만들고 --chain 을 유지한다", async () => {
  (await advance());
  editPlanning((state) => { state.tasks[0].attempts[0].at = ago(11); });
  const view = await chainedWithoutGate("stale");
  assert.ok(view.next.includes("planning cancel analysis"), view.next);
  assert.ok(view.next.includes("담당 시작이 관찰되지 않았습니다(배정 11분 전)"), view.next);
  assert.ok(view.next.includes("code-agent planning advance --chain"), view.next);
  assert.doesNotMatch(view.next, /planning advance(?! --chain)/);
});

test("C7 실제 출력 — 차단 지적(feedback)은 다시 배정 안내를 덧붙이고 되감기 명령을 내지 않는다", async () => {
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  const line = FUNCTIONAL.split("\n").findIndex((row) => row.startsWith("- AC-R1-1")) + 1;
  finish(dispatch("critic"), {}, { findings: [{ id: "F1", severity: "blocking", detail: "AC-R1-1 경계값 TC 없음", source: { path: `${DIR}/04-functional.md`, line } }] });
  const out = (await chain());
  assert.equal(out.view.chain, undefined);
  assert.equal(out.view.next, planningNextLine(out.view, { chained: true, workDir: DIR }));
  assert.equal(out.view.feedback.length, 1);
  assert.match(out.view.next, /^차단 지적 1건 — 계약의 수정 피드백으로 고칠 작업을 다시 배정한다\(feedback\[\]\.citedTask 는 근거 문서를 낸 작업일 뿐[\s\S]*고친 뒤 code-agent planning advance --chain$/);
  assert.doesNotMatch(out.view.next, /code-agent back/);
  assert.equal(loadActive(root)!.phase, "plan");
});

test("C7 연쇄 — plan 단계의 ready-for-gate 는 제출을 안내하고 게이트를 지나지 않는다", async () => {
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  finish(dispatch("critic"));
  const out = (await chain());
  assert.equal(out.view.action, "ready-for-gate");
  assert.equal(out.exit, 0);
  assert.equal(out.view.chain, undefined);
  assert.equal(out.view.next, `계획 제출 — code-agent plan submit ${DIR}/plan.json (ca-plan 끝 절차)`);
  assert.equal(loadActive(root)!.phase, "plan");
});

test("C7 CLI — planning advance 의 모르는 인자는 사용법, hook 은 --chain 을 연다", () => {
  const cli = join(__dirname, "../agent/cli.js");
  const bad = spawnSync(process.execPath, [cli, "planning", "advance", "--bogus"], { cwd: root, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /사용법: code-agent planning advance \[--chain\]/);
  assert.equal(hook({ cwd: root, tool_name: "Bash", tool_input: { command: "code-agent planning advance --chain" } }), undefined);
});

test("C7 SessionStart — 압축·비우기 뒤에는 ca-answer 를 다시 읽으라는 줄을 붙인다(시작·재개·인자 없음에는 없다)", () => {
  const line = /대화가 압축·비워졌다 — 질문·동의 전에 ca-answer 절차/;
  assert.match(sessionAnchor(root, "compact"), line);
  assert.match(sessionAnchor(root, "clear"), line);
  for (const source of ["startup", "resume", undefined]) assert.doesNotMatch(sessionAnchor(root, source), line);
  // 실제 hook 경로 — stdin 의 source 를 읽는다
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR; delete env.CODE_AGENT_CROSS;
  const hookRun = (source: string) => spawnSync(process.execPath, [join(__dirname, "../agent/cli.js"), "session-event"], { cwd: root, env, encoding: "utf8", input: JSON.stringify({ cwd: root, source }) });
  const cleared = hookRun("clear");
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.match(cleared.stdout, line);
  assert.match(cleared.stdout, /\(\.claude\/skills\/ca-answer\/SKILL\.md\)/);
  assert.doesNotMatch(hookRun("startup").stdout, line);
});

test("Codex SessionStart — Claude 와 같은 진행 상태를 additionalContext 로 붙이고, 스킬 이름·경로는 Codex 표기다", async () => {
  (await advance());
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR; delete env.CODE_AGENT_CROSS;
  const codexRun = (source: string) => spawnSync(process.execPath, [join(__dirname, "../agent/cli.js"), "codex-event"], { cwd: root, env, encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd: root, session_id: "codex-s1", source }) });
  const context = (source: string): string => {
    const run = codexRun(source);
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
    assert.equal(out.hookSpecificOutput?.hookEventName, "SessionStart", source);
    return out.hookSpecificOutput?.additionalContext ?? "";
  };
  const compacted = context("compact");
  assert.match(compacted, new RegExp(`작업 ${ID} \\(feature\\) · 스테이지 analysis`));
  assert.match(compacted, /실행 중으로 기록된 계획 배정: analysis\(ca_analyst/, "담당 이름도 Codex 표기다");
  assert.match(compacted, /\$ca-next/);
  assert.doesNotMatch(compacted, /\/ca-next/);
  assert.match(compacted, /ca-answer 절차\(\.agents\/skills\/ca-answer\/SKILL\.md\)를 다시 읽는다/);
  const forked = context("fork");
  assert.match(forked, /code-agent planning cancel analysis/, "분기한 대화에는 이전 대화가 부른 담당의 결과가 돌아오지 않는다");
  assert.doesNotMatch(forked, /ca-answer 절차/);
  const empty = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-planning-")));
  try {
    execFileSync("git", ["init", "-q"], { cwd: empty });
    assert.deepEqual(codexHook({ hook_event_name: "SessionStart", cwd: empty, session_id: "codex-s1", source: "compact" }), {}, "진행 중인 것이 없으면 붙이지 않는다");
  } finally { rmSync(empty, { recursive: true, force: true }); }
});
