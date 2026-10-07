import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { Module } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { assetKeys, assetText, CLAUDE_ASSETS, installedPath, isPackaged, packageVersion } from "../agent/assets";
import { checkProjectDocs, recordDocConfirmation } from "../agent/docs";
import { doctor, npmCli } from "../agent/doctor";
import { init } from "../agent/init";
import { documentEntries, existingEntry, removeEntry } from "../agent/knowledge";
import { codeRefs, knowledgeList, knowledgePrune, missingRefs, pruneCandidates } from "../agent/knowledgeCommands";
import { logStage, readStages, saveActive, STAGES_LOG, STATE_DIR } from "../agent/layout";
import { MODELS_FILE } from "../agent/models";
import { Stop } from "../agent/stop";
import { update } from "../agent/update";
import { commandKey, encodeRepoPath, usage, usageReport } from "../agent/usage";
import { unwrapShellArgv } from "../agent/codexUsage";
import { retryReports } from "../agent/retryReport";
import { loadManifestIfAny } from "../agent/work";

/**
 * P8 — 단일 실행 파일(자원 해석) · doctor · update.
 *
 * 임시 디렉토리에 실제 함수를 그대로 부른다. 단일 실행 파일 모드는 `node:sea` 를 가짜로 바꿔 흉내낸다 —
 * 빌트인 모듈이라 `require.cache` 로는 못 바꾸고 모듈 로더를 잠깐 가로채야 한다.
 */

let repo: string;

/** dist/test 기준 — hook 명령이 **실제로 있는 파일**을 가리키게 한다 (검사 5가 그것을 본다) */
const CLI = join(__dirname, "..", "agent", "cli.js");

