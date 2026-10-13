import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { questionPresentationProblem } from "../agent/questionPresentation";
import { decideStop } from "../agent/stopHook";
import { codexHook } from "../agent/codexHook";
import { ACTIVE_FILE, DOCS_SESSION_FILE, REQUEST_SESSION_FILE, PHASES } from "../agent/layout";

const broken = 'UZRF-392의 최신 오류 원문을 저장했습니다. 이전 테스트·품질 기준을 사용하려면 **“둘 다 기본안 적용”**이라고 답해 주세요.';

test("선택지 없는 문구 입력 요구를 감지하고 독립 질문·도구 부재·중복 방지를 안내한다", () => {
  const reason = questionPresentationProblem(broken)!;
  assert.match(reason, /선택지 없이/);
  assert.match(reason, /각각 제안 기준 사용 \/ 항목 수정 \/ 보류/);
  assert.match(reason, /도구가 없거나 거부되면/);
  assert.match(reason, /이미 제시한 질문은 다시 호출하지/);
  for (const reply of ['"기본안 적용"이라고 입력하세요', '“기본안”으로 응답해 주세요']) {
    assert.ok(questionPresentationProblem(reply), reply);
  }
});

test("번호·글자·불릿 대안, 인용 로그, 코드, 정상 보고와 동의 응답은 교정하지 않는다", () => {
  for (const message of [undefined, "초안을 저장했습니다.", "> " + broken, "```text\n" + broken + "\n```",
    '"code-agent consent respond ID 1 abc123"이라고 답해 주세요.',
    ...["1.", "A.", "-"].map(mark => broken + `\n${mark} 제안 기준 사용\n${mark === '1.' ? '2.' : mark === 'A.' ? 'B.' : '-'} 항목 수정`),
  ]) assert.equal(questionPresentationProblem(message), undefined, message ?? "응답 없음");
});

test("양쪽 Stop에서 준비·접수·전체 단계의 동일 재현을 한 번 교정하고 상태를 만들지 않는다", () => {
  const repo = mkdtempSync(join(tmpdir(), "ca-question-presentation-"));
  try {
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, ".code-agent"));
    assert.equal(decideStop({ cwd: repo, last_assistant_message: broken }), undefined);
    for (const [file, phase] of [[DOCS_SESSION_FILE, "docs"], [REQUEST_SESSION_FILE, "request"], ...PHASES.map(phase => [ACTIVE_FILE, phase])]) {
      writeFileSync(join(repo, file), JSON.stringify({ phase }));
      assert.match(decideStop({ cwd: repo, last_assistant_message: broken })!, /선택지 없이/, phase);
      const input = { cwd: repo, hook_event_name: "Stop", last_assistant_message: broken };
      assert.equal((codexHook(input) as { decision?: string }).decision, "block", phase);
      assert.equal(decideStop({ ...input, stop_hook_active: true }), undefined, phase);
      assert.deepEqual(codexHook({ ...input, stop_hook_active: true }), {}, phase);
      rmSync(join(repo, file));
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
