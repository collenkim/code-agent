import { existsSync, writeFileSync } from "fs";
import { hostname, userInfo } from "os";
import { resolve } from "path";

import { resolveExecutable } from "../../core/build";
import { MANIFEST_FILE, SLOTS } from "../../core/manifest";
import type { Manifest, Slot } from "../../core/manifest";
import { assetBytes, isPackaged } from "../assets";
import { checkCommands, testCommands } from "../evidence";
import { Stop } from "../stop";
import { askOnTerminal, confirmOnTerminal, requireTerminal } from "../tty";
import { loadManifestIfAny } from "../work";
import { SLOT_NOTES, SLOT_SENDS } from "./protocol";
import type { DescribeOutput } from "./protocol";
import { describeAdapter, probeAdapter, slotOwner } from "./run";
import type { Secret } from "./run";
import { readStore, storeWarning, STORE_LABEL, WINDOWS_ACL_NOTE, writeStore } from "./store";
import type { StoredPlugin } from "./store";

/**
 * `code-agent plugin list | add | remove`.
 *
 * `add`·`remove` 는 **사람의 자리**다 — hook 의 모델 허용 목록에 넣지 않고(`plugin list` 만 연다),
 * `requireTerminal` 이 한 번 더 막는다. 모델이 플러그인을 등록할 수 있으면 "어디로 코드가
 * 나가는가" 를 모델이 정하게 된다.
 */

/** 번들에 든 예시 어댑터의 자원 키 — 단일 실행 파일에도 **들어 있다** (빌드가 template/ 전부를 담는다) */
const EXAMPLE_KEY = "template/plugin-example/echo-adapter.js";

/** 어댑터는 `node <경로>` 로 도는 **파일**이라, 바이너리만 있는 PC 는 꺼내 쓸 자리가 필요하다 */
const EXAMPLE_ADAPTER = isPackaged()
  ? `예시 어댑터: 단일 실행 파일 안에 들어 있습니다 — code-agent plugin example [--out <경로>] 로 꺼내세요`
  : `예시 어댑터: <패키지>/${EXAMPLE_KEY} (code-agent plugin example [--out <경로>] 로 꺼낼 수도 있습니다)`;

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const PLUGIN_USAGE =
  '사용법: code-agent plugin list | example [--out <경로>] | add <이름> --command "<argv>" [--slots a,b] [--sends-code] | remove <이름>';

export interface AddOptions {
  name?: string;
  command?: string;
  slots?: string;
  sendsCode: boolean;
}

/** 테스트가 대본을 넣을 수 있게 프롬프트를 밖으로 뺀다 — `hook.ts` 의 `decide`/`runHook` 과 같은 모양 */
export interface Prompts {
  ask(shown: string, prompt: string): string;
  /** 문구가 다르면 던진다 */
  confirm(shown: string, word: string): void;
}

/** 공백 분리 + 따옴표 한 겹 */
function parseArgv(text: string): string[] {
  return (text.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
    (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))
      ? token.slice(1, -1)
      : token,
  );
}

function parseSlots(text: string): Slot[] {
  const asked = text.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  const unknown = asked.filter((entry) => !(SLOTS as readonly string[]).includes(entry));
  if (unknown.length > 0) {
    throw new Stop(`자리 이름이 아닙니다: ${unknown.join(", ")} — 받는 값: ${SLOTS.join(", ")}`);
  }
  return asked as Slot[];
}

// ---- list ----

function manifestOrNothing(repoRoot: string): Manifest | undefined {
  try {
    return loadManifestIfAny(repoRoot);
  } catch {
    // 형식 오류는 `manifest check` 의 자리다 — 상태 조회는 그것 없이도 돌아야 한다
    return undefined;
  }
}

function serving(manifest: Manifest | undefined, slot: Slot): string {
  // 예약된 자리를 **먼저** 본다. 선언·등록이 다 있어도 부르는 지점이 없으므로 `플러그인 jev` 라고
  // 찍으면 표가 돌지 않는 것을 돈다고 말하게 된다 — 아래 `!` 줄보다 이 칸을 사람이 먼저 읽는다
  if (slot === "code.index") {
    return "예약 — 부르는 지점이 없습니다";
  }
  const owner = slotOwner(manifest, slot);
  if (!owner.declared) {
    return "기본 구현";
  }
  return owner.registered ? `플러그인 ${owner.declared}` : `${owner.declared} 선언됨 · 등록 없음 → 기본 구현`;
}

