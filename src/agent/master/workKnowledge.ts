/**
 * master 가 인계한 지식 항목 참조의 적용 범위 — `managedExecution`(workExecution.ts)과 같은 순서로 찾는다: 지금 작업이 master 실행이
 * 연 작업이면 그 작업에 고정된 참조, 작업을 열기 전이면 이 세션의 master 실행이 받은 참조. 둘 다 없으면 인계가 없는 것이다.
 *
 * 기록은 code-agent 만 쓰는 `.code-agent/master/` 에 있지만 읽을 때 모양을 다시 거른다 — 형식 검사(인계 때 `knowledgeHandoffOf`)를
 * 거치지 않은 값이 문맥에 들어가지 않게. 내용(해시·세대·범위)의 대조는 context 를 만들 때 어댑터와 knowledgeRefs.ts 가 한다.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { loadActive, STATE_DIR } from "../layout";
import type { KnowledgeHandoff, KnowledgeRef } from "../plugins/protocol";
import { masterRun } from "./runGuard";

function refsOf(value: unknown): KnowledgeHandoff | undefined {
  const handoff = value as { version?: unknown; refs?: unknown } | undefined;
  if (!handoff || handoff.version !== 1 || !Array.isArray(handoff.refs)) return undefined;
  const refs: KnowledgeRef[] = [];
  for (const raw of handoff.refs as unknown[]) {
    const ref = raw as Partial<KnowledgeRef> | null;
    // 모양이 어긋난 참조는 버리지 않고 그대로 실패로 보이게 남긴다 — 인계가 있었는데 조용히 사라지면 근거 재확인 신호도 사라진다
    refs.push({
      itemId: typeof ref?.itemId === "string" ? ref.itemId : "",
      generation: typeof ref?.generation === "number" ? ref.generation : 0,
      commit: typeof ref?.commit === "string" ? ref.commit : "",
      itemSha256: typeof ref?.itemSha256 === "string" ? ref.itemSha256 : "",
      required: ref?.required !== false,
    });
  }
  return refs.length > 0 ? { version: 1, refs } : undefined;
}

/** 이 저장소의 지금 작업(또는 이 세션의 master 실행)에 master 가 인계한 지식 참조 — 없으면 undefined */
export function managedKnowledge(root: string, env: Readonly<Record<string, string | undefined>> = process.env): KnowledgeHandoff | undefined {
  let workId: string | undefined;
  try { workId = loadActive(root)?.id; } catch { workId = undefined; }
  const file = workId ? join(root, STATE_DIR, "master", "works", `${encodeURIComponent(workId)}.json`) : undefined;
  // master 실행이 연 작업이면 그 작업의 기록이 정본이다 — 참조 없이 연 작업에는 인계가 없다
  if (file && existsSync(file)) {
    try { return refsOf((JSON.parse(readFileSync(file, "utf8")) as { knowledge?: unknown }).knowledge); } catch { return undefined; }
  }
  return refsOf((masterRun(root, env) as { knowledge?: unknown } | undefined)?.knowledge);
}
