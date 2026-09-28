import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "fs";
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

export const PHASES = ["analysis", "research", "plan", "implement", "verify", "handoff"] as const;
export type Phase = (typeof PHASES)[number];

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

export function saveActive(repoRoot: string, active: ActiveWork): void {
  mkdirSync(join(repoRoot, STATE_DIR), { recursive: true });
  writeAtomic(join(repoRoot, ACTIVE_FILE), `${JSON.stringify(active, null, 2)}\n`);
}

export function clearActive(repoRoot: string): void {
  rmSync(join(repoRoot, ACTIVE_FILE), { force: true });
}
