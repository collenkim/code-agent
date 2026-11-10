import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { context, next } from "../agent/commands";
import { consentSnapshot } from "../agent/consent";
import { KNOWLEDGE_LOG, optionalDocsInput, registrationFingerprint, SHADOW_REFRESH_ENV } from "../agent/knowledgeContext";
import { loadActive } from "../agent/layout";
import type { KnowledgeRef } from "../agent/plugins/protocol";
import { readStore, writeStore } from "../agent/plugins/store";
import { start } from "./confirmedStart";
import { createRepo, removeRepo, repoTools } from "./repoFixture";

/**
 * 지식 검색 연결(context.docs) — off·enabled·shadow 를 실제 `context` 로 본다.
 *
 * 어댑터는 임시 폴더의 node 스크립트(테스트 더블)다. 응답은 시험마다 파일(reply.json)로 주고, 참조의 itemSha256 은 임시 저장소의
 * 실제 문서 줄로 계산한다. `CODE_AGENT_HOME` 을 임시 폴더로 돌려 실제 사용자 등록을 건드리지 않는다.
 */

const ARCH_PATH = "doc/architecture.md";
const CONV_PATH = "doc/conventions.md";
const RULES = "doc/knowledge/business-rules.md";
const FEATURES = "doc/knowledge/features.md";
const LEGACY = "src/main/app/order-legacy.js";

const BATCH = Array.from({ length: 30 }, (_, index) => `- 정산 배치 규칙 ${index + 1}`);
const ARCH = [
  "# 아키텍처",
  "## 기술 스택", "Node.js",
  "## 모듈/패키지 구조", "src/main/app/<파일>.js",
  "## 계층과 책임", "- app: 애플리케이션 코드",
  "## 의존 방향", "test → app",
  "## 공통 모듈", "없음",
  "## 주요 결정", "- 식별자: 문자열",
  // 같은 제목, 다른 내용 — 해시가 고른다
  "## 저장소", "주문 데이터는 PostgreSQL 에 저장한다.",
  "## 저장소", "세션은 Redis 에 저장한다.",
  // 같은 제목, 같은 내용 — 줄이 옮겨 가면 어느 쪽인지 정할 수 없다
  "## 캐시", "- 캐시는 5분",
  "## 캐시", "- 캐시는 5분",
  // 긴 절 — 그 안의 덩어리만 확인되면 절 전체로 넓히지 않는다
  "## 정산 배치", ...BATCH,
].join("\n");

const CONV = [
  "# 코드 컨벤션",
  "## 명명", "- 파일은 소문자",
  "## 계층별 규칙", "- app 은 순수 함수로",
  "## 예외 처리", "- Error 를 던진다",
  "## 테스트 규칙", "- 테스트 이름·주석에 TC id 를 남긴다",
  "## 주문 등록 규칙", "- order 를 만들 때는 총액을 함께 센다",
].join("\n");
const STRATEGY = ["# 테스트 전략", "## 수준과 범위", "- Unit: 필수", "## 도구와 실행 명령", "- `test`: 전체 테스트", "## 통과 기준", "- AC 마다 1케이스"].join("\n");
const QUALITY = ["# 품질·보안 기준", "## 정적 분석", "- `build`: 컴파일", "## 보안 검사", "- 없음 — 리뷰에서 본다", "## 통과 기준과 반영 차단", "- 컴파일 실패는 반영을 막는다"].join("\n");

const RULES_DOC = [
  "# 업무 규칙·용어집", "", "## 업무 규칙", "",
  "### `BR-ORDER-01` 주문 id 는 문자열", "- 구분: 필수", "- 상태: 확정", "- 출처: 사용자 결정", "- 범위: src/main/app", "",
  "### `BR-ORDER-02` 주문 총액", "- 구분: 권장", "- 상태: 관찰", `- 코드: ${LEGACY}`, "",
].join("\n");
/** BOM·CRLF 문서 — 줄은 `\r?\n` 으로 세고 해시는 "\n" 으로 이은 글이다 */
const FEATURES_DOC = `﻿${["# 기능 목록", "", "## 기능", "", "### `FEAT-ORDER-LIST` 주문 목록", "- 목적: 주문을 나열한다", `- 코드: ${LEGACY}`, ""].join("\r\n")}`;

const ORDER = ["---", "kind: feature", "id: FEAT-1", "title: 주문을 등록한다", "target: order", "scope: [src/main, src/test]", "---", "", "주문을 등록한다.", ""].join("\n");
const REQ = ["# FEAT-1 요구사항 정의", "## R1 · 주문을 등록한다 (order register)", "근거: \"주문을 등록한다.\"", "- 데이터: 만든다", "## 가정", "- 없음"].join("\n");

/** init 이 쓰는 .gitignore 블록과 같은 줄 — 기록(`.code-agent/log/`)이 git status 에 보이지 않는 실제 설치 상태 */
const GITIGNORE = ["build/", ...["active.json", "docs-session.json", "request-session.json", "log/", "consents/", "lease.json*", "agent-runs.json*", "runtime.json", "runtime.lock",
  "template-conflicts/", "graph/", "branches/", "identities/", "interactions/"].map((line) => `.code-agent/${line}`), ""].join("\n");

const ACCEPTS = ["context.docs.phase", "context.docs.files", "context.docs.refs"];
const NOW = "2026-11-10T00:00:00.000Z";

let repo: string;
let home: string;
let tools: string;
let homeBefore: string | undefined;

const { write, git, confirmDocs } = repoTools(() => repo);

