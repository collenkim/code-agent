/**
 * 사람 판단의 기록 — 동의 `judgment` 의 `waive-finding`(지적 기각·범위 밖 확인)과 `cross-stop`(막힌 교차 지점의 사람 중지).
 *
 * 동의 쪽(consent.ts preview·applyLocked)이 kind·comment(500자)·id·name 공통 검증을 먼저 하고 이 네 함수를 부른다. 여기서는 자기
 * 도메인 전제(작업·단계·지점·지적)만 본다. preview 는 요약 문자열을, apply 는 소유 기록의 잠금 안에서 전제를 다시 확인한 뒤
 * 기록하고 결과 문구를 돌려준다. 표의 지적 줄은 지우지 않는다 — 게이트가 그 지적을 세지 않을 뿐이다.
 */
import { hashManifest, hashPlan } from "../core/approval";
import { runtimeHost } from "./crossEnv";
import { crossSectionText } from "./crossCheck";
import {
  crossAttemptsOf, effectiveReviewer, findingDetailHash, legacyPlanningAttempts, orphanView, planningCrossAttemptsOf, pointLabel, stopBody, syncLegacyPlanning, waiveVerdict,
  type CrossAttempt, type PlanningCrossAttempt, type PlanningCrossView, type Waiver,
} from "./crossRecord";
import { planPaths, treeHashNow } from "./evidence";
import { mutatePlanning } from "./planning";
import { criticCrossPoint, loadPlanning, taskCurrent, withPlanningCache, type PlanningState } from "./planningState";
import { crossPointState } from "./retryPolicy";
import { CROSS_ID, crossRequired, loadReview, mutateReview, parseFindings, waived, type ReviewLog } from "./review";
import { Stop } from "./stop";
import { loadWork, type Work } from "./work";

function requireWork(root: string): Work {
  const work = loadWork(root);
  if (!work) throw new Stop("진행 중인 작업이 없습니다.");
  return work;
}
const oneLine = (text: string | undefined, max: number): string => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const MEANING: Record<Waiver["verdict"], string> = {
  "범위 밖 확인": "이번 작업에서 다루지 않습니다",
  기각: "이번 작업에서 고치지 않습니다",
  "형식 문제 기각": "표기 문제가 있는 지적을 이번 작업에서 다루지 않습니다",
};

// ---- waive-finding ----

/** 마지막 회차가 지금 기준·계획·경계·트리 위의 것이어야 한다 */
function currentRound(work: Work, log: ReviewLog | undefined) {
  const last = log?.rounds.at(-1);
  if (!log || !last || last.baseCommit !== work.active.baseCommit || !work.plan || last.planHash !== hashPlan(work.plan)
      || last.manifestHash !== hashManifest(work.manifest) || last.treeHash !== treeHashNow(work)) {
    throw new Stop("리뷰 회차가 지금 트리·계획 위의 것이 아닙니다 — 새 회차의 결과를 보고 다시 판단하세요.");
  }
  return { log, last };
}

