import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, posix } from "path";
import type { z } from "zod";

import { isBatchScript, quoteForCmd, resolveExecutable } from "../../core/build";
import type { Manifest } from "../../core/manifest";
import { planPaths, treeHashNow } from "../evidence";
import type { VerifyRun } from "../evidence";
import { STATE_DIR } from "../layout";
import { changedPaths } from "../tree";
import type { Work } from "../work";
import {
  CAPPED_KEYS,
  DESCRIBE_SCHEMA,
  ENVELOPE_SCHEMA,
  HANDSHAKE_LIMIT,
  LOG_LINES,
  LOG_RESPONSE_BYTES,
  MAX_ITEMS,
  MAX_OUTPUT_ITEMS,
  MAX_TEXT,
  PROBE_SCHEMA,
  PROTOCOL,
  SLOT_LIMITS,
  SLOT_OUTPUT_SCHEMA,
  VERSION,
} from "./protocol";
import type { DescribeOutput, Limit, ProbeOutput, Slot, SlotInput, SlotOutput } from "./protocol";
import { readStore } from "./store";

/**
 * 어댑터를 부르는 **유일한** 자리.
 *
 * 동기(`spawnSync`)다. 필요한 상한 셋(제한 시간 · 응답 크기 · stdin 입력)이 `spawnSync` 의 옵션
 * 그대로이고, `core/build.ts` 가 비동기가 된 이유("gradle 이 몇 분 도는 동안 프로세스가 멈춘다")는
 * 20초로 묶인 조언 호출에는 해당하지 않는다. 비동기로 가면 `context`·`survey`·`openRound`·`hook`
 * 인접 동기 경로가 전부 async 로 물들어 diff 가 몇 배가 된다.
 *
 * **플러그인 실패는 명령을 세우지 않는다.** 어떤 이유로 실패하든 기본 구현으로 떨어지고 알림이
 * 한 줄 는다 — 조언 하나가 파이프라인을 멈추면 그것은 조언이 아니라 의존이다.
 *
 * 제한 시간이 묶는 것은 **어댑터 프로세스 하나**다. 어댑터가 stdout 파이프를 물려준 손자 프로세스를
 * 뒤에 남기면 파이프가 EOF 에 닿지 않아 `spawnSync` 는 타이머가 끝난 뒤에도 기다린다 — 어댑터는
 * 물려받은 파이프 위에 아무것도 백그라운드로 남기지 않아야 한다 (plugins.md §2.5).
 */
export const PLUGIN_LOG_DIR = `${STATE_DIR}/log/plugins`;

/**
 * 어댑터가 준 문자열 하나를 **한 줄로** 묶는다.
 *
 * 자리 출력은 `context`·`review`·`survey` 의 stdout 으로 나가고 모델은 그것을 지시로 읽는다.
 * 줄바꿈을 그대로 두면 어댑터가 준 한 필드가 여러 줄이 되어 그 화면에 무엇이든 쓸 수 있다 —
 * 어댑터 실행 파일은 사람이 골랐지만 그 어댑터가 중계하는 서버까지 고른 것은 아니다.
 */
export function clamp(text: string, max = MAX_TEXT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

export interface SlotResult<T> {
  source: "plugin" | "default";
  /** source 가 plugin 일 때의 등록 이름 */
  name?: string;
  output: T;
  /** 기본 구현으로 떨어진 이유. 아무 일도 없었으면 없다 */
  notice?: string;
}

export type Call<T> = { ok: true; output: T } | { ok: false; error: string };

export interface Secret {
  delivery: "stdin" | "env";
  env?: string;
  value?: string;
}

// ---- 한 왕복 ----

interface Envelope {
  op: "describe" | "probe" | "run";
  repoRoot?: string;
  slot?: Slot;
  input?: Record<string, unknown>;
}

interface Invocation {
  command: string[];
  secret?: Secret;
  sendsCode: boolean;
}

interface Raw {
  requestId: string;
  bytes: number;
  durationMs: number;
  exit: number | null;
  stdout: string;
  /** stderr 의 꼬리 — 실패를 진단하는 자리다 */
  stderrTail: string;
  /** 계약을 보기 전에 이미 실패한 이유 */
  problem?: string;
}

/** 요청에 실어 보내는 목록을 자른다 — 잘랐으면 그 사실을 함께 보낸다 */
function capped(input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };
  let cut = false;
  for (const key of CAPPED_KEYS) {
    const value = out[key];
    if (Array.isArray(value) && value.length > MAX_ITEMS) {
      out[key] = value.slice(0, MAX_ITEMS);
      cut = true;
    }
  }
  return cut ? { ...out, truncated: true } : input;
}

