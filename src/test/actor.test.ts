import assert from "node:assert/strict";
import { test } from "node:test";
import { actorName } from "../agent/actor";

test("원장 표시 이름은 OS 조회 실패에도 환경값 또는 미확인 표기로 남긴다", () => {
  const denied = () => { throw Object.assign(new Error("uv_os_get_passwd"), { code: "ERR_SYSTEM_ERROR" }); };
  assert.equal(actorName(() => ({ username: "os-user" }), { USERNAME: "env-user" }), "os-user");
  assert.equal(actorName(denied, { USERNAME: "win-user" }), "win-user");
  assert.equal(actorName(denied, { USER: "unix-user" }), "unix-user");
  assert.equal(actorName(denied, {}), "사용자 이름 확인 불가");
});
