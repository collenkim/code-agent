import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "fs";
import { basename, dirname, join, posix } from "path";

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
/** 문서 작성 세션 — 있는 동안 hook 이 문서 자리 밖 쓰기를 막는다 */
export const DOCS_SESSION_FILE = `${STATE_DIR}/docs-session.json`;

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
 * Stop hook 이 턴 끝에 들여다보는 스테이지 — 코드를 쓰는 자리부터 통합 검증까지.
 *
 * `deliver` 는 뺀다. 거기서는 `code-agent deliver` 가 같은 대조를 절대적으로 하고 사람이 TTY 앞에
 * 있으므로, 한 번 더 막아 봐야 사람이 보는 화면에 잡음만 는다.
 */
export const STOP_PHASES: readonly Phase[] = ["implement", "check", "test", "review", "integrate"];

export interface ActiveWork {
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

/** 커서를 움직인 명령 */
export type StageMove = "start" | "next" | "back" | "deliver" | "abort";

/** 전이 한 줄. `code-agent usage` 가 메시지의 timestamp 를 이 구간에 담는다 */
export interface StageTransition {
  /** 전이한 시각 (ISO) */
  at: string;
  id: string;
  target: string;
  phase: Phase;
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
export function logStage(repoRoot: string, active: ActiveWork, by: StageMove): void {
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
