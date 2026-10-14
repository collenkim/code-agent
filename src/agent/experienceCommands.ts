import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { isAbsolute, join, posix, resolve } from "path";

import { writeAtomic } from "../core/atomic";
import { documentEntries, entryFields } from "./knowledge";
import { freshness } from "./knowledgeIndex";
import {
  checkEvidence,
  EXPERIENCE_NOTE,
  experienceDriftText,
  experienceIndex,
  experienceLine,
  experienceStateText,
  ExperienceDraftSchema,
  nextExperienceId,
  VERIFY_REF,
} from "./experience";
import type { ExperienceDraft, ExperienceRecord, ExperienceVersion } from "./experience";
import { draftFile, experienceFile, removeDraft, STATE_DIR } from "./layout";
import { acquireLock } from "./lock";
import { TIMING } from "./retryPolicy";
import { sensitiveProblems } from "./sensitiveText";
import { Stop } from "./stop";
import { loadWork } from "./work";

/**
 * `code-agent experience` — 작업 경험 기록(experience.ts)을 쓰고 본다. `add` 만 쓰고(작업 임대를 본다) `list`·`show` 는 읽기 전용이다.
 * 기록은 선택이다 — 없다고 어떤 게이트도 막지 않는다.
 */

const USAGE = "사용법: code-agent experience [add <초안.json> | list [--all] | show <EXP-ID>]";

const FORMAT = `작업 경험 초안(JSON) — doc/work/<ID>/experience.draft.json 에 쓰고 add 에 그 경로를 준다(기록하면 코드가 그 초안을 지운다). 재사용할 가치가 있는 것만 남긴다(대화·로그 전문을 옮기지 않는다):
{
  "title": "문제 한 줄 (120자)",
  "problem": "무엇이 어떻게 안 됐나 (600자)",
  "environment": "당시 OS·런타임·도구 버전 등 (선택, 300자)",
  "attempts": [{ "approach": "시도한 접근", "failure": "실패한 이유" }],
  "cause": "확인된 원인 또는 가설 (600자)",
  "solution": "해결 방법 (선택)",
  "evidence": ["verify:test"],
  "conditions": "이 경험이 맞는 조건 — 언제 다시 쓸 수 있나 (400자)",
  "status": "가설 | 검증됨 | 폐기 (기본 가설)",
  "features": ["FEAT-…"], "policies": ["BR-…"], "code": ["src/…"], "tests": ["test/…"], "aliases": ["별칭"],
  "revises": "EXP-<작업>-<n> (선택 — 그 기록의 새 버전)", "supersedes": "EXP-… (선택 — 이 기록이 대체하는 옛 기록)",
  "change": "이번 버전에서 바뀐 것 (revises 때 필수)"
}
- ID 는 코드가 정한다: 새 기록은 EXP-<이 작업 ID>-<순번>, revises 는 같은 ID 의 버전 +1(같은 작업 안에서 다시 쓰면 갈아 끼우고 버전 유지).
- "검증됨" 은 evidence 에 이 작업의 통과한 검증(verify:repro|check|test|integrate)이 있어야 한다 — 선언만으로는 쓰지 않는다.
- 자격 증명·토큰·비밀 값과 로그·출력 전문은 거부한다 — "<가림>" 이나 설정 위치, 요약 한두 줄과 로그 경로로 쓴다.
- 경험은 정책이 아니다. 정책으로 올리려면 knowledge.proposal 로 제안한다.`;

