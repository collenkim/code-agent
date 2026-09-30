import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";

import { SLOTS } from "./protocol";
import type { SecretSpec, Slot } from "./protocol";

/**
 * 등록은 **개인의 것**이고 저장소 밖에 산다 — `~/.code-agent/credentials.json`.
 *
 * 저장소(`code-agent.json`)에는 "어느 자리에 어느 플러그인을 쓰는 프로젝트인가"만 커밋된다.
 * 키가 저장소에 들어가는 순간 되돌릴 수 없고(히스토리에 남는다), 팀원마다 다른 키를 쓸 수도 없다.
 *
 * 위치를 `%APPDATA%`·`XDG_CONFIG_HOME` 으로 가르지 않는 것은 의도다 — 두 플랫폼이 같은 자리를
 * 쓰는 편이 문서·지원이 싸고, 설계(§6)가 적은 경로가 그것이다.
 */
export const STORE_FILE = "credentials.json";

/** 테스트가 실제 사용자 홈을 건드리지 않게 두는 자리. 그 외 용도는 없다 */
const HOME_ENV = "CODE_AGENT_HOME";

export function storeDir(): string {
  const override = process.env[HOME_ENV];
  return override && override.trim() !== "" ? override : join(homedir(), ".code-agent");
}

export function storePath(): string {
  return join(storeDir(), STORE_FILE);
}

/** 화면에 찍는 이름 — 실제 경로에는 사용자 이름이 들어 있다 */
export const STORE_LABEL = "~/.code-agent/credentials.json";

export interface StoredSecret extends SecretSpec {
  /** 한 번 쓰고 다시 출력하지 않는다. 로그에도 들어가지 않는다 */
  value?: string;
}

export interface Consent {
  user: string;
  host: string;
  at: string;
  slots: Slot[];
  sendsCode: boolean;
  /** 동의 화면에서 사람이 그대로 입력한 문구 */
  typed: string;
}

export interface StoredPlugin {
  command: string[];
  slots: Slot[];
  sendsCode: boolean;
  secret?: StoredSecret;
  adapter: { name: string; version: string; describedAt: string };
  consent?: Consent;
  probe: { at: string; ok: boolean; detail?: string };
}

export interface Store {
  version: 1;
  plugins: Record<string, StoredPlugin>;
}

function empty(): Store {
  return { version: 1, plugins: {} };
}

/**
 * 스토어 항목의 모양을 **읽을 때** 본다.
 *
 * JSON 으로 파싱된다고 계약이 맞는 것은 아니다 — 사람이 손으로 고치는 파일이라(문서가 그 자리를
 * 알려 준다) `slots` 가 빠진 항목 하나가 `plugin.slots.includes(...)` 에서 TypeError 로 튀어
 * `context`·`survey`·`review`·`check` 를 통째로 세운다. **플러그인 문제는 명령을 세우지 않는다** 는
 * 규칙이 읽는 자리에서 먼저 지켜져야 한다 — 모양이 어긋난 항목은 던지지 않고 **버린다**(= 등록이 없다).
 */
const STORED_PLUGIN_SCHEMA = z.object({
  command: z.array(z.string().min(1)).min(1),
  slots: z.array(z.enum(SLOTS)),
  sendsCode: z.boolean(),
  secret: z
    .object({
      required: z.boolean(),
      delivery: z.enum(["stdin", "env"]),
      env: z.string().min(1).optional(),
      value: z.string().optional(),
    })
    .optional(),
  adapter: z.object({ name: z.string(), version: z.string(), describedAt: z.string() }),
  consent: z
    .object({
      user: z.string(),
      host: z.string(),
      at: z.string(),
      slots: z.array(z.enum(SLOTS)),
      sendsCode: z.boolean(),
      typed: z.string(),
    })
    .optional(),
  probe: z.object({ at: z.string(), ok: z.boolean(), detail: z.string().optional() }),
});

/** 읽을 수 없는 스토어는 스토어가 아니다 — 막지 않고 빈 것으로 본다(등록이 없는 것과 같다) */
export function readStore(): Store {
  const path = storePath();
  if (!existsSync(path)) {
    return empty();
  }
  let raw: Partial<Store>;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<Store>;
  } catch {
    return empty();
  }
  const plugins: Record<string, StoredPlugin> = {};
  for (const [name, entry] of Object.entries(raw.plugins ?? {})) {
    const parsed = STORED_PLUGIN_SCHEMA.safeParse(entry);
    if (parsed.success) {
      plugins[name] = parsed.data as StoredPlugin;
    }
  }
  return { version: 1, plugins };
}

/**
 * 권한이 넓어도 **막지 않는다** — 막으면 제 키에서 제가 잠긴다. 한 줄 알리고 지나간다.
 * Windows 는 `chmod` 가 읽기 전용 비트만 건드리고 ACL 을 바꾸지 않아 이 검사를 하지 않는다.
 */
export function storeWarning(): string | undefined {
  const path = storePath();
  if (process.platform === "win32" || !existsSync(path)) {
    return undefined;
  }
  // 디렉토리도 함께 본다 — `mkdirSync` 의 mode 는 **만들 때만** 걸리고 umask 가 한 번 더 깎으므로,
  // 이미 0755 로 있던 `~/.code-agent` 는 파일만 봐서는 영영 보이지 않는다.
  const wide: string[] = [];
  const fileMode = statSync(path).mode & 0o777;
  if ((fileMode & 0o077) !== 0) wide.push(`파일 0${fileMode.toString(8)} → chmod 600`);
  const dirMode = statSync(storeDir()).mode & 0o777;
  if ((dirMode & 0o077) !== 0) wide.push(`디렉토리 0${dirMode.toString(8)} → chmod 700`);
  return wide.length === 0 ? undefined : `${STORE_LABEL} 의 권한이 넓습니다 (${wide.join(" · ")}).`;
}

export function writeStore(store: Store): void {
  const dir = storeDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, STORE_FILE);
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  // 이미 있던 파일을 덮어쓰면 writeFileSync 의 mode 가 무시된다 — 쓰고 나서 한 번 더 좁힌다
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows 에서는 의미가 없고 실패할 수도 있다. 권한은 프로필 폴더의 ACL 이 지킨다
  }
}

/** Windows 에서 파일 권한이 지키지 못하는 것을 사실대로 말하는 한 줄 */
export const WINDOWS_ACL_NOTE =
  "Windows 에서는 파일 권한 대신 사용자 프로필 폴더의 기본 ACL 이 이 파일을 지킵니다 — " +
  "다른 계정이 이 PC 를 함께 쓰면 그 사실을 확인하세요.";
