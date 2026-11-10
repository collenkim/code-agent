import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { commitNote, docReader, headingAt, parseSectionRef, safeDocPath, statusLabel, verifySectionRef } from "../agent/knowledgeRefs";
import type { DocReader, DocSectionRef } from "../agent/knowledgeRefs";

/**
 * 출처 참조 검증(knowledgeRefs.ts) — 형식 검사, 읽는 경로의 경계, 내용 해시로 확인한 범위(exact·moved), 상태 표시의 비승격.
 * 파일은 가짜 읽기 함수로 준다 — 어느 경로를 읽었는지 센다.
 */

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const HEAD = "1".repeat(40);

const DOC = [
  "# 아키텍처", // 1
  "## 저장소", // 2
  "주문은 PostgreSQL", // 3
  "## 저장소", // 4
  "세션은 Redis", // 5
  "## 캐시", // 6
  "- 같은 규칙", // 7
  "## 캐시", // 8
  "- 같은 규칙", // 9
  "## 배치", // 10
  "- 하나", // 11
  "- 둘", // 12
  "- 셋", // 13
];

function ref(lines: string[], start: number, end: number, extra: Partial<DocSectionRef> = {}, path = "doc/architecture.md"): DocSectionRef {
  return {
    engine: "agent-knowledge",
    itemId: `src:${path}#a${start}`,
    projectId: "p",
    sourceId: "src",
    generation: 2,
    commit: HEAD,
    blobSha: "a".repeat(40),
    documentSha256: "b".repeat(64),
    itemSha256: sha(lines.slice(start - 1, end).join("\n")),
    startLine: start,
    endLine: end,
    unit: "section",
    kind: "architecture",
    status: "confirmed_policy",
    confirmed: true,
    declaredStatus: "confirmed_policy",
    ...extra,
  };
}

/** 가짜 읽기 — 읽은 경로를 남긴다 */
function reader(files: Record<string, string[]>): DocReader & { reads: string[] } {
  const reads: string[] = [];
  const read = ((path: string) => {
    reads.push(path);
    return files[path];
  }) as DocReader & { reads: string[] };
  read.reads = reads;
  return read;
}

const DOCS = new Set(["doc/architecture.md"]);

test("parseSectionRef: 계약 꼴만 받는다 — 모르는 키·대문자 16진·정수 아님·0 세대·뒤집힌 범위·모르는 상태는 거부", () => {
  const good = ref(DOC, 2, 3);
  assert.deepEqual(parseSectionRef(good), good);
  assert.deepEqual(parseSectionRef({ ...good, reason: "basis-resolved", pinned: true }), { ...good, reason: "basis-resolved", pinned: true });
  assert.equal(parseSectionRef({ ...good, declaredStatus: null })?.declaredStatus, null);
  const bad: unknown[] = [
    { ...good, extra: 1 },
    { ...good, commit: "A".repeat(40) },
    { ...good, blobSha: "a".repeat(39) },
    { ...good, itemSha256: "f".repeat(63) },
    { ...good, documentSha256: "g".repeat(64) },
    { ...good, generation: 0 },
    { ...good, generation: 1.5 },
    { ...good, startLine: 0 },
    { ...good, startLine: 4, endLine: 3 },
    { ...good, unit: "chunk" },
    { ...good, status: "confirmed" },
    { ...good, engine: "other" },
    { ...good, itemId: "" },
    { ...good, confirmed: "yes" },
    "text",
    null,
  ];
  for (const value of bad) assert.equal(parseSectionRef(value), undefined, JSON.stringify(value));
});

test("safeDocPath: 상대 경로만 — 역슬래시·절대·드라이브·.. · . · 빈 구성요소는 아니다", () => {
  assert.equal(safeDocPath("doc/architecture.md"), true);
  for (const path of ["", "../outside.md", "doc/../x.md", "doc\\architecture.md", "/etc/passwd", "C:/x.md", "c:x.md", "./doc/a.md", "doc//a.md", "doc/a.md/"]) {
    assert.equal(safeDocPath(path), false, path);
  }
});

