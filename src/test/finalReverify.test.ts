/**
 * 최종 재검증(952594c) 지적 R1~R6 의 회귀 시험 — 지적마다 되돌리면 실패한다. 지적 번호는 doc/reviews/2026-10-08-procedure-fix-summary.md 의
 * '전체 검토와 후속 수정' 절이다(지적별 처리 표는 git show 0a77595:doc/reviews/2026-10-08-full-review.md). 그 수정(72f6b97)의 반박 검증 지적 F1~F4 시험도 고친 R 의 이름으로 여기 있다(F1·F2 → R2, F3 → R3, F4 → R6 —
 * 같은 절). 모델·호스트는 부르지 않는다(교차는 가짜 실행 파일 경로만 쓴다).
 * R1 은 사용자 홈을 임시 폴더로 바꾼 뒤(USERPROFILE·HOME·CODEX_HOME) 판정 함수만 부른다 — 사용자의 실제 ~/.claude·~/.codex 파일은 읽거나 쓰지 않는다.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { codexHook } from "../agent/codexHook";
import { next, requireValidatable, status } from "../agent/commands";
import { doctor } from "../agent/doctor";
import { loadEvidence, reviewRoundUsage } from "../agent/evidence";
import { decide, foldStreams, type HookInput } from "../agent/hook";
import { crossNotice } from "../agent/hosts";
import { init } from "../agent/init";
import { loadActive, reviewFile } from "../agent/layout";
import { pidAlive } from "../agent/lock";
import { storePath } from "../agent/plugins/store";
import { loadReview, openRound } from "../agent/review";
import { budgetReport, grantRetry } from "../agent/retryGrant";
import { guidance, NO_REVIEW_CHOICES, POLICIES, RetryRefused, stateGuardText } from "../agent/retryPolicy";
import { check, integrate, runTests } from "../agent/validate";
import { verify } from "../agent/verificationFlow";
import { loadWork } from "../agent/work";
import { setupConsentProject } from "./consentFixture";
import { deadPid, UNASSIGNED_PID_FLOOR } from "./deadPid";
import { crossReview } from "../agent/crossCheck";
import { recordReviewFixture, withCaller } from "./reviewFixture";
import { createStageRepo, ORDER, PRINT_CASES, removeStageRepo, repo, TEST_FILE, toCheck, toIntegrate, toReview, useManifest, write, writeFileHook, writeFindings, writeFindingsDoc } from "./stageFixture";

const ROOT = join(__dirname, "..", "..");
const nextLine = (text: string): string => text.split("\n").find((line) => line.startsWith("다음: ")) ?? "";
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WIN = process.platform === "win32";

// ---- R1 — 사용자 수준 호스트 설정의 다른 이름(NTFS 스트림 표기·Windows 별칭) ----

describe("R1 — 사용자 수준 호스트 설정 쓰기 거부를 같은 파일의 다른 이름으로 비켜 가지 못한다", () => {
  let root: string, home: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["USERPROFILE", "HOME", "CODEX_HOME", "CODE_AGENT_HOME", "CLAUDECODE"];
  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-r1-repo-")));
    home = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-r1-home-")));
    // 홈을 임시 폴더로 — hook 의 homedir()·CODEX_HOME 이 여기를 본다. 실제 사용자 파일은 건드리지 않는다
    process.env.USERPROFILE = home; process.env.HOME = home;
    process.env.CODEX_HOME = join(home, "codex-home");
    process.env.CODE_AGENT_HOME = join(home, ".code-agent");
    delete process.env.CLAUDECODE;
    mkdirSync(process.env.CODE_AGENT_HOME, { recursive: true });
    writeFileSync(storePath(), "{}");
    for (const file of [".claude/settings.json", ".claude/settings.local.json", ".codex/hooks.json", ".codex/config.toml", "codex-home/hooks.json"]) {
      mkdirSync(dirname(join(home, file)), { recursive: true });
      writeFileSync(join(home, file), "{}");
    }
    setupConsentProject(root);
  });
  afterEach(() => {
    for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    const temporary = realpathSync.native(tmpdir());
    for (const target of [root, home]) {
      assert.ok(resolve(target).startsWith(temporary + sep) && /^ca-r1-/.test(resolve(target).slice(temporary.length + 1)), target);
      rmSync(target, { recursive: true, force: true });
    }
  });

  const DENIED = /사용자 수준 호스트 설정[\s\S]*disableAllHooks/;
  const tool = (tool_name: string, tool_input: HookInput["tool_input"], cwd = root) => decide({ cwd, session_id: "s", tool_name, tool_input }, root);
  /** Write·Edit·MultiEdit·NotebookEdit 가 모두 같은 판정을 받는다 */
  const writes = (target: string, cwd = root) => [
    tool("Write", { file_path: target }, cwd), tool("Edit", { file_path: target }, cwd),
    tool("MultiEdit", { file_path: target }, cwd), tool("NotebookEdit", { notebook_path: target }, cwd),
  ];
  const patch = (path: string, cwd = root) => {
    const result = codexHook({ cwd, session_id: "s", hook_event_name: "PreToolUse", tool_name: "apply_patch",
      tool_input: { command: `*** Begin Patch\n*** Update File: ${path}\n@@\n-{}\n+{"disableAllHooks":true}\n*** End Patch` } } as Parameters<typeof codexHook>[0]) as
      { hookSpecificOutput?: { permissionDecisionReason?: string } };
    return result.hookSpecificOutput?.permissionDecisionReason;
  };
  /** 8.3 짧은 이름 — 볼륨이 만들지 않으면 undefined */
  const shortName = (path: string): string | undefined => {
    const out = spawnSync("cmd", ["/d", "/c", `for %I in ("${path}") do @echo %~sI`], { encoding: "utf8", windowsVerbatimArguments: true }).stdout?.trim();
    return out && out.toLowerCase() !== path.toLowerCase() && /~\d/.test(out) ? out : undefined;
  };

  test("R1 foldStreams — 스트림 표기·폴더 스트림·이름 끝 점·공백을 본 이름으로 접고, 장치 접두·드라이브·`.`·`..` 는 둔다(win32 만)", () => {
    const cases: [string, string][] = [
      ["C:\\u\\.claude\\settings.json::$DATA", "C:\\u\\.claude\\settings.json"],
      ["C:\\u\\.claude\\settings.json:$DATA", "C:\\u\\.claude\\settings.json"],
      ["C:\\u\\.claude\\settings.json:x", "C:\\u\\.claude\\settings.json"],
      ["C:\\u\\.claude::$INDEX_ALLOCATION\\settings.json", "C:\\u\\.claude\\settings.json"],
      ["C:\\u\\.claude:$I30:$INDEX_ALLOCATION\\settings.json", "C:\\u\\.claude\\settings.json"],
      ["C:/u/.claude. /settings.json. ", "C:/u/.claude/settings.json"],
      ["\\\\?\\C:\\u\\settings.json::$DATA", "\\\\?\\C:\\u\\settings.json"],
      ["..\\a\\.\\b:x", "..\\a\\.\\b"],
    ];
    for (const [input, folded] of cases) assert.equal(foldStreams(input, "win32"), folded, input);
    assert.equal(foldStreams("/home/u/.claude/settings.json:x", "linux"), "/home/u/.claude/settings.json:x", "다른 플랫폼에서 ':' 는 이름의 글자다");
  });

  test("R1 쓰기 도구(Write·Edit·MultiEdit·NotebookEdit) — 스트림 표기·긴 경로 접두·로컬 관리 공유·대소문자·슬래시·`..`·상대 경로·8.3 이름을 같은 파일로 막는다", { skip: !WIN }, () => {
    const settings = join(home, ".claude", "settings.json");
    const drive = home.slice(0, 1), rest = home.slice(2);
    const aliases = [
      `${settings}::$DATA`, `${settings}:$DATA`, `${settings}:stream`, `${settings}::$data`,
      join(home, ".claude::$INDEX_ALLOCATION", "settings.json"),
      join(home, ".claude:$I30:$INDEX_ALLOCATION", "settings.local.json"),
      join(home, ".CLAUDE", "SETTINGS.JSON"),
      settings.replace(/\\/g, "/"),
      `${home}\\.claude\\sub\\..\\settings.json`,
      `\\\\?\\${settings}::$DATA`,
      `\\\\localhost\\${drive}$${rest}\\.claude\\settings.json:$DATA`,
      `\\\\?\\UNC\\localhost\\${drive}$${rest}\\.claude\\settings.json`,
      join(home, ".codex", "hooks.json::$DATA"),
      join(home, ".codex::$INDEX_ALLOCATION", "config.toml"),
      join(home, "codex-home", "hooks.json:x"),
      `~/.claude/settings.json::$DATA`,
      relative(root, `${settings}::$DATA`),
    ];
    const short = shortName(settings);
    if (short) aliases.push(short, `${short}::$DATA`);
    for (const alias of aliases) {
      for (const [index, reason] of writes(alias).entries()) assert.match(reason ?? "", DENIED, `${["Write", "Edit", "MultiEdit", "NotebookEdit"][index]} ${alias}`);
    }
    // 세션 작업 경로 기준 상대 경로 — 홈에서 연 세션
    for (const reason of writes(".claude\\settings.json::$DATA", home)) assert.match(reason ?? "", DENIED, "cwd 기준 상대 경로");
    // 이름 끝의 점·공백은 별칭 거부가 먼저 막는다
    for (const reason of writes(`${settings}.`)) assert.match(reason ?? "", /이름 끝의 점·공백/);
    // 같은 이름이 아닌 파일은 관여하지 않는다
    for (const other of [join(home, ".claude", "notes.md"), join(home, ".claude", "notes.md::$DATA"), join(home, ".claude", "settings.json.bak"), join(home, "other", "settings.json")]) {
      for (const reason of writes(other)) assert.equal(reason, undefined, other);
    }
  });

  test("R1 공격 검증 — 이름이 파일 서버가 아닌 MCP 쓰기 도구도 사용자 수준 호스트 설정의 절대 경로(다른 이름 포함)는 막고, 그 밖의 저장소 밖 경로·읽기·원격 서비스 경로는 판정하지 않는다", () => {
    const settings = join(home, ".claude", "settings.json");
    const mcp = (name: string, input: Record<string, unknown>) => tool(name, input as HookInput["tool_input"]);
    const writes: [string, Record<string, unknown>][] = [
      ["mcp__acme__write_note", { path: settings }],
      ["mcp__x__rename", { new_path: join(home, ".codex", "hooks.json") }],
      ["mcp__x__copy", { destination: join(home, "codex-home", "config.toml") }],
      ["mcp__x__save", { options: { file: join(home, ".claude", "settings.local.json") } }],
      ["mcp__x__write", { uri: pathToFileURL(settings).href }],
      ["mcp__x__write", { path: "~/.claude/settings.json" }],
    ];
    if (WIN) writes.push(["mcp__acme__write_note", { path: `${settings}::$DATA` }], ["mcp__acme__write_note", { path: join(home, ".CLAUDE", "SETTINGS.JSON") }]);
    for (const [name, input] of writes) assert.match(mcp(name, input) ?? "", DENIED, `${name} ${JSON.stringify(input)}`);
    assert.equal(mcp("mcp__acme__read_note", { path: settings }), undefined, "읽기는 판정하지 않는다(Read 와 같다)");
    assert.equal(mcp("mcp__acme__write_note", { path: join(home, ".claude", "notes.md") }), undefined, "호스트 설정이 아닌 저장소 밖 파일");
    assert.equal(mcp("mcp__github__create_or_update_file", { path: ".claude/settings.json" }), undefined, "원격 서비스의 상대 경로");
    assert.equal(mcp("mcp__drive__write_file", { path: "/My Drive/settings.json" }), undefined, "원격 서비스의 절대 경로");
  });

  test("R1 파일 번호(dev, ino) — 하드 링크·폴더 연결(junction)로 단 다른 이름도 같은 파일로 막는다", { skip: !WIN }, () => {
    const alias = join(home, "alias.json");
    linkSync(join(home, ".claude", "settings.json"), alias);
    for (const reason of writes(alias)) assert.match(reason ?? "", DENIED, "하드 링크");
    symlinkSync(join(home, ".claude"), join(home, "linked"), "junction");
    for (const target of [join(home, "linked", "settings.json"), join(home, "linked", "settings.local.json::$DATA")]) {
      for (const reason of writes(target)) assert.match(reason ?? "", DENIED, target);
    }
  });

  test("R1 Codex apply_patch — 스트림 표기·별칭 경로의 패치도 같은 판정이다", { skip: !WIN }, () => {
    const hooks = join(home, ".codex", "hooks.json");
    for (const path of [`${hooks}::$DATA`, join(home, ".codex::$INDEX_ALLOCATION", "hooks.json"), `\\\\?\\${hooks}:x`, join(home, ".CODEX", "CONFIG.TOML:$DATA"), join(home, "codex-home", "hooks.json::$DATA")]) {
      assert.match(patch(path) ?? "", DENIED, path);
    }
    assert.match(patch(".codex\\hooks.json::$DATA", home) ?? "", DENIED, "cwd 기준 상대 경로");
    assert.equal(patch(join(home, ".codex", "notes.md")), undefined);
  });

  test("R1 셸 언급 — 호스트 설정 폴더·상태 폴더의 스트림 표기와 `<이름>\\..\\` 도 같은 자리로 막는다", () => {
    const HOST = /호스트 hook 설정\(\.claude\/settings\.json/;
    const STATE = /`\.code-agent\/` 는 code-agent 명령으로만 바뀝니다/;
    for (const command of [
      `echo {} > '${home}\\.claude::$INDEX_ALLOCATION\\settings.json'`,
      "echo {} > '.claude:$I30:$INDEX_ALLOCATION/settings.json'",
      "echo {} > .claude/a/../settings.json",
      "echo {} > .claude\\.\\settings.local.json",
      "echo x > .codex::$INDEX_ALLOCATION/hooks.json",
      "echo x > .codex/x/../config.toml",
      // 겹친 `<이름>/..` — 되풀이해 접은 꼴도 본다
      "echo {} > .claude/a/b/../../settings.json",
      "Set-Content .claude\\x\\y\\..\\..\\settings.local.json '{}'",
      "echo x > .codex\\a\\b\\c\\..\\..\\..\\hooks.json:x",
    ]) assert.match(tool("Bash", { command }) ?? "", HOST, command);
    // 접으면 호스트 설정 폴더 밖이다 — `.claude/a/../../settings.json` 은 `.claude` 의 부모
    for (const command of ["echo {} > .claude/a/../../settings.json", "echo {} > .claude/../settings.json"]) {
      assert.equal(tool("Bash", { command }), undefined, command);
    }
    for (const command of ["echo {} > '.code-agent::$INDEX_ALLOCATION/active.json'", "echo {} > .code-agent:$I30:$INDEX_ALLOCATION\\active.json"]) {
      assert.match(tool("Bash", { command }) ?? "", STATE, command);
    }
    assert.equal(tool("Bash", { command: "echo .claude-notes" }), undefined, "이름이 다른 것은 관여하지 않는다");
  });
});