/** stderr 의 마지막 한 줄 — exit≠0 의 이유는 대개 거기 있다 */
function lastLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines[lines.length - 1] ?? "";
}

/** spawn 까지. 계약 검사는 `validate` 가 한다 */
function spawnAdapter(invocation: Invocation, envelope: Envelope, limit: Limit, cwd: string): Raw {
  const requestId = randomUUID();
  const secret = invocation.secret;
  const request: Record<string, unknown> = {
    protocol: PROTOCOL,
    version: VERSION,
    op: envelope.op,
    requestId,
    ...(envelope.repoRoot ? { repoRoot: envelope.repoRoot.replace(/\\/g, "/") } : {}),
    ...(envelope.slot ? { slot: envelope.slot } : {}),
    // 등록 때 합의된 사실을 매 호출 되비친다
    ...(envelope.op === "run" ? { sendsCode: invocation.sendsCode } : {}),
    // 전달 방식 그대로 — stdin 이면 요청에 싣고, env 면 요청에 secret 키 자체가 없다
    ...(secret?.value && secret.delivery === "stdin" ? { secret: secret.value } : {}),
    ...(envelope.input ? { input: capped(envelope.input) } : {}),
  };
  const body = JSON.stringify(request);
  const env: NodeJS.ProcessEnv =
    secret?.value && secret.delivery === "env" && secret.env
      ? { ...process.env, [secret.env]: secret.value }
      : process.env;

  const [name, ...args] = invocation.command;
  // **저장소는 어댑터를 고르지 못한다.** `skipLocal` 로 저장소 루트의 동명 파일을 건너뛰고 PATH 만
  // 본다 — 그러지 않으면 클론한 저장소에 `node.cmd` 하나를 두는 것만으로 등록된 어댑터를 가로채
  // 키(stdin 의 secret · 환경변수)를 받아 갈 수 있다. cwd 는 실행 디렉토리로만 쓴다.
  const file = resolveExecutable(cwd, name, env, { skipLocal: true });
  if (!file) {
    return {
      requestId,
      bytes: body.length,
      durationMs: 0,
      exit: null,
      stdout: "",
      stderrTail: "",
      problem: `실행 파일을 찾을 수 없습니다: ${name}`,
    };
  }

  const started = Date.now();
  const shared = {
    cwd,
    env,
    input: body,
    encoding: "utf-8" as const,
    timeout: limit.timeoutMs,
    maxBuffer: limit.maxBytes,
    windowsHide: true,
  };
  const result = isBatchScript(file)
    ? spawnSync(env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[quoteForCmd(file), ...args.map(quoteForCmd)].join(" ")}"`], {
        ...shared,
        windowsVerbatimArguments: true,
      })
    : spawnSync(file, args, shared);

  const stderr = result.stderr ?? "";
  const base = {
    requestId,
    bytes: body.length,
    durationMs: Date.now() - started,
    exit: result.status,
    stdout: result.stdout ?? "",
    stderrTail: stderr.slice(-LOG_RESPONSE_BYTES),
  };
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  // 상한 초과를 제한 시간보다 **먼저** 본다 — 둘 다 SIGTERM 으로 끝나 signal 만으로는 갈라지지 않는다
  if (code === "ENOBUFS" || base.stdout.length > limit.maxBytes) {
    // 비우지 않고 자른다 — 무엇이 넘쳤는지는 로그에 남아야 어댑터를 고칠 수 있다
    return {
      ...base,
      stdout: base.stdout.slice(0, LOG_RESPONSE_BYTES),
      problem: `응답이 상한 ${Math.round(limit.maxBytes / 1024)} KiB 를 넘었습니다`,
    };
  }
  if (code === "ETIMEDOUT" || (result.error && result.signal !== null)) {
    return { ...base, problem: `제한 시간 ${limit.timeoutMs / 1000}초를 넘겨 중단했습니다` };
  }
  if (result.error) {
    return { ...base, problem: result.error.message };
  }
  if (result.status !== 0) {
    const tail = lastLine(stderr);
    return { ...base, problem: `exit ${result.status}${tail ? ` (${clamp(tail)})` : ""}` };
  }
  return base;
}

