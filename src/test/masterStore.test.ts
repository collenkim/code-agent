import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { acquireLock } from "../agent/lock";
import { mutateInteractions } from "../agent/interactions";
import { forwardCodexPermission, shadowingExecutable } from "../agent/master/codexPermissions";
import { hostEnv } from "../agent/master/supervisor";
import { CONTROL_LOCK, emit, ensureMasterDir, masterPath, readCommand, readEvents, writeCommand, type CommandRecord } from "../agent/master/store";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ca-master-store-")); ensureMasterDir(root); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("2-7 제어 잠금이 바쁘면 권한 전달은 다음 조회를 기다린다", () => {
  const release = acquireLock(masterPath(root, CONTROL_LOCK), { waitMs: 0, ageReclaim: false, label: "정지" });
  try { assert.equal(forwardCodexPermission(root, "pending", "connection", () => assert.fail("전달")), false); }
  finally { release(); }
  assert.throws(() => forwardCodexPermission(root, "pending", "connection", () => {}), /찾을 수 없|없습니다/);
});

test("2-7 비Windows도 상대 PATH와 저장소 셸 가림을 거부한다", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    writeFileSync(join(root, "bash"), "");
    assert.equal(shadowingExecutable(root), "bash");
    const keep = join(tmpdir(), "trusted-bin");
    assert.equal(hostEnv({ PATH: [".", "./bin", "node_modules/.bin", root, join(root, "..evil"), keep].join(delimiter) }, "run", "codex", root).PATH, keep);
  } finally { Object.defineProperty(process, "platform", platform); }
});

test("2-7 구분자만 다른 commandId는 각각 재전송 결과를 보존한다", () => {
  const record = (commandId: string) => ({ commandId, result: commandId }) as unknown as CommandRecord;
  writeCommand(root, record("inv:1")); writeCommand(root, record("inv_1"));
  assert.equal(readCommand(root, "inv:1")!.commandId, "inv:1");
  assert.equal(readCommand(root, "inv_1")!.commandId, "inv_1");
});

test("2-7 이벤트 append 뒤 메타 쓰기가 끊겨도 순번과 다음 페이지를 보존한다", () => {
  const first = emit(root, "policy.changed"), meta = readFileSync(masterPath(root, "events-meta.json"), "utf8");
  emit(root, "policy.changed"); writeFileSync(masterPath(root, "events-meta.json"), meta);
  assert.equal(emit(root, "policy.changed").seq, first.seq + 2);
  const page = readEvents(root, 0, first.logId, 2);
  assert.equal(page.hasMore, true);
  assert.equal(readEvents(root, page.events.at(-1)!.seq, first.logId, 2).hasMore, false);
});

test("2-7 이벤트 보관 상한 밖 커서는 gap으로 돌려준다", () => {
  const first = emit(root, "policy.changed");
  writeFileSync(masterPath(root, "events.jsonl"), Array.from({ length: 12000 }, (_, i) => JSON.stringify({ ...first, seq: i + 1 })).join("\n") + "\n");
  assert.equal(emit(root, "policy.changed").seq, 12001);
  const rows = readFileSync(masterPath(root, "events.jsonl"), "utf8").trim().split("\n");
  assert.ok(rows.length <= 10000);
  assert.equal(readEvents(root, 0, first.logId, 100).gap, true);
  assert.equal(readEvents(root, 12000, first.logId, 100).events[0].seq, 12001);
});

test("2-7 질문 원장 조회만으로 파일을 다시 쓰지 않는다", () => {
  mutateInteractions(root, () => {});
  const file = join(root, ".code-agent/interactions/state.json"), old = new Date("2000-01-01T00:00:00Z");
  utimesSync(file, old, old);
  mutateInteractions(root, () => {});
  assert.equal(statSync(file).mtimeMs, old.getTime());
  mutateInteractions(root, state => { state.seq += 1; });
  assert.notEqual(statSync(file).mtimeMs, old.getTime());
});