function write(path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function read(path: string): string {
  return readFileSync(join(repo, path), "utf-8");
}

beforeEach(() => {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-p8-")));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

// ---- 자원 해석 ----

/** 번들이 담는 것과 같은 자원 묶음 — scripts/build-bin.js 의 assets 와 같은 키다 */
function bundleAssets(): Record<string, string> {
  const assets: Record<string, string> = { "package.json": assetText("package.json") };
  for (const key of [...assetKeys(CLAUDE_ASSETS), "template/CLAUDE.block.md"]) assets[key] = assetText(key);
  return assets;
}

/**
 * 단일 실행 파일 모드로 몸통을 돈다. `node:sea` 를 가짜로 바꾸고 자원 모듈을 새로 읽는다 —
 * `init` 도 같이 새로 읽어야 그 안의 `./assets` 가 가짜를 쓴다.
 */
function withFakeSea<T>(assets: Record<string, string>, body: (loaded: { assets: typeof import("../agent/assets"); init: typeof import("../agent/init") }) => T): T {
  const fake = {
    isSea: () => true,
    getAsset: (key: string) => {
      const text = assets[key];
      if (text === undefined) throw new Error(`자원이 없습니다: ${key}`);
      return text;
    },
    getRawAsset: (key: string) => {
      const text = assets[key];
      if (text === undefined) throw new Error(`자원이 없습니다: ${key}`);
      const bytes = Buffer.from(text, "utf-8");
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    getAssetKeys: () => Object.keys(assets),
  };
  const loader = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
  const original = loader._load;
  const paths = [require.resolve("../agent/assets"), require.resolve("../agent/init")];
  const saved = paths.map((path) => require.cache[path]);
  loader._load = function (request: string, parent: unknown, isMain: boolean) {
    return request === "node:sea" ? fake : original.call(this, request, parent, isMain);
  };
  for (const path of paths) delete require.cache[path];
  try {
    return body({ assets: require("../agent/assets"), init: require("../agent/init") });
  } finally {
    loader._load = original;
    paths.forEach((path, index) => {
      const module = saved[index];
      if (module) require.cache[path] = module;
      else delete require.cache[path];
    });
  }
}

describe("P8 · 자원 해석 — 두 모드가 같은 키를 쓴다", () => {
  test("npm 모드: 키는 패키지 루트 기준 `/` 상대경로이고 정렬돼 있다", () => {
    const keys = assetKeys(CLAUDE_ASSETS);
    assert.equal(isPackaged(), false);
    assert.deepEqual(keys, [...keys].sort());
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(keys.every((key) => key.startsWith(`${CLAUDE_ASSETS}/`) && !key.includes("\\")));
    for (const key of ["template/claude/skills/ca-plan/SKILL.md", "template/claude/agents/ca-reviewer.md"]) {
      assert.ok(keys.includes(key), `${key} 가 없습니다`);
    }
    assert.match(assetText("template/claude/skills/ca-plan/SKILL.md"), /name: ca-plan/);
    assert.match(assetText("template/CLAUDE.block.md"), /code-agent/);
    assert.equal(packageVersion(), JSON.parse(assetText("package.json")).version);
  });

  test("SEA 모드: 같은 키로 같은 답을 돌려준다 — 부르는 쪽이 갈리지 않는다", () => {
    const bundle = bundleAssets();
    // 번들에는 파일 순서가 보장되지 않는다 — 뒤집어 넣어도 assetKeys 는 정렬해서 돌려줘야 한다
    const shuffled = Object.fromEntries(Object.entries(bundle).reverse());
    withFakeSea(shuffled, ({ assets }) => {
      assert.equal(assets.isPackaged(), true);
      assert.deepEqual(assets.assetKeys(CLAUDE_ASSETS), assetKeys(CLAUDE_ASSETS));
      assert.equal(assets.assetText("template/CLAUDE.block.md"), assetText("template/CLAUDE.block.md"));
      assert.equal(assets.packageVersion(), packageVersion());
    });
  });

  test("없는 키는 두 모드 모두 던진다", () => {
    assert.throws(() => assetText("template/claude/skills/ca-nothing/SKILL.md"));
    withFakeSea(bundleAssets(), ({ assets }) => {
      assert.throws(() => assets.assetText("template/claude/skills/ca-nothing/SKILL.md"), /자원이 없습니다/);
    });
  });
});

describe("P8 · init 은 파일이 아니라 자원에서 설치한다", () => {
  test("SEA 모드에서 .claude/ 가 번들 내용으로 채워진다", () => {
    const bundle = bundleAssets();
    const key = "template/claude/skills/ca-plan/SKILL.md";
    // 디스크의 파일과 다르게 만들어 둔다 — 설치본이 이것과 같으면 자원에서 온 것이다
    bundle[key] = `${bundle[key]}\n<!-- 번들에서 왔다 -->\n`;
    const report = withFakeSea(bundle, (loaded) => loaded.init.init(repo, { cli: CLI }));

    assert.match(report, /스킬·에이전트 26개/);
    assert.equal(read(".claude/skills/ca-plan/SKILL.md"), bundle[key]);
    assert.equal(read(".claude/agents/ca-reviewer.md"), bundle["template/claude/agents/ca-reviewer.md"]);
    assert.ok(read("CLAUDE.md").includes(assetText("template/CLAUDE.block.md").trim()));
    assert.equal(read(`${STATE_DIR}/version`).trim(), packageVersion());
  });
});

// ---- doctor ----

/** 한 검사의 줄 (`  ✓ 이름: 관측한 값`) */
function line(text: string, name: string): string {
  const found = text.split("\n").find((row) => row.trimStart().startsWith(`✓ ${name}:`) || row.trimStart().startsWith(`✗ ${name}:`) || row.trimStart().startsWith(`· ${name}:`));
  assert.ok(found, `${name} 검사가 없습니다:\n${text}`);
  return found.trim();
}

/** ✗ 줄 다음의 `→ 고치는 법` */
function hint(text: string, name: string): string {
  const rows = text.split("\n");
  const index = rows.indexOf(rows.find((row) => row.trim().startsWith(`✗ ${name}:`)) ?? "");
  assert.ok(index >= 0, `${name} 의 ✗ 가 없습니다:\n${text}`);
  return (rows[index + 1] ?? "").trim();
}

const ARCH = ["# 아키텍처", "## 기술 스택", "Node.js", "## 모듈/패키지 구조", "src/main/app", "## 계층과 책임", "- app: 코드", "## 의존 방향", "test → app", "## 공통 모듈", "없음", "## 주요 결정", "- 식별자: 문자열"].join("\n");
const CONV = ["# 코드 컨벤션", "## 명명", "- 파일은 소문자", "## 계층별 규칙", "- app 은 순수 함수로", "## 예외 처리", "- Error 를 던진다", "## 테스트 규칙", "- TC id 를 남긴다"].join("\n");
const STRATEGY = ["# 테스트 전략", "## 수준과 범위", "- Unit: 필수", "## 도구와 실행 명령", "- 없음", "## 통과 기준", "- AC 마다 1케이스"].join("\n");
const QUALITY = ["# 품질·보안 기준", "## 정적 분석", "- 없음", "## 보안 검사", "- 없음 — 리뷰에서 본다", "## 통과 기준과 반영 차단", "- 컴파일 실패는 반영을 막는다"].join("\n");

function gitInit(): void {
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
}

describe("P8 · doctor", () => {
  test("git 저장소가 아니면 ✗ 이고 종료 코드가 1 이다", () => {
    const report = doctor(repo);
    assert.equal(report.ok, false);
    assert.match(line(report.text, "git 저장소"), /^✗ git 저장소: 아닙니다/);
    assert.match(hint(report.text, "git 저장소"), /git init/);
    // 저장소 게이트가 막혀도 나머지를 끝까지 찍는다
    assert.match(line(report.text, "런타임"), /^✓ 런타임: Node v/);
    assert.match(line(report.text, "터미널"), /^·/);
  });

  test("init 직후에는 hook · 버전 · 스킬이 ✓ 다", () => {
    gitInit();
    init(repo, { cli: CLI });
    const report = doctor(repo);
    assert.equal(line(report.text, "PreToolUse hook"), `✓ PreToolUse hook: node "${CLI.replace(/\\/g, "/")}" hook`);
    assert.match(line(report.text, "Stop hook"), /^✓ Stop hook:/);
    assert.equal(line(report.text, "설치 버전"), `✓ 설치 버전: ${packageVersion()}`);
    assert.match(line(report.text, "스킬·에이전트"), /^✓ 스킬·에이전트: 26개 · 보조 문서 10개 모두 번들과 같습니다$/);
    assert.equal(line(report.text, "에이전트 모델"), "✓ 에이전트 모델: 판단(analyst·critic·reviewer) opus/high · 실행(surveyor·explorer·writer·implementer·tester) sonnet/medium");
    assert.match(line(report.text, "git 저장소"), /^✓/);
  });

  test("정의 파일의 effort 를 손으로 바꾸면 에이전트 모델이 ✗ 다 — 스킬·에이전트 해시는 그 줄을 보지 않는다", () => {
    gitInit();
    init(repo, { cli: CLI });
    write(".claude/agents/ca-writer.md", read(".claude/agents/ca-writer.md").replace(/^effort: medium/m, "effort: max"));
    const report = doctor(repo);
    assert.equal(report.ok, false);
    assert.equal(line(report.text, "에이전트 모델"), "✗ 에이전트 모델: 정의 파일이 설정과 다릅니다 — writer 파일 sonnet/max ≠ 설정 sonnet/medium");
    assert.match(hint(report.text, "에이전트 모델"), /update --templates-only/);
    assert.match(line(report.text, "스킬·에이전트"), /^✓/);
  });

  test("models.json 이 깨졌으면 에이전트 모델 ✗ 에 사유를 적고 doctor 는 끝까지 찍는다", () => {
    gitInit();
    init(repo, { cli: CLI });
    write(MODELS_FILE, JSON.stringify({ writer: "inherit" }));
    const report = doctor(repo);
    assert.equal(report.ok, false);
    assert.match(line(report.text, "에이전트 모델"), /^✗ 에이전트 모델: `\.code-agent\/models\.json` 형식이 잘못되었습니다/);
    assert.match(hint(report.text, "에이전트 모델"), /models\.json 을 고치거나 지운 뒤/);
    assert.match(line(report.text, "git 저장소"), /^✓/);
  });

  test("정의 파일이 하나도 없으면 에이전트 모델은 ✓ 가 아니라 · 다 — 설치 여부는 스킬·에이전트 줄이 말한다", () => {
    gitInit();
    init(repo, { cli: CLI });
    rmSync(join(repo, ".claude/agents"), { recursive: true, force: true });
    const report = doctor(repo);
    assert.match(line(report.text, "에이전트 모델"), /^· 에이전트 모델: 대조할 정의 파일이 없습니다/);
    assert.match(line(report.text, "스킬·에이전트"), /^✗ 스킬·에이전트: 없는 것 8개/);
  });

  test("정의 파일이 일부만 있으면 ✓ 에 일치한 파일 수를 붙인다", () => {
    gitInit();
    init(repo, { cli: CLI });
    rmSync(join(repo, ".claude/agents/ca-critic.md"));
    assert.match(line(doctor(repo).text, "에이전트 모델"), /^✓ 에이전트 모델: .* — 설치된 정의 파일 7개 일치$/);
  });

  test("Stop hook 을 지우면 ✗ 이고 고치는 법은 init 이다", () => {
    gitInit();
    init(repo, { cli: CLI });
    const settings = JSON.parse(read(".claude/settings.json")) as { hooks: Record<string, unknown[]> };
    delete settings.hooks.Stop;
    write(".claude/settings.json", JSON.stringify(settings, null, 2));

    const report = doctor(repo);
    assert.equal(report.ok, false);
    assert.equal(line(report.text, "Stop hook"), "✗ Stop hook: 없습니다");
    assert.match(hint(report.text, "Stop hook"), /code-agent init/);
    assert.match(line(report.text, "PreToolUse hook"), /^✓/);
  });

  test("hook 이 없는 파일을 가리키면 ✗ 다 — 있는지가 아니라 **풀리는지**를 본다", () => {
    gitInit();
    init(repo, { cli: join(repo, "dist", "agent", "cli.js") }); // 없는 파일
    const report = doctor(repo);
    assert.match(line(report.text, "PreToolUse hook"), /가리키는 파일이 없습니다/);
    assert.match(hint(report.text, "PreToolUse hook"), /code-agent init/);
  });

  test("스킬을 손으로 고치면 그 경로가 ✗ 에 뜬다", () => {
    gitInit();
    init(repo, { cli: CLI });
    write(".claude/skills/ca-check/SKILL.md", `${read(".claude/skills/ca-check/SKILL.md")}\n손으로 고친 줄\n`);
    rmSync(join(repo, ".claude/agents/ca-critic.md"));

    const report = doctor(repo);
    assert.equal(report.ok, false);
    const row = line(report.text, "스킬·에이전트");
    // 없는 것과 다른 것은 따로 센다 — 처방이 같아도 사람이 보는 사실이 다르다
    assert.match(row, /없는 것 1개: \.claude\/agents\/ca-critic\.md/);
    assert.match(row, /다른 것 1개: \.claude\/skills\/ca-check\/SKILL\.md/);
    assert.match(hint(report.text, "스킬·에이전트"), /code-agent update/);
  });

  test("모델을 바꿔 둔 에이전트는 번들과 달라도 ✗ 가 아니다 — `model:`·`effort:` 줄은 설정이다", () => {
    gitInit();
    write(MODELS_FILE, JSON.stringify({ implementer: "opus" }));
    init(repo, { cli: CLI });
    assert.match(read(".claude/agents/ca-implementer.md"), /^model: opus$/m);
    const report = doctor(repo).text;
    assert.match(line(report, "스킬·에이전트"), /^✓/);
    assert.match(line(report, "에이전트 모델"), /^✓ 에이전트 모델: .* · 바꿈 1개: implementer opus\/medium$/);
  });

  test("버전 스큐는 알리기만 한다 — 종료 코드에 들어가지 않는다", () => {
    gitInit();
    init(repo, { cli: CLI });
    write(`${STATE_DIR}/version`, "0.0.1\n");

    const report = doctor(repo);
    assert.equal(line(report.text, "설치 버전"), `· 설치 버전: 0.0.1 ≠ 지금 도는 버전 ${packageVersion()}`);
    assert.equal(report.text.includes("✗ 설치 버전"), false);
    assert.equal(report.text.split("\n").pop()?.includes("설치 버전"), false);
  });

  test("POLICY 4종을 확정하면 문서 ✗ 가 사라진다", () => {
    gitInit();
    init(repo, { cli: CLI });
    assert.match(line(doctor(repo).text, "아키텍처"), /^✗ 아키텍처: missing-file$/);

    write("doc/architecture.md", ARCH);
    write("doc/conventions.md", CONV);
    write("doc/test-strategy.md", STRATEGY);
    write("doc/quality.md", QUALITY);
    assert.match(line(doctor(repo).text, "아키텍처"), /^✗ 아키텍처: unconfirmed$/);
    assert.match(hint(doctor(repo).text, "아키텍처"), /code-agent confirm doc architecture/);

    for (const entry of checkProjectDocs(repo, undefined)) {
      recordDocConfirmation(repo, entry, "test", { channel: "tty", verified: true, detail: "테스트" });
    }
    const report = doctor(repo);
    for (const label of ["아키텍처", "코드 컨벤션", "테스트 전략", "품질·보안 기준"]) {
      assert.equal(line(report.text, label), `✓ ${label}: 확정됨`);
    }
    // 매니페스트가 없는 것은 도입 전이라 `·` 다 — 막지 않는다
    assert.match(line(report.text, "매니페스트"), /^· 매니페스트: code-agent\.json 이 없습니다/);
  });
});

describe("P8 · PreToolUse matcher 는 읽기 도구도 넘긴다", () => {
  /** 설치된 PreToolUse 항목 — 이 저장소에는 우리 것 하나뿐이다 */
  function preToolUse(): { matcher?: string } {
    const settings = JSON.parse(read(".claude/settings.json")) as { hooks: Record<string, { matcher?: string }[]> };
    return settings.hooks.PreToolUse[0];
  }

  test("init 이 깐 matcher 에 키 파일을 지키는 Read · Grep · Glob 이 들어 있다", () => {
    gitInit();
    init(repo, { cli: CLI });
    const matcher = preToolUse().matcher ?? "";
    // Claude Code 는 matcher 를 정규식으로 본다 — 도구 이름 전체가 맞아야 hook 이 불린다
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "PowerShell", "Read", "Grep", "Glob", "mcp__fs__write_file"]) {
      assert.match(tool, new RegExp(`^(${matcher})$`), `${tool} 이 hook 에 오지 않습니다`);
    }
    assert.match(line(doctor(repo).text, "PreToolUse hook"), /^✓/);
  });

  test("읽기 셋이 없는 옛 matcher 는 doctor 가 ✗ 로 짚고, update 가 고친다", () => {
    gitInit();
    init(repo, { cli: CLI });
    const settings = JSON.parse(read(".claude/settings.json")) as { hooks: Record<string, { matcher?: string }[]> };
    settings.hooks.PreToolUse[0].matcher = "Write|Edit|MultiEdit|NotebookEdit|Bash";
    write(".claude/settings.json", JSON.stringify(settings, null, 2));

    const report = doctor(repo);
    assert.equal(report.ok, false);
    assert.match(line(report.text, "PreToolUse hook"), /matcher 가 PowerShell · Read · Grep · Glob · mcp__\.\* 를 넘기지 않습니다$/);
    assert.match(hint(report.text, "PreToolUse hook"), /code-agent update/);

    update(repo);
    assert.match(line(doctor(repo).text, "PreToolUse hook"), /^✓/);
  });
});

// ---- update ----

describe("P8 · update", () => {
  test("사람이 바꾼 것을 보존하고 템플릿만 되돌린다", () => {
    gitInit();
    init(repo, { cli: CLI });
    // 사람의 것 넷: 모델 오버라이드 · 남의 hook · CLAUDE.md 블록 밖 문장 · 손으로 고친 스킬
    write(MODELS_FILE, JSON.stringify({ implementer: "opus" }));
    const settings = JSON.parse(read(".claude/settings.json")) as { hooks: Record<string, unknown[]> };
    settings.hooks.PreToolUse = [{ matcher: "Bash", hooks: [{ type: "command", command: "other-check" }] }, ...settings.hooks.PreToolUse];
    write(".claude/settings.json", JSON.stringify(settings, null, 2));
    write("CLAUDE.md", `# 우리 프로젝트\n\n원래 내용\n\n${read("CLAUDE.md")}`);
    const bundled = read(".claude/skills/ca-check/SKILL.md");
    write(".claude/skills/ca-check/SKILL.md", `${bundled}\n손으로 고친 줄\n`);
    rmSync(join(repo, ".claude/agents/ca-critic.md"));

    const report = update(repo);

    assert.match(report, /스킬·에이전트 1개 추가: \.claude\/agents\/ca-critic\.md/);
    assert.match(report, /스킬·에이전트 1개 갱신: \.claude\/skills\/ca-check\/SKILL\.md/);
    assert.match(report, /!! 손으로 고쳐 두었던 파일을 덮어썼습니다: \.claude\/skills\/ca-check\/SKILL\.md/);
    assert.match(report, new RegExp(`${STATE_DIR}/version = ${packageVersion()}`));
    assert.match(report, /에이전트 모델 오버라이드 1개 유지: implementer=opus\/medium/);

    assert.equal(read(".claude/skills/ca-check/SKILL.md"), bundled);
    assert.ok(existsSync(join(repo, ".claude/agents/ca-critic.md")));
    assert.match(read(".claude/agents/ca-implementer.md"), /^model: opus$/m);
    assert.match(read("CLAUDE.md"), /^# 우리 프로젝트\n\n원래 내용\n/);
    assert.equal(read("CLAUDE.md").split("<!-- code-agent:start -->").length, 2);
    const after = JSON.parse(read(".claude/settings.json")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    assert.deepEqual(after.hooks.PreToolUse.map((entry) => entry.hooks[0].command), ["other-check", `node "${CLI.replace(/\\/g, "/")}" hook`, `node "${CLI.replace(/\\/g, "/")}" consent-event`]);
    assert.equal(doctor(repo).text.includes("✗ 스킬·에이전트"), false);
  });

  test("이전 번들 기본값(opus·강도 없음)이던 정의 파일은 역할별 기본값으로 다시 쓰고 전후 값을 말한다", () => {
    gitInit();
    init(repo, { cli: CLI });
    for (const key of assetKeys(CLAUDE_ASSETS).filter((item) => item.includes("/agents/"))) {
      const path = installedPath(repo, key);
      writeFileSync(path, readFileSync(path, "utf-8").replace(/^model: .*\r?\n(?:effort: .*\r?\n)?/m, (matched) => `model: opus${matched.endsWith("\r\n") ? "\r\n" : "\n"}`));
    }
    assert.equal(doctor(repo).text.includes("✗ 에이전트 모델"), true);
    const report = update(repo);
    assert.match(report, /에이전트 모델·추론 강도 8개를 설정대로 다시 썼습니다: surveyor opus → sonnet\/medium · analyst opus → opus\/high/);
    assert.match(report, /그중 8개는 이전 번들 기본값\(opus·강도 없음\)/);
    assert.doesNotMatch(report, /손으로 고쳐 두었던 파일을 덮어썼습니다: .*ca-/);
    assert.doesNotMatch(report, /오버라이드/);
    assert.match(line(doctor(repo).text, "에이전트 모델"), /^✓ 에이전트 모델:/);
  });

  test("같은 버전에서 손으로 바꾼 effort 를 되돌리면 원인을 단정하지 않고 전후 값만 말한다", () => {
    gitInit();
    init(repo, { cli: CLI });
    write(".claude/agents/ca-writer.md", read(".claude/agents/ca-writer.md").replace(/^effort: medium/m, "effort: max"));
    const report = update(repo);
    assert.match(report, /에이전트 모델·추론 강도 1개를 설정대로 다시 썼습니다: writer sonnet\/max → sonnet\/medium — 기준: \.code-agent\/models\.json/);
    assert.doesNotMatch(report, /이전 번들 기본값/);
    assert.doesNotMatch(report, /제품 기본값이 바뀐/);
    assert.match(read(".claude/agents/ca-writer.md"), /^effort: medium$/m);
  });

  test("`--cli` 를 승계한다 — 인자 없이 갱신해도 개발용 설치가 갈아 끼워지지 않는다", () => {
    gitInit();
    init(repo, { cli: CLI });
    update(repo);
    const settings = JSON.parse(read(".claude/settings.json")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    assert.deepEqual(settings.hooks.PreToolUse.map((entry) => entry.hooks[0].command), [`node "${CLI.replace(/\\/g, "/")}" hook`, `node "${CLI.replace(/\\/g, "/")}" consent-event`]);
    assert.deepEqual(settings.hooks.Stop.map((entry) => entry.hooks[0].command), [`node "${CLI.replace(/\\/g, "/")}" stop`]);
  });

  test("진행 중인 작업이 있어도 막지 않고 경고만 한다 — 승인·증거는 해시에 묶여 있다", () => {
    gitInit();
    init(repo, { cli: CLI });
    write(`${STATE_DIR}/active.json`, JSON.stringify({ id: "ORD-1", spec: "doc/spec.md", target: "order", phase: "implement", stage: "domain" }));
    const report = update(repo);
    assert.match(report, /!! 진행 중인 작업이 있습니다 \(ORD-1 · implement\/domain\)/);
    assert.match(report, /갱신된 파일을 커밋해/);
  });

  test("바뀐 것이 없으면 그렇게 말한다 — 없는 변경을 지어내지 않는다", () => {
    gitInit();
    init(repo, { cli: CLI });
    const report = update(repo);
    assert.match(report, /스킬·에이전트 26개 · 보조 문서 10개 그대로/);
    assert.match(report, /\.claude\/settings\.json: 그대로/);
    assert.match(report, /CLAUDE\.md: 그대로/);
    assert.equal(report.includes("!!"), false);
  });

  /** 설치가 쓰는 파일 전부(.git 제외)의 내용 — 멈춘 뒤 하나도 바뀌지 않았는지 대조한다 */
  function installedFiles(): Record<string, string> {
    const files: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(repo, dir), { withFileTypes: true })) {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (path === ".git") continue;
        if (entry.isDirectory()) walk(path);
        else files[path] = read(path);
      }
    };
    walk("");
    return files;
  }

  test("models.json 형식이 잘못되었으면 파일을 하나도 바꾸지 않고 멈춘다 — 이전 버전이 받던 손 입력 값도 쓰기 전에 거부한다", () => {
    gitInit();
    init(repo, { cli: CLI });
    // 이전 설치본 흉내: 버전 · 손으로 고친 스킬 · 지운 Stop hook · 손으로 고친 강도 · 이전 버전이 검사하지 않던 대문자 별칭
    write(`${STATE_DIR}/version`, "0.9.0\n");
    write(".claude/skills/ca-check/SKILL.md", `${read(".claude/skills/ca-check/SKILL.md")}\n손으로 고친 줄\n`);
    const settings = JSON.parse(read(".claude/settings.json")) as { hooks: Record<string, unknown[]> };
    delete settings.hooks.Stop;
    write(".claude/settings.json", JSON.stringify(settings, null, 2));
    write(".claude/agents/ca-writer.md", read(".claude/agents/ca-writer.md").replace(/^effort: medium/m, "effort: max"));
    write(MODELS_FILE, JSON.stringify({ reviewer: "Opus" }));
    const before = installedFiles();

    for (const run of [() => update(repo), () => init(repo, { cli: CLI })]) {
      assert.throws(run, (error: unknown) => error instanceof Stop && /models\.json` 형식이 잘못되었습니다 — reviewer/.test(error.message));
      assert.deepEqual(installedFiles(), before);
    }
  });

  test("두 호스트 설치에서 codex-models.json 이 깨졌으면 Claude 쪽도 갱신하지 않고 멈춘다", () => {
    gitInit();
    init(repo, { cli: CLI, host: "both" });
    write(".claude/skills/ca-check/SKILL.md", `${read(".claude/skills/ca-check/SKILL.md")}\n손으로 고친 줄\n`);
    write(`${STATE_DIR}/codex-models.json`, JSON.stringify({ writer: { model: "opus", reasoning: "high" } }));
    const before = installedFiles();

    assert.throws(() => update(repo), (error: unknown) => error instanceof Stop && /codex-models\.json` 형식이 잘못되었습니다/.test(error.message));
    assert.deepEqual(installedFiles(), before);
  });
});

// 자원 해석은 설치 파일과 npm 패키지 파일이 같다는 전제 위에 선다
describe("P8 · installedPath", () => {
  test("번들 키가 저장소 안의 자리로 그대로 떨어진다", () => {
    assert.equal(
      installedPath("/r", "template/claude/skills/ca-plan/SKILL.md"),
      join("/r", ".claude", "skills", "ca-plan", "SKILL.md"),
    );
  });
});

describe("P8 · PATH 의 code-agent 가 무엇인지 가른다", () => {
  /** 실제 npm 11 이 만드는 래퍼 — 자기 폴더를 `%dp0%` 로 가리킨다 (`%~dp0` 가 아니다) */
  const CMD_SHIM = [
    "@ECHO off",
    ":find_dp0",
    "SET dp0=%~dp0",
    ':start',
    'endLocal & "%_prog%"  "%dp0%\\node_modules\\code-agent\\dist\\agent\\cli.js" %*',
  ].join("\r\n");
  const SH_SHIM = [
    "#!/bin/sh",
    'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
    'exec node  "$basedir/node_modules/code-agent/dist/agent/cli.js" "$@"',
  ].join("\n");

  test("셸 래퍼는 가리키는 cli.js 로 풀린다 — 변수로 쓴 제 폴더까지", () => {
    write("npm/code-agent.cmd", CMD_SHIM);
    write("npm/code-agent", SH_SHIM);
    const expected = join(repo, "npm", "node_modules", "code-agent", "dist", "agent", "cli.js");
    assert.equal(npmCli(join(repo, "npm", "code-agent.cmd")), expected);
    assert.equal(npmCli(join(repo, "npm", "code-agent")), expected);
  });

  test("단일 실행 파일은 cli.js 가 아니다 — 90MB 를 utf-8 로 읽지도 않는다", () => {
    write("bin/code-agent.exe", "MZ");
    writeFileSync(join(repo, "bin", "big.exe"), Buffer.alloc(1024 * 1024 + 1));
    assert.equal(npmCli(join(repo, "bin", "code-agent.exe")), undefined);
    assert.equal(npmCli(join(repo, "bin", "big.exe")), undefined);
  });
});

// ---- 스테이지 전이 기록 ----

describe("P8 · 스테이지 전이 기록", () => {
  const CURSOR = { id: "ORD-1", spec: "doc/spec.md", target: "order", phase: "implement", stage: "domain" } as const;

  test("`by` 를 준 저장만 한 줄을 남긴다 — 테스트 헬퍼가 조용히 오염시키지 않는다", () => {
    saveActive(repo, { ...CURSOR });
    assert.equal(existsSync(join(repo, STAGES_LOG)), false);

    saveActive(repo, { ...CURSOR }, "next");
    const rows = readStages(repo);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "ORD-1");
    assert.equal(rows[0].phase, "implement");
    assert.equal(rows[0].stage, "domain");
    assert.equal(rows[0].by, "next");
    assert.match(rows[0].at, /^\d{4}-\d{2}-\d{2}T/);
  });

  test("시각 순으로 읽고 깨진 줄은 그 줄만 버린다 — 집계가 명령을 세우면 안 된다", () => {
    logStage(repo, { ...CURSOR, phase: "check", stage: undefined }, "next");
    write(
      STAGES_LOG,
      `{"at":"2020-01-01T00:00:00.000Z","id":"OLD","target":"x","phase":"analysis","by":"start"}\n{ 깨진 줄\n${read(STAGES_LOG)}`,
    );

    const rows = readStages(repo);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "OLD");
    assert.equal(rows[1].phase, "check");
    assert.equal(rows[1].stage, undefined);
  });
});

// ---- usage ----

describe("P8 · usage 의 기록 경로", () => {
  /** 이 PC 의 `~/.claude/projects` 에 실제로 있는 폴더 이름에서 뽑은 골든값 */
  test("영숫자가 아닌 글자 하나마다 `-` 하나다 — 한글도 글자마다", () => {
    assert.equal(encodeRepoPath("C:\\IdeaProjects\\code-agent"), "C--IdeaProjects-code-agent");
    assert.equal(encodeRepoPath("C:\\Users\\김우석(카이)"), "C--Users--------");
    assert.equal(encodeRepoPath("/home/kai/work"), "-home-kai-work");
  });

  test("기록 폴더가 없으면 던지지 않고 안내한다 — 다른 PC 의 저장소일 수 있다", () => {
    const report = usage(repo, { transcripts: join(repo, "없는-폴더") });
    assert.match(report, /기록을 찾지 못했습니다/);
    assert.match(report, /다른 PC 의 기록입니다/);
  });

  test("--since 가 날짜가 아니면 세지 않고 멈춘다", () => {
    assert.throws(() => usage(repo, { since: "지난주" }), /--since 의 날짜를 읽을 수 없습니다/);
  });
});

describe("P8 · usage 집계", () => {
  const OPUS = "claude-opus-5";
  let dir: string;

  /** 기록 한 줄. `usage` 가 읽는 필드만 담는다 */
  function assistant(at: string, model: string, tokens: Record<string, unknown>, id: string, block = 0): string {
    return JSON.stringify({ type: "assistant", timestamp: at, apiBlockIndex: block, message: { id, model, usage: tokens } });
  }

  beforeEach(() => {
    dir = join(repo, "transcripts");
    mkdirSync(join(dir, "s1", "subagents"), { recursive: true });

    write(
      STAGES_LOG,
      [
        JSON.stringify({ at: "2026-09-30T01:00:00.000Z", id: "ORD-1", target: "order", phase: "implement", stage: "domain", by: "next" }),
        JSON.stringify({ at: "2026-09-30T03:00:00.000Z", id: "ORD-1", target: "order", phase: "check", by: "next" }),
        "",
      ].join("\n"),
    );

    writeFileSync(
      join(dir, "s1.jsonl"),
      [
        // 첫 전이 이전 — 문서 작성처럼 작업 커서가 없던 시간
        assistant("2026-09-30T00:30:00.000Z", OPUS, { input_tokens: 1_000_000, output_tokens: 0 }, "msg-before"),
        // 같은 message.id 가 apiBlockIndex 만 달리 세 줄. 그냥 더하면 output 이 450 이 된다
        assistant("2026-09-30T02:00:00.000Z", OPUS, { cache_read_input_tokens: 2_000_000, output_tokens: 16 }, "msg-dup", 0),
        assistant("2026-09-30T02:00:01.000Z", OPUS, { cache_read_input_tokens: 2_000_000, output_tokens: 217 }, "msg-dup", 1),
        assistant("2026-09-30T02:00:02.000Z", OPUS, { cache_read_input_tokens: 2_000_000, output_tokens: 217 }, "msg-dup", 2),
        // 단가표에 없는 모델
        assistant("2026-09-30T04:00:00.000Z", "claude-mystery-9", { output_tokens: 999 }, "msg-unknown"),
        // 쓰이는 중일 수 있는 기록 — 반쯤 쓰인 줄과 usage 없는 줄
        '{"type":"assistant","timestamp":"2026-09-30T04:00:01.000Z","message":{"id":"broke"',
        JSON.stringify({ type: "user", timestamp: "2026-09-30T04:00:02.000Z", message: { id: "u1" } }),
        "",
      ].join("\n"),
      "utf-8",
    );

    writeFileSync(
      join(dir, "s1", "subagents", "agent-a1.jsonl"),
      `${assistant("2026-09-30T02:30:00.000Z", "claude-haiku-4-5", { input_tokens: 1_000_000, output_tokens: 0 }, "msg-sub")}\n`,
      "utf-8",
    );
    writeFileSync(
      join(dir, "s1", "subagents", "agent-a1.meta.json"),
      JSON.stringify({ agentType: "ca-implementer", model: "sonnet" }),
      "utf-8",
    );
  });

  /** 표 한 칸씩. 열은 2칸 이상으로 갈라져 있고 이름 안의 한 칸 공백은 남는다 */
  function table(text: string, title: string): Map<string, string[]> {
    const lines = text.split("\n");
    const start = lines.indexOf(title);
    assert.ok(start >= 0, `${title} 표가 없습니다:\n${text}`);
    const rows = new Map<string, string[]>();
    for (let index = start + 2; index < lines.length && /\$\d/.test(lines[index]); index += 1) {
      const cells = lines[index].trim().split(/\s{2,}/);
      rows.set(cells[0], cells.slice(1));
    }
    return rows;
  }

  test("같은 요청을 한 번만 세고 마지막 값을 쓴다", () => {
    const stages = table(usage(repo, { transcripts: dir }), "스테이지별");
    // 16 + 217 + 217 = 450 이 아니라 217 이다. 입력 1M 는 같은 구간에 든 서브에이전트의 것이다
    assert.deepEqual(stages.get("implement/domain"), ["1,000,000", "2,000,000", "0", "217", "$2.01"]);
  });

  test("스테이지 경계는 timestamp 로 갈린다 — 첫 전이 이전은 (작업 전) 이다", () => {
    const stages = table(usage(repo, { transcripts: dir }), "스테이지별");
    assert.deepEqual([...stages.keys()], ["(작업 전)", "implement/domain", "check", "합계"]);
    assert.deepEqual(stages.get("(작업 전)"), ["1,000,000", "0", "0", "0", "$5.00"]);
    assert.deepEqual(stages.get("check"), ["0", "0", "0", "999", "$0.00"]);
  });

  test("서브에이전트는 짝 meta 의 agentType 으로 서고 두 표의 합계가 같다", () => {
    const text = usage(repo, { transcripts: dir });
    const agents = table(text, "에이전트별");
    assert.deepEqual(agents.get("ca-implementer"), ["1,000,000", "0", "0", "0", "$1.00"]);
    assert.deepEqual(agents.get("main"), ["1,000,000", "2,000,000", "0", "1,216", "$6.01"]);
    assert.deepEqual(agents.get("합계"), table(text, "스테이지별").get("합계"));
    assert.match(text, /세션 1 · 서브에이전트 1/);
  });

  test("subagents 아래 하위 폴더(워크플로 실행)의 agent-*.jsonl 도 서브에이전트로 읽고, 같은 폴더의 실행 기록은 읽지 않는다", () => {
    const nested = join(dir, "s1", "subagents", "workflows", "wf_1");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "agent-w1.jsonl"), `${assistant("2026-09-30T02:40:00.000Z", "claude-haiku-4-5", { input_tokens: 1_000_000, output_tokens: 0 }, "msg-wf")}\n`);
    writeFileSync(join(nested, "agent-w1.meta.json"), JSON.stringify({ agentType: "workflow-subagent" }));
    writeFileSync(join(nested, "journal.jsonl"), `${assistant("2026-09-30T02:41:00.000Z", OPUS, { input_tokens: 5_000_000, output_tokens: 0 }, "msg-journal")}\n`);
    const text = usage(repo, { transcripts: dir });
    assert.deepEqual(table(text, "에이전트별").get("workflow-subagent"), ["1,000,000", "0", "0", "0", "$1.00"]);
    assert.match(text, /세션 1 · 서브에이전트 2/);
    assert.deepEqual(table(text, "에이전트별").get("합계"), table(text, "스테이지별").get("합계"));
    assert.deepEqual(table(text, "스테이지별").get("implement/domain"), ["2,000,000", "2,000,000", "0", "217", "$3.01"]);
  });

  test("모르는 모델은 0 으로 세고 이름만 꼬리에 남긴다 — 지어낸 단가로 합계를 물들이지 않는다", () => {
    const text = usage(repo, { transcripts: dir });
    assert.match(text, /비용 미산정 모델: claude-mystery-9/);
    assert.match(text, /비용은 추정치입니다 — 2026-09-25 기준/);
  });

  test("모델별 표는 날짜 접미사를 뗀 단가표 키로 묶고, 사용량이 0 인 모델은 미산정 목록에 적지 않는다", () => {
    writeFileSync(
      join(dir, "s2.jsonl"),
      [
        assistant("2026-09-30T05:00:00.000Z", "claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 0 }, "msg-sonnet55"),
        assistant("2026-09-30T05:00:01.000Z", "claude-haiku-4-5-20251001", { input_tokens: 1_000_000, output_tokens: 0 }, "msg-haiku-dated"),
        assistant("2026-09-30T05:00:02.000Z", "<synthetic>", { input_tokens: 0, output_tokens: 0 }, "msg-synthetic"),
        "",
      ].join("\n"),
      "utf-8",
    );
    const text = usage(repo, { transcripts: dir });
    const models = table(text, "모델별");
    assert.deepEqual(models.get("claude-sonnet-5-5"), ["1,000,000", "0", "0", "0", "$2.00"]);
    // 서브에이전트의 claude-haiku-4-5 1M 과 날짜가 붙은 1M 이 한 행이다
    assert.deepEqual(models.get("claude-haiku-4-5"), ["2,000,000", "0", "0", "0", "$2.00"]);
    assert.equal(models.has("claude-haiku-4-5-20251001"), false);
    assert.match(text, /비용 미산정 모델: claude-mystery-9 — /);
    assert.deepEqual(models.get("합계"), table(text, "스테이지별").get("합계"));
    assert.deepEqual(models.get("합계"), table(text, "에이전트별").get("합계"));
  });

  test("--work 는 그 작업의 구간만, --since 는 그 뒤만 남긴다", () => {
    const mine = table(usage(repo, { transcripts: dir, work: "ORD-1" }), "스테이지별");
    assert.deepEqual([...mine.keys()], ["implement/domain", "check", "합계"]);
    assert.match(usage(repo, { transcripts: dir, work: "없는작업" }), /셀 것이 없습니다/);

    const later = table(usage(repo, { transcripts: dir, since: "2026-09-30T03:00:00.000Z" }), "스테이지별");
    assert.deepEqual([...later.keys()], ["check", "합계"]);
  });

  test("스테이지 기록이 없으면 표 대신 이유를 말한다 — 이 버전 이전에 시작한 작업이다", () => {
    rmSync(join(repo, STAGES_LOG));
    const text = usage(repo, { transcripts: dir });
    assert.deepEqual([...table(text, "스테이지별").keys()], ["(작업 전)", "합계"]);
    assert.match(text, /스테이지 기록이 없습니다/);
  });
});