// ---- R2·R4 — 검증 단계(임시 git 저장소, 주문 도메인 ORD-1) ----

describe("R2 — 검증 명령이 code-agent 기록을 바꿔 되돌린 실행은 전제 미충족이고, status·next·verify·재실행 거부가 같은 사실을 말한다", () => {
  beforeEach(() => createStageRepo("ca-r2-"));
  afterEach(() => { delete process.env.CA_R2_TAMPER; removeStageRepo(); });
  const REVIEW_JSON = ".code-agent/work/ORD-1/order.review.json";
  const GUARD = new RegExp(escape(stateGuardText([REVIEW_JSON])));

  // CA_R2_TAMPER 가 있으면 테스트 코드가 리뷰 기록을 지운다(사람이 테스트를 그렇게 바꾼 것을 흉내)
  const TAMPER_TEST = ["node", "-e", `const fs = require('fs'); if (process.env.CA_R2_TAMPER) fs.rmSync('${REVIEW_JSON}', { force: true }); console.log('ok 1 - TC-1'); console.log('ok 2 - TC-2')`];
  const UNCONFIRMED_TC = /⑦ 의 테스트 케이스가 확인되지 않았습니다/;

  test("R2 리뷰 기록을 지운 test 는 되돌리고, 같은 문장으로 멈추며 리뷰 회차 사용량은 줄지 않는다 — 계획 안에서 고친 뒤 verify 가 새 회차로 통과한다", async () => {
    useManifest({ test: TAMPER_TEST });
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings();
    const before = readFileSync(reviewFile(repo, "ORD-1", "order"), "utf8");
    const usedBefore = reviewRoundUsage(loadWork(repo)!).used;
    process.env.CA_R2_TAMPER = "1";
    write(`${ORDER}/domain/Order.java`, "class Order { int c1; }\n");
    await assert.rejects(verify(repo), GUARD, "verify 는 전제 미충족 Stop(JSON 없음 — 사람 확인 멈춤)이고 사유가 같은 문장이다");
    assert.equal(readFileSync(reviewFile(repo, "ORD-1", "order"), "utf8"), before, "지운 리뷰 기록을 되돌렸다");
    assert.equal(loadReview(repo, "ORD-1", "order")!.rounds.length, 1);
    assert.ok(reviewRoundUsage(loadWork(repo)!).used >= usedBefore, "리뷰 회차 사용량이 줄지 않는다(E15)");
    assert.equal(loadActive(repo)!.phase, "test");
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    const runs = evidence.runs.filter((run) => run.phase === "test" && run.round === evidence.rounds);
    assert.ok(runs.length > 0 && runs.every((run) => run.cause === "guard" && run.outcome === "error" && run.guarded?.includes(REVIEW_JSON)), JSON.stringify(runs));
    // status 다음: — 앞 회차의 통과를 '검증 통과' 로 내지 않는다
    const line = nextLine(status(repo));
    assert.match(line, GUARD, line);
    assert.doesNotMatch(line, /검증 통과/);
    // next 의 거부 — 같은 문장이고 '다시 돌리세요' 꼬리가 없다. 그 출력으로 TC 를 읽지 않았으므로 ⑦ 미확인 줄('TC id 를 남기세요')도 없다
    assert.throws(() => next(repo), (error: Error) => GUARD.test(error.message) && !/로 다시 돌리세요/.test(error.message) && !/검증 통과/.test(error.message) &&
      !UNCONFIRMED_TC.test(error.message));
    // 같은 코드 재실행 거부(test)와 verify --retry 도 같은 문장
    await assert.rejects(runTests(requireValidatable(repo, "test")), (error: unknown) => error instanceof RetryRefused && error.failure.class === "precondition" && GUARD.test(error.message));
    await assert.rejects(verify(repo, { retry: true }), GUARD);
    assert.equal(readFileSync(reviewFile(repo, "ORD-1", "order"), "utf8"), before);
    // 계획 안에서 고친다(테스트가 기록을 건드리지 않게) — 새 회차로 다시 검증해 리뷰로 간다
    delete process.env.CA_R2_TAMPER;
    write(`${ORDER}/domain/Order.java`, "class Order { int c2; }\n");
    const result = await verify(repo);
    assert.equal(result.node, "review");
    assert.doesNotMatch(nextLine(status(repo)), GUARD);
  });

  test("R2 test 의 기록 변경 뒤 verify --retry·check 의 거부로 커서가 check 에 서도 다음: 은 '검증 통과' 가 아니라 같은 회차의 기록 변경 사유다 — 그 자리의 verify 가 멈추는 문장과 같다", async () => {
    useManifest({ test: TAMPER_TEST });
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings();
    process.env.CA_R2_TAMPER = "1";
    write(`${ORDER}/domain/Order.java`, "class Order { int c1; }\n");
    await assert.rejects(verify(repo), GUARD);
    assert.equal(loadActive(repo)!.phase, "test");
    // 같은 코드 재실행 거부 — --retry 는 check 로 되감은 뒤 거부된다
    await assert.rejects(verify(repo, { retry: true }), GUARD);
    assert.equal(loadActive(repo)!.phase, "check");
    await assert.rejects(check(requireValidatable(repo, "check")), (error: unknown) => error instanceof RetryRefused && error.failure.class === "precondition" && GUARD.test(error.message));
    const line = nextLine(status(repo));
    assert.doesNotMatch(line, /검증 통과/, line);
    assert.match(line, GUARD, line);
    // check 커서의 verify 는 check 를 통과로 보고 test 로 넘어가 같은 사유로 멈춘다 — 다음: 이 그 Stop 과 같은 전제 안내다
    const stopped = await verify(repo).then(() => "", (error: Error) => error.message);
    assert.equal(stopped, guidance("precondition", { problems: stateGuardText([REVIEW_JSON]) }));
    assert.ok(line.includes(` — ${stopped}`), `${line}\n— verify: ${stopped}`);
    assert.equal(loadActive(repo)!.phase, "test");
    assert.ok(nextLine(status(repo)).includes(stopped));
  });

  test("R2 얼어 있는 테스트를 바꾼 데다 기록 변경까지 겹치면 다음:·next·verify 가 같은 두 사유를 싣고, 그 회차의 ⑦ 미확인 줄은 싣지 않는다", async () => {
    useManifest({ test: TAMPER_TEST });
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings();
    process.env.CA_R2_TAMPER = "1";
    // 사람이 동결된 테스트 파일을 바꿨다(지적 없이) — 게이트의 동결 대조가 잡는다
    write(TEST_FILE, "// TC-1 · TC-2\nclass OrderTest { int changed; }\n");
    write(`${ORDER}/domain/Order.java`, "class Order { int c1; }\n");
    const stopped = await verify(repo).then(() => "", (error: Error) => error.message);
    const FROZEN = /테스트 동결 뒤 바뀐 kind:test 파일: src\/test\/java\/com\/acme\/app\/application\/order\/OrderTest\.java/;
    assert.match(stopped, FROZEN);
    assert.match(stopped, GUARD);
    const line = nextLine(status(repo));
    assert.ok(line.includes(` — ${stopped}`), `다음: 이 verify 의 Stop 과 같은 목록이다\n${line}\n— verify: ${stopped}`);
    assert.throws(() => next(repo), (error: Error) => FROZEN.test(error.message) && GUARD.test(error.message) && !UNCONFIRMED_TC.test(error.message));
  });

  test("R2 첫 test 가 기록을 만들면 지우고, 그 실행으로 TC 결과를 읽거나 테스트를 얼리지 않는다", async () => {
    useManifest({ test: ["node", "-e", `const fs = require('fs'); fs.mkdirSync('.code-agent/work/ORD-1', { recursive: true }); fs.writeFileSync('${REVIEW_JSON}', '{}'); console.log('ok 1 - TC-1'); console.log('ok 2 - TC-2')`] });
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    const text = await runTests(requireValidatable(repo, "test")).catch((error: Error) => error.message);
    assert.match(text, GUARD);
    assert.equal(existsSync(join(repo, REVIEW_JSON)), false, "만든 기록을 지웠다");
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(evidence.testFreeze, undefined, "기록을 바꾼 실행으로 테스트를 얼리지 않는다");
    assert.equal(evidence.testCases.some((entry) => entry.source === "출력"), false, "그 출력으로 TC 결과를 읽지 않는다");
    assert.equal(evidence.retry?.started, undefined, "시작 표지는 정상으로 지운다(끊긴 실행이 아니다)");
    assert.match(nextLine(status(repo)), GUARD);
  });

  test("R2 통합 검증의 준비 명령이 기록을 바꿔도 같다 — 환경 실패로 분류하지 않고, 같은 코드 재실행·next·다음: 이 같은 문장이다", async () => {
    // 통합 검증은 기준 커밋 위의 worktree 에서 돈다 — 저장소의 리뷰 기록을 절대 경로로 지운다
    useManifest({ test: PRINT_CASES, prepare: ["node", "-e", `require('fs').rmSync(${JSON.stringify(join(repo, REVIEW_JSON))}, { force: true })`] });
    await toIntegrate();
    const before = readFileSync(reviewFile(repo, "ORD-1", "order"), "utf8");
    const text = await integrate(requireValidatable(repo, "integrate"));
    assert.match(text, GUARD);
    assert.doesNotMatch(text, /환경 문제로 분류했습니다/, "기록 변경은 환경 실패가 아니다");
    assert.equal(readFileSync(reviewFile(repo, "ORD-1", "order"), "utf8"), before);
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    const runs = evidence.runs.filter((run) => run.phase === "integrate" && run.round === evidence.rounds);
    assert.deepEqual(runs.map((run) => [run.kind, run.outcome, run.cause]), [["prepare", "error", "guard"]]);
    assert.match(nextLine(status(repo)), GUARD);
    assert.throws(() => next(repo), GUARD);
    await assert.rejects(integrate(requireValidatable(repo, "integrate")), (error: unknown) => error instanceof RetryRefused && error.failure.class === "precondition" && GUARD.test(error.message));
  });

  test("R2 실행은 통과했어도 게이트 문제가 남으면 '검증 통과' 로 내지 않는다 — 검증 뒤 바뀐 계획 파일·계획 밖 변경이 next·verify 와 같은 사실이다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    assert.match(nextLine(status(repo)), /^다음: 검증 통과 — code-agent next 로 넘긴 뒤/);
    // 검증 뒤 계획 파일을 고쳤다 — next 는 거부하고 verify 는 check 부터 다시 돈다(--retry 가 아니다)
    write(`${ORDER}/domain/Order.java`, "class Order { int c1; }\n");
    let line = nextLine(status(repo));
    assert.match(line, /검증 뒤 계획 파일이 바뀌었습니다[^\n]* — code-agent verify --json \(/, line);
    assert.doesNotMatch(line, /검증 통과|--retry/);
    assert.throws(() => next(repo), /검증 뒤 계획 파일이 바뀌었습니다/);
    // 계획 밖 변경 — 다시 돌려도 남는 문제다. 다음: 은 verify 가 멈추는 사유와 같다
    write("notes.txt", "memo\n");
    line = nextLine(status(repo));
    assert.match(line, /검증 전제가 맞지 않습니다: 계획 밖 변경: \[\S+\] notes\.txt/, line);
    assert.doesNotMatch(line, /검증 통과/);
    assert.throws(() => next(repo), /계획 밖 변경: \[\S+\] notes\.txt/);
    await assert.rejects(verify(repo), /계획 밖 변경 \[\S+\] notes\.txt/);
  });

  test("R2 이 회차의 test 를 아직 돌리지 않았으면 다음: 은 앞 회차의 결과가 아니라 이어서 돌 verify 다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    const line = nextLine(status(repo));
    assert.match(line, /1회차 test 를 아직 돌리지 않음 — code-agent verify --json \(/, line);
    assert.doesNotMatch(line, /검증 통과|--retry/);
  });

  test("R2 앞 회차의 test 통과로 지금 회차를 '검증 통과' 로 내지 않는다 — next 의 회차 불일치 거부와 같은 사실이다", async () => {
    // 1회차 check·test 통과 → 리뷰 → 통과 뒤 변경으로 2회차 check 만 돌고 test 커서에 선 자리(지적의 꼴)
    await toReview();
    write(`${ORDER}/domain/Order.java`, "class Order { int c1; }\n");
    await check(requireValidatable(repo, "check"));
    next(repo);
    assert.equal(loadActive(repo)!.phase, "test");
    const line = nextLine(status(repo));
    assert.match(line, /2회차 test 를 아직 돌리지 않음 — code-agent verify --json \(/, line);
    assert.doesNotMatch(line, /검증 통과|--retry/);
    assert.throws(() => next(repo), (error: Error) => /test 결과가 2회차의 것이 아닙니다/.test(error.message) && !/검증 통과/.test(error.message));
    // 이어서 돈 verify 는 2회차 test 를 돌려 리뷰로 간다
    assert.equal((await verify(repo)).node, "review");
  });
});

describe("R4 — 리뷰 없이 리뷰 회차를 다 쓴 자리의 안내는 실제로 받는 동의와 같은 선택지다", () => {
  beforeEach(() => createStageRepo("ca-r4-"));
  afterEach(() => removeStageRepo());
  const change = (n: number) => write(`${ORDER}/domain/Order.java`, `class Order { int v${n}; }\n`);
  const CHOICES = new RegExp(escape(NO_REVIEW_CHOICES));

  test("R4 verify decision·status 다음:·hook·허용 거부가 같은 세 선택지이고 허용·기각을 싣지 않는다 — 되돌리는 길로 리뷰까지 간다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    for (let n = 1; n <= 3; n++) { change(n); await check(requireValidatable(repo, "check")); }
    change(4);
    const refused = await check(requireValidatable(repo, "check")).then(() => undefined, (error: unknown) => error);
    assert.ok(refused instanceof RetryRefused && refused.failure.counter?.key === "reviewRounds" && refused.failure.kind === "no-review", String(refused));
    assert.match(refused.message, CHOICES);
    const result = await verify(repo);
    assert.equal(result.node, "decision");
    assert.match(result.task, CHOICES, "verify 의 decision 안내");
    assert.doesNotMatch(result.task, /한 번 더 허용|retry-grant/);
    const line = nextLine(status(repo));
    assert.match(line, CHOICES, line);
    assert.doesNotMatch(line, /retry-grant reviewRounds|waive-finding/);
    const hook = writeFileHook(`${ORDER}/domain/Order.java`) ?? "";
    assert.match(hook, CHOICES, "hook 쓰기 거부");
    assert.doesNotMatch(hook, /회차 추가·지적 기각은/);
    assert.throws(() => budgetReport(repo, "reviewRounds"), CHOICES, "허용 미리보기 거부");
    assert.throws(() => grantRetry(repo, "reviewRounds", "a1b2c3d4-0000-0000-0000-000000000000", "r"), CHOICES, "허용 거부");
    // 첫 선택지 — 사람이 바꾼 계획 파일을 통과한 트리로 되돌리면 같은 트리 재사용이라 카운터 없이 통과하고 리뷰로 간다
    change(3);
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    next(repo);
    assert.equal(loadActive(repo)!.phase, "review");
    openRound(requireValidatable(repo, "review"));
  });

  test("R4 리뷰를 열었고 열린 지적이 없으면 회차 추가만 싣고 지적 기각은 싣지 않는다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings();
    for (let n = 1; n <= 3; n++) { change(n); await check(requireValidatable(repo, "check")); }
    change(4);
    await assert.rejects(check(requireValidatable(repo, "check")), (error: unknown) => error instanceof RetryRefused && error.failure.kind === undefined);
    const line = nextLine(status(repo));
    assert.match(line, /회차 추가\(\S*ca-answer 의 judgment 동의 retry-grant reviewRounds\)/, line);
    assert.doesNotMatch(line, /waive-finding|지적 기각/);
    const hook = writeFileHook(`${ORDER}/domain/Order.java`) ?? "";
    assert.match(hook, /회차 추가는 ca-answer 의 judgment 동의/);
    assert.doesNotMatch(hook, /지적 기각/);
  });
});

