import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareConsentFixture } from "./consentFixture";
import { submitPlan } from "../agent/commands";
import { decide as hook } from "../agent/hook";
import { contextHandoff, handoffPlanning } from "../agent/handoff";
import { crossCritic } from "../agent/crossCheck";
import { withCaller } from "./reviewFixture";
import { sessionAnchor } from "../agent/sessionHook";
import { context } from "../agent/commands";
import { loadActive, saveActive } from "../agent/layout";

import { preparePlanning } from "../agent/planning";
import { codexHook } from "../agent/codexHook";
import { withNotation } from "../agent/hostText";
import { hostAssets } from "../agent/hosts";
import { readProjectFile } from "../agent/read";
import { observePlanner, runPlanningHook } from "../agent/planningHook";
import { loadPlanning, planningProblems } from "../agent/planningState";
import { loadWork } from "../agent/work";
import { ID, REQUIREMENTS, TESTS, PLAN, root, advance, write, dispatch, finish, handed, throughDesign, DIR, SPEC } from "./planningFixture";

test("CLI 출력에는 배정 요약과 파일 경로만 남고, 파일에 계약·문서 기준·뼈대가 들어 있다", () => {
  const cli = join(__dirname, "../agent/cli.js");
  const out = execFileSync(process.execPath, [cli, "planning", "advance"], { cwd: root, encoding: "utf8", env: { ...process.env, CODE_AGENT_HOST: "claude" } });
  const [summary] = JSON.parse(out).assignments;
  assert.deepEqual(Object.keys(summary).sort(), ["agent", "assignmentFile", "role", "taskId", "title"], "Claude 는 agent 만 — 배정 ID 는 assignmentFile 이름에 있다");
  assert.ok(out.split("\n").every((line) => !line.startsWith("  ")), "최상위 키마다 한 줄이고 들여쓰지 않는다");
  const full = handed(summary), codex = withNotation("codex", () => JSON.parse(handoffPlanning(root, JSON.stringify(full))));
  assert.deepEqual(codex.hostAgents, { codex: full.hostAgents.codex }, "Codex 는 자기 담당 이름만 함께 받는다");
  const text = readFileSync(join(root, summary.assignmentFile), "utf8");
  assert.match(text, /## 문서 기준[\s\S]*01-requirements\.md 작성 기준/);
  assert.match(text, /## 단계 context[\s\S]*확정된 접수 요구/, "이전 흐름에서 담당이 받던 접수 요구 원문 목록을 함께 넘긴다");
  assert.ok(text.includes(`## 뼈대 — ${DIR}/01-requirements.md`));
  assert.equal(readFileSync(join(root, ".code-agent/work", ID, "handoff/.gitignore"), "utf8"), "*\n");
  assert.equal(handed(summary).resultShape.artifacts[0].staged, `${DIR}/.staging/${handed(summary).resultShape.dispatchId}/01-requirements.md`);
  assert.equal(existsSync(join(root, DIR, ".staging")), false, "staging 폴더는 배정(CLI)이 아니라 담당 시작 hook 이 만든다");
});

test("담당이 staging에 쓴 문서를 완료 hook이 정식 문서로 옮기고, 결과 보고에는 본문이 없다", async () => {
  const item = (await advance()).assignments[0], staged = item.staging[`${DIR}/01-requirements.md`];
  const event = { cwd: root, session_id: "s", agent_id: "planner-1", agent_type: item.agent };
  const write_ = (file: string, agent?: string) => hook({ cwd: root, session_id: "s", agent_id: agent, tool_name: "Write", tool_input: { file_path: join(root, file) } });
  observePlanner({ ...event, hook_event_name: "SubagentStart" });
  assert.equal(readFileSync(join(root, DIR, ".staging/.gitignore"), "utf8"), "*\n", "시작 hook 이 staging 폴더를 연다");
  assert.equal(existsSync(join(root, DIR, ".staging", item.resultShape.dispatchId)), false, "배정별 폴더는 담당의 쓰기가 만든다");
  assert.match(write_(staged)!, /계획 담당만/, "메인은 staging에 대신 쓰지 못한다");
  assert.equal(write_(staged, "planner-1"), undefined);
  assert.match(write_(`${DIR}/questions.md`, "planner-1")!, /staging 경로에만/);
  assert.match(write_(`${DIR}/.staging/forged/01-requirements.md`, "planner-1")!, /staging 경로가 아닙니다/);
  write(staged, REQUIREMENTS);
  const message = JSON.stringify({ ...item.resultShape, status: "completed", summary: "근거 확인", evidence: [{ path: SPEC, line: 1 }] });
  assert.ok(!message.includes("값 반환"));
  observePlanner({ ...event, hook_event_name: "SubagentStop", last_assistant_message: message });
  assert.equal(readFileSync(join(root, DIR, "01-requirements.md"), "utf8"), REQUIREMENTS);
  assert.equal(existsSync(join(root, DIR, ".staging", item.resultShape.dispatchId)), false);
  assert.equal(readFileSync(join(root, DIR, ".staging/.gitignore"), "utf8"), "*\n");
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.result!.artifacts[0].content, REQUIREMENTS);
});

test("배정 밖 staging 경로나 쓰지 않은 staging 문서는 완료로 받지 않는다", async () => {
  const stop = (item: Awaited<ReturnType<typeof advance>>, agent: string, artifacts?: unknown) => {
    const event = { cwd: root, session_id: "s", agent_id: agent, agent_type: item.agent };
    observePlanner({ ...event, hook_event_name: "SubagentStart" });
    observePlanner({ ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify({ ...item.resultShape, status: "completed", summary: "확인", evidence: [{ path: SPEC, line: 1 }], ...(artifacts ? { artifacts } : {}) }) });
  };
  await assert.rejects(async () => stop((await advance()).assignments[0], "planner-a"), /staging 문서가 없습니다/);
  const again = dispatch("analysis");
  write(`${DIR}/.staging/forged/01-requirements.md`, REQUIREMENTS);
  assert.throws(() => stop(again, "planner-b", [{ path: `${DIR}/01-requirements.md`, staged: `${DIR}/.staging/forged/01-requirements.md` }]), /배정된 staging 경로가 아닙니다/);
  assert.equal(existsSync(join(root, DIR, "01-requirements.md")), false);
});

test("완료 hook은 담당이 고칠 수 있는 실패만 한 번 돌려보내고, 기록이 끝난 실패와 이미 막힌 재시도는 막지 않는다", async () => {
  const item = (await advance()).assignments[0], event = { cwd: root, session_id: "s", agent_id: "looping", agent_type: item.agent };
  const report = { ...item.resultShape, status: "completed", summary: "확인", evidence: [{ path: SPEC, line: 1 }] };
  const stop = (message: unknown, extra = {}) => runPlanningHook(JSON.stringify({ ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify(message), ...extra }));
  const saved = process.env.CLAUDE_PROJECT_DIR, quiet = process.stderr.write;
  process.env.CLAUDE_PROJECT_DIR = root; process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    observePlanner({ ...event, hook_event_name: "SubagentStart" });
    assert.equal(stop({ ...report, dispatchId: "other" }), 2, "배정 식별 오류는 담당이 고쳐 다시 보고할 수 있다");
    assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "running", "되돌림은 기록하지 않는다");
    assert.equal(stop(report, { stop_hook_active: true }), 0, "한 번 막힌 재시도는 놓아 준다 — staging 이 없어 실패로 기록한다");
    assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "failed");
    assert.equal(stop(report), 0, "이미 처리한 완료 이벤트가 반복되지 않는다");
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
    process.stderr.write = quiet;
  }
});

