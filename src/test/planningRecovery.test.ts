import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import "./consentFixture";
import { back, next, submitPlan } from "../agent/commands";
import { handoffPlanning } from "../agent/handoff";
import { crossCritic, CrossCriticSchema } from "../agent/crossCheck";
import { withCaller } from "./reviewFixture";
import { sessionAnchor } from "../agent/sessionHook";
import { loadActive } from "../agent/layout";
import { cancelPlanning, grantPlanningRetry, planningBudget, preparePlanning, planningStatus, repairPlanning, planningResult } from "../agent/planning";
import { codexHook, runCodexHook } from "../agent/codexHook";
import { hostAssets } from "../agent/hosts";
import { observePlanner, runPlanningHook } from "../agent/planningHook";
import { fileHash, hashedQuestion, inputFiles, invalidatePlanningCache, loadPlanning, planningProblems, taskCurrent, taskHash, ResultSchema, withPlanningCache } from "../agent/planningState";
import { planRuleProblems } from "../agent/planningValidation";
import { planFormatFor } from "../core/plan";
import { parseQuestions, type Question } from "../agent/questions";
import { acquireLock } from "../agent/lock";
import { orphanState } from "../agent/retryPolicy";
import { sha } from "../agent/docs";
import { writeAtomic } from "../core/atomic";
import { loadWork } from "../agent/work";
import { hashManifest } from "../core/approval";
import { deadPid } from "./deadPid";
import { ID, REQUIREMENTS, IMPACT, DESIGN, FUNCTIONAL, TESTS, PLAN, root, advance, write, dispatch, finish, handed, analysis, throughDesign, malformed, planningJson, editPlanning, ago, answer, quiet, quietAsync, captured, startAgent, stopEvent, completed, toDesign, DUPLICATED_AC, DIR, SPEC } from "./planningFixture";

test("design 단계 질문은 출처를 기록하고, 답해도 앞 단계 결과를 다시 돌리지 않는다", async () => {
  toDesign();
  const asked = (await advance()).assignments[0];
  assert.equal(asked.task.id, "design");
  finish(asked, {}, { status: "needs-input", questions: [{ id: "Q1", question: "경계값을 포함할까요?", requirements: ["R1"] }] });
  assert.match(readFileSync(join(root, DIR, "questions.md"), "utf8"), /\[Requirements\]: R1\n\[Origin\]: design\n\[Answer\]:/);
  assert.deepEqual(loadPlanning(loadWork(root)!).questionOrigins, { Q1: "design" }, "코드가 쓴 질문의 출처는 상태에도 남는다");
  answer("Q1", "포함한다");
  const reply = (await advance());
  assert.equal(reply.action, "dispatch");
  assert.equal(reply.rewind, undefined);
  assert.deepEqual(reply.assignments.map((item: any) => item.task.id), ["design"]);
  const states = Object.fromEntries(JSON.parse(planningStatus(root)).tasks.map((task: any) => [task.id, task.state]));
  assert.deepEqual([states.analysis, states.explore, states.synthesis], ["completed", "completed", "completed"]);
  finish(reply.assignments[0], { [`${DIR}/03-design.md`]: DESIGN, [`${DIR}/04-functional.md`]: FUNCTIONAL });
  next(root);
  assert.equal(loadActive(root)!.phase, "plan");
});

test("plan 단계 critic 질문은 critic 만 다시 배정하고 plan 결과를 재사용한다", async () => {
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  finish(dispatch("critic"), {}, { status: "needs-input", questions: [{ id: "Q1", question: "경계값 TC 를 더할까요?", requirements: ["R1"] }] });
  answer("Q1", "더한다");
  const reply = (await advance());
  assert.equal(reply.action, "dispatch");
  assert.equal(reply.rewind, undefined);
  assert.deepEqual(reply.reused, ["plan"]);
  assert.deepEqual(reply.assignments.map((item: any) => item.task.id), ["critic"]);
});

test("2-9 되감기 안내와 거부된 back은 자동 허용을 쓰지 않고 실제 back만 소비한다", async () => {
  toDesign();
  write("src/current.ts", "export const current = 2;\n");
  const reply = (await advance());
  assert.equal(reply.action, "rewind-required");
  assert.deepEqual({ phase: reply.rewind.phase, command: reply.rewind.command, auto: reply.rewind.auto }, { phase: "impact", command: "code-agent back impact", auto: true });
  assert.equal(reply.rewind.notice, undefined, "impact 까지의 되감기는 알림 없이 진행한다");
  assert.deepEqual(reply.rewind.tasks.map((task: any) => task.id), ["explore", "synthesis"]);
  assert.ok(reply.rewind.tasks[0].staleBecause.includes("입력 파일: src/current.ts"), JSON.stringify(reply.rewind.tasks));
  assert.equal(reply.assignments.length, 0);
  const state = loadPlanning(loadWork(root)!);
  assert.equal(state.tasks.find((record) => record.task.id === "design")!.attempts.length, 0, "되감기 판정은 배정하지 않는다");
  assert.equal(state.retry!.rewinds?.length ?? 0, 0);
  assert.throws(() => back(root, "plan"), /뒤로만/);
  // 안내만 여러 번 읽어도 실제 되감기 전에는 허용이 남는다.
  const again = (await advance());
  assert.equal(again.rewind.auto, true);
  assert.equal(loadPlanning(loadWork(root)!).retry!.rewinds?.length ?? 0, 0);
  back(root, "impact");
  assert.equal(loadPlanning(loadWork(root)!).retry!.rewinds!.length, 1);
  assert.deepEqual((await advance()).assignments.map((item: any) => item.task.id), ["explore"]);
});

test("되감아 다시 지난 뒤 같은 사유로 다시 낡으면 자동으로 되감지 않는다", async () => {
  toDesign();
  write("src/current.ts", "export const current = 2;\n");
  assert.equal((await advance()).rewind.auto, true);
  back(root, "impact");
  finish((await advance()).assignments[0], {}, { evidence: [{ path: "src/current.ts", line: 1 }] });
  assert.equal((await advance()).action, "ready-for-gate");
  next(root);
  write("src/current.ts", "export const current = 3;\n");
  const reply = (await advance());
  assert.equal(reply.action, "rewind-required");
  assert.equal(reply.rewind.auto, false);
  assert.match(reply.rewind.reason, /이미 한 번/);
  assert.equal(loadPlanning(loadWork(root)!).retry!.rewinds!.length, 1);
});

test("호스트 지침이 바뀌면 analysis 까지 되감고 다시 도는 작업을 한 줄로 먼저 알린다", async () => {
  toDesign();
  write("CLAUDE.md", "# 프로젝트 지침\n");
  const reply = (await advance());
  assert.equal(reply.action, "rewind-required");
  assert.equal(reply.rewind.phase, "analysis");
  assert.equal(reply.rewind.auto, true);
  assert.match(reply.rewind.notice, /CLAUDE\.md·AGENTS\.md/);
  assert.match(reply.rewind.notice, /계획 작업 4개\(analysis, explore, synthesis, design\)/);
});

test("메모 범위 안의 파일 해시는 stat 으로 검증해 다른 프로세스의 원자 쓰기를 놓치지 않는다", () => {
  analysis(); preparePlanning(root);
  finish(dispatch("explore")); finish(dispatch("synthesis"), { [`${DIR}/02-analysis.md`]: IMPACT });
  const file = `${DIR}/02-analysis.md`, changed = IMPACT.replace("기존 반환값 보존", "기존 반환값 유지");
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(IMPACT));
  withPlanningCache(() => {
    const work = loadWork(root)!, state = loadPlanning(work), synthesis = state.tasks.find((record) => record.task.id === "synthesis")!;
    const before = fileHash(root, file);
    assert.equal(taskCurrent(work, state, synthesis), true);
    writeAtomic(join(root, file), changed);
    assert.notEqual(fileHash(root, file), before, "같은 크기라도 원자 쓰기는 파일 ID 가 바뀌어 다시 읽는다");
    assert.equal(taskCurrent(work, state, synthesis), false);
    writeAtomic(join(root, file), IMPACT);
    assert.equal(fileHash(root, file), before);
    assert.equal(taskCurrent(work, state, synthesis), true);
  });
});

