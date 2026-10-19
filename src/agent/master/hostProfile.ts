/** 실행 선택과 등록된 권한 설정을 결합한다. 실행 한 건에는 선택한 설정을 고정한다. */
import { executionPolicy } from "../executionMode";
import { codexTrust } from "../codexTrust";
import { installedHook } from "../init";
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
export function requireManagedHost(root: string, profile: HostProfile): void {
  if (profile.kind !== "codex") return;
  const trust = codexTrust(root);
  if (!installedHook(root, "PreToolUse", "codex-event", "codex") || trust.project !== "trusted" || trust.hooks !== "recorded") {
    throw new ControlError("invalid-state", "Codex 관리 실행 전에 init·doctor로 프로젝트 hook 설치와 프로젝트·hook 신뢰를 확인하세요. 신뢰를 자동 우회하지 않습니다", { project: trust.project, hooks: trust.hooks });
  }
}
