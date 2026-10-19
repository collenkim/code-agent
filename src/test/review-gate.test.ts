import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { next, requireValidatable, status, Stop, submitPlan } from "../agent/commands";
import { loadActive, saveActive } from "../agent/layout";
import { loadReview, openRound, reviewDocFile, saveReview } from "../agent/review";
import { doctor } from "../agent/doctor";
import { recordReviewFixture, withCaller } from "./reviewFixture";
import { observeReviewer, RecordedFailure, runReviewHook } from "../agent/reviewHook";
import { partialTreeHash } from "../agent/tree";
import { verify } from "../agent/verificationFlow";
import { crossReview } from "../agent/crossCheck";
import { RetryRefused } from "../agent/retryPolicy";

/**
 * 코드 리뷰 — 회차·리뷰 게이트·⑨ 지적 절·교차 리뷰.
 *
 * p5.test 에서 describe 단위로 옮겼다(이름·본문 그대로 — 이력 추적용). 임시 git 저장소에 실제 함수를 그대로 부른다.
 * 검증 명령은 node 한 줄짜리 스크립트라 통과·실패·없는 실행 파일 세 경우를 이 머신에서 재현할 수 있다.
 */
import {
  ORDER, TEST_FILE, PLAN, repo, write, hook, writeFileHook, approve, toReview, writeFindingsDoc, writeFindings, toIntegrate, createStageRepo, removeStageRepo,
} from "./stageFixture";

beforeEach(() => createStageRepo());

afterEach(() => removeStageRepo());

// ---- 9 코드 리뷰 ----

describe("code-agent review — 회차", () => {
  test("구조화 리뷰는 검토 위치와 지적을 분리하고 한 번의 완료로 게이트를 통과한다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    const event = { cwd: repo, session_id: "structured", agent_id: "reviewer-json", agent_type: "ca-reviewer" };
    observeReviewer({ ...event, hook_event_name: "SubagentStart" });
    observeReviewer({ ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify({ findings: "- 없음", checked: [{ path: TEST_FILE, acceptance: ["AC-R1-1"] }] }) });
    const round = loadReview(repo, "ORD-1", "order")!.rounds.at(-1)!;
    assert.equal(round.reviewers!.length, 1);
    assert.equal(round.reviewers![0].result, "- 없음");
    assert.doesNotThrow(() => next(repo));
  });

  test("검증이 통과한 뒤에만 열리고, 회차 구역은 코드가 렌더한다", async () => {
    await toReview();
    // 리뷰 스테이지에서 계획 파일을 고치면 증거가 무효라 회차가 열리지 않는다
    write(`${ORDER}/domain/Order.java`, "class Order { }\n");
    assert.throws(
      () => openRound(requireValidatable(repo, "review")),
      (error: Error) => error instanceof Stop && /검증이 지금 트리 위에서 통과하지 않아/.test(error.message),
    );

    write(`${ORDER}/domain/Order.java`, "class Order {}\n");
    openRound(requireValidatable(repo, "review"));
    const log = loadReview(repo, "ORD-1", "order")!;
    assert.equal(log.rounds.length, 1);
    assert.equal(
      log.rounds[0].treeHash,
      partialTreeHash(repo, [`${ORDER}/domain/Order.java`, `${ORDER}/repository/OrderRepository.java`, TEST_FILE]),
    );
    const doc = readFileSync(join(repo, reviewDocFile("ORD-1")), "utf-8");
    assert.match(doc, /<!-- code-agent:review:start -->/);
    assert.ok(doc.includes(`| 1 | ${log.rounds[0].at} | ${log.rounds[0].treeHash} |`));
  });

  test("같은 트리에서 회차를 두 번 열지 않는다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    assert.throws(
      () => openRound(requireValidatable(repo, "review")),
      (error: Error) => error instanceof Stop && /이미 지금 트리를 보고 있습니다/.test(error.message),
    );
  });

  test("마지막 회차가 지금 트리를 보고 있으면 한도보다 같은 트리 안내가 먼저다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    const log = loadReview(repo, "ORD-1", "order")!;
    const now = log.rounds[0];
    saveReview(repo, { ...log, rounds: [{ ...now, round: 1, treeHash: "sha256:fake1" }, { ...now, round: 2, treeHash: "sha256:fake2" }, { ...now, round: 3 }] });
    assert.throws(() => openRound(requireValidatable(repo, "review")),
      (error: Error) => error instanceof Stop && !(error instanceof RetryRefused) && /이미 지금 트리를 보고 있습니다/.test(error.message));
  });

  test("회차 없이 next 를 부르면 넘어가지 않는다", async () => {
    await toReview();
    assert.throws(() => next(repo), /리뷰 회차가 없습니다/);
  });
});