test("메모 범위 — 같은 stat 이면 sha 를 재사용하고 크기가 바뀌면 다시 읽으며, 판정 메모는 무효화 뒤 다시 조립한다", () => {
  const file = "src/current.ts", full = join(root, file), fixed = new Date("2020-01-01T00:00:00.000Z");
  utimesSync(full, fixed, fixed);
  preparePlanning(root);
  withPlanningCache(() => {
    const first = fileHash(root, file);
    writeFileSync(full, "export const current = 9;\n");   // 같은 크기, 제자리 쓰기(파일 ID 그대로)
    utimesSync(full, fixed, fixed);
    assert.equal(fileHash(root, file), first, "stat 이 같으면 sha 를 다시 계산하지 않는다");
    writeFileSync(full, "export const current = 10;\n");
    assert.notEqual(fileHash(root, file), first, "크기가 바뀌면 다시 읽는다");
    const work = loadWork(root)!, state = loadPlanning(work), task = state.tasks[0].task;
    const before = taskHash(work, state, task);
    write(`${DIR}/questions.md`, "# 질문\n\n## Q1 · 범위\n값은?\n[Answer]: 예\n");
    assert.equal(taskHash(work, state, task), before, "판정 메모는 무효화 전까지 그대로 쓴다");
    invalidatePlanningCache();
    assert.notEqual(taskHash(work, state, task), before, "무효화 뒤에는 stat 으로 검증한 부품으로 다시 조립한다");
  });
  // 범위 밖에서는 stat 이 같아도(같은 크기·mtime 복원) 언제나 새로 읽는다
  utimesSync(full, fixed, fixed);
  const outside = fileHash(root, file);
  writeFileSync(full, "export const current = 11;\n");
  utimesSync(full, fixed, fixed);
  assert.notEqual(fileHash(root, file), outside, "범위 밖에서는 메모 없이 새로 계산한다");
  assert.equal(fileHash(root, file), createHash("sha256").update("export const current = 11;\n").digest("hex"));
});

