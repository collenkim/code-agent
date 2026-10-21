/**
 * 진행 관찰 — code-agent 상태(stateView, 읽기 전용)를 지난 관찰과 견줘 바뀐 것만 이벤트로 남긴다. 감독 프로세스가 주기마다,
 * 제어 명령(판단 적용·답 기록)이 끝날 때 부른다. 둘이 겹치지 않게 관찰 잠금 안에서 읽고·견주고·쓴다.
 *
 * master 실행이 작업(또는 접수)을 열면 그 작업을 실행의 master 식별자(임무·작업·시도·계획 버전)와 묶는다(works/<ID>.json).
 * 묶이지 않은 작업은 연동 대상이 아니다 — 판단·답·이어 실행을 받지 않는다.
 */
import { loadRequestSession } from "../request";
import { stateView, type StateJson } from "../stateView";
import { emit, masterPath, readJson, readWorkBinding, withLock, writeJson, writeWorkBinding, type RunRecord } from "./store";

interface Observed {
  at: string; stateVersion: string; workId: string | null; requestId: string | null; phase: string | null; attempt: string | null;
  resume: string; action: string; unanswered: string[]; unverified: string[]; consents: Record<string, string>;
  verification: string | null;
  graph?: string;
  interactions?: number;
}

function summarize(view: StateJson, requestId: string | null): Observed {
  return {
    at: view.observedAt, stateVersion: view.stateVersion, workId: view.work?.id ?? null, requestId, phase: view.work?.phase ?? null,
    attempt: view.attempt?.id ?? null, resume: view.resume.code, action: view.resume.next.action,
    graph: view.graph ? JSON.stringify(view.graph) : undefined,
    interactions: view.interactions?.cursor,
    unanswered: view.questions?.unanswered ?? [], unverified: view.questions?.unverified ?? [],
    consents: Object.fromEntries(view.consents.open.map((entry) => [entry.id, `${entry.action}:${entry.status}`])),
    verification: view.verification ? JSON.stringify(view.verification.phases) : null,
  };
}

/** 지금 상태를 보고 지난 관찰과 다른 것을 이벤트로 남긴다. run 이 있으면 그 실행이 연 작업을 묶는다 */
export function observeProgress(root: string, run?: RunRecord): { view: StateJson; changed: boolean } {
  return withLock(root, "observe.lock", () => {
    const view = stateView(root, run ? { session: run.sessionId, runId: run.runId } : {});
    let requestId: string | null = null;
    try { requestId = view.work ? null : loadRequestSession(root)?.id ?? null; } catch { requestId = null; }
    const now = summarize(view, requestId);
    const file = masterPath(root, "observed.json");
    const before = readJson<Observed>(file);
    const runId = run?.runId;
    const base = { ...(runId ? { runId } : {}), stateVersion: now.stateVersion };
    if (run) bindWork(root, run, now.workId ?? now.requestId);
    let changed = false;
    if (now.interactions !== undefined && now.interactions !== before?.interactions) {
      emit(root, "interaction.changed", { ...base, data: { cursor: now.interactions } }); changed = true;
    }
    if (now.graph && now.graph !== before?.graph) {
      emit(root, "graph.changed", { ...base, data: view.graph });
      changed = true;
    }
    if (before) {
      if (before.workId !== now.workId || before.phase !== now.phase) {
        emit(root, "phase.changed", { ...base, data: { workId: now.workId, from: before.phase, to: now.phase, previousWork: before.workId } }); changed = true;
      }
      if (before.attempt !== now.attempt) { emit(root, "attempt.changed", { ...base, data: { workId: now.workId, from: before.attempt, to: now.attempt } }); changed = true; }
      if (before.resume !== now.resume || before.action !== now.action) {
        emit(root, "resume.changed", { ...base, data: { code: now.resume, action: now.action, by: view.resume.next.by, reasons: view.resume.reasons.slice(0, 5) } }); changed = true;
      }
      for (const id of now.unanswered.filter((q) => !before.unanswered.includes(q))) { emit(root, "question.opened", { ...base, data: { workId: now.workId ?? now.requestId, q: id } }); changed = true; }
      for (const id of before.unanswered.filter((q) => !now.unanswered.includes(q))) { emit(root, "question.answered", { ...base, data: { workId: now.workId ?? now.requestId, q: id } }); changed = true; }
      for (const [id, value] of Object.entries(now.consents)) {
        const [action, status] = value.split(":");
        if (!(id in before.consents)) { emit(root, "consent.opened", { ...base, data: { id, action, status } }); changed = true; }
        else if (before.consents[id] !== value) { emit(root, "consent.updated", { ...base, data: { id, action, status } }); changed = true; }
      }
      for (const id of Object.keys(before.consents).filter((id) => !(id in now.consents))) {
        emit(root, "consent.closed", { ...base, data: { id, action: before.consents[id].split(":")[0] } }); changed = true;
      }
      if (before.verification !== now.verification && now.verification) {
        emit(root, "verification.recorded", { ...base, data: { workId: now.workId, phases: view.verification?.phases, bound: view.verification?.bound } }); changed = true;
      }
    } else {
      // 첫 관찰 — 지금 열린 질문·동의를 알린다(받는 쪽이 스냅샷 없이도 기다릴 판단을 안다)
      for (const id of now.unanswered) emit(root, "question.opened", { ...base, data: { workId: now.workId ?? now.requestId, q: id } });
      for (const [id, value] of Object.entries(now.consents)) emit(root, "consent.opened", { ...base, data: { id, action: value.split(":")[0], status: value.split(":")[1] } });
      emit(root, "resume.changed", { ...base, data: { code: now.resume, action: now.action, by: view.resume.next.by, reasons: view.resume.reasons.slice(0, 5) } });
      changed = true;
    }
    if (!before || before.stateVersion !== now.stateVersion || changed) writeJson(file, now);
    return { view, changed };
  });
}

/** master 실행이 연 작업·접수를 그 실행의 식별자와 묶는다 — 이미 묶였으면 실행만 더한다(다른 임무로 다시 묶지 않는다) */
function bindWork(root: string, run: RunRecord, workId: string | null): void {
  if (!workId) return;
  const existing = readWorkBinding(root, workId);
  if (existing) {
    if (!existing.runs.includes(run.runId)) writeWorkBinding(root, { ...existing, runs: [...existing.runs, run.runId] });
    return;
  }
  // 실행이 고른 실행 방식을 작업에 고정한다 — 이후 실행·사람 세션의 교차 검증·단독 호스트 판정이 이 작업에서는 그 선택을 따른다
  writeWorkBinding(root, { workId, links: run.links, boundAt: new Date().toISOString(), runId: run.runId, controller: run.controller, runs: [run.runId],
    ...(run.execution ? { execution: run.execution } : {}) });
  emit(root, "work.bound", { runId: run.runId, data: { workId, links: run.links } });
}
