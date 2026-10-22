/** 실행 선택과 등록된 권한 설정을 결합한다. 실행 한 건에는 선택한 설정을 고정한다. */
import { existsSync } from "fs";
import { join } from "path";

import { executionPolicy } from "../executionMode";
import { codexReadiness, type CodexCheckMode, type CodexHookStatus, type CodexTarget, type ReadinessProblem, type ReadinessState } from "../codexReadiness";
import { hostCommand, hostCommandConfigError, selectedHosts, type Host } from "../hosts";
import { CLAUDE_HOOKS, CODEX_EVENTS, installedHook, settingsProblem } from "../init";
import { STATE_DIR } from "../layout";
import { canonicalJson, ControlError, executionMain, hostProfileOf, type HostProfile, type RunExecution } from "./protocol";
import { readBinding, readWorkBinding, type Binding, type RunRecord } from "./store";

/** 그 호스트로 등록된 설정 — 없으면 그 호스트의 제한된 기본값 */
export function profileFor(binding: Binding, kind: Host): HostProfile {
  return hostProfileOf(binding.host.kind === kind ? binding.host : binding.hostProfiles?.[kind] ?? { kind });
}
export function selectedProfile(root: string, binding: Binding): HostProfile {
  const policy = executionPolicy(root);
  return profileFor(binding, policy?.mode === "codex" || policy?.mode === "claude" ? policy.mode : policy?.main ?? binding.host.kind);
}
/** master 가 고른 실행 방식의 호스트가 설치 기록에 있어야 한다 — both 는 두 호스트 모두 */
export function requireExecutionHosts(root: string, execution: RunExecution): void {
  const installed = installedHosts(root), needed: Host[] = execution.mode === "both" ? ["claude", "codex"] : [execution.mode];
  const missing = needed.filter((kind) => !installed.includes(kind));
  if (missing.length) throw new ControlError("invalid-state", `실행 방식 ${execution.mode} 에 필요한 호스트가 설치 기록에 없습니다(${missing.join(", ")}) — code-agent init 으로 두 호스트를 준비합니다`,
    { missing: missing.map((kind) => `hosts.json: ${kind}`), problems: ["host-not-installed"] });
}
/**
 * 이어 실행의 호스트 설정 — 이전 실행이 master 가 고른 실행 방식으로 돌았으면 그 작업에 지금 고정된 선택(사람의 handoff 가 바꿨으면 바뀐 선택)과,
 * 아니면 프로젝트 실행 방식과 맞아야 한다. 다른 호스트의 세션은 잇지 않는다.
 */
export function requireResumeProfile(root: string, binding: Binding, previous: RunRecord): HostProfile {
  const profile = previous.hostProfile ?? hostProfileOf(binding.host.kind === "claude" ? binding.host : binding.hostProfiles?.claude);
  const chosen = previous.execution ? (previous.workId ? readWorkBinding(root, previous.workId)?.execution : undefined) ?? previous.execution : undefined;
  const selected = chosen ? profileFor(binding, executionMain(chosen)) : selectedProfile(root, binding);
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

export type HostProblem = ReadinessProblem;
/**
 * Codex 준비를 어떻게 확인하나 — fresh·reuse·stored 는 codexReadiness 의 조회 방식(doctor·init / 접수·재개·복원 / hello),
 * static 은 설치만 본다(감독 — CodexTransport 가 실제로 쓸 app-server 에 같은 판정으로 묻는다)
 */
export type CodexCheck = CodexCheckMode | "static";
export interface HostReadiness { ready: boolean; state: ReadinessState; problems: HostProblem[]; missing: string[]; hooks?: CodexHookStatus[]; checkedAt?: string; target?: CodexTarget }

/** Codex 준비 조회에 쓸 실행 명령 — master 연동에 등록된 Codex 설정의 command(관리 실행이 띄울 것), 연동 전이면 기본 */
export function codexCommandOf(root: string, binding: Binding | undefined = readBinding(root)): readonly string[] {
  return (binding ? profileFor(binding, "codex") : hostProfileOf({ kind: "codex" })).command;
}

/**
 * 한 호스트의 실행 준비 — 설치 단계(설치 기록·설정 파일·code-agent hook)를 먼저 보고, 막히면 거기서 끝낸다(설치 누락). Codex 는 그다음
 * app-server 에 프로젝트 신뢰와 hook 신뢰를 묻는다(codexReadiness — 앞 단계가 막히면 뒤 단계는 알리지 않는다).
 */
export function hostReadiness(root: string, kind: Host, options: { codex?: CodexCheck; command?: readonly string[]; kick?: boolean } = {}): HostReadiness {
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
    // Codex 는 doctor·CodexTransport 와 같이 CODEX_EVENTS 전부를 본다 — 감독은 하나라도 로드되지 않으면 턴을 시작하지 않는다
    const hooks = kind === "claude" ? CLAUDE_HOOKS.filter(([event, subcommand]) => !installedHook(root, event, subcommand)).map(([event, subcommand]) => `Claude ${event}(${subcommand})`)
      : CODEX_EVENTS.filter((event) => !installedHook(root, event, "codex-event", "codex")).map((event) => `Codex ${event}(codex-event)`);
    missing.push(...hooks);
    if (hooks.length) problems.push({ code: "hooks-missing", message: `빠진 hook: ${hooks.join(" · ")} — code-agent init(또는 doctor)으로 복구합니다` });
  }
  if (problems.length) return { ready: false, state: "not-installed", problems, missing };
  if (kind !== "codex" || options.codex === "static") return { ready: true, state: "ready", problems, missing };
  const codex = codexReadiness(root, options.codex ?? "reuse", { command: options.command ?? codexCommandOf(root), kick: options.kick });
  return { ready: codex.state === "ready", state: codex.state, problems: codex.problems, missing, ...(codex.hooks ? { hooks: codex.hooks } : {}),
    checkedAt: codex.checkedAt, ...(codex.target ? { target: codex.target } : {}) };
}

