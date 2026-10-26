/** 브랜치 전환은 조회만으로 상태를 바꾸지 않는다. 다음 저장 때 이전 커서·임대를 보관한다. */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { createHash } from "crypto";
import { join, resolve } from "path";
import { writeAtomic } from "../core/atomic";
import type { ActiveWork } from "./layout";
import { acquireLock } from "./lock";
import { TIMING } from "./retryPolicy";
import { readJson } from "./stateJson";

export const BRANCH_CURSORS = ".code-agent/branches";
const PRIMARY = ".code-agent/active.json", LEASE = ".code-agent/lease.json";

/** Git HEAD는 전환 때마다 읽는다. worktree의 gitdir 포인터·unborn·detached HEAD도 구분한다. */
export function checkoutBranch(root: string): string | undefined {
  const marker = join(root, ".git");
  if (!existsSync(marker)) return undefined;
  let dir = marker;
  if (!statSync(marker).isDirectory()) {
    const pointer = /^gitdir: (.+)\r?\n?$/.exec(readFileSync(marker, "utf8"));
    if (!pointer) throw new Error("Git 작업 폴더의 gitdir을 읽을 수 없습니다");
    dir = resolve(root, pointer[1].trim());
  }
  const head = readFileSync(join(dir, "HEAD"), "utf8").trim();
  if (/^[a-f0-9]{40,64}$/i.test(head)) return ""; // detached는 이름 있는 작업과 다르다
  const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1];
  if (!branch) throw new Error("Git HEAD의 브랜치를 확인할 수 없습니다");
  return branch;
}

export function branchCursorFile(branch: string): string {
  return `${BRANCH_CURSORS}/${createHash("sha256").update(branch).digest("hex")}.json`;
}
const leaseFile = (file: string) => file === PRIMARY ? LEASE : file.replace(/\.json$/, ".lease.json");
function read(root: string, file: string): ActiveWork | undefined {
  if (!existsSync(join(root, file))) return undefined;
  return readJson(join(root, file), { parse(raw) {
    const value = raw as ActiveWork;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        (value.branch !== undefined && (typeof value.branch !== "string" || !value.branch))) throw new Error(`작업 커서 형식이 유효하지 않습니다: ${file}`);
    return value;
  } }, file);
}
export function cursorOnBranch(root: string, branch: string | undefined): { file: string; active: ActiveWork } | undefined {
  const primary = read(root, PRIMARY);
  // 브랜치가 없는 이전 기록은 기존 저장소 단위 규약으로 다룬다.
  if (primary && (!primary.branch || primary.branch === branch || branch === undefined)) return { file: PRIMARY, active: primary };
  if (!branch) return undefined;
  const file = branchCursorFile(branch), active = read(root, file);
  if (active && active.branch !== branch) throw new Error(`보관한 작업의 브랜치가 경로와 다릅니다: ${file}`);
  return active ? { file, active } : undefined;
}
export function currentCursor(root: string): { file: string; active: ActiveWork } | undefined {
  if (!existsSync(join(root, PRIMARY)) && !existsSync(join(root, BRANCH_CURSORS))) return undefined;
  const primary = read(root, PRIMARY);
  if (primary && !primary.branch) return { file: PRIMARY, active: primary };
  return cursorOnBranch(root, checkoutBranch(root));
}
/** 버전·모델 변경은 다른 브랜치에서 보관 중인 작업도 보호한다. */
export function allCursors(root: string): ActiveWork[] {
  const primary = read(root, PRIMARY), result = primary ? [primary] : [];
  if (existsSync(join(root, BRANCH_CURSORS))) for (const name of readdirSync(join(root, BRANCH_CURSORS))) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const active = read(root, `${BRANCH_CURSORS}/${name}`)!;
    if (!active.branch || branchCursorFile(active.branch) !== `${BRANCH_CURSORS}/${name}`) throw new Error(`보관한 작업의 브랜치가 경로와 다릅니다: ${name}`);
    if (active.branch !== primary?.branch) result.push(active);
  }
  return result;
}
export function currentLeaseFile(root: string): string {
  return leaseFile(currentCursor(root)?.file ?? PRIMARY);
}
function withLock(root: string, action: () => void): void {
  mkdirSync(join(root, BRANCH_CURSORS), { recursive: true });
  // init을 다시 실행하지 않은 설치에서도 개인 상태를 커밋하지 않는다.
  writeAtomic(join(root, BRANCH_CURSORS, ".gitignore"), "*\n");
  const release = acquireLock(join(root, BRANCH_CURSORS, "cursor.lock"), { waitMs: TIMING.lockWaitMs, ageReclaim: false, label: "브랜치 작업 커서" });
  try { action(); } finally { release(); }
}
export function writeCursor(root: string, active: ActiveWork): void {
  withLock(root, () => {
    const branch = checkoutBranch(root);
    if (active.branch && branch !== undefined && active.branch !== branch) throw new Error("작업 브랜치가 현재 브랜치와 다릅니다. 해당 브랜치에서 재개하세요.");
    const primary = read(root, PRIMARY);
    if (!active.branch && primary?.branch && branch !== undefined && primary.branch !== branch) throw new Error("다른 브랜치의 작업을 브랜치 없는 커서로 덮어쓸 수 없습니다");
    if (primary?.branch && active.branch && primary.branch !== active.branch) {
      const archive = branchCursorFile(primary.branch);
      writeAtomic(join(root, archive), JSON.stringify(primary, null, 2) + "\n");
      if (existsSync(join(root, LEASE))) writeAtomic(join(root, leaseFile(archive)), readFileSync(join(root, LEASE), "utf8"));
      else rmSync(join(root, leaseFile(archive)), { force: true });
    }
    if (active.branch && primary?.branch !== active.branch) {
      const incoming = leaseFile(branchCursorFile(active.branch));
      if (existsSync(join(root, incoming))) writeAtomic(join(root, LEASE), readFileSync(join(root, incoming), "utf8"));
      else rmSync(join(root, LEASE), { force: true });
    }
    writeAtomic(join(root, PRIMARY), JSON.stringify(active, null, 2) + "\n");
    if (active.branch) rmSync(join(root, branchCursorFile(active.branch)), { force: true });
  });
}
export function removeCursor(root: string): void {
  withLock(root, () => {
    const current = currentCursor(root);
    if (!current) return;
    // 중단된 교체의 중복 사본이 다시 살아나지 않게 보관 사본부터 지운다.
    if (current.active.branch) rmSync(join(root, branchCursorFile(current.active.branch)), { force: true });
    if (current.file === PRIMARY) rmSync(join(root, PRIMARY), { force: true });
  });
}
