/**
 * 문서 생성 블록과 흐름도·코드 대조 — doc/process-flow.md 의 표 가운데 코드가 원천인 것은 코드와 맞아야 한다.
 *
 * 생성 블록은 `<!-- generated:<이름> -->` 줄과 `<!-- /generated:<이름> -->` 줄 사이다. 줄바꿈(CRLF·LF) 차이만 무시한다.
 * 고칠 때는 문서를 손으로 고치지 말고 원천(예: retryPolicy.ts POLICIES)을 고친 뒤 렌더 결과를 다시 붙인다.
 *
 * 손으로 쓴 표 가운데 코드의 목록·순서·기본값을 옮긴 칸도 대조한다(흐름도 유지 장치) — §4.1 동의 동작 ↔ consent.ts ActionSchema·
 * consentState.ts CONSENT_TITLES, §5.1·§5.2 hook 등록표 ↔ init 이 실제로 설치하는 settings.json·hooks.json(임시 저장소에 init),
 * §3.2 스테이지 ↔ layout.ts PHASES, §7 모델 기본값 ↔ modelPolicy.ts ROLE_POLICY·TIER_DEFAULTS. 문서가 다르면 문서를 고친다.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { CONSENT_ACTIONS } from "../agent/consent";
import { CONSENT_TITLES } from "../agent/consentState";
import { init } from "../agent/init";
import { PHASES } from "../agent/layout";
import { AGENTS, ROLE_POLICY, TIER_DEFAULTS, TIER_LABEL } from "../agent/modelPolicy";
import { renderRetryPolicyTable } from "../agent/retryPolicy";

const DOC = join(__dirname, "..", "..", "doc", "process-flow.md");
const doc = (): string => readFileSync(DOC, "utf8").replace(/\r\n?/g, "\n");

function generatedBlock(text: string, name: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const open = `<!-- generated:${name} -->\n`, close = `\n<!-- /generated:${name} -->`;
  const start = normalized.indexOf(open);
  assert.ok(start >= 0, `${open.trim()} 줄이 없습니다`);
  assert.equal(normalized.indexOf(open, start + 1), -1, `${open.trim()} 블록이 둘 이상입니다`);
  const end = normalized.indexOf(close, start + open.length);
  assert.ok(end >= 0, `${close.trim()} 줄이 없습니다`);
  return normalized.slice(start + open.length, end);
}

/** 제목 줄(`### 4.1 …`)로 시작하는 절의 본문 — 다음 같은 수준 이상의 제목 전까지 */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const from = lines.findIndex((line) => line.startsWith(heading));
  assert.ok(from >= 0, `${heading} 절이 없습니다`);
  const level = /^#+/.exec(lines[from])![0].length;
  const to = lines.findIndex((line, index) => index > from && /^#+\s/.test(line) && /^#+/.exec(line)![0].length <= level);
  return lines.slice(from + 1, to < 0 ? lines.length : to).join("\n");
}

