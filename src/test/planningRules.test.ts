import { writeFixture as writeRepoFile } from "./repoFixture";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { start } from "./confirmedStart";
import { observeQuestionAnswers } from "./consentFixture";
import { checkProjectDocs, recordDocConfirmation } from "../agent/docs";
import { loadManifest } from "../core/manifest";
import { loadWork } from "../agent/work";
import { planningDocumentProblems } from "../agent/planningValidation";
import { sourceTrace } from "../agent/sourceTrace";
import { parseRequirements } from "../agent/workDocs";
import { citationText, requirementBlocks, sourceIds } from "../agent/requirementFields";
import { skeleton, WORK_SCHEMAS } from "../agent/schemas";
import { ruleOf } from "../agent/planningRules";

const ID = "RULE-1", DIR = `doc/work/${ID}`, SPEC = `${DIR}/requirement.md`;
const LOG = "java.lang.NullPointerException: items is null\n    at app.OrderService.place(OrderService.java:42)\n    at app.OrderController.post(OrderController.java:17)";
let root: string;
function write(path: string, content: string): void {
  writeRepoFile(root, path, content);
  if (path.endsWith("questions.md")) observeQuestionAnswers(root);
}
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-rules-")));
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: root });
  write("code-agent.json", JSON.stringify({ language: "typescript", sourceExtensions: [".ts"], domainBase: "src", domainRoots: [], conventions: ["doc/conventions.md"], docs: { architecture: "doc/architecture.md" }, referenceDomain: "reference", build: ["node", "-e", "process.exit(0)"], test: ["node", "-e", "process.exit(0)"], stages: [{ key: "app", title: "함수", template: "app.md", scope: "project", outputDirs: ["src"] }, { key: "test", title: "검증", template: "test.md", kind: "test", scope: "project", outputDirs: ["test"], kinds: ["feature", "fix"] }] }));
  write("doc/architecture.md", "# 아키텍처\n## 기술 스택\nNode\n## 모듈/패키지 구조\nsrc\n## 계층과 책임\n함수\n## 의존 방향\ntest → src\n## 공통 모듈\n없음\n## 주요 결정\n순수 함수");
  write("doc/conventions.md", "# 컨벤션\n## 명명\n소문자\n## 계층별 규칙\n순수 함수\n## 예외 처리\nError");
  write("doc/test-strategy.md", "# 테스트 전략\n## 수준과 범위\n- Unit: 필수\n## 도구와 실행 명령\n- `test`: 전체\n## 통과 기준\n- AC마다1개");
  write("doc/quality.md", "# 품질\n## 정적 분석\n- `build`: 컴파일\n## 보안 검사\n- 없음 — 리뷰에서 확인\n## 통과 기준과 반영 차단\n- 컴파일 실패 차단");
  write(".gitignore", ".code-agent/\n");
  write("src/main/java/app/OrderService.java", "class OrderService {\n  void place() {}\n}\n".repeat(20));
  write("src/a.ts", "export const a = 1;\n".repeat(12));
  write(SPEC, `---\nkind: feature\nid: ${ID}\ntitle: 주문\ntarget: order\n---\n\n주문을 저장한다.\n\n## 오류 로그\n\n\`\`\`\n${LOG}\n\`\`\`\n`);
  for (const check of checkProjectDocs(root, loadManifest(root))) recordDocConfirmation(root, check, "test", { channel: "tty", verified: true, detail: "테스트" });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture"], { cwd: root });
  start(root, join(root, SPEC), { planning: true });
});
afterEach(() => {
  assert.ok(root.startsWith(`${realpathSync.native(tmpdir())}${sep}ca-rules-`));
  rmSync(root, { recursive: true, force: true });
});

const ORDER = "## 요구 내용\n- [REQ-1] 주문을 저장한다, 재고를 줄인다.\n- [REQ-2] 할인율은 3.5% 이다.\n## 완료 조건\n- [DONE-1] 수량이 -1 이면 거부한다.\n## 제약\n- [CON-1] v1.2 API 와 src/a.ts 를 유지한다.\n";
const block = (key: string, lines: string[]) => `## ${key} · 요구\n${lines.join("\n")}\n`;

test("근거·출처 줄 — 목록 표시·강조·전각 쌍점은 표시이고, 닫는 따옴표 뒤는 인용이 아니다 (형식 검사와 원문 추적이 같은 파서)", () => {
  const text = [
    block("R1", ["- **출처**: REQ-1", "- **근거:** \"주문을 저장한다, 재고를 줄인다.\" (REQ-1)"]),
    block("R2", ["* 출처： REQ-2", "1. 근거: “할인율은 3.5% 이다.”"]),
    block("R3", ["출처: DONE-1", "출처: CON-1", "근거: \"수량이 -1 이면 거부한다.\" — 완료 조건", "근거: 「v1.2 API 와 src/a.ts 를 유지한다.」"]),
    "## 가정\n- 없음",
  ].join("\n");
  assert.deepEqual(requirementBlocks(text).map((item) => [item.key, item.grounds.length, item.sources.length]), [["R1", 1, 1], ["R2", 1, 1], ["R3", 2, 2]]);
  assert.equal(citationText("\"주문 \"A\" 저장\" (REQ-1)"), "주문 \"A\" 저장", "안의 따옴표는 본문, 마지막 닫는 따옴표 뒤는 설명");
  assert.equal(citationText("**\"주문\"**"), "주문");
  assert.doesNotThrow(() => parseRequirements(text));
  assert.deepEqual(sourceTrace(ORDER, text).problems, []);
  // 두 번째 `출처:` 줄도 읽는다 — R3 는 DONE-1·CON-1 만 인용할 수 있다
  assert.match(sourceTrace(ORDER, text.replace("근거: \"수량이 -1 이면 거부한다.\"", "근거: \"주문을 저장한다\"")).problems.join("\n"), /\[REQ-TRACE\] 01-requirements\.md:\d+ R3: 근거 인용이/);
});