function commandRow(repoRoot: string, label: string, specs: { kind: string; argv?: string[] }[]): string {
  const cells = specs.map((spec) =>
    spec.argv
      ? `${spec.kind}(${spec.argv.join(" ")}) ${resolveExecutable(repoRoot, spec.argv[0]) ? "있음" : "실행 파일 없음"}`
      : `${spec.kind} 선언 없음`,
  );
  return `  - ${label}: ${cells.join(" · ") || "없음"}`;
}

/** 누구나 부른다 (모델도). 상태만 읽는다 — 키는 한 글자도 찍지 않는다 */
export function pluginList(repoRoot: string): string {
  const manifest = manifestOrNothing(repoRoot);
  const store = readStore();
  const rows = SLOTS.map((slot) => {
    const note = SLOT_NOTES[slot];
    const fallback = note.where ? `${note.fallback} (${note.where})` : note.fallback;
    return `| ${slot.padEnd(16)} | ${fallback.padEnd(42)} | ${serving(manifest, slot)} |`;
  });

  const rg = resolveExecutable(repoRoot, "rg");
  const declared = Object.entries(manifest?.plugins ?? {}).filter(([, entry]) => entry.slots.length > 0);
  const registered = Object.entries(store.plugins);
  const warning = storeWarning();

  return [
    `code-agent plugin — ${repoRoot.replace(/\\/g, "/")}`,
    "",
    "| 자리 | 기본 구현 | 지금 채우는 것 |",
    "|---|---|---|",
    ...rows,
    "",
    "감지된 무료 도구:",
    `  - ripgrep: ${rg ? `있음 (${rg.replace(/\\/g, "/")})` : "없음"} — candidates.rank 는 쓰지 않습니다` +
      "(사람마다 순위가 갈리지 않게 내장 스캔으로 고정)",
    ...(manifest
      ? [
          commandRow(repoRoot, "7 정적 분석이 돌릴 명령 (code-agent check)", checkCommands(repoRoot, manifest)),
          commandRow(repoRoot, "8 테스트가 돌릴 명령 (code-agent test)", testCommands(repoRoot, manifest)),
        ]
      : [`  - 매니페스트: ${MANIFEST_FILE} 이 없습니다 — 자리 선언도 검증 명령도 아직 없습니다`]),
    "",
    `이 PC 에 등록된 플러그인 (${STORE_LABEL}):`,
    ...(registered.length > 0
      ? registered.map(([name, plugin]) => `  - ${line(name, plugin)}`)
      : ["  - 없음 — 전부 기본 구현으로 돕니다"]),
    ...(warning ? [`  ! ${warning}`] : []),
    // 예약된 자리는 등록·선언이 되지만 부르는 지점이 없다 — 말해 주지 않으면 돌고 있는 줄 안다
    ...(registered.some(([, plugin]) => plugin.slots.includes("code.index")) ||
    declared.some(([, entry]) => entry.slots.includes("code.index"))
      ? ["  ! code.index 는 예약된 자리입니다 — 등록·선언은 되지만 이 버전에는 부르는 지점이 없습니다."]
      : []),
    "",
    `이 저장소가 선언한 플러그인 (${MANIFEST_FILE}):`,
    ...(declared.length > 0
      ? declared.map(([name, entry]) => `  - ${name} · 자리 ${entry.slots.join(", ")}`)
      : ["  - 없음"]),
    "",
    `등록·제거는 별도 터미널에서 — ${PLUGIN_USAGE}`,
    EXAMPLE_ADAPTER,
  ].join("\n");
}

/**
 * `code-agent plugin example [--out <경로>]` — 번들에 든 예시 어댑터를 파일로 꺼낸다.
 *
 * 어댑터는 `node <경로>` 로 도는 파일이라, 저장소 없이 바이너리만 받은 사람에게는 꺼낼 길이
 * 있어야 한다. 있는 파일은 덮지 않는다 — 고쳐 둔 어댑터를 지울 이유가 없다.
 */
export function pluginExample(out?: string): string {
  const target = resolve(out ?? "echo-adapter.js");
  if (existsSync(target)) {
    throw new Stop(`이미 있는 파일입니다: ${target} — --out 으로 다른 자리를 주세요.`);
  }
  writeFileSync(target, assetBytes(EXAMPLE_KEY));
  return [
    `예시 어댑터를 꺼냈습니다: ${target}`,
    `  code-agent plugin add example --command "node ${target.replace(/\\/g, "/")}"`,
  ].join("\n");
}