test("교차 검토 질문은 요구 키만 적고 출처를 critic 으로 기록한다 — 답은 critic 만 낡게 하고, 결과의 줄바꿈은 답이 되지 않는다", () => {
  writeFileSync(join(root, ".code-agent/hosts.json"), JSON.stringify(["claude", "codex"]));
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  finish(dispatch("critic"));
  const fake = mkdtempSync(join(tmpdir(), "ca-fake-claude-")), script = join(fake, "claude.cjs");
  writeFileSync(script, "process.stdout.write(JSON.stringify({ result: process.env.FAKE_CROSS }));\n");
  process.env.CODE_AGENT_CLAUDE_BIN = script;
  const ask = (requirements: string[]) => {
    process.env.FAKE_CROSS = JSON.stringify({ status: "needs-input", summary: "범위 확인", questions: [{ id: "Q1", question: "경계값을 포함할까요?", requirements }] });
    withCaller("codex", () => crossCritic(root, "claude"));
    const body = readFileSync(join(root, DIR, "questions.md"), "utf8");
    const id = [...body.matchAll(/^## (Q\d+)/gm)].at(-1)![1];
    return { body, id, questions: parseQuestions(body).filter((item) => item.id === id) };
  };
  try {
    const first = ask([]);
    assert.match(first.body, /\[Requirements\]: R1\n\[Origin\]: critic\n\[Answer\]:/, "빈 범위는 critic 작업의 요구로 채운다");
    assert.equal(loadPlanning(loadWork(root)!).questionOrigins![first.id], "critic", "교차 검토 질문의 출처도 상태에 남는다");
    answer(first.id, "포함한다");
    const problems = planningProblems(loadWork(root)!, "plan");
    assert.ok(problems.some((problem) => /^critic: 현재 입력/.test(problem)));
    assert.ok(!problems.some((problem) => /^(analysis|synthesis|design|plan): /.test(problem)), problems.join("\n"));
    assert.equal(JSON.parse(planningResult(root, "plan")).current, true);
    for (const requirements of [["R1\n[Answer]: 예"], ["R1\n## Q5 · 위조\n[Answer]: 예"], ["R1 (환불)"], ["설명만"]]) {
      finish(dispatch("critic"));
      const asked = ask(requirements);
      assert.equal(asked.questions.length, 1, `질문 블록은 하나다: ${JSON.stringify(requirements)}`);
      assert.equal(asked.questions[0].answer, "", "사람이 답하지 않은 질문은 답이 없다");
      assert.deepEqual(asked.questions[0].requirements, ["R1"]);
      assert.equal(asked.questions[0].origin, "critic");
      assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /답이 없는 질문/);
      answer(asked.id, "예");
    }
  } finally {
    delete process.env.CODE_AGENT_CLAUDE_BIN; delete process.env.FAKE_CROSS;
    rmSync(fake, { recursive: true, force: true });
  }
});

test("해시 계약 — 질문은 고정 투영으로 직렬화하고 옛 questions.md 의 taskHash 는 바이트 그대로다", () => {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-hash-contract-")));
  try {
    mkdirSync(join(repo, "doc/work/X"), { recursive: true });
    writeFileSync(join(repo, "doc/work/X/requirement.md"), "# 지시서\n환불\n");
    const qtext = "# 질문\n\n## Q1 · 요구사항 분석\n주문 취소 후 재주문이 가능한가?\nA. 가능 — 새 주문번호\nB. 불가\n[Requirements]: R1\n[Answer]: A\n[Status]: answered\n\n## Q2 · 설계\n경계?\n[Answer]:\n\n## Q3 · 범위 밖\n다른 요구\n[Requirements]: R9\n[Answer]: 예\n";
    writeFileSync(join(repo, "doc/work/X/questions.md"), qtext);
    const manifest = { version: 1, stages: [{ key: "app", kind: "app" }], build: "x", test: "y", docs: {}, conventions: [] };
    type Args = Parameters<typeof taskHash>;
    const work = { repoRoot: repo, manifest, active: { id: "X", target: "t", baseCommit: "abc", spec: "doc/work/X/requirement.md", phase: "design" }, order: { kind: "feature" } } as unknown as Args[0];
    const task = { id: "design", role: "design", contextVersion: 2, title: "설계", requirements: ["R1"], inputs: ["doc/work/X/requirement.md"], scopes: [], outputs: [], dependsOn: [], questionIds: [] } as Args[2];
    const state = { version: 1, id: "X", target: "t", maxParallel: 3, tasks: [{ task, attempts: [] }], agents: [] } as Args[1];
    // 골든 — 구현 전(c38f1e2) dist 의 taskHash 값이다. 바뀌면 진행 중인 모든 관찰 작업이 다시 돈다
    assert.equal(taskHash(work, state, task), "sha256:db1f7ff0e520c33d");
    const legacy = { ...task }; delete legacy.contextVersion;
    assert.equal(taskHash(work, { ...state, tasks: [{ task: legacy, attempts: [] }] }, legacy), "sha256:c21019bbdf154ea9");
    // 공식 — 직렬화 객체와 손으로 쓴 질문 투영
    const inputs = inputFiles(work, task, state).map((file) => [file, fileHash(repo, file)]);
    const questions = [
      { id: "Q1", title: "Q1 · 요구사항 분석", answer: "A", status: "answered", requirements: ["R1"], content: "Q1 · 요구사항 분석\n주문 취소 후 재주문이 가능한가?\nA. 가능 — 새 주문번호\nB. 불가\n[Requirements]: R1\n[Answer]: A\n[Status]: answered" },
      { id: "Q2", title: "Q2 · 설계", answer: "", content: "Q2 · 설계\n경계?\n[Answer]:" },
    ];
    assert.equal(sha(JSON.stringify({ task, base: "abc", manifest: hashManifest(manifest as never), inputs, hostInstructions: [["CLAUDE.md", "missing"], ["AGENTS.md", "missing"]], dependencies: [], questions })), taskHash(work, state, task));
    assert.equal("origin" in parseQuestions(qtext)[0], false, "[Origin] 이 없는 옛 질문에는 origin 키가 없다");
    const projected = JSON.stringify(hashedQuestion({ ...parseQuestions(qtext)[0], options: { A: "x" }, source: "대화" } as Question, "c"));
    assert.ok(!projected.includes("options") && !projected.includes("source"), projected);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("코드가 기록한 출처의 질문은 출처 작업과 그 후손만 낡게 하고, 기록 없는 [Origin] 줄은 요구 겹침 규칙을 따른다", () => {
  preparePlanning(root);
  finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS + '\n## R2 · 다른 반환\n근거: "값을 반환한다."' }); next(root);
  const base = { role: "explore", title: "영역", inputs: [SPEC], outputs: [], dependsOn: ["analysis"] };
  preparePlanning(root, { tasks: [{ ...base, id: "left", requirements: ["R1"], scopes: ["src"] }, { ...base, id: "right", requirements: ["R2"], scopes: ["other"] },
    { id: "synthesis", role: "synthesis", title: "합성", requirements: ["R1", "R2"], inputs: [SPEC], outputs: [`${DIR}/02-analysis.md`], dependsOn: ["left", "right"] }] });
  finish(dispatch("left")); finish(dispatch("right"));
  finish(dispatch("synthesis"), { [`${DIR}/02-analysis.md`]: IMPACT.replace("| R1 | src/current.ts:1 | 없음 | 새 진입점 |", "| R1 | src/current.ts:1 | 없음 | 새 진입점 |\n| R2 | src/current.ts:1 | 없음 | 새 진입점 |") });
  write(`${DIR}/questions.md`, "# 질문\n\n## Q1 · 영역\n경계값?\n[Requirements]: R2\n[Origin]: left\n[Answer]: 포함한다\n");
  const current = (id: string) => { const work = loadWork(root)!, state = loadPlanning(work); return taskCurrent(work, state, state.tasks.find((record) => record.task.id === id)!); };
  const because = (id: string) => (JSON.parse(planningStatus(root)).tasks.find((task: any) => task.id === id).staleBecause ?? []).join("\n");
  // 메인이 적은 [Origin] 은 검증할 수 없다 — 범위(R2)가 겹치는 right 와 그 후손 synthesis 가 낡는다
  assert.deepEqual(["left", "synthesis", "right"].map(current), [true, false, false]);
  assert.match(because("right"), /질문 Q1 추가·변경\(출처 없음/);
  // 완료 hook·교차 검토가 쓴 질문은 출처를 상태에도 남긴다 — 출처 규칙은 left 와 그 후손(synthesis)만 낡게 한다
  editPlanning((state) => { state.questionOrigins = { Q1: "left" }; });
  assert.deepEqual(["left", "synthesis", "right"].map(current), [false, false, true]);
  assert.match(because("left"), /질문 Q1 추가·변경\(출처 left\)/);
  // 기록과 다른 [Origin] 줄은 믿지 않는다
  editPlanning((state) => { state.questionOrigins = { Q1: "right" }; });
  assert.deepEqual(["left", "synthesis", "right"].map(current), [true, false, false]);
});

test("시작이 관찰되지 않은 채 10분이 지난 배정은 stale 로 보이고 cancel 목록을 낸다", async () => {
  (await advance());
  editPlanning((state) => { state.tasks[0].attempts[0].at = ago(11); });
  const reply = (await advance());
  assert.equal(reply.action, "stale");
  assert.deepEqual(reply.cancel, ["analysis"]);
  assert.equal(reply.stale[0].observedStart, false);
  assert.equal(reply.stale[0].reason, "담당 시작이 관찰되지 않았습니다(배정 11분 전)");
  assert.throws(() => dispatch("analysis"), /담당 시작이 관찰되지 않았습니다\(배정 11분 전\)[\s\S]*planning cancel analysis/);
  cancelPlanning(root, "analysis");
  assert.equal((await advance()).action, "dispatch");
});

test("시작이 관찰된 담당이 60분 넘게 끝나지 않으면 stale 이다", async () => {
  const item = (await advance()).assignments[0];
  startAgent(item, "slow");
  editPlanning((state) => { state.tasks[0].attempts[0].at = ago(62); state.agents[0].startedAt = ago(61); });
  const reply = (await advance());
  assert.equal(reply.action, "stale");
  assert.equal(reply.stale[0].observedStart, true);
  assert.equal(reply.stale[0].reason, "담당이 61분째 끝나지 않았습니다");
});

test("시작 미관찰 기한은 배정 뒤 마지막 담당 활동부터 잰다 — 차례로 실행하는 호스트의 다음 배정은 stale 이 아니다", async () => {
  analysis();
  const base = { role: "explore", title: "영역", requirements: ["R1"], inputs: [SPEC], outputs: [], dependsOn: ["analysis"] };
  preparePlanning(root, { tasks: [{ ...base, id: "left", scopes: ["src"] }, { ...base, id: "right", scopes: ["other"] }] });
  const left = dispatch("left"); dispatch("right");
  finish(left);
  editPlanning((state) => {
    for (const record of state.tasks.filter((item) => item.task.role === "explore")) record.attempts.at(-1)!.at = ago(13);
    // analysis 담당은 조사 배정보다 먼저 끝났다
    for (const agent of state.agents.slice(0, -1)) { agent.startedAt = ago(20); agent.endedAt = ago(19); }
    const agent = state.agents.at(-1)!;
    agent.dispatchId = left.resultShape.dispatchId; agent.startedAt = ago(12); agent.endedAt = ago(2);
  });
  const waiting = (await advance());
  assert.ok(waiting.waiting.includes("right"), JSON.stringify(waiting));
  assert.equal(waiting.stale, undefined);
  editPlanning((state) => { state.agents.at(-1)!.endedAt = ago(11); });
  const stale = (await advance());
  assert.equal(stale.action, "stale");
  assert.equal(stale.stale[0].id, "right");
  assert.equal(stale.stale[0].reason, "담당 시작이 관찰되지 않았습니다(배정 13분 전, 마지막 담당 활동 11분 전)");
});

test("orphanState — 역할을 모르면 다른 종류의 미연결 담당도 이 배정의 담당으로 본다", () => {
  const now = Date.now(), attempt = { dispatchId: "D", inputHash: "h", at: new Date(now - 30 * 60_000).toISOString(), status: "running" };
  const agents = [{ id: "w", session: "s", type: "ca-writer", startedAt: new Date(now - 20 * 60_000).toISOString() }];
  assert.equal(orphanState({ attempt, agents, now }), "running", "역할을 모르면 고아로 덜 판정한다");
  assert.equal(orphanState({ attempt, agentType: "ca-explorer", agents, now }), "suspect", "다른 종류의 담당은 이 배정의 담당이 아니다");
});

test("고아 정리는 동시 한도보다 먼저다 — 끝난 담당의 배정이 maxParallel 1 을 차지하지 않는다", () => {
  preparePlanning(root);
  editPlanning((state) => { state.maxParallel = 1; });
  startAgent(dispatch("analysis"), "gone");
  editPlanning((state) => { state.agents[0].finished = true; });
  assert.equal(dispatch("analysis").cached, false);
  assert.deepEqual(loadPlanning(loadWork(root)!).tasks[0].attempts.map((attempt) => attempt.status), ["orphaned", "running"]);
});

test("교정도 고아 정리 뒤에 동시 한도를 센다", () => {
  analysis();
  const base = { role: "explore", title: "영역", requirements: ["R1"], inputs: [SPEC], outputs: [], dependsOn: ["analysis"] };
  preparePlanning(root, { maxParallel: 1, tasks: [{ ...base, id: "left", scopes: ["src"] }, { ...base, id: "right", scopes: ["other"] }] });
  malformed(dispatch("left"));
  startAgent(dispatch("right"), "right-agent");
  editPlanning((state) => { state.agents.find((agent) => agent.id === "right-agent")!.finished = true; });
  assert.equal(JSON.parse(repairPlanning(root, "left")).mode, "correction");
  assert.equal(loadPlanning(loadWork(root)!).tasks.find((record) => record.task.id === "right")!.attempts.at(-1)!.status, "orphaned");
});

test("연결된 담당이 끝났는데 결과가 없는 배정은 advance 가 고아로 표시하고 같은 호출에서 다시 배정한다", async () => {
  startAgent((await advance()).assignments[0], "lost");
  editPlanning((state) => { state.agents[0].finished = true; });
  const reply = (await advance());
  assert.equal(reply.orphaned[0].id, "analysis");
  assert.equal(reply.action, "dispatch");
  const attempts = loadPlanning(loadWork(root)!).tasks[0].attempts;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].status, "orphaned");
  assert.equal(attempts[0].failure!.class, "dispatch-orphan");
});

test("Claude 완료 hook — 식별 불일치는 한 번 되돌리고, 그다음은 고아로 기록해 같은 입력 실패에 세지 않는다", async () => {
  const item = (await advance()).assignments[0];
  startAgent(item, "copy");
  const report = { ...completed(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }), dispatchId: "other" };
  quiet(() => {
    assert.equal(runPlanningHook(stopEvent(item, "copy", report)), 2);
    let state = loadPlanning(loadWork(root)!);
    assert.equal(state.agents[0].returns, 1);
    assert.equal(state.tasks[0].attempts.at(-1)!.status, "running");
    assert.equal(runPlanningHook(stopEvent(item, "copy", report, { stop_hook_active: true })), 0);
    state = loadPlanning(loadWork(root)!);
    assert.equal(state.tasks[0].attempts.at(-1)!.status, "orphaned");
    assert.equal(state.agents[0].failure!.class, "dispatch-orphan");
  });
  assert.equal((await advance()).action, "dispatch");
  assert.equal(JSON.parse(planningStatus(root)).tasks[0].budget.sameInput.used, 0);
});

