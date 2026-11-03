import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { hasConsentPresentation } from "../agent/consentPresentation";
import { applyConsent, loadConsent, runConsentHook } from "../agent/consent";
import { createRepo, removeRepo } from "./repoFixture";
import { consentEvent, nativeResponse, prepareConsentFixture, setupConsentProject } from "./consentFixture";

test("표시 근거는 준비 이후 같은 메인 세션의 일반 응답 전문이며 도구·생각·부분 요약으로 대신하지 않는다", () => {
  const root = createRepo("ca-presentation-");
  try {
    const path = join(root, "transcript.jsonl"), since = "2026-11-02T00:00:00Z";
    const summary = "요구사항 확인\n\n[요구](doc/work/W/requirement.md)\n로컬 커밋 31개 파일";
    const row = (content: unknown[], extra = {}) => ({ type: "assistant", sessionId: "S", timestamp: since, message: { content }, ...extra });
    const full = { type: "text", text: summary };
    const shown = (rows: unknown[], withQuestion = true) => {
      if (withQuestion) rows = [...rows, row([{ type: "tool_use", id: "question" }])];
      writeFileSync(path, rows.map(r => JSON.stringify(r)).join("\n"));
      return hasConsentPresentation(path, "S", since, summary, "question");
    };
    assert.equal(shown([row([full])]), true);
    assert.equal(shown([row([full])], false), false, "질문 호출의 기록도 있어야 사전 표시로 인정한다");
    assert.equal(shown([row([{ type: "text", text: summary.replace(/\n/g, "\r\n") }])]), true);
    for (const bad of [row([{ type: "thinking", thinking: summary }]), row([{ type: "tool_result", content: summary }]),
      row([full], { sessionId: "other" }), row([full], { isSidechain: true }), row([full], { timestamp: "2026-11-01T23:59:59Z" }),
      row([{ type: "text", text: "요구사항 확인 — 전문 파일을 읽으세요" }]), row([full], { type: "user" })]) {
      assert.equal(shown([bad]), false);
    }
    assert.equal(shown([row([{ type: "tool_use", id: "question" }, full])]), false, "질문 뒤 글은 사전 표시가 아니다");
    assert.equal(shown([row([full, { type: "tool_use", id: "question" }])]), true);
    assert.equal(hasConsentPresentation(undefined, "S", since, summary, "question"), false);
    assert.equal(hasConsentPresentation(join(root, "missing"), "S", since, summary, "question"), false);
  } finally { removeRepo(root); }
});

test("Claude 기록 지연: Pre 때 아직 없는 같은 메시지의 전문을 Post에서 확인하고 첫 질문 응답을 승인한다", () => {
  const root = createRepo("ca-presentation-hook-");
  const saved = process.env.CLAUDE_PROJECT_DIR, stderr = process.stderr.write;
  let output = "";
  process.env.CLAUDE_PROJECT_DIR = root;
  process.stderr.write = ((chunk: string) => { output += chunk; return true; }) as typeof stderr;
  try {
    setupConsentProject(root);
    const fixture = prepareConsentFixture(root, { action: "setup" });
    assert.match(loadConsent(root, fixture.id).summary, /문서·파일 링크:\n- \[.+\]\(<.+>\)/, "전문에 실제 파일 링크도 생성한다");
    const call = (event: object) => runConsentHook(JSON.stringify(event));
    const transcript = join(root, ".code-agent/consents/test-transcript.jsonl");
    writeFileSync(transcript, "");
    const pre = consentEvent(fixture, "PreToolUse", { transcript_path: transcript });
    const broken = structuredClone(pre);
    broken.tool_input!.questions![0].question = "요약한 질문";
    assert.equal(call(broken), 2, "전문 표시와 질문 원문 결속은 별도 검사다");
    assert.equal(call(pre), 0, "Pre는 아직 기록되지 않은 전문 때문에 질문을 거부하지 않는다");
    assert.equal(loadConsent(root, fixture.id).status, "pending");
    // Claude 2.1.316의 시점: Pre 종료 뒤 같은 메시지의 일반 글과 tool_use가 파일에 쓰인다.
    writeFileSync(transcript, JSON.stringify({ type: "assistant", sessionId: fixture.sessionId,
      timestamp: new Date().toISOString(), message: { content: [
        { type: "text", text: loadConsent(root, fixture.id).summary }, { type: "tool_use", id: pre.tool_use_id },
      ] } }));
    assert.equal(call(consentEvent(fixture, "PostToolUse", { transcript_path: transcript, tool_response: nativeResponse(fixture) })), 0, output);
    assert.equal(loadConsent(root, fixture.id).status, "approved");
  } finally {
    process.stderr.write = stderr;
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
    removeRepo(root);
  }
});

