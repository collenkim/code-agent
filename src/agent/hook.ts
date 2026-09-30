import { isAbsolute, relative, resolve } from "path";

import { existsSync } from "fs";
import { join } from "path";

import { hashPlan } from "../core/approval";
import { checkPaths, unplannedFiles } from "../core/gate";
import type { Manifest, StageDef } from "../core/manifest";
import { docPaths } from "./docs";
import {
  fixLimit,
  loadEvidence,
  overFixLimit,
  reproMissing,
  testRoots,
  trackedTestFiles,
  validationDocFile,
} from "./evidence";
import { storeDir } from "./plugins/store";
import { findingOpensFile } from "./review";
import { KNOWLEDGE_KINDS, POLICY_KINDS } from "./schemas";
import { canonical, DOCS_SESSION_FILE, STATE_DIR, workDocsDir } from "./layout";
import { approvalOf, loadManifestIfAny, loadWork } from "./work";
import type { Work } from "./work";
import { planDocFile } from "./workDocs";

/**
 * Claude Code PreToolUse hook 의 판정.
 *
 * 규칙 대조라 모델에게 맡기지 않는다. 거부 사유는 모델에게 그대로 보이므로, 무엇을 하면 풀리는지까지 적는다.
 * 진행 중인 작업이 없으면 관여하지 않는다 — code-agent 로 하는 작업이 아닐 때까지 막을 이유는 없다.
 */
export interface HookInput {
  cwd: string;
  tool_name: string;
  tool_input: { file_path?: string; notebook_path?: string; path?: string; command?: string };
}

const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/** 경로를 받아 파일 내용을 모델에게 주는 도구들 */
const READ_TOOLS = ["Read", "Grep", "Glob"];

