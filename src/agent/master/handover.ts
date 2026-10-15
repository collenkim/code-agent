/**
 * 제어권 인계 — requested → stopping → stopped → transferred → (새 제어자가) accepted. 각 단계는 owner.json 에 남아 어느 단계에서 끊겨도
 * 같은 단계부터 다시 이어진다(advance 는 몇 번 불러도 같은 결과).
 *
 * - 요청: 지금 제어자만. 대상은 사람이 enable 로 등록한 제어자. 실행 중인 실행에 협력 정지(pause)를 건다.
 * - 정지 확인: 인계 대상 실행이 모두 끝난 상태(감독의 끝맺음 또는 재조정의 프로세스 확인)여야 한다. heartbeat 가 끊긴 것만으로는 넘기지 않는다.
 * - 이전: 세대를 올리고 제어자를 바꾼다. 그 실행들의 세션이 쥔 작업 임대를 푼다. 이때부터 이전 제어자의 요청은 fenced 다.
 * - 인수: 새 제어자가 새 세대로 accept 해야 상태를 바꾸는 명령을 받는다.
 * - 취소: 이전 전(requested·stopping·stopped)에만 지금 제어자가 abort 한다. 멈춘 실행은 paused 로 남는다.
 * - 사람의 강제 인계(TTY `code-agent master handover --to <ID> --force-stop`)는 확인된 프로세스를 끝낸 뒤에만 넘긴다.
 */
import { randomUUID } from "crypto";

import { releaseLease, readLease } from "../lease";
import { ControlError, TERMINAL_RUN_STATES, type Policy } from "./protocol";
import { activeRuns, reconcileRuns, requestStop } from "./runs";
import { emit, readOwner, readRun, writeOwner, type Binding, type Owner } from "./store";

export function requestHandover(root: string, binding: Binding, owner: Owner, to: unknown, commandId: string): Owner {
  if (typeof to !== "string" || !binding.controllers[to]) throw new ControlError("invalid-request", "인계 대상(to)은 사람이 등록한 제어자여야 합니다");
  if (to === owner.controller) throw new ControlError("invalid-request", "지금 제어자에게는 인계하지 않습니다");
  if (owner.handover) throw new ControlError("handover-in-progress", `인계 ${owner.handover.id} 가 진행 중입니다(${owner.handover.state})`);
  const runs = activeRuns(root).map((run) => run.runId);
  const handover = { id: `ho-${randomUUID().slice(0, 12)}`, from: owner.controller, to, mode: "cooperative" as const, by: "controller" as const,
    state: runs.length ? "stopping" as const : "stopped" as const, requestedAt: new Date().toISOString(), commandId, runs,
    ...(runs.length ? {} : { stoppedAt: new Date().toISOString() }) };
  const next: Owner = { ...owner, handover };
  writeOwner(root, next);
  emit(root, "handover.requested", { commandId, data: { handoverId: handover.id, from: owner.controller, to, runs } });
  for (const runId of runs) requestStop(root, runId, { mode: "pause", reason: `제어권 인계(${handover.id})`, by: `controller:${owner.controller}`, commandId, graceMs: binding.policy.stopGraceMs });
  if (runs.length) emit(root, "handover.stopping", { commandId, data: { handoverId: handover.id, runs } });
  else emit(root, "handover.stopped", { commandId, data: { handoverId: handover.id } });
  return next;
}

/** 한 단계씩 앞으로 — 정지가 확인되면 이전까지 간다. 바뀌지 않으면 그대로 돌려준다 */
export function advanceHandover(root: string, policy: Policy): Owner | undefined {
  let owner = readOwner(root);
  const handover = owner?.handover;
  if (!owner || !handover || handover.state === "transferred") return owner;
  if (handover.state === "requested" || handover.state === "stopping") {
    reconcileRuns(root, policy, true);
    const pending = handover.runs.filter((runId) => { const run = readRun(root, runId); return run && !TERMINAL_RUN_STATES.includes(run.state); });
    if (pending.length) return owner;
    owner = { ...owner, handover: { ...handover, state: "stopped", stoppedAt: new Date().toISOString() } };
    writeOwner(root, owner);
    emit(root, "handover.stopped", { data: { handoverId: handover.id, runs: handover.runs } });
  }
  return transfer(root, owner);
}

