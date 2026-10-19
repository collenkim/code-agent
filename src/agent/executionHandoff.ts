/** 사람이 확인하는 호스트 인계. 답·승인을 다른 세션의 것으로 바꾸지 않는다. */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { readLease, releaseLease } from "./lease";
import { loadWork } from "./work";
import { interactionContext, currentInteractions, mutateInteractions, bumpInteraction, interactionHash } from "./interactions";
import { activeRuns } from "./master/runs";
import { readOwner } from "./master/store";
import { CONSENT_DIR, OPEN_STATUSES } from "./consentState";
import { Stop } from "./stop";

export function handoffView(root: string) {
  const context = interactionContext(root, "handoff-preview", "claude");
  const work = loadWork(root);
  const lease = readLease(root);
  const questions = currentInteractions(root).requests.filter(r => r.context.branch === context.branch &&
    (r.context.workId === context.workId || r.context.workId === null) &&
    (["pending", "deferred", "responded"].includes(r.status) || r.response && r.application?.state !== "applied"));
  const consentDir = join(root, CONSENT_DIR);
  const consents: { id: string; action: string; status: string; session?: string }[] = [];
  if (existsSync(consentDir)) for (const name of readdirSync(consentDir).filter(n => /^[a-f0-9-]{36}\.json$/i.test(n))) {
    const c = JSON.parse(readFileSync(join(consentDir, name), "utf8"));
    if (OPEN_STATUSES.includes(c.status)) consents.push({ id: c.id, action: c.action.action, status: c.status, session: c.preparedSession?.id });
  }
  const runs = activeRuns(root).map(r => ({ runId: r.runId, state: r.state }));
  const blockers = [
    ...runs.map(r => `관리 실행 ${r.runId}(${r.state})을 먼저 중지·재조정하세요`),
    ...(readOwner(root)?.handover ? ["master 소유권 인계가 진행 중입니다"] : []),
    ...consents.map(c => `동의 ${c.id}(${c.action}/${c.status})를 원래 채널에서 마치거나 취소하세요`),
    ...questions.filter(r => r.response && r.application?.state !== "applied").map(r => `응답 ${r.requestId}를 원래 세션에서 소비·적용하세요`),
  ];
  return { branch: context.branch, head: context.head, workId: context.workId, kind: work?.order.kind ?? null,
    phase: work?.active.phase ?? null, lease: lease && !lease.released ? lease : null, runs, consents,
    questions: questions.map(r => ({ requestId: r.requestId, title: r.title, status: r.status, revision: r.revision, session: r.context.sessionId, origin: r.origin.type })), blockers };
}
export function handoffSummary(view: ReturnType<typeof handoffView>): string {
  return [`브랜치: ${view.branch ?? "없음"} · 작업: ${view.workId ?? "없음"} · 종류: ${view.kind ?? "접수/준비"} · 단계: ${view.phase ?? "준비"}`,
    `진행 임대: ${view.lease ? `${view.lease.host} / ${view.lease.session}` : "없음"}`,
    ...view.questions.map(q => `질문 ${q.requestId} (${q.status}): ${q.title}`), ...view.blockers,
    "인계 시 미응답 일반 질문은 취소 이력을 남기고 새 호스트에서 다시 발행합니다. 받은 답·승인은 이전하지 않습니다."].join("\n");
}
export function requireHandoffUnchanged(root: string, before: ReturnType<typeof handoffView>): ReturnType<typeof handoffView> {
  const fresh = handoffView(root);
  if (interactionHash(before) !== interactionHash(fresh)) throw new Stop("인계 확인 중 작업·질문·동의·임대 상태가 바뀌었습니다. 다시 조회하세요");
  if (fresh.blockers.length) throw new Stop(fresh.blockers.join("\n"));
  return fresh;
}
export function applyHandoff(root: string, view: ReturnType<typeof handoffView>): void {
  const ids = new Set(view.questions.filter(q => q.origin !== "consent" && ["pending", "deferred"].includes(q.status)).map(q => q.requestId));
  if (ids.size) mutateInteractions(root, state => {
    for (const r of Object.values(state.requests)) if (ids.has(r.requestId)) {
      if (r.response || !["pending", "deferred"].includes(r.status)) throw new Stop("질문 응답이 도착했습니다. 인계를 다시 확인하세요");
      r.status = "cancelled"; r.continuation = { state: "blocked", detail: "사람이 호스트 인계를 확인했습니다. 새 세션에서 미응답 질문을 재발행하세요" }; bumpInteraction(state, r);
    }
  });
  if (view.lease) releaseLease(root);
}
