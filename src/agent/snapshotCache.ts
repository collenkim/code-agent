/**
 * 동의 준비 스냅샷의 파일 내용 해시 캐시 — `.code-agent/consents/snapshot-cache.json`.
 * 저장소 스크립트가 바꿀 수 있는 성능 보조다. 응답 관찰·적용 재대조는 이 캐시를 읽지 않고 전수 해시한다.
 *
 * 키는 (size, mtimeMs, ctimeMs, ino) 넷이다. 크기를 같게 두고 mtime 을 되돌리는 변경(`touch -r`, PowerShell LastWriteTime 대입)은
 * 사용자 도구로 만들 수 있지만, ctime(POSIX inode change time · NTFS ChangeTime)은 내용·속성이 바뀌면 커널이 갱신하고 되돌릴 수 없다.
 * 그래서 캐시가 내용 변경을 놓치려면 ctime 까지 같아야 한다. 2초 안에 바뀐 파일과 ctime 을 주지 않는 파일 시스템(0)은 캐시하지 않는다.
 * 해시 값과 형식은 캐시가 없을 때와 같다 — 동의 기록의 snapshot·snapshotEntries와 같은 형식으로 비교한다.
 */
import { createHash } from "crypto";
import { readFileSync, type Stats } from "fs";
import { join } from "path";

import { writeAtomic } from "../core/atomic";

const FILE = ".code-agent/consents/snapshot-cache.json";
const FRESH_MS = 2_000;
type Entry = [size: number, mtimeMs: number, ctimeMs: number, ino: number, sha256: string];
interface CacheFile { version: 1; root: string; entries: Record<string, Entry> }
type StatLike = Pick<Stats, "size" | "mtimeMs" | "ctimeMs" | "ino">;

export class SnapshotCache {
  private readonly seen: Record<string, Entry> = Object.create(null);
  private changed = false;
  private constructor(private readonly root: string, private readonly entries: Record<string, Entry>) {}

  /** 깨졌거나 다른 저장소의 캐시면 빈 캐시 */
  static open(root: string): SnapshotCache {
    try {
      const value = JSON.parse(readFileSync(join(root, FILE), "utf8")) as CacheFile;
      if (value?.version === 1 && value.root === root && value.entries && typeof value.entries === "object") return new SnapshotCache(root, value.entries);
    } catch { /* 없거나 깨졌다 */ }
    return new SnapshotCache(root, Object.create(null));
  }

  contentHash(file: string, full: string, stat: StatLike, now = Date.now()): string {
    const cached = this.entries[file];
    const cacheable = stat.ctimeMs > 0 && Math.max(stat.mtimeMs, stat.ctimeMs) < now - FRESH_MS;
    if (cacheable && Array.isArray(cached) && cached[0] === stat.size && cached[1] === stat.mtimeMs && cached[2] === stat.ctimeMs && cached[3] === stat.ino) {
      this.seen[file] = cached;
      return cached[4];
    }
    const sha = createHash("sha256").update(readFileSync(full)).digest("hex");
    if (cacheable) {
      this.seen[file] = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, sha];
      this.changed = true;
    } else if (cached) this.changed = true;
    return sha;
  }

  /** 이번에 본 파일만 남겨 쓴다. 바뀐 것이 없으면 쓰지 않는다 */
  save(): void {
    if (!this.changed && Object.keys(this.entries).length === Object.keys(this.seen).length) return;
    try { writeAtomic(join(this.root, FILE), JSON.stringify({ version: 1, root: this.root, entries: this.seen } satisfies CacheFile)); }
    catch { /* 캐시는 덤이다 — 쓰지 못하면 다음에 다시 읽는다 */ }
  }
}