function transfer(root: string, owner: Owner): Owner {
  const handover = owner.handover!;
  if (activeRuns(root).length) return owner; // 인계 중 새 실행은 받지 않지만, 남은 것이 있으면 넘기지 않는다
  const sessions = new Set(handover.runs.map((runId) => readRun(root, runId)?.sessionId).filter(Boolean));
  const lease = readLease(root);
  const releasedLease = !!lease && !lease.released && sessions.has(lease.session);
  if (releasedLease) releaseLease(root);
  const generation = owner.generation + 1;
  const at = new Date().toISOString();
  const next: Owner = {
    controller: handover.to, generation, since: at, history: [...owner.history, { at, controller: handover.to, generation, how: `인계 ${handover.id}(${handover.mode}, ${handover.by})` }],
    handover: { ...handover, state: "transferred", transferredAt: at, generation },
  };
  writeOwner(root, next);
  emit(root, "handover.transferred", { data: { handoverId: handover.id, from: handover.from, to: handover.to, generation, releasedLease } });
  return next;
}

export function acceptHandover(root: string, owner: Owner, controller: string, generation: number | undefined, handoverId: unknown): Owner {
  const handover = owner.handover;
  if (!handover || handover.state !== "transferred") throw new ControlError("invalid-state", "인수할 인계가 없습니다");
  if (handover.id !== handoverId) throw new ControlError("conflict", `인계 ID 가 다릅니다(지금 ${handover.id})`);
  if (controller !== owner.controller || generation !== owner.generation) throw new ControlError("fenced", `인수는 새 제어자 ${owner.controller} 가 세대 ${owner.generation} 로 합니다`);
  const at = new Date().toISOString();
  const next: Owner = { ...owner, handover: undefined, acceptedAt: at, lastSeenAt: at };
  writeOwner(root, next);
  emit(root, "handover.accepted", { data: { handoverId: handover.id, controller, generation } });
  return next;
}

export function abortHandover(root: string, owner: Owner, handoverId: unknown): Owner {
  const handover = owner.handover;
  if (!handover) throw new ControlError("invalid-state", "진행 중인 인계가 없습니다");
  if (handover.id !== handoverId) throw new ControlError("conflict", `인계 ID 가 다릅니다(지금 ${handover.id})`);
  if (handover.state === "transferred") throw new ControlError("invalid-state", "이미 넘긴 인계는 취소하지 않습니다 — 새 제어자가 다시 인계해야 합니다");
  const next: Owner = { ...owner, handover: undefined };
  writeOwner(root, next);
  emit(root, "handover.aborted", { data: { handoverId: handover.id } });
  return next;
}

/** 사람의 강제 인계 — 실행이 남아 있으면 forceStop 일 때만 확인된 프로세스를 끝내고, 모두 끝난 것을 확인한 뒤 넘긴다 */
export function forceHandover(root: string, binding: Binding, to: string, forceStop: boolean, actor: string): Owner {
  if (!binding.controllers[to]) throw new ControlError("invalid-request", `등록되지 않은 제어자: ${to}`);
  let owner = readOwner(root);
  if (!owner) throw new ControlError("not-enabled", "연동 소유 기록이 없습니다");
  reconcileRuns(root, binding.policy, true);
  const runs = activeRuns(root);
  if (runs.length && !forceStop) {
    throw new ControlError("busy", `실행 중인 실행이 있습니다: ${runs.map((run) => `${run.runId}(${run.state})`).join(", ")} — 멈춘 뒤 넘기거나 --force-stop 으로 확인된 프로세스를 끝낸 뒤 넘기세요`);
  }
  for (const run of runs) requestStop(root, run.runId, { mode: "cancel", reason: `사람의 강제 인계(${actor})`, by: `human:${actor}`, graceMs: 0, force: true, waitMs: 30_000 });
  reconcileRuns(root, binding.policy, true);
  const left = activeRuns(root);
  if (left.length) throw new ControlError("busy", `끝났는지 확인하지 못한 실행이 있습니다: ${left.map((run) => `${run.runId}(${run.state})`).join(", ")} — 넘기지 않았습니다`);
  const handover = { id: `ho-${randomUUID().slice(0, 12)}`, from: owner.controller, to, mode: "forced" as const, by: "human" as const, state: "stopped" as const,
    requestedAt: new Date().toISOString(), stoppedAt: new Date().toISOString(), runs: runs.map((run) => run.runId), note: `사람 ${actor}` };
  owner = { ...owner, handover };
  writeOwner(root, owner);
  emit(root, "handover.requested", { data: { handoverId: handover.id, from: handover.from, to, forced: true, by: actor } });
  return transfer(root, owner);
}