function manifestJson(plugins?: Record<string, unknown>): string {
  return JSON.stringify({
    language: "javascript",
    sourceExtensions: [".js"],
    domainBase: "src/main",
    domainRoots: ["app"],
    conventions: [CONV_PATH],
    docs: { architecture: ARCH_PATH },
    build: ["node", "-e", "process.exit(0)"],
    test: ["node", "-e", "console.log('ok 1 - TC-1')"],
    stages: [
      { key: "code", title: "코드", template: "01-code.md", scope: "project", outputDirs: ["src/main"] },
      { key: "test", title: "테스트", template: "02-test.md", kind: "test", scope: "project", outputDirs: ["src/test"] },
    ],
    ...(plugins ? { plugins } : {}),
  }, null, 2);
}

function newRepo(): void {
  repo = createRepo("ca-kctx-");
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-kctx-home-")));
  tools = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-kctx-tools-")));
  homeBefore = process.env.CODE_AGENT_HOME;
  process.env.CODE_AGENT_HOME = home;
  write(ARCH_PATH, ARCH);
  write(CONV_PATH, CONV);
  write("doc/test-strategy.md", STRATEGY);
  write("doc/quality.md", QUALITY);
  write(RULES, RULES_DOC);
  write(FEATURES, FEATURES_DOC);
  write(".gitignore", GITIGNORE);
}

function dropRepo(): void {
  if (homeBefore === undefined) delete process.env.CODE_AGENT_HOME;
  else process.env.CODE_AGENT_HOME = homeBefore;
  removeRepo(repo);
  for (const dir of [home, tools]) rmSync(dir, { recursive: true, force: true });
}

/** 작업을 impact 에 세운다 — 자리 선언은 기준 커밋 전에 쓴다 */
function toImpact(plugins?: Record<string, unknown>): void {
  write("code-agent.json", manifestJson(plugins));
  confirmDocs();
  write("doc/work/FEAT-1.md", ORDER);
  write(LEGACY, "// 주문 register\nmodule.exports = {};\n");
  write("src/test/existing.test.js", "// 기존 테스트\n");
  write("01-code.md", "코드 단계 규칙");
  write("02-test.md", "테스트 단계 규칙");
  git("add", "-A");
  git("commit", "-qm", "init");
  start(repo, join(repo, "doc/work/FEAT-1.md"));
  write("doc/work/FEAT-1/01-requirements.md", REQ);
  next(repo);
  assert.equal(loadActive(repo)!.phase, "impact");
}

const declare = (plugins: Record<string, unknown>): void => write("code-agent.json", manifestJson(plugins));

// ---- 가짜 어댑터 ----

const replyFile = (): string => join(tools, "reply.json");
const seenFile = (): string => join(tools, "seen.json");
const callsFile = (): string => join(tools, "calls.txt");

/** 요청을 남기고(seen·calls) reply.json 대로 답한다 — `{crash:true}` 면 실패로 끝난다 */
function adapterCommand(): string[] {
  const path = join(tools, "ak.js");
  writeFileSync(path, [
    "const fs=require('fs');",
    "const chunks=[];",
    "process.stdin.on('data',(c)=>chunks.push(c));",
    "process.stdin.on('end',()=>{",
    "  const req=JSON.parse(Buffer.concat(chunks).toString('utf-8'));",
    `  fs.appendFileSync(${JSON.stringify(callsFile())}, req.op+'\\n');`,
    `  fs.writeFileSync(${JSON.stringify(seenFile())}, JSON.stringify(req));`,
    `  const spec=JSON.parse(fs.readFileSync(${JSON.stringify(replyFile())},'utf-8'));`,
    "  if(spec.crash){process.stderr.write('boom\\n');process.exit(3);}",
    "  process.stdout.write(JSON.stringify({protocol:'code-agent.plugin',version:'1',requestId:req.requestId,ok:true,output:spec.output}));",
    "});",
  ].join("\n"));
  return ["node", path.replace(/\\/g, "/")];
}

/** accepts 가 null 이면 이전 등록(선택 입력을 모르는 어댑터)이다 */
function register(accepts: string[] | null = ACCEPTS, name = "ak"): void {
  const store = readStore();
  writeStore({
    ...store,
    plugins: {
      ...store.plugins,
      [name]: {
        command: adapterCommand(),
        slots: ["context.docs"],
        sendsCode: false,
        adapter: { name, version: "t", describedAt: NOW, ...(accepts ? { accepts } : {}) },
        probe: { at: NOW, ok: true },
      },
    },
  });
}

function reply(output: unknown): void {
  writeFileSync(replyFile(), JSON.stringify({ output }));
}

function crash(): void {
  writeFileSync(replyFile(), JSON.stringify({ crash: true }));
}

const calls = (): number => (existsSync(callsFile()) ? readFileSync(callsFile(), "utf-8").split("\n").filter(Boolean).length : 0);
const seen = (): { input: Record<string, unknown> } => JSON.parse(readFileSync(seenFile(), "utf-8"));