/** 마크다운 표의 본문 행 — 머리 줄이 header 로 시작하는 첫 표. 칸은 `\|` 를 글자 그대로 둔다 */
function tableRows(text: string, header: string): string[][] {
  const lines = text.split("\n");
  const from = lines.findIndex((line) => line.startsWith(header));
  assert.ok(from >= 0, `${header} 표가 없습니다`);
  const rows: string[][] = [];
  for (const line of lines.slice(from + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(line.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim()));
  }
  return rows;
}
/** 칸의 코드 글자 — 백틱을 벗기고 `\|` 를 `|` 로 */
const code = (cell: string): string => cell.replace(/`/g, "").replace(/\\\|/g, "|").trim();

test("process-flow.md §6.4 재시도 규약 표는 renderRetryPolicyTable() 출력과 같다", () => {
  const block = generatedBlock(readFileSync(DOC, "utf8"), "retry-policy");
  assert.equal(block, renderRetryPolicyTable(),
    "doc/process-flow.md 의 generated:retry-policy 블록을 renderRetryPolicyTable() 출력으로 다시 붙이세요 — " +
    "node -e \"process.stdout.write(require('./dist/agent/retryPolicy').renderRetryPolicyTable())\"");
});

test("생성 블록 추출은 줄바꿈 차이를 무시하고 표지가 빠지면 실패한다", () => {
  assert.equal(generatedBlock("앞\r\n<!-- generated:x -->\r\n| a |\r\n| b |\r\n<!-- /generated:x -->\r\n뒤", "x"), "| a |\n| b |");
  assert.throws(() => generatedBlock("<!-- generated:x -->\n| a |\n", "x"), /\/generated:x/);
  assert.throws(() => generatedBlock("| a |", "x"), /generated:x/);
});

test("§4.1 동의 동작 표는 consent.ts ActionSchema(CONSENT_ACTIONS)와 같은 동작을 같은 순서로 적고, 제목은 CONSENT_TITLES 다", () => {
  const rows = tableRows(section(doc(), "### 4.1 "), "| action | 제목 |");
  const actions = rows.flatMap((row) => code(row[0]).split(/\s*·\s*/));
  assert.deepEqual(actions, [...CONSENT_ACTIONS], "§4.1 표의 action 칸을 consent.ts ActionSchema 순서대로 맞추세요");
  for (const row of rows) {
    const names = code(row[0]).split(/\s*·\s*/) as (keyof typeof CONSENT_TITLES)[];
    if (names.length === 1) assert.equal(row[1], CONSENT_TITLES[names[0]], `${names[0]} 의 제목`);
    else {
      // 묶은 행은 같은 머리말을 한 번만 쓴다 — 플러그인 등록 · 플러그인 제거 → 플러그인 등록·제거
      const titles = names.map((name) => CONSENT_TITLES[name]);
      const head = titles[0].slice(0, titles[0].lastIndexOf(" ") + 1);
      assert.ok(titles.every((title) => title.startsWith(head)), `${names.join("·")} 의 제목 머리말`);
      assert.equal(row[1], head + titles.map((title) => title.slice(head.length)).join("·"), `${names.join("·")} 의 제목(묶은 행)`);
    }
  }
});

test("§3.2 커서 단계 표의 단계는 layout.ts PHASES 와 같은 순서다", () => {
  const rows = tableRows(section(doc(), "### 3.2 "), "| 단계 |");
  assert.deepEqual(rows.map((row) => code(row[0])), [...PHASES]);
});

test("§7 모델 기본값 행은 modelPolicy.ts ROLE_POLICY·TIER_DEFAULTS 와 같다", () => {
  const row = tableRows(section(doc(), "## 7. "), "| 항목 | Claude | Codex |").find((cells) => cells[0] === "모델 기본값");
  assert.ok(row, "§7 표에 모델 기본값 행이 없습니다");
  const [, claude, codex] = row!;
  const judgment = AGENTS.filter((agent) => ROLE_POLICY[agent].tier === "judgment");
  const { judgment: j, execution: e } = TIER_DEFAULTS;
  assert.ok(claude.includes(`${TIER_LABEL.judgment}(${judgment.join("·")}) ${j.claude.model}/${j.claude.effort}`), `판단 역할·기본값: ${claude}`);
  assert.ok(claude.includes(`${TIER_LABEL.execution}(그 밖) ${e.claude.model}/${e.claude.effort}`), `실행 기본값: ${claude}`);
  for (const model of new Set([j.codex.model, e.codex.model])) assert.ok(codex.includes(`\`${model}\``), `Codex 모델 ${model}: ${codex}`);
  assert.ok(codex.includes(`${TIER_LABEL.judgment} ${j.codex.reasoning}`) && codex.includes(`${TIER_LABEL.execution} ${e.codex.reasoning}`), `Codex 강도: ${codex}`);
});

