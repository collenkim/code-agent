import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { loadActive } from "../agent/layout";
import { loadRequestSession } from "../agent/requestSession";
import { readInteractions } from "../agent/interactions";
import { interactionSummary } from "../agent/interactionSummary";
import { loadConsent } from "../agent/consent";
import { loadPlanning, planningFile } from "../agent/planningState";
import { graphView } from "../agent/graph/view";
import type { Work } from "../agent/work";
import { Stop } from "../agent/stop";

test("2-2 상태 JSON의 문법·구조 손상은 경로가 있는 Stop으로 읽기만 실패한다", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-state-json-")));
  const work = { repoRoot: root, active: { id: "TASK", target: "app" } } as Work;
  const id = "00000000-0000-0000-0000-000000000001";
  const cases: [string, () => unknown][] = [
    [".code-agent/active.json", () => loadActive(root)],
    [".code-agent/request-session.json", () => loadRequestSession(root)],
    [".code-agent/interactions/state.json", () => readInteractions(root)],
    [".code-agent/interactions/state.json", () => interactionSummary(root)],
    [`.code-agent/consents/${id}.json`, () => loadConsent(root, id)],
    [planningFile(work), () => loadPlanning(work)],
    [".code-agent/graph/view.json", () => graphView(root)],
  ];
  try {
    for (const [file, read] of cases) for (const content of ["{bad", "null", "[]"]) {
      const path = resolve(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
      assert.throws(read, (error: unknown) => error instanceof Stop && error.message.includes(file.replaceAll("\\", "/").split("/").pop()!), file + " " + content);
      assert.equal(readFileSync(path, "utf8"), content, "손상된 원본을 덮어쓰거나 지우지 않는다");
      rmSync(path);
    }
  } finally {
    assert.equal(dirname(root), realpathSync.native(tmpdir())); assert.ok(root.includes("ca-state-json-"));
    rmSync(root, { recursive: true, force: true });
  }
});

test("2-2 질문 요약과 원장 조회는 손상된 요청 구조를 같은 경로에서 거부한다", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-state-json-")));
  const path = join(root, ".code-agent/interactions/state.json");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, instanceId: "instance", seq: 1, commands: {}, requests: { broken: { context: null } } }));
    for (const read of [() => readInteractions(root), () => interactionSummary(root)]) assert.throws(read, /state\.json.*질문 원장/);
  } finally {
    assert.equal(dirname(root), realpathSync.native(tmpdir())); assert.ok(root.includes("ca-state-json-"));
    rmSync(root, { recursive: true, force: true });
  }
});
