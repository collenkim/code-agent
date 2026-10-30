/**
 * `code-agent test-repair <TC-ID…> --cause <원인> --reason <근거>` — 테스트 수정 창을 연다(판정·기계 검사는 testRepair.ts).
 *
 * 여는 조건은 모두 코드가 대조한다: 지금 계획·기준 커밋에 묶인 증거, 테스트 동결, 고친 것이 남은 열린 창 없음(파일이 동결 기준과 같은
 * 열린 창은 새 창이 대신한다), ⑦ 에 있는 TC, 마지막 실행에서 실패한 TC
 * (표기 원인은 결과 미인식도), 그 TC 토큰(표기 원인은 비슷한 표기)이 있는 kind:test 계획 파일, refactor 의 기준 커밋 테스트 아님,
 * 다음 회차를 열 수 있는 남은 회차. 열면 증거에 창을 남기고 지정 테스트 담당이 읽을 전문(handoff)을 쓴다 — 메인은 그 경로만 넘긴다.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { boundEvidence, failedRuns, runsOf, testFrozen, testStageFiles, verifyView, type Evidence } from "./evidence";
import { handoffLines, writeHandoff } from "./handoff";
import { writeBlockReason } from "./retryPolicy";
import { Stop } from "./stop";
import { questionsFile } from "./layout";
import { shortCommand } from "./screenText";
import { tcToken } from "./testResults";
import { fileHashes } from "./tree";
import { trackedTestFiles } from "./testFiles";
import {
  caseResults, openRepair, REPAIR_AGENT, REPAIR_CAUSE_LABEL, REPAIR_CAUSES, REPAIR_MAX_CASES, repairFileStats, type RepairCause, type TestRepair,
} from "./testRepair";
import { recordEvent } from "./timeline";
import { patchEvidence } from "./validate";
import type { Work } from "./work";
import { parseTestCases, readWorkDoc } from "./workDocs";

export const TEST_REPAIR_USAGE = `사용법: code-agent test-repair <TC-ID…> --cause <${REPAIR_CAUSES.join("|")}> --reason <근거>`;

export interface RepairRequest { cases: string[]; cause: RepairCause; reason: string }

export function parseRepairArgs(args: string[]): RepairRequest {
  const cases: string[] = [];
  let cause: string | undefined, reason: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--cause" || arg === "--reason") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Stop(`${arg} 에 값이 필요합니다.\n${TEST_REPAIR_USAGE}`);
      if (arg === "--cause") cause = value; else reason = value;
      index += 1;
    } else if (/^TC-\d+$/.test(arg)) cases.push(arg);
    else throw new Stop(`알 수 없는 인자입니다: ${arg}\n${TEST_REPAIR_USAGE}`);
  }
  if (!cases.length || !cause || reason === undefined) throw new Stop(TEST_REPAIR_USAGE);
  if (!(REPAIR_CAUSES as readonly string[]).includes(cause)) {
    throw new Stop(`원인 분류는 ${REPAIR_CAUSES.map((value) => `${value}(${REPAIR_CAUSE_LABEL[value]})`).join(" · ")} 중 하나입니다 — ` +
      "이 넷이 아닌 테스트 문제(기대 결과·AC 를 바꿔야 하는 것)는 창이 아니라 재계획 대상입니다.");
  }
  const text = reason.replace(/\s+/g, " ").trim();
  if (!text || text.length > 1000) throw new Stop("--reason 에 근거(실패 로그 줄·파일:줄과 왜 테스트 구현 오류인지)를 1,000자 안으로 적으세요.");
  if (new Set(cases).size !== cases.length) throw new Stop("같은 TC 를 두 번 적었습니다.");
  if (cases.length > REPAIR_MAX_CASES) throw new Stop(`한 창은 TC ${REPAIR_MAX_CASES}개까지 엽니다 — 원인이 다르면 창을 나눕니다.`);
  return { cases, cause: cause as RepairCause, reason: text };
}

/** 표기 원인의 비슷한 표기(`TC_3`·`TC3`·`tc-3`) — evidence.ts tcNearMisses 와 같은 꼴 */
const nearMiss = (id: string): RegExp => new RegExp(`(?<![A-Za-z0-9])TC[-_ ]?${id.slice(3)}(?![0-9])[A-Za-z]*`, "i");