describe("코드 리뷰 게이트 (review → integrate)", () => {
  test("회차와 지적 없음만 작성해서는 독립 리뷰를 대신할 수 없다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    const path = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(path, `${readFileSync(path, "utf-8")}\n- 없음\n`);
    assert.throws(() => next(repo), /독립 리뷰어 실행·완료 기록이 없습니다/);
    assert.match(hook("Bash", { command: "code-agent review-event" }) ?? "", /호스트 hook/);
  });

  test("리뷰어의 짝이 맞는 시작·완료와 수정되지 않은 결과만 통과한다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    const event = { cwd: repo, session_id: "session", agent_id: "reviewer", agent_type: "ca-reviewer" };
    assert.throws(() => observeReviewer({ ...event, hook_event_name: "SubagentStop", last_assistant_message: "- 없음" }), /시작한 리뷰어/);
    observeReviewer({ ...event, hook_event_name: "SubagentStart" });
    assert.throws(() => observeReviewer({ ...event, agent_id: "other", hook_event_name: "SubagentStop", last_assistant_message: "- 없음" }), /시작한 리뷰어/);
    observeReviewer({ ...event, hook_event_name: "SubagentStop", last_assistant_message: `| F1 | ${TEST_FILE} | 계획 안 | 열림 | TC-1 단언을 보완해야 한다 |` });
    assert.equal(writeFileHook(TEST_FILE), undefined);
    const path = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(path, readFileSync(path, "utf-8").replace("| 열림 |", "| 해결 |"));
    assert.throws(() => next(repo), /관찰된 ca-reviewer 결과와 다릅니다/);
  });

  test("리뷰어 완료 hook은 형식 오류만 한 번 돌려보내고, 기록이 끝났거나 이미 막힌 재시도는 막지 않는다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    const event = { cwd: repo, session_id: "session", agent_id: "reviewer", agent_type: "ca-reviewer" };
    const stop = (message: string, extra = {}) => runReviewHook(JSON.stringify({ ...event, hook_event_name: "SubagentStop", last_assistant_message: message, ...extra }));
    const saved = process.env.CLAUDE_PROJECT_DIR, quiet = process.stderr.write;
    process.env.CLAUDE_PROJECT_DIR = repo; process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      observeReviewer({ ...event, hook_event_name: "SubagentStart" });
      assert.equal(stop("검토 완료"), 2, "리뷰어가 지적 표로 다시 낼 수 있다");
      assert.equal(stop("검토 완료", { stop_hook_active: true }), 0);
      // 이미 한 번 막힌 재시도의 형식 오류는 기록한다 — 그 실행의 뒤 완료는 결과를 쓰지 않는다
      assert.equal(loadReview(repo, "ORD-1", "order")!.rounds.at(-1)!.reviewers![0].failure!.class, "agent-format-error");
      assert.equal(stop("- 없음"), 0);
      assert.equal(stop("- 없음"), 0, "이미 기록한 실패의 완료 이벤트가 반복돼도 막지 않는다");
      assert.equal(loadReview(repo, "ORD-1", "order")!.rounds.at(-1)!.reviewer!.result, undefined);
      // 새로 호출한 리뷰어(이 회차 남은 호출 1회)의 결과가 기록된다 — 옛 필드 reviewer 는 파생 사본이다
      const second = { ...event, agent_id: "reviewer-2" };
      observeReviewer({ ...second, hook_event_name: "SubagentStart" });
      observeReviewer({ ...second, hook_event_name: "SubagentStop", last_assistant_message: "- 없음" });
      assert.equal(loadReview(repo, "ORD-1", "order")!.rounds.at(-1)!.reviewer!.result, "- 없음");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
      process.stderr.write = quiet;
    }
  });

  test("리뷰 중 바뀐 코드에는 완료 기록을 붙이지 않는다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    const event = { cwd: repo, session_id: "session", agent_id: "reviewer", agent_type: "ca-reviewer" };
    observeReviewer({ ...event, hook_event_name: "SubagentStart" });
    write(`${ORDER}/domain/Order.java`, "class Order { int changed; }\n");
    assert.throws(() => observeReviewer({ ...event, hook_event_name: "SubagentStop", last_assistant_message: "- 없음" }), /리뷰 도중/);
    // 완료 기록은 붙지 않았다 — 시작한 실행이 끝나지 않은 채로 남는다
    assert.throws(() => next(repo), /독립 리뷰어가 실행 중입니다/);
    assert.equal(loadReview(repo, "ORD-1", "order")!.rounds.at(-1)!.reviewers![0].completedAt, undefined);
  });

  test("리뷰 지적 수정은 구현 파일을 먼저 고쳐도 동결 테스트를 열 수 있다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings(`| F1 | ${TEST_FILE} | 계획 안 | 열림 | TC-1 단언 누락 |`);
    write(`${ORDER}/domain/Order.java`, "class Order { /* review fix */ }\n");
    assert.equal(writeFileHook(TEST_FILE), undefined);
    assert.throws(() => next(repo), /회차 뒤 계획 파일이 바뀌었습니다/);
  });

  test("실제 하위 transcript의 SubagentHandback 보고를 기록하며 다른 경로는 거부한다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    const transcriptRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-transcript-")));
    try {
      const session = "session", agent = "reviewer";
      const transcript = join(transcriptRoot, session, "subagents", `agent-${agent}.jsonl`);
      mkdirSync(dirname(transcript), { recursive: true });
      const event = { cwd: repo, session_id: session, agent_id: agent, agent_type: "ca-reviewer", transcript_path: join(transcriptRoot, `${session}.jsonl`) };
      observeReviewer({ ...event, hook_event_name: "SubagentStart" });
      const entry = (timestamp: string, message: string) => JSON.stringify({ timestamp, type: "assistant", message: { content: [{ type: "tool_use", name: "SubagentHandback", input: { message } }] } });
      writeFileSync(transcript, entry("2000-01-01T00:00:00.000Z", "- 없음") + "\n");
      assert.throws(() => observeReviewer({ ...event, hook_event_name: "SubagentStop", agent_transcript_path: join(repo, reviewDocFile("ORD-1")), last_assistant_message: "- 없음" }), /해당 세션의 하위/);
      assert.throws(() => observeReviewer({ ...event, hook_event_name: "SubagentStop", agent_transcript_path: transcript, last_assistant_message: "검토 완료" }), /리뷰 결과는 지적 표/);
      writeFileSync(transcript, entry(new Date().toISOString(), "- 없음") + "\n");
      observeReviewer({ ...event, hook_event_name: "SubagentStop", agent_transcript_path: transcript, last_assistant_message: "검토 완료" });
      next(repo);
      assert.equal(loadActive(repo)!.phase, "integrate");
    } finally { rmSync(transcriptRoot, { recursive: true, force: true }); }
  });
  test("마지막 회차 뒤 계획 파일이 바뀌면 거부한다 — 리뷰 뒤 고치고 반영하는 길", async () => {
    await toIntegrate();
    saveActive(repo, { ...loadActive(repo)!, phase: "review" });
    write(`${ORDER}/domain/Order.java`, "class Order { /* 몰래 */ }\n");
    assert.throws(() => next(repo), /회차 뒤 계획 파일이 바뀌었습니다/);
  });

  test("열린 지적은 메인이 닫을 수 없고 독립 재검토가 확인해야 한다 — 같은 회차는 다시 리뷰하지 않는다 (PVR-2)", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings(`| F1 | ${ORDER}/domain/Order.java | 계획 안 | 열림 | 필드가 public 이다 |`);
    assert.throws(() => next(repo), /열린 지적: F1/);

    const path = join(repo, reviewDocFile("ORD-1"));
    const recorded = readFileSync(path, "utf-8");
    writeFileSync(path, recorded.replace("| 열림 |", "| 해결 |"));
    assert.throws(() => next(repo), /관찰된 ca-reviewer 결과와 다릅니다/);
    // 같은 회차에 리뷰어를 다시 불러도 기록은 바뀌지 않는다
    const again = { cwd: repo, session_id: "session-2", agent_id: "reviewer-2", agent_type: "ca-reviewer" };
    observeReviewer({ ...again, hook_event_name: "SubagentStart" });
    assert.throws(() => observeReviewer({ ...again, hook_event_name: "SubagentStop", last_assistant_message: `| F1 | ${ORDER}/domain/Order.java | 계획 안 | 해결 | 필드가 public 이다 |` }),
      (error: Error) => error instanceof RecordedFailure && /이미 기록했습니다/.test(error.message));
    assert.equal(loadReview(repo, "ORD-1", "order")!.rounds.at(-1)!.reviewers![1].ignored!.reason, "completed-round");
    writeFileSync(path, recorded);

    // 고친 뒤 새 회차에서 독립 재검토가 해결을 확인한다
    write(`${ORDER}/domain/Order.java`, "class Order { private int id; }\n");
    assert.equal((await verify(repo)).node, "review");
    openRound(requireValidatable(repo, "review"));
    writeFileSync(path, readFileSync(path, "utf-8").replace(/^\| F1 \|.*\| 열림 \|.*$/m, `| F1 | ${ORDER}/domain/Order.java | 계획 안 | 해결 | 필드가 public 이다 |`));
    recordReviewFixture(repo);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "integrate");
  });

  test("계획 밖 경로를 가리키는 지적은 해결로 적어도 거부한다 — 모델이 닫을 수 없다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings("| F1 | src/main/java/com/acme/app/common/ErrorCode.java | 계획 밖 | 해결 | 오류 코드가 없다 |");
    assert.throws(() => next(repo), /계획 밖을 가리키는 지적: F1/);
  });

  test("범위 칸은 코드가 계획과 대조해 정한다 — 모델이 다르게 적으면 hook 이 고쳐 기록하고, 기록 뒤 손으로 바꾼 문서는 게이트가 드러낸다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    const row = `| F1 | ${ORDER}/domain/Order.java | 계획 밖 | 해결 | 이름이 다르다 |`;
    writeFindingsDoc(row);
    // 범위는 계획 파일 목록에서 정해지는 값이라 판단 등급 리뷰어를 다시 부르지 않고 hook 이 고친다
    const event = { cwd: repo, session_id: "session", agent_id: "reviewer", agent_type: "ca-reviewer" };
    observeReviewer({ ...event, hook_event_name: "SubagentStart" });
    observeReviewer({ ...event, hook_event_name: "SubagentStop", last_assistant_message: row });
    const fixed = `| F1 | ${ORDER}/domain/Order.java | 계획 안 | 해결 | 이름이 다르다 |`;
    const run = loadReview(repo, "ORD-1", "order")!.rounds.at(-1)!.reviewers![0];
    assert.equal(run.returns, undefined, "범위 칸 때문에 돌려보내지 않는다");
    assert.equal(run.result, fixed);
    const path = join(repo, reviewDocFile("ORD-1"));
    assert.ok(readFileSync(path, "utf-8").includes(fixed), "⑨ 의 지적 절도 고친 표로 다시 쓴다");
    // 게이트는 문서의 표도 본다 — 손으로 범위를 바꾸면 드러난다
    writeFileSync(path, readFileSync(path, "utf-8").replace(fixed, row));
    assert.throws(() => next(repo), /범위 칸이 계획과 다릅니다: F1/);
  });

  test("지적을 아예 쓰지 않으면 거부한다 — 없으면 없다고 적게 한다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    assert.throws(() => next(repo), /지적이 없습니다/);
  });

  test("회차 구역을 손으로 고치면 거부한다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings();
    const path = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(path, readFileSync(path, "utf-8").replace(/\| 1 \| [^|]+ \|/, "| 1 | 방금 |"));
    assert.throws(() => next(repo), /회차 구역이 기록과 다릅니다/);
  });

  test("계획이 재승인되면 옛 회차 위에서 진행하지 않는다", async () => {
    await toIntegrate();
    // 계획을 다시 제출하고 승인하면 planHash 가 달라진다
    saveActive(repo, { ...loadActive(repo)!, phase: "plan" });
    write("doc/work/ORD-1/plan.json", JSON.stringify({ ...PLAN, reasoning: "다시 세운 계획" }));
    submitPlan(repo, join(repo, "doc/work/ORD-1/plan.json"));
    approve();
    saveActive(repo, { ...loadActive(repo)!, phase: "review" });
    assert.throws(() => next(repo), /리뷰 뒤 계획이 바뀌었습니다/);
  });
});