test("context --file은 전문을 전달 파일로 두고 메인에게는 첫 줄과 경로만 준다", () => {
  const text = contextHandoff(root), file = `.code-agent/work/${ID}/handoff/context.md`;
  assert.equal(readFileSync(join(root, file), "utf8"), `${context(root)}\n`);
  assert.ok(text.includes(`전문: ${file}`));
  assert.ok(text.split("\n").length <= 3);
});

test("대화 시작·압축 뒤 붙는 진행 상태 — 진행 중인 것이 없으면 아무것도 붙이지 않는다", () => {
  const anchor = sessionAnchor(root);
  assert.ok(anchor.includes(`작업 ${ID} (feature) · 스테이지 analysis`));
  assert.match(anchor.split("\n")[0], /자동 요약 — 이어갈 때는 \/ca-next\)$/);
  assert.doesNotMatch(anchor, /이전 대화 내용이 아니라|동의는 준비한 세션에서만/, "이어가는 방법은 설치 지침 블록에 있고, 기다리는 동의가 없으면 동의 줄도 없다");
  prepareConsentFixture(root, { action: "abort" });
  assert.match(sessionAnchor(root), /\n- 응답·적용을 기다리는 동의가 있다\(.+\)\. 동의는 준비한 세션에서만 적용된다/, "기다리는 동의가 있으면 그 줄만 더한다");
  const empty = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-planning-")));
  try { execFileSync("git", ["init", "-q"], { cwd: empty }); assert.equal(sessionAnchor(empty), ""); }
  finally { rmSync(empty, { recursive: true, force: true }); }
});

