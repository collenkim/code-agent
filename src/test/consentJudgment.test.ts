import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyConsent, CONSENT_ACTIONS, loadConsent, prepareConsent } from "../agent/consent";
import type { ConsentAction } from "../agent/consent";
import { start } from "../agent/commands";
import { cancelPlanning, dispatchPlanning, planningBudget, preparePlanning } from "../agent/planning";
import { loadPlanning } from "../agent/planningState";
import { GRANT_STEP, GUIDE_VARIANTS, POLICIES } from "../agent/retryPolicy";
import { loadReview } from "../agent/review";
import { loadWork } from "../agent/work";
import { CONSENT_SPEC, CONSENT_WORK_ID, approveAndApplyFixture, observeConsentFixture, prepareConsentFixture, prepareReviewFixture, submitConsentRequest } from "./consentFixture";
import { root } from "./consentBindingFixture";

import "./consentBindingFixture";
function startWork(): void {
  approveAndApplyFixture(root, { action: "setup" });
  submitConsentRequest(root);
  approveAndApplyFixture(root, { action: "request", id: CONSENT_WORK_ID });
  start(root, join(root, CONSENT_SPEC));
}
const judgment = (extra: Partial<ConsentAction>) => ({ action: "judgment", kind: "retry-grant", comment: "사용자 판단", ...extra }) as ConsentAction;

test("T-J-1 judgment 공통 검증과 카운터 검증", () => {
  startWork();
  const refuse = (action: ConsentAction, pattern: RegExp) => assert.throws(() => prepareConsent(root, action), pattern);
  refuse({ action: "judgment", comment: "x" }, /kind 는 retry-grant/);
  refuse(judgment({ comment: undefined, name: "fix" }), /사유\(comment\)가 필요/);
  refuse(judgment({ comment: "가".repeat(501), name: "fix" }), /500자 이하/);
  refuse(judgment({ name: "collect" }), /사람 허용으로 늘리지 않습니다/);
  refuse(judgment({ name: "fix", id: "analysis" }), /id 를 빼고/);
  refuse(judgment({ name: "taskTotal" }), /계획 작업 ID/);
  // 리뷰 회차 한도 거부는 검증 쪽(check 로 되감긴 뒤)에서 나므로 검증 단계 어디서든 받는다(E14) — 계획 단계에서는 거부
  refuse(judgment({ name: "reviewRounds" }), /reviewRounds 는 check·test·review·integrate 단계에서 허용합니다\(지금: analysis\)/);
  refuse({ action: "judgment", kind: "waive-finding", comment: "x" }, /지적 번호/);
  refuse({ action: "judgment", kind: "cross-stop", name: "x", comment: "x" }, /review 또는 planning/);
  preparePlanning(root);
  refuse(judgment({ name: "taskTotal", id: "analysis" }), /한도가 남아 있어/);
});

test("T-J-2 judgment retry-grant(검증) — 소진된 고쳐 쓰기·같은 코드 재실행에 코드가 정한 범위로 한 번만 남긴다", async () => {
  await prepareReviewFixture(root);
  const file = join(root, `.code-agent/work/${CONSENT_WORK_ID}/value.verify.json`);
  const evidence = JSON.parse(readFileSync(file, "utf8"));
  evidence.retry = { version: 1, causes: { "1": "first", "2": "fix", "3": "fix" }, reruns: { [String(evidence.rounds)]: 2 }, integrateReruns: {}, grants: [] };
  writeFileSync(file, JSON.stringify(evidence));
  const fix = approveAndApplyFixture(root, judgment({ name: "fix" }));
  assert.match(fix.result, /고쳐 쓰기 한도를 2→3회로 늘렸습니다\(사람 판단, 동의 [a-f0-9]{8}\) — code-agent verify/);
  const grants = () => JSON.parse(readFileSync(file, "utf8")).retry.grants as { key: string; scope: string; step: number; consent: string }[];
  assert.deepEqual(grants().map(({ key, scope, step, consent }) => ({ key, scope, step, consent })), [{ key: "fix", scope: "", step: 1, consent: fix.id }]);
  assert.equal(applyConsent(root, fix.id), fix.result, "같은 동의는 캐시된 결과만 돌려준다");
  assert.equal(grants().length, 1);
  assert.match(approveAndApplyFixture(root, judgment({ name: "rerun" })).result, /code-agent verify --retry/);
  assert.deepEqual(grants().map((grant) => [grant.key, grant.scope]), [["fix", ""], ["rerun", `round:${evidence.rounds}`]]);
  assert.throws(() => prepareConsent(root, judgment({ name: "fix" })), /한도가 남아 있어/, "허용 뒤에는 소진이 아니다");
});