export function openTestRepair(work: Work, request: RepairRequest): string {
  const evidence = boundEvidence(work);
  if (!evidence) throw new Stop("지금 계획·기준 커밋에 묶인 검증 증거가 없습니다 — code-agent verify 로 먼저 검증하세요.");
  if (!testFrozen(evidence)) throw new Stop("테스트가 아직 얼지 않았습니다 — 동결 전에는 테스트 담당이 계획 안에서 테스트를 그대로 고칩니다.");
  const open = openRepair(evidence);
  const pending = open && Object.entries(fileHashes(work.repoRoot, open.files)).some(([path, hash]) => evidence.testFreeze?.files[path] !== hash);
  if (open && pending) {
    throw new Stop(`테스트 수정 창 #${open.n}(${open.cases.join(", ")})의 파일이 바뀐 채 열려 있습니다 — code-agent verify --json 으로 그 창을 판정받거나, ` +
      "지정 테스트 담당이 되돌린 뒤 새 창을 엽니다.");
  }

  const spec = readWorkDoc(work.repoRoot, work.active.id, "07-test-spec");
  const specCases = spec ? parseTestCases(spec) : [];
  const problems: string[] = [];
  for (const id of request.cases) {
    if (!specCases.some((entry) => entry.id === id)) { problems.push(`${id}: ⑦ 에 없는 TC 입니다`); continue; }
    const results = caseResults(evidence, id);
    const failing = results.some((entry) => entry.status === "failed") ||
      (request.cause === "notation" && results.some((entry) => entry.status !== "passed" && entry.status !== "skipped"));
    if (!failing) problems.push(`${id}: 마지막 실행에서 실패하지 않았습니다(${results.map((entry) => entry.status ?? "기록 없음").join(", ") || "결과 없음"}) — 창은 실패한 TC 만 엽니다(표기 원인은 인식되지 않은 TC 도)`);
  }
  const protectedFiles = work.order.kind === "refactor" ? trackedTestFiles(work) : [];
  const texts = new Map<string, string>();
  for (const path of testStageFiles(work)) {
    const full = join(work.repoRoot, path);
    if (existsSync(full)) texts.set(path, readFileSync(full, "utf-8"));
  }
  const files = new Set<string>();
  for (const id of request.cases) {
    const hits = [...texts].filter(([, text]) => tcToken(id).test(text) || (request.cause === "notation" && nearMiss(id).test(text))).map(([path]) => path);
    const open = hits.filter((path) => !protectedFiles.includes(path));
    if (!hits.length) problems.push(`${id}: 이 TC 가 있는 kind:test 계획 파일을 찾지 못했습니다`);
    else if (!open.length) problems.push(`${id}: 기준 커밋에 있던 테스트(${hits.join(", ")})라 refactor 에서는 고치지 않습니다`);
    for (const path of open) files.add(path);
  }
  if (problems.length) throw new Stop(`테스트 수정 창을 열지 않았습니다:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);

  const view = verifyView(work, evidence);
  const blocked = writeBlockReason({ state: view.state, emptyRound: view.emptyRound, budget: view.budget, path: [...files][0], questionsPath: questionsFile(work.active.id),
    reviewOpened: view.reviewOpened, reviewOpenFindings: view.reviewOpenFindings });
  if (blocked) throw new Stop(`창을 열어도 고친 테스트를 받아들일 회차가 없습니다 — ${blocked}`);

  const sorted = [...files].sort();
  const repair: TestRepair = {
    n: (evidence.testRepairs?.length ?? 0) + 1, at: new Date().toISOString(), round: evidence.rounds,
    cause: request.cause, reason: request.reason, cases: request.cases, files: sorted,
    baseline: Object.fromEntries(sorted.map((path) => [path, repairFileStats(texts.get(path) ?? "")])),
  };
  patchEvidence(work, (disk) => {
    const previous = openRepair(disk);
    if (previous) previous.withdrawn = { at: repair.at, by: repair.n };
    disk.testRepairs = [...(disk.testRepairs ?? []), repair];
  });
  const file = writeHandoff(work.repoRoot, work.active.id, `test-repair-${repair.n}.md`, repairText(work, evidence, repair, specCases));
  recordEvent(work.repoRoot, { type: "agent.assigned", workId: work.active.id, target: work.active.target, phase: work.active.phase,
    detail: { agentType: REPAIR_AGENT, mode: "test-repair", contextFile: file, repair: repair.n, cases: repair.cases.length } });
  return [
    `테스트 수정 창 #${repair.n} 을 열었습니다 — ${repair.cases.join(", ")} · ${REPAIR_CAUSE_LABEL[repair.cause]}`,
    `- 열린 파일(지정 테스트 담당만 쓴다): ${sorted.join(", ")}`,
    "- 고친 뒤 code-agent verify --json — check 가 기계 검사(TC 토큰 유지·창의 TC 인식·건너뛰기 표지)를 통과한 창만 받아들이고, 다음 리뷰 회차가 고친 테스트를 다시 봅니다.",
    ...handoffLines(file, REPAIR_AGENT),
  ].join("\n");
}

