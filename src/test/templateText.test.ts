/**
 * 템플릿 문장의 동기 — Codex 문장째 치환의 원문(`CODEX_SENTENCES`), 계획 스킬 4개의 공통 항목, 17개 스킬의 공통 질문·동의 문단.
 * 어긋나면 오류 없이 치환이 빠지거나 스킬마다 규칙이 갈린다.
 */
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { CODEX_SENTENCES, hostAssets } from "../agent/hosts";
import { POWERSHELL_COMMAND_GUIDE } from "../agent/hostText";
import { normalizeReviewTable, reviewResultProblems } from "../agent/crossRecord";
import { PHASES } from "../agent/layout";

const TEMPLATE = join(__dirname, "../../template/claude");
function claudeTexts(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".md")) out.set(`${prefix}${entry.name}`, readFileSync(join(dir, entry.name), "utf8").replace(/\r\n/g, "\n"));
    }
  };
  walk(TEMPLATE, "");
  return out;
}
const skill = (name: string): string => readFileSync(join(TEMPLATE, "skills", name, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");

test("3-1 두 호스트는 테스트 단계가 없을 때 구현 담당에게 계획된 TC 작성을 맡긴다", () => {
  for (const host of ["claude", "codex"] as const) {
    const assets = hostAssets(host), prefix = host === "claude" ? ".claude" : ".agents";
    const role = assets.get(host === "claude" ? ".claude/agents/ca-implementer.md" : ".codex/agents/ca-implementer.toml")!;
    assert.match(role, /없으면 현재 계획 파일의 테스트도/);
    assert.match(assets.get(`${prefix}/skills/ca-implement/SKILL.md`)!, /없으면 구현 담당이 계획된 테스트도/);
    assert.match(assets.get(`${prefix}/skills/ca-check/SKILL.md`)!, /없으면 implementer/);
    assert.match(assets.get(`${prefix}/skills/ca-test/SKILL.md`)!, /없으면 계획 파일만 쓰는/);
  }
});

test("Codex 하위 에이전트 지침과 AGENTS.md 블록은 PowerShell .cmd 호출과 대화 응답 예외를 안내한다 — 스킬 사본은 블록을 늘 싣는 메인이 읽어 꼬리말이 없다", () => {
  for (const [path, text] of hostAssets("codex")) {
    if (path.startsWith(".codex/agents/")) assert.ok(text.includes(POWERSHELL_COMMAND_GUIDE), path);
    else if (path !== ".agents/skills/ca-answer/SKILL.md") assert.ok(!text.includes(POWERSHELL_COMMAND_GUIDE), `스킬 사본에 꼬리말이 붙었습니다: ${path}`);
    assert.doesNotMatch(text, /code-agent\.cmd consent respond/, path);
    assert.doesNotMatch(text, /\.code-agent\.cmd|code-agent\.cmd\.json/, path);
  }
  const block = readFileSync(join(TEMPLATE, "../CODEX.block.md"), "utf8");
  assert.ok(block.includes(POWERSHELL_COMMAND_GUIDE));
  for (const [path, text] of hostAssets("claude")) assert.doesNotMatch(text, /code-agent\.cmd/, path);
});

test("codexText 고정 문장 치환의 원문은 Claude 템플릿 하나 이상에 있고 Codex 사본에는 남지 않는다", () => {
  const claude = [...claudeTexts().values()];
  const codex = [...hostAssets("codex").values()];
  for (const [from] of CODEX_SENTENCES) {
    assert.ok(claude.some((text) => text.includes(from)), `codexText 고정 문장이 템플릿에 없습니다: ${from.slice(0, 30)}`);
    assert.ok(!codex.some((text) => text.includes(from)), `Codex 사본에 치환되지 않은 문장이 남았습니다: ${from.slice(0, 30)}`);
  }
});

test("계획 스킬 넷은 두 호스트에서 공통 계약을 읽고 action별 next와 되감기 조건을 따른다", () => {
  for (const host of ["claude", "codex"] as const) {
    const prefix = host === "claude" ? ".claude" : ".agents", assets = hostAssets(host);
    const contract = assets.get(`${prefix}/skills/ca-plan/contract.md`)!;
    for (const phrase of ["assignmentFile", "run_in_background", "staging", "`cancel` 목록", "rewind.auto", "chain.gate", "사용자가 되돌리라고 말했을 때만"]) {
      if (host === "codex" && phrase === "run_in_background") continue;
      assert.ok(contract.includes(phrase), `${host}: ${phrase}`);
    }
    for (const name of ["ca-analyze", "ca-impact", "ca-design", "ca-plan"]) {
      const text = assets.get(`${prefix}/skills/${name}/SKILL.md`)!;
      assert.ok(text.includes(`${prefix}/skills/ca-plan/contract.md`), name);
      assert.match(text, /명령 전에.*공통 진행·되감기.*읽고 따른다/);
      assert.doesNotMatch(text, /2\. 이후는 출력의 `next`/);
    }
  }
  // 연쇄는 program 게이트 단계만 — 계획 제출·승인(사람 확인)은 잇지 않는다
  for (const name of ["ca-analyze", "ca-impact", "ca-design"]) assert.match(skill(name), /^1\. Bash: `code-agent planning advance --chain`/m, name);
  assert.doesNotMatch(skill("ca-plan"), /--chain/);
});

test("질문·동의 공통 문단은 17개 스킬에서 같은 글자다", () => {
  const skills = readdirSync(join(TEMPLATE, "skills")).filter((name) => name !== "ca-answer");
  const lines = skills.map((name) => [name, skill(name).split("\n").filter((line) => line.startsWith("**질문·동의** —"))] as const);
  assert.equal(lines.length, 17);
  for (const [name, found] of lines) assert.equal(found.length, 1, name);
  const reference = lines[0][1][0];
  assert.match(reference, /이 대화에서 아직 읽지 않았거나 대화가 압축·비워진 뒤라면 그 직전에 읽는다/);
  assert.match(reference, /reference\.md.*차단 복구/);
  assert.match(reference, /AskUserQuestion.*실제 호출/);
  for (const [name, found] of lines) assert.equal(found[0], reference, `공통 문단이 다릅니다: ${name}`);
});

test("두 호스트의 모든 진입은 복구로 연결하고 업무 선택 도구와 동의를 구분한다", () => {
  for (const host of ["claude", "codex"] as const) {
    const assets = hostAssets(host);
    const prefix = host === "claude" ? ".claude" : ".agents";
    const answer = assets.get(`${prefix}/skills/ca-answer/SKILL.md`)!;
    const recovery = assets.get(`${prefix}/skills/ca-answer/reference.md`)!;
    assert.match(answer, /reference\.md.*차단 복구/);
    assert.match(answer, /허용된 도움말·상태 조회.*재확인 없이/);
    assert.match(answer, /실제 호출 결과 없이.*보고하지 않는다/);
    assert.match(recovery, /planning --help.*code-agent help/);
    assert.match(recovery, /이미 선택한 방향.*계속한다/);
    assert.match(recovery, /새 결정에 의존하는 동작만/);
    for (const [path, text] of assets) {
      if (!path.endsWith("/SKILL.md") || path.endsWith("ca-answer/SKILL.md")) continue;
      assert.match(text, /reference\.md.*차단 복구/, path);
      assert.doesNotMatch(text, /거부하면 사유를 전하고 멈춘다|명령 자체가 거부되면 사유를 보고하고 멈춘다/, path);
    }
    const docs = assets.get(`${prefix}/skills/ca-docs/SKILL.md`)!;
    assert.match(docs, /사용자가 특정 방식을 이미 요청했으면 바로 그 절차를 따른다/);
    if (host === "codex") {
      assert.match(answer, /request_user_input_async/);
      assert.match(answer, /request_user_input.*모드 제한을 우회하지 않는다/);
      assert.match(answer, /mcp__code_agent__ask/);
      assert.match(answer, /mcp__code_agent__confirm/);
      assert.match(answer, /방향키.*Enter/);
      assert.match(answer, /번호 입력을 선택 UI의 대체 완료로 보고하지 않는다/);
      assert.match(answer, /승인은 이 도구의 답으로 처리하지 않고/);
      assert.match(answer, /UserPromptSubmit/);
    } else {
      assert.match(answer, /AskUserQuestion.*실제로 호출/);
      assert.match(answer, /도구가 없거나 호출이 거부되면/);
      assert.match(answer, /대화 답을 관찰된 도구 응답이나 승인으로 기록하지 않는다/);
    }
  }
});

test("단계별 선택 표는 전체 단계와 접수·준비·재개를 다루고 UZRF-392의 미응답 정책 질문을 연결한다", () => {
  for (const host of ["claude", "codex"] as const) {
    const assets = hostAssets(host);
    const prefix = host === "claude" ? ".claude" : ".agents";
    const get = (name: string, file = "SKILL.md") => assets.get(`${prefix}/skills/${name}/${file}`)!;
    const reference = get("ca-answer", "reference.md");
    for (const phase of PHASES) assert.ok(reference.includes(`| ${phase} |`), `${host}: ${phase}`);
    for (const [path, text] of assets) {
      if (!path.endsWith("/SKILL.md")) continue;
      assert.match(text, /단계별 선택/, path);
    }
    for (const name of ["ca-adopt", "ca-docs", "ca-request", "ca-feature", "ca-fix", "ca-refactor", "ca-next", "ca-status", "ca-answer"]) {
      assert.ok(reference.includes(name), `${host}: ${name}`);
    }
    assert.match(reference, /이미 준 지시·답·설정.*계속한다/);
    assert.match(reference, host === "claude" ? /도구가 없거나 표시가 실패하면 설치·hook·호스트 지원/ : /MCP 선택 UI가 없거나 표시가 실패하면 doctor/);
    assert.match(reference, /복구 후 같은 질문을 UI로 표시한다/);
    assert.doesNotMatch(reference, /번호·선택지·결과를 대화에 제시하고 실제 답을 기다린다/);
    assert.match(reference, /업무 답으로 동의를 대체하지 않는다/);
    assert.match(reference, /선택지 없이 특정 문구 입력만 요청한 안내는 질문 제시 완료로 보지 않는다/);
    assert.match(get("ca-request"), /초안 저장 보고만 하고 끝내지 않는다/);
    assert.match(get("ca-request"), /미응답 질문의 내용·선택지를 같은 턴에 질문 도구로 제시/);
    assert.match(get("ca-docs"), /테스트 기준.*품질 기준.*독립 질문/);
    assert.match(get("ca-docs"), /제안 기준 사용.*항목 수정.*보류/);
    assert.match(get("ca-docs"), /특정 문구 입력으로 대신하지 않는다/);
    assert.match(get("ca-docs"), /문서 확정·준비 커밋 동의는 6에서 따로/);
  }
});

test("H7 ca-* 담당을 부르는 Claude 스킬 문장마다 Agent 도구를 run_in_background: false 로 부르게 하고, Codex 사본은 결과를 기다리는 문장으로 바꾼다", () => {
  // claude 2.1.293 은 run_in_background 를 주지 않은 Agent 호출을 백그라운드로 띄운 일이 있다 — 결과 전에 메인 차례가 끝나지 않게 한다
  const FOREGROUND = "Agent 도구는 `run_in_background: false` 로 부른다(결과를 받아야 다음 단계로 간다).";
  const CODEX = "담당의 결과를 받을 때까지 기다린 뒤 다음 단계로 간다.";
  assert.ok(CODEX_SENTENCES.some(([from, to]) => from === FOREGROUND && to === CODEX), "codexText 치환이 없습니다");
  // 역할 이름 없이 부르는 다시 맡기기(ca-implement 5항 '같은 서브에이전트에게 그 Task만 한 번 더 맡긴다')도 담당 호출이다
  const call = /`ca-(?:analyst|explorer|writer|critic|reviewer|implementer|surveyor|tester)`[^\n]*?(?:부른다|맡긴다|쓰게 한다|옮기게 한다|요청한다|검토를 받는다)|`agent` 서브에이전트를 호출|서브에이전트에게[^\n]*?맡긴다/;
  const codex = hostAssets("codex");
  let calls = 0;
  for (const [path, text] of claudeTexts()) {
    // SKILL.md 와 필요할 때 읽는 보조 문서(legacy.md 등 — 이전 버전 작업 절차도 담당을 부른다)
    if (!path.startsWith("skills/") || !path.endsWith(".md")) continue;
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (!call.test(line)) return;
      calls += 1;
      assert.ok(`${line}\n${lines[index + 1] ?? ""}`.includes(FOREGROUND), `${path}:${index + 1} 담당 호출에 전경 실행 문장이 없습니다: ${line.slice(0, 60)}`);
    });
    const copy = codex.get(`.agents/${path}`);
    if (copy === undefined || path.startsWith("skills/ca-answer/")) continue;
    assert.equal(copy.split(CODEX).length, text.split(FOREGROUND).length, `${path} 의 Codex 사본에 기다림 문장 수가 다릅니다`);
    assert.doesNotMatch(copy, /run_in_background|Agent 도구/, path);
  }
  // 계획 스킬 4개·ca-review·ca-implement 둘(2항 호출·5항 다시 맡기기)·ca-test·ca-check·ca-docs 둘·ca-adopt, 이전 버전 절차(legacy.md) — 분석·설계·계획 하나씩·영향도 둘
  assert.equal(calls, 14, "계획 네 스킬의 호출 문장은 공통 계약의 한 문장으로 모인다");
});

