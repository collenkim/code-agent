import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

import { KINDS } from "./workOrder";
import type { WorkKind } from "./workOrder";

export const MANIFEST_FILE = "code-agent.json";

/**
 * 플러그인이 끼는 자리. 코어가 자리를 정의하고 자리마다 **기본 구현**이 있다 —
 * 플러그인은 그 자리를 대신 채울 뿐이고, 등록하지 않은 사람에게는 기본 구현으로 돈다.
 *
 * 계약(요청·응답 JSON)과 상한은 `src/agent/plugins/protocol.ts` 가 들고 있다. 이름만 여기 있는
 * 것은 매니페스트 스키마가 이 목록으로 값을 검사하기 때문이다 — core 는 agent 를 import 하지 않는다.
 */
export const SLOTS = [
  "survey.classify",
  "candidates.rank",
  "review.prefilter",
  "context.docs",
  "code.index",
  "verify.extra",
] as const;
export type Slot = (typeof SLOTS)[number];

const StageSchema = z.object({
  key: z.string().describe("단계를 가리키는 식별자. 계획의 files[].stage 와 작업 커서가 이 값을 쓴다"),
  title: z.string().describe("이 단계가 만드는 것"),
  template: z.string().describe("같은 디렉토리의 템플릿 문서 파일명"),
  kind: z
    .enum(["code", "doc", "verify", "test"])
    .default("code")
    .describe(
      "이 단계가 만드는 것의 성격. doc은 코드가 아닌 문서(결정 질문지·조사서·컨벤션), " +
        "verify는 build/test 명령을 돌려 그 결과로 고치는 단계, " +
        "test는 테스트 코드 단계 — 테스트가 한 번 돈 뒤에는 hook 이 그 파일들을 얼린다(단언을 지워 통과시키는 길). " +
        "라이프사이클 단계를 코드에 박지 않고 프로젝트가 선언하게 하는 축이다",
    ),
  kinds: z
    .array(z.enum(KINDS))
    .default([])
    .describe(
      "이 단계를 도는 작업 종류. 비면 모든 종류에서 돈다. refactor 는 Entity~Controller 를 " +
        "순차 생성하지 않으므로, 종류마다 도는 단계가 갈리는 자리가 여기다",
    ),
  confirm: z
    .boolean()
    .default(true)
    .describe(
      "**지금은 아무것도 바꾸지 않는다.** 단계 산출물을 사람이 따로 확정하게 하던 시절의 " +
        "선언이고 그 기능은 없어졌다. 승인 시점의 매니페스트 해시에 이미 들어가 있어 남겨 둔다 — " +
        "지우면 그 해시가 달라져 이미 받은 승인이 전부 무효가 된다",
    ),
  expect: z
    .enum(["pass", "fail"])
    .optional()
    .describe(
      "**지금은 아무것도 강제하지 않는다.** 검증 단계의 기대 결과(fail 은 재현)를 적던 선언이고, " +
        "재현 판정은 code-agent repro 와 07-test-spec.md 의 `## 재현` 이 맡는다. " +
        "매니페스트 해시에 들어가 있어 남겨 둔다 — 지우면 이미 받은 승인이 무효가 된다",
    ),
  base: z
    .string()
    .optional()
    .describe(
      "이 단계의 도메인 디렉토리 루트. 생략하면 domainBase. 테스트처럼 같은 패키지 구조를 " +
        "다른 루트 아래에 미러링하는 단계에 쓴다 (예: src/test/java/...)",
    ),
  exemplars: z
    .array(z.string())
    .default([])
    .describe("참조 도메인 디렉토리 기준 상대경로. {Ref}는 참조 도메인 PascalCase로 치환. /로 끝나면 디렉토리 전체"),
  scope: z
    .enum(["domain", "project"])
    .default("domain")
    .describe(
      "domain이면 outputDirs를 도메인 디렉토리 기준으로, project면 저장소 루트 기준으로 본다. " +
        "빌드 파일·공통 모듈처럼 도메인 밖에 놓이는 산출물은 project",
    ),
  outputDirs: z
    .array(z.string())
    .default([])
    .describe(
      "산출물이 놓일 수 있는 위치. scope=domain이면 도메인 하위 디렉토리('.'은 도메인 바로 아래), " +
        "scope=project면 저장소 루트 기준 경로 접두사. 비면 위치를 제한하지 않는다",
    ),
}).superRefine((stage, ctx) => {
  // 명령을 돌릴 수 없는 단계에 기대 결과를 걸면 그 단계는 영원히 끝나지 않는다.
  if (stage.expect && stage.kind !== "verify") {
    ctx.addIssue({
      code: "custom",
      path: ["expect"],
      message:
        `expect 는 kind 가 verify 인 단계에만 걸 수 있습니다 (${stage.key} 의 kind: ${stage.kind}). ` +
        "명령을 돌릴 수 없는 단계에 걸면 끝낼 방법이 없습니다.",
    });
  }
});

