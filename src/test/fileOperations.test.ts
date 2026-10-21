import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import * as stage from "./stageFixture";
import { start } from "./confirmedStart";
import { next, requireValidatable, submitPlan } from "../agent/commands";
import { check } from "../agent/validate";
import { applyFileOperations, preflightFiles } from "../agent/fileOperations";
import { fileOperationProblems } from "../core/fileOperations";
import { loadWork } from "../agent/work";
import { planPaths, stageProblems } from "../agent/evidence";
import { PlanSchema } from "../core/plan";
import { diffPlans, formatDiff, hashPlan } from "../core/approval";
import { CODEX_MARKERS } from "../agent/crossEnv";

beforeEach(() => stage.createStageRepo("ca-file-operations-"));
afterEach(() => stage.removeStageRepo());
const old = `${stage.ORDER}/domain/Old.java`, gone = `${stage.ORDER}/domain/Gone.java`;
function prepare(withTasks = false) {
  stage.write(".code-agent/execution.json", JSON.stringify({ version: 1, mode: withTasks ? "codex" : "claude" }));
  stage.write(old, "class Order {}\n"); stage.write(gone, "class Gone {}\n");
  stage.git("add", "-A"); stage.git("commit", "-qm", "existing files");
  start(stage.repo, join(stage.repo, "doc/work/ORD-1.md"));
  for (const [name, text] of Object.entries({ "01-requirements": stage.REQUIREMENTS, "02-analysis": stage.IMPACT, "03-design": stage.DESIGN, "04-functional": stage.FUNCTIONAL, "07-test-spec": stage.TEST_SPEC })) stage.write(`doc/work/ORD-1/${name}.md`, text);
  const files = [{ ...stage.PLAN.files[0], operation: "move", from: old }, { stage: "entity", path: gone, purpose: "폐기", requirements: ["R1"], operation: "delete" }, ...stage.PLAN.files.slice(1)];
  const tasks = stage.PLAN.sequence.map((step, i) => ({ id: `T${i + 1}`, stage: step.step, title: step.why, requirements: [...new Set(files.filter(f => f.stage === step.step).flatMap(f => f.requirements))], files: files.filter(f => f.stage === step.step).map(f => f.path), dependsOn: i ? [`T${i}`] : [], acceptance: step.step === "entity" ? ["AC-R1-1"] : step.step === "repository" ? ["AC-R2-1"] : ["AC-R1-1", "AC-R2-1"] }));
  return PlanSchema.parse({ ...stage.PLAN, files, ...(withTasks ? { tasks } : {}) });
}
for (const withTasks of [false, true]) test(`삭제·이동은 승인·완료·검증 범위를 지킨다 (Task ${withTasks})`, async () => {
  const plan = prepare(withTasks);
  const apply = () => {
    const keys = [...CODEX_MARKERS, "CLAUDECODE", "CLAUDE_CODE_SESSION_ID"];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    process.env[withTasks ? "CODEX_CI" : "CLAUDECODE"] = "1";
    try { return applyFileOperations(stage.repo); }
    finally { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
  };
  assert.deepEqual(preflightFiles(loadWork(stage.repo)!, plan.files, plan), []);
  assert.throws(apply, /승인된 구현/);
  next(stage.repo); next(stage.repo); next(stage.repo);
  stage.write("doc/work/ORD-1/plan.json", JSON.stringify(plan));
  submitPlan(stage.repo, join(stage.repo, "doc/work/ORD-1/plan.json"));
  stage.approve(); next(stage.repo);
  assert.throws(() => next(stage.repo), /이동 원본|삭제할 파일|없는 파일/);
  stage.write(plan.files[0].path, "덮어쓰면 안 되는 내용");
  assert.throws(apply, /덮어쓰지 않습니다/);
  assert.equal(existsSync(join(stage.repo, old)), true);
  assert.equal(existsSync(join(stage.repo, gone)), true);
  unlinkSync(join(stage.repo, plan.files[0].path));
  assert.match(apply(), /2건/);
  assert.equal(existsSync(join(stage.repo, old)), false);
  assert.equal(existsSync(join(stage.repo, gone)), false);
  assert.equal(readFileSync(join(stage.repo, plan.files[0].path), "utf8"), "class Order {}\n");
  assert.match(apply(), /0건/);
  assert.ok(planPaths(loadWork(stage.repo)!).includes(old));
  next(stage.repo);
  stage.write(stage.PLAN.files[1].path, "interface OrderRepository {}\n"); next(stage.repo);
  stage.write(stage.TEST_FILE, "// TC-1 TC-2\nclass OrderTest {}\n"); next(stage.repo);
  await check(requireValidatable(stage.repo, "check"));
  assert.deepEqual(stageProblems(loadWork(stage.repo)!, "check"), []);
});
test("원본 경계·기준 커밋·겹치는 경로·대상 덮어쓰기는 파일 변경 전에 거부한다", () => {
  const plan = prepare(), work = loadWork(stage.repo)!;
  assert.ok(preflightFiles(work, [{ ...plan.files[0], from: "outside/Old.java" }], plan).length);
  assert.ok(preflightFiles(work, [{ ...plan.files[0], path: gone }], plan).some(p => /이미 있습니다/.test(p)));
  assert.ok(fileOperationProblems([{ ...plan.files[0], from: "../Old.java" }]).length);
  assert.ok(fileOperationProblems([plan.files[0], { ...plan.files[1], path: old }]).length);
  assert.ok(fileOperationProblems([{ ...plan.files[0], from: undefined }]).length);
  assert.ok(preflightFiles({ ...work, active: { ...work.active, baseCommit: "missing" } }, plan.files, plan).some(p => /기준 커밋/.test(p)));
  assert.equal(existsSync(join(stage.repo, old)), true);
  const changed = structuredClone(plan);
  changed.files[0].from = gone;
  assert.notEqual(hashPlan(changed), hashPlan(plan));
  assert.match(formatDiff(diffPlans(plan, changed)), /Old.java.*Gone.java/);
});
