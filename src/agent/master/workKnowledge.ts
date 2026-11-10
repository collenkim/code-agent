/**
 * master 가 인계한 지식 항목 참조의 적용 범위 — `managedExecution`(workExecution.ts)과 같은 순서로 찾는다: 지금 작업이 master 실행이
 * 연 작업이면 그 작업에 고정된 참조, 작업을 열기 전(또는 묶이기 전)이면 이 세션의 master 실행이 받은 참조. 둘 다 없으면 인계가 없는 것이다.
 *
 * 기록은 code-agent 만 쓰는 `.code-agent/master/` 에 있지만 읽을 때 인계 때와 같은 엄격 검사(`knowledgeHandoffOf`)를 다시 거친다.
 * 형식이 깨진 기록은 버리지 않는다 — 인계가 있었는데 조용히 사라지면 진행 게이트도 사라진다. 검사를 지나지 못한 기록은 `invalid` 로
 * 알리고(게이트가 그 작업을 멈춘다) 화면에는 읽을 수 있는 만큼의 참조를 그대로 실패로 보이게 남긴다.
 *
 * hook 경로 모듈이다 — fs·path·layout·runGuard·순수 계약 모듈(master/protocol.ts)과 플러그인 계약의 타입만 읽는다.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { loadActive, STATE_DIR } from "../layout";
import type { KnowledgeHandoff, KnowledgeRef } from "../plugins/protocol";
import { knowledgeDigest, knowledgeHandoffOf, normalizedKnowledgeRefs } from "./protocol";
import { masterRun } from "./runGuard";

/** 인계 하나 — 어디서 읽었는지, 검사를 지났는지, 정규화한 참조와 정본 해시 */
export interface ManagedKnowledge {
  source: "work" | "run";
  /** 검사를 지난 기록(받은 형식 그대로) — invalid 면 undefined */
  handoff?: KnowledgeHandoff;
  /** 어댑터 입력·게이트가 쓰는 꼴. invalid 면 읽을 수 있는 만큼만(형식이 어긋난 값은 빈 값) */
  refs: KnowledgeRef[];
  /** 정본 해시(`knowledgeDigest`) — invalid 면 기록 바이트의 해시 */
  digest: string;
  /** 검사를 지나지 못한 사유 — 있으면 진행 게이트가 이 작업을 멈춘다 */
  invalid?: string;
}

/** 형식이 깨진 기록에서 읽을 수 있는 만큼 — 꼴이 어긋난 값은 빈 값으로 남겨 화면·게이트에서 실패로 보이게 한다 */
function looseRefs(value: unknown): KnowledgeRef[] {
  const raw = (value as { refs?: unknown } | null | undefined)?.refs;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry: unknown) => {
    const ref = (entry ?? {}) as Record<string, unknown>;
    const generation = typeof ref.generation === "number" ? ref.generation : typeof ref.indexGeneration === "number" ? ref.indexGeneration : 0;
    return {
      itemId: typeof ref.itemId === "string" ? ref.itemId : "",
      generation,
      commit: typeof ref.commit === "string" ? ref.commit : "",
      itemSha256: typeof ref.itemSha256 === "string" ? ref.itemSha256 : "",
      required: ref.required !== false,
    };
  });
}

function knowledgeOf(value: unknown, source: ManagedKnowledge["source"]): ManagedKnowledge | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const handoff = knowledgeHandoffOf(value);
    if (!handoff) return undefined;
    return { source, handoff, refs: normalizedKnowledgeRefs(handoff), digest: knowledgeDigest(handoff) };
  } catch (error) {
    const reason = (error as { detail?: { reason?: unknown } }).detail?.reason;
    let digest: string;
    try { digest = `invalid:${JSON.stringify(value).length}`; } catch { digest = "invalid"; }
    return { source, refs: looseRefs(value), digest, invalid: typeof reason === "string" ? reason : "invalid-handoff" };
  }
}

/** 작업 연결 파일 — master 실행이 연 작업이면 있다 */
export function workBindingFile(root: string, workId: string): string {
  return join(root, STATE_DIR, "master", "works", `${encodeURIComponent(workId)}.json`);
}

/**
 * 이 저장소의 지금 작업(또는 이 세션의 master 실행)에 인계된 지식 참조. 없으면 undefined.
 * 작업 연결 파일이 있으면 그것이 정본이다(참조 없이 묶인 작업에는 인계가 없다). 연결 파일을 읽지 못하면 인계가 깨진 것으로 본다.
 */
export function managedKnowledgeOf(root: string, env: Readonly<Record<string, string | undefined>> = process.env, workId?: string): ManagedKnowledge | undefined {
  let id = workId;
  if (id === undefined) {
    try { id = loadActive(root)?.id; } catch { id = undefined; }
  }
  const file = id ? workBindingFile(root, id) : undefined;
  if (file && existsSync(file)) {
    let binding: { knowledge?: unknown };
    try { binding = JSON.parse(readFileSync(file, "utf8")) as { knowledge?: unknown }; } catch {
      return { source: "work", refs: [], digest: "invalid:unreadable", invalid: "binding-unreadable" };
    }
    return knowledgeOf(binding.knowledge, "work");
  }
  return knowledgeOf((masterRun(root, env) as { knowledge?: unknown } | undefined)?.knowledge, "run");
}

/** 지금 작업(또는 이 세션의 master 실행)에 인계된 지식 참조 — 받은 형식 그대로. 검사를 지나지 못한 기록이면 읽을 수 있는 만큼(형식 1 꼴) */
export function managedKnowledge(root: string, env: Readonly<Record<string, string | undefined>> = process.env): KnowledgeHandoff | undefined {
  const found = managedKnowledgeOf(root, env);
  if (!found) return undefined;
  if (found.handoff) return found.handoff;
  return found.refs.length > 0 ? { version: 1, refs: found.refs } : undefined;
}
