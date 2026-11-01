/**
 * 외부 계약 채택 — service-api 가 authorization-api 의 JWT·JWKS 계약 문서에 기대는 모양을 재현한다. 제공 저장소의 범위 밖 글·줄바꿈만
 * 바뀐 계약을 다시 등록하면 아무 작업도 낡지 않고, 요구에 연결된 항목이 바뀌면 그 요구의 작업만, JWT claim(보안) 항목이 바뀌면
 * 설계·계획·독립 검토와 승인·검증이 다시 돈다. 제공 저장소의 지금 상태는 채택하지 않고 알리기만 하며, 미구현 기능은 외부 의존 대기다.
 */
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { root, ID, DIR, SPEC, IMPACT, DESIGN, FUNCTIONAL, PLAN, TESTS, advance, analysis, dispatch, finish } from "./planningFixture";
import { planningContracts, planningStatus, preparePlanning } from "../agent/planning";
import { contractDrift, dependencyContracts } from "../agent/dependencyContracts";
import { approvalDocsHash, loadWork } from "../agent/work";
import { loadPlanning, staleCauses, taskContracts, taskCurrent } from "../agent/planningState";
import { impactAfter, needsVerify } from "../agent/changeImpact";
import { loadActive } from "../agent/layout";
import { next, submitPlan } from "../agent/commands";

const CONTRACT = "doc/contracts/jwt-jwks.md";
const TENANT = "- tenant_id: 요청 테넌트 ID — 없으면 403 TENANT_CONTEXT_REQUIRED";
const WORKSPACE = "- workspace_id: 업무 문맥 ID — 없으면 403 WORKSPACE_CONTEXT_REQUIRED";
const REQUEST_ID = "- 요청 ID 는 X-Request-Id 헤더로 전달한다";
/** 제공 저장소의 계약 문서 — 범위 밖 절(발급자의 다른 줄·변경 이력)과 의존 범위(헤더 줄·토큰 claim 절)가 함께 있다 */
function jwt(options: { claim?: string; header?: string; sub?: string; history?: string; eol?: string } = {}): string {
  return ["# JWT·JWKS 계약", "", "## 발급자와 키", "- iss 는 https://auth.example.test 이다", options.header ?? REQUEST_ID, "",
    "## 액세스 토큰 claim", options.sub ?? "- sub: 사용자 ID", options.claim ?? TENANT, "", "## 변경 이력", options.history ?? "- 초안", ""].join(options.eol ?? "\n");
}
/** 요구 둘 — 같은 접수 항목에서 나온 R1(요청 추적)·R2(업무 문맥) */
const TWO = '# 요구 정의\n## R1 · 요청 추적\n근거: "값을 반환한다."\n출처: REQ-1\n## R2 · 업무 문맥 확인\n근거: "값을 반환한다."\n출처: REQ-1\n## 가정\n- 없음';
const TWO_IMPACT = IMPACT.replace("| R1 | src/current.ts:1 | 없음 | 새 진입점 |", "| R1 | src/current.ts:1 | 없음 | 요청 ID 전달 |\n| R2 | src/current.ts:1 | 없음 | 업무 문맥 확인 |");

let provider: string, inputs: string;
beforeEach(() => {
  provider = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-contract-provider-")));
  inputs = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-contract-input-")));
  git(["init", "-q"]); mkdirSync(join(provider, "doc/contracts"), { recursive: true });
});
afterEach(() => { for (const dir of [provider, inputs]) rmSync(dir, { recursive: true, force: true }); });
const git = (args: string[]) => execFileSync("git", args, { cwd: provider, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** 원문을 커밋한다 — HEAD 와 같으면 그 커밋을 쓴다 */
function commit(content: string): [string, string] {
  writeFileSync(join(provider, CONTRACT), content);
  git(["-c", "core.autocrlf=false", "add", CONTRACT]);
  if (git(["status", "--porcelain"])) git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "contract"]);
  return [git(["rev-parse", "HEAD"]), createHash("sha256").update(content).digest("hex")];
}
interface Claims { header?: string; claim?: string; tokenFor?: string; headerFor?: string; availability?: "provided" | "pending" }
/** 제공 저장소에 원문을 커밋하고 그 커밋으로 등록한다(채택). 요구 연결은 헤더→R1, 토큰 claim→R2 가 기본이다 */
function adopt(content: string, claims: Claims = {}): string {
  const [commitId, sha256] = commit(content), input = join(inputs, "contracts.json");
  writeFileSync(input, JSON.stringify({ version: 2, contracts: [{ id: "auth-jwt", repository: provider, path: CONTRACT, commit: commitId, sha256, claims: [
    { key: "request.id", kind: "header", text: claims.header ?? REQUEST_ID, requirements: [claims.headerFor ?? "R1"] },
    { key: "token.context", kind: "jwt-claim", section: "액세스 토큰 claim", text: claims.claim ?? TENANT, requirements: [claims.tokenFor ?? "R2"], availability: claims.availability ?? "provided" },
  ] }] }));
  return planningContracts(root, input);
}
const view = () => { const work = loadWork(root)!; return { work, state: loadPlanning(work) }; };
/** 완료됐지만 지금 입력과 맞지 않는 계획 작업 */
function stale(): string[] {
  const { work, state } = view();
  return state.tasks.filter(record => record.attempts.at(-1)?.status === "completed" && !taskCurrent(work, state, record)).map(record => record.task.id).sort();
}
/** 01 에 R1·R2 를 두고 영향 조사를 요구별로 나눈다 — explore-r1(R1)·explore-r2(R2)·synthesis(둘 다) */
function splitImpact(claims: Claims = {}): void {
  preparePlanning(root); finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: TWO }); next(root);
  adopt(jwt(), claims);
  const base = { role: "explore", title: "요구별 조사", inputs: [SPEC], outputs: [], dependsOn: ["analysis"] };
  preparePlanning(root, { maxParallel: 2, tasks: [{ ...base, id: "explore-r1", requirements: ["R1"], scopes: ["src"] }, { ...base, id: "explore-r2", requirements: ["R2"], scopes: ["other"] },
    { id: "synthesis", role: "synthesis", title: "합성", requirements: ["R1", "R2"], inputs: [SPEC], outputs: [`${DIR}/02-analysis.md`], dependsOn: ["explore-r1", "explore-r2"] }] });
}

