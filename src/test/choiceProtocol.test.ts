import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

test("MCP stdio: 폼 응답 ID·취소 ID·동시 호출을 구분하고 실제 답만 돌려준다", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-choice-wire-")));
  const child = spawn(process.execPath, [join(__dirname, "../agent/cli.js"), "choice-server", "--root", root], { stdio: ["pipe", "pipe", "pipe"] });
  const replies: any[] = [];
  let changed: (() => void) | undefined;
  createInterface({ input: child.stdout }).on("line", line => { replies.push(JSON.parse(line)); changed?.(); });
  const send = (value: any) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  const wait = async (match: (r: any) => boolean): Promise<any> => {
    const deadline = Date.now() + 10000;
    while (!replies.some(match)) {
      if (Date.now() > deadline) throw new Error("MCP 응답 시간 초과");
      await new Promise<void>(r => { changed = r; setTimeout(r, 50); });
    }
    return replies.find(match);
  };
  try {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: { form: {} } } } });
    assert.ok((await wait(r => r.id === 1)).result.capabilities.tools);
    send({ id: 2, method: "tools/list" });
    assert.deepEqual((await wait(r => r.id === 2)).result.tools.map((t: any) => t.name), ["ask", "confirm"]);
    send({ id: 3, method: "tools/call", params: { name: "ask", arguments: { questions: [{ title: "표시", options: ["간단", "상세"] }] } } });
    const form = await wait(r => r.method === "elicitation/create");
    assert.equal(form.params.mode, "form");
    send({ id: 4, method: "tools/call", params: { name: "ask", arguments: {} } });
    assert.equal((await wait(r => r.id === 4)).result.isError, true);
    send({ method: "notifications/cancelled", params: { requestId: 999 } });
    send({ id: "wrong-form-id", result: { action: "accept", content: { q1: "간단" } } });
    send({ id: form.id, result: { action: "accept", content: { q1: "상세" } } });
    const output = (await wait(r => r.id === 3)).result;
    assert.equal(JSON.parse(output.content[0].text).answers[0].answer, "상세");
    send({ id: 5, method: "tools/call", params: { name: "ask", arguments: { questions: [{ title: "취소", options: ["진행", "보류"] }] } } });
    await wait(r => r.method === "elicitation/create" && r.id !== form.id);
    send({ method: "notifications/cancelled", params: { requestId: 5 } });
    assert.equal((await wait(r => r.id === 5)).result.isError, true);
  } finally {
    child.stdin.end();
    await new Promise<void>(r => { if (child.exitCode !== null) r(); else child.once("exit", () => r()); });
    assert.ok(resolve(root).startsWith(realpathSync.native(tmpdir()) + sep) && root.includes("ca-choice-wire-"));
    rmSync(root, { recursive: true, force: true });
  }
});
