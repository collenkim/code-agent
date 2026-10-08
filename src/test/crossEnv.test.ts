/**
 * 실행 환경 표지(crossEnv.ts) — 지금 호스트 판별과 교차 실행 자식.
 *
 * 판별 함수는 runtimeHost 하나다. 두 호스트 표지가 함께 보이거나 하나도 없으면 판별하지 않고(undefined),
 * 표기 전용 값 CODE_AGENT_HOST 는 보지 않는다.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAUDE_SESSION_ENV, CODEX_MARKERS, CROSS_CHILD_ENV, crossChild, crossChildEnv, hostMarked, otherHost, runtimeHost, sandboxMarkers,
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

test("H10 교차 자식 환경 — 부른 Claude 세션에 묶인 값(메시지 통로·세션 id·자식 세션·pid·추론 강도·사람 응대 표지)을 지운다", () => {
  const base = { CLAUDECODE: "1", CLAUDE_CODE_MESSAGING_SOCKET: "pipe-x", CLAUDE_CODE_MESSAGING_TOKEN: "t", CLAUDE_CODE_SESSION_ID: "s",
    CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_PID: "42", CLAUDE_EFFORT: "max", CLAUDE_CODE_SESSION_ATTENDED: "1",
    CLAUDE_CODE_EXECPATH: "c:/claude.exe", AI_AGENT: "claude-code", PATH: "p" };
  assert.deepEqual([...CLAUDE_SESSION_ENV].sort(), ["CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_SESSION_ID", "CLAUDE_EFFORT", "CLAUDE_PID"]);
  for (const host of ["claude", "codex"] as const) {
    const env = crossChildEnv(base, host);
    for (const key of CLAUDE_SESSION_ENV) assert.equal(env[key], undefined, `${host} ${key}`);
    assert.equal(env.CLAUDE_CODE_EXECPATH, "c:/claude.exe", "세션에 묶이지 않은 값은 남긴다");
    assert.equal(env.AI_AGENT, "claude-code");
    assert.equal(env.PATH, "p");
    assert.equal(env[CROSS_CHILD_ENV], host);
  }
  assert.equal(base.CLAUDE_CODE_MESSAGING_TOKEN, "t", "원본은 바꾸지 않는다");
  assert.equal(base.CLAUDE_EFFORT, "max");
});