test("범위 밖 글·줄바꿈만 바뀐 계약은 다시 등록해도 어떤 작업도 다시 돌지 않고 승인 해시·영향 기록도 그대로다", () => {
  splitImpact();
  finish(dispatch("explore-r1")); finish(dispatch("explore-r2")); finish(dispatch("synthesis"), { [`${DIR}/02-analysis.md`]: TWO_IMPACT });
  assert.deepEqual(stale(), []);
  const approved = approvalDocsHash(loadWork(root)!), impacts = loadActive(root)!.request!.impacts?.length ?? 0;
  const out = adopt(jwt({ history: "- 초안\n- 예시 정리", eol: "\r\n" }));
  assert.match(out, /바뀐 항목 0\(보안 0\) · 그대로 2 · 기준 커밋만 바뀐 계약\(범위 밖 변경\): auth-jwt/);
  assert.match(out, /다시 판정할 완료된 계획 작업이 없습니다/);
  assert.deepEqual(stale(), []);
  assert.equal(approvalDocsHash(loadWork(root)!), approved);
  assert.equal(loadActive(root)!.request!.impacts?.length ?? 0, impacts);
  assert.deepEqual(contractDrift(root, ID), { drift: [], outOfScope: [], problems: [] }, "채택한 커밋의 표기 차이는 알릴 것도 없다");
});

test("요구에 연결된 항목이 바뀌면 그 요구의 작업만 다시 판정한다 — 같은 접수 항목의 다른 R·analysis 는 그대로다", () => {
  splitImpact();
  finish(dispatch("explore-r1")); finish(dispatch("explore-r2")); finish(dispatch("synthesis"), { [`${DIR}/02-analysis.md`]: TWO_IMPACT });
  const header = "- 요청 ID 는 X-Correlation-Id 헤더로 전달한다";
  const out = adopt(jwt({ header }), { header });
  assert.match(out, /바뀐 항목 1\(보안 0\) · 그대로 1/);
  assert.match(out, /auth-jwt\/request\.id 변경 \(R1\)/);
  assert.match(out, /다시 판정할 계획 작업: explore-r1, synthesis/);
  assert.deepEqual(stale(), ["explore-r1", "synthesis"]);
  const { work, state } = view();
  assert.ok(staleCauses(work, state, state.tasks.find(record => record.task.id === "explore-r1")!).some(cause => cause.text === "외부 의존 계약 항목: auth-jwt/request.id"));
  const impact = loadActive(root)!.request!.impacts!.at(-1)!;
  assert.deepEqual([impact.contracts, impact.requirements, impact.security, impact.conservative], [["auth-jwt/request.id"], ["R1"], [], []]);
});

