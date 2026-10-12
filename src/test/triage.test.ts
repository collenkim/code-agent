import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, test } from "node:test";
import { triageBegin, triageClose, triageHandoff, triageJira, triageLink, triageStatus, triageSubmit } from "../agent/triage";
import { loadTriage, triageDraft, triageRecordFile, type TriageReport } from "../agent/triageState";
import { loadActive } from "../agent/layout";
import { init } from "../agent/init";
import { decide } from "../agent/hook";
import { codexHook } from "../agent/codexHook";
import { start, status } from "../agent/commands";
import { docsBegin } from "../agent/docsCommands";
import { loadRequestSession, requestBegin, requestSubmit, requestState } from "../agent/request";
import { hostAssets } from "../agent/hosts";
import { setupConsentProject, writeFixture } from "./consentFixture";
import { hasUnmappedOriginal } from "../agent/intakeTrace";
import { triageIngest, triageDeployed, triageReassess, triageAttach, triageWorkState } from "../agent/triage";
import { readTriageRecord, TRIAGE_INPUT } from "../agent/triageState";
import { errorFingerprint } from "../agent/errorFingerprint";
import { abort } from "../agent/commands";

let root: string;
const source = "acme/cloud/12345";
const log = "TypeError: items is null\r\n    at total (src/cloud.js:1)\r\n";
function report(overrides: Partial<TriageReport> = {}): TriageReport {
  return {
    title: "cloud 합계 오류", errorLog: log, release: "v1 — src/cloud.js의 같은 구현을 확인",
    facts: ["items가 null인 호출에서 오류"], hypotheses: ["외부 입력 검증 누락 가능성"],
    cause: "code", codeChange: "required", reason: "코드가 null을 확인하지 않고 map을 호출한다",
    evidence: [{ path: "src/cloud.js", line: 1, quote: "items.map" }],
    nextActions: ["입력 경계 확인과 회귀 테스트"], missingEvidence: [],
    duplicate: { status: "none", evidence: "사람이 Sentry 연결 티켓과 cloud Jira에서 출처를 조회해 중복 없음을 확인" },
    proposal: { target: "src/cloud.js", scope: ["src"], preserve: ["정상 배열의 합계 결과 유지"],
      requirements: ["null 입력의 처리 규칙을 확인하고 예외를 교정한다"], done: ["정상 배열과 null 입력 회귀 테스트 통과"] },
    ...overrides,
  };
}
function submit(value = report()): void {
  writeFileSync(join(root, triageDraft(loadTriage(root)!.id)), JSON.stringify(value));
  triageSubmit(root);
}
const hook = (tool_name: string, tool_input: Record<string, unknown>) => decide({ cwd: root, tool_name, tool_input });
function ingest(errorLog = log, release?: string, project = "cloud"): string {
  writeFixture(root, TRIAGE_INPUT, JSON.stringify({ project, errorLog, release }));
  return triageIngest(root, TRIAGE_INPUT);
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-triage-")));
  setupConsentProject(root);
  init(root, { host: "both" });
  writeFixture(root, "src/cloud.js", "module.exports = items => items.map(x => x.amount);\n");
});
afterEach(() => {
  assert.ok(resolve(root).startsWith(realpathSync.native(tmpdir()) + sep) && root.includes("ca-triage-"));
  rmSync(root, { recursive: true, force: true });
});

test("로그 특징은 이벤트 ID·시각만 정규화하고 오류 코드·프로젝트·스택을 보존", () => {
  assert.equal(errorFingerprint("cloud", log + "Event ID: aaa\n").key, errorFingerprint("cloud", log + "Event ID: bbb\n").key);
  assert.notEqual(errorFingerprint("cloud", log).key, errorFingerprint("other", log).key);
  assert.notEqual(errorFingerprint("cloud", log + "code: 401").key, errorFingerprint("cloud", log + "code: 403").key);
  assert.notEqual(errorFingerprint("cloud", log).key, errorFingerprint("cloud", log.replace("total", "other")).key);
  assert.equal(errorFingerprint("cloud", "TypeError: failure").reliable, false);
});

test("조사 중 반복 접수는 원본 보존·발생 누적, 새로운 조사를 만들지 않는다", () => {
  ingest();
  const id = loadTriage(root)!.id;
  assert.equal(hook("Write", { file_path: join(root, TRIAGE_INPUT) }), undefined);
  assert.match(ingest(log + "Event ID: another\n"), /새 Jira·수정 실행은 생략/);
  assert.equal(loadTriage(root)!.id, id);
  assert.equal(readTriageRecord(root, id).intake!.count, 2);
  assert.equal(readTriageRecord(root, id).intake!.original, log);
  assert.throws(() => submit(report({ errorLog: "변조" })), /원문/);
  assert.throws(() => ingest(log, undefined, "other"), /다른 오류/);
});