test("문장 사이 쉼표·마침표만 빠진 인용은 덮은 것으로 보고, 값의 일부인 기호·숫자·경로가 빠지면 계속 거부한다", () => {
  const cite = (key: string, source: string, quotes: string[]) => block(key, [`출처: ${source}`, ...quotes.map((quote) => `근거: "${quote}"`)]);
  const ok = [cite("R1", "REQ-1", ["주문을 저장한다", "재고를 줄인다"]), cite("R2", "REQ-2", ["할인율은 3.5% 이다"]), cite("R3", "DONE-1", ["수량이 -1 이면 거부한다"]), cite("R4", "CON-1", ["v1.2 API 와 src/a.ts 를 유지한다"])].join("\n");
  assert.deepEqual(sourceTrace(ORDER, ok).problems, []);
  const rejects: [string, string, RegExp][] = [
    ["할인율은 3.5% 이다", "할인율은 3", /"\.5% 이다\."/],                        // 소수점
    ["수량이 -1 이면 거부한다", "1 이면 거부한다", /"수량이 -"/],                      // 음수
    ["v1.2 API 와 src/a.ts 를 유지한다", "2 API 와 src/a", /"v1\."|"\.ts 를 유지한다\."/], // 버전·경로
  ];
  for (const [from, to, missing] of rejects) {
    const problems = sourceTrace(ORDER, ok.replace(`"${from}"`, `"${to}"`)).problems.join("\n");
    assert.match(problems, /\[REQ-TRACE\] 분석에서 빠진 요구/, `${to} 는 거부해야 한다`);
    assert.match(problems, missing);
  }
  // 1,000 의 쉼표·부등호는 값이다
  assert.match(sourceTrace("금액이 1,000 이상이다.", block("R1", ["근거: \"금액이 1\"", "근거: \"000 이상이다\""])).problems.join("\n"), /","/);
  assert.match(sourceTrace("값 >= 100", block("R1", ["근거: \"값\"", "근거: \"100\""])).problems.join("\n"), />=/);
  // 지어낸 인용·없는 출처·형식이 틀린 출처 ID 는 그대로 거부한다
  assert.match(sourceTrace(ORDER, ok.replace("\"주문을 저장한다\"", "\"주문을 삭제한다\"")).problems.join("\n"), /근거 인용이 확정된 요구/);
  assert.match(sourceTrace(ORDER, ok.replace("출처: REQ-2", "출처: REQ-9")).problems.join("\n"), /지시서에 없는 출처 REQ-9 — 있는 ID: REQ-1, REQ-2, DONE-1, CON-1/);
  assert.match(sourceTrace(ORDER, ok.replace("출처: REQ-2", "출처: req-2")).problems.join("\n"), /\[REQ-TRACE\] 01-requirements\.md:\d+ R2: 출처 ID 형식이 아닙니다: req-2/);
  assert.deepEqual(sourceIds([{ value: "REQ-1, REQ1, DONE-2", line: 3 }]), { ids: ["REQ-1", "DONE-2"], invalid: [{ value: "REQ1", line: 3 }] });
  for (const citation of ["", '""', '"  "', '""  (REQ-1)']) assert.throws(() => parseRequirements(`## R1 · 값\n근거: ${citation}\n## 가정\n- 없음`), /\[REQ-FORMAT\] 근거: 줄이 없는 요구 항목: R1\(1행\)/);
});

const doc = (file: string) => `${DIR}/${file}`;
const problemsOf = (file: string, text: string, phase = "design") =>
  planningDocumentProblems(loadWork(root)!, phase, { overlay: new Map([[doc(file), text]]), only: [file] });