test("Codex 담당은 배정 파일을 code-agent read로 읽고, 메인은 staging 을 대신 쓰지 못하며, 쓰기가 거부된 담당은 본문을 실어 완료할 수 있다", () => {
  const cli = join(__dirname, "../agent/cli.js");
  const [summary] = JSON.parse(execFileSync(process.execPath, [cli, "planning", "advance"], { cwd: root, encoding: "utf8" })).assignments;
  const shell = (command: string) => codexHook({ cwd: root, session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
  assert.deepEqual(shell(`code-agent read ${summary.assignmentFile}`), {});
  assert.ok(readProjectFile(root, summary.assignmentFile).split("\n").filter((line) => /^\d+\t/.test(line)).length > 10);
  const item = handed(summary), staged = item.staging[`${DIR}/01-requirements.md`];
  const patch = codexHook({ cwd: root, session_id: "s", hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Add File: ${staged}\n+x\n*** End Patch` } }) as { hookSpecificOutput?: { permissionDecisionReason: string } };
  assert.match(patch.hookSpecificOutput!.permissionDecisionReason, /메인은 계획 문서를 대신 쓰지 않습니다/);
  assert.doesNotMatch(hostAssets("codex").get(".codex/agents/ca-analyst.toml")!, /Codex에서는 staging에 쓰지 않는다/);
  finish(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }, {}, "codex");
  assert.equal(readFileSync(join(root, DIR, "01-requirements.md"), "utf8"), REQUIREMENTS);
});

test("H4 Codex 하위 에이전트 hook 의 agent_id·agent_type 으로 담당을 가른다 — 실행 중인 Codex 계획 담당은 자기 배정의 staging 만 쓴다", async () => {
  const item = (await advance()).assignments[0];
  const staged = item.staging[`${DIR}/01-requirements.md`];
  // Codex 는 하위 에이전트 이벤트에 부모 session_id 와 자기 agent_id·agent_type(ca_x)을 싣는다(0.161.0 실측)
  const sub = { cwd: root, session_id: "s", agent_id: "01a11a65-sub", agent_type: item.agent.replace(/-/g, "_") };
  codexHook({ ...sub, hook_event_name: "SubagentStart" });
  const reason = (input: object) => ((codexHook({ cwd: root, session_id: "s", hook_event_name: "PreToolUse", ...input }) as
    { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason ?? "");
  const patch = (path: string) => ({ tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch` } });
  assert.equal(reason({ ...sub, ...patch(staged) }), "", "자기 배정의 staging 은 apply_patch 로 쓴다");
  assert.equal(reason({ ...sub, ...patch(item.resultFile) }), "", "결과 파일도 자기 배정의 자리에 쓴다");
  assert.match(reason(patch(item.resultFile)), /메인은 계획 문서를 대신 쓰지 않습니다/, "메인은 결과 파일을 대신 쓰지 않는다");
  for (const path of ["src/x.ts", `${DIR}/01-requirements.md`]) {
    assert.match(reason({ ...sub, ...patch(path) }), /계획 담당은 배정 파일의 staging 경로에만 씁니다/, path);
  }
  assert.match(reason({ ...sub, ...patch(`${DIR}/.staging/other-dispatch/01-requirements.md`) }), /실행 중인 배정의 staging 경로가 아닙니다/);
  assert.match(reason({ ...sub, agent_id: "other-agent", ...patch(staged) }), /메인은 계획 문서를 대신 쓰지 않습니다/, "시작이 관찰되지 않은 에이전트는 담당이 아니다");
  // 메인(agent_id 없음)은 이전과 같다 — staging 은 메인이 대신 쓰지 않는다
  assert.match(reason(patch(staged)), /메인은 계획 문서를 대신 쓰지 않습니다/);
  assert.equal(reason({ tool_name: "Bash", tool_input: { command: `code-agent read ${staged}` } }), "");
});

test("결과 JSON 은 배정의 resultFile 에 쓰고 최종 응답은 경로 한 줄이다 — 메인 대화에 결과 본문이 실리지 않는다", async () => {
  const item = (await advance()).assignments[0];
  assert.equal(item.resultFile, `${DIR}/.staging/${item.resultShape.dispatchId}/result.json`);
  assert.match(item.instructions, /결과 JSON은 resultFile 경로에 .* "결과: <resultFile>" 한 줄만 돌려주세요/);
  const sub = { cwd: root, session_id: "s", agent_id: "pointer", agent_type: item.agent };
  observePlanner({ ...sub, hook_event_name: "SubagentStart" });
  const staged = item.staging[`${DIR}/01-requirements.md`];
  write(staged, REQUIREMENTS);
  write(item.resultFile, JSON.stringify({ ...item.resultShape, status: "completed", summary: "근거 확인", evidence: [{ path: SPEC, line: 1 }], facts: [], questions: [], findings: [],
    artifacts: [{ path: `${DIR}/01-requirements.md`, staged }] }));
  observePlanner({ ...sub, hook_event_name: "SubagentStop", last_assistant_message: `결과: ${item.resultFile}` });
  assert.equal(readFileSync(join(root, DIR, "01-requirements.md"), "utf8"), REQUIREMENTS);
  assert.equal(loadPlanning(loadWork(root)!).tasks.find((record) => record.task.id === "analysis")!.attempts.at(-1)!.status, "completed");
  assert.equal(existsSync(join(root, item.resultFile)), false, "완료되면 staging 폴더째 지운다");
});

test("결과 파일 줄이 다른 배정의 자리이거나 파일이 없으면 형식 오류다", async () => {
  const item = (await advance()).assignments[0];
  const sub = { cwd: root, session_id: "s", agent_id: "wrong", agent_type: item.agent };
  observePlanner({ ...sub, hook_event_name: "SubagentStart" });
  assert.throws(() => observePlanner({ ...sub, hook_event_name: "SubagentStop", last_assistant_message: `결과: ${DIR}/.staging/other/result.json` }), /결과 파일 경로가 이 배정의 resultFile 이 아닙니다/);
});

test("형식 교정은 원본의 staging 본문을 지우지 않고 새 배정으로 옮겨 그대로 보존한다", async () => {
  const item = (await advance()).assignments[0], original = item.staging[`${DIR}/01-requirements.md`];
  const event = { cwd: root, session_id: "s", agent_id: "origin", agent_type: item.agent };
  observePlanner({ ...event, hook_event_name: "SubagentStart" });
  write(original, REQUIREMENTS);
  assert.throws(() => observePlanner({ ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify({ ...item.resultShape, status: "completed", summary: 7, evidence: [{ path: SPEC, line: 1 }] }) }), /결과 형식 오류/);
  const repaired = (await advance()).assignments[0];
  assert.equal(repaired.mode, "correction");
  assert.ok(existsSync(join(root, original)), "교정 담당이 다시 읽을 원본 staging 이 남아 있다");
  const moved = repaired.staging[`${DIR}/01-requirements.md`], corrector = { cwd: root, session_id: "s", agent_id: "corrector", agent_type: repaired.agent };
  observePlanner({ ...corrector, hook_event_name: "SubagentStart" });
  write(moved, REQUIREMENTS);
  observePlanner({ ...corrector, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify({ ...repaired.resultShape, status: "completed", summary: "요구 정리", evidence: [{ path: SPEC, line: 1 }] }) });
  assert.equal(readFileSync(join(root, DIR, "01-requirements.md"), "utf8"), REQUIREMENTS);
});

test("계획 단계가 아니면 staging은 닫힌다", () => {
  saveActive(root, { ...loadActive(root)!, phase: "implement" }, "next");
  assert.match(hook({ cwd: root, session_id: "s", agent_id: "implementer", tool_name: "Write", tool_input: { file_path: join(root, DIR, ".staging/x/01-requirements.md") } })!, /계획 단계/);
});

test("다른 호스트를 실행할 수 없으면 그 critic 결과의 교차 검토는 중지로 기록되고 계획을 제출할 수 있다", () => {
  writeFileSync(join(root, ".code-agent/hosts.json"), JSON.stringify(["claude", "codex"]));
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS }); finish(dispatch("critic"));
  assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /교차 검토[\s\S]*실행할 수 없으면 중지로 기록되고 진행합니다/);
  const fake = mkdtempSync(join(tmpdir(), "ca-fake-codex-")), script = join(fake, "codex.cjs");
  writeFileSync(script, "process.stderr.write('Not logged in. Run codex login.'); process.exit(1);\n");
  process.env.CODE_AGENT_CODEX_BIN = script;
  try {
    withCaller("claude", () => {
      assert.match(crossCritic(root, "codex"), /교차 검증 중지[\s\S]*Not logged in/);
      const cross = loadPlanning(loadWork(root)!).cross!;
      assert.equal(cross.status, "unavailable");
      assert.equal(loadPlanning(loadWork(root)!).crossAttempts![0].class, "cross-unavailable");
      assert.ok(!planningProblems(loadWork(root)!, "plan").some((problem) => /교차/.test(problem)));
      // 사람이 아닌 중지는 같은 critic 결과로 지점 한도(3회) 안에서 다시 실행할 수 있다 — 다시 실행할 수 없으면 중지 그대로 진행한다
      assert.match(crossCritic(root, "codex"), /교차 검증 중지[\s\S]*Not logged in/);
      assert.match(crossCritic(root, "codex"), /교차 검증 중지/);
      assert.throws(() => crossCritic(root, "codex"), /한도 3회/);
      assert.equal(loadPlanning(loadWork(root)!).crossAttempts!.length, 3);
      assert.ok(!planningProblems(loadWork(root)!, "plan").some((problem) => /교차/.test(problem)));
    });
    submitPlan(root, join(root, DIR, "plan.json"));
  } finally {
    delete process.env.CODE_AGENT_CODEX_BIN;
    rmSync(fake, { recursive: true, force: true });
  }
});

