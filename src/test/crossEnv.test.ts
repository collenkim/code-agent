/**
 * 실행 환경 표지(crossEnv.ts) — 지금 호스트 판별과 교차 실행 자식.
 *
 * 판별 함수는 runtimeHost 하나다. 두 호스트 표지가 함께 보이거나 하나도 없으면 판별하지 않고(undefined),
 * 표기 전용 값 CODE_AGENT_HOST 는 보지 않는다.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODEX_MARKERS, CROSS_CHILD_ENV, crossChild, crossChildEnv, hostMarked, otherHost, runtimeHost, sandboxMarkers,
} from "../agent/crossEnv";

test("runtimeHost — Claude·Codex 표지 하나만 보일 때만 판별한다", () => {
  assert.equal(runtimeHost({ CLAUDECODE: "1" }), "claude");
  assert.equal(runtimeHost({ CLAUDECODE: "0" }), undefined);
  for (const key of CODEX_MARKERS) assert.equal(runtimeHost({ [key]: "x" }), "codex", key);
  assert.equal(runtimeHost({ CODEX_CI: "1" }), "codex");
  assert.equal(runtimeHost({ CLAUDECODE: "1", CODEX_CI: "1" }), undefined, "두 표지가 함께 보이면 판별하지 않는다");
  assert.equal(runtimeHost({}), undefined);
  assert.equal(runtimeHost({ CODE_AGENT_HOST: "codex" }), undefined, "표기 전용 값은 판별에 쓰지 않는다");
  assert.equal(runtimeHost({ CODE_AGENT_HOST: "claude", CODEX_THREAD_ID: "t" }), "codex");
});

test("교차 자식·샌드박스·호스트 표지", () => {
  assert.equal(CROSS_CHILD_ENV, "CODE_AGENT_CROSS");
  assert.equal(crossChild({ CODE_AGENT_CROSS: "codex" }), true);
  assert.equal(crossChild({ CODE_AGENT_CROSS: "" }), false);
  assert.equal(crossChild({}), false);
  assert.equal(sandboxMarkers({ CODEX_SANDBOX: "seatbelt" }), true);
  assert.equal(sandboxMarkers({ CODEX_SANDBOX_NETWORK_DISABLED: "1" }), true);
  assert.equal(sandboxMarkers({ CODEX_SANDBOX_NETWORK_DISABLED: "0", CODEX_CI: "1" }), false);
  assert.equal(hostMarked({ CLAUDECODE: "1" }), true);
  assert.equal(hostMarked({ CODEX_THREAD_ID: "t" }), true);
  assert.equal(hostMarked({ CODE_AGENT_HOST: "claude" }), false, "사람의 터미널");
  assert.equal(otherHost("claude"), "codex");
  assert.equal(otherHost("codex"), "claude");
});

test("교차 자식 환경은 부른 쪽 호스트 표지를 지우고 자식 표지를 넣는다 — 원본은 그대로", () => {
  const base = { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", NODE_TEST_CONTEXT: "child", PATH: "p" };
  const env = crossChildEnv(base, "codex");
  assert.deepEqual(env, { PATH: "p", CODE_AGENT_CROSS: "codex" });
  assert.equal(base.CLAUDECODE, "1");
  assert.equal(crossChild(env), true);
  assert.equal(runtimeHost(env), undefined);
});