/** 리뷰 지적 기각의 대상 — 기록된 결과(독립 리뷰의 유효 결과·교차 리뷰의 첫 완료 결과)에서 그 id 의 게이트를 막는 줄 하나 */
function reviewTarget(work: Work, current: ReviewLog | undefined, findingId: string) {
  const { log, last } = currentRound(work, current);
  const planned = planPaths(work);
  let source: Waiver["source"], result: string | undefined, host: string | undefined;
  if (/^F\d+$/.test(findingId)) {
    source = "reviewer";
    result = effectiveReviewer(last, planned)?.result;
  } else if (CROSS_ID.test(findingId)) {
    source = "cross";
    const done = crossPointState(orphanView(crossAttemptsOf(last, planned))).completed as CrossAttempt | undefined;
    result = done?.result; host = done?.host;
  } else throw new Stop("리뷰 지적 id 는 F<번호>(독립 리뷰) 또는 X<번호>(교차 리뷰)입니다.");
  const label = source === "reviewer" ? "독립 리뷰" : "교차 리뷰";
  if (result === undefined) throw new Stop(`${label} 결과가 기록되지 않았습니다.`);
  const matches = parseFindings(result, planned, source === "reviewer" ? /^F\d+$/ : CROSS_ID).filter((finding) => finding.id === findingId);
  if (!matches.length) throw new Stop(`기록된 ${label} 결과에 ${findingId} 가 없습니다.`);
  if (matches.length > 1) throw new Stop(`${findingId} 가 여러 줄입니다 — 새 회차에서 리뷰어가 번호를 바로잡게 하세요.`);
  const finding = matches[0];
  const verdict = waiveVerdict(finding);
  if (!verdict) throw new Stop(`${findingId} 는 게이트를 막는 지적이 아닙니다(${finding.status}·${finding.scope}) — 기각할 것이 없습니다.`);
  if (waived(log, finding, last.round)) throw new Stop(`${findingId} 는 이미 사람 판단으로 기록했습니다.`);
  const summary = [
    `대상: ${findingId} · ${source === "reviewer" ? "독립 리뷰" : `교차 리뷰(${host})`} · ${last.round}회차 · ${finding.written} · ${finding.path}`,
    `지적: ${finding.detail}`,
    `판단: ${verdict} — ${MEANING[verdict]}`,
    "",
    "표의 지적 줄은 그대로 남고, 리뷰 게이트는 이 회차에서 이 지적을 세지 않습니다.",
    "다음 회차에는 같은 id·경로·범위에 지적 내용(공백 차이 제외)까지 같을 때만 이 판단이 이어집니다. 내용이 바뀌면 다시 판단합니다.",
    "기록은 review.json · 09-review.md 회차 구역 · 10-pr.md 검증 절 · 커밋 메시지에 남습니다.",
  ].join("\n");
  return { log, round: last.round, source, finding, verdict, summary };
}

/** 계획 교차 검토의 차단 지적 기각 대상 — 현재 critic 지점의 완료 결과에 묶인다 */
function planTarget(work: Work, state: PlanningState, findingId: string) {
  const critic = state.tasks.find((record) => record.task.role === "critic");
  const last = critic?.attempts.at(-1);
  if (!critic || !last || last.status !== "completed" || !taskCurrent(work, state, critic)) {
    throw new Stop("현재 critic 결과가 없습니다 — 교차 검토 지적은 지금 critic 결과에 묶입니다.");
  }
  const current = criticCrossPoint(work, state)!;
  if (current.point.state !== "completed") throw new Stop("이 critic 결과의 교차 검토가 완료로 기록되지 않았습니다.");
  const done = current.point.completed as PlanningCrossView;
  const matches = (done.outcome?.findings ?? []).filter((finding) => finding.id === findingId);
  if (!matches.length) throw new Stop(`기록된 교차 계획 검토 결과에 ${findingId} 가 없습니다.`);
  if (matches.length > 1) throw new Stop(`${findingId} 가 여러 개입니다 — 새 critic 결과의 교차 검토로 다시 판단하세요.`);
  const finding = matches[0];
  if (finding.severity !== "blocking") throw new Stop("차단 지적만 기각합니다 — advisory 는 게이트를 막지 않습니다.");
  if ((state.crossWaivers ?? []).some((waiver) => waiver.criticDispatchId === current.dispatchId && waiver.id === findingId)) {
    throw new Stop(`${findingId} 는 이미 사람 판단으로 기록했습니다.`);
  }
  const summary = [
    `대상: ${findingId} · 교차 계획 검토(${done.host}) · critic ${current.dispatchId.slice(0, 8)} · ${finding.source.path}:${finding.source.line}`,
    `지적: ${finding.detail}`,
    `판단: 기각 — ${MEANING.기각}`,
    "",
    "이 critic 결과에만 적용됩니다 — critic 이 다시 배정되면 새 교차 검토 결과로 다시 판단합니다.",
    "기록은 planning.json · 10-pr.md 검증 절 · 커밋 메시지에 남습니다.",
  ].join("\n");
  return { dispatchId: current.dispatchId, finding, summary };
}

