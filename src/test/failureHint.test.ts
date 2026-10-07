/**
 * 원천이 `다음:` 에 닿지 않는 실패의 안내(failureHint.ts, 재시도 규약 §7.4).
 *
 * 관찰 흐름 analysis~plan 의 배정 실패·고아는 원인 이름표 + `planning advance` 로 이끄는 한 줄, deliver 의 동의 실패는 그 원인의
 * guidance 다. 검증·리뷰·교차 원인은 원인을 판정한 모듈의 문구가 `다음:` 에 실리므로 이 모듈은 관여하지 않는다.
 */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { status } from "../agent/commands";
import { failureHint } from "../agent/failureHint";
import { loadActive, saveActive, STAGES_LOG } from "../agent/layout";
import { GUIDE_KEYS } from "../agent/retryPolicy";
import { verificationFlowFile } from "../agent/verificationFlow";
import { loadWork } from "../agent/work";
import { start } from "./confirmedStart";
import { createStageRepo, DESIGN, removeStageRepo, repo, toCheck, write } from "./stageFixture";

const SPEC = "doc/work/ORD-1.md";
const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const nextLine = (): string => status(repo).split("\n").find((line) => line.startsWith("다음: ")) ?? "";

function planning(tasks: unknown[], extra: Record<string, unknown> = {}): void {
  write(".code-agent/work/ORD-1/order.planning.json", JSON.stringify({ version: 1, id: "ORD-1", target: "order", maxParallel: 3, tasks, agents: [], ...extra }));
}
const attempt = (over: Record<string, unknown>) => ({ dispatchId: randomUUID(), inputHash: "h", at: ago(0), status: "running", ...over });
function observed(phase: "analysis" | "impact" | "design" | "plan"): void {
  start(repo, join(repo, SPEC), { planning: true });
  saveActive(repo, { ...loadActive(repo)!, phase });
}
function consent(over: Record<string, unknown>): void {
  const id = randomUUID();
  write(`.code-agent/consents/${id}.json`, JSON.stringify({ id, action: { action: "deliver" }, status: "failed", createdAt: ago(-1000), ...over }));
}

beforeEach(() => createStageRepo("ca-failure-"));
afterEach(() => removeStageRepo());

describe("관찰 흐름의 배정 실패·고아", () => {
  test("시작이 관찰되지 않은 채 기한을 넘긴 배정은 planning advance 로 이끈다", () => {
    observed("plan");
    planning([{ task: { id: "critic", role: "critic" }, attempts: [attempt({ at: ago(15 * MIN) })] }]);
    assert.match(nextLine(), /^다음: \[배정 식별 불일치·고아 실행\] 배정 critic 이\(가\) 실행 중으로 기록된 지 15분입니다 — 기다리지 말고 code-agent planning advance 의 안내/);
    planning([{ task: { id: "critic", role: "critic" }, attempts: [attempt({ at: ago(3 * MIN) })] }]);
    assert.match(nextLine(), /code-agent planning advance 로 계획·검토 담당을 배정하고/, "아직 기한 전이면 기본 문구");
  });

  test("기록된 실패는 원인 이름표와 첫 줄만 — 남은 횟수는 쓰지 않는다. 다른 단계 작업은 보지 않는다", () => {
    observed("design");
    planning([
      { task: { id: "design", role: "design" }, attempts: [attempt({ status: "failed", failure: { class: "agent-content-error", at: ago(2 * MIN), detail: "출력 문서 03-design.md 의 '## 경계' 절이 비어 있습니다\n둘째 줄" } })] },
      { task: { id: "analysis", role: "analysis" }, attempts: [attempt({ status: "failed", failure: { class: "agent-format-error", at: ago(0), detail: "앞 단계" } })] },
    ]);
    const line = nextLine();
    assert.match(line, /^다음: \[담당 결과 내용 오류\] 배정 design: 출력 문서 03-design\.md 의 '## 경계' 절이 비어 있습니다 — code-agent planning advance 가 다음 처리/);
    assert.doesNotMatch(line, /둘째 줄|앞 단계|\d+회/);
    planning([{ task: { id: "design", role: "design" }, attempts: [attempt({ status: "failed", error: "옛 시도" })] }]);
    assert.match(nextLine(), /code-agent planning advance 로 담당을 배정하고/, "failure 없는 옛 시도는 advance 가 추정한다");
  });

  test("교차 원인은 다루지 않는다 — 이전 critic 배정의 교차 실패·리뷰 단계는 안내하지 않는다", () => {
    observed("plan");
    planning([], { crossAttempts: [{ n: 1, host: "codex", mode: "review", criticDispatchId: "old", startedAt: ago(5 * MIN), endedAt: ago(4 * MIN), class: "cross-config-error", detail: "unknown option" }] });
    assert.equal(failureHint(loadWork(repo)!), undefined);
    assert.doesNotMatch(nextLine(), /설정 오류|unknown option/);
    saveActive(repo, { ...loadActive(repo)!, phase: "review" });
    assert.equal(failureHint(loadWork(repo)!), undefined);
  });
});