test("§5.1·§5.2 hook 등록표는 init --host both 가 실제로 설치하는 settings.json·hooks.json 과 같다", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-docsync-")));
  try {
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: root });
    init(root, { host: "both" });
    const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8")) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string; commandWindows?: string }[] }[]>;
    };
    // Claude — (이벤트, matcher, 하위 명령) 집합
    const claude = read(".claude/settings.json");
    const installed = Object.entries(claude.hooks).flatMap(([event, entries]) => entries.flatMap((entry) =>
      entry.hooks.map((hook) => `${event} | ${entry.matcher ?? "없음"} | ${hook.command.split(/\s+/).at(-1)}`))).sort();
    const rows = tableRows(section(doc(), "### 5.1 "), "| 이벤트 | matcher |");
    const documented = rows.flatMap((row) => {
      const events = code(row[0]).split(/\s*·\s*/).map((event, _, all) => all.length > 1 && event === "Stop" ? "SubagentStop" : event);
      return events.map((event) => `${event} | ${code(row[1])} | ${code(row[2])}`);
    }).sort();
    assert.deepEqual(documented, installed, "§5.1 표의 이벤트·matcher·하위 명령을 init.ts 가 설치하는 .claude/settings.json 에 맞추세요");
    // Codex — 이벤트 집합, matcher 없음, 모두 codex-event, PreToolUse 만 `|| exit 2`. commandWindows 는 모든 이벤트에 있고(cmd /c),
    // PreToolUse 는 실패를 2 로 닫고 UserPromptSubmit 은 종료 코드를 넘긴다(H3 — 문서 §5.2 표 앞 문단·목록이 같은 꼴을 적는다)
    const codex = read(".codex/hooks.json");
    const codexRows = tableRows(section(doc(), "### 5.2 "), "| 이벤트 | 처리 |");
    const codexDocumented = codexRows.flatMap((row) => code(row[0]).split(/\s*·\s*/).map((event, _, all) => all.length > 1 && event === "Stop" ? "SubagentStop" : event)).sort();
    assert.deepEqual(codexDocumented, Object.keys(codex.hooks).sort(), "§5.2 표의 이벤트를 .codex/hooks.json 에 맞추세요");
    // 표 앞의 첫 문단과 그 목록(Windows 명령·설치 점검·신뢰·종료 코드·지연 로드)
    const intro = section(doc(), "### 5.2 "), lead = intro.slice(0, intro.search(/^\|/m)).trim();
    assert.match(lead, new RegExp(`^${["", "일", "이", "삼", "사", "다섯", "여섯"][Object.keys(codex.hooks).length] ?? ""} ?이벤트가 matcher 없이 모두 \`code-agent codex-event\``));
    for (const [event, entries] of Object.entries(codex.hooks)) {
      for (const entry of entries) {
        assert.equal(entry.matcher, undefined, `${event} 에 matcher 가 없다`);
        for (const hook of entry.hooks) {
          if (event === "PreToolUse") {
            assert.match(hook.command, /codex-event \|\| exit 2$/);
            assert.equal(hook.commandWindows, "cmd /c code-agent codex-event; if ($LASTEXITCODE -ne 0) { exit 2 }");
          } else {
            assert.match(hook.command, /codex-event$/, `${event} 는 래핑하지 않는다`);
            assert.equal(hook.commandWindows, event === "UserPromptSubmit" ? "cmd /c code-agent codex-event; exit $LASTEXITCODE" : "cmd /c code-agent codex-event", event);
          }
          if (hook.commandWindows) assert.ok(lead.includes(`\`${hook.commandWindows}\``), `§5.2 표 앞 문단·목록에 ${event} 의 Windows 명령 \`${hook.commandWindows}\` 을 적으세요`);
        }
      }
    }
  } finally {
    const temporary = realpathSync.native(tmpdir()), target = resolve(root);
    assert.ok(target.startsWith(temporary + sep));
    rmSync(target, { recursive: true, force: true });
  }
});
