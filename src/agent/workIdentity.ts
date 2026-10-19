/** 접수한 ID와 종류는 브랜치 전환·접수 종료 뒤에도 같은 작업을 가리킨다. 승인 근거는 기존 원장을 쓴다. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { KINDS, parseFrontMatter, type WorkKind } from "../core/workOrder";
import { allCursors } from "./branchCursor";
import { loadActive, REQUEST_SESSION_FILE, workDocsDir } from "./layout";
import { acquireLock } from "./lock";
import { Stop } from "./stop";
import { commitOf } from "./tree";

export const WORK_IDENTITIES = ".code-agent/identities";
interface Identity { version: 1; id: string; kind: WorkKind; }
const validId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);

/** 새 기록이 없는 설치는 접수 세션·렌더된 지시서·작업 브랜치에서 종류를 확인한다. */
export function workIdentity(root: string, id: string): Identity | undefined {
  if (!validId(id)) throw new Stop(`작업 ID 형식이 올바르지 않습니다: ${id}`);
  const file = join(root, WORK_IDENTITIES, `${id.toLowerCase()}.json`);
  if (existsSync(file)) {
    const value = JSON.parse(readFileSync(file, "utf8")) as Identity;
    if (value.version !== 1 || !KINDS.includes(value.kind) || value.id !== id) throw new Stop(`접수 식별 기록이 다르거나 손상되었습니다: ${id}. 기존 ID와 기록을 확인하세요.`);
    return value;
  }
  const kinds = new Set<WorkKind>();
  const add = (value: { id?: unknown; kind?: unknown }) => {
    if (value.id !== id || !KINDS.includes(value.kind as WorkKind)) throw new Stop(`기존 작업 ${id}의 ID·종류를 확인할 수 없습니다. 기존 접수 기록을 복구하세요.`);
    kinds.add(value.kind as WorkKind);
  };
  const session = join(root, REQUEST_SESSION_FILE);
  if (existsSync(session)) {
    const value = JSON.parse(readFileSync(session, "utf8"));
    if (value.id === id) add(value);
  }
  const spec = join(root, workDocsDir(id), "requirement.md");
  if (existsSync(spec)) add(parseFrontMatter(readFileSync(spec, "utf8")) ?? {});
  // 초안만 남은 접수도 종류를 새로 추측하지 않는다.
  const draft = join(root, workDocsDir(id), "request.json");
  if (!kinds.size && existsSync(draft)) {
    const value = JSON.parse(readFileSync(draft, "utf8"));
    // 아직 ID·종류도 없는 빈 초안은 접수 근거가 아니다(직접 지시서 시작과 공존할 수 있다).
    if (value && typeof value === "object" && ("id" in value || "kind" in value)) add(value);
  }
  for (const active of allCursors(root).filter(item => item.id === id)) {
    const kind = active.branch?.split("/")[0] as WorkKind;
    if (KINDS.includes(kind)) kinds.add(kind);
  }
  if (existsSync(join(root, ".git"))) for (const kind of KINDS) {
    if (commitOf(root, `refs/heads/${kind}/${id}`)) kinds.add(kind);
  }
  if (kinds.size > 1) throw new Stop(`기존 작업 ${id}의 접수 종류가 서로 다릅니다. 중복 생성하지 말고 기존 기록을 확인하세요.`);
  return kinds.size ? { version: 1, id, kind: [...kinds][0] } : undefined;
}

export function requireWorkKind(root: string, id: string, kind: WorkKind): void {
  const previous = workIdentity(root, id);
  if (previous && previous.kind !== kind) throw new Stop(`${id} 는 ${previous.kind} 로 접수한 작업입니다. 후속 수정도 기존 종류를 유지합니다 — ${kind} 로 다시 접수하지 않습니다.`);
}

export function rememberWorkIdentity(root: string, id: string, kind: WorkKind): void {
  mkdirSync(join(root, WORK_IDENTITIES), { recursive: true });
  writeFileSync(join(root, WORK_IDENTITIES, ".gitignore"), "*\n");
  const release = acquireLock(join(root, WORK_IDENTITIES, "identity.lock"), { waitMs: 0, ageReclaim: false, label: "접수 식별 기록" });
  try {
    requireWorkKind(root, id, kind);
    const file = join(root, WORK_IDENTITIES, `${id.toLowerCase()}.json`);
    if (!existsSync(file)) writeFileSync(file, JSON.stringify({ version: 1, id, kind } satisfies Identity) + "\n", { flag: "wx" });
  } finally { release(); }
}

export function requireWorkOnCurrentBranch(root: string, id: string): void {
  const current = loadActive(root);
  const retained = allCursors(root).find(item => item.id === id && item.branch !== current?.branch);
  if (retained) throw new Stop(`작업 ${id}가 브랜치 ${retained.branch}에 보관되어 있습니다. 해당 브랜치에서 재개하세요. 같은 ID를 중복 생성하지 않습니다.`);
}
