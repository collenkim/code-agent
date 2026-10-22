/** 독립 세션의 영속 질문과 호스트 원본을 사람이 대조해 관리 재개에 연결한다. 실행·승인을 합성하지 않는다. */
import { actorName } from "../actor";
import { hostMarked } from "../crossEnv";
import { leaseConflict, leaseConflictText, leaseConflictView } from "../lease";
import { confirmOnTerminal } from "../tty";
import { contextMatches, currentInteractions, interactionHash, mutateInteractions, bumpInteraction, needInteraction, readInteractions } from "../interactions";
import { stateView } from "../stateView";
import { ControlError } from "./protocol";
import { activeRuns } from "./runs";
import { selectedProfile, requireManagedHost } from "./hostProfile";
import { nativeSession } from "./nativeSession";
import { CONTROL_LOCK, readBinding, readOwner, listRuns, readRun, readWorkBinding, writeWorkBinding, writeRunRecord, withLock, emit, type RunRecord } from "./store";

function preview(root: string, requestId: string, transcript?: string) {
  const request = needInteraction(readInteractions(root), requestId), binding = readBinding(root), owner = readOwner(root);
  if (!binding || !owner || owner.handover) throw new ControlError("invalid-state", "현재 master 소유권을 먼저 확인하세요");
  if (!contextMatches(root, request.context) || request.unavailableReason) throw new ControlError("stale-state", "질문의 원래 프로젝트·브랜치·HEAD·작업·세션에서 복원하세요");
  if (!["pending", "deferred", "responded", "applied"].includes(request.status) || !request.response && Date.parse(request.expiresAt) <= Date.now()) throw new ControlError("invalid-state", "취소·만료·실패한 질문으로 세션을 복원하지 않습니다");
  if (request.context.runId) throw new ControlError("invalid-state", "이미 관리 실행에 연결된 질문입니다. 기존 실행을 조회·재개하세요");
  const profile = selectedProfile(root, binding);
  if (profile.kind !== request.context.host) throw new ControlError("invalid-state", "복원은 원래 호스트로만 가능합니다. execution에서 같은 호스트를 선택하세요");
  requireManagedHost(root, profile);
  const previous = listRuns(root).filter(r => r.sessionId === request.context.sessionId);
  const imported = previous.find(r => r.recovery);
  if (imported && (imported.generation !== owner.generation || imported.controller !== owner.controller)) throw new ControlError("fenced", "다른 소유 세대에서 복원한 세션입니다");
  if (request.recoveredRunId && imported?.runId === request.recoveredRunId) return { alreadyRecovered: true as const, runId: imported.runId };
  if (previous.some(r => !r.recovery)) throw new ControlError("invalid-state", "이미 관리 실행 기록이 있는 세션입니다. 기존 실행을 확인하세요");
  if (activeRuns(root).length) throw new ControlError("busy", "관리 실행이 끝난 뒤 복원하세요");
  const lease = leaseConflict(root, { host: profile.kind, session: request.context.sessionId });
  if (lease) throw new ControlError("busy", leaseConflictText(lease), { leaseConflict: leaseConflictView(lease) });
  const requests = currentInteractions(root).requests.filter(r => r.context.sessionId === request.context.sessionId && r.context.host === profile.kind && !r.context.runId && contextMatches(root, r.context) && ["pending", "deferred", "responded", "applied"].includes(r.status) && (r.response || Date.parse(r.expiresAt) > Date.now()));
  for (const r of requests.filter(r => r.origin.type === "consent")) {
    const c = (require("../consent") as typeof import("../consent")).loadConsent(root, r.origin.id);
    if (c.status !== "applied" && (c.status === "applying" || c.status === "approved" || c.binding || c.observed?.length || c.delegation)) throw new ControlError("busy", "원래 호스트에서 응답을 시작한 동의는 그 채널에서 먼저 마치세요");
  }
  const source = nativeSession(root, profile.kind, request.context.sessionId, transcript);
  if (imported && (!contextMatches(root, imported.recovery!.context) || imported.recovery!.source.hash !== source.hash || interactionHash(imported.hostProfile) !== interactionHash(profile))) {
    throw new ControlError("stale-state", "중단된 복원의 원본·작업·호스트 설정이 바뀌었습니다. 기존 복원 실행을 먼저 확인하세요");
  }
  const work = request.context.workId ? readWorkBinding(root, request.context.workId) : undefined;
  if (work && work.controller !== owner.controller) throw new ControlError("conflict", "기존 작업 연결의 제어자가 다릅니다");
  const runId = imported?.runId ?? `run-recover-${interactionHash({ project: binding.projectId, generation: owner.generation, session: request.context.sessionId }).slice(7, 31)}`;
  return { alreadyRecovered: false as const, runId, source, profile, context: request.context, generation: owner.generation, controller: owner.controller,
    requests: requests.map(r => ({ id: r.requestId, revision: r.revision, title: r.title })), work, timeoutMs: binding.policy.runTimeoutMs };
}