describe("P8 · usage 호출·재시도 집계", () => {
  let dir: string;
  const line = (value: object) => JSON.stringify(value);

  beforeEach(() => {
    dir = join(repo, "transcripts");
    mkdirSync(dir, { recursive: true });
    write(STAGES_LOG, `${JSON.stringify({ at: "2026-09-30T01:00:00.000Z", id: "ORD-1", target: "order", phase: "analysis", by: "start" })}\n`);
    const use = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
    const usageOf = { input_tokens: 10, output_tokens: 5 };
    writeFileSync(join(dir, "s1.jsonl"), [
      // 같은 message.id 세 줄 — 요청 1건, 블록마다 도구 호출 하나(같은 id 중복 한 줄)
      line({ type: "assistant", timestamp: "2026-09-30T02:00:00.000Z", message: { id: "m1", model: "claude-opus-5", usage: usageOf, content: [use("t1", "Bash", { command: "code-agent planning advance --chain" })] } }),
      line({ type: "assistant", timestamp: "2026-09-30T02:00:01.000Z", message: { id: "m1", model: "claude-opus-5", usage: usageOf, content: [use("t2", "Bash", { command: "code-agent consent prepare --action plan --for claude" })] } }),
      line({ type: "assistant", timestamp: "2026-09-30T02:00:02.000Z", message: { id: "m1", model: "claude-opus-5", usage: usageOf, content: [use("t3", "Read", { file_path: join(repo, ".claude", "skills", "ca-answer", "SKILL.md") })] } }),
      line({ type: "assistant", timestamp: "2026-09-30T02:00:03.000Z", message: { id: "m1", model: "claude-opus-5", usage: usageOf, content: [use("t3", "Read", { file_path: "x" })] } }),
      line({ type: "user", timestamp: "2026-09-30T02:00:04.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "0123456789" }] } }),
      line({ type: "user", timestamp: "2026-09-30T02:00:05.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "12345" }] }] } }),
      line({ type: "user", timestamp: "2026-09-30T02:00:06.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "중복은 세지 않는다" }] } }),
      "",
    ].join("\n"));
  });

  /** 열이 2칸 이상 공백으로 갈린 표 — `$` 없는 호출 표 */
  function rows(text: string, title: string): Map<string, string[]> {
    const lines = text.split("\n");
    const start = lines.indexOf(title);
    assert.ok(start >= 0, `${title} 표가 없습니다:\n${text}`);
    const out = new Map<string, string[]>();
    for (let index = start + 2; index < lines.length && lines[index].startsWith("  "); index += 1) {
      const cells = lines[index].trim().split(/\s{2,}/);
      out.set(cells[0], cells.slice(1));
    }
    return out;
  }

  test("요청·도구 호출·도구 결과 글자를 스테이지·에이전트별로 세고, 도구·명령·스킬 읽기를 줄로 낸다", () => {
    const text = usage(repo, { transcripts: dir });
    assert.deepEqual(rows(text, "호출별 (스테이지)").get("analysis"), ["1", "3", "15"]);
    assert.deepEqual(rows(text, "호출별 (에이전트)").get("main"), ["1", "3", "15"]);
    assert.match(text, /^도구별 호출: Bash 2 · Read 1$/m);
    assert.match(text, /^code-agent 명령별 호출: consent prepare 1 · planning advance --chain 1$/m);
    assert.match(text, /^스킬 읽기: ca-answer\/SKILL\.md 1$/m);
    // 토큰 표는 그대로다 — 새 절에는 `$` 가 없다
    assert.ok(!/\$\d/.test(text.slice(text.indexOf("호출별 (스테이지)"))));
    assert.match(text, /비용은 추정치입니다/);
  });

  test("--json 은 같은 값을 객체로 낸다", () => {
    const report = usageReport(repo, { transcripts: dir });
    assert.equal(report.sections[0].source, "claude");
    assert.deepEqual(report.sections[0].stages.find((row) => row.label === "analysis")?.calls, { requests: 1, toolCalls: 3, toolResultChars: 15 });
    assert.equal(report.sections[0].tools.Bash, 2);
    assert.equal(report.sections[0].commands["planning advance --chain"], 1);
    const cli = spawnSync(process.execPath, [join(__dirname, "..", "agent", "cli.js"), "usage", "--json", "--bogus"], { cwd: repo, encoding: "utf8" });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /사용법: code-agent usage/);
  });

  test("명령 키 — 셋째 낱말·깃발·도움말", () => {
    assert.equal(commandKey("code-agent consent finish 1234"), "consent finish");
    assert.equal(commandKey("code-agent verify --json --retry"), "verify --json --retry");
    assert.equal(commandKey("code-agent next"), "next");
    assert.equal(commandKey("code-agent review cross --by codex"), "review cross");
    assert.equal(commandKey("code-agent"), "(도움말)");
    assert.equal(commandKey("git status"), undefined);
  });

  test("재시도·재배정은 작업 기록을 읽기만 하고 교차 실행 합계를 낸다 — `$` 를 쓰지 않는다", () => {
    const work = join(repo, STATE_DIR, "work", "ORD-1");
    mkdirSync(work, { recursive: true });
    const attempt = (status: string, extra: object = {}) => ({ dispatchId: Math.random().toString(16).slice(2), inputHash: "h", at: "2026-09-30T02:00:00.000Z", status, ...extra });
    writeFileSync(join(work, "order.planning.json"), JSON.stringify({ tasks: [
      { task: { id: "analysis" }, attempts: [attempt("failed", { failure: { class: "agent-format-error", at: "", detail: "x" } }), attempt("failed"), attempt("completed")] },
      { task: { id: "impact" }, attempts: [attempt("completed")] },
    ] }));
    writeFileSync(join(work, "order.review.json"), JSON.stringify({ rounds: [{ round: 1, crossAttempts: [
      { n: 1, host: "codex", mode: "review", startedAt: "", class: "cross-unavailable" },
      { n: 2, host: "codex", mode: "review", startedAt: "", class: "completed", usage: { durationMs: 412_000, costUsd: 0.81 } },
    ] }] }));
    writeFileSync(join(work, "order.verify.json"), "{ 깨진");
    const before = readdirSync(work).sort();
    const [report] = retryReports(repo, "ORD-1");
    assert.equal(report.dispatches, 4);
    assert.equal(report.reassignments, 2);
    assert.deepEqual(report.failures, { "agent-format-error": 1, "cross-unavailable": 1 });
    assert.deepEqual(report.cross, { attempts: 1, durationMs: 412_000, costUsd: 0.81, inputTokens: 0, outputTokens: 0 });
    assert.deepEqual(report.unreadable, [".code-agent/work/ORD-1/order.verify.json"]);
    const text = usage(repo, { transcripts: dir });
    assert.match(text, /재시도·재배정 \(작업 기록, 읽기 전용\)\n  ORD-1\/order: 배정 4회\(재배정 2\)/);
    assert.match(text, /교차 실행 1회 412초 비용 0\.81 USD/);
    assert.ok(!text.split("\n").some((row) => row.startsWith("  ORD-1/order") && row.includes("$")));
    assert.deepEqual(readdirSync(work).sort(), before, "측정은 기록을 쓰지 않는다");
  });

  test("옛 기록 — 배열 없는 교차(cross)·단수 리뷰어(reviewer)의 실패 원인도 카운터와 같은 범위로 센다", () => {
    const work = join(repo, STATE_DIR, "work", "ORD-2");
    mkdirSync(work, { recursive: true });
    const at = "2026-09-30T02:00:00.000Z";
    writeFileSync(join(work, "order.review.json"), JSON.stringify({ rounds: [{ round: 1,
      cross: { host: "codex", startedAt: at, unavailable: "codex 미설치" },
      reviewer: { agentId: "a1", startedAt: at, failure: { class: "agent-format-error", at, detail: "표가 아니다" } } }] }));
    writeFileSync(join(work, "order.planning.json"), JSON.stringify({ tasks: [], cross: { host: "codex", at, criticDispatchId: "d1", status: "unavailable", summary: "인증 없음" } }));
    const [report] = retryReports(repo, "ORD-2");
    assert.equal(report.counters.crossPoint, 2, "카운터(retrySummary)는 옛 교차 지점을 센다");
    assert.deepEqual(report.failures, { "agent-format-error": 1, "cross-unavailable": 2 });
    assert.equal(report.cross.attempts, 0, "옛 시도에는 usage 가 없다");
  });

  test("Codex 세션 기록 — 저장소의 세션만 세고 비용은 내지 않는다(형식 미확인 표시)", () => {
    const sessions = join(repo, "codex-sessions");
    const day = join(sessions, "2026", "10", "01");
    mkdirSync(day, { recursive: true });
    const tokens = (n: number) => line({ timestamp: `2026-09-30T02:00:0${n}.000Z`, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 7, reasoning_output_tokens: 3 } } } });
    writeFileSync(join(day, "rollout-x.jsonl"), [
      line({ timestamp: "2026-09-30T02:00:00.000Z", type: "session_meta", payload: { cwd: repo } }),
      tokens(1), tokens(2),
      line({ timestamp: "2026-09-30T02:00:03.000Z", type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1", arguments: JSON.stringify({ command: ["code-agent", "next"] }) } }),
      line({ timestamp: "2026-09-30T02:00:04.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "1234567" } }),
      "",
    ].join("\n"));
    // 셸 래퍼로 감싼 명령(bash -lc · powershell -Command · cmd /c)도 code-agent 명령·스킬 읽기로 센다
    const call = (n: number, command: string[], type = "function_call") => line({ timestamp: `2026-09-30T02:00:0${n}.000Z`, type: "response_item",
      payload: type === "local_shell_call" ? { type, call_id: `w${n}`, action: { type: "exec", command } } : { type, name: "shell", call_id: `w${n}`, arguments: JSON.stringify({ command }) } });
    writeFileSync(join(day, "rollout-wrapped.jsonl"), [
      line({ timestamp: "2026-09-30T02:00:00.000Z", type: "session_meta", payload: { cwd: repo } }),
      call(1, ["bash", "-lc", "code-agent consent finish 1234"]),
      call(2, ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoProfile", "-Command", "code-agent next"]),
      call(3, ["cmd.exe", "/c", "code-agent read .agents/skills/ca-answer/SKILL.md"], "local_shell_call"),
      call(4, ["bash", "-lc", "git", "status"]),
      "",
    ].join("\n"));
    assert.equal(unwrapShellArgv(["bash", "-lc", "code-agent next"]), "code-agent next");
    assert.equal(unwrapShellArgv(["code-agent", "next"]), "code-agent next");
    assert.equal(unwrapShellArgv(["bash", "script.sh", "code-agent"]), "bash script.sh code-agent", "스크립트 깃발이 없으면 벗기지 않는다");
    writeFileSync(join(day, "rollout-other.jsonl"), [line({ timestamp: "2026-09-30T02:00:00.000Z", type: "session_meta", payload: { cwd: join(tmpdir(), "다른-저장소") } }), tokens(1), ""].join("\n"));
    const text = usage(repo, { codexSessions: sessions });
    assert.match(text, /^Codex 사용량 · /m);
    assert.match(text, /형식은 공개 Codex 기록 기준이며 실제 기록으로 확인하기 전입니다/);
    assert.deepEqual(rows(text, "스테이지별").get("analysis"), ["200", "100", "14", "6", "2", "5", "7"]);
    assert.match(text, /^도구별 호출: shell 4 · local_shell_call 1$/m);
    assert.match(text, /^code-agent 명령별 호출: next 2 · consent finish 1 · read 1$/m);
    assert.match(text, /^스킬 읽기: ca-answer\/SKILL\.md 1$/m);
    assert.match(text, /Codex 비용은 단가표가 없어 산정하지 않습니다/);
    assert.match(usage(repo, { codexSessions: join(repo, "없는-폴더") }), /Codex 기록을 찾지 못했습니다/);
  });
});

// ---- knowledge ----

const DICTIONARY = "doc/knowledge/data-dictionary.md";

function commit(message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message], { cwd: repo });
}

describe("P8 · knowledge 목록", () => {
  test("키마다 그 키를 마지막으로 쓴 작업이 붙고, 커밋되지 않은 것은 (미상) 이다", () => {
    gitInit();
    write(
      DICTIONARY,
      ["# 데이터 사전", "", "### `ORDER` 주문", "- 근거: src/main/java/Order.java:31", "", "### `PAYMENT` 결제", "- 사람이 말해 준 규칙이라 경로가 없다", ""].join("\n"),
    );
    commit("[ORD-1] 주문 도메인");

    write(DICTIONARY, `${read(DICTIONARY)}\n### \`SHIPPING\` 배송\n- 손으로 넣었다\n`);

    const text = knowledgeList(repo);
    assert.match(text, /doc\/knowledge\/data-dictionary\.md \(항목 3\)/);
    assert.match(text, /ORDER\s+ORD-1\s+src\/main\/java\/Order\.java:31/);
    assert.match(text, /PAYMENT\s+ORD-1\s+근거 경로 없음/);
    assert.match(text, /SHIPPING\s+\(미상\)/);
    assert.match(text, /마지막으로 쓴 작업/);
  });

  test("문서가 없으면 어디에 만드는지 알려 준다", () => {
    const text = knowledgeList(repo);
    assert.match(text, /공통 KNOWLEDGE 문서가 없습니다/);
    assert.match(text, /doc\/knowledge\/api-catalog\.md/);
  });
});

describe("P8 · knowledge prune", () => {
  test("비TTY 에서는 거부하고 문서를 한 글자도 바꾸지 않는다", () => {
    write(DICTIONARY, "# 데이터 사전\n\n### `GONE` 사라진 것\n- 근거: src/gone/Gone.java:1\n");
    const before = read(DICTIONARY);

    assert.notEqual(process.stdin.isTTY, true, "이 테스트는 TTY 가 없는 데서 돌아야 한다");
    assert.throws(() => knowledgePrune(repo), /터미널에서만 바꿉니다/);
    assert.equal(read(DICTIONARY), before);
  });

  test("참조가 전부 없을 때만 표시한다 — 하나만 썩은 것은 리팩터링의 흔적이라 잡음이다", () => {
    gitInit();
    write("src/live/Kept.java", "class Kept {}\n");
    write(
      DICTIONARY,
      [
        "# 데이터 사전",
        "",
        "### `GONE` 전부 사라짐",
        "- src/gone/Gone.java:1 과 src/gone/Also.java 를 보라",
        "",
        "### `HALF` 하나만 사라짐",
        "- src/live/Kept.java:3 · src/gone/Moved.java:9",
        "",
        "### `NOPATH` 경로가 없다",
        "- 사람이 말해 준 업무 규칙",
        "",
        "### `URLONLY` 링크뿐",
        "- https://wiki.example.com/spec/order.md 를 보라",
        "",
      ].join("\n"),
    );

    const { found, unchecked } = pruneCandidates(repo);
    assert.deepEqual(found.map((candidate) => candidate.key), ["GONE"]);
    assert.deepEqual(found[0].missing, ["src/gone/Also.java", "src/gone/Gone.java:1"]);
    // URL 은 참조가 아니다 — 경로가 0개인 항목 둘(NOPATH · URLONLY)은 세기만 한다
    assert.equal(unchecked, 2);
  });

  test("KNOWLEDGE 문서 자신을 가리키는 줄은 참조가 아니다", () => {
    assert.deepEqual(codeRefs("자세한 것은 doc/knowledge/api-catalog.md 를 보라", [DICTIONARY, "doc/knowledge/api-catalog.md"]), []);
    // 홑이름은 어디를 가리키는지 모른다
    assert.deepEqual(codeRefs("Order.java 를 보라", []), []);
    assert.deepEqual(codeRefs("src/a/Order.java:31 을 보라", []), ["src/a/Order.java:31"]);
  });

  test("git 이 아는 경로는 없다고 하지 않는다 — 작업 트리에 아직 없어도 커밋돼 있다", () => {
    gitInit();
    write("src/tracked.ts", "export const x = 1;\n");
    commit("[ORD-1] t");
    rmSync(join(repo, "src", "tracked.ts"));

    assert.deepEqual(missingRefs(repo, ["src/tracked.ts", "src/never.ts"]), ["src/never.ts"]);
  });
});

// ---- 리뷰에서 나온 규칙들 ----

describe("P8 · KNOWLEDGE 항목의 경계는 `####` 가 아니다", () => {
  test("소제목 아래의 살아 있는 근거를 보므로 정리 후보가 아니다", () => {
    gitInit();
    write("src/live/Kept.java", "class Kept {}\n");
    write(
      DICTIONARY,
      [
        "# 데이터 사전",
        "",
        "### `ORDER` 주문",
        "- 옛 근거: src/gone/Old.java:1",
        "",
        "#### 세부",
        "- 지금 근거: src/live/Kept.java:3",
        "",
        "### `OTHER` 다른 것",
        "- 사람이 말해 준 업무 규칙",
        "",
      ].join("\n"),
    );

    // `##+` 로 자르면 본문이 `#### 세부` 에서 끊겨 살아 있는 경로가 보이지 않고, 보이는 것이 전부 썩어
    // ORDER 가 지우자고 올라온다
    const { found } = pruneCandidates(repo);
    assert.deepEqual(found.map((candidate) => candidate.key), []);
    assert.deepEqual(
      codeRefs(documentEntries(read(DICTIONARY)).find((entry) => entry.key === "ORDER")!.body, [DICTIONARY]),
      ["src/gone/Old.java:1", "src/live/Kept.java:3"],
    );
  });

  test("지울 때도 소제목 덩어리를 데리고 나간다 — 문서에 고아를 남기지 않는다", () => {
    const text = [
      "# 데이터 사전",
      "",
      "### `ORDER` 주문",
      "- 옛 근거: src/gone/Old.java:1",
      "",
      "#### 세부",
      "- 지금 근거: src/live/Kept.java:3",
      "",
      "### `OTHER` 다른 것",
      "- 남는다",
      "",
    ].join("\n");
    const next = removeEntry(text, "ORDER");
    assert.ok(!next.includes("#### 세부"), next);
    assert.ok(!next.includes("Kept.java"), next);
    assert.ok(next.includes("### `OTHER` 다른 것"), next);
  });

  test("`##`·`###` 경계는 그대로다 — 제안 적용이 다른 종류를 삼키지 않는다", () => {
    const text = ["# 데이터 사전", "", "### `A` 가", "- 가", "", "### `B` 나", "- 나", ""].join("\n");
    assert.equal(existingEntry(text, "A"), "### `A` 가\n- 가");
    assert.ok(removeEntry(text, "A").includes("### `B` 나"));
  });
});

describe("P8 · 깨진 .claude/settings.json", () => {
  test("doctor 가 사유를 말하고, 처방한 init 이 스택 없이 멈춘다", () => {
    gitInit();
    write(".claude/settings.json", '{ "hooks": { broken');

    const report = doctor(repo);
    assert.equal(report.ok, false);
    const row = line(report.text, "hook 설정 파일");
    assert.match(row, /^✗ hook 설정 파일: .*settings\.json 을 읽을 수 없습니다/);
    assert.match(hint(report.text, "hook 설정 파일"), /고친 뒤 code-agent init/);
    // 끝까지 찍는다 — 한 줄 보고 고치고 다시 도는 것을 반복하게 만들지 않는다
    assert.match(report.text, /막는 문제가 없습니다|^✗ \d+개:/m);

    // 처방이 맨 SyntaxError 로 죽지 않는다
    assert.throws(() => init(repo), (error: unknown) => error instanceof Stop && /읽을 수 없습니다/.test(error.message));
    assert.throws(() => update(repo), (error: unknown) => error instanceof Stop);
  });
});

describe("P8 · 이 버전에 없는 스킬·에이전트", () => {
  test("update 는 `!!` 로, doctor 는 `·` 로 알리고 지우지 않는다", () => {
    gitInit();
    init(repo, { cli: CLI });
    write(".claude/skills/ca-gone/SKILL.md", "# 옛 버전의 스킬\n");
    write(".claude/agents/ca-gone.md", "# 옛 버전의 에이전트\n");

    assert.match(update(repo), /이 버전에 없는 스킬·에이전트 2개가 남아 있습니다/);
    assert.ok(existsSync(join(repo, ".claude/skills/ca-gone/SKILL.md")), "자동으로 지우지 않는다");

    const report = doctor(repo);
    const row = line(report.text, "이 버전에 없는 스킬·에이전트");
    assert.match(row, /^· /); // 막지 않는다 — 사람이 만든 ca- 스킬과 가릴 수 없다
    assert.match(row, /2개: \.claude\/agents\/ca-gone\.md · \.claude\/skills\/ca-gone\/SKILL\.md/);
    // 마지막 요약 줄의 ✗ 목록에 들어가지 않는다
    assert.doesNotMatch(report.text, /✗ \d+개:.*이 버전에 없는/);
  });

  test("우리 것이 아닌 스킬은 세지 않는다", () => {
    gitInit();
    init(repo, { cli: CLI });
    write(".claude/skills/team-thing/SKILL.md", "# 팀의 스킬\n");
    assert.doesNotMatch(update(repo), /이 버전에 없는/);
  });
});

describe("P8 · 한 번도 깔지 않은 저장소", () => {
  test("두 검사가 같은 처방을 준다 — `다릅니다` 가 아니라 `설치되지 않았습니다` 다", () => {
    gitInit();
    const report = doctor(repo);
    assert.equal(line(report.text, "스킬·에이전트"), "✗ 스킬·에이전트: 설치되지 않았습니다 (.claude/skills/ca-*, .claude/agents/ca-*)");
    assert.match(hint(report.text, "스킬·에이전트"), /code-agent init$/);
    // 검사 6 도 같은 사실을 본다 — 한 원인에 두 처방을 주지 않는다
    assert.match(line(report.text, "설치 버전"), /^· 설치 버전: \.code-agent\/version 이 없습니다/);
  });
});

describe("P8 · 자원을 읽지 못하는 단일 실행 파일", () => {
  /** `getAssetKeys` 가 없는 node:sea — 24.8 미만으로 묶은 바이너리의 모습이다 */
  function withBrokenSea<T>(body: (doctor: typeof import("../agent/doctor")) => T): T {
    const fake = { isSea: () => true, getAsset: () => "", getAssetKeys: undefined };
    const loader = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
    const original = loader._load;
    const paths = [require.resolve("../agent/assets"), require.resolve("../agent/init"), require.resolve("../agent/doctor")];
    const saved = paths.map((path) => require.cache[path]);
    loader._load = function (request: string, parent: unknown, isMain: boolean) {
      return request === "node:sea" ? fake : original.call(this, request, parent, isMain);
    };
    for (const path of paths) delete require.cache[path];
    try {
      return body(require("../agent/doctor"));
    } finally {
      loader._load = original;
      paths.forEach((path, index) => {
        const module = saved[index];
        if (module) require.cache[path] = module;
        else delete require.cache[path];
      });
    }
  }

  test("doctor 가 죽지 않고 한 문장으로 이유를 말한다 — 깨진 설치를 설명할 유일한 명령이다", () => {
    gitInit();
    const report = withBrokenSea((loaded) => loaded.doctor(repo));
    assert.equal(report.ok, false);
    assert.match(line(report.text, "번들 자원"), /node:sea\.getAssetKeys 가 없는 Node/);
    assert.match(hint(report.text, "번들 자원"), /npm run build:bin/);
    // 요약 줄까지 반드시 닿는다
    assert.match(report.text, /^✗ \d+개:/m);
    // 단일 실행 파일이라는 사실 자체는 맞게 말한다
    assert.match(line(report.text, "런타임"), /단일 실행 파일/);
  });
});

describe("P8 · 매니페스트의 빈 배열", () => {
  test("영문 zod 기본 문구가 아니라 고치는 법이 나온다", () => {
    write("code-agent.json", JSON.stringify({ build: [] }));
    assert.throws(
      () => loadManifestIfAny(repo),
      /빈 배열은 선언하지 않은 것과 같습니다 — 키를 지우거나 실제 명령을 적으세요/,
    );
  });

  test("doctor 는 어느 키가 왜 틀렸는지까지 남긴다 — 머리말만 남기지 않는다", () => {
    gitInit();
    write("code-agent.json", JSON.stringify({ build: [] }));
    const report = doctor(repo);
    assert.match(line(report.text, "매니페스트"), /형식 오류/);
    assert.match(hint(report.text, "매니페스트"), /build: 빈 배열은 선언하지 않은 것과 같습니다/);
  });
});

describe("P8 · CLI 의 `--깃발 <값>`", () => {
  function cli(...args: string[]): { code: number; text: string } {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf-8" });
    return { code: result.status ?? -1, text: `${result.stdout}${result.stderr}` };
  }

  test("값 없는 깃발은 무시되지 않고 멈춘다 — 그럴듯한데 틀린 숫자를 막는다", () => {
    gitInit();
    assert.deepEqual(cli("usage", "--since"), { code: 1, text: "--since 에 값이 필요합니다: code-agent … --since <값>\n" });
    assert.match(cli("usage", "--work", "--since", "2026-09-30").text, /--work 에 값이 필요합니다/);
  });

  test("값을 준 깃발은 그대로 간다", () => {
    gitInit();
    assert.match(cli("usage", "--since", "지난주").text, /--since 의 날짜를 읽을 수 없습니다/);
  });
});

describe("P8 · 캐시 쓰기와 모델 이름", () => {
  /** `model` 은 기본값을 두지 않는다 — undefined 를 넘기면 기본값이 되살아나 이름 없는 줄을 못 만든다 */
  function fixture(usageFields: Record<string, unknown>, model?: string): string {
    const dir = join(repo, "transcripts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "s1.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-30T02:00:00.000Z",
        message: { id: "msg-1", ...(model ? { model } : {}), usage: usageFields },
      })}\n`,
      "utf-8",
    );
    return dir;
  }

  test("모르는 TTL 칸이 생겨도 캐시 쓰기 토큰이 사라지지 않는다", () => {
    const text = usage(repo, {
      transcripts: fixture({ cache_creation: { ephemeral_5m_input_tokens: 100 }, cache_creation_input_tokens: 300 }, "claude-opus-5"),
    });
    // 아는 두 칸(100 + 0)의 나머지 200 을 5분 칸으로 되돌린다 — 버리면 비용에서 조용히 빠진다
    assert.match(text, /^\s*합계\s+0\s+0\s+300\s+0\s/m);
  });

  test("아는 칸의 합이 총계와 같으면 아무것도 바뀌지 않는다", () => {
    const text = usage(repo, {
      transcripts: fixture({
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
        cache_creation_input_tokens: 300,
      }, "claude-opus-5"),
    });
    assert.match(text, /^\s*합계\s+0\s+0\s+300\s+0\s/m);
  });

  test("모델 이름이 없는 줄은 에이전트 이름이 아니라 모델 자리의 이름으로 뜬다", () => {
    const text = usage(repo, { transcripts: fixture({ output_tokens: 10 }) });
    assert.match(text, /비용 미산정 모델: \(모델 없음\)/);
    assert.doesNotMatch(text, /비용 미산정 모델: \(알 수 없음\)/);
  });
});
