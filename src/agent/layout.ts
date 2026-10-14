import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "fs";
import { hostname, networkInterfaces } from "os";
import { basename, dirname, join, posix, resolve } from "path";

import { writeAtomic } from "../core/atomic";

/**
 * 대상 저장소 안의 자리.
 *
 * 둘로 나뉜다. `.code-agent/` 는 **코드만** 쓴다 — 진행 커서·제출된 계획·승인 원장이라 모델이 고치면
 * 통제가 무너진다 (hook 이 막는다). `doc/work/<ID>/` 는 **모델과 사람이** 쓴다 — 분석·질문·작업 문서·계획 초안.
 */
export const STATE_DIR = ".code-agent";
export const ACTIVE_FILE = `${STATE_DIR}/active.json`;
export const WORK_DOCS_DIR = "doc/work";
/**
 * 뼈대 역공학 초안 자리 — ca-surveyor 가 영역별 초안을 쓰고 ca-writer 가 읽는다(본문이 메인 대화를 거쳐 다시 출력되지 않게 경로만 넘긴다).
 * 문서 세션이 열 때 자기 자신을 무시하는 `.gitignore` 와 함께 만들고 닫을 때 지운다
 */
export const SURVEY_DRAFTS = "doc/.survey";
/** 문서 작성 세션 — 있는 동안 hook 이 문서 자리 밖 쓰기를 막는다 */
export const DOCS_SESSION_FILE = `${STATE_DIR}/docs-session.json`;
/** 요구사항 접수 세션 — 있는 동안 hook 이 그 작업 폴더 밖 쓰기와 지시서 쓰기를 막는다 */
export const REQUEST_SESSION_FILE = `${STATE_DIR}/request-session.json`;

export const PHASES = [
  "analysis",
  "impact",
  "design",
  "plan",
  "implement",
  "check",
  "test",
  "review",
  "integrate",
  "deliver",
] as const;
export type Phase = (typeof PHASES)[number];

/** 구현 뒤의 스테이지 — 계획 파일을 고쳐 쓰는 자리라 hook 이 같은 규칙으로 판정한다 */
export const AFTER_IMPLEMENT: readonly Phase[] = ["check", "test", "review", "integrate", "deliver"];

/**
 * Stop hook 이 턴 끝에 들여다보는 스테이지 — 코드를 쓰는 자리부터 반영까지.
 *
 * `deliver` 도 본다 — 동의 흐름에서는 사람이 TTY 앞에 있지 않으므로, 반영 동의를 묻기 전에 계획 밖 변경·남은 질문을
 * 턴 끝에 한 번 알린다(커밋 자체는 `code-agent deliver` 가 같은 대조로 절대적으로 막는다).
 */
export const STOP_PHASES: readonly Phase[] = ["implement", "check", "test", "review", "integrate", "deliver"];

export interface ActiveWork {
  /** 신규 작업은 관찰된 분석·조사·설계·계획 검토를 필수로 한다. 없는 기록은 기존 작업이다. */
  planningVersion?: 1;
  /** 신규 작업은 02 의 `문서 영향` 판단과 계획 파일에 걸린 지식 항목 판단을 필수로 한다(knowledgeImpact.ts). 없는 기록은 기존 작업이다. */
  knowledgeVersion?: 1;
  /** 구현 단계 안에서 현재 수행하는 독립 Task. */
  task?: string;
  /** 작업 지시서 id */
  id: string;
  /** 작업 지시서 경로, 저장소 기준 */
  spec: string;
  /** 지시서의 대상 중 지금 진행하는 것 */
  target: string;
  phase: Phase;
  /** 작업 브랜치와 그 기준. git 저장소가 아니면 없다 */
  branch?: string;
  base?: string;
  /**
   * 작업을 시작할 때 기준 브랜치를 굳혀 둔 커밋. **이름이 아니라 커밋이다.**
   *
   * 브랜치 이름은 움직인다. 이름만 들고 있으면 같은 작업이 언제 검증하느냐에 따라 변경 목록이
   * 달라지고, 증거가 무엇 위에서 났는지 아무도 모른다. P5 의 모든 대조(계획 밖 변경 · 증거 묶기 ·
   * 커밋 대상)가 이 값 위에 선다. git 저장소가 아니면 없다 — 그 경우 검증 스테이지가 거부한다.
   */
  baseCommit?: string;
  /** implement 에서 지금 도는 매니페스트 단계 key */
  stage?: string;
}

