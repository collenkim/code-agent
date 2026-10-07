import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { checkApproval, diffBoundary, formatBoundary, hashManifest, manifestBoundary, recordDecision } from "../core/approval";
import type { Manifest } from "../core/manifest";
import { consentSnapshot, observeConsent } from "../agent/consent";
import { prDocFile, deliverProblems } from "../agent/deliver";
import { checkProjectDocs, projectDocsHash, sha } from "../agent/docs";
import { docsBegin, docsLink } from "../agent/docsCommands";
import { outsideChanges } from "../agent/evidence";
import { decide } from "../agent/hook";
import { loadPlanning } from "../agent/planningState";
import { manifestCheck } from "../agent/survey";
import { approvalDocsHash, approvalDocsState, approvalOf, loadWork } from "../agent/work";
import { workDocsHash } from "../agent/workDocs";
import { approvalChangeLines, start } from "../agent/commands";
import {
  CONSENT_SPEC, CONSENT_WORK_ID, approveAndApplyFixture, consentEvent, gitFixture, prepareConsentFixture, prepareDeliveryFixture, preparePlanFixture,
  setupConsentProject, submitConsentRequest, writeFixture,
} from "./consentFixture";

let root: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-screens-")));
  setupConsentProject(root);
});
afterEach(() => {
  const target = resolve(root), temporary = realpathSync.native(tmpdir());
  assert.ok(target.startsWith(temporary + sep) && target.slice(temporary.length + 1).startsWith("ca-screens-"));
  rmSync(target, { recursive: true, force: true });
});

const hookWrite = (path: string) => decide({ cwd: root, tool_name: "Write", tool_input: { file_path: join(root, path) } });
const manifest = () => JSON.parse(readFileSync(join(root, "code-agent.json"), "utf8"));
const saveManifest = (value: unknown) => writeFileSync(join(root, "code-agent.json"), JSON.stringify(value, null, 2));
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function startWork(): void {
  approveAndApplyFixture(root, { action: "setup" });
  submitConsentRequest(root);
  approveAndApplyFixture(root, { action: "request", id: CONSENT_WORK_ID });
  start(root, join(root, CONSENT_SPEC));
}

// ---- CON-3 문서 세션 범위 ----

test("T-3-1 문서 세션의 쓰기 범위는 docs begin 때의 매니페스트로 고정된다", () => {
  docsBegin(root);
  const value = manifest();
  value.conventions = ["doc/conventions.md", "src"];
  value.docs = { ...value.docs, knowledge: { businessRules: "package.json" } };
  saveManifest(value);
  for (const path of ["src/app.ts", "package.json", "src/deep/a.md"]) assert.match(hookWrite(path) ?? "", /문서 작성 중에는/, path);
  assert.equal(hookWrite("doc/x.png"), undefined);
  assert.equal(hookWrite("code-agent.json"), undefined);
});

test("T-3-2·T-3-4 docs link 로 연결한 문서만 범위가 넓어지고, 문서 경로는 .md 파일이어야 한다", () => {
  docsBegin(root);
  mkdirSync(join(root, "docs/conv"), { recursive: true });
  writeFixture(root, "docs/conv/a.md", "# 규칙\n");
  docsLink(root, "conventions", ["docs/conv"]);
  assert.equal(hookWrite("docs/conv/a.md"), undefined);
  assert.match(hookWrite("docs/conv/a.ts") ?? "", /문서 작성 중에는/);
  writeFixture(root, "package.json", "{}\n");
  assert.throws(() => docsLink(root, "business-rules", ["package.json"]), /\.md 파일이어야 합니다/);
  assert.throws(() => docsLink(root, "business-rules", ["docs/conv"]), /디렉토리 불가/);
});

test("T-3-3 범위가 없는 이전 형식 세션도 doc/ 밖은 .md 만 연다", () => {
  writeFixture(root, ".code-agent/docs-session.json", JSON.stringify({ startedAt: "2026-10-01T00:00:00.000Z" }));
  const value = manifest();
  value.conventions = ["src"];
  saveManifest(value);
  assert.match(hookWrite("src/app.ts") ?? "", /문서 작성 중에는/);
  assert.equal(hookWrite("src/README.md"), undefined);
});