function gitHead(repoRoot: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** 한 줄 값 — 칸 안의 줄바꿈은 ` / ` 로 잇는다(`- 이름: 값` 한 줄이 한 칸이다) */
const flat = (value: string): string => value.split("\n").map((part) => part.trim()).filter(Boolean).join(" / ");
const ticks = (values: readonly string[]): string => values.map((value) => `\`${value}\``).join(", ");

function cleanPath(path: string): string | undefined {
  const value = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (isAbsolute(path) || /^[A-Za-z]:/.test(value) || value.split("/").includes("..")) return undefined;
  return posix.normalize(value);
}

function renderEntry(input: { id: string; version: number; work: string; draft: ExperienceDraft; base?: string; at: string }): string {
  const { id, version, work, draft } = input;
  const lines = [
    `### \`${id}\` ${flat(draft.title)}`,
    `- 버전: ${version}`,
    `- 작업: ${work}`,
    `- 상태: ${draft.status}`,
    `- 문제: ${flat(draft.problem)}`,
    ...(draft.environment ? [`- 환경: ${flat(draft.environment)}`] : []),
    `- 기준 커밋: ${input.base ?? "없음"} (기록할 때의 HEAD — 작업 트리 변경은 반영 커밋에 들어간다)`,
    ...draft.attempts.map((attempt) => `- 시도: ${flat(attempt.approach)} — 실패 이유: ${flat(attempt.failure)}`),
    `- 원인: ${flat(draft.cause)}`,
    ...(draft.solution ? [`- 해결: ${flat(draft.solution)}`] : []),
    ...(draft.evidence.length ? [`- 검증: ${draft.evidence.join(" · ")}`] : []),
    `- 적용 조건: ${flat(draft.conditions)}`,
    ...(draft.features.length ? [`- 기능: ${ticks(draft.features)}`] : []),
    ...(draft.policies.length ? [`- 정책: ${ticks(draft.policies)}`] : []),
    ...(draft.code.length ? [`- 코드: ${ticks(draft.code)}`] : []),
    ...(draft.tests.length ? [`- 테스트: ${ticks(draft.tests)}`] : []),
    ...(draft.aliases.length ? [`- 별칭: ${draft.aliases.map(flat).join(", ")}`] : []),
    ...(draft.supersedes ? [`- 대체: \`${draft.supersedes}\``] : []),
    ...(draft.change ? [`- 변경: ${flat(draft.change)}`] : []),
    `- 기록: ${input.at}`,
  ];
  return lines.join("\n");
}

const HEADER = (work: string): string => [
  `# ${work} 작업 경험`,
  "",
  "<!-- code-agent experience add 가 쓴다 — 손으로 고치지 않는다. 확정 정책이 아니다: 정책으로 올리려면 knowledge.proposal 로 제안한다. -->",
].join("\n");

/** 같은 작업 폴더에 이미 있는 같은 내용 — 문제·원인·적용 조건이 같으면 같은 경험이다 */
function sameContent(body: string, draft: ExperienceDraft): boolean {
  const fields = entryFields(body);
  const norm = (value: string | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  return norm(fields.get("문제")) === norm(flat(draft.problem)) && norm(fields.get("원인")) === norm(flat(draft.cause)) &&
    norm(fields.get("적용조건")) === norm(flat(draft.conditions));
}

function parseDraft(raw: unknown): ExperienceDraft {
  const parsed = ExperienceDraftSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Stop(`경험 초안 형식이 맞지 않습니다:\n${parsed.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n")}\n\n${FORMAT}`);
  }
  return parsed.data;
}

/** `experience add <초안.json>` — 검사하고 ID·버전을 정해 이 작업의 experience.md 에 쓴다 */
export function experienceAdd(repoRoot: string, file: string): string {
  const work = loadWork(repoRoot);
  if (!work) throw new Stop("진행 중인 작업이 없습니다 — 경험은 그 작업 안에서 기록합니다(반영 커밋에 함께 들어갑니다).");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8")); } catch (error) {
    throw new Stop(`경험 초안을 읽을 수 없습니다 (${file}): ${(error as Error).message}`);
  }
  const draft = parseDraft(raw);
  const sensitive = sensitiveProblems({
    title: draft.title, problem: draft.problem, environment: draft.environment, cause: draft.cause, solution: draft.solution,
    conditions: draft.conditions, change: draft.change, aliases: draft.aliases.join(", "),
    ...Object.fromEntries(draft.attempts.flatMap((attempt, index) => [[`attempts.${index}.approach`, attempt.approach], [`attempts.${index}.failure`, attempt.failure]])),
  });
  if (sensitive.length) throw new Stop(`기록하지 않았습니다 — 민감 정보·로그 전문으로 보이는 칸이 있습니다:\n${sensitive.map((problem) => `  - ${problem}`).join("\n")}`);
  const paths = [...draft.code, ...draft.tests];
  const bad = paths.filter((path) => cleanPath(path) === undefined);
  if (bad.length) throw new Stop(`code·tests 는 이 저장소 안의 상대 경로만 씁니다: ${bad.join(", ")}`);
  draft.code = draft.code.map((path) => cleanPath(path)!);
  draft.tests = draft.tests.map((path) => cleanPath(path)!);
  const badRefs = draft.evidence.filter((ref) => !VERIFY_REF.test(ref));
  if (badRefs.length) throw new Stop(`evidence 는 verify:repro|check|test|integrate 형식입니다(이 작업의 검증 기록): ${badRefs.join(", ")}`);
  const id = work.active.id;
  if (draft.status === "검증됨" && checkEvidence(repoRoot, id, draft.evidence).verified.length === 0) {
    throw new Stop("\"검증됨\" 은 이 작업의 통과한 검증 기록(evidence 의 verify:<단계>)과 이어져야 합니다 — 그 단계의 마지막 회차가 통과하지 않았거나 근거가 없습니다. 지금은 \"가설\" 로 기록하세요.");
  }

  const release = acquireLock(join(repoRoot, STATE_DIR, "work", id, "experience.lock"), { waitMs: TIMING.lockWaitMs, ageReclaim: true, label: "경험 기록", display: `${STATE_DIR}/work/${id}/experience.lock` });
  try {
    const index = experienceIndex(repoRoot);
    const find = (key: string): ExperienceRecord | undefined => index.records.find((record) => record.id === key);
    if (draft.supersedes && !find(draft.supersedes)) throw new Stop(`대체할 기록이 없습니다: ${draft.supersedes}`);
    const path = experienceFile(id);
    const full = join(repoRoot, path);
    const before = existsSync(full) ? readFileSync(full, "utf8") : undefined;
    const eol = before?.includes("\r\n") ? "\r\n" : "\n";
    const text = (before ?? HEADER(id)).replace(/\r\n/g, "\n");
    const entries = documentEntries(text);
    let recordId: string, version: number;
    let replace: { line: number; end: number } | undefined;
    if (draft.revises) {
      const target = find(draft.revises);
      if (!target) throw new Stop(`고칠 기록이 없습니다: ${draft.revises}`);
      if (!draft.change) throw new Stop("revises 에는 이번 버전에서 바뀐 것(change)이 필요합니다.");
      if (draft.supersedes === draft.revises) throw new Stop("같은 기록을 고치면서 대체할 수 없습니다 — 고칠 때는 revises 만 씁니다.");
      recordId = draft.revises;
      const mine = entries.find((entry) => entry.key === recordId);
      if (mine) {
        // 같은 작업 안에서 다시 쓴다 — 반영 전 초안이라 갈아 끼우고 버전은 그대로
        const versions: ExperienceVersion[] = [target.current, ...target.history, ...target.conflicts];
        version = versions.find((item) => item.work === id && item.id === recordId)?.version ?? target.current.version;
        replace = { line: mine.line, end: mine.end };
      } else {
        version = Math.max(target.current.version, ...target.conflicts.map((item) => item.version)) + 1;
      }
    } else {
      const same = entries.find((entry) => entry.key.startsWith(`EXP-${id}-`) && sameContent(entry.body, draft));
      if (same) {
        const removed = removeDraft(repoRoot, id, "experience", file);
        return `같은 경험이 이미 있습니다: ${same.key} (${path} L${same.line}-L${same.end}) — 고치려면 "revises": "${same.key}" 로 다시 쓰세요.${removed ? ` 초안 ${draftFile(id, "experience")} 는 지웠습니다.` : ""}`;
      }
      recordId = nextExperienceId(repoRoot, id);
      version = 1;
      if (draft.supersedes === recordId) throw new Stop("자기 자신을 대체할 수 없습니다.");
    }
    const entry = renderEntry({ id: recordId, version, work: id, draft, base: gitHead(repoRoot), at: new Date().toISOString().slice(0, 10) });
    const lines = text.replace(/\s+$/, "").split("\n");
    const next = replace
      ? [...lines.slice(0, replace.line - 1), ...entry.split("\n"), ...lines.slice(replace.end)]
      : [...lines, "", ...entry.split("\n")];
    writeAtomic(full, `${next.join("\n").replace(/\s+$/, "")}\n`.replace(/\n/g, eol));
    const written = documentEntries(next.join("\n")).find((item) => item.key === recordId)!;
    const removed = removeDraft(repoRoot, id, "experience", file);
    return [
      `기록: ${recordId} v${version} · ${draft.status} → ${path} L${written.line}-L${written.end}${replace ? " (같은 작업의 초안을 갈아 끼움)" : ""}${removed ? ` · 초안 ${draftFile(id, "experience")} 는 지웠습니다` : ""}`,
      ...(draft.supersedes ? [`대체: ${draft.supersedes} 는 이제 대체됨으로 보입니다.`] : []),
      "선택 기록입니다 — 반영(deliver) 커밋에 작업 폴더와 함께 들어가고, 없어도 어떤 단계도 막지 않습니다.",
      EXPERIENCE_NOTE,
    ].join("\n");
  } finally {
    release();
  }
}