/**
 * 서브에이전트에게 넘길 긴 자료(전달 사본)를 두는 폴더 — 저장소 기준, `/` 구분. 반영 커밋은 이 폴더를 뺀다(deliver.ts deliveryExcludes).
 * handoff.ts 가 다시 내보낸다(deliver.ts 가 handoff.ts 를 읽으면 deliver → handoff → commands → deliver 순환이 생긴다).
 */
export function handoffDir(id: string): string {
  return posix.join(STATE_DIR, "work", id, "handoff");
}

/** 모델이 쓰는 작업 폴더 — 저장소 기준, `/` 구분 */
export function workDocsDir(id: string): string {
  return posix.join(WORK_DOCS_DIR, id);
}

export function questionsFile(id: string): string {
  return posix.join(workDocsDir(id), "questions.md");
}

/** 제출된 계획. 초안은 작업 폴더에 있고, `plan submit` 만이 이 자리에 쓴다 */
export function planFile(repoRoot: string, id: string, target: string): string {
  return join(repoRoot, STATE_DIR, "work", id, `${target}.plan.json`);
}

/** 검증 증거. `code-agent check` · `test` 만이 이 자리에 쓴다 — hook 이 도구 쓰기를 막는다 */
export function verifyFile(repoRoot: string, id: string, target: string): string {
  return join(repoRoot, STATE_DIR, "work", id, `${target}.verify.json`);
}

/** 리뷰 회차. `code-agent review` 만이 이 자리에 쓴다 — 회차의 기준 트리 해시를 모델이 지어내지 못하게 */
export function reviewFile(repoRoot: string, id: string, target: string): string {
  return join(repoRoot, STATE_DIR, "work", id, `${target}.review.json`);
}

/** 작업 경험 기록(선택) — `code-agent experience add` 만이 쓴다(hook 이 도구 쓰기를 막는다). 작업 폴더라 반영 커밋에 함께 들어간다 */
export function experienceFile(id: string): string {
  return posix.join(workDocsDir(id), "experience.md");
}

/**
 * 경험·발견 초안의 정해진 자리 — 작업 폴더라 모델이 쓸 수 있다. 기록하면 코드가 이 자리의 초안을 지운다(기록 파일이 정본이라
 * 같은 내용이 반영 커밋에 둘로 남지 않게). 다른 자리의 초안은 지우지 않는다
 */
export function draftFile(id: string, kind: "experience" | "finding"): string {
  return posix.join(workDocsDir(id), `${kind}.draft.json`);
}

/** 기록한 뒤 부른다 — 받은 초안이 정해진 자리의 것일 때만 지우고 true */
export function removeDraft(repoRoot: string, id: string, kind: "experience" | "finding", given: string): boolean {
  const own = join(repoRoot, draftFile(id, kind));
  const fold = (path: string): string => (process.platform === "win32" ? path.toLowerCase() : path);
  if (!existsSync(own) || fold(canonical(resolve(process.cwd(), given))) !== fold(canonical(own))) return false;
  rmSync(own, { force: true });
  return true;
}

/** 진행 중 발견 보고 — `code-agent finding report` 만이 쓴다. 상태 폴더라 도구 쓰기는 hook 이 막고, 반영 커밋에 함께 들어간다 */
export function findingsFile(repoRoot: string, id: string): string {
  return join(repoRoot, STATE_DIR, "work", id, "findings.json");
}

/** 검증 로그. `.gitignore` 에 있어 커밋되지 않는다 — 근거는 ⑧ 이 들고 있다 */
export function logDir(repoRoot: string): string {
  return join(repoRoot, STATE_DIR, "log");
}

/**
 * 실제 경로로 푼다. 아직 없는 파일은 있는 가장 가까운 조상을 풀고 나머지를 붙인다.
 *
 * Windows 는 같은 폴더를 8.3 이름(`김우석~1`)과 긴 이름으로 둘 다 부른다. 루트와 파일이
 * 다른 형태로 오면 문자열 비교는 저장소 밖으로 본다. 링크·junction 으로 밖을 가리키는 것도 여기서 드러난다.
 */
export function canonical(path: string): string {
  let head = path;
  const rest: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) {
      return path;
    }
    rest.unshift(basename(head));
    head = parent;
  }
  return join(realpathSync.native(head), ...rest);
}