// ---- R3 — 교차 검증 안내의 설정 오류·실행 불가 구분 ----

describe("R3 — 교차 검증 안내(status·doctor·init)는 설정 오류와 실행 불가를 나눠 쓴다", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["CODE_AGENT_CLAUDE_BIN", "CODE_AGENT_CODEX_BIN", "PATH", "APPDATA"];
  before(() => { for (const key of KEYS) saved[key] = process.env[key]; });
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-r3-")));
    mkdirSync(join(dir, ".code-agent"), { recursive: true });
    writeFileSync(join(dir, ".code-agent", "hosts.json"), JSON.stringify(["claude", "codex"]));
    writeFileSync(join(dir, "claude.cjs"), "process.exit(0);\n");
    process.env.CODE_AGENT_CLAUDE_BIN = join(dir, "claude.cjs");
  });
  afterEach(() => {
    for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    rmSync(dir, { recursive: true, force: true });
  });
  after(() => { for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  const CONFIG = POLICIES["cross-config-error"].label, UNAVAILABLE = POLICIES["cross-unavailable"].label;

  test("R3 없는 실행 파일 변수는 설정 오류(게이트 막힘)로 쓰고 중지 기록을 말하지 않는다", () => {
    process.env.CODE_AGENT_CODEX_BIN = join(dir, "no-such-codex.cjs");
    const text = crossNotice(dir) ?? "";
    assert.match(text, new RegExp(`^교차 검증: ${escape(CONFIG)} — CODE_AGENT_CODEX_BIN 가 가리키는 파일이 없습니다: .*중지로 기록하지 않고 그 지점의 게이트가 막힌다 — 사람이 셸에서 .*ca-answer 동의 judgment cross-stop\\)`));
    // 갈래 문장의 원천은 재시도 규약의 notice 변형이다
    assert.ok(text.includes(guidance("cross-config-error", { detail: `CODE_AGENT_CODEX_BIN 가 가리키는 파일이 없습니다: ${join(dir, "no-such-codex.cjs")}` }, "notice")), text);
    assert.doesNotMatch(text, /중지로 기록하고 진행한다/);
    assert.doesNotMatch(text, new RegExp(escape(UNAVAILABLE)));
  });

  test("R3 PATH·npm 어디에도 없는 미설치는 실행 불가(중지 기록 후 진행)로 쓴다 — 둘이 겹치면 둘 다", () => {
    delete process.env.CODE_AGENT_CODEX_BIN;
    const empty = join(dir, "empty");
    mkdirSync(empty);
    process.env.PATH = empty;
    process.env.APPDATA = empty;
    const text = crossNotice(dir) ?? "";
    assert.match(text, new RegExp(`^교차 검증: ${escape(UNAVAILABLE)} — 다른 호스트를 실행할 수 없으면 그 지점의 교차 검증은 중지로 기록하고 진행한다: codex 실행 파일을 PATH 에서 찾지 못했습니다\\. `));
    assert.doesNotMatch(text, new RegExp(escape(CONFIG)));
    process.env.CODE_AGENT_CLAUDE_BIN = join(dir, "no-such-claude.cjs");
    assert.match(crossNotice(dir) ?? "", new RegExp(`^교차 검증: ${escape(CONFIG)} — CODE_AGENT_CLAUDE_BIN [\\s\\S]* / ${escape(UNAVAILABLE)} — `));
  });

  test("R3 status·doctor·init 출력이 같은 안내를 싣는다", () => {
    createStageRepo("ca-r3-stage-");
    try {
      write(".code-agent/hosts.json", JSON.stringify(["claude", "codex"]));
      process.env.CODE_AGENT_CODEX_BIN = join(repo, "no-such-codex.cjs");
      const notice = crossNotice(repo)!;
      assert.match(notice, new RegExp(escape(CONFIG)));
      assert.ok(status(repo).includes(notice), "status");
      assert.ok(doctor(repo).text.includes(notice.replace(/^교차 검증: /, "")), "doctor");
      assert.ok(init(repo, { host: "both" }).includes(notice), "init");
    } finally { removeStageRepo(); }
  });

  test("R3 doctor 는 설정 오류(게이트 막힘)를 막는 문제(✗ — 고치는 길)로, 실행 불가(중지 기록 후 진행)는 실패가 아닌 줄(·)로 쓴다", () => {
    createStageRepo("ca-r3-doctor-");
    try {
      write(".code-agent/hosts.json", JSON.stringify(["claude", "codex"]));
      process.env.CODE_AGENT_CODEX_BIN = join(repo, "no-such-codex.cjs");
      const config = doctor(repo);
      const lines = config.text.split("\n");
      const at = lines.findIndex((line) => line.trimStart().startsWith("✗ 교차 검증: "));
      assert.ok(at >= 0, config.text);
      assert.match(lines[at + 1], /^\s+→ 셸에서 CODE_AGENT_CLAUDE_BIN·CODE_AGENT_CODEX_BIN 을 있는 실행 파일/, lines[at + 1]);
      assert.equal(config.ok, false);
      assert.match(config.text, /✗ \d+개: [^\n]*교차 검증/);
      // 미설치 — PATH·npm 어디에도 없다(이 호출 동안만 빈 폴더)
      delete process.env.CODE_AGENT_CODEX_BIN;
      const empty = join(dir, "empty");
      mkdirSync(empty);
      process.env.PATH = empty;
      process.env.APPDATA = empty;
      const missing = doctor(repo).text;
      assert.match(missing, new RegExp(`· 교차 검증: ${escape(UNAVAILABLE)} — `), missing);
      assert.doesNotMatch(missing, /✗ 교차 검증|✗ \d+개: [^\n]*교차 검증/);
    } finally { removeStageRepo(); }
  });

  test("R3 교차 리뷰 게이트 줄 — 실행 전에는 실행 불가 갈래 괄호(gate 변형), 실행 파일이 설정 오류면 설정 오류 갈래, 설정 오류로 막힌 뒤에는 '실행할 수 없으면 중지' 괄호를 달지 않는다", async () => {
    createStageRepo("ca-r3-gate-");
    try {
      await toReview();
      write(".code-agent/hosts.json", JSON.stringify(["claude", "codex"]));
      process.env.CODE_AGENT_CODEX_BIN = join(dir, "claude.cjs");
      openRound(requireValidatable(repo, "review"));
      writeFindingsDoc();
      recordReviewFixture(repo, "claude", { cross: false });
      const GATE_NOTE = new RegExp(escape(guidance("cross-unavailable", {}, "gate")));
      const runnable = withCaller("claude", () => nextLine(status(repo)));
      assert.ok(runnable.includes(`code-agent review cross --by codex (${guidance("cross-unavailable", {}, "gate")})`), runnable);
      const missing = join(repo, "no-such-codex.cjs");
      process.env.CODE_AGENT_CODEX_BIN = missing;
      const before = withCaller("claude", () => nextLine(status(repo)));
      const configNote = `(${CONFIG} — ${guidance("cross-config-error", { detail: `CODE_AGENT_CODEX_BIN 가 가리키는 파일이 없습니다: ${missing}` }, "notice")})`;
      assert.ok(before.includes(`code-agent review cross --by codex ${configNote}`), before);
      assert.doesNotMatch(before, GATE_NOTE);
      assert.throws(() => withCaller("claude", () => crossReview(repo, "codex")), /교차 호출 설정 오류/);
      const after = withCaller("claude", () => nextLine(status(repo)));
      assert.match(after, /code-agent review cross --by codex — 직전 실행: 막힘\(설정 오류\)/, after);
      assert.doesNotMatch(after, GATE_NOTE);
      // 실행할 수 있는 실행 파일이면 지점 안내(직전 설정 오류)가 그대로 다음 일을 싣는다 — 괄호는 다시 달지 않는다
      process.env.CODE_AGENT_CODEX_BIN = join(dir, "claude.cjs");
      assert.doesNotMatch(withCaller("claude", () => nextLine(status(repo))), GATE_NOTE);
    } finally { removeStageRepo(); }
  });
});

