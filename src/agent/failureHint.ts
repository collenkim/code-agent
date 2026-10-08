/**
 * 원천이 `다음:` 에 닿지 않는 실패의 안내 한 줄(재시도 규약 §7.4).
 *
 * 원인별 안내의 원천은 그 원인을 판정한 모듈 하나다 — 검증(check·test)은 commands.ts nextHint 의 증거 기반 갈래(한도는
 * verifyLimitHint), 리뷰·교차는 reviewProblems·crossCriticProblems(crossPointHint), 계획 배정은 `planning advance`(고아 정리·남은 횟수·
 * 사람 허용을 그 자리에서 반영한다). 이 모듈은 그 원천이 `다음:` 에 닿지 않는 두 자리만 맡는다:
 * - 관찰 흐름의 analysis~plan — 지금 단계 작업의 배정 실패·고아를 원인 이름표와 배정 ID 로 알리고 `planning advance` 로 이끈다.
 *   기록된 실패를 다른 값으로 다시 렌더하지 않는다(남은 횟수는 사람 허용 뒤 틀리므로 쓰지 않는다 — advance 가 실시간으로 알려 준다).
 * - deliver — 이 작업이 deliver 에 들어온 뒤의 마지막 deliver 동의가 failed 면 그 failure.detail 로 동의 원인 안내(guidance)를 낸다.
 * 읽기 실패·형식 오류는 안내를 내지 않는다(안내 하나로 status 를 세우지 않는다). 검증·교차 기록은 읽지 않는다.
 *
 * 순환 import 를 피하려고 consent.ts·planning.ts·commands.ts 를 import 하지 않는다.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { readStages, STATE_DIR } from "./layout";
import { loadPlanning, PLANNING_PHASES, ROLE_PHASE, runView } from "./planningState";
import { GUIDE_VARIANTS, guidance, isFailureClass, POLICIES, type FailureClass } from "./retryPolicy";
import type { Work } from "./work";

/** 동의 기록 파일 이름(consent.ts 의 UUID 와 같다) — 같은 폴더의 index.json·snapshot-cache.json·tickets/·apply.lock 은 건너뛴다 */
const CONSENT_FILE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/;
/** 읽는 동의 기록 수(최근 수정 순) */
const CONSENT_SCAN = 30;
/** deliver 동의 실패 안내의 원인 — GUIDE_KEYS 계약상 둘 다 값 키는 detail 하나다 */
const CONSENT_CLASSES: readonly FailureClass[] = ["consent-target-changed", "consent-apply-failed"];

interface Candidate { cls: FailureClass; at: number; id: string; minutes?: number; detail?: string }

/** 원천이 `다음:` 에 닿지 않는 실패 한 줄 — 없으면 undefined */
export function failureHint(work: Work, now: number = Date.now()): string | undefined {
  try {
    return planningHint(work, now) ?? deliverHint(work);
  } catch {
    return undefined;
  }
}

function planningHint(work: Work, now: number): string | undefined {
  const { active } = work;
  if (!active.planningVersion || !(PLANNING_PHASES as readonly string[]).includes(active.phase)) return undefined;
  const state = loadPlanning(work);
  const candidates: Candidate[] = [];
  for (const record of state.tasks) {
    if (ROLE_PHASE[record.task.role] !== active.phase) continue;
    const attempt = record.attempts.at(-1);
    if (!attempt) continue;
    if (attempt.status === "running") {
      // advance 와 같은 판정(orphanState — runView 가 부른다)
      const view = runView(state, record, attempt, now);
      if (view.state === "suspect" || view.state === "orphaned") candidates.push({ cls: "dispatch-orphan", at: Date.parse(attempt.at), id: record.task.id, minutes: view.elapsedMin });
    } else if ((attempt.status === "failed" || attempt.status === "orphaned") && attempt.failure && isFailureClass(attempt.failure.class)) {
      // failure 없는 옛 시도는 후보가 아니다 — advance 가 error 문구로 추정한다
      candidates.push({ cls: attempt.failure.class, at: Date.parse(attempt.failure.at), id: record.task.id, detail: attempt.failure.detail });
    }
  }
  const latest = candidates.filter((item) => !Number.isNaN(item.at)).sort((a, b) => b.at - a.at)[0];
  if (!latest) return undefined;
  const label = POLICIES[latest.cls].label;
  if (latest.minutes !== undefined) {
    return `[${label}] 배정 ${latest.id} 이(가) 실행 중으로 기록된 지 ${latest.minutes}분입니다 — 기다리지 말고 code-agent planning advance 의 안내(아직 부르지 않은 배정은 지금 호출, 부른 배정은 cancel 뒤 재배정)를 따릅니다`;
  }
  const detail = (latest.detail ?? "").split("\n")[0].slice(0, 120);
  return `[${label}] 배정 ${latest.id}: ${detail} — code-agent planning advance 가 다음 처리(형식 교정·수정 피드백 재배정·사람 판단)와 남은 횟수를 알려 줍니다`;
}

interface ConsentView { action?: { action?: unknown }; status?: unknown; createdAt?: unknown; failure?: { class?: unknown; detail?: unknown } }

function deliverHint(work: Work): string | undefined {
  const { repoRoot, active } = work;
  if (active.phase !== "deliver") return undefined;
  // deliver 진입 시각 — 집계 로그(판정에 쓰지 않는다)라 없거나 읽지 못하면 안내를 내지 않는다(옛 실패를 지금 것으로 보이지 않게)
  const entered = readStages(repoRoot).filter((row) => row.id === active.id && row.target === active.target && row.phase === "deliver").at(-1)?.at;
  const since = entered ? Date.parse(entered) : NaN;
  if (Number.isNaN(since)) return undefined;
  const dir = join(repoRoot, STATE_DIR, "consents");
  const files = readdirSync(dir).filter((name) => CONSENT_FILE.test(name)).flatMap((name) => {
    try { return [{ name, mtime: statSync(join(dir, name)).mtimeMs }]; } catch { return []; }
  }).sort((a, b) => b.mtime - a.mtime).slice(0, CONSENT_SCAN);
  let last: { record: ConsentView; created: number } | undefined;
  for (const file of files) {
    let record: ConsentView;
    try { record = JSON.parse(readFileSync(join(dir, file.name), "utf8")) as ConsentView; } catch { continue; }
    if (record?.action?.action !== "deliver" || typeof record.createdAt !== "string") continue;
    const created = Date.parse(record.createdAt);
    if (!Number.isNaN(created) && (!last || created > last.created)) last = { record, created };
  }
  const failure = last?.record.failure;
  if (!last || last.record.status !== "failed" || last.created < since || !failure) return undefined;
  const cls = failure.class;
  if (!isFailureClass(cls) || !CONSENT_CLASSES.includes(cls)) return undefined;
  // 동의 출력의 failure.guide(consentGuide)와 같은 갈래 문구 — 승인이 아닌 응답(response-*)은 그 변형이다
  const kind = (failure as { kind?: unknown }).kind;
  const variant = cls === "consent-target-changed" && typeof kind === "string" && GUIDE_VARIANTS[cls]?.[kind] !== undefined ? kind : undefined;
  return `[${POLICIES[cls].label}] ${guidance(cls, { detail: typeof failure.detail === "string" ? failure.detail : "" }, variant)}`;
}