function records(): Record<string, any>[] {
  const path = join(repo, KNOWLEDGE_LOG);
  return existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

// ---- 참조 ----

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const docLines = (path: string): string[] => readFileSync(join(repo, path), "utf-8").replace(/^﻿/, "").split(/\r?\n/);
const head = (): string => git("rev-parse", "HEAD");
/** 문서에서 그 글이 처음(또는 n번째) 나오는 줄 번호(1부터) */
function lineOf(path: string, text: string, nth = 1): number {
  let count = 0;
  const index = docLines(path).findIndex((line) => line === text && ++count === nth);
  assert.ok(index >= 0, `${path} 에 ${text} 없음`);
  return index + 1;
}

function ref(path: string, start: number, end: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine: "agent-knowledge",
    itemId: `kb:${path}#a${start}`,
    projectId: "orders",
    sourceId: "kb",
    generation: 2,
    commit: head(),
    blobSha: "a".repeat(40),
    documentSha256: "b".repeat(64),
    itemSha256: sha(docLines(path).slice(start - 1, end).join("\n")),
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

function section(path: string, start: number, end: number, extra: Record<string, unknown> = {}, why = "agent-knowledge keyword-match"): Record<string, unknown> {
  return { path, heading: "어댑터 제목", why, ref: ref(path, start, end, extra) };
}

/** master 가 이 작업에 인계한 참조 — 작업 기록(.code-agent/master/works/<id>.json)의 knowledge */
function handoff(refs: KnowledgeRef[]): void {
  write(`.code-agent/master/works/${encodeURIComponent("FEAT-1")}.json`, JSON.stringify({
    workId: "FEAT-1", links: {}, boundAt: NOW, runId: "run-1", controller: "m", runs: ["run-1"], knowledge: { version: 1, refs },
  }));
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DEFAULT_SOURCE = "- 출처: 기본 구현 (키·경로·별칭·본문 검색)";
const docsBlock = (text: string): string => text.slice(text.indexOf("## 참고 문서"));
/** 참고 문서 목록 — 다음 빈 줄까지 */
const docsList = (text: string): string => docsBlock(text).split("\n\n")[0];

describe("지식 검색 연결 — off", () => {
  beforeEach(newRepo);
  afterEach(dropRepo);

  test("선언이 없으면 등록이 있어도 context 가 같고 어댑터를 부르지 않으며 지식 기록도 없다", () => {
    toImpact();
    const before = context(repo);
    register();
    reply({ sections: [section(ARCH_PATH, lineOf(ARCH_PATH, "## 저장소"), lineOf(ARCH_PATH, "## 저장소") + 1)] });
    assert.equal(context(repo), before);
    assert.equal(calls(), 0);
    assert.equal(existsSync(join(repo, KNOWLEDGE_LOG)), false);
    assert.match(before, new RegExp(`## 참고 문서 \\(지식 항목·문서 절 순위 — 전문을 읽지 말고 이 줄 범위만\\)\\n${escape(DEFAULT_SOURCE)}\\n`));
    assert.match(before, /- doc\/conventions\.md L\d+-L\d+ · ## 주문 등록 규칙 \[개발 지침 · 코드 컨벤션\]/);
    assert.doesNotMatch(before, /인계받은 지식 근거|근거 재확인 필요|검증 제외/);
  });

  test("master 인계 참조가 있는데 연결이 off 면 생산자를 부르지 않고 required 참조를 adapter-off 로 재확인 블록에 싣는다 — 나머지 줄은 그대로", () => {
    toImpact();
    const before = context(repo);
    handoff([
      { itemId: "kb:doc/architecture.md#a14", generation: 2, commit: head(), itemSha256: "c".repeat(64), required: true },
      { itemId: "kb:doc/architecture.md#a99", generation: 2, commit: head(), itemSha256: "d".repeat(64), required: false },
    ]);
    const text = context(repo);
    const block = "\n\n## 근거 재확인 필요 (인계 항목 검증 실패 — 범위를 넓혀 다시 찾지 말고 이 작업의 근거를 다시 확인하거나 재계획을 요청한다)\n- kb:doc/architecture.md#a14: adapter-off";
    assert.ok(text.includes(block));
    assert.equal(text.replace(block, ""), before, "블록 말고는 off 와 같다");
    assert.doesNotMatch(text, /#a99/, "required 가 아닌 실패는 화면에 싣지 않는다");
    const record = records().at(-1)!;
    assert.equal(record.mode, "off");
    assert.equal(record.outcome, "adapter-unavailable");
    assert.deepEqual(record.pinned.map((entry: any) => [entry.itemId, entry.ok, entry.reason]), [
      ["kb:doc/architecture.md#a14", false, "adapter-off"], ["kb:doc/architecture.md#a99", false, "adapter-off"],
    ]);
  });
});

describe("지식 검색 연결 — enabled", () => {
  beforeEach(() => {
    newRepo();
    toImpact({ ak: { slots: ["context.docs"] } });
    register();
  });
  afterEach(dropRepo);

  test("인덱스 항목과 범위가 꼭 맞으면 그 항목으로 — 상태 표시는 이유 끝, 선택 입력(단계·파일)이 간다", () => {
    const start = lineOf(RULES, "### `BR-ORDER-01` 주문 id 는 문자열");
    reply({ sections: [{ ...section(RULES, start, start + 4, { unit: "entry", kind: "business-rule" }), heading: "`BR-ORDER-01` 주문 id 는 문자열", why: "agent-knowledge explicit-key" }] });
    const text = context(repo);
    assert.match(text, /## 참고 문서 [^\n]*\n- 출처: 플러그인 ak\n/);
    assert.match(text, new RegExp(`- doc/knowledge/business-rules\\.md L${start}-L${start + 4} · \`BR-ORDER-01\` 주문 id 는 문자열 \\[업무 정책 · 필수 확정\\] \\(agent-knowledge explicit-key\\)\\n`), "인덱스 항목은 code-agent 의 구분·상태가 정본 — 어댑터의 확정 판정을 덧붙이지 않는다");
    // 화면에 실린 항목은 반드시 적용하는 정책 목록에 다시 나오지 않는다(기존 규칙 그대로)
    assert.doesNotMatch(/## 반드시 적용하는 업무 정책[^\n]*\n((?:- [^\n]*\n?)*)/.exec(text)?.[1] ?? "", /BR-ORDER-01/);
    const input = seen().input;
    assert.equal(input.phase, "impact");
    assert.ok(Array.isArray(input.files) && (input.files as string[]).includes(LEGACY), JSON.stringify(input.files));
    assert.equal(input.refs, undefined, "인계가 없으면 refs 를 보내지 않는다");
    const record = records().at(-1)!;
    assert.deepEqual([record.mode, record.outcome, record.phase, record.verified[0].how, record.verified[0].status], ["enabled", "verified", "impact", "exact", "confirmed_policy"]);
    assert.match(record.inputHash, /^[0-9a-f]{64}$/);
  });

  test("인덱스 절과 꼭 맞으면 그 절, 긴 절 안의 덩어리는 그 범위만(부분) — 기준 커밋이 HEAD 와 다르면 표시", () => {
    const first = lineOf(ARCH_PATH, "## 저장소");
    const batch = lineOf(ARCH_PATH, "## 정산 배치");
    const other = "0123456789abcdef0123456789abcdef01234567";
    reply({ sections: [
      section(ARCH_PATH, first, first + 1, { commit: other }),
      section(ARCH_PATH, batch + 8, batch + 13, { status: "unverified", confirmed: false, declaredStatus: null }),
    ] });
    const text = context(repo);
    assert.match(text, new RegExp(`- doc/architecture\\.md L${first}-L${first + 1} · ## 저장소 \\[개발 지침 · 아키텍처\\] \\(agent-knowledge keyword-match · 기준 커밋 0123456 — 현재 파일과 일치 확인\\)`));
    assert.match(text, new RegExp(`- doc/architecture\\.md L${batch + 8}-L${batch + 13} · ## 정산 배치 \\(부분\\) \\[미확인 — 탐색 참고, 확정 근거 아님\\] \\(agent-knowledge keyword-match\\)\\n`));
    assert.doesNotMatch(text, new RegExp(`L${batch}-L${batch + BATCH.length}`), "긴 원본 절 전체로 넓히지 않는다");
  });

  test("줄이 옮겨 가면 같은 제목 중 해시가 맞는 절로 옮기고, 같은 내용이 둘이면 ambiguous 로 뺀다", () => {
    const redis = lineOf(ARCH_PATH, "## 저장소", 2);
    const cache = lineOf(ARCH_PATH, "## 캐시");
    const moved = section(ARCH_PATH, redis, redis + 1);
    const twin = section(ARCH_PATH, cache, cache + 1);
    // 커밋하지 않은 줄 두 개를 앞에 끼운다 — 두 참조의 적힌 범위가 모두 어긋난다
    write(ARCH_PATH, ARCH.replace("## 저장소", "## 메모\n- 끼운 줄\n## 저장소"));
    reply({ sections: [moved, twin] });
    const text = context(repo);
    const sha7 = head().slice(0, 7);
    assert.match(text, new RegExp(`- doc/architecture\\.md L${redis + 2}-L${redis + 3} · ## 저장소 \\[개발 지침 · 아키텍처\\] \\(agent-knowledge keyword-match · 기준 커밋 ${sha7} — 현재 파일과 일치 확인\\)`));
    assert.match(text, /\n- 검증 제외 1개 \(사유 ambiguous\) — \.code-agent\/log\/knowledge\/context\.jsonl\n/);
    const record = records().at(-1)!;
    assert.deepEqual(record.verified.map((entry: any) => [entry.start, entry.how]), [[redis + 2, "moved"]]);
    assert.deepEqual(record.rejected.map((entry: any) => entry.reason), ["ambiguous"]);
  });

  test("범위 안의 커밋하지 않은 변경은 거부 — 확인된 것이 없으면 기본 검색 + 알림 + 검증 제외 줄", () => {
    const redis = lineOf(ARCH_PATH, "## 저장소", 2);
    reply({ sections: [section(ARCH_PATH, redis, redis + 1)] });
    write(ARCH_PATH, ARCH.replace("세션은 Redis 에 저장한다.", "세션은 Memcached 에 저장한다."));
    const text = context(repo);
    assert.match(docsBlock(text), new RegExp(`^## 참고 문서 [^\\n]*\\n${escape(DEFAULT_SOURCE)}\\n- 플러그인 ak\\(context\\.docs\\) 의 항목을 현재 파일과 하나도 대조하지 못했습니다: no-verified-items — 기본 구현으로 돕니다\\.\\n`));
    assert.match(text, /- doc\/conventions\.md L\d+-L\d+ · ## 주문 등록 규칙 \[개발 지침 · 코드 컨벤션\]/);
    assert.match(text, /\n- 검증 제외 1개 \(사유 content-changed\) — \.code-agent\/log\/knowledge\/context\.jsonl\n/);
    const record = records().at(-1)!;
    assert.deepEqual([record.outcome, record.fallback], ["fallback", { code: "no-verified-items", by: "host" }]);
  });

  test("지운 문서·문서 밖·..·역슬래시 경로는 읽지 않고 거부한다 — 확인된 것만 싣는다", () => {
    const features = lineOf(FEATURES, "### `FEAT-ORDER-LIST` 주문 목록");
    const deleted = section(FEATURES, features, features + 2);
    unlinkSync(join(repo, FEATURES));
    const first = lineOf(ARCH_PATH, "## 저장소");
    const outside = (path: string) => ({ path, heading: "x", why: "y", ref: { ...ref(ARCH_PATH, first, first + 1), itemId: `kb:${path}#x` } });
    reply({ sections: [deleted, outside(LEGACY), outside("../outside.md"), outside("doc\\architecture.md"), section(ARCH_PATH, first, first + 1)] });
    const text = context(repo);
    assert.match(text, new RegExp(`- doc/architecture\\.md L${first}-L${first + 1} · ## 저장소 \\[개발 지침 · 아키텍처\\]`));
    assert.match(text, /\n- 검증 제외 4개 \(사유 not-in-docs\) — \.code-agent\/log\/knowledge\/context\.jsonl\n/);
    assert.deepEqual(records().at(-1)!.rejected.map((entry: any) => entry.path), [FEATURES, LEGACY, "../outside.md", "doc\\architecture.md"]);
  });

  test("CRLF·BOM 문서도 줄 범위와 해시가 맞는다", () => {
    const start = lineOf(FEATURES, "### `FEAT-ORDER-LIST` 주문 목록");
    reply({ sections: [section(FEATURES, start, start + 2, { unit: "entry", kind: "feature" })] });
    const text = context(repo);
    assert.match(text, new RegExp(`- doc/knowledge/features\\.md L${start}-L${start + 2} · \`FEAT-ORDER-LIST\` 주문 목록 \\[기능[^\\]]*\\] \\(agent-knowledge keyword-match\\)`));
  });

  test("상태 표시는 올리지 않는다 — 미확인·관찰·충돌·폐기·확정이지만 confirmed 아님", () => {
    const batch = lineOf(ARCH_PATH, "## 정산 배치");
    const states: [Record<string, unknown>, string][] = [
      [{ status: "unverified", confirmed: false }, "미확인 — 탐색 참고, 확정 근거 아님"],
      [{ status: "observed_behavior", confirmed: true }, "관찰 — 현재 동작, 정책 아님"],
      [{ status: "conflicted", confirmed: true }, "충돌 — 확인 필요"],
      [{ status: "deprecated", confirmed: false }, "폐기 — 쓰지 않는다"],
      [{ status: "confirmed_policy", confirmed: false }, "미확인 — 탐색 참고, 확정 근거 아님"],
    ];
    reply({ sections: states.map(([extra], index) => section(ARCH_PATH, batch + 1 + index * 2, batch + 2 + index * 2, extra)) });
    const text = context(repo);
    states.forEach(([, label], index) => {
      assert.match(text, new RegExp(`L${batch + 1 + index * 2}-L${batch + 2 + index * 2} · ## 정산 배치 \\(부분\\) \\[${escape(label)}\\]`));
    });
    assert.doesNotMatch(docsList(text), /확정 정책/);
  });

  test("어댑터가 fallback 을 내면 기본 검색 + 알림 — 출처 줄은 기본 구현", () => {
    reply({ sections: [], fallback: { code: "no-results", message: "아무것도 없음" }, diagnostics: { queries: 1 } });
    const text = context(repo);
    assert.match(docsBlock(text), new RegExp(`^## 참고 문서 [^\\n]*\\n${escape(DEFAULT_SOURCE)}\\n- 플러그인 ak\\(context\\.docs\\) 가 기본 검색을 요청했습니다: no-results — 기본 구현으로 돕니다\\.\\n`));
    assert.match(text, /- doc\/conventions\.md L\d+-L\d+ · ## 주문 등록 규칙 \[개발 지침 · 코드 컨벤션\]/);
    assert.doesNotMatch(text, /아무것도 없음|queries/, "어댑터 글·진단은 화면에 싣지 않는다");
    const record = records().at(-1)!;
    assert.deepEqual([record.outcome, record.fallback.code, record.fallback.by, record.diagnostics], ["fallback", "no-results", "adapter", { queries: 1 }]);
  });

  test("참조를 쓰지 않는 어댑터는 그대로 — 빈 sections 는 '없음', 이전 등록(accepts 없음)에는 선택 입력이 가지 않는다", () => {
    register(null);
    reply({ sections: [] });
    const empty = context(repo);
    assert.match(empty, /## 참고 문서 [^\n]*\n- 출처: 플러그인 ak\n- 없음 — 등록된 문서에서 걸리는 항목·절이 없습니다\.\n/);
    assert.deepEqual(Object.keys(seen().input), ["requirements", "docs", "limit"]);
    reply({ sections: [{ path: CONV_PATH, heading: "주문 등록 규칙", why: "플러그인 판단" }, { path: "doc/none.md", heading: "없는 절", why: "그대로" }] });
    const text = context(repo);
    assert.match(text, /- 출처: 플러그인 ak\n- doc\/conventions\.md L\d+-L\d+ · ## 주문 등록 규칙 \[개발 지침 · 코드 컨벤션\] \(플러그인 판단\)\n- doc\/none\.md · ## 없는 절 \(그대로\)\n/);
    assert.doesNotMatch(text, /검증 제외|기본 검색을 요청/);
    assert.equal(existsSync(join(repo, KNOWLEDGE_LOG)), false, "참조를 쓰지 않는 출력은 지식 기록을 남기지 않는다");
  });

  test("인계 참조 — 확인된 것은 인계 블록, 실패한 required 는 재확인 블록(어댑터 사유·호스트 대조 모두)", () => {
    const rule = lineOf(RULES, "### `BR-ORDER-01` 주문 id 는 문자열");
    const ruleRef = ref(RULES, rule, rule + 4, { unit: "entry", kind: "business-rule", pinned: true });
    const redis = lineOf(ARCH_PATH, "## 저장소", 2);
    const redisRef = ref(ARCH_PATH, redis, redis + 1, { pinned: true });
    const handed = (value: Record<string, unknown>, required = true): KnowledgeRef =>
      ({ itemId: value.itemId as string, generation: value.generation as number, commit: value.commit as string, itemSha256: value.itemSha256 as string, required });
    handoff([
      handed(ruleRef),
      handed(redisRef),
      // master 가 넘긴 해시와 어댑터가 되찾은 항목의 해시가 다르다 — 호스트가 대조해 거부한다
      { ...handed(redisRef), itemId: "kb:doc/architecture.md#other", itemSha256: "e".repeat(64) },
      { itemId: "kb:doc/architecture.md#gone", generation: 2, commit: head(), itemSha256: "f".repeat(64), required: false },
    ]);
    reply({
      sections: [],
      fallback: { code: "no-results" },
      pinned: [
        { itemId: ruleRef.itemId, ok: true, section: { path: RULES, heading: "`BR-ORDER-01` 주문 id 는 문자열", why: "master 인계", ref: ruleRef } },
        { itemId: redisRef.itemId, ok: false, reason: "generation-expired" },
        { itemId: "kb:doc/architecture.md#other", ok: true, section: { path: ARCH_PATH, heading: "저장소", why: "master 인계", ref: { ...redisRef, itemId: "kb:doc/architecture.md#other" } } },
      ],
    });
    const text = context(repo);
    assert.equal((seen().input.refs as unknown[]).length, 4);
    assert.match(text, new RegExp(`\\n\\n## 인계받은 지식 근거 \\(master — 항목·세대·해시를 현재 파일과 대조\\)\\n- doc/knowledge/business-rules\\.md L${rule}-L${rule + 4} · \`BR-ORDER-01\` 주문 id 는 문자열 \\[업무 정책 · 필수 확정\\] \\(master 인계\\)\\n`));
    assert.match(text, new RegExp(`\\n\\n## 근거 재확인 필요 \\(인계 항목 검증 실패 — 범위를 넓혀 다시 찾지 말고 이 작업의 근거를 다시 확인하거나 재계획을 요청한다\\)\\n- ${escape(redisRef.itemId as string)}: generation-expired\\n- kb:doc/architecture\\.md#other: hash-mismatch(?:\\n|$)`));
    assert.doesNotMatch(text, /#gone/);
    const record = records().at(-1)!;
    assert.deepEqual(record.pinned.map((entry: any) => [entry.ok, entry.reason ?? null]), [[true, null], [false, "generation-expired"], [false, "hash-mismatch"], [false, "not-returned"]]);
  });

  test("기록에서 꼴이 깨진 인계 참조는 어댑터 결과와 관계없이 invalid-ref", () => {
    reply({ sections: [] });
    // workKnowledge 는 꼴이 틀린 참조를 버리지 않고 빈 값으로 남긴다 — 조용히 사라지지 않고 형식 오류로 보인다
    handoff([{ itemId: "", generation: 0, commit: "", itemSha256: "", required: true }]);
    const text = context(repo);
    assert.match(text, /\n- \(항목 id 없음\): invalid-ref(?:\n|$)/);
  });

  test("인덱스 항목으로 되찾은 줄에는 낮추는 상태(관찰·충돌·폐기)만 덧붙이고, 확정·미확인 판정은 기록에만 남긴다", () => {
    const start = lineOf(RULES, "### `BR-ORDER-01` 주문 id 는 문자열");
    const entry = (extra: Record<string, unknown>) => ({ ...section(RULES, start, start + 4, { unit: "entry", kind: "business-rule", ...extra }), why: "agent-knowledge explicit-key" });
    reply({ sections: [entry({ status: "unverified", confirmed: false, declaredStatus: "confirmed_policy" })] });
    const unverified = context(repo);
    assert.match(unverified, new RegExp(`L${start}-L${start + 4} · \`BR-ORDER-01\` 주문 id 는 문자열 \\[업무 정책 · 필수 확정\\] \\(agent-knowledge explicit-key\\)\\n`));
    assert.doesNotMatch(docsList(unverified), /미확인/);
    assert.equal(records().at(-1)!.verified[0].status, "unverified", "어댑터 판정은 기록에 남는다");
    reply({ sections: [entry({ status: "deprecated", confirmed: false })] });
    assert.match(context(repo), new RegExp(`\\[업무 정책 · 필수 확정\\] \\(agent-knowledge explicit-key · 폐기 — 쓰지 않는다\\)\\n`));
  });

  test("확인한 지식 검색 결과로 목록을 갈아도 기본 검색이 고른 필수 업무 정책은 '반드시 적용' 블록에 남는다", () => {
    // 범위가 이 작업의 파일과 겹치지 않는 필수 정책 — off 에서는 기본 검색 순위(낱말 주문·등록)로만 화면에 오른다
    write(RULES, `${RULES_DOC}\n### \`BR-ORDER-03\` 주문 등록 승인\n- 구분: 필수\n- 상태: 확정\n- 출처: 사용자 결정\n- 범위: src/billing\n`);
    declare({});
    const off = context(repo);
    assert.match(docsList(off), /`BR-ORDER-03` 주문 등록 승인/);
    declare({ ak: { slots: ["context.docs"] } });
    const first = lineOf(ARCH_PATH, "## 저장소");
    reply({ sections: [section(ARCH_PATH, first, first + 1)] });
    const text = context(repo);
    assert.doesNotMatch(docsList(text), /BR-ORDER-03/);
    const block = /## 반드시 적용하는 업무 정책[^\n]*\n((?:- [^\n]*\n?)*)/.exec(text)?.[1] ?? "";
    assert.match(block, /`BR-ORDER-03` 주문 등록 승인 \[업무 정책 · 필수 확정[^\]]*\] \(기본 검색이 고름\)/);
  });

  test("어댑터가 refs 를 받지 않는 등록이면 인계 참조는 adapter-unsupported", () => {
    register(["context.docs.phase"]);
    reply({ sections: [] });
    handoff([{ itemId: "kb:doc/architecture.md#a1", generation: 2, commit: head(), itemSha256: "c".repeat(64), required: true }]);
    const text = context(repo);
    assert.equal(seen().input.refs, undefined);
    assert.match(text, /- kb:doc\/architecture\.md#a1: adapter-unsupported/);
  });
});

describe("지식 검색 연결 — shadow", () => {
  beforeEach(() => {
    newRepo();
    toImpact();
    register();
  });
  afterEach(dropRepo);

  const snapshot = (): string => consentSnapshot(repo, { action: "plan", decision: "accept", sendsCode: false });
  const status = (): string => git("status", "--porcelain", "--untracked-files=all");

  test("화면은 off 와 바이트까지 같고 비교 기록만 남긴다 — 동의 스냅샷·git status 그대로, 같은 입력은 다시 부르지 않는다", () => {
    const off = context(repo);
    declare({ ak: { shadow: ["context.docs"] } });
    const first = lineOf(ARCH_PATH, "## 저장소");
    const batch = lineOf(ARCH_PATH, "## 정산 배치");
    reply({ sections: [section(ARCH_PATH, first, first + 1), section(ARCH_PATH, batch + 3, batch + 4), section(LEGACY, 1, 1)] });
    const before = { snapshot: snapshot(), status: status() };
    const shadow = context(repo);
    assert.equal(shadow, off);
    assert.equal(calls(), 1);
    assert.deepEqual({ snapshot: snapshot(), status: status() }, before);
    const record = records().at(-1)!;
    assert.deepEqual([record.mode, record.outcome, record.plugin, record.phase], ["shadow", "compared", "ak", "impact"]);
    assert.ok(record.baseline.length > 0 && record.baseline.every((entry: any) => entry.source === "default"));
    assert.deepEqual(record.candidate.verified.map((entry: any) => [entry.start, entry.end, entry.how]), [[first, first + 1, "exact"], [batch + 3, batch + 4, "exact"]]);
    assert.deepEqual(record.candidate.rejected.map((entry: any) => entry.reason), ["not-in-docs"]);
    assert.equal(record.comparison.candidate, 2);
    assert.equal(record.comparison.baseline, record.baseline.length);
    // 기본 검색도 첫 저장소 절을 고른다(본문에 '주문') — 겹침 하나 이상, 정산 배치 덩어리는 후보에만 있다
    assert.ok(record.comparison.overlap >= 1 && record.comparison.onlyCandidate >= 1, JSON.stringify(record.comparison));
    assert.doesNotMatch(JSON.stringify(record), /PostgreSQL|정산 배치 규칙/, "본문을 싣지 않는다");
    assert.equal(seen().input.phase, "impact");

    // 같은 입력·HEAD·문서 — 다시 부르지 않는다
    assert.equal(context(repo), off);
    assert.equal(calls(), 1);
    // 등록 문서 내용이 바뀌면 입력 해시가 바뀐다
    write(CONV_PATH, `${CONV}\n- 덧붙인 줄`);
    context(repo);
    assert.equal(calls(), 2);
  });

  test("shadow 어댑터가 죽어도 화면은 off 와 같고 실패를 기록한다 — 실패한 비교는 잠시 뒤·등록을 바꾸면 다시 부른다", () => {
    const off = context(repo);
    declare({ ak: { shadow: ["context.docs"] } });
    crash();
    assert.equal(context(repo), off);
    assert.equal(calls(), 1);
    const record = records().at(-1)!;
    assert.deepEqual([record.mode, record.outcome, record.candidate.ok], ["shadow", "shadow-failed", false]);
    assert.match(record.candidate.error, /exit 3/);

    // 실패 직후 같은 입력은 다시 부르지 않는다(고장 난 연결이 context 마다 늦추지 않게)
    reply({ sections: [] });
    assert.equal(context(repo), off);
    assert.equal(calls(), 1);
    // 실패 기록이 오래되면 같은 입력이라도 다시 비교한다 — 설정·색인을 고친 뒤
    const path = join(repo, KNOWLEDGE_LOG);
    const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    writeFileSync(path, readFileSync(path, "utf-8").split("\n").filter(Boolean).map((line) => JSON.stringify({ ...JSON.parse(line), at: old })).join("\n") + "\n");
    assert.equal(context(repo), off);
    assert.equal(calls(), 2);
    assert.equal(records().at(-1)!.outcome, "compared");
    // 성공한 비교는 다시 부르지 않고, 등록이 바뀌면(다시 등록) 다시 부른다
    assert.equal(context(repo), off);
    assert.equal(calls(), 2);
    const store = readStore();
    writeStore({ ...store, plugins: { ak: { ...store.plugins.ak, adapter: { ...store.plugins.ak.adapter, describedAt: "2026-11-11T00:00:00.000Z" } } } });
    assert.equal(context(repo), off);
    assert.equal(calls(), 3);
  });

  /** 기록의 시각을 모두 ms 앞으로 옮긴다 */
  const ageLog = (ms: number): void => {
    const path = join(repo, KNOWLEDGE_LOG);
    const old = new Date(Date.now() - ms).toISOString();
    writeFileSync(path, readFileSync(path, "utf-8").split("\n").filter(Boolean).map((line) => JSON.stringify({ ...JSON.parse(line), at: old })).join("\n") + "\n");
  };
  /** 등록 명령 뒤에 인자를 더하고 어댑터 이름을 바꾼다(다시 등록하지 않은 채 같은 경로의 파일만 바뀌는 상황을 만든다) */
  const extendRegistration = (args: string[], name?: string): void => {
    const store = readStore();
    const ak = store.plugins.ak;
    writeStore({ ...store, plugins: { ak: { ...ak, command: [...ak.command, ...args], adapter: { ...ak.adapter, ...(name ? { name } : {}) } } } });
  };

  test("성공한 비교 뒤 같은 경로의 어댑터 설정 내용·생산자 설정·DB(WAL)가 바뀌면 다시 비교한다 — 바뀌지 않으면 다시 부르지 않는다", () => {
    const off = context(repo);
    const cfg = join(tools, "agent-knowledge.json");
    const sources = join(tools, "sources.json");
    const db = join(tools, "kb.db");
    const config = (project: string): string => JSON.stringify({ command: ["node", "producer.js"], sourcesConfig: "sources.json", db: "kb.db", projects: [{ root: repo, project }] });
    writeFileSync(cfg, config("orders"));
    writeFileSync(sources, "{\"sources\":[]}");
    writeFileSync(db, "db-1");
    writeFileSync(join(tools, "producer.js"), "// 생산자 1");
    extendRegistration(["--config", cfg], "agent-knowledge");
    declare({ ak: { shadow: ["context.docs"] } });
    reply({ sections: [] });
    assert.equal(context(repo), off);
    assert.equal(calls(), 1);
    assert.equal(context(repo), off);
    assert.equal(calls(), 1, "같은 입력·같은 지문");
    // 같은 경로의 설정 파일에서 프로젝트 대응만 바꾼다
    writeFileSync(cfg, config("billing"));
    assert.equal(context(repo), off);
    assert.equal(calls(), 2);
    writeFileSync(sources, "{\"sources\":[\"kb\"]}");
    context(repo);
    assert.equal(calls(), 3, "생산자 원본 설정 내용");
    writeFileSync(db, "db-2 — 다시 색인했다");
    context(repo);
    assert.equal(calls(), 4, "DB 교체·재색인(크기·수정 시각)");
    writeFileSync(`${db}-wal`, "wal");
    context(repo);
    assert.equal(calls(), 5, "WAL 에만 쓴 재색인");
    writeFileSync(join(tools, "producer.js"), "// 생산자 2 — 순위 방식이 바뀐 빌드");
    context(repo);
    assert.equal(calls(), 6, "생산자 명령 파일");
    assert.equal(context(repo), off);
    assert.equal(calls(), 6);
    assert.equal(new Set(records().map((record) => record.inputHash)).size, 6, "비교마다 다른 지문이다");
  });

  test("성공한 비교는 60분 뒤 다시 비교하고, CODE_AGENT_SHADOW_REFRESH=1 이면 바로 다시 비교한다", () => {
    const off = context(repo);
    declare({ ak: { shadow: ["context.docs"] } });
    reply({ sections: [] });
    context(repo);
    assert.equal(calls(), 1);
    ageLog(59 * 60 * 1000);
    assert.equal(context(repo), off);
    assert.equal(calls(), 1, "60분 안의 성공은 다시 쓴다");
    ageLog(61 * 60 * 1000);
    assert.equal(context(repo), off);
    assert.equal(calls(), 2, "60분이 지난 성공은 다시 비교한다");
    const before = process.env[SHADOW_REFRESH_ENV];
    process.env[SHADOW_REFRESH_ENV] = "1";
    try {
      assert.equal(context(repo), off);
      assert.equal(calls(), 3, "강제 갱신");
      context(repo);
      assert.equal(calls(), 4);
    } finally {
      if (before === undefined) delete process.env[SHADOW_REFRESH_ENV]; else process.env[SHADOW_REFRESH_ENV] = before;
    }
    context(repo);
    assert.equal(calls(), 4, "강제 갱신을 끄면 방금 비교를 다시 쓴다");
    assert.equal(records().at(-1)!.outcome, "compared");
  });

  test("갱신 실패는 이전 성공을 지금 비교로 남기지 않는다 — 실패를 잠시 억제하되 설정을 고치면 바로 다시 부른다", () => {
    const off = context(repo);
    const cfg = join(tools, "adapter.json");
    writeFileSync(cfg, "{\"v\":1}");
    extendRegistration(["--config", cfg]);
    declare({ ak: { shadow: ["context.docs"] } });
    reply({ sections: [] });
    context(repo);
    const success = records().at(-1)!;
    assert.equal(success.outcome, "compared");
    writeFileSync(cfg, "{\"v\":2}");
    crash();
    assert.equal(context(repo), off, "실패해도 화면은 off 와 같다");
    assert.equal(calls(), 2);
    const failed = records().at(-1)!;
    assert.equal(failed.outcome, "shadow-failed");
    assert.notEqual(failed.inputHash, success.inputHash, "실패는 새 지문의 기록이다 — 이전 성공이 지금 설정의 비교가 아니다");
    context(repo);
    assert.equal(calls(), 2, "같은 지문의 실패는 잠시 다시 부르지 않는다");
    writeFileSync(cfg, "{\"v\":3}");
    reply({ sections: [] });
    context(repo);
    assert.equal(calls(), 3, "설정을 고치면 억제 시간을 기다리지 않는다");
    assert.equal(records().at(-1)!.outcome, "compared");
  });

  test("등록 지문에 저장소 경로가 들어간다 — 다른 저장소의 비교를 다시 쓰지 않는다", () => {
    const plugin = readStore().plugins.ak;
    assert.notEqual(registrationFingerprint(repo, plugin), registrationFingerprint(join(repo, "..", "다른-저장소"), plugin));
    assert.equal(registrationFingerprint(repo, plugin), registrationFingerprint(repo, plugin));
  });

  test("shadow 선언이 있어도 등록이 없으면 부르지도 기록하지도 않는다", () => {
    const off = context(repo);
    writeStore({ ...readStore(), plugins: {} });
    declare({ ak: { shadow: ["context.docs"] } });
    assert.equal(context(repo), off);
    assert.equal(calls(), 0);
    assert.equal(existsSync(join(repo, KNOWLEDGE_LOG)), false);
  });
});

describe("지식 검색 연결 — 선택 입력", () => {
  test("작업 파일은 저장소 기준 상대 경로만 싣는다 — 영향 범위 표에서 뽑힌 엔드포인트·저장소 밖 경로는 뺀다", () => {
    const input = optionalDocsInput("design", ["src/a.ts", "./src/b.ts", "src\\c.ts", "src/dir/", "/api/orders/refund", "../shared/money.ts", "C:/x/y.ts", "//host/path", "src/a.ts"], undefined);
    assert.deepEqual(input, { phase: "design", files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/dir"] });
    assert.deepEqual(optionalDocsInput(undefined, ["/member/**"], []), {}, "남는 것이 없으면 싣지 않는다");
  });
});