/** 등록 한 줄. **키 값도 길이도 찍지 않는다** — 길이는 단서다 */
function line(name: string, plugin: StoredPlugin): string {
  return [
    name,
    `자리 ${plugin.slots.join(", ")}`,
    `코드 외부 전송 ${plugin.sendsCode ? "예" : "아니오"}`,
    plugin.secret?.required ? "키 등록됨" : "키 필요 없음",
    plugin.consent ? `동의 ${plugin.consent.at.slice(0, 10)} ${plugin.consent.user}` : "동의 없음",
    `probe ${plugin.probe.ok ? "ok" : "실패"}`,
  ].join(" · ");
}

// ---- add ----

function requireName(name: string | undefined): string {
  if (!name || !NAME_PATTERN.test(name)) {
    throw new Stop(
      `플러그인 이름은 소문자로 시작하는 32자 이하의 [a-z0-9-] 입니다: ${name ?? "(없음)"}\n` +
        "  로그 파일 이름과 검증 런의 kind 접두사가 되는 값입니다.",
    );
  }
  return name;
}

/** `--slots` 가 describe 가 말하지 않은 자리를 섞었는가 */
function resolveSlots(asked: Slot[] | undefined, described: DescribeOutput): Slot[] {
  if (!asked || asked.length === 0) {
    return described.slots;
  }
  const extra = asked.filter((slot) => !described.slots.includes(slot));
  if (extra.length > 0) {
    throw new Stop(
      `어댑터가 채운다고 말하지 않은 자리입니다: ${extra.join(", ")} — ` +
        `${described.name} 가 말한 자리: ${described.slots.join(", ")}`,
    );
  }
  return asked;
}

const SENDS_CODE_WARNING = (name: string, note?: string): string =>
  [
    `!! ${name} 는 이 저장소의 **코드·요구 항목 텍스트를 이 PC 밖으로 보냅니다.**`,
    ...(note ? [`   어댑터가 밝힌 것: ${note}`] : []),
    "   보내지는 것: 자리마다 다르지만 파일 경로·요구 항목 문장·파일 내용이 포함될 수 있습니다.",
    "   회사·고객 코드를 외부로 보내도 되는지 확인한 뒤에만 등록하세요. 되돌리려면 code-agent plugin remove 입니다.",
  ].join("\n");

/**
 * 순수 로직 — 테스트가 대본 프롬프트를 넣어 부른다.
 *
 * 순서가 곧 규칙이다. **앞이 실패하면 뒤가 돌지 않는다** — describe 가 실패하면 아무것도 저장하지
 * 않고, probe 가 실패하면 **키도 저장하지 않는다**. 반쯤 등록된 플러그인은 등록된 것으로 보이면서
 * 돌지 않아, 실패의 이유를 매 호출 다시 찾게 만든다.
 */
