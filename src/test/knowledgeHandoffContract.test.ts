/**
 * 인계 수신 계약 — agent-knowledge 저장소의 공통 계약 사례(`docs/contract/handoff-cases.json`)를 code-agent 의 실제 수신 파서
 * (`knowledgeHandoffOf`·`requireHandoffVersion`)와 인계 해시(`knowledgeDigest`)로 그대로 돌린다. 사례의 `verification` 원인 갈래는 이
 * 빌드의 진행 게이트 원인(`KNOWLEDGE_CAUSES`)과 판정(required 만 막는다)에 대응해야 한다.
 *
 * 사례 파일은 생산자 저장소가 소유한다(읽기만 한다). 위치는 `AGENT_KNOWLEDGE_ROOT` → `C:/IdeaProjects/agent-knowledge` 순이고, 없으면 이
 * 묶음을 건너뛴다. 자리표시(`<index-id>`·`<index-id:other>`·`<handle>`)는 형식에 맞는 고정 값으로 바꾼다 — 생산자 쪽 시험은 실제 DB 값으로
 * 바꾸지만 수신 형식 검사에는 값의 꼴만 중요하다.
 */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";

import { knowledgeCause, KNOWLEDGE_CAUSES } from "../agent/knowledgeGate";
import { knowledgeDigest, knowledgeHandoffOf, requireHandoffVersion } from "../agent/master/protocol";

const ROOT = process.env.AGENT_KNOWLEDGE_ROOT ?? "C:/IdeaProjects/agent-knowledge";
const CASES = resolve(ROOT, "docs", "contract", "handoff-cases.json");
const AVAILABLE = existsSync(CASES);

interface Case {
  id: string;
  receiverVersions: number[];
  knowledge: unknown;
  expect: { accepted: boolean; refs?: unknown[]; digest?: string; code?: string; reason?: string };
  verification?: { refs: { itemId: string; segmentId: string | null; required: boolean; cause: string }[]; progress: "allowed" | "blocked" };
}

const PLACEHOLDERS: Record<string, string> = {
  "<index-id>": "17f75cc6617715a74285ff8903f05ce8",
  "<index-id:other>": "0123456789abcdef0123456789abcdef",
  "<handle>": "ak-69a35f3ff95562488d91",
};
function fill(value: unknown): unknown {
  if (typeof value === "string") return PLACEHOLDERS[value] ?? value;
  if (Array.isArray(value)) return value.map(fill);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fill(entry)]));
  return value;
}

/** 수신 검사 — 꼴(knowledgeHandoffOf)과 지금 받는 형식(requireHandoffVersion). submit 이 같은 순서로 부른다 */
function receive(item: Case): { ok: true; handoff: NonNullable<ReturnType<typeof knowledgeHandoffOf>> } | { ok: false; code?: string; reason?: string } {
  try {
    const handoff = knowledgeHandoffOf(fill(item.knowledge))!;
    requireHandoffVersion(handoff, item.receiverVersions);
    return { ok: true, handoff };
  } catch (error) {
    const failure = error as { code?: string; detail?: { reason?: string } };
    return { ok: false, code: failure.code, reason: failure.detail?.reason };
  }
}

/** 생산자 대조 결과(사례의 원인 갈래)를 이 빌드가 받는 사유 코드 하나로 — 어댑터가 get 형식 2 오류를 옮기는 이름(agentKnowledge.ts getV2Failure) */
const REASON_OF_CAUSE: Record<string, string> = {
  "hash-mismatch": "hash-mismatch", "identity-mismatch": "index-mismatch", expired: "generation-expired", scope: "not-found",
};

describe("인계 수신 계약 — agent-knowledge 공통 사례", { skip: AVAILABLE ? false : `계약 사례가 없습니다: ${CASES}` }, () => {
  const file = AVAILABLE ? (JSON.parse(readFileSync(CASES, "utf-8")) as { schema: string; cases: Case[]; limits: { maxRefs: number; maxBytes: number } }) : undefined;

  test("HC1. 사례 파일의 형식과 상한이 이 빌드의 상한과 같다", () => {
    assert.equal(file!.schema, "agent-knowledge.handoff-cases");
    assert.deepEqual(file!.limits, { maxRefs: 20, maxBytes: 32768 });
    assert.ok(file!.cases.length >= 30, `사례 ${file!.cases.length}개`);
  });

  test("HC2. 수신 사례마다 받음·거절(코드·detail.reason)·정규화한 참조·인계 해시가 사례와 같다", () => {
    const mismatches: string[] = [];
    for (const item of file!.cases) {
      const got = receive(item);
      if (item.expect.accepted) {
        if (!got.ok) { mismatches.push(`${item.id}: 거절함(${got.code}/${got.reason})`); continue; }
        try { assert.deepEqual(got.handoff.refs, fill(item.expect.refs)); } catch { mismatches.push(`${item.id}: 정규화한 참조가 다름 ${JSON.stringify(got.handoff.refs)}`); }
        if (item.expect.digest && knowledgeDigest(got.handoff) !== item.expect.digest) mismatches.push(`${item.id}: 해시 ${knowledgeDigest(got.handoff)} ≠ ${item.expect.digest}`);
      } else if (got.ok) {
        mismatches.push(`${item.id}: 받음(기대 ${item.expect.reason})`);
      } else if (got.code !== item.expect.code || got.reason !== item.expect.reason) {
        mismatches.push(`${item.id}: ${got.code}/${got.reason} ≠ ${item.expect.code}/${item.expect.reason}`);
      }
    }
    assert.deepEqual(mismatches, []);
  });

  test("HC3. 참조 순서가 달라도 같은 인계 해시다", () => {
    for (const item of file!.cases.filter((entry) => entry.expect.accepted)) {
      const got = receive(item);
      assert.ok(got.ok);
      const reversed = knowledgeHandoffOf({ ...(fill(item.knowledge) as Record<string, unknown>), refs: [...((fill(item.knowledge) as { refs: unknown[] }).refs)].reverse() })!;
      assert.equal(knowledgeDigest(reversed), knowledgeDigest(got.handoff), item.id);
    }
  });

  test("HC4. 대조 사례의 원인 갈래는 진행 게이트의 원인과 같고, required 실패만 진행을 막는다", () => {
    for (const item of file!.cases.filter((entry) => entry.verification)) {
      const verification = item.verification!;
      const blocking = verification.refs.filter((ref) => ref.required && ref.cause !== "verified");
      assert.equal(verification.progress, blocking.length > 0 ? "blocked" : "allowed", item.id);
      for (const ref of verification.refs.filter((entry) => entry.cause !== "verified")) {
        assert.ok((KNOWLEDGE_CAUSES as readonly string[]).includes(ref.cause), `${item.id}: 모르는 원인 ${ref.cause}`);
        const reason = REASON_OF_CAUSE[ref.cause];
        assert.ok(reason, `${item.id}: ${ref.cause} 를 옮기는 사유가 없다`);
        assert.equal(knowledgeCause(reason).cause, ref.cause, `${item.id}: ${reason}`);
        assert.equal(knowledgeCause(reason).recovery, "replan", "참조 자체가 지금 근거와 다르면 재계획이다");
      }
    }
  });
});