test("정보 부족·유사 로그는 자동 억제하지 않고 후보 비교 전 Jira 차단", () => {
  ingest("TypeError: failure");
  const id = loadTriage(root)!.id;
  triageClose(root);
  ingest("TypeError: failure");
  assert.notEqual(loadTriage(root)!.id, id);
  assert.deepEqual(loadTriage(root)!.intake!.candidates, [id]);
  submit(report({ errorLog: "TypeError: failure" }));
  assert.throws(() => triageJira(root), /유사 후보/);
  assert.match(triageAttach(root, id, "같은 호출 입력과 원인 코드를 확인"), /기존 오류에 연결/);
  assert.equal(loadTriage(root), undefined);
  assert.match(ingest("TypeError: failure"), /새 Jira·수정 실행은 생략/);
  assert.equal(loadTriage(root), undefined);
});

test("fix 인계 중 반복은 새 접수 없이 연결하고 중단·재판별 사유를 보존", () => {
  ingest();
  const id = loadTriage(root)!.id;
  submit();
  triageLink(root, "CLOUD-12", "https://jira.example/browse/CLOUD-12");
  triageHandoff(root);
  assert.match(ingest(), /CLOUD-12/);
  assert.equal(loadTriage(root), undefined);
  assert.equal(loadRequestSession(root)!.id, "CLOUD-12");
  abort(root);
  assert.equal(readTriageRecord(root, id).lifecycle, "paused");
  triageReassess(root, id, "중단 후 새 증거 확인");
  assert.equal(loadTriage(root)!.reassessmentReason, "중단 후 새 증거 확인");
});

test("배포 대기는 반복 억제, 배포 버전 재발은 새로운 조사, 버전 불명은 확인 요청", () => {
  ingest(log, "v1");
  const id = loadTriage(root)!.id;
  submit();
  triageLink(root, "CLOUD-12", "https://jira.example/browse/CLOUD-12");
  triageHandoff(root);
  abort(root);
  assert.throws(() => triageDeployed(root, id, "v2", "배포 확인"), /배포 대기/);
  triageWorkState(root, "CLOUD-12", "awaiting-deployment");
  assert.match(ingest(log, "v1"), /새 Jira·수정 실행은 생략/);
  assert.throws(() => triageReassess(root, id, "반복"), /배포 작업/);
  triageDeployed(root, id, "v2", "사용자가 배포 실행 #42 성공 확인");
  assert.match(ingest(), /발생 버전/);
  assert.equal(loadTriage(root), undefined);
  ingest(log, "v2");
  assert.notEqual(loadTriage(root)!.id, id);
  submit(report({ candidateReview: [{ id, decision: "reassess", reason: "수정 배포 버전에서 재발" }] }));
  assert.match(triageJira(root), /jira.md/);
});

test("운영 판정 반복 재사용, 새 근거로 재판별 가능", () => {
  ingest();
  const id = loadTriage(root)!.id;
  submit(report({ cause: "data", codeChange: "unnecessary", proposal: undefined }));
  triageClose(root);
  assert.match(ingest(), /operational/);
  assert.equal(loadTriage(root), undefined);
  triageReassess(root, id, "정상 데이터에서도 재현됨");
  assert.deepEqual(loadTriage(root)!.intake!.candidates, [id]);
});

test("동시 CLI 접수는 하나의 조사로 예약하고 두 발생을 기록", async () => {
  writeFixture(root, TRIAGE_INPUT, JSON.stringify({ project: "cloud", errorLog: log }));
  const run = () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, "../agent/cli.js"), "triage", "ingest", TRIAGE_INPUT], { cwd: root });
    let output = "";
    child.stdout.on("data", x => { output += x; });
    child.stderr.on("data", x => { output += x; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output) : reject(new Error(output)));
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(results.filter(x => x.includes("새 Jira·수정 실행은 생략")).length, 1);
  assert.equal(loadTriage(root)!.intake!.count, 2);
});