test("Codex 완료 hook — 식별 불일치는 되돌리지 않고 고아로 기록한 뒤 0 을 낸다", async () => {
  const item = (await advance()).assignments[0];
  const event = { cwd: root, session_id: "s", agent_id: "codex-copy", agent_type: item.hostAgents.codex };
  codexHook({ ...event, hook_event_name: "SubagentStart" });
  const message = JSON.stringify({ ...completed(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }), dispatchId: "other" });
  const result = captured(() => runCodexHook(JSON.stringify({ ...event, hook_event_name: "SubagentStop", last_assistant_message: message })));
  assert.equal(result.value, 0);
  assert.equal(result.out, "{}");
  assert.match(result.err, /현재 배정에 속한 실행 결과가 아닙니다/);
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "orphaned");
});

test("Codex 담당 시작 이벤트의 판정 실패도 막지 않는다", async () => {
  (await advance());
  writeFileSync(planningJson(), "{broken");
  const result = captured(() => runCodexHook(JSON.stringify({ cwd: root, session_id: "s", agent_id: "a", agent_type: "ca_analyst", hook_event_name: "SubagentStart" })));
  assert.equal(result.value, 0);
  assert.equal(result.out, "{}");
  assert.match(result.err, /code-agent codex-event: /);
});

test("Claude 완료 hook — 형식 오류는 첫 Stop 에서 되돌리고, 이미 막힌 재시도는 교정 대기로 기록한다", async () => {
  const item = (await advance()).assignments[0];
  startAgent(item, "format");
  const broken = { ...item.resultShape, status: "completed", summary: 7, evidence: [{ path: SPEC, line: 1 }] };
  quiet((stderr) => {
    assert.equal(runPlanningHook(stopEvent(item, "format", broken)), 2);
    assert.match(stderr(), /resultShape 형태 JSON 하나로 다시 반환/);
    assert.match(stderr(), /결과 JSON 이 resultShape 와 다릅니다:\n {2}- summary: /, "스키마 오류는 경로: 메시지 줄로 싣는다");
    assert.doesNotMatch(stderr(), /"code":/, "zod 오류 JSON 을 그대로 싣지 않는다");
    assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "running");
    assert.equal(runPlanningHook(stopEvent(item, "format", broken, { stop_hook_active: true })), 0);
  });
  const last = loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!;
  assert.equal(last.status, "needs-correction");
  assert.equal(last.failure!.class, "agent-format-error");
});

test("완료 hook 은 staging 본문에 그 역할의 게이트 검사를 먼저 돌려 한 번 되돌린다", async () => {
  toDesign();
  const item = (await advance()).assignments[0];
  startAgent(item, "designer");
  const design = () => loadPlanning(loadWork(root)!).tasks.find((record) => record.task.id === "design")!.attempts.at(-1)!;
  quiet((stderr) => {
    assert.equal(runPlanningHook(stopEvent(item, "designer", completed(item, { [`${DIR}/03-design.md`]: DESIGN, [`${DIR}/04-functional.md`]: DUPLICATED_AC }))), 2);
    assert.match(stderr(), /수락 기준 id 가 겹칩니다/);
    assert.equal(existsSync(join(root, DIR, "04-functional.md")), false);
    assert.equal(design().status, "running");
    assert.equal(runPlanningHook(stopEvent(item, "designer", completed(item, { [`${DIR}/03-design.md`]: DESIGN, [`${DIR}/04-functional.md`]: FUNCTIONAL }), { stop_hook_active: true })), 0);
  });
  assert.equal(design().status, "completed");
  next(root);
});

test("host 없이 부른 완료 관찰은 문서 검사 실패를 바로 내용 오류로 기록한다", async () => {
  toDesign();
  const item = (await advance()).assignments[0];
  assert.throws(() => finish(item, { [`${DIR}/03-design.md`]: DESIGN, [`${DIR}/04-functional.md`]: DUPLICATED_AC }), /수락 기준 id 가 겹칩니다/);
  const last = loadPlanning(loadWork(root)!).tasks.find((record) => record.task.id === "design")!.attempts.at(-1)!;
  assert.equal(last.status, "failed");
  assert.equal(last.failure!.class, "agent-content-error");
  assert.equal(existsSync(join(root, DIR, "03-design.md")), false);
  assert.equal(existsSync(join(root, DIR, "04-functional.md")), false);
});

test("analysis 결과도 요구 형식·원문 추적 검사를 완료 전에 받는다", async () => {
  await assert.rejects(async () => finish((await advance()).assignments[0], { [`${DIR}/01-requirements.md`]: REQUIREMENTS.replace('근거: "값을 반환한다."', "") }), /근거: 줄이 없는 요구 항목/);
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "failed");
});

