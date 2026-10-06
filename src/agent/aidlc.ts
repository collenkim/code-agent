import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

/**
 * AWS AI-DLC(awslabs/aidlc-workflows)와 같은 저장소에서 쓸 때의 경계.
 *
 * 둘을 **동시에 진행하지 않는다.** 브랜치 담당자는 바뀌지 않는다는 전제라, 같은 브랜치에 진행 중인
 * AI-DLC 의도(intent)가 있으면 — 팀원이 커밋해 둔 것이어도 — code-agent 를 시작하지 않는다.
 * 진행 중은 아니어도 AI-DLC 훅이 추적 감사 파일에 덧붙일 수 있는 상태면 경고만 한다 —
 * 그 기록이 동의 스냅샷·계획 밖 변경 검사를 흔든다.
 *
 * 판정은 AI-DLC 2.8.2~2.10.x 의 의도 해석을 따른다(core/tools/aidlc-lib.ts: intentsDir ·
 * readActiveIntentCursor · activeIntent · isArchivedIntent). AI-DLC 자체 훅·다른 터미널의 실행은 막지 못한다.
 */
interface Intent {
  space: string;
  record: string;
  /** aidlc-state.md 의 `**Status**:` 값 */
  status: string;
  /** intents.json 의 status — in-flight | complete | archived */
  registry?: string;
  path: string;
}

function readStatus(file: string): string {
  try {
    return /\*\*Status\*\*:\s*([^\r\n]+)/.exec(readFileSync(file, "utf8"))?.[1].trim() ?? "";
  } catch {
    return "";
  }
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function listIntents(root: string): Intent[] {
  const found: Intent[] = [];
  const spacesDir = join(root, "aidlc", "spaces");
  let spaces: string[] = [];
  try { spaces = readdirSync(spacesDir); } catch { /* AI-DLC 가 없다 */ }
  for (const space of spaces) {
    const dir = join(spacesDir, space, "intents");
    let registry: { dirName?: string; status?: string }[] = [];
    try {
      const raw: unknown = JSON.parse(readFileSync(join(dir, "intents.json"), "utf8"));
      if (Array.isArray(raw)) registry = raw;
    } catch { /* 레지스트리가 없거나 깨졌으면 상태 파일만 본다 */ }
    let records: string[] = [];
    try { records = readdirSync(dir); } catch { /* 의도 없음 */ }
    for (const record of records) {
      const state = join(dir, record, "aidlc-state.md");
      if (!existsSync(state)) continue;
      found.push({ space, record, status: readStatus(state), registry: registry.find((entry) => entry.dirName === record)?.status,
        path: `aidlc/spaces/${space}/intents/${record}` });
    }
  }
  // 작업 공간 도입 전의 평평한 배치 — AI-DLC 가 다음 실행 때 옮긴다
  const legacy = join(root, "aidlc-docs", "aidlc-state.md");
  if (existsSync(legacy)) found.push({ space: "default", record: "aidlc-docs", status: readStatus(legacy), path: "aidlc-docs" });
  return found;
}

/** 레지스트리가 있으면 그것이 정본이다(완료·보관을 기록한다). 없으면 상태 파일의 Status 를 본다 */
function inFlight(intent: Intent): boolean {
  if (intent.registry) return intent.registry.trim().toLowerCase() === "in-flight";
  return !/^(completed?|archived)\b/i.test(intent.status);
}

function hooksInstalled(root: string): boolean {
  return [".claude/settings.json", ".codex/hooks.json"].some((file) => readText(join(root, file)).includes("record-human-turn"));
}

/** AI-DLC 훅이 기록을 덧붙일 대상 — 사용자별 커서가 가리키는 기록, 없으면 보관되지 않은 기록이 하나뿐일 때 그 기록 */
function resolvedIntent(root: string, intents: Intent[]): Intent | undefined {
  const space = readText(join(root, "aidlc", "active-space")) || "default";
  const inSpace = intents.filter((intent) => intent.space === space);
  const cursor = readText(join(root, "aidlc", "spaces", space, "intents", "active-intent"));
  const named = cursor ? inSpace.find((intent) => intent.record === cursor) : undefined;
  if (named) return named;
  const live = inSpace.filter((intent) => intent.registry?.trim().toLowerCase() !== "archived");
  return live.length === 1 ? live[0] : undefined;
}

/** 진행 중인 AI-DLC 의도가 있으면 막는 사유 */
export function aidlcBlock(root: string): string | undefined {
  const running = listIntents(root).filter(inFlight);
  if (running.length === 0) return undefined;
  return [
    "같은 브랜치에 진행 중인 AWS AI-DLC 작업이 있어 code-agent 를 진행하지 않습니다 — 두 워크플로를 동시에 진행하지 않습니다.",
    ...running.map((intent) => `  - ${intent.path} (${intent.registry ?? intent.status ?? "상태 없음"})`),
    "AI-DLC 작업을 마치고(완료 또는 `/aidlc intent archive <이름>`, 2.9 이상) 그 기록을 커밋한 뒤 다시 실행하세요.",
  ].join("\n");
}

/** 진행 중은 아니지만 AI-DLC 훅이 추적 감사 파일에 기록할 수 있는 상태면 경고 */
export function aidlcWarning(root: string): string | undefined {
  if (!hooksInstalled(root)) return undefined;
  const intents = listIntents(root);
  if (intents.some(inFlight)) return undefined; // 막는 쪽이 이미 알린다
  const target = resolvedIntent(root, intents);
  if (!target) return undefined;
  return `경고: AWS AI-DLC 훅이 설치돼 있고 의도 ${target.path} 가 아직 선택돼 있습니다 — 질문·답변·세션마다 AI-DLC 가 추적되는 감사 파일에 기록해 ` +
    "code-agent 의 동의와 계획 밖 변경 검사가 실패할 수 있습니다. 함께 진행하지 말고, `/aidlc intent archive <이름>`(2.9 이상)이나 " +
    `커서(aidlc/spaces/${target.space}/intents/active-intent) 정리 뒤 진행하세요.`;
}

/** code-agent 작업 중 AI-DLC 실행을 가리키는 셸 명령 — 허용 목록에서 거부되지만 사유를 분명히 알린다 */
export function mentionsAidlc(command: string): boolean {
  return /\.(?:claude|codex)[\\/]tools[\\/]aidlc|(?:^|\s)aidlc(?:\s|$)/i.test(command);
}
