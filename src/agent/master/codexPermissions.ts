/** Codex가 실제 요청한 단건 실행 권한. 업무 동의·일반 답·위임으로 대신하지 않는다. */
import { randomUUID } from "crypto";
import { realpathSync } from "fs";
import { basename } from "path";
import { splitCommandArgs } from "../consentTicket";
import { leaseConflict } from "../lease";
import { stageOf } from "../interactionSources";
import { bumpInteraction, contextMatches, interactionContext, interactionHash, mutateInteractions, needInteraction, readInteractions, type InteractionRecord } from "../interactions";
import type { InteractionSubmission } from "../interactionSchema";
import { ControlError } from "./protocol";
import { CONTROL_LOCK, emit, readBinding, readOwner, readRun, withLock, type RunRecord } from "./store";

export interface CodexApproval {
  threadId: string; turnId: string; itemId: string; command: string; cwd: string; reason?: string | null;
  kind?: string; environmentId?: string | null; networkApprovalContext?: unknown;
}
/** 복합 셸·인라인 코드·직접 git 변경은 받지 않는다. 기존 hook/CLI 게이트를 거치는 명령만 지원한다. */
export function gitOperationCommand(command: string): boolean {
  let words = splitCommandArgs(command);
  if (!words?.length) return false;
  const shell = basename(words[0].replace(/\\/g, "/")).toLowerCase();
  if (["powershell.exe", "pwsh.exe", "powershell", "pwsh", "bash", "sh", "zsh"].includes(shell)) {
    const at = words.findIndex(w => /^(?:-command|-c|-lc)$/i.test(w));
    if (at < 1 || at !== words.length - 2 || words.slice(1, at).some(w => !/^(?:-noprofile|-noninteractive|-nologo)$/i.test(w))) return false;
    command = words[at + 1];
    words = splitCommandArgs(command);
  }
  // 셸 확장·경로 바꿔치기·환경 변수 대입은 승인 대상이 아니다.
  if (/[;&|<>`$\r\n(){}\[\]*?!%]/.test(command) || !words || !/^(?:code-agent|code-agent\.cmd)$/.test(words[0])) return false;
  return ["start", "verify", "repro"].includes(words[1]) && words.length > 2;
}
export function permissionUnavailable(root: string, record: InteractionRecord): string | undefined {
  const p = record.permission, run = record.context.runId ? readRun(root, record.context.runId) : undefined;
  const owner = readOwner(root);
  if (!p || !run || run.state !== "running" || run.stop || !run.sessionConfirmed || run.sessionId !== p.threadId || run.hostProfile?.kind !== "codex") return "원래 Codex 실행의 권한 요청이 더 이상 유효하지 않습니다.";
  if (!owner || owner.handover || owner.generation !== p.generation || owner.controller !== p.controller || run.generation !== p.generation) return "권한 요청의 소유 세대가 바뀌었습니다.";
  if (run.hostProfile.sandbox !== "workspace-write") return "읽기 전용 실행은 Git 쓰기 권한을 요청할 수 없습니다.";
  return undefined;
}
export function validatePermissionSubmission(root: string, record: InteractionRecord, submission: InteractionSubmission): void {
  const reason = permissionUnavailable(root, record);
  if (reason) throw new ControlError("invalid-state", reason);
  if (submission.answers || submission.verdict || submission.choices || submission.shownHash) throw new ControlError("invalid-request", "실행 권한은 업무 답·동의와 구분하여 응답하세요");
  if (submission.intent === "submit" ? !submission.permissionDecision : !!submission.permissionDecision) throw new ControlError("invalid-request", "실행 권한 제출에는 accept 또는 decline을 명시하세요");
}
export function publishCodexPermission(root: string, run: RunRecord, connectionId: string, rpcId: string | number, params: CodexApproval): InteractionRecord {
  if (run.hostProfile?.kind !== "codex" || run.hostProfile.sandbox !== "workspace-write" || params.threadId !== run.sessionId || !run.sessionConfirmed ||
      (params.kind && params.kind !== "command") || (params.environmentId && params.environmentId !== "local") || params.networkApprovalContext || !params.turnId || !params.itemId ||
      typeof params.command !== "string" || params.command.length > 12000 || !gitOperationCommand(params.command) ||
      typeof params.cwd !== "string" || realpathSync(params.cwd) !== realpathSync(root)) throw new ControlError("policy-forbids", "지원 범위 밖 Codex 권한 요청입니다");
  const context = interactionContext(root, run.sessionId, "codex", run.runId);
  const permission: NonNullable<InteractionRecord["permission"]> = { command: params.command, cwd: params.cwd, reason: (params.reason ?? "Git 작업에 필요한 실행 권한").slice(0, 4000),
    threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, rpcId, connectionId, controller: run.controller, generation: run.generation, scope: "once" };
  const record = mutateInteractions(root, state => {
    const key = `codex-permission:${interactionHash({ connectionId, rpcId }).slice(7)}`;
    const prior = Object.values(state.requests).find(r => r.key === key);
    if (prior) {
      if (interactionHash(prior.permission) !== interactionHash(permission)) throw new ControlError("conflict", "같은 Codex RPC의 명령이 달라졌습니다");
      return prior;
    }
    const at = new Date().toISOString();
    const r: InteractionRecord = { schemaVersion: 1, source: "code-agent", sourceInstanceId: state.instanceId, requestId: randomUUID(), revision: 0, key,
      contentHash: interactionHash({ kind: "host-permission", context, permission }), createdAt: at, updatedAt: at,
      expiresAt: new Date(Math.min(Date.now() + 15 * 60000, Date.parse(run.acceptedAt) + run.timeoutMs)).toISOString(), challenge: randomUUID(),
      stage: stageOf(root), kind: "host-permission", title: "Codex Git 작업 실행 권한", questions: [], context,
      origin: { type: "codex-command", id: params.itemId }, permission, status: "pending" };
    const reason = permissionUnavailable(root, r);
    if (reason) throw new ControlError("invalid-state", reason);
    bumpInteraction(state, r); state.requests[r.requestId] = r; return r;
  });
  emit(root, "interaction.changed", { runId: run.runId, data: { requestId: record.requestId, revision: record.revision, kind: record.kind } });
  return record;
}
/** 서명된 응답을 한 번만 전달한다. 적용 표지를 먼저 기록하여 중단 후에도 승인 재전송을 금지한다. */
export function forwardCodexPermission(root: string, id: string, connectionId: string, send: (decision: "accept" | "decline" | "cancel") => void): boolean {
  return withLock(root, CONTROL_LOCK, () => {
    let decision: "accept" | "decline" | "cancel" | undefined;
    mutateInteractions(root, state => {
      const r = needInteraction(state, id);
      if (r.permission?.connectionId !== connectionId || r.application) throw new ControlError("conflict", "종료되었거나 이미 전달한 Codex 권한 요청입니다");
      const invalid = permissionUnavailable(root, r) || (!contextMatches(root, r.context) ? "명령의 작업 문맥이 바뀌었습니다" : undefined);
      // 응답 수신(interactionService validateContext)과 같은 임대 판정 — 다른 작업의 남은 임대·푼 임대로 전달을 취소하지 않는다
      const lease = leaseConflict(root, { host: r.context.host, session: r.context.sessionId });
      if (invalid || lease || Date.parse(r.expiresAt) <= Date.now() || ["cancelled", "expired", "superseded", "failed"].includes(r.status)) {
        decision = "cancel"; r.status = "cancelled"; r.unavailableReason = invalid ?? "권한 요청 취소·만료 또는 다른 세션의 소유";
      } else if (r.status === "responded" && r.response) {
        const channel = readBinding(root)?.humanChannel, owner = readOwner(root);
        if (r.response.channel !== "dashboard-human" || !channel || !owner || channel.id !== r.response.channelId || channel.generation !== owner.generation || channel.controller !== owner.controller ||
            r.response.generation !== owner.generation || Date.parse(channel.expiresAt) <= Date.now() ||
            r.contentHash !== interactionHash({ kind: "host-permission", context: r.context, permission: r.permission })) {
          decision = "cancel"; r.status = "cancelled"; r.unavailableReason = "사람 채널이 회수·만료되었거나 요청이 달라졌습니다";
        } else decision = r.response.submission.permissionDecision;
      }
      if (decision) {
        r.application = { state: "applying", at: new Date().toISOString(), result: { decision, executionConfirmed: false } };
        bumpInteraction(state, r);
      }
    });
    if (!decision) return false;
    send(decision);
    mutateInteractions(root, state => {
      const r = needInteraction(state, id);
      if (decision !== "cancel") r.status = "applied";
      r.application = { state: "applied", at: new Date().toISOString(), result: { decision, forwarded: true, executionConfirmed: false } };
      bumpInteraction(state, r);
    });
    emit(root, "interaction.changed", { data: { requestId: id, decision, forwarded: true } });
    return true;
  });
}
export function closeCodexPermissions(root: string, runId: string, reason: string, requestId?: string): void {
  if (!readInteractions(root)) return;
  mutateInteractions(root, state => {
    for (const r of Object.values(state.requests)) if (r.kind === "host-permission" && r.context.runId === runId && (!requestId || r.requestId === requestId) && ["pending", "deferred", "responded"].includes(r.status)) {
      r.status = "failed"; r.unavailableReason = reason;
      r.application = { state: "failed", at: new Date().toISOString(), error: reason }; bumpInteraction(state, r);
    }
  });
}
export function recordCodexCommandResult(root: string, runId: string, threadId: string, turnId: string, item: { id: string; status?: string; exitCode?: number | null }): void {
  if (!readInteractions(root)) return;
  mutateInteractions(root, state => {
    for (const r of Object.values(state.requests)) if (r.kind === "host-permission" && r.context.runId === runId && r.permission?.threadId === threadId && r.permission.turnId === turnId && r.permission.itemId === item.id && r.application?.state === "applied") {
      r.application.result = { ...(r.application.result as object), executionConfirmed: true, status: item.status ?? "unknown", exitCode: item.exitCode ?? null };
      bumpInteraction(state, r);
    }
  });
}
