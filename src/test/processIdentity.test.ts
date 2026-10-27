import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { mock, test } from "node:test";
import { ownProcessIdentity } from "../agent/processIdentity";

test("OS 시작 식별 조회 실패는 다음 잠금에서 다시 확인하고 성공한 식별값만 보존한다", () => {
  const unavailable = (): never => { throw new Error("temporary OS query failure"); };
  const processRead = mock.method(childProcess, "execFileSync", unavailable);
  const fileRead = mock.method(fs, "readFileSync", unavailable);
  try { assert.equal(ownProcessIdentity(), undefined); }
  finally { processRead.mock.restore(); fileRead.mock.restore(); }
  const started = ownProcessIdentity();
  assert.ok(started, "OS가 자기 프로세스 시작을 확인해야 한다");
  const noProcess = mock.method(childProcess, "execFileSync", unavailable);
  const noFile = mock.method(fs, "readFileSync", unavailable);
  try { assert.equal(ownProcessIdentity(), started); }
  finally { noProcess.mock.restore(); noFile.mock.restore(); }
});