const WAIVE_PHASE = "지적 기각은 review 단계(F·X 번호)나 plan 단계(교차 계획 검토 지적)에서만 기록합니다.";

export function previewWaiveFinding(root: string, findingId: string): string {
  const work = requireWork(root);
  if (work.active.phase === "review") return reviewTarget(work, loadReview(root, work.active.id, work.active.target), findingId).summary;
  if (work.active.phase === "plan") return withPlanningCache(() => planTarget(work, loadPlanning(work), findingId).summary);
  throw new Stop(WAIVE_PHASE);
}

export function waiveFinding(root: string, findingId: string, consentId: string, reason: string): string {
  const work = requireWork(root);
  const at = new Date().toISOString();
  if (work.active.phase === "review") {
    return mutateReview(root, work.active.id, work.active.target, (current) => {
      const target = reviewTarget(work, current, findingId);
      const { finding } = target;
      target.log.waivers = [...(target.log.waivers ?? []), { source: target.source, id: finding.id, path: finding.path, scope: finding.written,
        verdict: target.verdict, detailHash: findingDetailHash(finding.detail), detail: finding.detail.slice(0, 300), round: target.round, reason, consent: consentId, at }];
      return { log: target.log, value: `${findingId} 를 사람 판단으로 기록했습니다(${target.verdict}). 리뷰 게이트는 이 회차에서 이 지적을 세지 않습니다 — 남은 지적이 없으면 code-agent next 로 진행합니다.` };
    });
  }
  if (work.active.phase === "plan") {
    return withPlanningCache(() => mutatePlanning(work, (state) => {
      const target = planTarget(work, state, findingId);
      state.crossWaivers = [...(state.crossWaivers ?? []), { criticDispatchId: target.dispatchId, id: findingId, reason, consent: consentId, at }];
      return `${findingId} 를 사람 판단으로 기록했습니다(기각). 계획 게이트는 이 critic 결과에서 이 지적을 세지 않습니다 — 남은 문제가 없으면 plan submit 으로 진행합니다.`;
    }));
  }
  throw new Stop(WAIVE_PHASE);
}

// ---- cross-stop ----

const BLOCKED: readonly string[] = ["cross-config-error", "cross-result-invalid", "host-sandbox-denied", "cross-timeout"];
type StopPoint = "review" | "planning";

/** 사람 중지를 기록할 수 있는 지점인가 — 열린 지점에 막힌 시도가 있거나(계획은 질문을 답한 needs-input·질문 없는 실패 완료도) */
function stoppable(view: readonly (CrossAttempt | PlanningCrossView)[], planning: boolean, failedClean: boolean): boolean {
  const point = crossPointState(view);
  if (point.state === "completed") return planning && failedClean;
  if (point.state !== "open") return false;
  return view.some((attempt) => attempt.endedAt !== undefined && BLOCKED.includes(attempt.class ?? ""))
    || (planning && view.some((attempt) => attempt.class === "answered-input"));
}
function stopSummary(point: string, host: string, view: readonly (CrossAttempt | PlanningCrossView)[]): string {
  const runs = view.filter((attempt) => attempt.endedAt !== undefined);
  return [
    `지점: ${point} · ${host} · 시도 ${runs.length}회(${runs.map((attempt) => `${attempt.class ?? "기록 없음"}: ${oneLine(attempt.detail, 80)}`).join(" · ") || "없음"})`,
    "",
    "이 지점의 교차 검증을 사람이 중지로 기록합니다. 게이트는 이 지점의 교차 결과 없이 진행합니다.",
    "다음 지점(새 회차·새 critic 결과)에서는 교차 검증을 다시 실행합니다. 기록은 반영 보고서와 커밋 메시지에 남습니다.",
  ].join("\n");
}
const NOT_STOPPABLE = (label: string) => `교차 실행이 막힌 지점만 사람이 중지를 결정합니다(완료·중지된 지점이나 아직 실행하지 않은 지점은 대상이 아닙니다) — 상태: ${label}.`;

