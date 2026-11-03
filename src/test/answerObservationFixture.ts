import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { answerSources } from "../agent/answers";
import { start } from "../agent/commands";
import { runConsentHook } from "../agent/consent";
import { parseQuestions } from "../agent/questions";
import { CONSENT_SPEC, CONSENT_WORK_ID, approveAndApplyFixture, setupConsentProject, submitConsentRequest, writeFixture } from "./consentFixture";

let root: string;
const QUESTIONS = `doc/work/${CONSENT_WORK_ID}/questions.md`;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-answers-")));
  setupConsentProject(root);
});
afterEach(() => {
  const target = resolve(root), temporary = realpathSync.native(tmpdir());
  assert.ok(target.startsWith(temporary + sep) && target.slice(temporary.length + 1).startsWith("ca-answers-"));
  rmSync(target, { recursive: true, force: true });
});

function startWork(): void {
  approveAndApplyFixture(root, { action: "setup" });
  submitConsentRequest(root);
  approveAndApplyFixture(root, { action: "request", id: CONSENT_WORK_ID });
  start(root, join(root, CONSENT_SPEC));
}
/** 업무 질문 Claude 이벤트를 production hook 진입점으로 넣는다 — CLAUDE_PROJECT_DIR 을 이 저장소로 두고 stderr 를 모은다 */
function hook(event: object): { code: number; stderr: string } {
  const saved = process.env.CLAUDE_PROJECT_DIR, write = process.stderr.write;
  let stderr = "";
  process.env.CLAUDE_PROJECT_DIR = root;
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  try { return { code: runConsentHook(JSON.stringify(event)), stderr }; }
  finally {
    process.stderr.write = write;
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
  }
}
const question = (text: string, labels: string[], header = "범위") =>
  ({ question: text, header, options: labels.map((label) => ({ label, description: label })), multiSelect: false });
function ask(text: string, labels: string[], answer: string, extra: { agent?: string; prefilled?: boolean; skipPre?: boolean; tool?: string; rawTitle?: boolean } = {}) {
  const q = /^Q\d+/.exec(text)?.[0];
  if (q && !extra.rawTitle) {
    const source = parseQuestions(readFileSync(join(root, QUESTIONS), "utf8")).find(question => question.id === q);
    if (source) text = `${source.title}\n${text}`;
  }
  const questions = [question(text, labels)];
  const base = { cwd: root, session_id: "main", tool_use_id: extra.tool ?? `tool-${Math.random()}`, tool_name: "AskUserQuestion",
    ...(extra.agent ? { agent_id: extra.agent } : {}) };
  if (!extra.skipPre) {
    const result = hook({ ...base, hook_event_name: "PreToolUse", tool_input: { questions, ...(extra.prefilled ? { answers: { [text]: answer } } : {}) } });
    assert.equal(result.code, extra.prefilled ? 2 : 0);
    if (extra.prefilled) assert.match(result.stderr, /답을 미리 넣을 수 없습니다/);
  }
  assert.equal(hook({ ...base, hook_event_name: "PostToolUse", tool_input: { questions }, tool_response: { questions, answers: { [text]: answer } } }).code, 0);
}
const writeQuestions = (body: string) => writeFixture(root, QUESTIONS, `# ${CONSENT_WORK_ID} 질문\n\n${body}`);
const sources = () => answerSources(root, CONSENT_WORK_ID, parseQuestions(readFileSync(join(root, QUESTIONS), "utf8")));

export { root, QUESTIONS, startWork, hook, question, ask, writeQuestions, sources };
