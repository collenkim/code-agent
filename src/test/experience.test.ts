import { writeFixture as writeRepoFile } from "./repoFixture";
/**
 * 작업 경험 기록(experience.ts·experienceCommands.ts) — 확정 정책과 따로 세는 선택 기록.
 *
 * 앞 절은 작은 임시 저장소에 손으로 쓴 기록으로 판정(검증 근거·폐기·대체·근거 변경)과 검색 분리를 보고,
 * 뒤 절은 스테이지 픽스처의 진행 중 작업에서 `experience add` 의 ID·버전·중복·거부·초안 정리와 hook 을 본다.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { codexHook } from "../agent/codexHook";
import { isDeliveryExcluded } from "../agent/deliver";
import { experienceIndex, searchExperience } from "../agent/experience";
import { experienceAdd, experienceList, experienceShow } from "../agent/experienceCommands";
import { decide } from "../agent/hook";
import { knowledgeFind } from "../agent/knowledgeCommands";
import { buildIndex, mandatoryPolicies } from "../agent/knowledgeIndex";
import { approvalOf, loadWork } from "../agent/work";
import { Stop } from "../agent/stop";
import * as stage from "./stageFixture";

let repo: string;

function write(path: string, content: string): void {
  writeRepoFile(repo, path, content);
}
function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf-8" }).trim();
}
function commit(message: string): void {
  git("add", "-A");
  git("commit", "-qm", message);
}
function entry(key: string, title: string, fields: string[]): string {
  return [`### \`${key}\` ${title}`, ...fields.map((field) => `- ${field}`), ""].join("\n");
}
function experienceDoc(work: string, ...entries: string[]): void {
  write(`doc/work/${work}/experience.md`, [`# ${work} 작업 경험`, "", ...entries].join("\n"));
}
function evidence(work: string, runs: { phase: string; round: number; outcome: string }[]): void {
  write(`.code-agent/work/${work}/t.verify.json`, JSON.stringify({ id: work, target: "t", runs }));
}
const stateOf = (id: string): string => experienceIndex(repo).records.find((record) => record.id === id)!.state;

const RULES = "doc/knowledge/business-rules.md";

describe("판정 — 선언만으로 검증됨이 되지 않고, 폐기·대체·낡은 근거가 드러난다", () => {
  beforeEach(() => {
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-exp-")));
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
    write("src/order/cancel.ts", "export function cancel() {}\n");
    write("src/order/list.ts", "export function list() {}\n");
    experienceDoc("W-1",
      entry("EXP-W-1-1", "취소 뒤 재고가 돌아오지 않음", ["버전: 1", "작업: W-1", "상태: 검증됨", "문제: 취소해도 재고 복원 안 됨", "원인: 이벤트 순서", "검증: verify:test", "적용 조건: 주문 취소 경로", "코드: `src/order/cancel.ts`"]),
      entry("EXP-W-1-2", "목록 캐시 의심", ["버전: 1", "작업: W-1", "상태: 폐기", "문제: 목록이 느림", "원인: 캐시라고 봤으나 아님", "적용 조건: 없음"]),
      entry("EXP-W-1-3", "목록 정렬 실패", ["버전: 1", "작업: W-1", "상태: 가설", "문제: 정렬이 깨짐", "원인: 비교 함수", "적용 조건: 목록", "코드: `src/order/list.ts`"]),
      entry("EXP-W-1-4", "근거 경로 없는 관찰", ["버전: 1", "작업: W-1", "상태: 가설", "문제: 가끔 느림", "원인: 모름", "적용 조건: 운영"]),
    );
    experienceDoc("W-2",
      entry("EXP-W-2-1", "목록 정렬 — 원인 확정", ["버전: 1", "작업: W-2", "상태: 가설", "문제: 정렬이 깨짐", "원인: 로캘 비교", "적용 조건: 목록", "대체: `EXP-W-1-3`", "코드: `src/order/list.ts`"]),
    );
    commit("[W-1] 씨앗");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test("검증됨 선언은 그 작업의 통과한 검증 기록이 있어야 검증됨이다 — 없거나 마지막 회차가 실패면 검증 근거 없음", () => {
    assert.equal(stateOf("EXP-W-1-1"), "검증 근거 없음");
    evidence("W-1", [{ phase: "test", round: 1, outcome: "passed" }]);
    assert.equal(stateOf("EXP-W-1-1"), "검증됨");
    evidence("W-1", [{ phase: "test", round: 1, outcome: "passed" }, { phase: "test", round: 2, outcome: "failed" }]);
    assert.equal(stateOf("EXP-W-1-1"), "검증 근거 없음", "마지막 회차가 실패면 근거가 아니다");
    evidence("W-2", [{ phase: "test", round: 1, outcome: "passed" }]);
    assert.equal(stateOf("EXP-W-1-1"), "검증 근거 없음", "다른 작업의 통과는 이 기록의 근거가 아니다");
  });

  test("폐기·대체됨을 구분하고 검색은 살아 있는 기록을 먼저 보인다", () => {
    assert.equal(stateOf("EXP-W-1-2"), "폐기");
    assert.equal(stateOf("EXP-W-1-3"), "대체됨");
    assert.equal(experienceIndex(repo).records.find((record) => record.id === "EXP-W-1-3")!.supersededBy, "EXP-W-2-1");
    const hits = searchExperience(experienceIndex(repo), { keywords: ["정렬"], keys: [], files: [] });
    assert.deepEqual(hits.map((hit) => hit.record.id), ["EXP-W-2-1", "EXP-W-1-3"], "대체된 기록은 뒤로 — 지우지 않는다");
  });

  test("기록 뒤 근거 코드가 바뀌면 재검토 필요, 사라지면 참조 없음, 근거 경로가 없으면 변경을 감지할 수 없다고 적는다", () => {
    write("src/order/cancel.ts", "export function cancel() { /* 바뀜 */ }\n");
    rmSync(join(repo, "src/order/list.ts"));
    commit("[W-3] 취소 수정·목록 삭제");
    const list = experienceList(repo);
    assert.match(list, /`EXP-W-1-1` [^\n]*\[경험 · 검증 근거 없음 — 가설로 본다 · v1 · 재검토 필요: W-3 가 src\/order\/cancel\.ts 를 바꿈\]/);
    assert.match(list, /`EXP-W-2-1` [^\n]*참조 없음: src\/order\/list\.ts/);
    assert.match(list, /`EXP-W-1-4` [^\n]*근거 경로 없음 — 코드 변경 감지 불가/);
    assert.match(list, /변경이 감지되지 않았다는 것은 내용이 맞다는 보장이 아닙니다/);
  });

  test("경험은 KNOWLEDGE 인덱스·반드시 적용하는 정책에 들어가지 않는다 — 많이 걸려도 정책 결과를 밀어내지 않는다", () => {
    write(RULES, ["# 업무 규칙·용어집", "", "## 업무 규칙", "",
      entry("BR-ORDER-01", "취소는 배송 전만", ["구분: 필수", "상태: 확정", "출처: W-1 R1", "범위: 전체"]),
    ].join("\n"));
    commit("[W-1] 정책");
    const query = "재고 사례";
    const policyPart = (text: string) => (text.includes("작업 경험 (") ? text.slice(0, text.indexOf("작업 경험 (")) : text)
      .replace(/줄 범위만 읽으세요 — 문서 전문을 열지 않습니다\.$/, "").trimEnd();
    const before = knowledgeFind(repo, query);
    for (let n = 5; n < 25; n++) {
      write(`doc/work/W-${n}/experience.md`, [`# W-${n}`, "", entry(`EXP-W-${n}-1`, `취소 재고 사례 ${n}`, ["상태: 가설", "문제: 취소 재고", "원인: 모름", "적용 조건: 취소", "정책: `BR-ORDER-01`"])].join("\n"));
    }
    const after = knowledgeFind(repo, query);
    assert.equal(policyPart(after), policyPart(before), "정책 쪽 결과는 경험 수와 관계없이 같다");
    assert.match(after, /반드시 적용하는 업무 정책[^\n]*\n- doc\/knowledge\/business-rules\.md [^\n]*BR-ORDER-01/);
    const experiencePart = after.slice(after.indexOf("작업 경험 ("));
    assert.match(experiencePart, /^- doc\/work\/W-\d+\/experience\.md L\d+-L\d+ · `EXP-W-\d+-1` [^\n]*\[경험 · 가설 · v1/m);
    assert.match(experiencePart, /- 범위: 걸린 2\d개 중 5개만/);
    assert.doesNotMatch(policyPart(after), /EXP-/);
    const index = buildIndex(repo, undefined, []);
    assert.ok(index.entries.every((item) => !item.key.startsWith("EXP-")));
    const mandatory = mandatoryPolicies(index, { keywords: ["취소"], keys: ["EXP-W-5-1"], files: [] }, []);
    assert.deepEqual(mandatory.map(({ entry: item }) => item.key), ["BR-ORDER-01"]);
  });

  test("버전 — 가장 높은 버전이 현재이고 같은 버전이 둘이면 충돌, 빠진 버전은 문제로 적는다", () => {
    experienceDoc("W-7", entry("EXP-W-1-3", "목록 정렬 실패", ["버전: 3", "작업: W-7", "상태: 가설", "문제: 정렬", "원인: 비교", "적용 조건: 목록", "변경: 원인 보강"]));
    experienceDoc("W-8", entry("EXP-W-1-3", "목록 정렬 실패", ["버전: 3", "작업: W-8", "상태: 가설", "문제: 정렬", "원인: 다른 비교", "적용 조건: 목록", "변경: 다른 보강"]));
    const record = experienceIndex(repo).records.find((item) => item.id === "EXP-W-1-3")!;
    assert.equal(record.state, "버전 충돌");
    assert.equal(record.current.version, 3);
    assert.deepEqual(record.history.map((version) => version.version), [1]);
    assert.match(record.current.problems.join("\n"), /버전 2 이\(가\) 없습니다/);
    assert.match(experienceShow(repo, "EXP-W-1-3"), /버전 충돌\(W-7, W-8\)/);
  });
});

