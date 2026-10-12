/**
 * 호스트별 표기(hostText.ts) — 판정 순서와 표기 함수.
 *
 * 표기는 CODE_AGENT_HOST → hosts.json(설치 호스트가 하나면) → 실행 환경(crossEnv.runtimeHost) → 중립 순으로 정한다.
 * Claude 표기는 지금 CLI·hook 문자열과 바이트가 같아야 한다(배선할 때 문구가 바뀌지 않게).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runtimeHost } from "../agent/crossEnv";
import * as hosts from "../agent/hosts";
import {
  POWERSHELL_COMMAND_GUIDE, agentName, askVia, codexAgentName, commonAgentName, fileToolsHint, hostLabel, installedHosts, notation, notationFor, ROLE_NAMES,
  shellLabel, skill, SKILL_NAMES, viaShell, withNotation, type Notation,
} from "../agent/hostText";

const repo = join(__dirname, "..", "..");

test("notationFor — CODE_AGENT_HOST → 설치 호스트 하나 → 실행 환경 → 중립", () => {
  const root = mkdtempSync(join(tmpdir(), "ca-host-"));
  try {
    const write = (value: string) => { mkdirSync(join(root, ".code-agent"), { recursive: true }); writeFileSync(join(root, ".code-agent", "hosts.json"), value); };
    assert.deepEqual(installedHosts(root), ["claude"], "hosts.json 이 없으면 claude");
    assert.equal(notationFor(root, {}), "claude");
    write(JSON.stringify(["codex"]));
    assert.equal(notationFor(root, { CLAUDECODE: "1" }), "codex", "설치 호스트가 하나면 실행 환경보다 앞선다");
    write(JSON.stringify(["claude", "codex", "codex"]));
    assert.deepEqual(installedHosts(root), ["claude", "codex"]);
    assert.equal(notationFor(root, { CLAUDECODE: "1" }), "claude");
    assert.equal(notationFor(root, { CODEX_CI: "1" }), "codex");
    assert.equal(notationFor(root, { CODEX_SANDBOX: "seatbelt" }), "codex");
    assert.equal(notationFor(root, { CLAUDECODE: "1", CODEX_CI: "1" }), "neutral", "두 표지가 함께면 중립");
    assert.equal(notationFor(root, {}), "neutral");
    assert.equal(notationFor(root, { CODE_AGENT_HOST: "codex", CLAUDECODE: "1" }), "codex", "표기 고정이 가장 앞선다");
    assert.equal(notationFor(`${root}/`, { CODE_AGENT_HOST: "bogus" }), "neutral");
    write("\"x\"");
    assert.deepEqual(installedHosts(root), [], "깨진 기록");
    assert.equal(notationFor(root, {}), "neutral");
    write(JSON.stringify(["gemini"]));
    assert.deepEqual(installedHosts(root), []);
    assert.equal(runtimeHost({ CODE_AGENT_HOST: "codex" }), undefined, "표기 전용 값이 교차 거부 판정에 새지 않는다");
    assert.equal(notationFor("없는-경로", {}, ["codex"]), "codex", "설치 호스트를 넘기면 파일을 읽지 않는다");
    assert.deepEqual(installedHosts(root, () => undefined), ["claude"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("표기 함수 — Claude·Codex·중립", () => {
  const table: Record<Notation, string[]> = {
    claude: ["/ca-next", "ca-tester", "AskUserQuestion으로", "Bash 로", "Bash:", "파일은 Write/Edit 로 고치고, 읽기는 Read/Grep/Glob 을 쓰세요."],
    codex: ["$ca-next", "ca_tester", "Codex 질문 도구(없으면 대화)로", "셸로", "셸:", `파일은 apply_patch로 고치고, 읽기는 code-agent read <파일> [시작 줄] [줄 수]를 쓰세요. ${POWERSHELL_COMMAND_GUIDE}`],
    neutral: ["/ca-next($ca-next)", "ca-tester(ca_tester)", "질문 도구(Claude Code: AskUserQuestion · Codex: 질문 도구 또는 대화)로", "셸로", "셸:",
      "파일은 Write/Edit 로 고치고, 읽기는 Read/Grep/Glob 을 쓰세요. (Codex: apply_patch · code-agent read)"],
  };
  for (const [n, expected] of Object.entries(table) as [Notation, string[]][]) {
    assert.deepEqual([skill("ca-next", n), agentName("ca-tester", n), askVia(n), viaShell(n), shellLabel(n), fileToolsHint(n)], expected, n);
    assert.equal(agentName("general-purpose", n), "general-purpose", "역할 이름이 아니면 그대로");
    assert.deepEqual(withNotation(n, () => [skill("ca-answer"), agentName("ca-reviewer")]), [skill("ca-answer", n), agentName("ca-reviewer", n)]);
  }
  assert.equal(hostLabel("claude"), "Claude Code");
  assert.equal(hostLabel("codex"), "Codex");
});

test("withNotation 은 끝나면(예외가 나도) 이전 표기로 돌아가고 기본값은 claude 다", () => {
  assert.equal(notation(), "claude");
  withNotation("codex", () => {
    assert.equal(notation(), "codex");
    assert.throws(() => withNotation("neutral", () => { assert.equal(skill("ca-plan"), "/ca-plan($ca-plan)"); throw new Error("x"); }), /x/);
    assert.equal(notation(), "codex");
  });
  assert.equal(notation(), "claude");
});

test("스킬·역할 목록이 템플릿과 같고, 역할 이름 변환이 hosts.ts 와 같다", () => {
  const skills = readdirSync(join(repo, "template", "claude", "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual([...SKILL_NAMES].sort(), skills);
  const agents = readdirSync(join(repo, "template", "claude", "agents")).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)).sort();
  assert.deepEqual([...ROLE_NAMES].sort(), agents);
  for (const name of [...ROLE_NAMES, "ca-unknown", "general-purpose"]) {
    assert.equal(codexAgentName(name), hosts.codexAgentName(name), name);
    assert.equal(commonAgentName(codexAgentName(name)), hosts.commonAgentName(hosts.codexAgentName(name)), name);
  }
  assert.equal(commonAgentName(undefined), undefined);
});

test("hook 은 표기 함수로 문구를 만든다 — 사후 치환이 남지 않는다", () => {
  const hook = readFileSync(join(repo, "src", "agent", "hook.ts"), "utf8");
  const codexHook = readFileSync(join(repo, "src", "agent", "codexHook.ts"), "utf8");
  // 배선 뒤에는 hook.ts 가 fileToolsHint() 를 부르고, codexHook.ts 는 문구를 치환하지 않는다(withNotation("codex") 로 판정)
  assert.ok(hook.includes("fileToolsHint()"), "hook.ts 의 파일 도구 안내는 표기 함수");
  assert.ok(!codexHook.includes(`"${fileToolsHint("claude")}"`) && !codexHook.includes("Codex 질문 절차"), "codexHook.ts 의 사후 치환 제거");
  assert.ok(codexHook.includes('withNotation("codex"'), "codexHook 은 Codex 표기로 판정한다");
});