test("verify: 적힌 범위의 해시가 맞으면 exact — 같은 제목이 둘이어도 해시가 고른다", () => {
  const read = reader({ "doc/architecture.md": DOC });
  const second = verifySectionRef({ path: "doc/architecture.md", ref: ref(DOC, 4, 5) }, DOCS, read);
  assert.deepEqual(second.ok && { start: second.start, end: second.end, how: second.how }, { start: 4, end: 5, how: "exact" });
});

test("verify: 줄이 옮겨 가면 제목 줄에서 시작하는 같은 길이 창 중 해시가 맞는 한 곳으로 옮긴다(moved)", () => {
  const moved = ["# 아키텍처", "## 새 절", "- 앞에 끼운 줄", ...DOC.slice(1)];
  const read = reader({ "doc/architecture.md": moved });
  // 원래 4-5 의 Redis 절 — 지금은 6-7, 같은 제목의 PostgreSQL 절(4-5)은 해시가 달라 고르지 않는다
  const found = verifySectionRef({ path: "doc/architecture.md", ref: ref(DOC, 4, 5) }, DOCS, read);
  assert.deepEqual(found.ok && { start: found.start, end: found.end, how: found.how }, { start: 6, end: 7, how: "moved" });
});

test("verify: 같은 내용이 둘이면 ambiguous, 아무 데도 없으면 content-changed, 본문 한가운데 덩어리는 옮겨 찾지 않는다", () => {
  const moved = ["# 아키텍처", "## 새 절", "- 앞에 끼운 줄", ...DOC.slice(1)];
  const read = reader({ "doc/architecture.md": moved });
  const cache = verifySectionRef({ path: "doc/architecture.md", ref: ref(DOC, 6, 7) }, DOCS, read);
  assert.deepEqual(!cache.ok && cache.reason, "ambiguous");
  const changed = DOC.map((line) => (line === "세션은 Redis" ? "세션은 Memcached" : line));
  const gone = verifySectionRef({ path: "doc/architecture.md", ref: ref(DOC, 4, 5) }, DOCS, reader({ "doc/architecture.md": changed }));
  assert.deepEqual(!gone.ok && gone.reason, "content-changed");
  // 제목 줄이 아닌 자리에서 시작하는 범위(긴 절의 분할 덩어리)는 옮겨 찾지 않는다 — 같은 글이 그대로 있어도 줄이 바뀌면 거부
  const chunk = verifySectionRef({ path: "doc/architecture.md", ref: ref(DOC, 11, 12) }, DOCS, read);
  assert.deepEqual(!chunk.ok && chunk.reason, "content-changed");
});

test("verify: 문서 단위 항목은 exact 만 — 옮겨 찾지 않는다", () => {
  const whole = ref(DOC, 1, DOC.length, { unit: "document" });
  assert.equal(verifySectionRef({ path: "doc/architecture.md", ref: whole }, DOCS, reader({ "doc/architecture.md": DOC })).ok, true);
  const shifted = ["", ...DOC];
  const found = verifySectionRef({ path: "doc/architecture.md", ref: { ...whole, startLine: 1, endLine: DOC.length } }, DOCS, reader({ "doc/architecture.md": shifted }));
  assert.deepEqual(!found.ok && found.reason, "content-changed");
});