function requireStopPoint(work: Work, point: StopPoint): void {
  if (!crossRequired(work.repoRoot)) throw new Stop("두 호스트가 설치된 프로젝트에서만 교차 검증 중지를 기록합니다.");
  const phase = point === "review" ? "review" : "plan";
  if (work.active.phase !== phase) throw new Stop(`${point} 교차 지점은 ${phase} 단계에서 기록합니다.`);
}

function reviewStopTarget(work: Work, current: ReviewLog | undefined) {
  const { log, last } = currentRound(work, current);
  const stored = crossAttemptsOf(last, planPaths(work)).map((attempt) => ({ ...attempt }));
  const view = orphanView(stored);
  if (!stoppable(view, false, false)) throw new Stop(NOT_STOPPABLE(pointLabel(view)));
  const name = `리뷰 ${last.round}회차`;
  return { log, last, view, name, summary: stopSummary(name, view[0].host, view) };
}
function planningStopTarget(work: Work, state: PlanningState) {
  const current = criticCrossPoint(work, state);
  if (!current) throw new Stop("현재 critic 결과가 없습니다 — 교차 검토 지점은 지금 critic 결과에 묶입니다.");
  const done = current.point.completed as PlanningCrossView | undefined;
  const failedClean = done?.outcome?.status === "failed" && !done.outcome.findings.some((finding) => finding.severity === "blocking"
    && !(state.crossWaivers ?? []).some((waiver) => waiver.criticDispatchId === current.dispatchId && waiver.id === finding.id));
  if (!stoppable(current.view, true, failedClean)) throw new Stop(NOT_STOPPABLE(pointLabel(current.view, current.awaiting)));
  const name = `계획 검토 critic ${current.dispatchId.slice(0, 8)}`;
  return { ...current, name, summary: stopSummary(name, current.view[0].host, current.view) };
}

export function previewCrossStop(root: string, point: StopPoint): string {
  const work = requireWork(root);
  requireStopPoint(work, point);
  if (point === "review") return reviewStopTarget(work, loadReview(root, work.active.id, work.active.target)).summary;
  return withPlanningCache(() => planningStopTarget(work, loadPlanning(work)).summary);
}

export function recordCrossStop(root: string, point: StopPoint, consentId: string, reason: string): string {
  const work = requireWork(root);
  requireStopPoint(work, point);
  const at = new Date().toISOString();
  const human = (n: number, host: CrossAttempt["host"]): CrossAttempt => ({ n, host, ...(runtimeHost() ? { caller: runtimeHost()! } : {}), mode: "human",
    startedAt: at, endedAt: at, class: "cross-stop", detail: reason, consent: consentId });
  const done = (name: string) => `${name} 의 교차 검증을 사람 판단으로 중지했습니다. 게이트는 이 지점의 교차 결과 없이 진행합니다.`;
  if (point === "review") {
    let section: string | undefined, host = "";
    return mutateReview(root, work.active.id, work.active.target, (current) => {
      const target = reviewStopTarget(work, current);
      const attempt = human(target.view.length + 1, target.view[0].host);
      target.last.crossAttempts = [...target.view, attempt];
      section = stopBody(attempt); host = attempt.host;
      return { log: target.log, value: done(target.name) };
    }, { document: (text) => section === undefined ? text : crossSectionText(text, host, section) });
  }
  return withPlanningCache(() => mutatePlanning(work, (state) => {
    const target = planningStopTarget(work, state);
    const stored = orphanView(planningCrossAttemptsOf(state, target.dispatchId).map((attempt) => ({ ...attempt })));
    const attempt: PlanningCrossAttempt = { ...human(stored.length + 1, stored[0].host), criticDispatchId: target.dispatchId };
    state.crossAttempts = [...(state.crossAttempts ?? legacyPlanningAttempts(state.cross)).filter((item) => item.criticDispatchId !== target.dispatchId), ...stored, attempt];
    syncLegacyPlanning(state, target.dispatchId);
    return done(target.name);
  }));
}