function repairText(work: Work, evidence: Evidence, repair: TestRepair, specCases: ReturnType<typeof parseTestCases>): string {
  const cell = (text: string) => text.replace(/\|/g, "\\|");
  const runs = (["test", "integrate"] as const).flatMap((phase) => failedRuns(runsOf(evidence, phase)));
  return [
    `# 테스트 수정 창 #${repair.n} — ${work.active.id} · ${work.active.target} · 검증 회차 ${repair.round}`,
    "",
    "이 파일이 지정 테스트 담당의 입력이다. 아래 TC 의 **테스트 구현**만 고친다 — ⑦ 의 케이스·기대 결과와 AC 는 그대로 지킨다.",
    "",
    `- 원인 분류: ${REPAIR_CAUSE_LABEL[repair.cause]}`,
    `- 근거: ${repair.reason}`,
    "",
    "## 고칠 TC — ⑦ 의 기대 결과(바꾸지 않는다)",
    "",
    "| TC | 마지막 결과 | AC | 케이스 → 기대 결과 |",
    "|---|---|---|---|",
    ...repair.cases.map((id) => {
      const tc = specCases.find((entry) => entry.id === id);
      const status = caseResults(evidence, id).map((entry) => `${entry.status ?? "?"}${entry.where ? ` (${entry.where})` : ""}`).join(" · ");
      return `| ${id} | ${cell(status || "-")} | ${tc?.acceptance.join(", ") ?? "-"} | ${cell(tc ? `${tc.scenario} → ${tc.expected}` : "-")} |`;
    }),
    "",
    "## 고칠 수 있는 파일",
    "",
    ...repair.files.map((path) => `- ${path} (지금 단언 꼴 ${repair.baseline[path].asserts}개 · 건너뛰기 표지 ${repair.baseline[path].skips}개)`),
    "",
    "## 실패한 실행",
    "",
    ...(runs.length ? runs.map((run) => `- ${run.phase}·${run.kind}: ${run.outcome}${run.command ? ` (${shortCommand(run.command)})` : ""}${run.logFile ? ` · 전체 로그 ${run.logFile}` : ""}`) : ["- (실패한 실행 기록 없음 — TC 결과를 본다)"]),
    "",
    "## 지킬 것",
    "",
    "- 위 파일 밖(구현 코드·다른 테스트 파일·⑦·계획 문서)은 고치지 않는다. 구현이 틀렸으면 고치지 말고 근거와 함께 보고한다.",
    "- TC 토큰을 지우거나 다른 TC·파일로 옮기지 않는다. 건너뛰기·조건부 실행 표지(@Disabled·skip·xit·assume 등)를 더하지 않는다 — 다음 check 가 기계로 대조해 창을 거부한다.",
    "- 단언을 지우거나 기대값을 약하게 하지 않는다. 같은 기대를 맞는 꼴로 다시 쓰는 것이 이 창의 일이다. ⑦ 의 기대 결과를 바꿔야 통과하면 고치지 말고 그 사실을 보고한다(재계획 대상).",
    "- 끝나면 고친 TC·파일:줄·이유를 짧게 돌려준다. 메인이 `code-agent verify --json` 으로 check 부터 다시 돌고, 고친 테스트는 다음 리뷰 회차가 다시 본다.",
    "",
  ].join("\n");
}
