/** 실행 선택과 등록된 권한 설정을 결합한다. 실행 한 건에는 선택한 설정을 고정한다. */
import { existsSync } from "fs";
import { join } from "path";

import { executionPolicy } from "../executionMode";
import { codexTrust } from "../codexTrust";
import { selectedHosts, type Host } from "../hosts";
import { CLAUDE_HOOKS, installedHook, settingsProblem } from "../init";
import { STATE_DIR } from "../layout";
import { canonicalJson, ControlError, hostProfileOf, type HostProfile } from "./protocol";
import type { Binding, RunRecord } from "./store";

export function selectedProfile(root: string, binding: Binding): HostProfile {
  const policy = executionPolicy(root);
  const kind = policy?.mode === "codex" || policy?.mode === "claude" ? policy.mode : policy?.main ?? binding.host.kind;
  return hostProfileOf(binding.host.kind === kind ? binding.host : binding.hostProfiles?.[kind] ?? { kind });
}
export function requireResumeProfile(root: string, binding: Binding, previous: RunRecord): HostProfile {
  const profile = previous.hostProfile ?? hostProfileOf(binding.host.kind === "claude" ? binding.host : binding.hostProfiles?.claude);
  const selected = selectedProfile(root, binding);
  if (selected.kind !== profile.kind) throw new ControlError("invalid-state", "다른 호스트의 세션을 재개할 수 없습니다. execution --handoff로 인계한 뒤 같은 작업에 새 호스트 실행을 시작하세요");
  if (canonicalJson(selected) !== canonicalJson(profile)) throw new ControlError("invalid-state", "등록된 호스트 권한·실행 설정이 바뀌었습니다. 이전 설정으로 자동 재개하지 않습니다");
  if (profile.kind === "codex" && !previous.sessionConfirmed) throw new ControlError("invalid-state", "확인된 Codex thread ID가 없습니다. 새 실행을 자동 생성하지 않습니다");
  return profile;
}

/** 설치 기록(hosts.json)의 호스트 — 파일이 없으면 빈 목록. 깨졌으면 selectedHosts 가 던진다 */
export function installedHosts(root: string): Host[] {
  return existsSync(join(root, STATE_DIR, "hosts.json")) ? selectedHosts(root) : [];
}
export type HostSource = "execution" | "execution-main" | "installed" | "default" | "binding";
/**
 * 처음 켤 때의 기본 호스트(터미널 enable·페어링 같다) — execution.json 의 mode(both 면 main) → 설치 호스트가 하나면 그 호스트 → claude.
 * 이미 켠 연동의 호스트는 이 규칙으로 바꾸지 않는다(selectedProfile·requireResumeProfile).
 */
export function defaultManagedHost(root: string): { kind: Host; source: HostSource } {
  const policy = executionPolicy(root);
  if (policy?.mode === "claude" || policy?.mode === "codex") return { kind: policy.mode, source: "execution" };
  if (policy?.mode === "both" && policy.main) return { kind: policy.main, source: "execution-main" };
  const installed = installedHosts(root);
  if (installed.length === 1) return { kind: installed[0], source: "installed" };
  return { kind: "claude", source: "default" };
}