// ---- R5 — 흐름도의 template/·doc/ 줄 인용 ----

/** 흐름도의 template/·doc/ 인용(머리말 규칙: HEAD 기준) — 그 줄에 있어야 하는 글. 줄이 밀리면 시험이 깨지고, 인용과 이 표를 함께 고친다 */
const CITED_LINES: Record<string, RegExp> = {
  "template/claude/skills/ca-next/SKILL.md:14": /^\| 스테이지 \| 단계 명령 \| 절차 \|$/,
  "template/claude/skills/ca-next/SKILL.md:25": /^\| `integrate` · `deliver` \| `\/ca-integrate` \|/,
  "template/claude/skills/ca-next/SKILL.md:31": /계획 단계\(`analysis`~`plan`\)이면 `code-agent planning status`도 본다/,
  "template/claude/skills/ca-next/SKILL.md:75": /사이클이 스스로 되감지는 않는다 — 예외는/,
};
const CITED_SECTIONS = [
  { path: "template/claude/skills/ca-plan/contract.md", cited: "ca-plan/contract.md", heading: "작업 등록·입력·피드백",
    contents: [/`questionIds`: 관련 질문 ID\. 담당·교차 검토가 낸 질문/, /^\*\*수정 피드백\*\*/m] },
  { path: "doc/usage.md", cited: "doc/usage.md", heading: "4. 슬래시 명령 (Claude Code 안)",
    contents: [/^설치되는 실행 절차는 모두 \*\*\d+개\*\*다/m] },
];

