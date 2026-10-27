/**
 * 동의 기록의 가벼운 색인 — hook 이 매번 읽을 수 있게 consent.ts(명령 모듈 전체를 끌어온다)를 import 하지 않는다.
 *
 * `.code-agent/consents/index.json` 은 열린 동의(응답·적용 대기)와 동작별 최근 종료 기록 3개를 둔다. 쓰기는 consent.ts 의
 * save() 가 동의 잠금 안에서만 하고, hook 은 읽기만 한다(깨졌거나 없으면 빈 색인). 위치가 consents/ 아래라 동의 스냅샷에서 빠진다.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { hostname } from "os";
import { join } from "path";
import { writeAtomic } from "../core/atomic";
import { pidAlive } from "./lock";
import { TIMING } from "./retryPolicy";

export const CONSENT_DIR = ".code-agent/consents";
export const CONSENT_INDEX = `${CONSENT_DIR}/index.json`;
export const CONSENT_LOCK = `${CONSENT_DIR}/apply.lock`;

/** 동의 동작의 제목 — 확인 화면 머리와 hook 거부 문구가 같이 쓴다 */
export const CONSENT_TITLES = {
  setup: "초기 설정 확정", docs: "공통 문서 확정", baseline: "기준 커밋 생성", request: "요구사항 확인",
  plan: "작업 계획 확인", deliver: "결과와 로컬 커밋 확인", "knowledge-prune": "지식 문서 정리",
  model: "에이전트 모델 변경", abort: "작업 진행 종료", "plugin-add": "플러그인 등록", "plugin-remove": "플러그인 제거",
  update: "code-agent 업데이트", "repro-log": "오류 로그 근거로 수정 진행", judgment: "사람 판단 기록",
} as const;

/** 응답·적용을 기다리는 상태 — 색인의 open 에 든다 */
export const OPEN_STATUSES: readonly string[] = ["pending", "approved", "applying"];
const RECENT_LIMIT = 3;

export interface IndexEntry { id: string; at: string; status: string; targetChanged: boolean; detail?: string }
export interface ConsentIndex {
  version: 1;
  /** session — 그 동의에 답하고 적용하는 세션(응답 관찰 뒤 sessionId, 그 전 준비 세션). 셸을 좁히는 것은 그 세션만이다 */
  open: Record<string, { action: string; status: string; createdAt: string; session?: string }>;
  recent: Record<string, IndexEntry[]>;
}
/** 색인이 다루는 기록의 필드 — consent.ts 의 ConsentRecord 부분 집합 */
export interface IndexedRecord {
  id: string; action: { action: string }; status: string; createdAt: string;
  failure?: { kind?: string; class?: string; at?: string; detail?: string };
  sessionId?: string; preparedSession?: { id: string };
}

function emptyIndex(): ConsentIndex { return { version: 1, open: Object.create(null), recent: Object.create(null) }; }

/** 읽기 — 없거나 깨졌으면 undefined */
export function readConsentIndex(root: string): ConsentIndex | undefined {
  try {
    const value = JSON.parse(readFileSync(join(root, CONSENT_INDEX), "utf8")) as Partial<ConsentIndex>;
    if (value?.version !== 1 || !value.open || typeof value.open !== "object" || !value.recent || typeof value.recent !== "object") return undefined;
    return value as ConsentIndex;
  } catch { return undefined; }
}

function entryOf(record: IndexedRecord): IndexEntry {
  return {
    id: record.id, at: record.failure?.at ?? record.createdAt, status: record.status,
    targetChanged: record.failure?.kind === "target",
    ...(record.failure?.detail ? { detail: record.failure.detail.slice(0, 300) } : {}),
  };
}
function place(index: ConsentIndex, record: IndexedRecord): void {
  const action = record.action.action;
  if (OPEN_STATUSES.includes(record.status)) {
    const session = record.sessionId ?? record.preparedSession?.id;
    index.open[record.id] = { action, status: record.status, createdAt: record.createdAt, ...(session ? { session } : {}) };
    return;
  }
  delete index.open[record.id];
  // 같은 기록을 여러 번 저장해도(응답 소비 뒤 실패 기록 등) 한 줄만 남는다
  const rows = (index.recent[action] ?? []).filter((row) => row.id !== record.id);
  rows.push(entryOf(record));
  index.recent[action] = rows.slice(-RECENT_LIMIT);
}

/** consents/*.json 을 훑어 색인을 다시 만든다(색인이 없거나 깨졌을 때) */
function rebuild(root: string): ConsentIndex {
  const index = emptyIndex();
  const dir = join(root, CONSENT_DIR);
  const records: IndexedRecord[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as IndexedRecord;
        if (record?.id && record.action?.action && record.status && record.createdAt) records.push(record);
      } catch { /* 깨진 기록은 색인하지 않는다 */ }
    }
  }
  for (const record of records.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) place(index, record);
  return index;
}

/** 기록을 저장한 뒤 색인을 고친다 — 동의 잠금 안에서만 부른다 */
export function updateConsentIndex(root: string, record: IndexedRecord): void {
  const index = readConsentIndex(root) ?? rebuild(root);
  place(index, record);
  writeAtomic(join(root, CONSENT_INDEX), `${JSON.stringify(index, null, 2)}\n`);
}

/** 같은 동작의 마지막 두 종료 기록이 모두 대상 변경 폐기인가 — 그렇다면 마지막 것의 변경 대상 */
export function repeatedTargetChange(root: string, action: string): { detail?: string } | undefined {
  const rows = (readConsentIndex(root) ?? rebuild(root)).recent[action] ?? [];
  const last = rows.slice(-2);
  return last.length === 2 && last.every((row) => row.targetChanged) ? { detail: last[1].detail } : undefined;
}

/**
 * 세션 밖에서 응답·적용을 기다리는 동의(열린 창 안의 첫 항목). 색인 읽기만 한다 — 잠금 없음, 깨진 색인은 undefined.
 * session 을 주면 그 동의에 답할 수 없는 다른 세션의 것은 건너뛴다(그 세션의 쓰기는 동의 스냅샷 대조가 잡는다). 세션이 기록되지 않은
 * 동의(옛 기록·프로세스 안 준비)는 누구에게나 연다.
 */
export function openConsent(root: string, now = Date.now(), session?: string): { id: string; action: string; title: string } | undefined {
  const index = readConsentIndex(root);
  if (!index) return undefined;
  for (const [id, entry] of Object.entries(index.open)) {
    if (!OPEN_STATUSES.includes(entry.status)) continue;
    const created = Date.parse(entry.createdAt);
    if (!Number.isFinite(created) || created < now - TIMING.consentOpenWindowMs) continue;
    if (session && entry.session && entry.session !== session) continue;
    const title = (CONSENT_TITLES as Record<string, string>)[entry.action] ?? entry.action;
    return { id, action: entry.action, title };
  }
  return undefined;
}

/** 동의 잠금을 같은 PC 의 살아 있는 프로세스가 쥐고 있는가 — 적용 중 쓰기를 막는 hook 판정이 읽는다 */
export function consentLockHeld(root: string): { pid: number } | undefined {
  try {
    const owner = JSON.parse(readFileSync(join(root, CONSENT_LOCK), "utf8")) as { pid?: unknown; host?: unknown };
    if (typeof owner.pid === "number" && owner.host === hostname() && pidAlive(owner.pid)) return { pid: owner.pid };
  } catch { /* 없거나 쓰는 중 — 막지 않는다 */ }
  return undefined;
}