export interface HostProblem { code: string; message: string }
/** 관리 실행 호스트의 준비 문제 — 설치 기록·hook·(Codex) 프로젝트·hook 신뢰. 빈 목록이면 준비됐다 */
export function managedHostProblems(root: string, kind: Host): { problems: HostProblem[]; missing: string[]; trust?: ReturnType<typeof codexTrust> } {
  const problems: HostProblem[] = [], missing: string[] = [];
  let hosts: Host[] | undefined;
  try { hosts = installedHosts(root); } catch (error) { problems.push({ code: "hosts-unreadable", message: error instanceof Error ? error.message : String(error) }); }
  if (hosts && !hosts.includes(kind)) {
    missing.push(`hosts.json: ${kind}`);
    problems.push({ code: "host-not-installed", message: `설치 기록(.code-agent/hosts.json)에 ${kind} 가 없습니다 — code-agent init 으로 설치합니다` });
  }
  const broken = settingsProblem(root, kind);
  if (broken) {
    missing.push(kind === "claude" ? ".claude/settings.json" : ".codex/hooks.json");
    problems.push({ code: "settings-unreadable", message: broken });
  } else {
    const hooks = kind === "claude" ? CLAUDE_HOOKS.filter(([event, subcommand]) => !installedHook(root, event, subcommand)).map(([event, subcommand]) => `Claude ${event}(${subcommand})`)
      : installedHook(root, "PreToolUse", "codex-event", "codex") ? [] : ["Codex PreToolUse(codex-event)"];
    missing.push(...hooks);
    if (hooks.length) problems.push({ code: "hooks-missing", message: `빠진 hook: ${hooks.join(" · ")} — code-agent init(또는 doctor)으로 복구합니다` });
  }
  if (kind !== "codex") return { problems, missing };
  const trust = codexTrust(root);
  if (trust.project !== "trusted") problems.push({ code: "codex-project-untrusted", message: trust.projectText });
  if (trust.hooks !== "recorded") problems.push({ code: "codex-hooks-untrusted", message: trust.hooksText });
  return { problems, missing, trust };
}
export function requireManagedHost(root: string, profile: HostProfile): void {
  const { problems, missing, trust } = managedHostProblems(root, profile.kind);
  if (!problems.length) return;
  if (profile.kind === "codex") {
    throw new ControlError("invalid-state", "Codex 관리 실행 전에 init·doctor로 프로젝트 hook 설치와 프로젝트·hook 신뢰를 확인하세요. 신뢰를 자동 우회하지 않습니다",
      { project: trust?.project, hooks: trust?.hooks, missing, problems: problems.map((problem) => problem.code) });
  }
  throw new ControlError("invalid-state", `Claude 관리 실행 전에 init·doctor로 이 프로젝트의 Claude 설치와 hook을 복구하세요 — 빠진 항목: ${missing.join(" · ") || problems.map((problem) => problem.message).join(" · ")}`,
    { missing, problems: problems.map((problem) => problem.code) });
}

/** hello.managedHost — 켠 연동은 지금 선택될 호스트, 켜기 전이면 켜면 선택될 호스트와 그 준비 상태(비밀값 없음) */
export function managedHostView(root: string, binding: Binding | undefined): {
  selected: Host | null; source: HostSource | null; installedHosts: Host[]; execution: { mode: string; main?: string } | null; ready: boolean; problems: HostProblem[];
} {
  const problems: HostProblem[] = [];
  let installed: Host[] = [];
  try { installed = installedHosts(root); } catch { /* managedHostProblems 가 알린다 */ }
  let execution: ReturnType<typeof executionPolicy> | undefined;
  try { execution = executionPolicy(root); }
  catch (error) { problems.push({ code: "execution-unreadable", message: error instanceof Error ? error.message : String(error) }); }
  let selected: { kind: Host; source: HostSource } | undefined;
  if (!problems.length) {
    try {
      if (binding) {
        const kind = selectedProfile(root, binding).kind;
        selected = { kind, source: execution?.mode === kind ? "execution" : execution?.mode === "both" && execution.main === kind ? "execution-main" : "binding" };
      } else selected = defaultManagedHost(root);
    } catch (error) { problems.push({ code: "hosts-unreadable", message: error instanceof Error ? error.message : String(error) }); }
  }
  if (selected) problems.push(...managedHostProblems(root, selected.kind).problems);
  return { selected: selected?.kind ?? null, source: selected?.source ?? null, installedHosts: installed,
    execution: execution ? { mode: execution.mode, ...(execution.main ? { main: execution.main } : {}) } : null, ready: !!selected && !problems.length, problems };
}