/**
 * 작업 지시서의 **확장** 속성. 예약 속성(kind·id·title·target·scope·preserve·approver)은
 * 파이프라인이 분기에 쓰므로 에이전트가 들고 있고, 회사·프로젝트마다 다른 것만 여기 온다.
 * 에이전트는 존재와 값 유효성만 볼 뿐 이 값들로 분기하지 않는다.
 */
const WorkOrderAttributeSchema = z.object({
  name: z.string().describe("머리말에 쓸 속성 이름"),
  required: z.boolean().default(false),
  values: z.array(z.string()).optional().describe("허용 값. 생략하면 아무 문자열이나 받는다"),
});

/**
 * 빈 배열을 거부할 때의 문구. zod 의 기본값(`Too small: expected array to have >=1 items`)은 영문이고
 * **무엇을 하라는 말이 없다** — hook 이 이 오류로 모든 도구 호출을 막으므로(`runHook` 은 닫히며 실패한다)
 * 메시지가 그대로 고치는 법이어야 한다.
 */
const EMPTY_ARGV = "빈 배열은 선언하지 않은 것과 같습니다 — 키를 지우거나 실제 명령을 적으세요";

const ManifestSchema = z.object({
  language: z
    .string()
    .optional()
    .describe("주 언어. 프롬프트 문구와 코드블록 표기에만 쓴다 (예: java, typescript, python)"),
  sourceExtensions: z
    .array(z.string())
    .default([])
    .describe("참조 표준으로 읽을 파일 확장자. 비면 디렉토리의 모든 파일을 읽는다"),
  domainBase: z.string().describe("도메인 디렉토리들이 놓이는 저장소 기준 경로"),
  domainRoots: z
    .array(z.string())
    .default([""])
    .describe("domainBase 아래의 도메인 분류 디렉토리. 분류가 없으면 생략"),
  conventions: z
    .array(z.string())
    .default([])
    .describe("컨벤션 문서 경로(파일 또는 디렉토리), 저장소 기준"),
  referenceDomain: z.string().optional().describe("기본 참조 표준 도메인"),
  docs: z
    .object({
      architecture: z
        .string()
        .optional()
        .describe("아키텍처(뼈대 구조) 문서 경로, 저장소 기준. 컨벤션 문서는 conventions 가 맡는다"),
      testStrategy: z.string().optional().describe("테스트 전략 문서 경로. 기본 doc/test-strategy.md"),
      quality: z.string().optional().describe("품질·보안 기준 문서 경로. 기본 doc/quality.md"),
      knowledge: z
        .object({
          dataDictionary: z.string().optional(),
          apiCatalog: z.string().optional(),
          businessRules: z.string().optional(),
        })
        .optional()
        .describe(
          "공통 KNOWLEDGE 문서의 위치. 게이트는 파일 존재뿐이고 승인 해시에도 넣지 않는다 — " +
            "넣으면 다른 작업의 반영마다 남의 승인이 stale 이 되어 병렬 작업이 막힌다",
        ),
    })
    .default({})
    .describe("프로젝트 필수 문서(POLICY 4종)의 위치. 넷이 확정되지 않으면 어떤 작업도 시작되지 않는다"),
  git: z
    .object({
      base: z
        .string()
        .default("master")
        .describe("작업 브랜치(<종류>/<ID>)를 딸 기준 브랜치. 작업마다 start --base 로 바꿀 수 있다"),
    })
    .default({ base: "master" }),
  // build·test·commands 의 빈 배열은 prepare 와 **같은 이유로** 형식 오류다. 두 독자가 어긋나기
  // 때문이다: 증거를 묶는 쪽(evidence.argvOf)은 빈 배열을 "선언 없음"(not-run · skipped)으로 보는데,
  // 문서 확정 게이트(docs.commandProblems)는 `manifest.build ? …` 라서 있는 것으로 본다. 그래서
  // 테스트 전략에 `test` 를 적으면 확정을 통과하고, `code-agent test` 는 아무것도 돌리지 않은 결과
  // 위에 "돌렸다" 를 세운다. 한 규칙을 세 자리에 다르게 두지 않고 **로드되지 않게** 막는다.
  // 유효한 매니페스트의 파싱 결과는 한 글자도 달라지지 않아 hashManifest 는 중립이다.
  build: z
    .array(z.string())
    .min(1, EMPTY_ARGV)
    .optional()
    .describe("컴파일 검증 명령. 첫 원소가 저장소 안의 실행 파일이면 그 경로로 실행한다"),
  test: z
    .array(z.string())
    .min(1, EMPTY_ARGV)
    .optional()
    .describe("테스트 실행 명령. 실패는 자동 수정 대상이 아니라 보고 대상이다"),
  prepare: z
    .array(z.string())
    // 빈 배열은 형식 오류다 — 선언은 hashManifest 를 바꾸고 manifest check 에도 실려 "준비가 돈다" 로
    // 읽히는데 integrate 는 조용히 건너뛴다. commands.build/test/prepare 에 건 superRefine 과 같은 이유다.
    .min(1, EMPTY_ARGV)
    .optional()
    .describe(
      "통합 검증의 깨끗한 worktree 에서 build·test **앞에** 한 번 도는 준비 명령 (예: [\"npm\",\"ci\"]). " +
        "기준 커밋을 뜬 트리에는 의존성처럼 커밋되지 않는 것이 없어서 두는 자리다. 실패하면 build·test 를 " +
        "돌리지 않고 통합 검증 전체가 실패한다 — 준비되지 않은 트리 위의 통과는 증거가 아니다. " +
        "check·test 스테이지에서는 돌지 않는다 (거기는 사람이 보고 있는 작업 트리다)",
    ),
  commands: z
    .record(z.string(), z.array(z.string()).min(1, EMPTY_ARGV))
    .default({})
    .describe(
      "검증(P5)이 build·test 말고 이름으로 돌릴 수 있는 추가 명령. 두 리터럴만으로는 " +
        "마이그레이션이나 테스트 필터(gradlew test --tests X)를 돌릴 자리가 없다. 이름은 build·test 를 " +
        "덮어쓸 수 없다 — 그 둘은 최상위 선언이 이미 쓰고 있는 이름이다",
    ),
  environmentErrors: z
    .array(z.string().min(6, "환경 오류 패턴은 6자 이상의 구체적인 문구로 적습니다 — 'Error' 같은 말은 모든 실패를 환경 탓으로 돌립니다"))
    .max(50)
    .optional()
    .describe(
      "코드가 아니라 실행 환경 탓인 실패의 출력 문구(대소문자까지 그대로 포함 여부로 대조). 예: " +
        "\"Could not find a valid Docker environment\", \"Connection refused: localhost:5432\". 실패한 명령의 출력·" +
        "새 테스트 보고서에 하나라도 들어 있으면 그 실행은 코드 결함(failed)이 아닌 환경 오류(error)다 — 수정이 아니라 " +
        "진단으로 가고, 코드를 그대로 둔 재실행은 고쳐 쓰기 회차를 쓰지 않으며, fix 의 재현으로도 인정하지 않는다. " +
        "무엇을 실패로 볼지를 바꾸므로 선언하면 hashManifest 에 들어간다",
    ),
  commandTimeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(240)
    .default(10)
    .describe(
      "검증 명령(build·test·prepare·commands) 한 번의 제한 시간(분). 넘으면 프로세스 트리째 끝내고 실패가 아닌 " +
        "실행 오류로 남긴다. hashManifest 에는 넣지 않는다: 무엇을 돌리는지가 아니라 얼마나 기다리는지다",
    ),
  fixRounds: z
    .number()
    .int()
    .min(1)
    .default(2)
    .describe(
      "검증 실패 뒤 계획 안에서 고쳐 쓸 수 있는 최대 회차. 넘으면 hook 이 계획 파일 쓰기를 전부 " +
        "거부하고 작업 폴더(보고·질문)만 남는다 — 덮지 않고 보고한다를 선언이 아니라 강제로 만드는 자리다. " +
        "hashManifest 에는 넣지 않는다: 경계도 검증 선언도 아니라 재승인을 부를 이유가 없다",
    ),
  workOrder: z
    .object({
      attributes: z.array(WorkOrderAttributeSchema).default([]),
      requireApprover: z
        .boolean()
        .default(false)
        .describe(
          "승인자를 필수로 볼지. 승인자 개념이 없는 조직에 필수로 걸면 아무 작업도 시작되지 않아 " +
            "예약 속성 중 이것만은 필수 여부를 프로젝트가 정한다",
        ),
      requireVerifiedApproval: z
        .boolean()
        .default(false)
        .describe(
          "사람 존재가 관측된 판정만 게이트를 열게 할지. 켜면 터미널에서 확인 문구를 입력한 " +
            "승인만 유효해지고, 비대화형 셸의 승인은 기록으로만 남는다 — " +
            "그 자리를 잃는 대가를 알고 켜는 선언이다",
        ),
    })
    .default({ attributes: [], requireApprover: false, requireVerifiedApproval: false })
    .describe("작업 지시서의 프로젝트 확장 속성 정책"),
  plugins: z
    .record(z.string(), z.object({ slots: z.array(z.enum(SLOTS)).default([]) }))
    .default({})
    .describe(
      "이 프로젝트가 어느 자리에 어느 플러그인을 쓰는가. **키는 여기 없다** — 키는 사람마다 " +
        "~/.code-agent/credentials.json 에만 있고, 등록하지 않은 사람에게는 기본 구현으로 돈다. " +
        "hashManifest 에 넣지 않는다: 경계도 검증 선언도 아니고, 플러그인은 런을 더하기만 하므로 " +
        "승인이 본 경계를 넓히지 못한다",
    ),
  stages: z.array(StageSchema).min(1),
}).superRefine((manifest, ctx) => {
  // 두 플러그인이 같은 자리를 선언하면 무엇이 도는지 정해지지 않는다 — 형식 오류다
  const owners = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(manifest.plugins)) {
    for (const slot of entry.slots) {
      owners.set(slot, [...(owners.get(slot) ?? []), name]);
    }
  }
  for (const [slot, names] of owners) {
    if (names.length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["plugins"],
        message: `자리 ${slot} 를 두 플러그인이 선언했습니다: ${names.join(", ")} — 한 자리에는 하나만 적습니다.`,
      });
    }
  }
  // 주석은 "덮어쓸 수 없다"고 말하는데 검사가 없었다. 그래서 commands.build 를 선언하면
  // 조용히 무시되고, 선언한 사람은 그것이 도는 줄 안다 — 검증 명령에서 그 착각은 비싸다.
  for (const reserved of ["build", "test", "prepare"] as const) {
    if (reserved in manifest.commands) {
      ctx.addIssue({
        code: "custom",
        path: ["commands", reserved],
        message:
          reserved + " 은 commands 에 선언할 수 없습니다 — 최상위 " + reserved + " 가 이미 그 이름입니다. " +
          "여기 적으면 조용히 무시됩니다. 다른 이름을 쓰거나 최상위 " + reserved + " 를 고치세요.",
      });
    }
  }
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type StageDef = z.infer<typeof StageSchema>;

