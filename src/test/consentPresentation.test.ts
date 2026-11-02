import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { hasConsentPresentation } from "../agent/consentPresentation";
import { loadConsent, runConsentHook } from "../agent/consent";
import { createRepo, removeRepo } from "./repoFixture";
import { consentEvent, nativeResponse, prepareConsentFixture, setupConsentProject } from "./consentFixture";

test("표시 근거는 준비 이후 같은 메인 세션의 일반 응답 전문이며 도구·생각·부분 요약으로 대신하지 않는다", () => {
  const root = createRepo("ca-presentation-");
  try {
    const path = join(root, "transcript.jsonl"), since = "2026-11-02T00:00:00Z";
    const summary = "요구사항 확인\n\n[요구](doc/work/W/requirement.md)\n로컬 커밋 31개 파일";
    const row = (content: unknown[], extra = {}) => ({ type: "assistant", sessionId: "S", timestamp: since, message: { content }, ...extra });
    const full = { type: "text", text: summary };
    const shown = (rows: unknown[]) => {
      writeFileSync(path, rows.map(r => JSON.stringify(r)).join("\n"));
      return hasConsentPresentation(path, "S", since, summary, "question");
    };
    assert.equal(shown([row([full])]), true);
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

test("실제 Claude hook 경계는 요약 누락을 상태 변경 없이 막고 전문 출력 뒤 같은 동의의 질문·응답을 받는다", () => {
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
    assert.equal(call(consentEvent(fixture, "PreToolUse")), 2);
    assert.match(output, /summary.*일반 응답 본문/);
    assert.equal(loadConsent(root, fixture.id).status, "pending");
    assert.equal(loadConsent(root, fixture.id).binding, undefined);
    // 실제 호스트가 쓰는 대화 기록의 합성 fixture다. 승인 원장과 분리된 경로에 둔다.
    const transcript = join(root, ".code-agent/consents/test-transcript.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "assistant", sessionId: fixture.sessionId,
      timestamp: new Date().toISOString(), message: { content: [{ type: "text", text: loadConsent(root, fixture.id).summary }] } }));
    const pre = consentEvent(fixture, "PreToolUse", { transcript_path: transcript });
    const broken = structuredClone(pre);
    broken.tool_input!.questions![0].question = "요약한 질문";
    assert.equal(call(broken), 2, "전문 표시와 질문 원문 결속은 별도 검사다");
    assert.equal(call(pre), 0, output);
    assert.equal(call(consentEvent(fixture, "PostToolUse", { tool_response: nativeResponse(fixture) })), 0, output);
    assert.equal(loadConsent(root, fixture.id).status, "approved");
  } finally {
    process.stderr.write = stderr;
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
    removeRepo(root);
  }
});