describe("R5 — 흐름도의 줄 인용", () => {
  test("R5 흐름도(§10 앞)의 template/·doc/ 인용은 지금 파일의 그 줄을 가리킨다 — 표에 없는 인용도 없다", () => {
    const lines = readFileSync(join(ROOT, "doc", "process-flow.md"), "utf8").split(/\r?\n/);
    const history = lines.findIndex((line) => line.startsWith("## 10."));
    const seen = new Set<string>();
    for (const line of lines.slice(0, history)) {
      let last: string | undefined;
      for (const match of line.matchAll(/([A-Za-z0-9_./-]+\.(?:ts|md|cjs)):(\d+(?:-\d+)?(?:,\s?\d+(?:-\d+)?)*)|`:(\d+(?:-\d+)?)`/g)) {
        const name = match[1] ?? last;
        if (!name) continue;
        last = name;
        const path = /^ca-[\w-]+\/[\w.-]+\.md$/.test(name) ? `template/claude/skills/${name}` : name;
        if (!path.startsWith("template/") && !path.startsWith("doc/")) continue;
        for (const range of (match[2] ?? match[3]).split(/,\s?/)) {
          for (const at of new Set(range.split("-"))) {
            const key = `${path}:${at}`;
            seen.add(key);
            assert.ok(CITED_LINES[key], `표에 없는 인용: ${key} — 그 줄의 글을 CITED_LINES 에 더한다`);
            const text = readFileSync(join(ROOT, path), "utf8").split(/\r?\n/)[Number(at) - 1] ?? "";
            assert.match(text, CITED_LINES[key], `${key} 가 가리키는 줄: ${text}`);
          }
        }
      }
    }
    assert.deepEqual(Object.keys(CITED_LINES).filter((key) => !seen.has(key)), [], "흐름도에 없는 표 항목");
    const flow = lines.slice(0, history).join("\n");
    for (const citation of CITED_SECTIONS) {
      assert.ok(flow.includes(`\`${citation.cited}\`의 「${citation.heading}」`), `흐름도에 없는 절 인용: ${citation.cited}`);
      const text = readFileSync(join(ROOT, citation.path), "utf8").replace(/\r\n/g, "\n");
      const section = text.split(`## ${citation.heading}\n`)[1]?.split(/\n## /)[0];
      assert.ok(section, `없는 절: ${citation.path} ${citation.heading}`);
      for (const pattern of citation.contents) assert.match(section, pattern, citation.path);
    }
  });
});

// ---- R6 — 시험의 죽은 pid ----

/** 동기 실행(끝난 프로세스) 호출 — 인자 안의 괄호는 두 겹까지 본다 */
const ENDED_CALL = String.raw`(?:[\w$.]+\.)?(?:spawnSync|execFileSync|execSync)\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)`;
/**
 * 시험 소스에서 끝난 프로세스의 pid 를 쓰는 자리 — 동기 실행 결과의 `.pid`(바로·변수에 담아·구조 분해)와 고정 pid 리터럴(세 자리 이상).
 * 살아 있는 자식(spawn — 시험이 kill 한다)·자기 pid·deadPid()·다른 PC 주인의 작은 pid 는 잡지 않는다
 */
function endedPidUses(text: string): string[] {
  const uses = [...text.matchAll(new RegExp(`${ENDED_CALL}\\s*!?\\s*\\.pid\\b`, "g"))].map((match) => match[0].replace(/\s+/g, " ").slice(0, 80));
  for (const match of text.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(\w+)\s*(?::[^=\n]+)?=\s*${ENDED_CALL}`, "g"))) {
    if (new RegExp(String.raw`\b${match[1]}\s*!?\s*\.pid\b`).test(text)) uses.push(`${match[1]}.pid(동기 실행 결과)`);
  }
  if (new RegExp(String.raw`\b(?:const|let|var)\s*\{[^}]*\bpid\b[^}]*\}\s*=\s*${ENDED_CALL}`).test(text)) uses.push("{ pid } = 동기 실행 결과");
  for (const match of text.matchAll(/\bpid\s*:\s*(\d{3,}(?:_\d+)*)\b|\bpidAlive\(\s*(\d{3,}(?:_\d+)*)\s*\)/g)) uses.push(`고정 pid ${match[1] ?? match[2]}`);
  return uses;
}

describe("R6 — 시험이 쓰는 죽은 pid 는 재사용될 수 없다", () => {
  test("R6 deadPid 는 OS 가 배정하지 않는 범위에서 지금 살아 있지 않은 pid 를 고른다", () => {
    const pid = deadPid();
    assert.ok(pid > UNASSIGNED_PID_FLOOR && pid % 4 === 0, String(pid));
    assert.equal(pidAlive(pid), false);
  });

  test("R6 시험 파일은 방금 끝난 자식의 pid 를 죽은 pid 로 쓰지 않는다(병렬 부하에서 Windows 가 곧바로 다시 준다) — 예외 없이", () => {
    const dir = join(ROOT, "src", "test");
    const offenders: string[] = [];
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".ts") && file !== "deadPid.ts")) {
      const uses = endedPidUses(readFileSync(join(dir, name), "utf8"));
      if (uses.length) offenders.push(`${name}: ${uses.join(" · ")}`);
    }
    assert.deepEqual(offenders, []);
  });

  test("R6 끝난 프로세스 pid 탐지는 인자·호출 꼴·변수·구조 분해·고정 리터럴을 넓게 잡고, 살아 있는 자식·자기 pid·deadPid 는 잡지 않는다", () => {
    // 이 파일도 위 시험이 훑으므로 표본은 조립한다(소스에 그 꼴이 그대로 있으면 이 파일이 걸린다)
    const sync = (name: string) => `${name}${"Sync"}`;
    const caught = [
      `${sync("spawn")}(process.execPath, ["-e", ""]).pid`,
      `${sync("spawn")}(process.execPath, ["-e", "0"]).pid!`,
      `${sync("spawn")}("node", ["-e", "process.exit(1)"], { encoding: "utf8", env: { ...process.env } }).pid`,
      `cp.${sync("spawn")}(process.execPath, []) .pid`,
      `${sync("execFile")}(process.execPath, ["-e", "0"]).pid`,
      `const ended = ${sync("spawn")}(process.execPath, ["-e", ""]);\nwriteFileSync(p, JSON.stringify({ pid: ended.pid! }));`,
      `let child: ReturnType<typeof spawnSync> = ${sync("spawn")}(process.execPath, ["-e", ""]);\nassert.equal(pidAlive(child.pid!), false);`,
      `const { pid } = ${sync("spawn")}(process.execPath, ["-e", ""]);`,
      `JSON.stringify({ pid: ${"9".repeat(6)}, host: hostname() })`,
      `{ pid: ${"123_456"}, host }`,
      `pidAlive(${"31337"})`,
    ];
    for (const sample of caught) assert.ok(endedPidUses(sample).length > 0, sample);
    const live = [
      `const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"]);\nwriteFileSync(p, JSON.stringify({ pid: child.pid }));`,
      "JSON.stringify({ pid: process.pid, host: hostname() })", "JSON.stringify({ pid: deadPid(), host: hostname() })",
      `{ pid: 1, host: "other-pc" }`, `{ owner: { pid: 10 } }`, `const out = ${sync("spawn")}("git", ["status"]);\nconsole.log(out.stdout);`,
    ];
    for (const sample of live) assert.deepEqual(endedPidUses(sample), [], sample);
  });
});