test("로그만으로 조사 시작 — 개발 접수·작업을 만들지 않고 상태로 재개", () => {
  assert.match(triageBegin(root, source), /조사 중/);
  assert.equal(loadActive(root), undefined);
  assert.equal(loadRequestSession(root), undefined);
  assert.match(status(root), /사전 판별: acme\/cloud\/12345/);
  assert.equal(triageBegin(root, source), status(root));
  assert.throws(() => triageBegin(root, "acme/cloud/999"), /다른 오류/);
  assert.throws(() => requestBegin(root, "CLOUD-1", "fix"), /사전 판별 중/);
  assert.throws(() => start(root, "unused.md"), /사전 판별 중/);
  assert.throws(() => docsBegin(root), /사전 판별 중/);
  assert.throws(() => triageJira(root), /코드 변경 필요/);
  assert.throws(() => triageLink(root, "CLOUD-1", "https://jira.example/browse/CLOUD-1"), /코드 변경 필요/);
});

test("판별 중 제품·상태 쓰기와 셸 변경은 거부하고 초안·조사는 양쪽 호스트에서 허용", () => {
  triageBegin(root, source);
  const active = loadTriage(root)!;
  assert.equal(hook("Write", { file_path: join(root, triageDraft(active.id)) }), undefined);
  for (const path of ["src/cloud.js", triageRecordFile(active.id), "../outside.txt"]) {
    assert.match(hook("Write", { file_path: join(root, path) })!, /사전 판별/);
  }
  assert.equal(hook("Read", { file_path: join(root, "src/cloud.js") }), undefined);
  for (const command of ["code-agent triage status", "code-agent triage submit", "code-agent read src/cloud.js", "git diff"]) {
    assert.equal(hook("Bash", { command }), undefined, command);
  }
  for (const command of ["node change.js", "code-agent request begin CLOUD-1 --kind fix", "code-agent docs begin", "git diff --output=src/cloud.js", "code-agent triage close; node change.js"]) {
    assert.ok(hook("Bash", { command }), command);
  }
  assert.ok(hook("mcp__jira__create_issue", { summary: "수정" }));
  assert.equal(hook("mcp__jira__search_issues", { query: source }), undefined);
  assert.ok(hook("mcp__filesystem__write_file", { path: join(root, "src/cloud.js"), content: "changed" }));
  const codex = (path: string) => codexHook({ cwd: root, hook_event_name: "PreToolUse", tool_name: "apply_patch",
    tool_input: { command: `*** Begin Patch\n*** Update File: ${path}\n@@\n-old\n+new\n*** End Patch` } } as Parameters<typeof codexHook>[0]);
  assert.match(JSON.stringify(codex("src/cloud.js")), /사전 판별/);
  assert.doesNotMatch(JSON.stringify(codex(triageDraft(active.id))) ?? "", /deny/);
});

for (const cause of ["data", "environment", "external"] as const) test(`${cause} 단독 조치는 Jira·fix 없이 종료`, () => {
  triageBegin(root, source);
  submit(report({ cause, codeChange: "unnecessary", proposal: undefined }));
  assert.throws(() => triageJira(root), /코드 변경 필요/);
  assert.throws(() => triageHandoff(root), /코드 변경 필요/);
  assert.match(triageClose(root), /기록과 Jira 연결은 보존/);
  assert.equal(loadRequestSession(root), undefined);
  assert.match(triageBegin(root, source), /unnecessary/);
});

test("판단 보류는 추가 증거를 요구하고, 데이터 원인이어도 코드 보완 필요로 분류 가능", () => {
  triageBegin(root, source);
  assert.throws(() => submit(report({ cause: "unknown", codeChange: "undetermined" })), /추가 증거/);
  submit(report({ cause: "unknown", codeChange: "undetermined", missingEvidence: ["발생 release의 코드"], proposal: undefined }));
  assert.throws(() => triageJira(root), /코드 변경 필요/);
  submit(report({ cause: "data" }));
  assert.match(triageJira(root), /수동 생성/);
});

test("코드 근거·경로를 대조하고 조사 뒤 코드가 바뀌면 Jira 준비와 인계를 거부", () => {
  triageBegin(root, source);
  assert.throws(() => submit(report({ evidence: [{ path: "src/cloud.js", line: 2, quote: "items.map" }] })), /실제 줄/);
  assert.throws(() => submit(report({ evidence: [{ path: "../outside.txt", line: 1, quote: "items.map" }] })), /저장소 안/);
  submit();
  writeFixture(root, "src/cloud.js", "// changed\nmodule.exports = items => items.map(x => x.amount);\n");
  assert.throws(() => triageJira(root), /실제 줄/);
  submit(report({ evidence: [{ path: "src/cloud.js", line: 2, quote: "items.map" }] }));
  writeFixture(root, "src/cloud.js", "// different\nmodule.exports = items => items.map(x => x.amount);\n");
  assert.throws(() => triageJira(root), /조사한 코드가 바뀌었습니다/);
});