// ---- CONS-M1 KNOWLEDGE 경로 ----

test("T-M1-1·T-M1-2 .md 가 아닌 KNOWLEDGE 경로는 계획 밖 변경 예외가 아니고, manifest check 가 ✗ 로 알린다", () => {
  startWork();
  const value = manifest();
  value.docs = { ...value.docs, knowledge: { businessRules: "src/a.ts" } };
  saveManifest(value);
  writeFixture(root, "src/a.ts", "export const a = 1;\n");
  writeFixture(root, "doc/knowledge/business-rules.md", "# 업무 규칙\n");
  const outside = outsideChanges(loadWork(root)!).map((change) => change.path);
  assert.ok(outside.includes("src/a.ts"));
  const result = manifestCheck(root);
  assert.equal(result.ok, false);
  assert.match(result.text, /공통 KNOWLEDGE business-rules: src\/a\.ts — \.md 파일이어야/);
});

// ---- CON-4 승인 화면 경계 절·재승인 diff ----

const goldenBase = { language: "typescript", sourceExtensions: [], domainBase: "src", domainRoots: [""], conventions: [], docs: {}, git: { base: "master" },
  commands: {}, commandTimeoutMinutes: 10, fixRounds: 2, workOrder: { attributes: [], requireApprover: false, requireVerifiedApproval: false }, plugins: {},
  stages: [{ key: "code", title: "코드", template: "code.md", kind: "code", kinds: [], confirm: true, exemplars: [], scope: "domain", outputDirs: ["."] },
    { key: "test", title: "테스트", template: "test.md", kind: "test", kinds: [], confirm: true, exemplars: [], scope: "project", outputDirs: ["tests"] }] } as unknown as Manifest;

test("T-4-1·T-4-2 경계 선언 리팩터는 해시 값을 바꾸지 않고, 승인 화면 절에 단계·명령·환경 오류 문구가 나온다", () => {
  assert.equal(hashManifest(goldenBase), "sha256:646b49add8e6d8cc");
  const full = { ...goldenBase, build: ["npm", "run", "build"], test: ["npm", "test"], prepare: ["npm", "ci"], commands: { lint: ["npm", "run", "lint"] },
    environmentErrors: ["Connection refused: localhost:5432"] } as unknown as Manifest;
  assert.equal(hashManifest(full), "sha256:9d696b298a3abce3");
  const text = formatBoundary(manifestBoundary(full));
  for (const pattern of [/단계 code: kind code/, /단계 test: kind test .*출력 위치 tests/, /build: npm run build/, /commands\.lint: npm run lint/, /환경 오류 문구: "Connection refused: localhost:5432"/]) {
    assert.match(text, pattern);
  }
  assert.match(formatBoundary(manifestBoundary(goldenBase)), /commands: 없음[\s\S]*환경 오류 문구: 선언 없음/);
  const changed = { ...full, commands: { lint: ["npm", "run", "lint:strict"] }, stages: [goldenBase.stages[0], { ...goldenBase.stages[1], outputDirs: ["spec"] }] } as unknown as Manifest;
  const diff = diffBoundary(manifestBoundary(full), manifestBoundary(changed)).map((entry) => `${entry.change} ${entry.text}`);
  assert.ok(diff.some((line) => line.startsWith("~ 단계 test")), diff.join("\n"));
  assert.ok(diff.some((line) => line.startsWith("~ commands.lint")), diff.join("\n"));
});