/**
 * 머리말 값은 YAML 평문 스칼라로 안전해야 한다 — `[`·`{` 등으로 시작하거나 `: `·` #` 가 든 값은 YAML 이 다른 꼴로 읽거나 머리말 전체를
 * 버린다(스킬 목록에 description 대신 본문 첫 문단이 뜬다). 그런 값은 큰따옴표로 감싸고, 감싼 값은 이스케이프 없는 한 줄이어야 한다.
 */
function frontmatterProblems(path: string, text: string): string[] {
  const header = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, "\n"));
  if (!header) return [];
  const problems: string[] = [];
  for (const line of header[1].split("\n")) {
    const pair = /^([A-Za-z][\w-]*): (.*)$/.exec(line);
    if (!pair) { problems.push(`${path}: 키: 값 꼴이 아닌 줄 — ${line}`); continue; }
    const value = pair[2];
    if (value.startsWith("\"")) {
      if (!/^"[^"\\]*"$/.test(value)) problems.push(`${path}: ${pair[1]} 큰따옴표 값이 한 줄로 닫히지 않습니다`);
    } else if (/^[[\]{}*&!|>'%@`#,?:-]/.test(value) || /: | #|:$/.test(value)) {
      problems.push(`${path}: ${pair[1]} 값을 큰따옴표로 감싸야 합니다 — ${value.slice(0, 40)}`);
    }
  }
  return problems;
}