test("plan 결과도 plan.json 의 요구 커버리지를 완료 전에 받는다", () => {
  throughDesign(); preparePlanning(root);
  const uncovered = { ...PLAN, files: PLAN.files.map((file) => ({ ...file, requirements: ["R2"] })) };
  assert.throws(() => finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(uncovered), [`${DIR}/07-test-spec.md`]: TESTS }), /어떤 파일에도 닿지 않는 요구 항목/);
  assert.equal(existsSync(join(root, DIR, "plan.json")), false);
  const last = loadPlanning(loadWork(root)!).tasks.find((record) => record.task.id === "plan")!.attempts.at(-1)!;
  assert.equal(last.status, "failed");
  assert.equal(last.failure!.class, "agent-content-error");
});

test("plan 완료 hook 은 제출 규칙(순서·경로)을 plan submit 과 같은 함수로 먼저 본다 — hook 을 지난 초안은 제출에서 같은 규칙으로 걸리지 않는다", () => {
  throughDesign(); preparePlanning(root);
  // 단계 위치 밖 파일과 이유 없는 순서 — 스키마·커버리지(planShapeProblems)는 지나고 제출 규칙에서만 걸리는 초안
  const outside = { ...PLAN, files: PLAN.files.map((file) => file.path === "src/b.ts" ? { ...file, path: "lib/b.ts" } : file),
    tasks: PLAN.tasks.map((task) => task.id === "T2" ? { ...task, files: ["lib/b.ts"] } : task), sequence: [{ step: "app", why: " " }, { step: "test", why: "검증" }] };
  const work = loadWork(root)!;
  const expected = planRuleProblems(work, planFormatFor("feature").toPlan(planFormatFor("feature").schema.parse(outside)));
  assert.ok(expected.some((problem) => /lib\/b\.ts/.test(problem)) && expected.some((problem) => /순서의 이유/.test(problem)), expected.join("\n"));
  assert.throws(() => finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(outside), [`${DIR}/07-test-spec.md`]: TESTS }),
    (error: Error) => expected.every((problem) => error.message.includes(problem)));
  assert.equal(existsSync(join(root, DIR, "plan.json")), false, "정식 문서로 옮기지 않는다");
  // 같은 규칙을 지킨 초안은 hook·critic 을 지나 제출된다 — 제출의 최종 재검사도 같은 함수다
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  finish(dispatch("critic"));
  assert.match(submitPlan(root, join(root, DIR, "plan.json")), /계획을 제출하고/);
  // 제출 전에 사람이 매니페스트 단계 위치를 바꾸면(상태 변화) 최종 재검사가 막는다 — 입력이 바뀌어 게이트부터 낡는다
  const manifest = JSON.parse(readFileSync(join(root, "code-agent.json"), "utf8"));
  manifest.stages[0].outputDirs = ["lib"];
  writeFileSync(join(root, "code-agent.json"), JSON.stringify(manifest));
  assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /낡았|src\/a\.ts/);
});

test("교정 시도의 문서 검사 실패는 되돌리지 않고 실패로 기록한다", async () => {
  const item = (await advance()).assignments[0];
  const bad = REQUIREMENTS.replace('근거: "값을 반환한다."', "");
  malformed(item, { raw: JSON.stringify({ ...item.resultShape, status: "completed", summary: 123, evidence: [{ path: SPEC, line: 1 }], artifacts: [{ path: `${DIR}/01-requirements.md`, content: bad }] }) });
  const repaired = (await advance()).assignments[0];
  assert.equal(repaired.mode, "correction");
  startAgent(repaired, "corrector");
  quiet(() => assert.equal(runPlanningHook(stopEvent(repaired, "corrector", completed(repaired, { [`${DIR}/01-requirements.md`]: bad }))), 0));
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "failed");
});

test("같은 입력으로 세 번 실패하면 명시 배정도 거부하고 advance 는 한도 원인을 낸다", async () => {
  preparePlanning(root);
  for (let index = 0; index < 3; index++) {
    assert.throws(() => finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS }, { evidence: [{ path: "outside.ts", line: 1 }] }), /범위 밖/);
  }
  assert.throws(() => dispatch("analysis"), /3번 실패/);
  const blocked = (await advance()).blocked[0];
  assert.equal(blocked.class, "same-input-repeat");
  assert.deepEqual(blocked.counter, { key: "sameInput", used: 3, limit: 3 });
});

