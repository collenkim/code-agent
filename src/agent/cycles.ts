import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join, posix } from "path";

import { writeAtomic } from "../core/atomic";
import { STATE_DIR, workDocsDir, type ActiveWork } from "./layout";
import { textHash } from "./requirementRevisions";

/**
 * 실행 회차 — 같은 작업 ID 가 반영된 뒤 후속 요청으로 다시 시작하면 새 회차다.
 *
 * 반영(deliver)이 그 회차를 `.code-agent/work/<ID>/cycles.json` 에 적어 반영 커밋에 함께 넣는다. 다음 start 는 작업 브랜치(없으면 기준 브랜치)의
 * git 이력에서 그 파일을 마지막으로 바꾼 커밋을 이전 회차의 반영 커밋으로 읽는다 — 작업 트리의 파일이 아니라 커밋된 기록이라, 반영이 커밋 전에
 * 멈춘 기록은 회차가 되지 않는다. 이 기록 전에 반영한 작업은 `[<ID>] ` 로 시작하는 반영 커밋 제목으로 찾는다.
 */

export interface CycleRecord {
  cycle: number;
  /** 반영한 확정 요구 — 개정 번호(개정 기록이 있을 때)와 지시서 해시 */
  revision?: number;
  requestHash: string;
  branch?: string;
  baseCommit: string;
  /** 검증한 계획 파일의 부분 트리 해시 */
  treeHash: string;
  deliveredAt: string;
}
interface CycleLog { version: 1; cycles: CycleRecord[] }

/** 이전 회차 — 반영 커밋과 그때 반영한 지시서 해시 */
export interface DeliveredCycle { commit: string; cycle: number; revision?: number; requestHash?: string }

export function cyclesFile(id: string): string {
  return posix.join(STATE_DIR, "work", id, "cycles.json");
}

/** 파일 본문(`show`)은 그대로, 나머지는 앞뒤 공백을 걷는다. 없는 ref·경로면 undefined */
function git(repoRoot: string, args: string[], raw = false): string | undefined {
  try {
    const out = execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return raw ? out : out.trim();
  } catch {
    return undefined;
  }
}

function parseLog(text: string | undefined): CycleRecord[] {
  if (!text) return [];
  try {
    const log = JSON.parse(text) as Partial<CycleLog>;
    return log.version === 1 && Array.isArray(log.cycles) ? log.cycles.filter((record) => Number.isInteger(record?.cycle) && record.cycle > 0) : [];
  } catch {
    return [];
  }
}

/**
 * 반영 직전에 이번 회차를 기록한다 — 반영 커밋에 함께 들어간다. 같은 회차를 다시 반영(커밋 실패 뒤 재시도)하면 그 회차 줄을 바꾼다.
 */
export function recordDeliveredCycle(repoRoot: string, active: ActiveWork, delivered: { requestHash: string; baseCommit: string; treeHash: string }): CycleRecord {
  const path = join(repoRoot, cyclesFile(active.id));
  const cycle = active.cycle?.number ?? 1;
  const record: CycleRecord = { cycle, ...(active.request?.revision ? { revision: active.request.revision } : {}), requestHash: delivered.requestHash,
    ...(active.branch ? { branch: active.branch } : {}), baseCommit: delivered.baseCommit, treeHash: delivered.treeHash, deliveredAt: new Date().toISOString() };
  const cycles = parseLog(existsSync(path) ? readFileSync(path, "utf-8") : undefined).filter((item) => item.cycle !== cycle);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${JSON.stringify({ version: 1, cycles: [...cycles, record].sort((a, b) => a.cycle - b.cycle) } satisfies CycleLog, null, 2)}\n`);
  return record;
}

/**
 * ref 의 이력에서 이 작업의 마지막 반영 — 회차 기록을 마지막으로 바꾼 커밋, 없으면 반영 커밋 제목(`[<ID>] `)이 붙은 커밋.
 * 지시서 해시는 그 커밋의 지시서에서 다시 잰다(회차 기록이 없는 이전 반영도 같은 요구의 재반영을 가른다).
 */
export function deliveredCycle(repoRoot: string, id: string, spec: string, ref: string): DeliveredCycle | undefined {
  const file = cyclesFile(id);
  const recorded = git(repoRoot, ["log", "-1", "--format=%H", ref, "--", file]);
  const commit = recorded || git(repoRoot, ["log", "-1", "--format=%H", "--fixed-strings", `--grep=[${id}] `, ref, "--", workDocsDir(id)]);
  if (!commit) return undefined;
  const last = recorded ? parseLog(git(repoRoot, ["show", `${commit}:${file}`], true)).at(-1) : undefined;
  const delivered = git(repoRoot, ["show", `${commit}:${spec}`], true);
  const requestHash = delivered === undefined ? last?.requestHash : textHash(delivered);
  return { commit, cycle: last?.cycle ?? 1, ...(last?.revision ? { revision: last.revision } : {}), ...(requestHash ? { requestHash } : {}) };
}
