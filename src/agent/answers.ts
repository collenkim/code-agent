/**
 * 업무 질문의 답 관찰(CON-6) — `.code-agent/work/<ID>/answers.jsonl`.
 *
 * Claude 의 AskUserQuestion 중 동의 질문이 아닌 것(업무 질문)을 consent-event hook 이 Pre(질문)·Post(응답)로 기록한다. 게이트는
 * questions.md 의 `[Answer]:` 가 관찰된 응답과 맞는지 본다. 관찰할 수 없는 답(사용자가 대화로 직접 준 답, Codex 에서 받은 모든 답)은
 * `[Answer]:` 다음 줄의 `[Source]: 대화` 로 남겨 통과시키되, 계획 승인·반영 화면에 '관찰 안 됨'으로 이름과 답을 싣는다.
 * Codex 사용자 메시지 원문은 기록하지 않는다.
 *
 * 판정 입력은 questions.md·answers.jsonl·확정 지시서뿐이고 모두 동의 스냅샷 안이다 — 동의를 준비한 뒤 판정이 바뀌면 그 동의는
 * 대상 변경으로 폐기된다. hook 이 읽으므로 consent.ts·request.ts 를 import 하지 않는다.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { dirname, join } from "path";

import { findRepoRoot, loadActive, questionsFile, REQUEST_SESSION_FILE, STATE_DIR } from "./layout";
import { parseQuestions, type Question } from "./questions";

export const ANSWERS_FILE = "answers.jsonl";
export function answersFile(id: string): string { return `${STATE_DIR}/work/${id}/${ANSWERS_FILE}`; }

interface AskItem { q?: string; header: string; questionHash: string; options: string[] }
interface AnswerItem { q?: string; questionHash: string; answer: string; free: boolean; note?: string }
export type AnswerRow =
  | { type: "start"; at: string; version: 1; intake: { q: string; hash: string }[] }
  | { type: "ask"; at: string; host: "claude"; session: string; toolId: string; prefilled: boolean; items: AskItem[] }
  | { type: "answer"; at: string; host: "claude"; session: string; toolId: string; items: AnswerItem[] }
  /**
   * master 가 넣은 답 — actor ai 는 위임 판단, human 은 master 를 거쳐 온 사람의 답(code-agent 가 응답을 관찰하지 않았다). 사람이 TTY 에서 준
   * 권한(grant) 범위에서만 master/delegation.ts 가 쓴다. hash 는 questions.md 에 쓴 답(sha16)이다 — 답을 고치면 출처가 사라진다
   */
  | { type: "delegated"; at: string; q: string; hash: string; actor: "ai" | "human"; decisionId: string; grantId: string; controller: string; generation: number; category: string };

/** consent.ts ConsentHookInput 과 같은 꼴(순환을 피하려고 따로 둔다) */
interface QuestionHookInput {
  cwd?: string; hook_event_name?: string; session_id?: string; tool_use_id?: string; tool_name?: string; agent_id?: string;
  tool_input?: { questions?: unknown; answers?: unknown; metadata?: { source?: string }; [key: string]: unknown };
  tool_response?: unknown;
}