export function recoverSession(root: string, requestId: string, options: { transcript?: string; json?: boolean } = {}): string {
  if (!options.json && hostMarked()) throw new ControlError("human-required", "종료 세션 복원은 호스트 밖 터미널에서 사람이 확인합니다");
  const before = preview(root, requestId, options.transcript);
  if (options.json || before.alreadyRecovered) return JSON.stringify(before);
  confirmOnTerminal(`원래 호스트: ${before.profile.kind} · 세션: ${before.context.sessionId}\n작업: ${before.context.workId ?? "설정/접수 전"} · 브랜치: ${before.context.branch}\n원본: ${before.source.file}\n질문: ${before.requests.map(r => r.title).join(" / ")}\n이 세션의 모든 대화형·비대화형 실행을 종료했음을 확인합니다. 기존 작업을 현재 제어자 ${before.controller}의 관리 재개에 연결합니다. 받은 답·승인·작업 종류는 바꾸지 않습니다. 복원 자체는 모델 실행이나 작업 완료가 아닙니다.`, "recover");
  return withLock(root, CONTROL_LOCK, () => {
    const fresh = preview(root, requestId, options.transcript);
    if (interactionHash(fresh) !== interactionHash(before)) throw new ControlError("stale-state", "복원 확인 중 세션 원본·질문·작업·소유권이 바뀌었습니다. 다시 조회하세요");
    const at = new Date().toISOString(), existing = readRun(root, before.runId);
    const run: RunRecord = existing ?? { version: 1, runId: before.runId, commandId: `recovery:${before.runId}`, controller: before.controller, generation: before.generation,
      mode: "continue", links: before.work?.links ?? {}, state: "blocked", acceptedAt: at, updatedAt: at, finishedAt: at,
      sessionId: before.context.sessionId, sessionConfirmed: true, hostProfile: before.profile, promptHash: interactionHash("native-session-recovery"), timeoutMs: before.timeoutMs,
      workId: before.context.workId, baseHead: before.context.head, baseStateVersion: stateView(root).stateVersion,
      recovery: { at, actor: actorName(), source: before.source, context: before.context, requestIds: before.requests.map(r => r.id) },
      outcome: { state: "blocked", reason: "사람이 종료한 독립 세션을 연결했습니다. 이전 실행 결과는 미검증이며 모델을 실행하지 않았습니다" },
      history: [{ at, state: "blocked", note: "TTY 종료 확인·호스트 원본 대조 후 복원" }] };
    writeRunRecord(root, run);
    if (run.workId && !before.work) writeWorkBinding(root, { workId: run.workId, links: {}, boundAt: at, runId: run.runId, controller: run.controller, runs: [run.runId] });
    const cursor = mutateInteractions(root, ledger => {
      for (const item of before.requests) {
        const r = needInteraction(ledger, item.id);
        if (r.revision !== item.revision) throw new ControlError("stale-state", "질문 상태가 바뀌었습니다. 복원 명령으로 연결 상태를 다시 확인하세요");
        if (r.recoveredRunId !== run.runId) { r.recoveredRunId = run.runId; bumpInteraction(ledger, r); }
      }
      return ledger.seq;
    });
    emit(root, "interaction.changed", { runId: run.runId, data: { cursor, recovered: true, requests: before.requests.map(r => r.id) } });
    return JSON.stringify({ recovered: true, runId: run.runId, sessionId: run.sessionId, started: false, note: "기존 응답은 대시보드 조회 또는 interaction drain으로 처리하고, 미응답은 실제 제출을 기다립니다" });
  });
}