test("verify: 입력 문서 밖·.. ·역슬래시·절대 경로는 읽지 않고 not-in-docs, 없는 파일은 missing-file, 깨진 참조는 invalid-ref", () => {
  const read = reader({ "doc/architecture.md": DOC, "src/secret.ts": ["x"] });
  for (const path of ["src/secret.ts", "../outside.md", "doc\\architecture.md", "/etc/passwd", "C:/Windows/win.ini"]) {
    const found = verifySectionRef({ path, ref: ref(DOC, 2, 3, {}, path) }, new Set([...DOCS, "doc\\architecture.md", "/etc/passwd", "../outside.md"]), read);
    assert.deepEqual(!found.ok && found.reason, "not-in-docs", path);
  }
  assert.deepEqual(read.reads, [], "경계 밖 경로는 한 번도 열지 않는다");
  const missing = verifySectionRef({ path: "doc/gone.md", ref: ref(DOC, 2, 3, {}, "doc/gone.md") }, new Set(["doc/gone.md"]), read);
  assert.deepEqual(!missing.ok && missing.reason, "missing-file");
  // itemId 가 다른 문서를 가리키면 그 해시를 이 문서의 범위로 쓰지 않는다
  const other = verifySectionRef({ path: "doc/architecture.md", ref: { ...ref(DOC, 2, 3), itemId: "src:doc/other.md#a" } }, DOCS, read);
  assert.deepEqual(!other.ok && [other.reason, other.itemId], ["invalid-ref", "src:doc/other.md#a"]);
  const broken = verifySectionRef({ path: "doc/architecture.md", ref: { itemId: "x", engine: "agent-knowledge" } }, DOCS, read);
  assert.deepEqual(!broken.ok && [broken.reason, broken.itemId], ["invalid-ref", "x"]);
  const absent = verifySectionRef({ path: "doc/architecture.md" }, DOCS, read);
  assert.deepEqual(!absent.ok && absent.reason, "invalid-ref");
});

test("docReader: BOM 을 떼고 CRLF·LF 를 같은 줄로 읽는다 — 해시가 같은 범위를 확인한다", () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-kref-")));
  try {
    writeFileSync(join(dir, "crlf.md"), `\uFEFF${DOC.join("\r\n")}\r\n`);
    const read = docReader(dir);
    const found = verifySectionRef({ path: "crlf.md", ref: ref(DOC, 1, 3, {}, "crlf.md") }, new Set(["crlf.md"]), read);
    assert.deepEqual(found.ok && [found.start, found.end, found.how], [1, 3, "exact"]);
    assert.equal(read("missing.md"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("statusLabel: 확정은 confirmed 일 때만, 관찰·충돌·폐기는 confirmed 와 관계없이 그 이름 — 올리지 않는다", () => {
  const unverified = "미확인 — 탐색 참고, 확정 근거 아님";
  assert.equal(statusLabel({ status: "confirmed_policy", confirmed: true }), "확정 정책");
  assert.equal(statusLabel({ status: "confirmed_policy", confirmed: false }), unverified);
  assert.equal(statusLabel({ status: "verified_experience", confirmed: true }), "검증된 경험");
  assert.equal(statusLabel({ status: "verified_experience", confirmed: false }), unverified);
  assert.equal(statusLabel({ status: "observed_behavior", confirmed: true }), "관찰 — 현재 동작, 정책 아님");
  assert.equal(statusLabel({ status: "unverified", confirmed: true }), unverified);
  assert.equal(statusLabel({ status: "conflicted", confirmed: true }), "충돌 — 확인 필요");
  assert.equal(statusLabel({ status: "deprecated", confirmed: true }), "폐기 — 쓰지 않는다");
});

test("commitNote: 기준 커밋이 HEAD 와 다르거나 옮겨 찾았을 때만 적는다 · headingAt: 시작 줄이나 바로 위 제목", () => {
  const base = ref(DOC, 2, 3);
  assert.equal(commitNote({ ref: base, how: "exact" }, HEAD), undefined);
  assert.equal(commitNote({ ref: base, how: "moved" }, HEAD), "기준 커밋 1111111 — 현재 파일과 일치 확인");
  assert.equal(commitNote({ ref: { ...base, commit: "abcdef0".padEnd(40, "0") }, how: "exact" }, HEAD), "기준 커밋 abcdef0 — 현재 파일과 일치 확인");
  assert.equal(commitNote({ ref: base, how: "exact" }, undefined), "기준 커밋 1111111 — 현재 파일과 일치 확인");
  assert.equal(headingAt(DOC, 12), "## 배치");
  assert.equal(headingAt(DOC, 10), "## 배치");
  assert.equal(headingAt(["본문만", "둘"], 2), undefined);
});
