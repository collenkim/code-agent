/** TTY로 확인한 호스트 전환은 같은 작업의 새 세션에 한 번만 연결한다. 승인 권한은 주지 않는다. */
import { existsSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { interactionContext, currentInteractions } from "../interactions";
import { listRuns, masterPath, readOwner, writeJson } from "./store";
import type { HostProfile } from "./protocol";
interface HostHandoff {
  id: string; at: string; host: "claude" | "codex"; branch: string | null; head: string | null; workId: string | null;
  generation?: number; questions: { requestId: string; title: string; questions: unknown[] }[];
}
export function recordHostHandoff(root: string, host: "claude" | "codex", questionIds: string[]): void {
  const context = interactionContext(root, "handoff", host), generation = readOwner(root)?.generation;
  const questions = currentInteractions(root).requests.filter(q => questionIds.includes(q.requestId)).map(q => ({ requestId: q.requestId, title: q.title, questions: q.questions }));
  writeJson(masterPath(root, "host-handoff.json"), { id: randomUUID(), at: new Date().toISOString(), host, branch: context.branch, head: context.head, workId: context.workId, generation, questions });
}
export function pendingHostHandoff(root: string, profile: HostProfile): HostHandoff | undefined {
  const path = masterPath(root, "host-handoff.json");
  if (!existsSync(path)) return undefined;
  const handoff = JSON.parse(readFileSync(path, "utf8")) as HostHandoff;
  const context = interactionContext(root, "handoff", profile.kind);
  if (handoff.host !== profile.kind || handoff.branch !== context.branch || handoff.head !== context.head || handoff.workId !== context.workId ||
    handoff.generation !== readOwner(root)?.generation || listRuns(root).some(r => r.handoffId === handoff.id)) return undefined;
  return handoff;
}