test("T-4-3·T-4-4·T-4-5 승인이 경계 스냅샷과 문서별 해시를 남기고, 재승인 상태가 바뀐 것을 보인다", () => {
  preparePlanFixture(root);
  const consent = prepareConsentFixture(root, { action: "plan" });
  assert.match(consent.questions[0].question, /경계·검증 선언 \(승인이 묶는 code-agent\.json 항목/);
  const work = loadWork(root)!;
  // 리팩터 전 식과 같은 docsHash
  const project = projectDocsHash(checkProjectDocs(root, work.manifest))!;
  const proof = JSON.stringify(loadPlanning(work).tasks.map((record) => ({ task: record.task, last: record.attempts.at(-1) })));
  assert.equal(approvalDocsHash(work), sha(`${project}\n${workDocsHash(root, CONSENT_WORK_ID, work.active.spec)}\n${proof}`));
  recordDecision(root, { order: work.order, target: work.active.target, plan: work.plan!, manifest: work.manifest, decision: "approved", approver: "t",
    presence: { channel: "tty", verified: true, detail: "t" }, docsHash: approvalDocsHash(work), docsParts: approvalDocsState(work).parts });
  assert.equal(approvalOf(loadWork(root)!).status, "approved");
  const design = `doc/work/${CONSENT_WORK_ID}/03-design.md`;
  const original = readFileSync(join(root, design), "utf8");
  appendFileSync(join(root, design), "\n바뀐 설계\n");
  const docs = approvalOf(loadWork(root)!);
  assert.equal(docs.status, "stale-docs");
  assert.deepEqual(docs.status === "stale-docs" ? docs.changed : [], [design]);
  // 재승인 화면(decide)의 바뀐 것 절 — 문서별 해시가 있으면 경로를, 없는 이전 기록이면 그 사실을 보인다
  assert.deepEqual(approvalChangeLines(docs), ["", `이전 판정 이후 바뀐 근거 문서: ${design}`]);
  if (docs.status === "stale-docs") {
    assert.deepEqual(approvalChangeLines({ ...docs, changed: [] }), ["", "이전 판정 이후 바뀐 근거 문서: 이전 승인 기록에 문서별 해시가 없어 무엇이 바뀌었는지 보일 수 없습니다"]);
  }
  writeFileSync(join(root, design), original);
  const value = manifest();
  value.commands = { lint: ["npm", "run", "lint"] };
  value.stages[1].outputDirs = ["spec"];
  saveManifest(value);
  const stale = approvalOf(loadWork(root)!);
  assert.equal(stale.status, "stale-manifest");
  const lines = stale.status === "stale-manifest" ? stale.diff.map((entry) => `${entry.change} ${entry.text}`) : [];
  assert.ok(lines.some((line) => line.startsWith("+ commands.lint")) && lines.some((line) => line.startsWith("~ 단계 test")), lines.join("\n"));
  const screen = approvalChangeLines(stale);
  assert.equal(screen[1], "이전 판정 이후 바뀐 경계·검증 선언:");
  assert.match(screen[2], /^ {2}\+ commands\.lint/m);
  assert.match(screen[2], /^ {2}~ 단계 test/m);
  // 경계 스냅샷이 없는 이전 기록은 차이를 보이지 않는다(현재 선언 전체를 보인다)
  rmSync(join(root, `.code-agent/approvals/${CONSENT_WORK_ID}/value-1.manifest.json`));
  const legacy = approvalOf(loadWork(root)!);
  assert.deepEqual(legacy.status === "stale-manifest" ? legacy.diff : ["?"], []);
  assert.deepEqual(approvalChangeLines(legacy), ["", "이전 판정 이후 바뀐 경계·검증 선언:", "  이전 승인 기록에 경계 스냅샷이 없어 차이를 보일 수 없습니다 — 위 현재 선언 전체를 확인하세요."]);
  assert.deepEqual(approvalChangeLines({ status: "none" }), []);
});

// ---- CON-14·CON-15 스냅샷 ----

function link(target: string, path: string): boolean {
  try { symlinkSync(join(root, target), join(root, path), process.platform === "win32" ? "junction" : "dir"); return true; }
  catch { return false; }
}

test("T-14-1 제어 경로 아래 링크는 따라가지 않고 대상으로 해시하며, 제어 루트 자체의 링크는 계속 거부한다", (context) => {
  mkdirSync(join(root, ".claude/skills"), { recursive: true });
  mkdirSync(join(root, "custom-a")); mkdirSync(join(root, "custom-b"));
  writeFixture(root, "custom-a/x.md", "a\n"); writeFixture(root, "custom-b/x.md", "b\n");
  if (!link("custom-a", ".claude/skills/shared")) { context.skip("링크를 만들 수 없는 환경"); return; }
  const fixture = prepareConsentFixture(root, { action: "docs" });
  rmSync(join(root, ".claude/skills/shared"), { recursive: true, force: true });
  assert.ok(existsSync(join(root, "custom-a/x.md")), "링크만 지운다");
  link("custom-b", ".claude/skills/shared");
  assert.throws(() => observeConsent(consentEvent(fixture, "PreToolUse")), /변경 대상: .*\.claude\/skills\/shared/);
  rmSync(join(root, ".claude"), { recursive: true, force: true });
  mkdirSync(join(root, "real-claude"));
  link("real-claude", ".claude");
  assert.throws(() => prepareConsentFixture(root, { action: "docs" }), /확인 대상에 심볼릭 링크가 있습니다: \.claude/);
});

test("T-15-1·T-15-2 내용 해시 캐시는 값을 바꾸지 않고, mtime 을 되돌린 같은 크기 변경도 잡는다", () => {
  const action = { action: "docs", decision: "accept", sendsCode: false } as Parameters<typeof consentSnapshot>[1];
  const file = join(root, "doc/architecture.md");
  pause(2_100);
  const fresh = consentSnapshot(root, action);
  const cacheFile = join(root, ".code-agent/consents/snapshot-cache.json");
  assert.ok(existsSync(cacheFile));
  assert.equal(consentSnapshot(root, action), fresh, "캐시로 구해도 같다");
  rmSync(cacheFile);
  assert.equal(consentSnapshot(root, action), fresh, "캐시 없이 구해도 같다");
  const before = statSync(file);
  const text = readFileSync(file, "utf8");
  writeFileSync(file, text.slice(0, -1) + (text.endsWith("X") ? "Y" : "X"));
  utimesSync(file, before.atime, before.mtime);
  assert.equal(statSync(file).size, before.size);
  assert.notEqual(consentSnapshot(root, action), fresh, "ctime 이 바뀌어 다시 읽는다");
  writeFixture(root, "doc/new.md", "새 문서\n");
  consentSnapshot(root, action);
  assert.equal("doc/new.md" in JSON.parse(readFileSync(cacheFile, "utf8")).entries, false, "2초 안에 바뀐 파일은 캐시하지 않는다");
});

// ---- CON-16 동의 영수증·원장 대조 ----

test("T-16-1·T-16-2 반영 커밋에 동의 영수증을 넣고, 원장 끝줄이 지워지면 반영을 막는다", async () => {
  await prepareDeliveryFixture(root);
  const pr = readFileSync(join(root, prDocFile(CONSENT_WORK_ID)), "utf8");
  assert.deepEqual(deliverProblems(loadWork(root)!, pr).filter((problem) => /판정 줄이 없습니다/.test(problem)), []);
  const ledger = join(root, `.code-agent/approvals/${CONSENT_WORK_ID}.jsonl`);
  const saved = readFileSync(ledger, "utf8");
  writeFileSync(ledger, saved.trim().split("\n").slice(0, -1).join("\n"));
  assert.ok(deliverProblems(loadWork(root)!, pr).some((problem) => /동의 [a-f0-9]{8}\(plan, .*\)의 판정 줄이 없습니다/.test(problem)));
  writeFileSync(ledger, saved);
  approveAndApplyFixture(root, { action: "deliver" });
  const receipts = `.code-agent/approvals/${CONSENT_WORK_ID}/consents.jsonl`;
  const committed = gitFixture(root, "show", `HEAD:${receipts}`).split("\n").map((line) => JSON.parse(line));
  assert.ok(committed.length >= 3);
  for (const row of committed) {
    assert.ok(row.id && row.action && Array.isArray(row.observed));
    assert.equal(JSON.stringify(row).includes("이 내용으로 진행할까요"), false, "질문 원문은 싣지 않는다");
  }
  assert.ok(committed.some((row) => row.action === "plan" && row.observed[0].choices.includes("확인하고 진행")));
  assert.equal(committed.find((row) => row.action === "deliver").status, "this-commit");
});
