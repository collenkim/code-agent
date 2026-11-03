import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { start } from "../agent/commands";

import { decide, type HookInput } from "../agent/hook";
import { storePath } from "../agent/plugins/store";
import { CONSENT_SPEC, CONSENT_WORK_ID, approveAndApplyFixture, setupConsentProject, submitConsentRequest } from "./consentFixture";
import { stubCodexProbe } from "./codexProbeFixture";

let root: string, home: string;
// doctor 는 Codex 준비를 지금 묻는다 — 실제 Codex·사용자 CODEX_HOME 대신 신뢰하지 않은 새 프로젝트의 응답으로 답한다(판정 기록은 아래 CODE_AGENT_HOME 에)
let probe: { restore(): void };
const saved = { home: process.env.CODE_AGENT_HOME, claude: process.env.CLAUDECODE };
const cli = join(__dirname, "../agent/cli.js");
beforeEach(() => {
  probe = stubCodexProbe("project-untrusted", { bin: false });
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-hookpaths-")));
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-hookhome-")));
  process.env.CODE_AGENT_HOME = join(home, ".code-agent");
  mkdirSync(process.env.CODE_AGENT_HOME, { recursive: true });
  writeFileSync(storePath(), "{}");
  setupConsentProject(root);
});
afterEach(() => {
  probe.restore();
  for (const [key, value] of [["CODE_AGENT_HOME", saved.home], ["CLAUDECODE", saved.claude]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const temporary = realpathSync.native(tmpdir());
  for (const target of [resolve(root), resolve(home)]) {
    assert.ok(target.startsWith(temporary + sep) && /^ca-hook/.test(target.slice(temporary.length + 1)));
    rmSync(target, { recursive: true, force: true });
  }
});

const tool = (tool_name: string, tool_input: HookInput["tool_input"], extra: Partial<HookInput> = {}) => decide({ cwd: root, session_id: "s", tool_name, tool_input, ...extra });
const write = (file_path: string) => tool("Write", { file_path });
const bash = (command: string) => tool("Bash", { command });
function startWork(): void {
  approveAndApplyFixture(root, { action: "setup" });
  submitConsentRequest(root);
  approveAndApplyFixture(root, { action: "request", id: CONSENT_WORK_ID });
  start(root, join(root, CONSENT_SPEC));
}
const store = () => dirname(storePath());

export { root, probe, saved, cli, tool, write, bash, startWork, store, home };
