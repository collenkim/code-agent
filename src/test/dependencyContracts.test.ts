import { strict as assert } from "node:assert";
import { test, afterEach } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { root, ID, DIR, REQUIREMENTS, IMPACT, DESIGN, FUNCTIONAL, write, dispatch, finish, analysis } from "./planningFixture";
import { planningContracts, planningReuseAnswer, preparePlanning } from "../agent/planning";
import { contractsFile, dependencyContracts } from "../agent/dependencyContracts";
import { answerSources, formatAnswerSources, openQuestions, readAnswerRows } from "../agent/answers";
import { parseQuestions } from "../agent/questions";
import { approvalDocsHash, loadWork } from "../agent/work";
import { hashInput, loadPlanning, readyProblems, taskCurrent } from "../agent/planningState";
import { next } from "../agent/commands";
import { observeAnswerFixture } from "./consentFixture";

const statement = "amount는 0 이상이고 percent는 0부터 100까지이며 범위 밖이면 RangeError";
let repository: string | undefined;
afterEach(() => {
  if (repository) {
    assert.ok(repository.startsWith(join(realpathSync.native(tmpdir()), "ca-contract-source-")));
    rmSync(repository, { recursive: true, force: true }); repository = undefined;
  }
});
function bundle() {
  repository = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-contract-source-")));
  writeFileSync(join(repository, "contract.md"), statement + "\n");
  const git = (args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q"]); git(["-c", "core.autocrlf=false", "add", "contract.md"]);
  git(["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "contract"]);
  const value = { version: 1, contracts: [{ id: "discount", repository, path: "contract.md", commit: git(["rev-parse", "HEAD"]), sha256: createHash("sha256").update(statement + "\n").digest("hex"), claims: [{ key: "discount.range", text: statement }] }] };
  write(`${DIR}/contracts-input.json`, JSON.stringify(value));
  return { value, input: join(root, DIR, "contracts-input.json") };
}
function register() { const { input, value } = bundle(); planningContracts(root, input); return value; }
function questions(answer = "", source = "") {
  writeFileSync(join(root, DIR, "questions.md"), `# 질문\n\n## Q1 계약\n할인의 범위와 오류 계약은 무엇인가\n[Answer]: ${answer}\n${source ? `[Source]: ${source}\n` : ""}`);
}
const sources = () => answerSources(root, ID, parseQuestions(readFileSync(join(root, DIR, "questions.md"), "utf8")));

test("2-9 같은 판정 구간의 계약은 Git 검사를 재사용하고 원문 변경과 다음 구간은 다시 검사한다", async () => {
  register(); await Promise.resolve();
  const child = require("node:child_process") as typeof import("node:child_process"), original = child.execFileSync;
  let calls = 0;
  child.execFileSync = ((file: string, args: string[], options: object) => {
    if (file === "git") calls += 1;
    return Reflect.apply(original, child, [file, args, options]);
  }) as typeof original;
  try {
    assert.equal(dependencyContracts(root, ID).problems.length, 0);
    assert.equal(dependencyContracts(root, ID).problems.length, 0);
    assert.equal(calls, 3);
    await Promise.resolve();
    assert.equal(dependencyContracts(root, ID).problems.length, 0);
    assert.equal(calls, 6);
    appendFileSync(join(repository!, "contract.md"), "changed\n");
    assert.ok(dependencyContracts(root, ID).problems.length > 0);
    assert.equal(calls, 9);
  } finally { child.execFileSync = original; }
});

test("계약 사본이 explore와 design 입력에 연결되고 사본을 근거로 반환한 결과가 완료된다", () => {
  register(); analysis(); preparePlanning(root);
  const explore = dispatch("explore");
  assert.ok(explore.inputs.includes(contractsFile(ID)));
  assert.equal(explore.externalContracts[0].commit.length, 40);
  assert.equal(explore.externalContracts[0].claims[0].text, statement);
  assert.ok(!explore.inputs.some((path: string) => path.includes("upstream/")));
  finish(explore, {}, { evidence: [{ path: contractsFile(ID), line: 1 }] });
  finish(dispatch("synthesis"), { [`${DIR}/02-analysis.md`]: IMPACT }); next(root); preparePlanning(root);
  const design = dispatch("design");
  assert.ok(design.inputs.includes(contractsFile(ID)));
  finish(design, { [`${DIR}/03-design.md`]: DESIGN, [`${DIR}/04-functional.md`]: FUNCTIONAL }, { evidence: [{ path: contractsFile(ID), line: 1 }] });
  assert.deepEqual(openQuestions(root, `${DIR}/questions.md`), { unanswered: [], unverified: [] });
});

test("외부 근거 변경은 완료 결과를 낡게 하고 새 배정을 막는다", () => {
  register(); preparePlanning(root); finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: REQUIREMENTS });
  const work = loadWork(root)!, state = loadPlanning(work), record = state.tasks[0];
  const before = hashInput(work, state, record.task).hash;
  const approvedDocs = approvalDocsHash(work);
  writeFileSync(join(repository!, "contract.md"), "다른 계약\n");
  assert.notEqual(hashInput(work, state, record.task).hash, before);
  assert.notEqual(approvalDocsHash(work), approvedDocs);
  assert.equal(taskCurrent(work, state, record), false);
  assert.match(readyProblems(work, state, record).join("\n"), /외부 의존 계약 미확인/);
});

test("계약 재인용은 원문과 질문에 묶이고 사람이 답한 것으로 표시하지 않는다", () => {
  register(); questions(); planningReuseAnswer(root, "Q1", "discount", "discount.range");
  assert.equal(sources().get("Q1"), "contract");
  assert.match(formatAnswerSources(root, ID)!, /기존 계약 재인용\(사람 응답 아님\)/);
  assert.equal(readAnswerRows(root, ID).filter(row => row.type === "answer" || row.type === "delegated").length, 0);
  assert.equal(openQuestions(root, `${DIR}/questions.md`).unverified.length, 0);
  assert.throws(() => planningReuseAnswer(root, "Q1", "discount", "discount.range"), /답이 없는/);
});

for (const change of ["answer", "question", "source", "evidence", "copy", "record"]) test(`계약 출처 변조 거부 ${change}`, () => {
  register(); questions(); planningReuseAnswer(root, "Q1", "discount", "discount.range");
  const path = join(root, DIR, "questions.md"), original = readFileSync(path, "utf8");
  if (change === "answer") writeFileSync(path, original.replace(statement, "범위 밖도 허용"));
  if (change === "question") writeFileSync(path, original.replace("할인의 범위와 오류 계약은 무엇인가", "배포를 승인하는가"));
  if (change === "source") writeFileSync(path, original.replace("기존 계약 discount discount.range", "대화"));
  if (change === "evidence") writeFileSync(join(repository!, "contract.md"), "범위 밖도 허용\n");
  if (change === "copy") {
    const stored = JSON.parse(readFileSync(join(root, contractsFile(ID)), "utf8")); stored.contracts[0].content = "위조";
    writeFileSync(join(root, contractsFile(ID)), JSON.stringify(stored));
  }
  if (change === "record") writeFileSync(join(root, ".code-agent/work", ID, "answers.jsonl"), "");
  assert.equal(sources().get("Q1"), "unverified");
  assert.equal(openQuestions(root, `${DIR}/questions.md`).unverified.length, 1);
});

test("Source 문자열만으로 계약 출처를 인증하지 않고 근거 없는 질문은 열린 채다", () => {
  questions(statement, "기존 계약 discount discount.range");
  assert.equal(sources().get("Q1"), "unverified");
  questions(); assert.throws(() => planningReuseAnswer(root, "Q1", "discount", "discount.range"), /검증된 계약 항목이 없습니다/);
  assert.equal(openQuestions(root, `${DIR}/questions.md`).unanswered.length, 1);
});

test("pending 상태는 원문 결속을 유지해 answered로 바꾸며 deferred는 덮어쓰지 않는다", () => {
  register(); questions();
  const path = join(root, DIR, "questions.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("[Answer]:", "[Status]: pending\n[Answer]:"));
  planningReuseAnswer(root, "Q1", "discount", "discount.range");
  assert.equal(sources().get("Q1"), "contract");
  questions(); writeFileSync(path, readFileSync(path, "utf8").replace("[Answer]:", "[Status]: deferred\n[Answer]:"));
  assert.throws(() => planningReuseAnswer(root, "Q1", "discount", "discount.range"), /답이 없는/);
});

test("옛 관찰 답은 계약 출처 변경의 우회가 아니며 이후 실제 관찰·위임·사람 전달 답은 구분한다", () => {
  register(); questions();
  const file = join(root, ".code-agent/work", ID, "answers.jsonl");
  const observed = { type: "answer", at: "", host: "claude", session: "s", toolId: "t", items: [{ q: "Q1", answer: statement, questionHash: "old", free: true }] };
  appendFileSync(file, JSON.stringify(observed) + "\n");
  planningReuseAnswer(root, "Q1", "discount", "discount.range");
  questions(statement, "대화");
  assert.equal(sources().get("Q1"), "unverified");
  const original = readFileSync(file, "utf8");
  observeAnswerFixture(root, ID, "Q1", statement);
  assert.equal(sources().get("Q1"), "observed");
  for (const actor of ["ai", "human"]) {
    writeFileSync(file, original + JSON.stringify({ type: "delegated", q: "Q1", actor, hash: createHash("sha256").update(statement).digest("hex").slice(0, 16) }) + "\n");
    assert.equal(sources().get("Q1"), actor === "ai" ? "delegated" : "relayed");
  }
});

for (const change of ["hash", "commit", "path", "claim", "conflict", "size"]) test(`유효하지 않은 계약 등록 거부 ${change}`, () => {
  const { input, value } = bundle();
  if (change === "hash") value.contracts[0].sha256 = "0".repeat(64);
  if (change === "commit") value.contracts[0].commit = "0".repeat(40);
  if (change === "path") value.contracts[0].path = "../contract.md";
  if (change === "claim") value.contracts[0].claims[0].text = "범위 밖도 허용";
  if (change === "conflict") {
    const ref = value.contracts[0];
    // 같은 사실 키에 다른 원문 값이 있는 것은 둘 다 실제 Git 근거라도 거부한다.
    writeFileSync(join(repository!, "other.md"), "음수도 허용\n");
    const git = (args: string[]) => execFileSync("git", args, { cwd: ref.repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["-c", "core.autocrlf=false", "add", "other.md"]); git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "other"]);
    value.contracts.push({ ...ref, id: "other", path: "other.md", commit: git(["rev-parse", "HEAD"]), sha256: createHash("sha256").update("음수도 허용\n").digest("hex"), claims: [{ key: "discount.range", text: "음수도 허용" }] });
  }
  writeFileSync(input, change === "size" ? "x".repeat(131073) : JSON.stringify(value));
  assert.throws(() => planningContracts(root, input));
  assert.deepEqual(dependencyContracts(root, ID).contracts, []);
});

test("실행 중 배정의 계약 등록은 거부한다", () => {
  const { input } = bundle(); preparePlanning(root); dispatch("analysis");
  assert.throws(() => planningContracts(root, input), /실행 중 배정/);
});