describe("deliver 동의 실패", () => {
  beforeEach(() => {
    toCheck();
    saveActive(repo, { ...loadActive(repo)!, phase: "deliver" }, "next");
  });

  test("deliver 진입 뒤의 마지막 deliver 동의가 failed 면 그 원인의 안내를 detail 로 렌더한다", () => {
    // 같은 폴더의 색인·캐시·티켓·잠금(깨진 JSON 포함)은 읽지 않는다
    write(".code-agent/consents/index.json", "{broken");
    write(".code-agent/consents/snapshot-cache.json", "{broken");
    write(".code-agent/consents/tickets/prepare.json", "{}");
    write(".code-agent/consents/apply.lock", "{}");
    consent({ failure: { class: "consent-apply-failed", kind: "apply", at: ago(0), detail: "git commit 이 실패했습니다" } });
    const line = nextLine();
    assert.match(line, /^다음: \[동의 적용 중단·실패\] 적용이 중단\(실패\)됐습니다 — 일부만 반영됐을 수 있습니다: git commit 이 실패했습니다\. code-agent status 와 git status/);
    assert.doesNotMatch(line, /\{/);
  });

  test("deliver 진입 전의 실패·진입 기록이 없을 때는 기본 문구다", () => {
    consent({ createdAt: ago(10 * MIN), failure: { class: "consent-target-changed", kind: "target", at: ago(10 * MIN), detail: "대상이 바뀌었습니다" } });
    assert.match(nextLine(), /^다음: 현재 호스트 세션에서 ca-answer의 deliver 동의 절차로/);
    consent({ failure: { class: "consent-target-changed", kind: "target", at: ago(0), detail: "대상이 바뀌었습니다" } });
    assert.match(nextLine(), /^다음: \[동의 대상 변경·취소\] 이 동의는 쓸 수 없습니다: 대상이 바뀌었습니다/);
    rmSync(join(repo, STAGES_LOG));
    assert.match(nextLine(), /^다음: 현재 호스트 세션에서 ca-answer의 deliver 동의 절차로/, "집계 로그가 없으면 안내하지 않는다");
  });

  test("미응답 질문·승인 무효가 먼저다", () => {
    consent({ failure: { class: "consent-apply-failed", kind: "apply", at: ago(0), detail: "중단" } });
    write("doc/work/ORD-1/03-design.md", `${DESIGN}\n- 추가 결정\n`);
    assert.match(nextLine(), /^다음: 승인 무효\(stale-docs/);
    write("doc/work/ORD-1/questions.md", "## Q1 · 반영\n무엇을 더 볼까?\n[Answer]:\n");
    assert.match(nextLine(), /^다음: 답이 없거나 출처를 확인할 수 없는 질문 1개 — \/ca-answer/);
  });
});

describe("값 키 계약·검증 단계", () => {
  test("동의 두 원인의 안내 값 키는 detail 하나다", () => {
    assert.deepEqual(GUIDE_KEYS["consent-target-changed"], ["detail"]);
    assert.deepEqual(GUIDE_KEYS["consent-apply-failed"], ["detail"]);
  });

  test("check 에서는 관여하지 않는다 — verify 기록의 실패가 있어도 증거 기반 문구 그대로", () => {
    toCheck();
    const before = nextLine();
    const file = verificationFlowFile(loadWork(repo)!);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, id: "ORD-1", target: "order", attempts: [{ at: ago(0), input: {}, events: [],
      result: { node: "decision", failure: { class: "limit-exceeded", at: ago(0), detail: "x" } } }] }));
    assert.equal(failureHint(loadWork(repo)!), undefined);
    assert.equal(nextLine(), before);
  });
});
