import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { doctor } from "../agent/doctor";

const root = join(__dirname, "..", "..");
const versions: [string, boolean][] = [
  ["22.22.0", false], ["24.18.9", false], ["24.19.0", true],
  ["24.20.0", true], ["25.0.0", false], ["24.19.0-rc.1", false],
];

test("doctor는 Node 24.19.0부터 24.x까지만 지원한다", () => {
  const repo = mkdtempSync(join(tmpdir(), "ca-node-runtime-"));
  const original = Object.getOwnPropertyDescriptor(process.versions, "node")!;
  const originalVersion = Object.getOwnPropertyDescriptor(process, "version")!;
  try {
    for (const [version, supported] of versions) {
      Object.defineProperty(process.versions, "node", { ...original, value: version });
      Object.defineProperty(process, "version", { ...originalVersion, value: `v${version}` });
      const runtime = doctor(repo).text.split("\n").find(line => line.includes("런타임:"))!.trim();
      assert.equal(runtime.startsWith(supported ? "✓" : "✗"), true, `${version}: ${runtime}`);
      if (!supported) assert.match(runtime, />=24\.19\.0 <25/);
    }
  } finally {
    Object.defineProperty(process.versions, "node", original);
    Object.defineProperty(process, "version", originalVersion);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("SEA 빌드는 지원 범위 밖에서 산출물 정리 전에 거부한다", () => {
  const source = readFileSync(join(root, "scripts", "build-bin.js"), "utf8");
  for (const [version, supported] of versions) {
    let reachedCleanup = false;
    assert.throws(() => runInNewContext(source, {
      __dirname: join(root, "scripts"),
      process: { versions: { node: version }, version: `v${version}`, platform: process.platform },
      require(id: string) {
        if (id === "node:sea") return { getAssetKeys() {} };
        if (id === "node:fs") return { rmSync() { reachedCleanup = true; throw new Error("검사 완료"); } };
        return require(id);
      },
    }), supported ? /검사 완료/ : />=24\.19\.0 <25/, version);
    assert.equal(reachedCleanup, supported, version);
  }
});