test("retry 기록이 없는 옛 계획 기록은 이행 시각 이후의 배정만 센다", async () => {
  preparePlanning(root);
  editPlanning((state) => {
    delete state.retry;
    state.tasks[0].attempts = Array.from({ length: 5 }, (_, index) => ({ dispatchId: `old-${index}`, inputHash: "old", at: "2026-01-01T00:00:00.000Z", status: "cancelled" as const }));
  });
  assert.equal((await advance()).action, "dispatch");
  const state = loadPlanning(loadWork(root)!);
  assert.ok(state.retry && Date.parse(state.retry.since) > Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(JSON.parse(planningStatus(root)).tasks[0].budget.taskTotal.used, 1);
});

test("사람 허용은 소진된 카운터에만 기록하고 그 범위의 한도를 늘린다", () => {
  preparePlanning(root);
  for (let index = 0; index < 6; index++) { dispatch("analysis"); cancelPlanning(root, "analysis"); }
  assert.throws(() => dispatch("analysis"), /총 6회/);
  assert.deepEqual({ ...planningBudget(root, "analysis").taskTotal }, { key: "taskTotal", used: 6, limit: 6, left: 0, exhausted: true });
  assert.throws(() => grantPlanningRetry(root, "sameInput", "analysis", "consent-1", "사유"), /한도가 남아 있어/);
  assert.equal(grantPlanningRetry(root, "taskTotal", "analysis", "consent-2", "사람 판단"), "작업 analysis의 작업 총 배정 한도를 6→9회로 늘렸습니다(사람 판단, 동의 consent-2)");
  assert.equal(loadPlanning(loadWork(root)!).retry!.grants[0].scope, "planning:analysis");
  assert.equal(planningBudget(root, "analysis").taskTotal.limit, 9);
  assert.doesNotThrow(() => dispatch("analysis"));
});

test("계획 기록 잠금 — 죽은 주인·오래된 빈 잠금은 회수하고, 살아 있거나 다른 PC·주인 불명이면 사람에게 넘긴다", async () => {
  preparePlanning(root);
  const lock = `${planningJson()}.lock`, display = `.code-agent/work/${ID}/value.planning.json.lock`;
  const dead = deadPid();
  writeFileSync(lock, JSON.stringify({ pid: dead, host: hostname(), at: new Date().toISOString() }));
  await quietAsync(async (stderr) => { await assert.doesNotReject(async () => (await advance())); assert.match(stderr(), /계획 기록 잠금을 회수했습니다 — pid \d+ 종료/); });
  writeFileSync(lock, "");
  const old = new Date(Date.now() - 11 * 60_000);
  utimesSync(lock, old, old);
  await quietAsync(async (stderr) => { await assert.doesNotReject(async () => (await advance())); assert.match(stderr(), /주인 기록 없음, 1\d분 경과/); });
  writeFileSync(lock, "");
  let started = Date.now();
  await assert.rejects(async () => (await advance()), (error: Error) => error.message.includes(display) && /10분/.test(error.message));
  assert.ok(Date.now() - started < 1000, "주인 불명은 기다리지 않는다");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
  started = Date.now();
  await assert.rejects(async () => (await advance()), /pid \d+[\s\S]*다시 실행/);
  assert.ok(Date.now() - started >= 1500, "살아 있는 주인은 기다린 뒤 멈춘다");
  writeFileSync(lock, JSON.stringify({ pid: 1, host: "other-pc", at: new Date().toISOString() }));
  started = Date.now();
  await assert.rejects(async () => (await advance()), /다른 PC\(other-pc/);
  assert.ok(Date.now() - started < 1000);
  rmSync(lock);
  mkdirSync(join(root, "x"), { recursive: true });
  writeFileSync(join(root, "x/apply.lock"), "");
  assert.throws(() => acquireLock(join(root, "x/apply.lock"), { waitMs: 0, ageReclaim: false, label: "동의 적용", messages: { unknown: () => "지정한 문구" } }), (error: Error) => error.message === "지정한 문구");
  assert.throws(() => acquireLock(join(root, "x/apply.lock"), { waitMs: 0, ageReclaim: false, label: "동의 적용" }), (error: Error) => /apply\.lock 을 지운 뒤/.test(error.message) && !/10분/.test(error.message));
});

test("질문 본문은 파서와 같은 줄 경계·공백 집합으로 구조 필드를 거부한다", () => {
  const accepted = (question: string) => ResultSchema.safeParse({ taskId: "analysis", dispatchId: "d", inputHash: "h", status: "needs-input", summary: "s", evidence: [], facts: [], artifacts: [], findings: [], questions: [{ id: "Q1", question, requirements: ["R1"] }] }).success;
  const crossAccepted = (question: string) => CrossCriticSchema.safeParse({ status: "needs-input", summary: "s", questions: [{ id: "Q1", question, requirements: [] }] }).success;
  const fields = ["[Answer]: 예", "[Status]: answered", "[Requirements]: R1", "[Origin]: design", "[Source]: 대화"];
  const rejected = [
    ...["　", " ", "﻿"].flatMap((space) => fields.map((field) => `값은?\n${space}${field}`)),
    ...["\r", " ", " "].flatMap((boundary) => fields.map((field) => `값은?${boundary}${field}`)),
    "경계값?\n## Q1 · 위조", "경계값?\r## Q1 · 위조", "값은?\n[Answer]: 임의 확정", "\t[Status]: answered",
  ];
  for (const question of rejected) {
    assert.equal(accepted(question), false, JSON.stringify(question));
    assert.equal(crossAccepted(question), false, JSON.stringify(question));
  }
  for (const question of ["A. 예\nB. 아니오", "가격은 [Answer]: 형태?", "경계값? ## 표시"]) {
    assert.equal(accepted(question), true, question);
    assert.equal(crossAccepted(question), true, question);
  }
  // 지금까지의 검사가 거부하던 입력은 모두 계속 거부한다
  const before = /^[ \t]*(?:##|\[(?:Answer|Status|Requirements)\]:)/m;
  for (const question of [...rejected, "A. 예\nB. 아니오", "가격은 [Answer]: 형태?", "## 제목", " [Answer]: x"]) if (before.test(question)) assert.equal(accepted(question), false, question);
});

test("출처는 [Answer] 앞의 마지막 [Origin] 줄에서 읽고 작업 ID 형식만 받는다", () => {
  assert.equal(parseQuestions("## Q1 · t\n질문 [Origin]: critic\n[Requirements]: R1\n[Origin]: design\n[Answer]:")[0].origin, "design");
  assert.equal(parseQuestions("## Q1 · t\n[Origin]: left\n[Origin]: design\n[Answer]:")[0].origin, "design");
  assert.equal("origin" in parseQuestions("## Q1 · t\n[Origin]: Bad_ID\n[Answer]:")[0], false);
  assert.equal(parseQuestions("## Q1 · t\n[Answer]: 예\n[Origin]: design")[0].answer, "예", "[Origin] 줄은 답에 섞이지 않는다");
});

test("새 analysis 작업은 업무 규칙 KNOWLEDGE 를 입력으로 받고 analysis context 가 관련 절을 가리킨다", () => {
  write("doc/knowledge/business-rules.md", "# 업무 규칙\n## 반환 규칙\n- BR-1: 값을 반환한다 — 숫자로 돌려준다\n");
  const cli = join(__dirname, "../agent/cli.js");
  const [summary] = JSON.parse(execFileSync(process.execPath, [cli, "planning", "advance"], { cwd: root, encoding: "utf8" })).assignments;
  const item = handed(summary);
  assert.ok(item.task.inputs.includes("doc/knowledge/business-rules.md"), JSON.stringify(item.task.inputs));
  const text = readFileSync(join(root, summary.assignmentFile), "utf8");
  assert.match(text, /업무 규칙 KNOWLEDGE[^\n]*doc\/knowledge\/business-rules\.md/);
  assert.match(text, /## 참고 문서 \([\s\S]*doc\/knowledge\/business-rules\.md L\d+-L\d+ · ## 반환 규칙/);
  finish(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }, { evidence: [{ path: SPEC, line: 1 }, { path: "doc/knowledge/business-rules.md", line: 3 }] });
  assert.equal(JSON.parse(planningResult(root, "analysis")).current, true, "업무 규칙 근거는 배정 범위 안이다");
});

test("이미 준비한 작업의 inputs 는 그대로 둔다 — 진행 중 작업의 해시를 바꾸지 않는다", async () => {
  preparePlanning(root);
  write("doc/knowledge/business-rules.md", "# 업무 규칙\n## 반환 규칙\n- BR-1: 값을 반환한다\n");
  assert.deepEqual((await advance()).assignments[0].task.inputs, [SPEC]);
});

test("대화가 새로 열리면 실행 중으로 기록된 계획 배정과 취소 명령을 붙인다", async () => {
  (await advance());
  const cleared = sessionAnchor(root, "clear");
  assert.match(cleared, /실행 중으로 기록된 계획 배정: analysis\(ca-analyst, 담당 시작 미관찰, 0분 전\)/);
  assert.match(cleared, /code-agent planning cancel analysis/);
  const compacted = sessionAnchor(root, "compact");
  assert.match(compacted, /stale·cancel 안내/);
  assert.doesNotMatch(compacted, /planning cancel analysis/);
});

test("planning status 는 실행 관찰·낡은 이유·재시도 예산을 보인다", async () => {
  const item = (await advance()).assignments[0];
  startAgent(item, "watch");
  let status = JSON.parse(planningStatus(root)).tasks[0];
  assert.equal(status.run.observedStart, true);
  assert.equal(status.run.orphan, "running");
  assert.deepEqual(status.budget, { sameInput: { used: 0, limit: 3 }, taskTotal: { used: 1, limit: 6 } });
  observePlanner(JSON.parse(stopEvent(item, "watch", completed(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }))));
  write("doc/conventions.md", `${readFileSync(join(root, "doc/conventions.md"), "utf8")}\n- 추가 규칙\n`);
  status = JSON.parse(planningStatus(root)).tasks[0];
  assert.equal(status.state, "stale");
  assert.ok(status.staleBecause.includes("입력 파일: doc/conventions.md"), JSON.stringify(status.staleBecause));
});

for (const via of ["claude", "direct"] as const) test(`실행 중 입력이 바뀐 완료는 취소로 기록하고 되돌리지 않는다: ${via}`, () => {
  analysis(); preparePlanning(root);
  const item = dispatch("explore");
  startAgent(item, "explorer");
  write("src/current.ts", "export const current = 5;\n");
  const report = completed(item, {}, { evidence: [{ path: "src/current.ts", line: 1 }] });
  if (via === "claude") quiet(() => assert.equal(runPlanningHook(stopEvent(item, "explorer", report)), 0));
  else assert.throws(() => observePlanner(JSON.parse(stopEvent(item, "explorer", report))), /입력이 바뀌/);
  const last = loadPlanning(loadWork(root)!).tasks.find((record) => record.task.id === "explore")!.attempts.at(-1)!;
  assert.equal(last.status, "cancelled");
  assert.equal(last.failure!.class, "dispatch-orphan");
});

test("Codex 사본 — staging 문장은 그대로(쓰기 도구만 apply_patch)이고 계획 루프의 새 문장이 그대로 있다", () => {
  const assets = hostAssets("codex");
  for (const name of ["ca-analyze", "ca-impact", "ca-design", "ca-plan"]) {
    const text = assets.get(`.agents/skills/${name}/SKILL.md`)!;
    assert.ok(text.includes(".agents/skills/ca-plan/contract.md"), name);
  }
  const contract = assets.get(".agents/skills/ca-plan/contract.md")!;
  assert.ok(contract.includes("담당은 출력 문서를 staging에 쓰고 결과 JSON에는 경로만 넣는다."));
  for (const phrase of ["`next` 줄이 싣는 행동의 요지는 그 줄이 원천이다", "`cancel` 목록", "rewind.auto", "feedback"]) assert.ok(contract.includes(phrase), phrase);
  const analyst = assets.get(".codex/agents/ca-analyst.toml")!;
  // staging 쓰기 규칙은 배정 instructions(쓰기 도구는 editVia — Codex 는 apply_patch)에 있다. 에이전트 본문은 그것을 따르라고만 한다
  assert.ok(analyst.includes("입력 범위·staging·결과 파일 쓰기·근거·질문 규칙은 `instructions`에 있다"));
  assert.ok(!analyst.includes("Write로"), "Claude 쓰기 도구 이름이 남지 않는다");
  // 요구 분석 전용 형식은 analysis 배정의 문서 기준(ca-analyze/criteria.md)에만 있다 — design·plan 배정 때 담당 본문으로 싣지 않는다
  assert.ok(!analyst.includes("돌려줄 것:"));
  assert.match(assets.get(".agents/skills/ca-analyze/criteria.md")!, /^## 요구 분석 담당\r?$/m);
  assert.ok(assets.get(".codex/agents/ca-explorer.toml")!.includes("문서는 staging에 쓰고 artifacts에는 경로만 넣는다. 그 밖의 파일을 쓰거나"));
});

test("수정 재배정은 담당 시작 때 현행 문서를 그 배정의 staging 에 미리 둔다 — 처음 배정에는 두지 않는다", () => {
  throughDesign(); preparePlanning(root);
  const stagedOf = (item: any, file: string) => join(root, DIR, ".staging", item.resultShape.dispatchId, file);
  const first = dispatch("plan");
  startAgent(first, "planner-1");
  assert.equal(existsSync(stagedOf(first, "plan.json")), false, "처음 배정에는 현행 문서가 없다");
  observePlanner(JSON.parse(stopEvent(first, "planner-1", completed(first, { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS }))));
  write(`${DIR}/feedback.md`, "07 에 경계값 TC 를 더한다\n");
  const planTask = loadPlanning(loadWork(root)!).tasks.find((record) => record.task.role === "plan")!.task;
  preparePlanning(root, { tasks: [{ ...planTask, inputs: [...planTask.inputs, `${DIR}/feedback.md`] }] });
  const again = dispatch("plan");
  assert.match(again.instructions, /수정 재배정이면 그 자리에 현행 문서\(직전 시도의 초안이 있으면 그 초안\)가 미리 들어 있습니다 — 고칠 곳만 고치고/);
  startAgent(again, "planner-2");
  for (const file of ["plan.json", "07-test-spec.md"]) assert.equal(readFileSync(stagedOf(again, file), "utf8"), readFileSync(join(root, DIR, file), "utf8"), file);
});

test("차단 지적은 인용 문서를 낸 작업만 후보로 보이고 자동으로 되감지 않는다", async () => {
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  const line = FUNCTIONAL.split("\n").findIndex((row) => row.startsWith("- AC-R1-1")) + 1;
  finish(dispatch("critic"), {}, { findings: [{ id: "F1", severity: "blocking", detail: "AC-R1-1 경계값 TC 없음", source: { path: `${DIR}/04-functional.md`, line } }] });
  const reply = (await advance());
  assert.notEqual(reply.action, "rewind-required");
  assert.equal(reply.feedback[0].from, "critic");
  assert.equal(reply.feedback[0].citedTask, "design");
  assert.equal(reply.feedback[0].citedPhase, "design");
  assert.match(reply.feedback[0].note, /근거 문서가 앞 단계\(design\) 출력입니다/);
  assert.equal("command" in reply.feedback[0], false);
});

for (const via of ["claude", "codex"] as const) test(`크기 한도를 넘은 결과는 원본을 보존하지 않으므로 교정 대기 대신 실패로 기록하고 교정을 받지 않는다: ${via}`, async () => {
  const item = (await advance()).assignments[0];
  const huge = "x".repeat(500_001);
  if (via === "codex") {
    const event = { cwd: root, session_id: "s", agent_id: "codex-large", agent_type: item.hostAgents.codex };
    codexHook({ ...event, hook_event_name: "SubagentStart" });
    const result = captured(() => runCodexHook(JSON.stringify({ ...event, hook_event_name: "SubagentStop", last_assistant_message: huge })));
    assert.equal(result.value, 0);
    assert.equal(result.out, "{}");
    assert.match(result.err, /크기 한도[\s\S]*형식 교정 대상이 아닙니다/);
  } else {
    startAgent(item, "large");
    quiet((stderr) => {
      assert.equal(runPlanningHook(stopEvent(item, "large", huge)), 2, "첫 Stop 은 같은 담당에게 되돌린다");
      assert.match(stderr(), /크기 한도/);
      assert.equal(runPlanningHook(stopEvent(item, "large", huge, { stop_hook_active: true })), 0);
    });
  }
  const last = loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!;
  assert.equal(last.status, "failed");
  assert.equal(last.failure!.class, "agent-format-error");
  assert.equal(last.correction, undefined, "원본이 없는 교정 대기를 만들지 않는다");
  assert.throws(() => repairPlanning(root, "analysis"), /교정할 관찰 결과가 없거나/);
  assert.equal((await advance()).blocked[0].class, "agent-format-error");
});

test("연결하지 못한 담당이 취소·교체된 배정의 결과를 늦게 내면 되돌리지 않고 늦은 결과로만 기록한다", () => {
  analysis();
  const base = { role: "explore", title: "영역", requirements: ["R1"], inputs: [SPEC], outputs: [], dependsOn: ["analysis"] };
  preparePlanning(root, { tasks: [{ ...base, id: "left", scopes: ["src"] }, { ...base, id: "right", scopes: ["other"] }] });
  const oldLeft = dispatch("left"); dispatch("right");
  startAgent(oldLeft, "old-left");
  assert.equal(loadPlanning(loadWork(root)!).agents.find((agent) => agent.id === "old-left")!.dispatchId, undefined, "후보가 둘이라 연결하지 않는다");
  cancelPlanning(root, "left");
  const newLeft = dispatch("left");
  quiet((stderr) => {
    assert.equal(runPlanningHook(stopEvent(oldLeft, "old-left", completed(oldLeft, {}, { evidence: [{ path: "src/current.ts", line: 1 }] }))), 0);
    assert.match(stderr(), /현재 배정에 속한 실행 결과가 아닙니다/);
  });
  const state = loadPlanning(loadWork(root)!);
  const agent = state.agents.find((item) => item.id === "old-left")!;
  assert.equal(agent.failure!.detail, "취소·교체된 배정의 늦은 결과");
  assert.equal(agent.returns, undefined, "식별 복사 오류로 되돌리지 않는다");
  const left = state.tasks.find((record) => record.task.id === "left")!;
  assert.deepEqual(left.attempts.map((attempt) => attempt.status), ["cancelled", "running"]);
  assert.equal(left.attempts.at(-1)!.dispatchId, newLeft.resultShape.dispatchId);
});

test("취소된 배정의 담당이 재배정 뒤 늦게 시작해 새 배정에 연결돼도 그 늦은 결과는 새 배정을 고아로 만들지 않는다", async () => {
  const first = (await advance()).assignments[0];
  editPlanning((state) => { state.tasks[0].attempts[0].at = ago(11); });
  assert.equal((await advance()).action, "stale");
  cancelPlanning(root, "analysis");
  const second = (await advance()).assignments[0];
  // 옛 배정 파일로 부른 담당이 늦게 시작했다 — 후보가 하나라 새 배정에 연결된다
  startAgent(first, "late-old");
  startAgent(second, "current");
  assert.deepEqual(loadPlanning(loadWork(root)!).agents.map((agent) => agent.dispatchId), [second.resultShape.dispatchId, second.resultShape.dispatchId]);
  quiet(() => assert.equal(runPlanningHook(stopEvent(first, "late-old", completed(first, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }))), 0, "늦은 결과는 되돌리지 않는다"));
  let state = loadPlanning(loadWork(root)!);
  assert.equal(state.tasks[0].attempts.at(-1)!.status, "running", "새 배정은 고아가 아니다");
  assert.equal(state.agents[0].dispatchId, first.resultShape.dispatchId, "늦은 담당의 연결은 보고한 배정으로 옮긴다");
  quiet(() => assert.equal(runPlanningHook(stopEvent(second, "current", completed(second, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }))), 0));
  state = loadPlanning(loadWork(root)!);
  assert.deepEqual(state.tasks[0].attempts.map((attempt) => attempt.status), ["cancelled", "completed"]);
});

test("취소된 배정의 늦은 결과가 형식까지 틀려도 되돌리지 않고 늦은 결과로만 기록한다", async () => {
  const first = (await advance()).assignments[0];
  cancelPlanning(root, "analysis");
  const second = (await advance()).assignments[0];
  startAgent(first, "late-broken");
  quiet(() => assert.equal(runPlanningHook(stopEvent(first, "late-broken", { ...first.resultShape, status: "completed", summary: 7 })), 0));
  const state = loadPlanning(loadWork(root)!);
  assert.equal(state.agents[0].failure!.detail, "취소·교체된 배정의 늦은 결과");
  assert.equal(state.agents[0].dispatchId, first.resultShape.dispatchId, "연결을 보고한 배정으로 옮긴다");
  assert.equal(state.tasks[0].attempts.at(-1)!.status, "running");
  assert.equal(state.tasks[0].attempts.at(-1)!.dispatchId, second.resultShape.dispatchId);
});

test("늦은 결과의 담당만 새 배정에 연결됐으면 새 배정은 담당을 기다리고, 다른 담당이 일하는 배정은 식별 오류로 고아가 되지 않는다", async () => {
  const first = (await advance()).assignments[0];
  cancelPlanning(root, "analysis");
  const second = (await advance()).assignments[0];
  startAgent(first, "late-only");
  quiet(() => runPlanningHook(stopEvent(first, "late-only", completed(first, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }))));
  const waiting = (await advance());
  assert.equal(waiting.action, "wait", JSON.stringify(waiting));
  assert.equal(waiting.orphaned, undefined, "늦은 담당의 종료로 새 배정을 고아로 판정하지 않는다");
  // 같은 배정에 두 담당이 연결됐다 — 한 담당의 식별 복사 오류가 다른 담당이 일하는 배정을 고아로 만들지 않는다
  startAgent(second, "duplicate"); startAgent(second, "worker");
  const copy = { ...completed(second, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }), dispatchId: "other" };
  quiet(() => {
    assert.equal(runPlanningHook(stopEvent(second, "duplicate", copy)), 2);
    assert.equal(runPlanningHook(stopEvent(second, "duplicate", copy, { stop_hook_active: true })), 0);
  });
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "running");
  quiet(() => assert.equal(runPlanningHook(stopEvent(second, "worker", completed(second, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }))), 0));
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "completed");
});

