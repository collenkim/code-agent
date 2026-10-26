/** Codex가 실제 요청한 단건 실행 권한. 업무 동의·일반 답·위임으로 대신하지 않는다. */
import { randomUUID } from "crypto";
import { readdirSync, realpathSync } from "fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "path";
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
/** 단순 실행 래퍼로 받는 셸 — 명령 인자 앞에 올 수 있는 깃발과 명령 인자 깃발 */
const WRAPPERS: { names: string[]; flags: RegExp; run: RegExp }[] = [
  { names: ["powershell.exe", "pwsh.exe", "powershell", "pwsh", "bash", "sh", "zsh"], flags: /^(?:-noprofile|-noninteractive|-nologo)$/i, run: /^(?:-command|-c|-lc)$/i },
  { names: ["cmd.exe", "cmd"], flags: /^\/[dsq]$/i, run: /^\/c$/i },
];
/**
 * 래퍼 셸은 맨 이름(Codex 가 시스템 검색 경로로 찾는다)이거나 알려진 셸 설치 경로여야 한다 — 저장소나 사용자가 쓸 수 있는
 * 시스템 하위 폴더(Windows\Tasks 등)에 둔 같은 이름 파일을 승인하지 않는다. Codex 는 큰따옴표 안 역슬래시를 겹쳐 보내므로 resolve 로 접는다
 */
function systemShell(file: string): boolean {
  if (!/[\\/]/.test(file)) return true;
  if (!isAbsolute(file) || /^[\\/]{2}/.test(file)) return false;
  const target = resolve(file);
  if (process.platform !== "win32") return ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].includes(dirname(target));
  const key = (p: string) => resolve(p).toLowerCase();
  const system = process.env.SystemRoot, programs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432].filter((p): p is string => !!p);
  const exact = [
    ...(system ? ["System32", "SysWOW64"].flatMap(d => [join(system, d, "cmd.exe"), join(system, d, "WindowsPowerShell", "v1.0", "powershell.exe")]) : []),
    ...programs.flatMap(p => [join(p, "Git", "bin"), join(p, "Git", "usr", "bin")].flatMap(d => [join(d, "bash.exe"), join(d, "sh.exe")])),
  ].map(key);
  // PowerShell 7 은 Program Files\PowerShell\<버전>\pwsh.exe
  return exact.includes(key(target)) || (basename(target).toLowerCase() === "pwsh.exe" && programs.some(p => key(dirname(dirname(target))) === key(join(p, "PowerShell"))));
}
/** 복합 셸·인라인 코드·직접 git 변경은 받지 않는다. 기존 hook/CLI 게이트를 거치는 명령만 지원한다. */
export function gitOperationCommand(command: string): boolean {
  // 공백·탭 밖의 공백 문자(U+3000·NBSP·VT 등)와 제어 문자 — 이 검사는 토큰으로 나누지만 cmd 는 명령 이름의 일부로 읽는다
  if (/[^\S \t]|[\x00-\x08\x0e-\x1f\x7f]/.test(command)) return false;
  let words = splitCommandArgs(command);
  if (!words?.length) return false;
  const shell = basename(words[0].replace(/\\/g, "/")).toLowerCase();
  const wrapper = WRAPPERS.find(w => w.names.includes(shell));
  if (wrapper) {
    if (!systemShell(words[0])) return false;
    const at = words.findIndex(w => wrapper.run.test(w));
    if (at < 1 || at !== words.length - 2 || words.slice(1, at).some(w => !wrapper.flags.test(w))) return false;
    command = words[at + 1];
    words = splitCommandArgs(command);
  }
  // 셸 확장·경로 바꿔치기·환경 변수 대입·cmd 이스케이프는 승인 대상이 아니다.
  if (/[;&|<>`$\r\n(){}\[\]*?!%^]/.test(command) || !words || !/^(?:code-agent|code-agent\.cmd)$/.test(words[0])) return false;
  return ["start", "verify", "repro"].includes(words[1]) && words.length > 2;
}
/**
 * 저장소 루트의 명령·셸 가림은 모든 플랫폼에서 거부한다. Windows는 PATHEXT도 대조한다.
 * 감독의 PATH 정리와 함께 승인 명령이 저장소의 같은 이름 파일로 바뀌지 않게 한다.
 */
export function shadowingExecutable(root: string): string | undefined {
  const exts = new Set([".com", ".exe", ".bat", ".cmd", ...(process.env.PATHEXT ?? "").split(";").map(e => e.trim().toLowerCase()).filter(Boolean)]);
  let names: string[];
  try { names = readdirSync(root); } catch { return undefined; }
  const commands = ["code-agent", "node", "git", "bash", "sh", "zsh", "cmd", "powershell", "pwsh"];
  return names.find(name => commands.includes(name) || (process.platform === "win32" && commands.includes(basename(name, extname(name)).toLowerCase()) && exts.has(extname(name).toLowerCase())));
}
export function permissionUnavailable(root: string, record: InteractionRecord): string | undefined {
  const p = record.permission, run = record.context.runId ? readRun(root, record.context.runId) : undefined;
  const owner = readOwner(root);
  if (!p || !run || run.state !== "running" || run.stop || !run.sessionConfirmed || run.sessionId !== p.threadId || run.hostProfile?.kind !== "codex") return "원래 Codex 실행의 권한 요청이 더 이상 유효하지 않습니다.";
  if (!owner || owner.handover || owner.generation !== p.generation || owner.controller !== p.controller || run.generation !== p.generation) return "권한 요청의 소유 세대가 바뀌었습니다.";
  if (run.hostProfile.sandbox !== "workspace-write") return "읽기 전용 실행은 Git 쓰기 권한을 요청할 수 없습니다.";
  const shadow = shadowingExecutable(root);
  if (shadow) return `저장소 루트의 ${shadow} 가 승인할 명령이 찾는 실행 파일을 가릴 수 있습니다 — 그 파일을 지운 뒤 다시 요청하세요.`;
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
      typeof params.cwd !== "string" || realpathSync(params.cwd) !== realpathSync(root)) {
    throw new ControlError("policy-forbids", "지원 범위 밖 Codex 권한 요청입니다 — 저장소 루트의 code-agent start·verify·repro 한 줄(Windows PowerShell 은 code-agent.cmd …)만 받습니다");
  }
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
  let entered = false;
  try { return withLock(root, CONTROL_LOCK, () => {
    entered = true;
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
  }, 0); } catch (error) {
    // 정지·인계가 제어 잠금을 쥐고 있어도 호스트를 실패 처리하지 않는다. RPC는 다음 poll까지 남긴다.
    if (!entered && error instanceof ControlError && error.code === "busy") return false;
    throw error;
  }
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