/**
 * 프로젝트 설정을 읽는다.
 *
 * 패키지 경로·계층 이름·빌드 명령·단계 구성은 프로젝트마다 다르므로 에이전트가 알고 있지 않고,
 * 대상 프로젝트가 템플릿 디렉토리에 선언한 것을 그대로 쓴다. 에이전트에 특정 프로젝트의 상수가
 * 박히는 순간 다른 프로젝트에 못 쓰게 된다.
 */
export function loadManifest(templatesDir: string): Manifest {
  const path = join(templatesDir, MANIFEST_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `${MANIFEST_FILE} 을 찾을 수 없습니다: ${templatesDir}\n` +
        "템플릿 디렉토리에 프로젝트 설정(도메인 경로·계층·단계)을 선언해야 합니다.",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`${MANIFEST_FILE} 파싱 실패: ${err instanceof Error ? err.message : err}`);
  }

  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`${MANIFEST_FILE} 형식 오류:\n${issues}`);
  }
  return parsed.data;
}

/**
 * 그 종류가 도는 단계만.
 *
 * 하나도 없으면 조용히 끝난 것처럼 보이는 대신 거절한다 — 아무 단계도 돌지 않은 실행을
 * "다 됐다"로 읽으면, 하지 않은 일을 한 것으로 알리게 된다.
 */
export function stagesFor(manifest: Manifest, kind: WorkKind): StageDef[] {
  const stages = manifest.stages.filter(
    (stage) => stage.kinds.length === 0 || stage.kinds.includes(kind),
  );
  if (stages.length === 0) {
    // 무엇이 막혔는지가 아니라 **무엇을 고치면 풀리는지**를 적는다 — 단계마다 지금 선언된 kinds 를 함께 찍어
    // 매니페스트를 열어 보지 않고도 어디에 "fix" 를 더할지 보이게 한다.
    throw new Error(
      `이 프로젝트에는 ${kind} 로 돌 단계가 선언돼 있지 않습니다.\n` +
        `  ${MANIFEST_FILE} 의 stages[].kinds 에 "${kind}" 를 더하세요 — kinds 를 비우면 모든 종류에서 돕니다.\n` +
        `  지금 선언된 단계: ${manifest.stages
          .map((stage) => `${stage.key}(${stage.kinds.length === 0 ? "모든 종류" : stage.kinds.join(", ")})`)
          .join(", ")}\n` +
        "  확인: code-agent manifest check",
    );
  }
  return stages;
}