function issuesOf(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => clamp(`output.${issue.path.join(".") || "(root)"}: ${issue.message}`))
    .join(" / ");
}

/**
 * 봉투와 자리 스키마를 대조한다. 하나라도 어긋나면 **호출 실패**다.
 * `requestId` 까지 보는 이유는 앞 호출의 응답을 캐시해 되돌려 주는 어댑터를 막기 위해서다.
 */
function validate<T>(raw: Raw, schema: z.ZodType<T>): Call<T> {
  if (raw.problem) {
    return { ok: false, error: raw.problem };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.stdout);
  } catch {
    return { ok: false, error: "응답이 JSON 이 아닙니다" };
  }
  const envelope = ENVELOPE_SCHEMA.safeParse(parsed);
  if (!envelope.success) {
    return { ok: false, error: `응답 봉투가 계약과 다릅니다: ${clamp(envelope.error.issues[0]?.message ?? "")}` };
  }
  if (envelope.data.protocol !== PROTOCOL) {
    return { ok: false, error: `protocol 이 ${clamp(JSON.stringify(envelope.data.protocol))} 입니다 (${PROTOCOL})` };
  }
  if (envelope.data.version !== VERSION) {
    return {
      ok: false,
      error: `version ${clamp(JSON.stringify(envelope.data.version))} 는 이 code-agent 가 아는 버전이 아닙니다 (${JSON.stringify(VERSION)})`,
    };
  }
  if (envelope.data.requestId !== raw.requestId) {
    return { ok: false, error: "requestId 가 요청과 다릅니다" };
  }
  if (!envelope.data.ok) {
    // 어댑터가 준 문장이 알림 한 줄로 화면에 나간다 — 한 줄로 묶어야 알림이 한 줄이다
    return { ok: false, error: `어댑터가 실패를 알렸습니다: ${clamp(envelope.data.error ?? "(사유 없음)")}` };
  }
  const output = schema.safeParse(envelope.data.output);
  return output.success
    ? { ok: true, output: output.data }
    : { ok: false, error: `응답 형식이 계약과 다릅니다: ${issuesOf(output.error)}` };
}

// ---- 로그 ----

/** 로그에 남기는 키 전달 방식. **값은 남기지 않는다** */
function secretNote(secret: Secret | undefined): string {
  if (!secret?.value) {
    return "보내지 않음";
  }
  return secret.delivery === "env" ? `env ${secret.env}` : "stdin";
}

function counted(input: Record<string, unknown>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) counts[key] = value.length;
  }
  return counts;
}

/** 어댑터가 제 stdout·stderr 로 키를 되뱉어도 로그에는 남지 않는다 */
function redact(text: string, secret: Secret | undefined): string {
  const value = secret?.value;
  return value && value.length > 0 ? text.split(value).join("(키)") : text;
}