test("Post에서 전문 누락·질문 뒤 출력은 승인하지 않고 새 질문으로 받은 응답만 적용할 수 있다", () => {
  const root = createRepo("ca-presentation-missing-");
  const saved = process.env.CLAUDE_PROJECT_DIR, stderr = process.stderr.write;
  let output = "";
  process.env.CLAUDE_PROJECT_DIR = root;
  process.stderr.write = ((chunk: string) => { output += chunk; return true; }) as typeof stderr;
  try {
    setupConsentProject(root);
    const fixture = prepareConsentFixture(root, { action: "setup" });
    const transcript = join(root, ".code-agent/consents/test-transcript.jsonl");
    const pre = consentEvent(fixture, "PreToolUse", { transcript_path: transcript });
    const post = consentEvent(fixture, "PostToolUse", { transcript_path: transcript, tool_response: nativeResponse(fixture) });
    const call = (event: object) => runConsentHook(JSON.stringify(event));
    assert.equal(call(pre), 0);
    assert.equal(call(post), 2, "읽을 수 없는 기록은 승인 근거가 아니다");
    const text = { type: "text", text: loadConsent(root, fixture.id).summary };
    const write = (content: object[]) => writeFileSync(transcript, JSON.stringify({ type: "assistant", sessionId: fixture.sessionId,
      timestamp: new Date().toISOString(), message: { content } }));
    write([{ type: "tool_use", id: pre.tool_use_id }, text]);
    assert.equal(call(post), 2, "질문 뒤 전문으로 이전 응답을 소급 승인하지 않는다");
    assert.equal(loadConsent(root, fixture.id).status, "pending");
    assert.equal(loadConsent(root, fixture.id).observed?.length ?? 0, 0);
    assert.throws(() => applyConsent(root, fixture.id, { sessionId: fixture.sessionId }));
    assert.match(output, /응답을 승인으로 기록하지 않았습니다/);
    const nextToolId = `${pre.tool_use_id}-retry`;
    assert.equal(call({ ...pre, tool_use_id: nextToolId }), 0);
    write([text, { type: "tool_use", id: nextToolId }]);
    assert.equal(call({ ...post, tool_use_id: nextToolId }), 0, output);
    assert.equal(loadConsent(root, fixture.id).status, "approved");
  } finally {
    process.stderr.write = stderr;
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
    removeRepo(root);
  }
});

test("전문 기록이 없어도 보류·수정 요청·빈 응답은 재질문 안내로 바꾸지 않는다", () => {
  const root = createRepo("ca-presentation-defer-");
  const saved = process.env.CLAUDE_PROJECT_DIR, stderr = process.stderr.write;
  let output = "";
  process.env.CLAUDE_PROJECT_DIR = root;
  process.stderr.write = ((chunk: string) => { output += chunk; return true; }) as typeof stderr;
  try {
    setupConsentProject(root);
    for (const [label, status] of [["보류", "deferred"], ["수정 요청", "changes-requested"], ["", "failed"]]) {
      const fixture = prepareConsentFixture(root, { action: "setup" });
      const pre = consentEvent(fixture, "PreToolUse");
      assert.equal(runConsentHook(JSON.stringify(pre)), 0);
      const response = label ? nativeResponse(fixture, label) : { questions: fixture.questions, answers: {} };
      assert.equal(runConsentHook(JSON.stringify(consentEvent(fixture, "PostToolUse", { tool_response: response }))), label ? 0 : 2);
      assert.equal(loadConsent(root, fixture.id).status, status);
    }
    assert.doesNotMatch(output, /새 질문 호출로 다시 확인/);
  } finally {
    process.stderr.write = stderr;
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
    removeRepo(root);
  }
});