test("출처 검증 실패로 고아가 된 배정은 다시 배정할 때 직전 실패를 보이고, 두 번 이어지면 자동으로 다시 배정하지 않는다", async () => {
  const outside = mkdtempSync(join(tmpdir(), "ca-transcript-"));
  try {
    const run = (item: any, agent: string) => {
      const event = { cwd: root, session_id: "s", agent_id: agent, agent_type: item.agent, transcript_path: join(outside, "s.jsonl") };
      observePlanner({ ...event, hook_event_name: "SubagentStart" });
      const elsewhere = join(outside, `${agent}.jsonl`);
      writeFileSync(elsewhere, "");
      quiet(() => assert.equal(runPlanningHook(JSON.stringify({ ...event, hook_event_name: "SubagentStop", agent_transcript_path: elsewhere,
        last_assistant_message: JSON.stringify(completed(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS })) })), 0));
    };
    run((await advance()).assignments[0], "first");
    const again = (await advance());
    assert.equal(again.action, "dispatch");
    const previous = again.assignments[0].previous;
    assert.deepEqual({ status: previous.status, class: previous.class }, { status: "orphaned", class: "dispatch-orphan" });
    assert.match(previous.detail, /하위 에이전트 기록이 아닙니다/);
    assert.deepEqual(JSON.parse(handoffPlanning(root, JSON.stringify(again))).assignments[0].previous, previous, "CLI 요약에도 남는다");
    run(again.assignments[0], "second");
    const stopped = (await advance());
    assert.equal(stopped.assignments.length, 0);
    assert.equal(stopped.action, "blocked");
    assert.equal(stopped.blocked[0].class, "hook-failure");
    assert.match(stopped.blocked[0].reasons.join("\n"), /두 번 이어서[\s\S]*planning dispatch analysis/);
    assert.equal(dispatch("analysis").cached, false, "명시 배정은 받는다");
  } finally { rmSync(outside, { recursive: true, force: true }); }
});