test("JWT claim 채택은 설계·계획·독립 검토와 승인·검증을 다시 돌게 하고, 제공 저장소의 지금 상태는 채택 전까지 알리기만 한다", () => {
  analysis();
  adopt(jwt(), { tokenFor: "R1" });
  preparePlanning(root); finish(dispatch("explore"), {}, { evidence: [{ path: "src/current.ts", line: 1 }] });
  finish(dispatch("synthesis"), { [`${DIR}/02-analysis.md`]: IMPACT }); next(root);
  preparePlanning(root); finish(dispatch("design"), { [`${DIR}/03-design.md`]: DESIGN, [`${DIR}/04-functional.md`]: FUNCTIONAL }); next(root);
  preparePlanning(root); finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS }); finish(dispatch("critic"));
  submitPlan(root, join(root, DIR, "plan.json"));
  const approved = approvalDocsHash(loadWork(root)!);
  assert.deepEqual(stale(), []);

  // 커밋되지 않은 변경 — 범위 안(토큰 claim 절)이면 알리고 아무것도 낡게 하지 않는다
  writeFileSync(join(provider, CONTRACT), jwt({ sub: "- sub: 사용자 UUID" }));
  assert.deepEqual(contractDrift(root, ID).drift, [{ contract: "auth-jwt", key: "token.context", kind: "jwt-claim", security: true, change: "changed", where: "worktree" }]);
  // 제공 저장소의 새 커밋도 채택이 아니다 — tenant_id 를 workspace_id 로 바꾼 커밋
  const [head] = commit(jwt({ claim: WORKSPACE }));
  assert.deepEqual(contractDrift(root, ID).drift, [{ contract: "auth-jwt", key: "token.context", kind: "jwt-claim", security: true, change: "removed", where: "head", head }]);
  assert.match(JSON.stringify(JSON.parse(planningStatus(root)).contracts), /자동으로 채택하지 않습니다/);
  assert.deepEqual(stale(), []);
  assert.equal(approvalDocsHash(loadWork(root)!), approved);

  const out = adopt(jwt({ claim: WORKSPACE }), { claim: WORKSPACE, tokenFor: "R1" });
  assert.match(out, /바뀐 항목 1\(보안 1\)/);
  assert.match(out, /auth-jwt\/token\.context 변경 · 보안 \(R1\)/);
  assert.deepEqual(stale(), ["critic", "design", "explore", "plan", "synthesis"], "R 에만 연결된 항목은 analysis 를 다시 돌리지 않는다");
  assert.notEqual(approvalDocsHash(loadWork(root)!), approved, "승인된 계획은 새 계약으로 다시 승인받는다");
  const active = loadActive(root)!, impact = active.request!.impacts!.at(-1)!;
  assert.deepEqual(impact.contracts, ["auth-jwt/token.context"]);
  assert.ok(impact.security.includes("외부 인증 계약"));
  assert.deepEqual([impact.tasks, impact.files], [["T1", "T2", "T3"], ["src/a.ts", "src/b.ts", "test/value.test.ts"]]);
  assert.ok(needsVerify(impact) && impactAfter(active, undefined) === impact, "구현·테스트 검증과 리뷰를 이 영향 뒤에 다시 요구한다");

  // 보안 항목은 요구가 겹치지 않아도 설계·계획·독립 검토가 기댄다 — 조사는 요구로만 고른다
  const { work, state } = view(), contracts = dependencyContracts(root, ID).contracts;
  const keys = (role: string) => taskContracts(work, { ...state.tasks.find(record => record.task.role === role)!.task, requirements: ["R2"] }, contracts).flatMap(contract => contract.claims.map(claim => claim.key));
  assert.deepEqual([keys("design"), keys("plan"), keys("critic"), keys("explore")], [["token.context"], ["token.context"], ["token.context"], []]);
});

test("01 에 없는 R 을 가리킨 항목은 모든 R 작업이 기댄다 — 01 이 생긴 뒤에는 그런 등록을 거부한다", () => {
  adopt(jwt(), { tokenFor: "R3" });
  preparePlanning(root); finish(dispatch("analysis"), { [`${DIR}/01-requirements.md`]: TWO }); next(root);
  const { work, state } = view(), contracts = dependencyContracts(root, ID).contracts;
  const keys = (requirements: string[]) => taskContracts(work, { ...state.tasks[0].task, role: "explore" as const, requirements }, contracts).flatMap(contract => contract.claims.map(claim => claim.key));
  assert.deepEqual([keys(["R1"]), keys(["R2"])], [["request.id", "token.context"], ["token.context"]]);
  assert.throws(() => adopt(jwt(), { tokenFor: "R3" }), /요구 ID가 지시서·01-requirements\.md 에 없습니다: R3/);
});

test("제공 기능이 아직 없으면 외부 의존 대기로 알리고 독립 작업은 배정한다", async () => {
  splitImpact({ availability: "pending" });
  const out = await advance();
  assert.deepEqual(out.contracts.waits, [{ claim: "auth-jwt/token.context", requirements: ["R2"] }]);
  assert.match(out.contracts.next.join("\n"), /외부 의존 대기 — [^\n]*구현 여부를 다시 조사하지 않고/);
  const assigned = Object.fromEntries(out.assignments.map((item: { task: { id: string }; externalContracts: { claims: { key: string; availability: string }[] }[] }) =>
    [item.task.id, item.externalContracts.flatMap(contract => contract.claims.map(claim => `${claim.key}:${claim.availability}`))]));
  assert.deepEqual(assigned, { "explore-r1": ["request.id:provided"], "explore-r2": ["token.context:pending"] });
});
