import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import "./consentFixture";
import { back, next, submitPlan } from "../agent/commands";
import { crossCritic } from "../agent/crossCheck";
import { withCaller } from "./reviewFixture";
import { loadActive } from "../agent/layout";
import { preparePlanning, planningStatus, planningResult } from "../agent/planning";
import { fileHash, hashedQuestion, inputFiles, invalidatePlanningCache, loadPlanning, planningProblems, taskCurrent, taskHash, withPlanningCache } from "../agent/planningState";
import { parseQuestions, type Question } from "../agent/questions";
import { sha } from "../agent/docs";
import { writeAtomic } from "../core/atomic";
import { loadWork } from "../agent/work";
import { hashManifest } from "../core/approval";
import { REQUIREMENTS, IMPACT, DESIGN, FUNCTIONAL, TESTS, PLAN, root, advance, write, dispatch, finish, analysis, throughDesign, editPlanning, answer, toDesign, DIR, SPEC } from "./planningFixture";

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