function recordLines(repoRoot: string, records: ExperienceRecord[], all: boolean): string[] {
  const fresh = freshness(repoRoot, records.map((record) => record.current));
  const lines: string[] = [];
  for (const record of records) {
    lines.push(experienceLine({ record, score: 0, why: [] }, fresh.get(record.current)));
    const problems = [...record.current.problems, ...record.current.unverified.map((ref) => `근거 ${ref} 가 이 작업의 통과한 검증과 이어지지 않습니다`)];
    for (const problem of problems) lines.push(`  ! ${problem}`);
    if (all) for (const old of [...record.history].reverse()) lines.push(`  v${old.version} · ${old.path} L${old.line}-L${old.end} (작업 ${old.work})`);
  }
  return lines;
}

/** `experience list [--all]` — 기록의 현재 버전·판정 상태·근거 변경. --all 은 이전 버전도 */
export function experienceList(repoRoot: string, all = false): string {
  const index = experienceIndex(repoRoot);
  if (index.records.length === 0) return "작업 경험 기록이 없습니다 — 기록은 선택입니다(code-agent experience add doc/work/<ID>/experience.draft.json).";
  return [`작업 경험 ${index.records.length}건 (${index.files.length}개 작업)`, "", ...recordLines(repoRoot, index.records, all), "", EXPERIENCE_NOTE].join("\n");
}