test("로그 인용·URL·JDBC 주소는 파일:줄 근거로 검사하지 않고, 실제 코드 근거는 백틱 안이어도 검사한다", () => {
  const analysis = [
    "# 영향도", "## 기존 시스템 분석",
    "- `at app.OrderService.place(OrderService.java:42)` → src/main/java/app/OrderService.java:2 — items 를 확인하지 않는다",
    "```", "    at app.OrderController.post(OrderController.java:17)", "```",
    "- 결제는 https://pay.example.com:443 , DB 는 jdbc:postgresql://db.internal:5432/orders, 배포 계정 deploy@build.example.com:22",
    "- 진입점은 `src/a.ts:10` 이다",
  ].join("\n");
  assert.deepEqual(problemsOf("02-analysis.md", analysis, "impact"), []);
  // 로그에 없는 백틱 내용은 근거다 — 없는 줄·파일 이름만 적은 근거는 계속 거부하고 줄·고칠 곳을 알려 준다
  const wrong = problemsOf("02-analysis.md", analysis.replace("`src/a.ts:10`", "`src/a.ts:99`").replace("→ src/main/java/app/OrderService.java:2", "→ OrderService.java:2"), "impact");
  assert.ok(wrong.some((problem) => /^\[DOC-REF\] doc\/work\/RULE-1\/02-analysis\.md:8: 근거 줄이 파일 범위를 넘었습니다: src\/a\.ts:99$/.test(problem)), wrong.join("\n"));
  assert.ok(wrong.some((problem) => /^\[DOC-REF\] doc\/work\/RULE-1\/02-analysis\.md:3: 근거 파일이 없습니다: OrderService\.java — 저장소 루트 기준 전체 경로로 씁니다 \(저장소에 있는 같은 이름: src\/main\/java\/app\/OrderService\.java\)/.test(problem)), wrong.join("\n"));
  // 로그에 없는 문구를 로그처럼 백틱에 넣어도 근거 검사를 피하지 못한다
  assert.ok(problemsOf("02-analysis.md", analysis.replace("`at app.OrderService.place(OrderService.java:42)`", "`at app.Fake.run(Fake.java:42)`"), "impact").some((problem) => /Fake\.java/.test(problem)));
});

test("미결 표시는 줄과 표현을 알려 준다 — 배정 파일의 뼈대에는 미결 표시를 넣지 않는다", () => {
  const problems = problemsOf("03-design.md", "# 설계\n## 구성 요소\n- 새 함수\n## 처리 흐름\n- 호출 → 반환 (확인 필요)\n## API\n- TBD\n");
  assert.deepEqual(problems.map(ruleOf), ["DOC-PENDING"]);
  assert.match(problems[0], /03-design\.md: 미결 표시가 남았습니다 — 5행 '확인 필요': - 호출 → 반환 \(확인 필요\) · 7행 'TBD': - TBD — 업무 결정이면 needs-input/);
  assert.doesNotMatch(skeleton(WORK_SCHEMAS["03-design"], { pending: false }), /확인 필요/);
  assert.match(skeleton(WORK_SCHEMAS["03-design"]), /확인 필요/, "docs skeleton 의 기존 뼈대는 그대로");
});

test("근거 있는 BR 정의는 AC 에서 다시 근거 없이 가리킬 수 있고, 없는 BR·근거 없는 정의·중복 정의·순환 근거는 거부한다", () => {
  write(doc("questions.md"), "# 질문\n## Q1 · 수량\n수량 0 은?\n[Requirements]: R1\n[Answer]: 거부한다\n");
  const functional = (rules: string, ac = "- AC-R1-1: BR-1 에 따라 수량 0 주문은 거부된다") =>
    `# 기능\n## 기능 정의\n- R1: 주문 저장\n## 업무 규칙\n${rules}\n## 예외\n- 없음 — 입력 검증만\n## 수락 기준\n${ac}\n`;
  assert.deepEqual(problemsOf("04-functional.md", functional("- BR-1: 수량이 0 이면 거부 (Q1)")), []);
  assert.deepEqual(problemsOf("04-functional.md", functional("| BR-1 | 수량 0 | 거부 | src/a.ts:3 |")), [], "표 줄 정의도 읽는다");
  const cases: [string, string, RegExp][] = [
    ["근거 없는 정의", functional("- **BR-1**: 수량이 0 이면 거부"), /^\[FUN-BR\] doc\/work\/RULE-1\/04-functional\.md:5: 업무 규칙 BR-1 에 근거가 없습니다/],
    ["없는 BR", functional("- BR-1: 수량이 0 이면 거부 (Q1)", "- AC-R1-1: BR-2 에 따라 거부된다"), /^\[FUN-BR\] doc\/work\/RULE-1\/04-functional\.md:9: 정의되지 않은 업무 규칙 BR-2/],
    ["중복 정의", functional("- BR-1: 수량이 0 이면 거부 (Q1)\n- BR-1: 수량이 음수면 거부 (Q1)"), /업무 규칙 BR-1 이 여러 번 정의됐습니다 \(5행, 6행\)/],
    ["순환 근거", functional("- BR-1: 수량이 0 이면 거부 — BR-2 참조\n- BR-2: BR-1 과 같다"), /BR-1 에 근거가 없습니다[\s\S]*BR-2 에 근거가 없습니다/],
  ];
  for (const [name, text, expected] of cases) {
    const problems = problemsOf("04-functional.md", text);
    assert.match(problems.join("\n"), expected, `${name}: ${problems.join("\n")}`);
    assert.ok(problems.every((problem) => ruleOf(problem) === "FUN-BR"), name);
  }
});
