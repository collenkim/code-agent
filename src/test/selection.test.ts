import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { assetKeys, assetText, CLAUDE_ASSETS, installedPath } from "../agent/assets";
import { init } from "../agent/init";
import { update } from "../agent/update";
import { docsBegin, docsEnd } from "../agent/docsCommands";
import { decide as hook } from "../agent/hook";
import { requestBegin, requestSubmit, requestState } from "../agent/request";
import { parseQuestions, unansweredQuestions } from "../agent/questions";
import { recommendSetup, setupProject } from "../agent/setup";

let repo: string;
function write(file: string, value: string) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), value);
}
beforeEach(() => {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-selection-")));
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "pipe" });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("init과 update가 18개 명령에 선택 절차를 설치하고 옛 질문 지시를 교체한다", () => {
  init(repo, { cli: join(__dirname, "../agent/cli.js") });
  const skills = assetKeys(CLAUDE_ASSETS).filter((key) => key.endsWith("/SKILL.md"));
  assert.equal(skills.length, 18);
  for (const key of skills) {
    const text = readFileSync(installedPath(repo, key), "utf8");
    assert.match(text, /AskUserQuestion/, key);
    assert.doesNotMatch(text, /사람에게 물을 것은.*턴의 마지막|\?{4}/, key);
  }
  write(".claude/skills/ca-answer/SKILL.md", "질문 목록을 채팅에 출력하고 멈춘다.\n");
  write(".claude/skills/ca-request/SKILL.md", "질문 후 ca-answer 입력을 기다린다.\n");
  update(repo);
  for (const name of ["ca-answer", "ca-request"]) {
    const key = `${CLAUDE_ASSETS}/skills/${name}/SKILL.md`;
    assert.equal(readFileSync(installedPath(repo, key), "utf8"), assetText(key));
  }
});

test("신규는 7개 실제 후보를 안내하고 기존 설정에는 재선택을 요구하지 않는다", () => {
  const text = recommendSetup(repo);
  const ids = [...text.matchAll(/^- ([a-z-]+):/gm)].map((match) => match[1]);
  assert.deepEqual(ids, ["node", "python", "typescript", "fastapi", "java-spring", "kotlin-spring", "go"]);
  docsBegin(repo);
  // 새 후보는 자동 생성 프리셋으로 잘못 전달하지 않는다.
  assert.throws(() => setupProject(repo, "java-spring"), /node \| python/);
  setupProject(repo, "node");
  docsEnd(repo);
  assert.match(recommendSetup(repo), /기존 프로젝트 설정 유지/);
  assert.doesNotMatch(recommendSetup(repo), /java-spring/);
});

test("선택 도구와 질문 기록은 접수·준비에서 허용되지만 답은 요구사항 승인이 아니다", () => {
  requestBegin(repo, "SELECT-1", "feature");
  const questionPath = "doc/work/SELECT-1/questions.md";
  const question = "## Q1 · 범위\n어디까지 만드나요?\nA. 서비스 전체\nB. 모듈 하나\n[Answer]: 서비스 전체\n";
  assert.equal(hook({ cwd: repo, tool_name: "AskUserQuestion", tool_input: {} }), undefined);
  assert.equal(hook({ cwd: repo, tool_name: "Write", tool_input: { file_path: join(repo, questionPath) } }), undefined);
  write(questionPath, question);
  docsBegin(repo);
  assert.equal(hook({ cwd: repo, tool_name: "AskUserQuestion", tool_input: {} }), undefined);
  setupProject(repo, "node");
  docsEnd(repo);
  write("doc/work/SELECT-1/request.json", JSON.stringify({ id: "SELECT-1", kind: "feature", title: "알림 API", target: ["notification"], original: "알림을 전송한다.", requirements: ["알림을 전송한다."], clarifications: [{ question: "어디까지 만드나요?", answer: "서비스 전체" }] }));
  requestSubmit(repo, join(repo, "doc/work/SELECT-1/request.json"));
  assert.equal(requestState(repo, "SELECT-1", "doc/work/SELECT-1/requirement.md").status, "none");
  assert.equal(parseQuestions(readFileSync(join(repo, questionPath), "utf8"))[0].answer, "서비스 전체");
  assert.deepEqual(unansweredQuestions(repo, questionPath), []);
  write(questionPath, question.replace("[Answer]: 서비스 전체", "상태: 보류 — 아직 정하지 않음\n[Answer]:"));
  assert.equal(unansweredQuestions(repo, questionPath).length, 1);
});
