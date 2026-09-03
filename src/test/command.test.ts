/**
 * 검증 명령의 실행 파일 해석 — Windows 에서도 돌아야 한다.
 *
 * Node 의 spawnSync 는 셸 없이는 PATH 에서 `.exe` 만 찾고, `.cmd`/`.bat` 은 전체 경로를 줘도
 * EINVAL 로 거절한다(CVE-2024-27980 이후). 그래서 `npm`·`gradlew` 가 둘 다 안 돌았다.
 * 여기서 보는 것은 셋이다 — PATH 에서 찾는가, 공백 든 인자가 갈라지지 않는가, 종료 코드가 오는가.
 */
import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { runCommand } from "../core/build";

const win = process.platform === "win32";

let root: string;
let bin: string;
let env: NodeJS.ProcessEnv;

/** 인자를 그대로 찍고 3 으로 끝나는 명령 — 플랫폼에 맞는 옷을 입힌다 */
function installEcho(dir: string, name: string) {
  if (win) {
    writeFileSync(join(dir, `${name}.cmd`), "@echo off\r\necho %1 %2\r\nexit /b 3\r\n");
  } else {
    const path = join(dir, name);
    writeFileSync(path, '#!/bin/sh\necho "$1" "$2"\nexit 3\n');
    chmodSync(path, 0o755);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-cmd-"));
  bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "work"));
  env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("PATH 에 있는 명령을 찾아 돌린다 — 공백 든 인자와 종료 코드가 그대로 온다", () => {
  installEcho(bin, "fake-runner");

  const done = runCommand(join(root, "work"), ["fake-runner", "a b", "c"], env);

  assert.equal(done.error, undefined);
  assert.equal(done.status, 3, "종료 코드가 전달되어야 한다");
  assert.match(done.stdout, /a b/, "공백 든 인자가 갈라지면 안 된다");
  assert.match(done.stdout, /c/);
});

test("저장소 안의 래퍼가 PATH 보다 먼저다", () => {
  // PATH 에도 같은 이름이 있지만, worktree 안의 것이 프로젝트가 고정한 버전이다.
  installEcho(bin, "gradlew");
  if (win) {
    writeFileSync(join(root, "work", "gradlew.bat"), "@echo off\r\necho local %1\r\nexit /b 0\r\n");
  } else {
    writeFileSync(join(root, "work", "gradlew"), '#!/bin/sh\necho local "$1"\nexit 0\n');
    chmodSync(join(root, "work", "gradlew"), 0o755);
  }

  const done = runCommand(join(root, "work"), ["gradlew", "build"], env);

  assert.equal(done.status, 0);
  assert.match(done.stdout, /local build/);
});

test(
  "Windows 는 확장자 없는 파일을 건너뛰고 .cmd 를 고른다 — nodejs 의 npm 과 npm.cmd 가 그렇다",
  { skip: !win },
  () => {
    installEcho(bin, "fake-runner");
    // 같은 이름의 POSIX 스크립트. Windows 가 실행할 수 없는데 먼저 집으면 ENOENT 로 죽는다.
    writeFileSync(join(bin, "fake-runner"), "#!/bin/sh\necho posix\n");

    const done = runCommand(join(root, "work"), ["fake-runner", "x"], env);

    assert.equal(done.error, undefined);
    assert.equal(done.status, 3);
    assert.match(done.stdout, /x/);
  },
);

test("어디에도 없는 명령은 실행 오류다 — 실패로 읽히지 않는다", () => {
  const done = runCommand(join(root, "work"), ["code-agent-no-such-command-xyz", "x"], env);

  assert.ok(done.error, "찾지 못한 것은 error 로 알린다");
  assert.match(done.error!.message, /code-agent-no-such-command-xyz/);
  assert.match(done.error!.message, /PATH/);
});