test("T-J-4 judgment retry-grant(리뷰·계획) — 리뷰 회차는 review.json, 작업 총 배정은 planning.json 에 남고 준비 뒤 기록이 바뀌면 폐기된다", async () => {
  await prepareReviewFixture(root);
  const file = join(root, `.code-agent/work/${CONSENT_WORK_ID}/value.review.json`);
  const log = JSON.parse(readFileSync(file, "utf8"));
  const first = log.rounds[0];
  log.rounds = [first, { ...first, round: 2 }, { ...first, round: 3 }];
  log.limit = 3;
  writeFileSync(file, JSON.stringify(log));
  const stale = prepareConsentFixture(root, judgment({ name: "reviewRounds" }));
  observeConsentFixture(stale);
  writeFileSync(file, JSON.stringify({ ...log, note: "준비 뒤에 바뀐 기록" }));
  assert.throws(() => applyConsent(root, stale.id), /확인 이후/);
  assert.equal(loadConsent(root, stale.id).failure?.kind, "target");
  const granted = approveAndApplyFixture(root, judgment({ name: "reviewRounds" }));
  assert.match(granted.result, /리뷰 회차 한도를 3→4회로 늘렸습니다/);
  assert.deepEqual(loadReview(root, CONSENT_WORK_ID, "value")!.grants!.map((grant) => [grant.key, grant.scope, grant.consent]), [["reviewRounds", "", granted.id]]);
});

test("judgment retry-grant(taskTotal) 통합 — 작업 총 배정 6회 소진 → 사람 판단 적용 → 한도 9 → 다시 배정", () => {
  startWork();
  preparePlanning(root);
  for (let index = 0; index < 6; index++) { dispatchPlanning(root, "analysis"); cancelPlanning(root, "analysis"); }
  assert.throws(() => dispatchPlanning(root, "analysis"), /총 6회/);
  const report = JSON.parse(prepareConsent(root, judgment({ name: "taskTotal", id: "analysis" })));
  assert.match(report.summary, /카운터: 작업 총 배정\(taskTotal\) · 지점: 계획 작업 analysis[\s\S]*사용 6 \/ 한도 6 — 소진[\s\S]*허용하면: 한도 6 → 9 \(\+3, 사람 판단\)/);
  const applied = approveAndApplyFixture(root, judgment({ name: "taskTotal", id: "analysis" }));
  assert.match(applied.result, /작업 총 배정 한도를 6→9회로 늘렸습니다.*code-agent planning advance/);
  assert.equal(planningBudget(root, "analysis").taskTotal.limit, 9);
  assert.match(loadPlanning(loadWork(root)!).retry!.grants[0].scope, /^planning:analysis@c1-[0-9a-f]{12}$/, "허용은 지금 예산 구간에 묶인다");
  assert.doesNotThrow(() => dispatchPlanning(root, "analysis"));
});

test("T-J-3 동작 목록·judgment 문구 동기화 — ca-answer 세 곳과 안내 문구가 같은 이름을 쓴다", () => {
  const files = ["template/claude/skills/ca-answer/SKILL.md", "template/claude/skills/ca-answer/appendix.md", "template/codex/ca-answer.md"]
    .map((file) => [file, readFileSync(join(__dirname, "../..", file), "utf8")] as const);
  for (const [file, text] of files) {
    for (const action of CONSENT_ACTIONS) assert.ok(text.includes(`\`${action}\``) || text.includes(`"action":"${action}"`), `${file} 에 ${action} 이 없습니다`);
  }
  const reference = files[1][1];
  for (const kind of ["retry-grant", "waive-finding", "cross-stop"]) {
    assert.ok(reference.includes(kind) && files[2][1].includes(kind), kind);
  }
  // 안내 문구·스킬이 가리키는 judgment 갈래와 카운터는 실제로 받는 값이다
  const texts = [...Object.values(POLICIES).map((policy) => policy.guide), ...Object.values(GUIDE_VARIANTS).flatMap((variants) => Object.values(variants ?? {}))];
  const skills = join(__dirname, "../../template/claude/skills");
  for (const dir of readdirSync(skills)) for (const name of readdirSync(join(skills, dir))) texts.push(readFileSync(join(skills, dir, name), "utf8"));
  texts.push(files[2][1]);
  // 코드의 거부·안내 문구(validate·commands·hook·review·crossCheck 등)도 같은 이름을 쓴다
  const sources = join(__dirname, "../../src/agent");
  for (const name of readdirSync(sources)) if (name.endsWith(".ts")) texts.push(readFileSync(join(sources, name), "utf8"));
  const all = texts.join("\n");
  const kinds = ["retry-grant", "waive-finding", "cross-stop"];
  for (const match of all.matchAll(/judgment ([a-z][a-z-]*)/g)) assert.ok(kinds.includes(match[1]), `알 수 없는 judgment 갈래: ${match[1]}`);
  let counters = 0;
  for (const match of all.matchAll(/retry-grant(?: |\(name )([a-zA-Z]+)/g)) {
    counters++;
    assert.ok(match[1] in GRANT_STEP, `사람 허용으로 늘리지 않는 카운터를 가리킵니다: ${match[1]}`);
  }
  assert.ok(counters >= 3, "안내 문구가 retry-grant 카운터를 가리킨다");
  for (const match of all.matchAll(/"action":"judgment","kind":"([a-z-]+)"/g)) assert.ok(kinds.includes(match[1]), `알 수 없는 judgment kind: ${match[1]}`);
});

test("judgment waive-finding·cross-stop 은 C1 함수로 이어진다 — 단계·지점 전제는 소유 함수가 본다", () => {
  startWork();
  assert.throws(() => prepareConsent(root, { action: "judgment", kind: "waive-finding", id: "F1", comment: "사용자 판단" }), /review 단계\(F·X 번호\)나 plan 단계/);
  assert.throws(() => prepareConsent(root, { action: "judgment", kind: "cross-stop", name: "review", comment: "사용자 판단" }), /교차 검증을 선택한 프로젝트에서만/);
});