function logCall(
  repoRoot: string,
  slot: Slot,
  name: string,
  invocation: Invocation,
  input: Record<string, unknown>,
  raw: Raw,
  result: Call<unknown>,
): void {
  // 응답은 그대로 싣되 64 KiB 를 넘으면 잘라 **문자열로** 남긴다 — 잘린 JSON 을 객체인 척 남기면
  // 로그를 읽는 쪽이 깨진 구조를 만난다
  const output = result.ok ? JSON.stringify(result.output) : undefined;
  const [program, ...args] = invocation.command;
  const line = JSON.stringify({
    at: new Date().toISOString(),
    slot,
    plugin: name,
    // argv 전체를 남기지 않는다 — 키를 인자로 받는 어댑터를 등록하면(계약이 말리지만 막지는 못한다)
    // 그 키가 저장소 안 파일에 그대로 눕는다. 어느 어댑터가 돌았는지는 첫 낱말로 충분하다
    command: args.length > 0 ? `${program} (+인자 ${args.length}개)` : program,
    request: {
      requestId: raw.requestId,
      bytes: raw.bytes,
      counts: counted(input),
      sendsCode: invocation.sendsCode,
      // 전달 방식만 남는다 — 키 **값**은 로그에 들어가지 않는다
      secret: secretNote(invocation.secret),
    },
    durationMs: raw.durationMs,
    exit: raw.exit,
    ok: result.ok,
    response:
      output === undefined
        ? null
        : output.length <= LOG_RESPONSE_BYTES
          ? (JSON.parse(output) as unknown)
          : `${output.slice(0, LOG_RESPONSE_BYTES)}…(잘림)`,
    error: result.ok ? null : result.error,
    // 실패했을 때만, 계약에 걸린 **원문**을 함께 남긴다. 이것이 없으면 로그가 화면의 알림 한 줄을
    // 되풀이할 뿐이라, 로그를 보라고 적어 둔 알림이 아무것도 더 주지 못한다
    ...(result.ok
      ? {}
      : {
          rawResponse: redact(raw.stdout, invocation.secret).slice(0, LOG_RESPONSE_BYTES),
          stderr: redact(raw.stderrTail, invocation.secret).slice(-LOG_RESPONSE_BYTES),
        }),
  });
  try {
    mkdirSync(join(repoRoot, PLUGIN_LOG_DIR), { recursive: true });
    const path = join(repoRoot, PLUGIN_LOG_DIR, `${slot}.jsonl`);
    appendFileSync(path, `${line}\n`, "utf-8");
    const lines = readFileSync(path, "utf-8").split("\n").filter((entry) => entry.trim() !== "");
    if (lines.length > LOG_LINES) {
      writeFileSync(path, `${lines.slice(-LOG_LINES).join("\n")}\n`, "utf-8");
    }
  } catch {
    // 로그를 못 써도 판정은 이미 났다 — 여기서 던지면 조언 하나가 명령을 세운다
  }
}

// ---- 자리 해결 ----

/** 이 저장소가 그 자리에 선언한 플러그인 이름. 선언이 없으면 아무 일도 일어나지 않는다 */
function declaredFor(manifest: Manifest | undefined, slot: Slot): string | undefined {
  for (const [name, entry] of Object.entries(manifest?.plugins ?? {})) {
    if (entry.slots.includes(slot)) return name;
  }
  return undefined;
}

/**
 * 자리 하나를 채운다.
 *
 * 순서가 곧 규칙이다 — **저장소가 선언하지 않았으면 개인이 등록해 뒀어도 기본 구현이 돈다.**
 * 등록은 개인 것이고 선언은 팀 것이다. 개인 등록이 팀 저장소의 출력을 조용히 바꾸면 재현이
 * 사람마다 갈린다.
 *
 * `input` 을 **함수로** 받는 이유: 요청을 짓는 값이 싸지 않다(등록된 문서 전부를 절 단위로 파싱하거나,
 * 트리 해시와 `git diff` 를 부른다). 아무도 등록하지 않은 저장소 — 즉 거의 모든 저장소 — 에서
 * 보내지도 않을 요청을 매번 짓는 것은 opt-in 이라는 말과 맞지 않는다.
 */
export function callSlot<S extends Slot>(
  repoRoot: string,
  manifest: Manifest | undefined,
  slot: S,
  input: () => SlotInput[S],
  fallback: () => SlotOutput[S],
): SlotResult<SlotOutput[S]> {
  const name = declaredFor(manifest, slot);
  if (!name) {
    return { source: "default", output: fallback() };
  }
  const plugin = readStore().plugins[name];
  if (!plugin || !plugin.slots.includes(slot)) {
    return {
      source: "default",
      output: fallback(),
      notice:
        `자리 ${slot} 는 code-agent.json 이 ${name} 를 선언했지만 이 PC 에 등록돼 있지 않습니다 — ` +
        `기본 구현으로 돕니다 (code-agent plugin add ${name}).`,
    };
  }

  const invocation: Invocation = { command: plugin.command, secret: plugin.secret, sendsCode: plugin.sendsCode };
  const body = input() as unknown as Record<string, unknown>;
  const raw = spawnAdapter(invocation, { op: "run", repoRoot, slot, input: body }, SLOT_LIMITS[slot], repoRoot);
  const result = validate(raw, SLOT_OUTPUT_SCHEMA[slot]);
  logCall(repoRoot, slot, name, invocation, body, raw, result);
  if (!result.ok) {
    return {
      source: "default",
      output: fallback(),
      notice:
        `플러그인 ${name}(${slot}) 가 실패해 기본 구현으로 돕니다: ${result.error}. ` +
        `자세한 것은 ${posix.join(PLUGIN_LOG_DIR, `${slot}.jsonl`)}`,
    };
  }
  return { source: "plugin", name, output: result.output };
}