test("두 호스트 사본의 머리말은 YAML 로 안전하다 — argument-hint 가 `[` 로 시작하면 큰따옴표로 감싼다", () => {
  const problems = [...hostAssets("claude"), ...hostAssets("codex")].flatMap(([path, text]) => frontmatterProblems(path, text));
  assert.deepEqual(problems, []);
  assert.deepEqual(frontmatterProblems("x", "---\nname: a\nargument-hint: [ID] <서술>\n---\n"), ["x: argument-hint 값을 큰따옴표로 감싸야 합니다 — [ID] <서술>"]);
  assert.match(skill("ca-feature"), /^argument-hint: "\[ID\] /m);
});


test("3-4 리뷰 봉투는 계획 파일과 AC 형식을 지침·검사에서 함께 제한한다", () => {
  const planned = ["src/a.ts"], pattern = /^F\d+$/;
  const good = JSON.stringify({ findings: "- 없음", checked: [{ path: planned[0], acceptance: ["AC-R1-1"] }] });
  assert.equal(normalizeReviewTable(good, planned, pattern).body, "- 없음");
  for (const body of [good.replace("src/a.ts", "outside.ts"), good.replace("AC-R1-1", "AC-1")]) {
    assert.ok(reviewResultProblems(normalizeReviewTable(body, planned, pattern).body, planned, pattern).length);
  }
  for (const host of ["claude", "codex"] as const) {
    const text = [...hostAssets(host)].find(([path]) => /ca-reviewer\.(md|toml)$/.test(path))![1];
    assert.match(text, /계획 밖 파일은 제외/); assert.match(text, /AC-R<n>-<m>/);
  }
});

test("3-5 Codex 블록의 검증·비밀값·언어 규칙과 조사 담당 수정 도구가 일치한다", () => {
  const block = readFileSync(join(TEMPLATE, "../CODEX.block.md"), "utf8");
  for (const text of ["직접 돌린 빌드·테스트는 게이트를 열지 못한다", "비밀값은 질문·요약·JSON·명령 인자에 넣지 않는다", "사용자가 쓰는 언어로"]) assert.ok(block.includes(text), text);
  assert.match(readFileSync(join(TEMPLATE, "agents/ca-explorer.md"), "utf8"), /^tools: .*Write, Edit$/m);
  for (const host of ["claude", "codex"] as const) {
    const prefix = host === "claude" ? ".claude" : ".agents", assets = hostAssets(host);
    assert.match(assets.get(prefix + "/skills/ca-review/SKILL.md")!, /update --templates-only/);
    assert.match(assets.get(prefix + "/skills/ca-answer/reference.md")!, /code_agent.confirm.*사용자가 요청한 호환 경로/);
  }
});