test("중복 미조회·Jira 미연결·불일치 URL은 막고 기존 Jira는 그대로 연결", () => {
  triageBegin(root, source);
  submit(report({ duplicate: { status: "unchecked", evidence: "Jira 접근 없음" } }));
  assert.throws(() => triageJira(root), /기존 Jira/);
  const jira = { key: "CLOUD-12", url: "https://jira.example/browse/CLOUD-12" };
  submit(report({ duplicate: { status: "existing", evidence: "사용자가 기존 티켓 확인", jira } }));
  assert.match(triageJira(root), /기존 Jira CLOUD-12/);
  assert.throws(() => triageHandoff(root), /실제 Jira/);
  assert.throws(() => triageLink(root, "CLOUD-13", "https://jira.example/browse/CLOUD-12"), /키와 일치/);
  assert.throws(() => triageLink(root, "CLOUD-13", "https://jira.example/browse/CLOUD-13"), /다른 티켓/);
  triageLink(root, jira.key, jira.url);
  assert.throws(() => triageSubmit(root), /바꾸지 않습니다/);
  assert.ok(hook("Write", { file_path: join(root, triageDraft(loadTriage(root)!.id)) }));
});

test("Sentry → 판별 → Jira 수동 연결 → fix 접수·제출, 원문 보존·미승인·중복 인계 방지", () => {
  triageBegin(root, source, "release/cloud");
  submit();
  assert.match(triageJira(root), /jira.md/);
  triageLink(root, "CLOUD-12", "https://jira.example/browse/CLOUD-12");
  assert.match(triageHandoff(root), /fix로 접수/);
  assert.equal(loadTriage(root), undefined);
  assert.equal(loadRequestSession(root)?.kind, "fix");
  assert.equal(loadRequestSession(root)?.base, "release/cloud");
  const draft = "doc/work/CLOUD-12/request.json";
  const data = JSON.parse(readFileSync(join(root, draft), "utf8"));
  assert.equal(data.original, log);
  assert.equal(data.errorLog, log);
  assert.match(data.background, /사용자 확정 전/);
  requestSubmit(root, draft);
  assert.equal(hasUnmappedOriginal(readFileSync(join(root, "doc/work/CLOUD-12/requirement.md"), "utf8")), false);
  assert.equal(requestState(root, "CLOUD-12", "doc/work/CLOUD-12/requirement.md").status, "none");
  assert.equal(loadActive(root), undefined);
  assert.match(triageBegin(root, source), /이미 Jira CLOUD-12/);
  assert.equal(loadTriage(root), undefined);
});

test("기존 작업 폴더를 덮어쓰지 않는다", () => {
  triageBegin(root, source);
  submit();
  triageLink(root, "CLOUD-12", "https://jira.example/browse/CLOUD-12");
  writeFixture(root, "doc/work/CLOUD-12/request.json", "기존 자료");
  assert.throws(() => triageHandoff(root), /덮어쓰지/);
  assert.equal(readFileSync(join(root, "doc/work/CLOUD-12/request.json"), "utf8"), "기존 자료");
});

test("직접 fix·feature·refactor 접수는 사전 판별을 요구하지 않는다", () => {
  for (const kind of ["fix", "feature", "refactor"]) {
    requestBegin(root, "DIRECT-1", kind);
    assert.equal(loadRequestSession(root)?.kind, kind);
    assert.equal(loadTriage(root), undefined);
    rmSync(join(root, ".code-agent/request-session.json"));
  }
});

test("CLI 인자 검사와 두 호스트의 사전 판별 절차 배포", () => {
  const cli = join(__dirname, "../agent/cli.js");
  const result = spawnSync(process.execPath, [cli, "triage", "begin", source], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /사전 판별/);
  const bad = spawnSync(process.execPath, [cli, "triage", "link", "CLOUD-1"], { cwd: root, encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(triageStatus(root), /draft.json/);
  for (const host of ["claude", "codex"] as const) {
    const assets = hostAssets(host);
    const path = host === "claude" ? ".claude" : ".agents";
    assert.match(assets.get(`${path}/skills/ca-fix/triage.md`)!, /코드 변경 필요/);
    assert.match(assets.get(`${path}/skills/ca-fix/SKILL.md`)!, /--triage/);
  }
  assert.ok(existsSync(join(root, ".agents/skills/ca-fix/triage.md")));
});