export function registerPlugin(repoRoot: string, options: AddOptions, prompts: Prompts): string {
  const name = requireName(options.name);
  const store = readStore();
  if (store.plugins[name]) {
    throw new Stop(
      `이미 등록돼 있습니다: ${name} — 덮어쓰지 않습니다.\n` +
        `  바꾸려면 먼저 지우세요: code-agent plugin remove ${name}`,
    );
  }
  const command = parseArgv(options.command ?? "");
  if (command.length === 0) {
    throw new Stop(PLUGIN_USAGE);
  }
  const asked = options.slots ? parseSlots(options.slots) : undefined;

  const described = describeAdapter(repoRoot, command);
  if (!described.ok) {
    throw new Stop(
      `어댑터가 describe 에 답하지 않아 등록하지 않았습니다: ${described.error}\n` +
        `  명령: ${command.join(" ")}\n` +
        `  ${EXAMPLE_ADAPTER}`,
    );
  }
  const adapter = described.output;
  const slots = resolveSlots(asked, adapter);
  // 하나만 켜져도 켜진 것이다 — 사람이 몰랐다고 해서 나간 코드가 돌아오지 않는다
  const sendsCode = options.sendsCode || adapter.sendsCode;

  let typed = "";
  if (sendsCode) {
    prompts.confirm(SENDS_CODE_WARNING(name, adapter.note), name);
    typed = name;
  }
  // `sendsCode` 는 **게이트 대상이 스스로 답한 값**이다. `false` 라고 답한 어댑터에도 자리마다
  // 소스 파일 목록·요구 항목 문장·컨벤션 규칙이 그대로 간다. 큰 경고와 이름 입력은 `sendsCode`
  // 에만 두되(어깨에 힘이 실린 문은 하나여야 한다), **누가·언제·어느 자리를 열었는지는 언제나 남긴다**
  // — 기록이 없으면 나중에 "이건 누가 켠 건가" 를 답할 자리가 없다.

  let secret: Secret | undefined;
  if (adapter.secret?.required) {
    const value = prompts.ask(
      [
        `${name} 는 키가 필요합니다 (어댑터가 ${adapter.secret.delivery} 로 받습니다).`,
        `키는 ${STORE_LABEL} 에만 저장되고 저장소에는 들어가지 않습니다.`,
        "**입력하는 동안 화면에 그대로 보입니다** — 뒤에 사람이 없는지 보세요.",
      ].join("\n"),
      "키",
    );
    if (value.trim() === "") {
      throw new Stop("키를 입력하지 않아 등록하지 않았습니다.");
    }
    secret = { delivery: adapter.secret.delivery, env: adapter.secret.env, value: value.trim() };
  }

  const probe = probeAdapter(repoRoot, command, secret);
  if (!probe.ok || !probe.output.ready) {
    throw new Stop(
      `probe 가 통과하지 못해 등록하지 않았습니다 — 키도 저장하지 않았습니다: ` +
        `${probe.ok ? (probe.output.detail ?? "ready: false") : probe.error}`,
    );
  }

  const now = new Date().toISOString();
  const stored: StoredPlugin = {
    command,
    slots,
    sendsCode,
    ...(adapter.secret?.required
      ? { secret: { required: true, delivery: secret!.delivery, ...(secret!.env ? { env: secret!.env } : {}), value: secret!.value } }
      : {}),
    adapter: { name: adapter.name, version: adapter.adapterVersion, describedAt: now },
    consent: { user: userInfo().username, host: hostname(), at: now, slots, sendsCode, typed },
    probe: { at: now, ok: true, ...(probe.output.detail ? { detail: probe.output.detail } : {}) },
  };
  writeStore({ ...store, plugins: { ...store.plugins, [name]: stored } });

  return [
    `${name} 를 등록했습니다 — ${STORE_LABEL}`,
    `  - ${line(name, stored)}`,
    // 자리를 연다는 것은 그 자리의 입력이 어댑터로 간다는 뜻이다 — sendsCode 가 아니어도 그렇다
    `  - 이 자리들이 어댑터로 보내는 것: ${slots.map((slot) => `${slot} → ${SLOT_SENDS[slot]}`).join(" · ")}`,
    `  - ${WINDOWS_ACL_NOTE}`,
    "",
    `${MANIFEST_FILE} 에 "plugins": {"${name}": {"slots": [${slots.map((slot) => `"${slot}"`).join(", ")}]}} 를 넣어야 이 저장소에서 실제로 씁니다.`,
    "  선언하지 않으면 등록해 둬도 기본 구현으로 돕니다 — 등록은 개인 것이고 선언은 팀 것입니다.",
  ].join("\n");
}

/** CLI 진입점 — 사람이 그 자리에 있는지 먼저 보고, 실제 프롬프트를 묶어 넘긴다 */
export function pluginAdd(repoRoot: string, options: AddOptions): string {
  requireTerminal("플러그인 등록");
  return registerPlugin(repoRoot, options, {
    ask: askOnTerminal,
    confirm: (shown, word) => {
      confirmOnTerminal(shown, word);
    },
  });
}

// ---- remove ----

export function pluginRemove(name: string | undefined): string {
  requireTerminal("플러그인 제거");
  const store = readStore();
  if (!name || !store.plugins[name]) {
    throw new Stop(
      `등록돼 있지 않습니다: ${name ?? "(이름 없음)"} — 등록된 것: ${Object.keys(store.plugins).join(", ") || "없음"}`,
    );
  }
  const rest = { ...store.plugins };
  delete rest[name];
  writeStore({ ...store, plugins: rest });
  return [
    `${name} 를 지웠습니다 — 키·동의·probe 기록이 함께 사라졌습니다 (${STORE_LABEL}).`,
    `${MANIFEST_FILE} 의 선언은 건드리지 않았습니다 — 그 자리는 이제 기본 구현으로 돕니다.`,
  ].join("\n");
}