/**
 * 교차 검증 호스트의 준비 — 교차 검증은 그 호스트를 hostCommand 로 찾아 읽기 전용으로 한 번 실행하고(codex exec -s read-only·claude -p)
 * 결과를 파일로 받는다. 교차 자식에서 hook 은 쓰기 거부 말고는 하는 일이 없어 Codex 의 프로젝트·hook 신뢰가 필요하지 않다 — 설치와 실행 파일만 본다.
 */
export function crossHostReadiness(root: string, kind: Host): HostReadiness {
  const installed = hostReadiness(root, kind, { codex: "static" });
  if (!installed.ready) return installed;
  const resolved = hostCommand(kind);
  if (typeof resolved !== "string") return installed;
  return { ready: false, state: "not-installed", missing: [], problems: [{ code: hostCommandConfigError(resolved) ? "cross-host-config" : "cross-host-not-found",
    message: `교차 검증 호스트(${HOST_LABEL[kind]})를 실행할 수 없습니다 — ${resolved}` }] };
}

const HOST_LABEL: Record<Host, string> = { claude: "Claude", codex: "Codex" };
/** 준비되지 않은 호스트의 거부 — 설치 누락은 복구 안내, 그 밖(신뢰·검토·조회)은 Codex 가 알린 사유. 신뢰를 자동 우회하지 않는다 */
function readinessError(kind: Host, readiness: HostReadiness, cross = false): ControlError {
  const detail = { host: kind, state: readiness.state, missing: readiness.missing, problems: readiness.problems.map((problem) => problem.code), ...(readiness.hooks ? { hooks: readiness.hooks } : {}) };
  const messages = readiness.problems.map((problem) => problem.message).join(" · ");
  if (cross) {
    return new ControlError("invalid-state", `교차 검증(both) 실행을 시작하지 않습니다 — ${readiness.missing.length ? `${HOST_LABEL[kind]} 설치에서 빠진 항목: ${readiness.missing.join(" · ")}` : messages}. ` +
      "그 호스트를 설치·복구하거나 단독 실행(claude·codex)을 고릅니다", { ...detail, role: "cross" });
  }
  if (readiness.state === "not-installed") {
    return new ControlError("invalid-state", `${HOST_LABEL[kind]} 관리 실행 전에 init·doctor로 이 프로젝트의 ${HOST_LABEL[kind]} 설치와 hook을 복구하세요 — ` +
      `${readiness.missing.length ? `빠진 항목: ${readiness.missing.join(" · ")}` : messages}`, detail);
  }
  return new ControlError("invalid-state", `${HOST_LABEL[kind]} 관리 실행을 시작하지 않습니다 — ${messages}. 신뢰를 자동 우회하지 않습니다`, detail);
}
export function requireManagedHost(root: string, profile: HostProfile, options: { codex?: CodexCheck } = {}): void {
  const readiness = hostReadiness(root, profile.kind, { codex: options.codex ?? "reuse", ...(profile.kind === "codex" ? { command: profile.command } : {}) });
  if (!readiness.ready) throw readinessError(profile.kind, readiness);
}
/**
 * 이 실행이 쓸 호스트 모두의 준비 — 주 호스트(관리 실행), 그리고 both 를 고른 실행(고른 것, 없으면 프로젝트 실행 방식)이면 교차 검증 호스트의
 * 설치·실행 파일(crossHostReadiness). 실행 방식을 고르지 않은 auto 의 두 호스트 설치는 교차 검증이 켜지지만 여기서 막지 않는다 — 실행할 수
 * 없는 교차 검증은 그 지점을 중지로 기록하고 진행하는 규약(cross-unavailable)이 그대로 다룬다.
 */
