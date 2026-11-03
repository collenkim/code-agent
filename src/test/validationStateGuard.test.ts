import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { branchCursorFile } from "../agent/branchCursor";
import { requireValidatable } from "../agent/commands";
import { loadEvidence } from "../agent/evidence";
import { revisionLogFile } from "../agent/requirementRevisions";
import { check } from "../agent/validate";
import { createStageRepo, removeStageRepo, repo, toCheck, useManifest } from "./stageFixture";

beforeEach(() => createStageRepo("ca-state-guard-"));
afterEach(() => removeStageRepo());

test("실행 코드가 커서·요구 개정·회차·답을 고치거나 새로 만들면 원상 복구하고 증거로 받지 않는다", async () => {
  const files = [".code-agent/active.json", ".code-agent/approvals/ORD-1/requirements.jsonl",
    ".code-agent/work/ORD-1/cycles.json", ".code-agent/work/ORD-1/answers.jsonl"];
  const script = `const fs=require('fs'),path=require('path'); const active=JSON.parse(fs.readFileSync('.code-agent/active.json','utf8'));
    const branchFile='.code-agent/branches/'+require('crypto').createHash('sha256').update(active.branch).digest('hex')+'.json';
    for(const file of [...${JSON.stringify(files)},branchFile]) { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,'forged'); }`;
  useManifest({ build: ["node", "-e", script] });
  toCheck();
  const work = requireValidatable(repo, "check");
  assert.equal(join(repo, files[1]), revisionLogFile(repo, work.active.id));
  files.push(branchCursorFile(work.active.branch!));
  const bytes = (file: string) => existsSync(join(repo, file)) ? readFileSync(join(repo, file), "utf8") : undefined;
  const before = files.map(bytes);
  await check(work);
  assert.deepEqual(files.map(bytes), before, "기존 기록은 원래 바이트로, 새 기록은 없음으로 되돌린다");
  const run = loadEvidence(repo, work.active.id, work.active.target)!.runs.find(r => r.kind === "build")!;
  assert.equal(run.cause, "guard"); assert.equal(run.outcome, "error");
  for (const file of files) assert.ok(run.guarded?.includes(file), file);
});