describe("experience add — ID·버전·중복·거부는 코드가 정한다", () => {
  beforeEach(() => {
    stage.createStageRepo("ca-exp-add-");
    repo = stage.repo;
    stage.toCheck();
  });
  afterEach(() => stage.removeStageRepo());

  const DRAFT = "doc/work/ORD-1/experience.draft.json";
  const base = { title: "주문 조회 실패", problem: "id 없는 주문 조회가 예외", cause: "id null 검사 누락", conditions: "Order 저장소를 쓰는 조회",
    attempts: [{ approach: "캐시 비우기", failure: "증상 그대로" }], code: [`${stage.ORDER}/domain/Order.java`] };
  function add(draft: Record<string, unknown>, path = DRAFT): string {
    write(path, JSON.stringify(draft));
    return experienceAdd(repo, join(repo, path));
  }
  const file = (): string => readFileSync(join(repo, "doc/work/ORD-1/experience.md"), "utf8");

  test("새 기록은 EXP-<작업>-<순번>, 같은 내용은 다시 만들지 않고, 정해진 자리의 초안은 기록 뒤 지운다", () => {
    assert.match(add(base), /^기록: EXP-ORD-1-1 v1 · 가설 → doc\/work\/ORD-1\/experience\.md L\d+-L\d+ · 초안 doc\/work\/ORD-1\/experience\.draft\.json 는 지웠습니다/);
    assert.equal(existsSync(join(repo, DRAFT)), false);
    assert.match(add(base), /^같은 경험이 이미 있습니다: EXP-ORD-1-1/);
    assert.equal(file().match(/### `EXP-/g)!.length, 1);
    assert.match(add({ ...base, problem: "다른 문제" }, "elsewhere.json"), /^기록: EXP-ORD-1-2 v1/);
    assert.ok(existsSync(join(repo, "elsewhere.json")), "정해진 자리가 아닌 초안은 지우지 않는다");
    assert.match(file(), /- 기준 커밋: [0-9a-f]{40} /);
    assert.match(file(), /- 시도: 캐시 비우기 — 실패 이유: 증상 그대로/);
  });

  test("같은 작업 안의 revises 는 갈아 끼우고 버전을 지키며, 지난 작업의 기록을 고치면 자기 폴더에 버전 +1 로 쓴다", () => {
    add(base);
    assert.match(add({ ...base, cause: "id null 검사 누락 — 저장소 기본값", revises: "EXP-ORD-1-1", change: "원인 보강" }), /^기록: EXP-ORD-1-1 v1 · 가설 [^\n]*\(같은 작업의 초안을 갈아 끼움\)/);
    assert.equal(file().match(/### `EXP-ORD-1-1`/g)!.length, 1);
    write("doc/work/OLD/experience.md", ["# OLD", "", entry("EXP-OLD-1", "옛 경험", ["버전: 1", "작업: OLD", "상태: 가설", "문제: 옛 문제", "원인: 옛 원인", "적용 조건: 옛 조건"])].join("\n"));
    assert.throws(() => add({ ...base, revises: "EXP-OLD-1" }), /revises 에는 이번 버전에서 바뀐 것\(change\)이 필요합니다/);
    assert.match(add({ ...base, revises: "EXP-OLD-1", change: "현재 코드로 다시 봄" }), /^기록: EXP-OLD-1 v2/);
    const record = experienceIndex(repo).records.find((item) => item.id === "EXP-OLD-1")!;
    assert.deepEqual([record.current.version, record.current.work, record.history.map((item) => item.work)], [2, "ORD-1", ["OLD"]]);
    assert.match(readFileSync(join(repo, "doc/work/OLD/experience.md"), "utf8"), /버전: 1/, "지난 작업의 폴더는 고치지 않는다");
    assert.throws(() => add({ ...base, revises: "EXP-NONE-1", change: "x" }), /고칠 기록이 없습니다/);
  });

  test("검증됨은 통과한 검증과 이어져야 하고, 자격 증명·로그 전문·저장소 밖 경로는 쓰지 않는다 — 거부하면 파일도 초안도 그대로다", () => {
    assert.throws(() => add({ ...base, status: "검증됨", evidence: ["verify:test"] }), /"검증됨" 은 이 작업의 통과한 검증 기록/);
    assert.throws(() => add({ ...base, status: "검증됨", evidence: ["회의에서 확인"] }), /evidence 는 verify:repro\|check\|test\|integrate 형식/);
    assert.throws(() => add({ ...base, environment: "DB_PASSWORD=hunter2secret" }), (error: unknown) =>
      error instanceof Stop && /environment: 비밀 값 대입로 보이는 값/.test(error.message) && !/hunter2secret/.test(error.message));
    assert.throws(() => add({ ...base, problem: Array.from({ length: 9 }, (_, n) => `at line ${n}`).join("\n") }), /problem: 로그·출력 전문으로 보입니다/);
    assert.throws(() => add({ ...base, code: ["../other-repo/src/a.ts"] }), /이 저장소 안의 상대 경로만/);
    assert.equal(existsSync(join(repo, "doc/work/ORD-1/experience.md")), false);
    assert.ok(existsSync(join(repo, DRAFT)), "거부하면 초안을 남겨 고치게 한다");
    const work = loadWork(repo)!;
    assert.deepEqual([DRAFT, "doc/work/ORD-1/finding.draft.json", "doc/work/ORD-1/experience.md"].map((path) => isDeliveryExcluded(work, path)), [true, true, false],
      "남은 초안(걸린 비밀 값이 있을 수 있다)은 반영 커밋에 넣지 않고, 기록은 넣는다");
  });

  test("검증을 통과한 작업은 검증됨으로 쓸 수 있고, 기록은 승인·게이트를 흔들지 않는다", async () => {
    const { check } = await import("../agent/validate");
    const { requireValidatable } = await import("../agent/commands");
    await check(requireValidatable(repo, "check"));
    const before = approvalOf(loadWork(repo)!).status;
    assert.match(add({ ...base, status: "검증됨", evidence: ["verify:check"] }), /^기록: EXP-ORD-1-1 v1 · 검증됨/);
    assert.equal(stateOf("EXP-ORD-1-1"), "검증됨");
    assert.equal(approvalOf(loadWork(repo)!).status, before, "작업 폴더의 경험 기록은 승인 해시 밖이다");
  });

  test("hook — experience.md 는 도구로 직접 쓰지 않고 초안 자리는 쓸 수 있다(두 호스트가 같은 판정)", () => {
    const writeTool = (path: string) => decide({ cwd: repo, tool_name: "Write", tool_input: { file_path: join(repo, path) } });
    assert.match(writeTool("doc/work/ORD-1/experience.md") ?? "", /code-agent experience add <초안> 이 씁니다\(초안 자리 doc\/work\/ORD-1\/experience\.draft\.json\)/);
    assert.equal(writeTool(DRAFT), undefined);
    const patch = (path: string) => ((codexHook({ cwd: repo, hook_event_name: "PreToolUse", session_id: "s1", tool_name: "apply_patch",
      tool_input: { command: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch` } }) as { hookSpecificOutput?: { permissionDecisionReason?: string } })
      .hookSpecificOutput?.permissionDecisionReason ?? "");
    assert.match(patch("doc/work/ORD-1/experience.md"), /code-agent experience add <초안> 이 씁니다/);
    assert.match(patch(".code-agent/work/ORD-1/findings.json"), /도구로 고칠 수 없습니다/);
    assert.equal(patch(DRAFT), "");
  });
});
