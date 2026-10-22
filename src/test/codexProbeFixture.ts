/**
 * Codex 준비 조회의 시험 대역 — codexProbeRunner.query 를 실측(codex-cli 0.163.0) 꼴의 응답으로 바꿔 끼운다. 실제 Codex 와 사용자의
 * CODEX_HOME 을 띄우지 않는다. 실행 파일 해석(hostCommand)도 Codex 설치와 무관하게 지나가도록 CODE_AGENT_CODEX_BIN 을 이 node 로 두고,
 * 판정 기록이 사용자 홈에 남지 않게 CODE_AGENT_HOME 을 임시 폴더로 둔다.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { codexProbeRunner, type CodexProbeRaw } from "../agent/codexReadiness";

export type ProbeState = "ready" | "project-untrusted" | "hooks-review" | "modified" | "not-loaded" | "query-failed" | "spawn-missing" | "hooks-disabled" | "legacy" | "legacy-untrusted";
const EVENTS = ["preToolUse", "userPromptSubmit", "subagentStart", "subagentStop", "stop", "sessionStart"];

/** 실측 응답 꼴 — 신뢰하지 않으면 project 층에 disabledReason 이 있고 hooks/list 는 hook 을 돌려주지 않는다 */
export function probeResponse(root: string, state: ProbeState, home = join(root, "codex-home")): CodexProbeRaw {
  if (state === "query-failed") return { error: "config/read 실패: internal error" };
  if (state === "spawn-missing") return { error: "spawn codex ENOENT", code: "ENOENT" };
  const server = { userAgent: "code_agent/0.163.0 (Windows 10.0.26200; x86_64) fixture", codexHome: home };
  const untrusted = state === "project-untrusted" || state === "legacy-untrusted";
  const status = state === "hooks-review" ? "untrusted" : "trusted";
  const hooks = EVENTS.filter((eventName) => state !== "not-loaded" || eventName !== "stop").map((eventName, index) => ({
    eventName, handlerType: "command", enabled: true, async: false, trustStatus: state === "modified" && index === 0 ? "modified" : status,
    sourcePath: join(root, ".codex", "hooks.json"), command: ["code-agent", ["codex", "event"].join("-")].join(" ") }));
  // config/read 가 없는 옛 Codex — hooks/list 만 답하고, 신뢰하지 않은 프로젝트의 hook 은 돌려주지 않는다
  if (state === "legacy" || state === "legacy-untrusted") return { server, configUnsupported: true, hooks: { data: [{ cwd: root, errors: [], hooks: untrusted ? [] : hooks }] } };
  return {
    server,
    config: { config: { features: state === "hooks-disabled" ? { hooks: false } : {} }, layers: [
      { name: { type: "project", dotCodexFolder: join(root, ".codex") },
        disabledReason: untrusted ? `To load project-local config, hooks, and exec policies, add ${root.toLowerCase()} as a trusted project in ${join(home, "config.toml")}.` : null },
      { name: { type: "user", file: join(home, "config.toml") }, disabledReason: null }] },
    hooks: { data: [{ cwd: root, errors: [], hooks: untrusted ? [] : hooks }] },
  };
}

/**
 * 바꿔 끼운다 — 되돌리기와 부른 횟수를 돌려준다. state 가 함수면 부를 때마다 고른다. bin 이 false 면 실행 파일 변수는 그대로 둔다 — 준비 판정이
 * 아닌 줄(교차 검증 실행 파일)을 보는 시험용이다. Codex 가 없는 PC 는 조회 전에 codex-not-found 가 된다
 */
export function stubCodexProbe(state: ProbeState | ((root: string) => CodexProbeRaw), options: { bin?: boolean } = {}): { restore(): void; calls(): number } {
  const original = codexProbeRunner.query, bin = process.env.CODE_AGENT_CODEX_BIN, home = process.env.CODE_AGENT_HOME;
  const store = mkdtempSync(join(tmpdir(), "ca-readiness-"));
  let count = 0;
  if (options.bin !== false) process.env.CODE_AGENT_CODEX_BIN = process.execPath;
  process.env.CODE_AGENT_HOME = store;
  codexProbeRunner.query = (_launch, root) => { count += 1; return typeof state === "function" ? state(root) : probeResponse(root, state); };
  return {
    restore() {
      codexProbeRunner.query = original;
      if (bin === undefined) delete process.env.CODE_AGENT_CODEX_BIN; else process.env.CODE_AGENT_CODEX_BIN = bin;
      if (home === undefined) delete process.env.CODE_AGENT_HOME; else process.env.CODE_AGENT_HOME = home;
      rmSync(store, { recursive: true, force: true });
    },
    calls: () => count,
  };
}