/** 출처 줄 — 어느 자리든 같은 모양으로 찍는다 */
export function sourceLines(result: SlotResult<unknown>, fallbackLabel: string): string[] {
  return [
    `- 출처: ${result.source === "plugin" ? `플러그인 ${result.name}` : `기본 구현 (${fallbackLabel})`}`,
    ...(result.notice ? [`- ${result.notice}`] : []),
  ];
}

// ---- 등록이 부르는 악수 ----

export function describeAdapter(cwd: string, command: string[]): Call<DescribeOutput> {
  return validate(spawnAdapter({ command, sendsCode: false }, { op: "describe" }, HANDSHAKE_LIMIT, cwd), DESCRIBE_SCHEMA);
}

/** 어댑터가 준 여러 줄을 ``` 울타리 안에 넣기 전에 — 울타리를 닫고 나오는 길을 막는다 */
function fenced(text: string): string {
  return text.replace(/```/g, "'''").split("\n").slice(-40).join("\n");
}

export function probeAdapter(cwd: string, command: string[], secret: Secret | undefined): Call<ProbeOutput> {
  return validate(
    spawnAdapter({ command, secret, sendsCode: false }, { op: "probe" }, HANDSHAKE_LIMIT, cwd),
    PROBE_SCHEMA,
  );
}

// ---- verify.extra ----

/**
 * `code-agent check` 가 더하는 런. **더하기만 한다** — 기존 런을 지우거나 결과를 바꾸지 않으므로
 * 실패한 빌드를 통과로 만드는 길이 원천적으로 없다.
 *
 * 등록한 사람에게만 엄격해지는 비대칭은 알고 남긴다 — 자기 PC 에 린터를 하나 더 건 것과 같은 성질이다.
 */
export function pluginVerifyRuns(work: Work, round: number): { runs: VerifyRun[]; notice?: string } {
  const { repoRoot, active } = work;
  const result = callSlot(
    repoRoot,
    work.manifest,
    "verify.extra",
    () => ({
      phase: "check",
      baseCommit: active.baseCommit ?? "",
      treeHash: treeHashNow(work),
      planFiles: planPaths(work),
      changed: active.baseCommit
        ? changedPaths(repoRoot, active.baseCommit).map((change) => ({ status: change.status, path: change.path }))
        : [],
    }),
    () => ({ runs: [] }),
  );
  if (result.source !== "plugin") {
    return { runs: [], notice: result.notice };
  }
  const at = new Date().toISOString();
  return {
    // `kind` 는 스키마가 식별자로 묶어 두므로 표 칸에 넣어도 행이 갈라지지 않는다. `tail` 은 자유
    // 문장이라 여기서 울타리를 막는다 — ⑧ 의 실패 로그 블록이 ``` 안에 그대로 넣는 값이다
    runs: result.output.runs.slice(0, MAX_OUTPUT_ITEMS).map((run) => ({
      round,
      phase: "check" as const,
      kind: `plugin:${result.name}:${run.kind}`,
      command: `plugin ${result.name} verify.extra ${run.kind}`,
      outcome: run.outcome,
      status: null,
      tail: fenced(run.detail ?? run.summary),
      at,
    })),
  };
}

/** `plugin list` 가 "지금 무엇이 도는가" 를 찍을 때 쓴다 */
export function slotOwner(manifest: Manifest | undefined, slot: Slot): { declared?: string; registered: boolean } {
  const declared = declaredFor(manifest, slot);
  if (!declared) {
    return { registered: false };
  }
  const plugin = readStore().plugins[declared];
  return { declared, registered: Boolean(plugin && plugin.slots.includes(slot)) };
}