test("실행 파일 변수가 없는 파일을 가리키면 계획 교차 검토 줄은 실행 전에도 설정 오류 갈래이고, 설정 오류로 막힌 뒤에는 '실행할 수 없으면 중지' 괄호를 달지 않는다(R3)", () => {
  writeFileSync(join(root, ".code-agent/hosts.json"), JSON.stringify(["claude", "codex"]));
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS }); finish(dispatch("critic"));
  const saved = process.env.CODE_AGENT_CODEX_BIN;
  process.env.CODE_AGENT_CODEX_BIN = join(root, "no-such-codex.cjs");
  try {
    withCaller("claude", () => {
      const line = () => planningProblems(loadWork(root)!, "plan").find((problem) => /^교차 검토/.test(problem)) ?? "";
      const before = line();
      assert.match(before, /code-agent planning cross --by codex \(교차 호출 설정 오류 — CODE_AGENT_CODEX_BIN 가 가리키는 파일이 없습니다: [^)]*no-such-codex\.cjs\. 중지로 기록하지 않고 그 지점의 게이트가 막힌다/, before);
      assert.doesNotMatch(before, /실행할 수 없으면 중지로 기록되고 진행합니다/);
      assert.throws(() => crossCritic(root, "codex"), /교차 호출 설정 오류/);
      const after = line();
      assert.match(after, /code-agent planning cross --by codex — 직전 실행: 막힘\(설정 오류\)/, after);
      assert.doesNotMatch(after, /실행할 수 없으면 중지로 기록되고 진행합니다/);
    });
    assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /막힘\(설정 오류\)/);
  } finally {
    if (saved === undefined) delete process.env.CODE_AGENT_CODEX_BIN; else process.env.CODE_AGENT_CODEX_BIN = saved;
  }
});