/** `experience show <EXP-ID>` — 한 기록의 버전 이력과 근거 대조 */
export function experienceShow(repoRoot: string, id: string): string {
  const record = experienceIndex(repoRoot).records.find((item) => item.id === id);
  if (!record) throw new Stop(`기록이 없습니다: ${id} — code-agent experience list`);
  const fresh = freshness(repoRoot, [record.current]).get(record.current);
  const versions = [...record.history, record.current, ...record.conflicts];
  return [
    `${record.id} · ${experienceStateText(record)} · 현재 v${record.current.version}`,
    ...versions.map((version) => `- v${version.version} · 작업 ${version.work} · ${version.path} L${version.line}-L${version.end} · 선언 ${version.declared}` +
      `${version.evidence.length ? ` · 근거 ${version.evidence.map((ref) => `${ref}${version.verified.includes(ref) ? "(통과)" : "(이어지지 않음)"}`).join(", ")}` : ""}`),
    ...(experienceDriftText(fresh) ? [`근거 변경: ${experienceDriftText(fresh)}`] : []),
    ...record.current.problems.map((problem) => `! ${problem}`),
    "",
    "줄 범위만 읽으세요 — 문서 전문을 열지 않습니다.",
    EXPERIENCE_NOTE,
  ].join("\n");
}

export function experience(repoRoot: string, args: string[]): string {
  const [action, ...rest] = args;
  if (action === undefined) return `${USAGE}\n\n${FORMAT}`;
  if (action === "add" && rest.length === 1) return experienceAdd(repoRoot, rest[0]);
  if (action === "list" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--all"))) return experienceList(repoRoot, rest[0] === "--all");
  if (action === "show" && rest.length === 1) return experienceShow(repoRoot, rest[0]);
  throw new Stop(USAGE);
}