describe("⑨ 의 지적 절", () => {
  test("`없음` 은 `## 지적` 절 안에서만 인정한다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    const path = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(path, `${readFileSync(path, "utf-8").replace("## 지적", "## 잡담")}\n- 없음\n`);
    assert.throws(() => next(repo), /`## 지적` 절이 없습니다/);
  });

  test("회차 구역 표시가 둘이면 거부한다 — 둘째 짝이 위조본을 실어 나른다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings();
    const path = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(
      path,
      `${readFileSync(path, "utf-8")}\n<!-- code-agent:review:start -->\n## 회차\n\n| 회차 | 시각 | 기준 트리 해시 (계획 파일) |\n|---|---|---|\n| 9 | 2026-09-29T00:00:00.000Z | sha256:deadbeefdeadbeef |\n<!-- code-agent:review:end -->\n`,
    );
    assert.throws(() => next(repo), /회차 구역이 기록과 다릅니다/);
  });
});

describe("교차 리뷰 — 두 호스트 설치", () => {
  /** 두 호스트 설치 + 리뷰 1회차(독립 리뷰 `- 없음` 기록) + FAKE_CROSS 를 마지막 응답으로 남기는 가짜 codex */
  async function crossFixture(): Promise<{ fake: string; cleanup: () => void }> {
    await toReview();
    write(".code-agent/hosts.json", JSON.stringify(["claude", "codex"]));
    openRound(requireValidatable(repo, "review"));
    const doc = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(doc, `${readFileSync(doc, "utf-8")}\n- 없음\n`);
    recordReviewFixture(repo, "claude", { cross: false });
    const fake = mkdtempSync(join(tmpdir(), "ca-fake-codex-")), script = join(fake, "codex.cjs");
    writeFileSync(script, "const a = process.argv; require('fs').writeFileSync(a[a.indexOf('-o') + 1], process.env.FAKE_CROSS);\n");
    process.env.CODE_AGENT_CODEX_BIN = script;
    return { fake, cleanup: () => { delete process.env.CODE_AGENT_CODEX_BIN; delete process.env.FAKE_CROSS; rmSync(fake, { recursive: true, force: true }); } };
  }

  test("리뷰 게이트가 다른 호스트의 교차 리뷰를 요구하고, 완료된 회차의 교차 리뷰는 다시 실행하지 않는다 (PVR-1)", async () => {
    const fixture = await crossFixture();
    try {
      assert.throws(() => next(repo), /교차 리뷰가 필요합니다/);
      withCaller("claude", () => {
        process.env.FAKE_CROSS = `| X1 | ${TEST_FILE} | 계획 안 | 열림 | TC-2 의 오류 경로 단언이 없다 |`;
        assert.match(crossReview(repo, "codex"), /열린 지적 1개/);
        assert.match(readFileSync(join(repo, reviewDocFile("ORD-1")), "utf-8"), /## 교차 지적[\s\S]*\| X1 \|/);
        assert.throws(() => next(repo), /열린 지적: X1/);
        // 다시 실행해 지적을 지우는 길은 없다 — 완료된 지점은 거부한다
        process.env.FAKE_CROSS = "- 없음";
        assert.throws(() => crossReview(repo, "codex"), (error: Error) => error instanceof RetryRefused && /이미 기록했습니다/.test(error.message));
        assert.throws(() => next(repo), /열린 지적: X1/);
        assert.equal(loadReview(repo, "ORD-1", "order")!.rounds.at(-1)!.crossAttempts!.length, 1);
      });
    } finally { fixture.cleanup(); }
  });

  test("기록된 교차 지적 절을 손으로 바꾸면 리뷰 게이트가 막는다", async () => {
    const fixture = await crossFixture();
    try {
      withCaller("claude", () => {
        process.env.FAKE_CROSS = "- 없음";
        crossReview(repo, "codex");
      });
      const path = join(repo, reviewDocFile("ORD-1"));
      const recorded = readFileSync(path, "utf-8");
      writeFileSync(path, recorded.replace(/(## 교차 지적[\s\S]*?)- 없음/, `$1| X9 | ${TEST_FILE} | 계획 안 | 해결 | 임의 기록 |`));
      assert.throws(() => next(repo), /기록된 교차 리뷰 결과와 다릅니다/);
      writeFileSync(path, recorded);
      next(repo);
      assert.equal(loadActive(repo)!.phase, "integrate");
    } finally { fixture.cleanup(); }
  });

  test("다른 호스트를 실행할 수 없으면 그 회차의 교차 리뷰는 중지로 기록되고 리뷰 게이트를 지난다", async () => {
    await toReview();
    write(".code-agent/hosts.json", JSON.stringify(["claude", "codex"]));
    openRound(requireValidatable(repo, "review"));
    const doc = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(doc, `${readFileSync(doc, "utf-8")}\n- 없음\n`);
    recordReviewFixture(repo, "claude", { cross: false });
    // 사용 한도에 걸린 호스트 — 실행은 되지만 비정상 종료한다
    const fake = mkdtempSync(join(tmpdir(), "ca-fake-codex-")), script = join(fake, "codex.cjs");
    writeFileSync(script, "process.stderr.write('ERROR: You hit your spend cap set by the owner of your workspace.'); process.exit(1);\n");
    process.env.CODE_AGENT_CODEX_BIN = script;
    try {
      withCaller("claude", () => {
        assert.match(crossReview(repo, "codex"), /교차 검증 중지[\s\S]*spend cap[\s\S]*교차 검증 없이 진행/);
        assert.match(readFileSync(doc, "utf-8"), /## 교차 지적[\s\S]*- 교차 검증 중지 — codex 를 실행할 수 없습니다/);
        assert.match(loadReview(repo, "ORD-1", "order")!.rounds.at(-1)!.cross!.unavailable!, /spend cap/);
        assert.equal(loadReview(repo, "ORD-1", "order")!.rounds.at(-1)!.crossAttempts![0].class, "cross-unavailable");
        // 사람이 아닌 중지 지점은 지점 한도 안에서 다시 실행할 수 있다 — 다시 실행할 수 없으면 중지 그대로 진행한다
        assert.match(crossReview(repo, "codex"), /교차 검증 중지/);
        assert.equal(loadReview(repo, "ORD-1", "order")!.rounds.at(-1)!.crossAttempts!.length, 2);
      });
      next(repo);
      assert.equal(loadActive(repo)!.phase, "integrate");
    } finally {
      delete process.env.CODE_AGENT_CODEX_BIN;
      rmSync(fake, { recursive: true, force: true });
    }
  });

  test("실행 파일 변수가 없는 파일을 가리키면 띄우지 않고 설정 오류로 막으며(E20 — 경로 오타로 필수 교차 검증이 빠지지 않는다), status·doctor 가 호스트를 줄이는 길을 안내한다", async () => {
    await toReview();
    write(".code-agent/hosts.json", JSON.stringify(["claude", "codex"]));
    process.env.CODE_AGENT_CODEX_BIN = join(repo, "no-such-codex.cjs");
    try {
      assert.match(status(repo), /교차 검증: 교차 호출 설정 오류 — CODE_AGENT_CODEX_BIN 가 가리키는 파일이 없습니다[\s\S]*중지로 기록하지 않고 그 지점의 게이트가 막힌다[\s\S]*code-agent execution claude/);
      assert.doesNotMatch(status(repo), /중지로 기록하고 진행한다/, "설정 오류는 실행 불가가 아니다(E20·R3)");
      assert.doesNotMatch(status(repo), /init --host <호스트> 로 하나만/, "init 은 호스트를 줄이지 않는다(E40)");
      assert.match(doctor(repo).text, /교차 검증/);
      openRound(requireValidatable(repo, "review"));
      const doc = join(repo, reviewDocFile("ORD-1"));
      writeFileSync(doc, `${readFileSync(doc, "utf-8")}\n- 없음\n`);
      recordReviewFixture(repo, "claude", { cross: false });
      assert.throws(() => withCaller("claude", () => crossReview(repo, "codex")), /교차 호출 설정 오류[\s\S]*가리키는 파일이 없습니다/);
      assert.throws(() => next(repo), /교차 리뷰가 필요합니다[\s\S]*막힘\(설정 오류\)/);
      assert.equal(loadActive(repo)!.phase, "review");
    } finally {
      delete process.env.CODE_AGENT_CODEX_BIN;
    }
  });
});
