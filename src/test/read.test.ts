import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readProjectFile } from "../agent/read";

test("호스트 파일 읽기는 줄 범위를 보존하고 잘못된 범위·바이너리·큰 파일을 거부한다", () => {
  const root = mkdtempSync(join(tmpdir(), "ca-read-"));
  try {
    writeFileSync(join(root, "a.txt"), "하나\r\n둘\r\n셋\n");
    assert.deepEqual(JSON.parse(readProjectFile(root, "a.txt", 2, 1)), {path:"a.txt",totalLines:4,start:2,lines:[{line:2,text:"둘"}]});
    for (const start of [0, -1, 1.5, NaN]) assert.throws(() => readProjectFile(root, "a.txt", start), /사용법/);
    assert.throws(() => readProjectFile(root, "a.txt", 1, 401), /사용법/);
    writeFileSync(join(root, "binary"), "a\0b");
    assert.throws(() => readProjectFile(root, "binary"), /바이너리/);
    writeFileSync(join(root, "large"), Buffer.alloc(1_000_001));
    assert.throws(() => readProjectFile(root, "large"), /1 MB/);
    assert.throws(() => readProjectFile(root, "."), /일반 텍스트/);
  } finally { rmSync(root, {recursive:true,force:true}); }
});

test("호스트 파일 읽기는 상대·절대 경로와 연결 디렉터리를 통한 저장소 밖 접근을 거부한다", () => {
  const parent = mkdtempSync(join(tmpdir(), "ca-read-")), root = join(parent, "repo"), outside = join(parent, "outside");
  try {
    mkdirSync(root); mkdirSync(outside);
    writeFileSync(join(outside, "data.txt"), "outside");
    symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    for (const file of ["../outside/data.txt", join(outside, "data.txt"), "linked/data.txt"]) assert.throws(() => readProjectFile(root, file), /저장소 안/);
  } finally { rmSync(parent, {recursive:true,force:true}); }
});