const sha16 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** 질문 도구의 header·question 에서 Q 번호 — 없으면 undefined */
function questionId(header: string, question: string): string | undefined {
  const pattern = /(?:^|[\s[(])Q(\d+)\b/;
  const hit = pattern.exec(header) ?? pattern.exec(question.slice(0, 80));
  return hit ? `Q${hit[1]}` : undefined;
}
/** 답 대조용 정규화 — NFC, 앞뒤 공백, 연속 공백, 끝의 (추천), 감싼 따옴표·백틱 */
export function normalizeAnswer(text: string): string {
  let value = text.normalize("NFC").trim().replace(/\s+/g, " ").replace(/\s*\(추천\)$/, "").trim();
  const quoted = /^(["'`“‘])(.*)(["'`”’])$/.exec(value);
  if (quoted) value = quoted[2].trim();
  return value;
}

/** 진행 중인 작업 또는 접수의 ID — 상태 파일이 깨졌으면 던진다(호출자가 stderr 로 남긴다) */
function currentId(root: string): string | undefined {
  const active = loadActive(root);
  if (active) return active.id;
  const path = join(root, REQUEST_SESSION_FILE);
  if (!existsSync(path)) return undefined;
  const session = JSON.parse(readFileSync(path, "utf8")) as { id?: unknown };
  return typeof session.id === "string" ? session.id : undefined;
}

export function readAnswerRows(root: string, id: string): AnswerRow[] {
  const path = join(root, answersFile(id));
  if (!existsSync(path)) return [];
  const rows: AnswerRow[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as AnswerRow;
      if (row && (row.type === "start" || row.type === "ask" || row.type === "answer" || row.type === "delegated")) rows.push(row);
    } catch { /* 반쯤 쓰인 줄 */ }
  }
  return rows;
}
/** master 가 넣은 답의 기록 — master/delegation.ts 만 부른다 */
export function appendDelegatedAnswer(root: string, id: string, row: Extract<AnswerRow, { type: "delegated" }>): void { appendRow(root, id, row); }
/** 답 해시 — 기록의 hash 와 같은 계산 */
export function answerHash(answer: string): string { return sha16(answer); }
function appendRow(root: string, id: string, row: AnswerRow): void {
  const path = join(root, answersFile(id));
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`);
}

/**
 * Claude AskUserQuestion 중 업무 질문(metadata.source 가 code-agent: 가 아님)을 기록한다. 서브에이전트(agent_id)의 질문,
 * 작업·접수가 없을 때(준비 질문은 게이트 대상이 아니다)는 기록하지 않는다. Post 는 같은 세션·호출·질문의 Pre 가 있고
 * 미리 채운 답이 아닐 때만 기록한다.
 */
export function observeAnswerEvent(input: QuestionHookInput, projectDir?: string): void {
  if (input.tool_name !== "AskUserQuestion") return;
  if (input.hook_event_name !== "PreToolUse" && input.hook_event_name !== "PostToolUse") return;
  const source = input.tool_input?.metadata?.source;
  if (typeof source === "string" && source.startsWith("code-agent:")) return;
  if (input.agent_id !== undefined) return;
  const base = projectDir ?? input.cwd;
  if (typeof base !== "string" || !base) return;
  if (typeof input.session_id !== "string" || !input.session_id || typeof input.tool_use_id !== "string" || !input.tool_use_id) return;
  const root = findRepoRoot(base);
  const id = currentId(root);
  if (!id) return;
  const asked = Array.isArray(input.tool_input?.questions) ? (input.tool_input!.questions as unknown[]).map(record).filter((item): item is Record<string, unknown> => !!item) : [];
  if (!asked.length) return;
  const at = new Date().toISOString();
  const items = asked.map((item) => {
    const question = typeof item.question === "string" ? item.question : "";
    const header = typeof item.header === "string" ? item.header : "";
    const q = questionId(header, question);
    const options = Array.isArray(item.options) ? item.options.map((option) => String(record(option)?.label ?? "")).filter(Boolean) : [];
    return { question, header, q, options, questionHash: sha16(question) };
  });
  if (input.hook_event_name === "PreToolUse") {
    const answers = record(input.tool_input?.answers);
    appendRow(root, id, { type: "ask", at, host: "claude", session: input.session_id, toolId: input.tool_use_id,
      prefilled: !!answers && Object.keys(answers).length > 0,
      items: items.map(({ q, header, questionHash, options }) => ({ ...(q ? { q } : {}), header, questionHash, options })) });
    return;
  }
  const hashes = items.map((item) => item.questionHash);
  const ask = readAnswerRows(root, id).find((row): row is Extract<AnswerRow, { type: "ask" }> => row.type === "ask" && row.session === input.session_id &&
    row.toolId === input.tool_use_id && JSON.stringify(row.items.map((item) => item.questionHash)) === JSON.stringify(hashes));
  if (!ask || ask.prefilled) return;
  const response = record(input.tool_response);
  const answers = record(response?.answers);
  if (!answers) return;
  const annotations = record(response?.annotations);
  const answered: AnswerItem[] = [];
  for (const item of items) {
    const value = answers[item.question];
    if (typeof value !== "string" || !value.trim()) continue;
    const note = record(annotations?.[item.question])?.notes;
    answered.push({ ...(item.q ? { q: item.q } : {}), questionHash: item.questionHash, answer: value, free: !item.options.includes(value),
      ...(typeof note === "string" && note.trim() ? { note: note.trim() } : {}) });
  }
  if (answered.length) appendRow(root, id, { type: "answer", at, host: "claude", session: input.session_id, toolId: input.tool_use_id, items: answered });
}

/** 확정 지시서의 "접수 때 정한 것" 답(`- A:` 값) */
function intakeAnswers(root: string, specPath: string): string[] {
  const path = join(root, specPath);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const section = /^## 접수 때 정한 것\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1] ?? "";
  return [...section.matchAll(/^\s*- A:\s*(.+)$/gm)].map((match) => normalizeAnswer(match[1])).filter(Boolean);
}

/** 답의 후보 — 첫 줄, 첫 줄이 선택지 글자 하나면 그 선택지 문장도 */
function candidates(question: Question): string[] {
  const first = question.answer.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  const values = [normalizeAnswer(first)];
  const letter = /^([A-Z])[.)]?$/.exec(first)?.[1];
  if (letter && question.options?.[letter]) values.push(normalizeAnswer(question.options[letter]));
  return values.filter(Boolean);
}
/**
 * 관찰된 응답이 이 질문의 답인가 — 같은 Q 번호의 응답만 본다. Q 번호 없는 질문 호출(예: "다음으로 넘어갈까요?" → "예")의 응답은
 * 어느 질문에도 맞추지 않는다 — 맞추면 같은 답(예·A)을 가진 다른 질문이 사람이 받은 적 없이 '관찰됨'이 된다(ca-answer 1-5: 질문은 Q 번호로 시작한다).
 */
function observedMatch(question: Question, rows: AnswerRow[]): boolean {
  const wanted = candidates(question);
  return rows.some((row) => row.type === "answer" && row.items.some((item) =>
    item.q === question.id && wanted.includes(normalizeAnswer(item.answer))));
}

/**
 * start 가 부른다 — 시작 행이 이미 있으면 아무것도 하지 않는다. 지금 답이 있는 질문 중 관찰 행과 맞지 않고 답이 확정 지시서의
 * "접수 때 정한 것" 답과 같은 것만 접수 답으로 적는다(요구 확정 화면에 실려 사람이 본 답).
 */
export function writeAnswerBaseline(root: string, id: string, specPath: string): void {
  const rows = readAnswerRows(root, id);
  if (rows.some((row) => row.type === "start")) return;
  const path = join(root, questionsFile(id));
  const answered = existsSync(path) ? parseQuestions(readFileSync(path, "utf8")).filter((question) => question.answer) : [];
  const confirmed = intakeAnswers(root, specPath);
  const intake = answered.filter((question) => !observedMatch(question, rows) && candidates(question).some((value) => confirmed.includes(value)))
    .map((question) => ({ q: question.id, hash: sha16(question.answer) }));
  appendRow(root, id, { type: "start", at: new Date().toISOString(), version: 1, intake });
}

export type AnswerSource = "observed" | "intake" | "delegated" | "relayed" | "conversation" | "legacy" | "unverified";
/** master 가 넣은 답과 지금 답이 같은가 — 같은 Q 번호의 마지막 기록만 본다 */
function delegatedMatch(question: Question, rows: AnswerRow[]): Extract<AnswerRow, { type: "delegated" }> | undefined {
  const row = rows.filter((item): item is Extract<AnswerRow, { type: "delegated" }> => item.type === "delegated" && item.q === question.id).at(-1);
  return row && row.hash === sha16(question.answer) ? row : undefined;
}

/** 답이 있는 질문마다 답의 출처 */
export function answerSources(root: string, id: string, questions: Question[]): Map<string, AnswerSource> {
  const rows = readAnswerRows(root, id);
  const start = rows.find((row): row is Extract<AnswerRow, { type: "start" }> => row.type === "start");
  const sources = new Map<string, AnswerSource>();
  for (const question of questions) {
    if (!question.answer) continue;
    if (!start) sources.set(question.id, "legacy");
    else if (start.intake.some((entry) => entry.q === question.id && entry.hash === sha16(question.answer))) sources.set(question.id, "intake");
    else if (observedMatch(question, rows)) sources.set(question.id, "observed");
    else if (delegatedMatch(question, rows)) sources.set(question.id, delegatedMatch(question, rows)!.actor === "ai" ? "delegated" : "relayed");
    else if (question.source?.startsWith("대화")) sources.set(question.id, "conversation");
    else sources.set(question.id, "unverified");
  }
  return sources;
}

/**
 * 답은 있는데 출처를 확인할 수 없는 질문의 안내 — 답이 없는 질문과 같은 사유로 막혀도 방금 답을 적은 쪽이 이유를 알 수 있게 따로 쓴다.
 * 계획 배정(readyProblems)과 status 의 다음: 이 같은 문장을 쓴다. 호스트 중립 문구다.
 */
export function unverifiedAnswerHint(ids: readonly string[]): string {
  return `답 출처 미확인 ${ids.join(", ")} — 질문 도구 응답이 관찰되지 않은 답입니다. ca-answer 절차로 질문 도구 응답을 받거나, 대화로 받은 답이면 [Answer]: 뒤에 [Source]: 대화 줄을 적습니다`;
}

/** 답이 없는 질문과 답의 출처를 확인할 수 없는 질문. 작업 폴더의 questions.md 가 아니면 출처는 보지 않는다 */
export function openQuestions(root: string, questionsPath: string): { unanswered: Question[]; unverified: Question[] } {
  const path = join(root, questionsPath);
  if (!existsSync(path)) return { unanswered: [], unverified: [] };
  const all = parseQuestions(readFileSync(path, "utf8"));
  const unanswered = all.filter((question) => question.answer === "");
  const id = /^doc\/work\/([^/]+)\/questions\.md$/.exec(questionsPath.replace(/\\/g, "/"))?.[1];
  if (!id) return { unanswered, unverified: [] };
  const sources = answerSources(root, id, all);
  return { unanswered, unverified: all.filter((question) => sources.get(question.id) === "unverified") };
}

/** 사람 확인 화면의 답 출처 절 — 답이 있는 질문이 없으면 undefined */
export function formatAnswerSources(root: string, id: string): string | undefined {
  const path = join(root, questionsFile(id));
  if (!existsSync(path)) return undefined;
  const questions = parseQuestions(readFileSync(path, "utf8"));
  const sources = answerSources(root, id, questions);
  if (sources.size === 0) return undefined;
  const count = (source: AnswerSource) => [...sources.values()].filter((value) => value === source).length;
  if (count("legacy") === sources.size) return `질문 답 출처: 이전 형식(관찰 기록 없음) ${sources.size}`;
  const parts = ([["observed", "질문 도구 관찰"], ["intake", "접수 때 정한 것"], ["delegated", "master 위임 판단(사람 응답 아님)"], ["relayed", "master 경유 사람 답(관찰 안 됨)"], ["conversation", "대화 직접 입력(관찰 안 됨)"],
    ["legacy", "이전 형식(관찰 기록 없음)"], ["unverified", "출처 미확인"]] as const)
    .filter(([source]) => count(source) > 0).map(([source, label]) => `${label} ${count(source)}`);
  const conversation = questions.filter((question) => ["conversation", "delegated", "relayed"].includes(sources.get(question.id) ?? ""));
  const shown = conversation.slice(0, 10).map((question) =>
    `  - ${question.title}: ${JSON.stringify(question.answer.split("\n").map((line) => line.trim()).find(Boolean) ?? "")}`);
  if (conversation.length > 10) shown.push(`  - 외 ${conversation.length - 10}개 (questions.md)`);
  return [`질문 답 출처: ${parts.join(" · ")}`, ...shown].join("\n");
}