/** 셸 연결·리다이렉트·치환. 허용 목록의 명령 뒤에 무엇이든 붙일 수 있게 되는 자리다 */
const SHELL_META = /[;&|<>`\n]|\$\(/;

const READONLY_GIT = /^git (status|diff|log|show)(\s|$)/;

/**
 * 읽기용 git 도 `-o`·`--output` 을 받으면 파일을 쓴다 — `git show HEAD:<경로> --output=<아무 곳>` 은
 * 커밋된 내용을 바이트 그대로 아무 자리에 떨군다. 셸 메타 문자가 없어 SHELL_META 에도 걸리지 않는다.
 */
const WRITES_FILE = /(^|\s)(-o|--output)(=|\s|$)/;

/**
 * 모델이 Bash 로 부를 수 있는 `code-agent` 서브명령 — 스킬이 부르는 것뿐이다.
 *
 * `init`·`abort`·`approve`·`reject`·`confirm`·`model`·`deliver`·`plugin add`·`plugin remove` 는 사람이 터미널에서
 * 돌리는 것이다. 열어 두면
 * `abort` 한 줄로 작업 커서가 사라져 hook 이 아무것도 판정하지 않게 되고, `init --cli <제 스크립트>` 로
 * hook 자체가 갈린다. `deliver` 는 TTY 확인 뒤 커밋까지 가므로 모델의 자리가 아니다 —
 * 여기 없어도 `confirmOnTerminal` 이 한 번 더 막지만, 두 겹으로 닫는다.
 */
const MODEL_SUBCOMMANDS = [
  "start",
  "next",
  // 되감기는 열어 둔다 — 앞으로는 못 가고 지우는 것도 없어 건너뛸 수 있는 것이 없다.
  // 승인·증거가 전부 해시에 묶여 있어, 되감아도 통과가 되살아나거나 회차가 줄지 않는다.
  "back",
  "context",
  "status",
  "plan submit",
  "docs",
  "survey",
  "manifest check",
  // `plugin list` **만** 연다. `"plugin"` 을 넣으면 isModelCommand 의 접두어 일치로 add·remove 까지
  // 열려, 모델이 "어디로 코드가 나가는가" 를 제 손으로 정하게 된다.
  "plugin list",
  "repro",
  "check",
  "test",
  "review",
  "integrate",
];

function isModelCommand(command: string): boolean {
  if (command === "code-agent") {
    return true;
  }
  if (!command.startsWith("code-agent ")) {
    return false;
  }
  const rest = command.slice("code-agent ".length);
  return MODEL_SUBCOMMANDS.some((sub) => rest === sub || rest.startsWith(`${sub} `));
}

/**
 * `git branch` 는 목록 보기만. 인자를 열어 두면 `-D`·`-m`·`<새 브랜치>` 로 작업 브랜치를 지우거나 바꾼다 —
 * 작업 브랜치는 start 만 딴다.
 */
const READONLY_BRANCH = /^git branch(\s+(--list|-a|--all|-r|--remotes|-v|-vv|--verbose|--show-current))*$/;

/**
 * 등록된 키가 사는 자리 — **모델은 여기를 읽지 못한다.**
 *
 * P7 이 사용자 키를 평문으로 디스크에 두면서 생긴 자리다. 등록·제거는 TTY 로 막았지만, 막은 것은
 * *쓰는* 길뿐이었다 — `Read ~/.code-agent/credentials.json` 한 번이면 그 키가 모델의 화면에 그대로
 * 온다. 경로 비교는 구분자와 대소문자를 접어 본다 (Windows 는 둘 다 흔들린다).
 */
function normalized(path: string): string {
  return resolve(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function insideStore(target: string): boolean {
  if (target.trim() === "") {
    return false;
  }
  const root = normalized(storeDir());
  const path = normalized(target);
  return path === root || path.startsWith(`${root}/`);
}

const STORE_DENIED =
  "등록된 플러그인 키가 있는 자리는 읽을 수 없습니다. " +
  "무엇이 등록돼 있는지는 code-agent plugin list 가 값을 빼고 보여 줍니다 — 키가 필요하면 사람에게 물으세요.";

export function decide(input: HookInput, projectDir?: string): string | undefined {
  const repoRoot = canonical(projectDir ?? input.cwd);
  const work = loadWork(repoRoot);
  const documenting = !work && existsSync(join(repoRoot, DOCS_SESSION_FILE));
  if (!work && !documenting) {
    return undefined;
  }
  const manifest = work ? work.manifest : loadManifestIfAny(repoRoot);
  if (input.tool_name === "Bash") {
    return decideBash(manifest, (input.tool_input.command ?? "").trim(), documenting);
  }
  // 읽기는 저장소 밖도 열려 있다 — 딱 한 자리만 닫는다
  if (READ_TOOLS.includes(input.tool_name)) {
    const target = input.tool_input.file_path ?? input.tool_input.path ?? "";
    return insideStore(target) ? STORE_DENIED : undefined;
  }
  if (!WRITE_TOOLS.includes(input.tool_name)) {
    return undefined;
  }
  const target = input.tool_input.file_path ?? input.tool_input.notebook_path ?? "";
  const path = repoPath(repoRoot, target);
  const outside = guardRepo(path, target);
  if (outside) {
    return outside;
  }
  return work ? decideWrite(work, path) : decideDocWrite(manifest, path);
}

function repoPath(repoRoot: string, target: string): string {
  const absolute = isAbsolute(target) ? target : resolve(repoRoot, target);
  return relative(repoRoot, canonical(absolute)).replace(/\\/g, "/");
}

/** 어느 모드든 공통 — 저장소 밖과 `.code-agent/` 는 도구로 쓸 수 없다 */
function guardRepo(path: string, target: string): string | undefined {
  if (path === "" || path.startsWith("..") || isAbsolute(path)) {
    return `저장소 밖의 파일입니다: ${target}`;
  }
  if (path === STATE_DIR || path.startsWith(`${STATE_DIR}/`)) {
    return (
      "작업 상태·제출된 계획·승인 기록은 도구로 고칠 수 없습니다. " +
      "진행은 code-agent next, 계획은 code-agent plan submit, 확정은 code-agent confirm 으로 바뀝니다."
    );
  }
  return undefined;
}

/**
 * 문서 작성 세션 — 문서를 쓰다가 코드를 "고쳐 두는" 일을 막는다.
 * 쓸 수 있는 곳은 `doc/` 아래, 등록된 문서 경로, `code-agent.json`(도입할 때 만든다)뿐이다.
 */
function decideDocWrite(manifest: Manifest | undefined, path: string): string | undefined {
  const allowed = ["doc", ...[...POLICY_KINDS, ...KNOWLEDGE_KINDS].flatMap((kind) => docPaths(manifest, kind))];
  if (path === "code-agent.json" || allowed.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return undefined;
  }
  return (
    `문서 작성 중에는 문서 자리(doc/, 등록된 문서, code-agent.json) 밖은 쓸 수 없습니다: ${path}. ` +
    "코드를 바꿔야 한다고 보이면 문서에 적고 사람에게 알리세요. 세션은 code-agent docs end 로 끝납니다."
  );
}

/**
 * 셸 명령이 키 파일 자리를 가리키는가.
 *
 * 해석한 경로만 보면 `~`·`$HOME` 표기를 놓친다 — 셸이 풀기 전의 글자도 함께 본다.
 * 허용 목록을 통과한 명령(`declared`)이라도 여기서 먼저 걸린다.
 */
const STORE_MARKERS = [
  "~/.code-agent",
  "$home/.code-agent",
  "${home}/.code-agent",
  "%userprofile%/.code-agent",
  "$code_agent_home",
  "${code_agent_home}",
  "%code_agent_home%",
];

function mentionsStore(command: string): boolean {
  const text = command.replace(/\\/g, "/").toLowerCase();
  return text.includes(normalized(storeDir())) || STORE_MARKERS.some((marker) => text.includes(marker));
}

function decideBash(manifest: Manifest | undefined, command: string, documenting: boolean): string | undefined {
  if (mentionsStore(command)) {
    return STORE_DENIED;
  }
  // 문서 세션에서는 **선언된 명령을 열지 않는다.** 그 세션은 `code-agent.json` 을 쓸 수 있는
  // 유일한 자리라(`decideDocWrite`), 허용 목록을 모델이 제 손으로 넓히고 그것을 그대로 돌리는
  // 길이 열린다. 문서를 쓰는 동안 빌드·테스트를 돌릴 일은 없다.
  const declared = documenting
    ? []
    : [manifest?.build, manifest?.test, ...Object.values(manifest?.commands ?? {})]
        .filter((argv): argv is string[] => Array.isArray(argv) && argv.length > 0)
        .map((argv) => argv.join(" "));

  const allowed =
    !SHELL_META.test(command) &&
    (isModelCommand(command) ||
      declared.includes(command) ||
      (!WRITES_FILE.test(command) && (READONLY_GIT.test(command) || READONLY_BRANCH.test(command))));
  if (allowed) {
    return undefined;
  }
  return (
    `작업 중에는 Bash 로 code-agent 명령(${MODEL_SUBCOMMANDS.join(" · ")}), 선언된 명령` +
    (declared.length > 0 ? ` (${declared.join(" / ")})` : "") +
    ", 읽기용 git(status·diff·log·show, branch 는 목록 보기만, 파일로 내보내기 없이)만 실행할 수 있습니다. " +
    "연결·리다이렉트(; && | >)는 안 됩니다. init·abort·approve·reject·confirm·model·plugin add·plugin remove 는 " +
    "사람이 터미널에서 실행합니다. " +
    "파일은 Write/Edit 로 고치고, 읽기는 Read/Grep/Glob 을 쓰세요."
  );
}

function decideWrite(work: Work, path: string): string | undefined {
  const { repoRoot, active } = work;
  // 지시서는 사람의 입력이다 — 작업 폴더 안에 있어도 모델이 고치지 않는다. 모호하면 질문으로 돌린다.
  if (path === active.spec) {
    return (
      `작업 지시서(${active.spec})는 고칠 수 없습니다. 요구가 모호하거나 틀려 보이면 ` +
      `${workDocsDir(active.id)}/questions.md 에 질문으로 남기세요 — 지시서는 사람이 고칩니다.`
    );
  }
  // 05-plan.md 는 제출된 plan.json 의 파생물이라 코드만 쓴다 — 모델이 고치면 승인받은 계획과 읽는 문서가 갈라진다.
  // 대소문자는 무시한다 — 파일이 아직 없으면 canonical 이 실제 이름으로 되돌려 주지 못해 `05-PLAN.md` 가 지나간다.
  if (path.toLowerCase() === planDocFile(active.id).toLowerCase()) {
    return (
      `${planDocFile(active.id)} 는 코드가 렌더합니다 — code-agent plan submit 이 plan.json 에서 만듭니다. ` +
      `고칠 것이 있으면 ${workDocsDir(active.id)}/plan.json 을 고쳐 다시 제출하세요.`
    );
  }
  // ⑧ 도 같은 이유로 코드만 쓴다 — 검증 결과는 모델이 보고하는 것이 아니라 명령이 돌아서 남은 것만 유효하다.
  //
  // ⑨·⑩ 은 경로로 막지 않는다. 한 파일 안에서 쓰는 쪽이 갈리기 때문이다(회차 머리·추적표는 코드,
  // 지적·요약은 모델) — 안쪽만 막으려면 Edit 의 부분 치환까지 봐야 해 경로 단위 거부보다 비싸다.
  // 대신 코드가 그 구역을 **다시 렌더해 바이트로 대조한다** (blocks.ts · review.ts · deliver.ts).
  if (path.toLowerCase() === validationDocFile(active.id).toLowerCase()) {
    return (
      `${validationDocFile(active.id)} 는 코드가 렌더합니다 — code-agent check · test · integrate 가 검증 증거에서 만듭니다. ` +
      "검증 결과는 모델이 보고하는 것이 아니라 명령이 돌아서 남은 것만 유효합니다."
    );
  }
  // 작업 폴더(번호 문서·질문·계획 초안)는 어느 스테이지에서든 쓴다.
  const workDir = workDocsDir(active.id);
  if (path === workDir || path.startsWith(`${workDir}/`)) {
    return undefined;
  }

  // 리팩토링이 기존 테스트를 고치면 '동작 보존' 을 재는 자가 없어진다. 계획 밖 변경으로도 잡히지만
  // 여기서 막아야 **무엇이 규칙인지**가 거부 사유로 보인다. 접두어를 먼저 보고 그때만 git 을 부른다.
  if (work.order.kind === "refactor") {
    const roots = testRoots(work);
    if (roots.some((root) => path === root || path.startsWith(`${root}/`)) && trackedTestFiles(work).includes(path)) {
      return (
        `리팩토링은 기존 테스트를 고치지 않습니다 — hook 이 막습니다: ${path}. ` +
        "동작이 보존되는지 보는 것이 그 테스트입니다. " +
        `테스트를 고쳐야 할 이유가 보이면 ${workDocsDir(active.id)}/questions.md 로 물으세요.`
      );
    }
  }

  if (active.phase === "analysis" || active.phase === "impact" || active.phase === "design" || active.phase === "plan") {
    return (
      `지금은 ${active.phase} 스테이지라 작업 폴더(${workDir}/) 밖은 쓸 수 없습니다. ` +
      "코드는 계획이 승인된 뒤 implement 스테이지에서 씁니다."
    );
  }
  const { plan, order, manifest } = work;
  if (!plan) {
    return "제출된 계획이 없습니다. code-agent plan submit 으로 계획을 제출하고 승인을 받아야 합니다.";
  }
  const approval = approvalOf(work);
  if (approval.status !== "approved") {
    return (
      `계획이 승인되지 않았습니다 (${approval.status}). ` +
      "사람이 별도 터미널에서 code-agent approve 를 실행해야 쓸 수 있습니다."
    );
  }

  // 계획이 이 파일에 배정한 단계. 검증·리뷰는 고쳐 쓰는 자리라 커서가 아니라 이 단계의 규칙으로 본다.
  const planStage = work.stages.find((candidate) =>
    plan.files.some((file) => file.stage === candidate.key && file.path === path),
  );
  // implement 는 지금 단계의 파일만 — 경계·계획 대조는 커서 단계로 한다.
  const stage = active.phase === "implement" ? work.stage : planStage;
  if (!stage) {
    return active.phase === "implement"
      ? `지금 단계(${active.stage ?? "없음"})를 매니페스트에서 찾을 수 없습니다. code-agent status 로 확인하세요.`
      : `승인된 계획에 없는 파일입니다: ${path}. 필요하면 사람에게 알리세요 — 계획을 고치면 재승인을 받습니다.`;
  }
  const blocked = reproReason(work, path);
  if (blocked) {
    return blocked;
  }
  // 동결은 **그 파일이 속한 단계**로 잰다. 커서 단계로 재면, 구현 중 커서가 테스트 단계에 서 있는
  // 동안 고칠 파일까지 '테스트가 얼었다' 는 엉뚱한 사유로 막힌다 (막히는 것은 맞아도 이유가 틀린다).
  const frozen = freezeReason(work, planStage ?? stage, path);
  if (frozen) {
    return frozen;
  }
  const violations = [
    ...checkPaths({ repoRoot, order, manifest, plan, stage, files: [{ path, content: "" }] }),
    ...unplannedFiles(plan, stage, [path]),
  ];
  if (violations.length > 0) {
    return violations.map((v) => `[${v.item}] ${v.file}: ${v.detail}`).join("\n");
  }
  return undefined;
}

/**
 * fix 의 '재현 먼저'. 재현 증거가 없으면 **고칠 파일**(kind:"test" 가 아닌 계획 파일)을 쓸 수 없다.
 *
 * `freezeReason` 과 같은 이유로 스테이지가 아니라 증거로 잰다 — `back implement` 로 풀리면 안 된다.
 * 판정은 `reproMissing` 한 곳에 있다 (`next` 게이트가 같은 함수를 쓴다).
 */
function reproReason(work: Work, path: string): string | undefined {
  if (work.order.kind !== "fix" || !work.plan) {
    return undefined;
  }
  // 커서 단계가 아니라 **그 파일이 속한 단계**로 본다 — 재현 테스트는 어느 커서에서도 열려 있어야 하고,
  // 고칠 파일은 어느 커서에서도 닫혀 있어야 한다. 계획에 없는 파일은 다른 검사가 막는다.
  const testKeys = new Set(work.stages.filter((candidate) => candidate.kind === "test").map((candidate) => candidate.key));
  const planned = work.plan.files.find((file) => file.path === path);
  if (!planned || testKeys.has(planned.stage)) {
    return undefined;
  }
  const missing = reproMissing(work, loadEvidence(work.repoRoot, work.active.id, work.active.target));
  if (!missing) {
    return undefined;
  }
  return (
    `${missing} — 재현을 먼저 봐야 이 파일을 고칠 수 있습니다: ${path} (fix).\n` +
    "kind:\"test\" 단계의 계획 파일을 쓴 뒤 code-agent repro 로 지금 코드에서 **실패**하는 것을 보세요 — " +
    "고치고 나서 쓴 테스트는 결함을 재현한 적이 없습니다."
  );
}

/**
 * 이 파일을 고칠 수 없는 이유. 둘이다.
 *
 * **스테이지로 재지 않는다.** 증거가 있고 그 증거가 지금 계획(`planHash`) 위의 것인지만 본다 —
 * `code-agent back implement` 로 커서를 구현으로 빼면 두 규칙이 다 풀리기 때문이다. 첫 구현 패스에는
 * 증거 자체가 없어 여기서 걸릴 것이 없고, 계획을 재승인하면 `planHash` 가 달라져 둘이 함께 풀린다.
 *
 * **① 테스트 동결** — 테스트가 한 번 돈 뒤(통과든 실패든)에는 `kind: "test"` 단계의 계획 파일을
 * 고칠 수 없다. 옛 흐름이 "verify 단계의 outputDirs 에 테스트 디렉토리를 넣지 않는다"로 구조적으로
 * 막던 것의 최소 번역이다 — 실패한 단언을 지워 통과시키는 길이 여기서 닫힌다. `kind` 는
 * `hashManifest` 가 이미 해시하므로 승인 묶임이 따라온다: 승인 뒤에 선언을 끌 수 없다.
 * 푸는 길은 둘 — ⑨ 에 그 파일을 가리키는 열린 계획 안 지적, 또는 계획 재승인(planHash 가 달라지면
 * 증거가 통째로 무효라 동결도 함께 풀린다).
 *
 * **② 고쳐 쓰기 한도** — 한도를 넘겨 실패한 채면 계획 안 파일을 **전부** 거부한다. 작업 폴더는
 * 이 함수에 오기 전에 이미 통과했으므로 보고와 질문의 길은 남는다.
 */
function freezeReason(work: Work, stage: StageDef, path: string): string | undefined {
  const evidence = loadEvidence(work.repoRoot, work.active.id, work.active.target);
  if (!evidence || !work.plan || evidence.planHash !== hashPlan(work.plan)) {
    return undefined;
  }
  if (overFixLimit(work, evidence)) {
    return (
      `고쳐 쓰기 ${fixLimit(work, evidence)}회를 넘겨 계획 파일을 더 고칠 수 없습니다: ${path}. ` +
      `${workDocsDir(work.active.id)}/questions.md 에 무엇이 막혔는지 적고 사람에게 보고하세요 — ` +
      "덮지 않고 보고하는 자리입니다. 계획 자체를 고쳐야 하면 사람이 재승인해야 합니다."
    );
  }
  // 재현을 본 순간에도 언다 — 그때부터 단언을 약하게 하면 재현이 증거가 아니게 된다.
  // (`phase: "repro"` 로 기록하는 이유가 여기다. `test` 로 기록하면 재현에 실패했을 때
  //  재현 테스트를 고칠 길이 막혀 교착이 된다.)
  if (stage.kind === "test" && (evidence.runs.some((run) => run.phase === "test") || evidence.repro !== undefined)) {
    // 탈출구 둘 — ⑨ 에 이 파일을 가리키는 열린 계획 안 지적이 있거나, 계획이 재승인되거나.
    // 앞의 것은 문서에 남는 지적이 열쇠라 몰래 풀 수 없다 (그 줄이 닫히기 전에는 리뷰 게이트가 막는다).
    if (findingOpensFile(work, path)) {
      return undefined;
    }
    return (
      `테스트가 이미 돌아 얼어 있는 파일입니다: ${path} (단계 ${stage.key}, kind: test). ` +
      "테스트가 틀렸다고 판단되면 고치지 말고 근거와 함께 보고하세요 — 단언을 지워 통과시키는 길을 막는 자리입니다. " +
      "(재현을 본 뒤에는 재현 테스트가 얼립니다 — 그 단언을 약하게 하면 재현이 증거가 아니게 됩니다.) " +
      `정말 고쳐야 하면 ${workDocsDir(work.active.id)}/09-review.md 에 그 파일을 가리키는 지적으로 남기거나, ` +
      "계획을 고쳐 사람의 재승인을 받으세요."
    );
  }
  return undefined;
}

/** stdin 으로 받아 stdout 으로 낸다. 판정 자체가 실패하면 exit 2 — 막는 쪽으로 닫는다 */
export function runHook(stdin: string): number {
  try {
    const reason = decide(JSON.parse(stdin) as HookInput, process.env.CLAUDE_PROJECT_DIR);
    if (reason) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        }),
      );
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `code-agent hook 이 판정에 실패해 막았습니다: ${error instanceof Error ? error.message : error}\n`,
    );
    return 2;
  }
}