/** IPv6 주소의 비교용 꼴 — 영역(`%n`)을 떼고 URL 정규화로 줄인다(`0::1` → `::1`). IPv6 가 아니면 소문자 그대로 */
function ipv6Key(address: string): string {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!bare.includes(":")) return address.toLowerCase();
  try { return new URL(`http://[${bare}]/`).hostname.slice(1, -1).toLowerCase(); } catch { return bare.toLowerCase(); }
}
/** UNC 용 IPv6 리터럴 이름(`0--1.ipv6-literal.net` — `-`는 `:`, `s`는 영역 구분 `%`)의 주소. 그 꼴이 아니면 undefined */
function ipv6Literal(host: string): string | undefined {
  const match = /^([0-9a-f-]+(?:s[0-9a-z]+)?)\.ipv6-literal\.net$/i.exec(host);
  return match ? match[1].replace(/-/g, ":").replace(/s/i, "%") : undefined;
}
/** 로컬 관리 공유로 보는 호스트 — 이름(localhost·이 PC 이름)과 이 PC 의 네트워크 주소(IPv4·IPv6, IPv6 리터럴 이름 포함) */
function localHost(host: string): boolean {
  const name = host.toLowerCase();
  if (["localhost", hostname().toLowerCase()].includes(name)) return true;
  const address = ipv6Key(ipv6Literal(name) ?? name);
  const known = ["127.0.0.1", "::1", ...Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((entry) => entry.address))];
  return known.some((entry) => ipv6Key(entry) === address);
}
/**
 * win32 전용 — 로컬 관리 공유·장치 경로를 드라이브 경로로 접는다(그 밖은 그대로). 같은 파일을 다른 이름으로 가리켜 경로 대조를
 * 비켜 가는 길을 닫는다: `\\?\C:\x`·`\\.\C:\x` → `C:\x`, `\\?\UNC\host\share\x` → `\\host\share\x`, `\\<로컬>\C$\x` → `C:\x`.
 */
export function foldWindowsAlias(path: string, platform: string = process.platform): string {
  if (platform !== "win32") return path;
  const device = /^[\\/]{2}[?.][\\/]([A-Za-z]:(?:[\\/][\s\S]*)?)$/.exec(path);
  if (device) return device[1];
  let folded = path;
  const unc = /^[\\/]{2}\?[\\/]UNC[\\/]([\s\S]*)$/i.exec(folded);
  if (unc) folded = `\\\\${unc[1]}`;
  const share = /^[\\/]{2}([^\\/]+)[\\/]([A-Za-z])\$([\\/][\s\S]*)?$/.exec(folded);
  if (share && localHost(share[1])) return `${share[2].toUpperCase()}:${share[3] ?? "\\"}`;
  return folded;
}

/**
 * win32 전용 — 접히지 않은 UNC 경로(`\\<이름>\<공유>\…`, 이름 목록에 없는 FQDN·별칭·사용자 공유)가 저장소 안을 가리키는가.
 * 공유 루트에 닿을 수 있으면 가장 가까운 기존 조상부터 위로 (dev, ino)를 저장소 루트와 견주어, 같으면 그 아래 경로를 저장소 기준으로 돌려준다.
 * 닿지 못하거나 저장소 밖이면 undefined. 쓰기 판정만 부른다(UNC 경로일 때만 파일 시스템을 본다).
 */
export function shareInside(root: string, path: string, platform: string = process.platform): string | undefined {
  if (platform !== "win32") return undefined;
  const unc = /^[\\/]{2}([^\\/?.][^\\/]*)[\\/]([^\\/]+)([\\/][\s\S]*)?$/.exec(path);
  if (!unc) return undefined;
  const shareRoot = `\\\\${unc[1]}\\${unc[2]}\\`;
  try {
    const want = statSync(root, { bigint: true });
    statSync(shareRoot);   // 닿지 않는 이름은 여기서 한 번만 기다린다
    const parts = (unc[3] ?? "").split(/[\\/]/).filter(Boolean);
    for (let depth = parts.length; depth >= 0; depth--) {
      let stat;
      try { stat = statSync(shareRoot + parts.slice(0, depth).join("\\"), { bigint: true }); } catch { continue; }
      if (stat.dev === want.dev && stat.ino === want.ino) return join(root, ...parts.slice(depth));
    }
  } catch { /* 닿지 않는 공유 — 저장소 밖으로 본다 */ }
  return undefined;
}