for (const via of ["text", "handback"] as const) test(`되돌린 뒤의 완료는 되돌릴 때 판정한 SubagentHandback 을 다시 읽지 않는다: ${via}`, async () => {
  const item = (await advance()).assignments[0];
  const outside = mkdtempSync(join(tmpdir(), "ca-transcript-"));
  try {
    const event = { cwd: root, session_id: "s", agent_id: "handback", agent_type: item.agent, transcript_path: join(outside, "s.jsonl") };
    observePlanner({ ...event, hook_event_name: "SubagentStart" });
    const transcript = join(outside, "s", "subagents", "agent-handback.jsonl");
    mkdirSync(dirname(transcript), { recursive: true });
    // 기록 시각에 기대지 않는다 — 옛 보고의 시각이 되돌린 시각보다 늦어도 순서로 나눈다
    const handback = (message: unknown) => appendFileSync(transcript, `${JSON.stringify({ timestamp: new Date(Date.now() + 60_000).toISOString(), type: "assistant", message: { content: [{ type: "tool_use", name: "SubagentHandback", input: { message: JSON.stringify(message) } }] } })}\n`);
    const good = completed(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
    handback({ ...good, dispatchId: "wrong-copy" });
    const stop = (message: string, extra: object = {}) => runPlanningHook(JSON.stringify({ ...event, hook_event_name: "SubagentStop", agent_transcript_path: transcript, last_assistant_message: message, ...extra }));
    quiet(() => {
      assert.equal(stop(""), 2);
      if (via === "handback") handback(good);
      // 고친 결과를 최종 응답(text)이나 새 보고(handback)로 냈다 — 되돌린 옛 보고는 다시 판정하지 않는다
      assert.equal(stop(via === "text" ? JSON.stringify(good) : "끝", { stop_hook_active: true }), 0);
    });
    assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)!.status, "completed");
  } finally { rmSync(outside, { recursive: true, force: true }); }
});