export function requireRunHosts(root: string, profile: HostProfile, execution: RunExecution | undefined, options: { codex?: CodexCheck } = {}): void {
  requireManagedHost(root, profile, options);
  if ((execution?.mode ?? executionPolicy(root)?.mode) !== "both") return;
  const other: Host = profile.kind === "claude" ? "codex" : "claude", cross = crossHostReadiness(root, other);
  if (!cross.ready) throw readinessError(other, cross, true);
}

const STATE_ORDER: ReadinessState[] = ["not-installed", "project-untrusted", "hooks-review", "query-failed", "checking"];
export interface ModeReadiness { ready: boolean; state: ReadinessState; blocking: (HostProblem & { host: Host })[] }
/** 실행 방식의 준비 — 그 방식이 쓰는 호스트가 모두 준비돼야 한다. 상태는 앞 단계의 것(설치 누락 → 미신뢰 → 검토 → 조회 실패 → 확인 중) */
function modeReadiness(parts: [Host, HostReadiness][]): ModeReadiness {
  return { ready: parts.every(([, item]) => item.ready), state: STATE_ORDER.find((state) => parts.some(([, item]) => item.state === state)) ?? "ready",
    blocking: parts.flatMap(([host, item]) => item.problems.map((problem) => ({ host, ...problem }))) };
}

/**
 * hello.managedHost — 켠 연동은 지금 선택될 호스트, 켜기 전이면 켜면 선택될 호스트와 그 준비 상태(비밀값 없음).
 * runSelection 은 submit 의 execution 으로 고를 수 있는 실행 방식(설치 기록의 호스트), runReadiness 는 실행 방식마다의 실행 준비와 차단 이유
 * (both 는 주 호스트마다 — 주 호스트의 관리 실행 준비와 다른 호스트의 교차 검증 준비), hosts 는 설치된 호스트마다의 관리 실행 준비다.
 * 고를 수 있다고 준비된 것은 아니다. Codex 준비는 hello 가 묻지 않고 기록된 판정을 읽는다(codexReadiness stored — 연동한 프로젝트면 없거나
 * 기한이 지난 판정을 분리 프로세스가 다시 묻는다).
 */
export function managedHostView(root: string, binding: Binding | undefined): {
  selected: Host | null; source: HostSource | null; installedHosts: Host[]; execution: { mode: string; main?: string } | null; ready: boolean; state: ReadinessState | null;
  problems: HostProblem[]; runSelection: { supported: true; modes: string[] };
  runReadiness: { claude: ModeReadiness; codex: ModeReadiness; both: Record<Host, ModeReadiness> };
  hosts: Partial<Record<Host, { ready: boolean; state: ReadinessState; problems: HostProblem[]; checkedAt?: string; target?: CodexTarget }>>;
} {
  const problems: HostProblem[] = [];
  let installed: Host[] = [];
  try { installed = installedHosts(root); } catch { /* hostReadiness 가 알린다 */ }
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
  // 한 hello 에서 호스트마다 한 번만 판정한다(선택 호스트·호스트별·실행 방식별이 같은 결과를 쓴다)
  const command = codexCommandOf(root, binding), memo = new Map<Host, HostReadiness>(), crossMemo = new Map<Host, HostReadiness>();
  const readiness = (kind: Host): HostReadiness => {
    if (!memo.has(kind)) memo.set(kind, hostReadiness(root, kind, { codex: "stored", command, kick: !!binding }));
    return memo.get(kind)!;
  };
  const cross = (kind: Host): HostReadiness => {
    if (!crossMemo.has(kind)) crossMemo.set(kind, crossHostReadiness(root, kind));
    return crossMemo.get(kind)!;
  };
  if (selected) problems.push(...readiness(selected.kind).problems);
  const hosts = Object.fromEntries(installed.map((kind) => {
    const own = readiness(kind);
    return [kind, { ready: own.ready, state: own.state, problems: own.problems, ...(own.checkedAt ? { checkedAt: own.checkedAt } : {}), ...(own.target ? { target: own.target } : {}) }];
  }));
  return { selected: selected?.kind ?? null, source: selected?.source ?? null, installedHosts: installed,
    execution: execution ? { mode: execution.mode, ...(execution.main ? { main: execution.main } : {}) } : null, ready: !!selected && !problems.length,
    state: selected ? readiness(selected.kind).state : null, problems,
    runSelection: { supported: true, modes: [...installed, ...(installed.length === 2 ? ["both"] : [])] },
    runReadiness: { claude: modeReadiness([["claude", readiness("claude")]]), codex: modeReadiness([["codex", readiness("codex")]]),
      both: { claude: modeReadiness([["claude", readiness("claude")], ["codex", cross("codex")]]), codex: modeReadiness([["codex", readiness("codex")], ["claude", cross("claude")]]) } }, hosts };
}