/**
 * 문서 작성 세션 — 없으면 undefined, 깨졌거나 version 이 없으면 {}(이전 형식: hook 이 지금 매니페스트로 문서 자리를 계산한다).
 * writable 은 `docs begin` 때의 매니페스트로 고정한 쓰기 범위(저장소 상대 경로)이고, `docs link` 로 연결한 문서만 더해진다.
 */
export function loadDocsSession(root: string): { version?: 2; startedAt?: string; writable?: string[] } | undefined {
  const path = join(root, DOCS_SESSION_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; startedAt?: unknown; writable?: unknown };
    if (value?.version !== 2 || !Array.isArray(value.writable)) return {};
    return { version: 2, ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
      writable: value.writable.filter((item): item is string => typeof item === "string") };
  } catch { return {}; }
}

/** 위로 올라가며 `.git` 이 있는 곳. 없으면 시작한 곳 — 저장소가 아닌 곳에서도 상태 조회는 된다 */
export function findRepoRoot(start: string): string {
  let dir = canonical(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return canonical(start);
    }
    dir = parent;
  }
}

export function loadActive(repoRoot: string): ActiveWork | undefined {
  const path = join(repoRoot, ACTIVE_FILE);
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf-8")) as ActiveWork;
}

export function saveActive(repoRoot: string, active: ActiveWork, by?: StageMove): void {
  mkdirSync(join(repoRoot, STATE_DIR), { recursive: true });
  writeAtomic(join(repoRoot, ACTIVE_FILE), `${JSON.stringify(active, null, 2)}\n`);
  if (by) {
    logStage(repoRoot, active, by);
  }
}

export function clearActive(repoRoot: string): void {
  rmSync(join(repoRoot, ACTIVE_FILE), { force: true });
}

// ---- 스테이지 전이 기록 ----

/** 스테이지 전이 기록 — `.gitignore` 의 `.code-agent/log/` 안이라 커밋되지 않는다 */
export const STAGES_LOG = `${STATE_DIR}/log/stages.jsonl`;

/** 커서를 움직인 명령. `request` 는 커서가 생기기 전의 접수다 */
export type StageMove = "request" | "start" | "next" | "back" | "deliver" | "abort";

/** 기록에 남는 자리 — 스테이지 열 개와, 커서가 생기기 전의 접수 */
export type LoggedPhase = Phase | "request";

/** 전이 한 줄. `code-agent usage` 가 메시지의 timestamp 를 이 구간에 담는다 */
export interface StageTransition {
  /** 전이한 시각 (ISO) */
  at: string;
  id: string;
  target: string;
  phase: LoggedPhase;
  stage?: string;
  by: StageMove;
}

/**
 * 커서가 움직인 시각을 남긴다 — **집계용이고 판정에는 쓰지 않는다.**
 *
 * `usage` 가 토큰을 스테이지별로 가르는 유일한 근거다. Claude Code 기록에는 우리 스테이지가 없고
 * 시각만 있어서, 이 줄이 없으면 "어느 단계에 얼마를 썼는가" 를 물을 자리가 사라진다.
 *
 * 쓰기 실패는 **삼킨다**. 통계용 로그가 작업을 세우는 것은 값어치에 비해 비싸다.
 * `saveActive` 의 `by` 를 생략하면 기록하지 않는다 — 테스트 헬퍼가 조용히 오염시키지 않게.
 */
export function logStage(
  repoRoot: string,
  active: { id: string; target: string; phase: LoggedPhase; stage?: string },
  by: StageMove,
): void {
  const row: StageTransition = {
    at: new Date().toISOString(),
    id: active.id,
    target: active.target,
    phase: active.phase,
    ...(active.stage ? { stage: active.stage } : {}),
    by,
  };
  try {
    mkdirSync(logDir(repoRoot), { recursive: true });
    appendFileSync(join(repoRoot, STAGES_LOG), `${JSON.stringify(row)}\n`);
  } catch {
    // 집계용 로그가 작업을 세우면 안 된다
  }
}

/** 시각 순으로 읽는다. 깨진 줄은 그 줄만 버린다 — 쓰는 중일 수 있다 */
export function readStages(repoRoot: string): StageTransition[] {
  const path = join(repoRoot, STAGES_LOG);
  if (!existsSync(path)) {
    return [];
  }
  const rows: StageTransition[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as StageTransition);
    } catch {
      // 반쯤 쓰인 줄
    }
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}
