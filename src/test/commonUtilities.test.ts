import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalJson, canonicalJson, sha256, shortHash } from "../core/serialize";
import { readOptionalText, readTrimmedText } from "../core/text";
import { samePath } from "../agent/layout";

test("공통 직렬화는 기존 승인·상태 해시의 바이트 규약을 유지한다", () => {
  const value = { z: [undefined, { b: 2, a: 1 }], absent: undefined, a: null };
  assert.equal(approvalJson(value), '{"a":null,"z":[null,{"a":1,"b":2}]}');
  assert.equal(canonicalJson(value), '{"a":null,"z":[,{"a":1,"b":2}]}');
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(shortHash("abc"), "sha256:ba7816bf8f01cfea");
});

test("선택 문서 읽기는 원문·줄바꿈 정규화·공백 제거의 차이를 보존한다", () => {
  const root = mkdtempSync(join(tmpdir(), "ca-common-text-"));
  try {
    const file = join(root, "doc.md");
    writeFileSync(file, "  가\r\n나\r\n  ");
    assert.equal(readOptionalText(file), "  가\r\n나\r\n  ");
    assert.equal(readOptionalText(file, true), "  가\n나\n  ");
    assert.equal(readTrimmedText(file), "가\r\n나");
    assert.equal(readOptionalText(join(root, "missing")), undefined);
    assert.equal(readTrimmedText(join(root, "missing")), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("경로 비교는 실제 부모·없는 꼬리·링크를 대조하고 플랫폼의 대소문자 규칙을 따른다", () => {
  const root = mkdtempSync(join(tmpdir(), "ca-common-path-"));
  try {
    const actual = join(root, "Actual"), alias = join(root, "alias");
    mkdirSync(actual);
    symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
    assert.equal(samePath(join(actual, "missing", "file"), join(alias, "missing", "file")), true);
    assert.equal(samePath(join(actual, "x"), join(alias, "y")), false);
    assert.equal(samePath(actual, actual.toUpperCase()), process.platform === "win32");
    assert.equal(samePath(undefined, actual), false);
    assert.equal(samePath("", actual), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
