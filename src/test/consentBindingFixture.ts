import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { codexReplyCode, consentStatus, observeConsent, prepareConsent } from "../agent/consent";
import type { ConsentAction } from "../agent/consent";
import { codexHook } from "../agent/codexHook";
import { decide } from "../agent/hook";
import { ACCEPT_CONSENT, setupConsentProject, writeFixture } from "./consentFixture";

let root: string;
const cli = join(__dirname, "../agent/cli.js");
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-binding-")));
  setupConsentProject(root);
});
afterEach(() => {
  const target = resolve(root), temporary = realpathSync.native(tmpdir());
  assert.ok(target.startsWith(temporary + sep) && target.slice(temporary.length + 1).startsWith("ca-binding-"));
  rmSync(target, { recursive: true, force: true });
});

const bash = (command: string, session = "S1", extra: Record<string, unknown> = {}) =>
  decide({ cwd: root, session_id: session, tool_name: "Bash", tool_input: { command }, ...extra });
const ticketFile = () => join(root, ".code-agent/consents/tickets/prepare.json");
/** CLI 를 셸 표지 없이(사람의 터미널이 아닌 비TTY 자식으로) 돌린다 */
function runCli(args: string[], cwd = root) {
  const env = { ...process.env };
  delete env.CLAUDECODE; delete env.CODE_AGENT_CROSS;
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", env });
}
/** Claude 질문 도구 응답 — 준비 세션 sessionId 로 Pre/Post 를 넣는다 */
function answerAs(id: string, session: string, label = ACCEPT_CONSENT, toolId = `tool-${session}`): void {
  const status = JSON.parse(consentStatus(root, id));
  const base = { cwd: root, session_id: session, tool_use_id: toolId, tool_name: "AskUserQuestion", tool_input: structuredClone(status.toolInput) };
  observeConsent({ ...base, hook_event_name: "PreToolUse" });
  observeConsent({ ...base, hook_event_name: "PostToolUse", tool_response: { questions: status.questions,
    answers: Object.fromEntries(status.questions.map((q: { question: string }) => [q.question, label])) } });
}
const codexReply = (id: string, session: string, choice = "1", code = codexReplyCode(root, id).code) =>
  codexHook({ cwd: root, hook_event_name: "UserPromptSubmit", session_id: session, turn_id: `turn-${session}-${choice}`,
    prompt: `code-agent consent respond ${id} ${choice}${code ? ` ${code}` : ""}` });
const prepared = (action: ConsentAction, binding?: { id: string; host: "claude" | "codex" }) =>
  JSON.parse(prepareConsent(root, action, binding ? { binding } : {})) as { id: string; status: string; warning?: string; codexReply?: { format: string; questions: { question: string }[] }; toolInput: { questions: { question: string }[] } };
const touchDoc = () => writeFixture(root, "doc/architecture.md", readFileSync(join(root, "doc/architecture.md"), "utf8") + "\n바뀜\n");

export { root, cli, bash, ticketFile, runCli, answerAs, codexReply, prepared, touchDoc };
