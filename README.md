# code-agent

스펙 기반 소스 코드 생성 AI-Agent. `review-agent`와 짝을 이루는 반대편 — review-agent가 diff를 읽고 지적한다면, code-agent는 스펙을 읽고 코드를 만든다.

**API 없이 쓸 수 있다.** 프롬프트를 뽑아 LLM 채팅창에 붙여넣고, 응답을 되돌려 넣는 수동 모드가 기본 사용법이다. API 키가 있으면 같은 파이프라인을 자동으로 돌릴 수도 있다.

---

## 목차

- [에이전트는 프로젝트를 모른다](#에이전트는-프로젝트를-모른다)
- [세 가지 모드](#세-가지-모드)
- [코드 생성에 필요한 문서](#코드-생성에-필요한-문서)
- [수동 모드 — API 미사용](#수동-모드--api-미사용)
- [프로젝트 설정 `code-agent.json`](#프로젝트-설정--code-agentjson)
- [단계 템플릿](#단계-템플릿)
- [자동 모드 — API 사용](#자동-모드--api-사용)
- [옵션](#옵션)
- [설계 원칙](#설계-원칙)
- [아직 안 되는 것](#아직-안-되는-것)

---

## 에이전트는 프로젝트를 모른다

프로젝트마다 언어·라이브러리·패키지 구조·계층 이름·빌드 명령·코드 컨벤션이 전부 다르다. 그래서 이 에이전트에는 특정 프로젝트의 지식이 하나도 들어 있지 않다.

| 프로젝트마다 다른 것 | 어디서 오는가 |
|---|---|
| 코드 컨벤션 | 대상 저장소의 문서 (`conventions`) |
| 도메인 디렉토리 위치·분류 | `domainBase` / `domainRoots` |
| 계층 이름과 단계 구성 | `stages` |
| 참조할 표준 파일 | `stages[].exemplars` |
| 언어·확장자 | `language` / `sourceExtensions` |
| 빌드·테스트 명령 | `build` / `test` |
| 단계별 규칙·체크리스트 | 템플릿 문서 (`stages[].template`) |

전부 **대상 저장소가 선언**한다. 에이전트가 하는 일은 그 선언대로 파이프라인을 도는 것뿐이다.

### 설계의 축 — 참조 표준(exemplar)이 문서보다 강하다

컨벤션 문서를 프롬프트에 통째로 넣어도 **발명**은 막지 못한다. "파사드는 트랜잭션 경계다"라는 문장보다 "이 프로젝트의 `DealFacade.java`가 실제로 이렇게 생겼다"가 훨씬 강하게 작동한다.

> **참조할 파일은 모델이 아니라 코드가 결정론적으로 고른다.**

계층과 도메인이 정해지면 읽을 파일 경로는 이미 정해져 있다. 탐색을 모델에게 맡기면 실행마다 참조가 달라져 결과가 흔들리므로, `src/core/exemplar.ts`가 매니페스트의 `exemplars` 패턴대로 경로를 계산해 읽어 넣는다.

부수 효과로 **문서와 코드가 어긋난 지점이 드러난다.** 계획 단계가 이를 `conflicts`로 뽑아 주며, 조용히 한쪽을 고르지 않고 기본 판단(참조 표준을 따름)과 그 이유를 함께 남긴다.

---

## 세 가지 모드

모드를 가르는 기준은 하나다. **복제할 코드가 있느냐.**

| 모드 | 언제 | 근거 | 산출물 |
|---|---|---|---|
| **bootstrap** | 신규 프로젝트를 처음 만들 때 | 사람의 결정 + 공식 스캐폴더 출력 | 빌드 파일 · 공통 모듈 · `code-agent.json` · 컨벤션 문서 |
| **adopt** | 레거시 프로젝트에 도입할 때 | **이미 있는 코드** | `code-agent.json` · 컨벤션 문서 |
| **develop** | 도메인을 추가할 때 | 같은 저장소의 참조 도메인 | Entity ~ Controller ~ 테스트 |

```
신규:    bootstrap  →  seed(첫 도메인)  →  develop  →  develop  …
레거시:  adopt      →  develop  →  develop  …
```

`bootstrap`과 `adopt`의 진짜 산출물은 코드가 아니라 **근거 그 자체** — `code-agent.json`과 컨벤션 문서다. 그 둘이 생기면 이후는 `develop` 하나로 돈다.

`starter/bootstrap`, `starter/adopt`에 각 모드의 매니페스트와 템플릿이 들어 있다. 여기 선언된 것은 **절차**이며 프로젝트 지식이 아니다 — 언어·계층 같은 값은 전부 문서에서 온다.

### 시점 0에는 참조 표준이 없다

신규 프로젝트에는 복제할 코드가 없다. 다른 프로젝트를 가져다 쓸 수도 없다 — 아키텍처도 언어도 다를 수 있기 때문이다. 그 자리를 두 가지가 메운다.

**① 공식 스캐폴더의 출력** — 빌드 파일·엔트리포인트·디렉토리 레이아웃은 모델이 쓰지 않는다. 기억으로 쓰면 플러그인 버전과 의존성 좌표를 환각한다. `spring init` · `gradle init` · `cargo new` · `dotnet new` · `npm create` 같은 생태계 도구를 사람이 실행하고, **그 출력이 시점 0의 참조 표준이 된다.**

**② 사람이 내린 결정** — 계층 구조·식별자 전략·soft delete·멀티테넌시·예외 체계는 어떤 스캐폴더도 만들어 주지 않는다. 요구사항이 아니라 **결정**이다. 에이전트는 **무엇을 정해야 하는지 목록만 뽑고**, 고르지 않는다.

---

## 코드 생성에 필요한 문서

문서가 곧 근거다. 없는 문서는 곧 "모델이 지어내는 자리"가 되므로, 무엇이 필요한지 먼저 맞춰 둔다.

### 모드별 필요 문서

| 문서 | bootstrap | adopt | develop | 어떻게 넘기나 |
|---|:---:|:---:|:---:|---|
| **프로젝트 개요** | 필수 | — | — | `--spec` |
| **아키텍처 결정서** | 필수 | — | — | `--spec` |
| **요구사항·워크플로우** | — | — | 필수 | `--spec` |
| **데이터 정의**(스키마·필드) | — | — | 필수 | `--spec` |
| **화면·API 정의** | — | — | 권장 | `--spec` |
| **코드 컨벤션** | 산출물 | 산출물 | 필수 | `conventions` |
| **단계 템플릿** | starter 제공 | starter 제공 | 필수 | `--templates` |
| **생성 범위 정책** | 선택 | 선택 | 선택 | `--policy` |

### 각 문서에 무엇이 들어가야 하나

<details open>
<summary><b>프로젝트 개요</b> — bootstrap 입력</summary>

- 무엇을 만드는지, 누가 쓰는지
- 주요 도메인 목록 (이름만이라도)
- 이미 정해진 제약 (사내 표준, 운영 환경, 기존 시스템 연동 등)

</details>

<details open>
<summary><b>아키텍처 결정서</b> — bootstrap 입력 · 최소 6항목</summary>

| # | 항목 | 예 |
|---|---|---|
| 1 | 언어 · 런타임 버전 | Java 17 / Node 22 / Python 3.12 |
| 2 | 프레임워크 · 주요 라이브러리 | Spring Boot 3.x + JPA |
| 3 | 빌드 도구와 **스캐폴딩 명령** | `spring init --dependencies=web,data-jpa` |
| 4 | 패키지/모듈 루트와 도메인 분류 | `com.acme.app` · `application` / `admin` |
| 5 | **아키텍처 계층** | 이름 · 책임 · 의존 방향 · **트랜잭션 경계** |
| 6 | **공통 규약** | 식별자 전략 · soft delete · 멀티테넌시 · 감사 필드 · 예외 체계 |

없으면 `bootstrap`의 첫 단계가 **질문지를 만들어 준다.** 그걸 채운 것이 이 문서가 된다.

</details>

<details open>
<summary><b>요구사항·워크플로우</b> — develop 입력 · 최소 4항목</summary>

아래가 **특정 가능해야** 생성이 시작된다. 유추로 채워야 하면 계획 단계가 미결 질문으로 남기고 멈춘다.

- 도메인 이름(영문/한글)
- 어느 분류에 속하는지 (`domainRoots` 중 하나)
- 저장할 데이터 항목 — 최소한 이름과 의미
- 타 도메인과의 관계 — 어느 도메인, 어느 방향, 카디널리티

있으면 품질이 크게 갈리는 것:

- **상태값과 허용 전이** — 없으면 상태 전이 검사를 못 만든다
- **유스케이스 목록** — 유스케이스당 처리 단위가 하나씩 생긴다
- **제약·검증과 그때의 에러** — 예외 분기가 여기서 나온다

</details>

<details open>
<summary><b>데이터 정의</b> — develop 입력</summary>

필드명 · 타입 · 필수 여부 · 길이/정밀도 · 제약. DDL(`.sql`)을 그대로 넘겨도 된다.

**적지 않아도 되는 것**: PK, 테넌트 식별자, 삭제 표시, 감사 필드, 패키지 경로, 클래스 이름 규칙, 어노테이션. 전부 참조 표준에서 복제된다. 적으면 오히려 충돌 소지가 생긴다.

</details>

<details>
<summary><b>화면·API 정의</b> — develop 입력(권장)</summary>

화면 맵 · 상태별 UI 규칙 · API 목록(메서드·URI·요청·응답) · 권한.

</details>

<details>
<summary><b>코드 컨벤션</b> — develop 필수 / bootstrap·adopt 산출물</summary>

디렉토리를 주면 그 안의 `.md`를 전부 읽는다. 규칙이 여러 장으로 나뉘어 있는 게 보통이기 때문이다.

**대상 저장소의 문서를 쓴다.** 다른 저장소나 개인 작업본을 근거로 삼으면 실재하지 않는 규칙이 생긴다.

</details>

### 예 — 기존 문서를 그대로 넘기기

```bash
code-agent --repo /path/to/project --templates doc/templates \
  --spec 19-contract-정의-및-워크플로우.md \   # 요구사항·워크플로우·상태 전이
  --spec 20-contract-schema.sql \              # 데이터 정의
  --spec 25-contract-화면-정의.md \            # 화면·API
  --step plan --emit-prompt
```

`--spec`은 반복 가능하고, 합쳐져 **모든 단계 프롬프트에** 들어간다.

---

## 수동 모드 — API 미사용

프롬프트를 뽑아 LLM 채팅창에 붙여넣고, 응답을 파일로 저장해 되돌려 넣는다. **API 키가 필요 없다.**

```
① --emit-prompt  →  프롬프트 출력  →  복사  →  LLM에 붙여넣기
②                                    응답 복사  →  answer.txt 로 저장
③ --ingest       →  파일 생성 + 코드 검사  →  다음 단계 반복
```

### 흐름

```bash
COMMON="--repo /path/to/project --templates doc/templates --out ./out"

# 1. 계획 — 무엇을 어떤 규칙으로 만들지
code-agent $COMMON --spec 요구사항.md --step plan --emit-prompt > prompt.txt
#   → prompt.txt 를 LLM에 붙여넣고, 응답을 answer.txt 로 저장
code-agent $COMMON --step plan --ingest answer.txt
#   → out/.plan.json 저장 + 계획 출력 (미결 질문·문서충돌 확인)

# 2. 단계별 생성 — 매니페스트에 선언된 순서대로
code-agent $COMMON --spec 요구사항.md --step entity --emit-prompt > prompt.txt
code-agent $COMMON --step entity --ingest answer.txt
#   → out/ 에 파일 생성 + 경로·계획 검사

code-agent $COMMON --spec 요구사항.md --step repository --emit-prompt > prompt.txt
code-agent $COMMON --step repository --ingest answer.txt
# … 선언된 단계 수만큼 반복

# 3. (선택) 검수도 수동으로
code-agent $COMMON --step gate:entity --emit-prompt > prompt.txt
code-agent $COMMON --step gate:entity --ingest answer.txt
```

`--ingest`에는 `--spec`이 필요 없다 — 응답만 읽어 반영하기 때문이다.

### 이어짐이 어떻게 유지되나

- 계획은 `out/.plan.json`에 저장된다. 단계마다 프로세스가 끝나므로 디스크에 남아야 이어진다.
- 앞 단계 산출물은 `out/`에서 **다시 읽어** 다음 단계 프롬프트에 들어간다. 사람이 `out/` 안의 파일을 손봤다면 그 손본 내용이 반영된다 — 수동 모드에서는 그게 맞는 동작이다.

### 코드가 하는 검사는 API 없이 그대로 돈다

`--ingest`는 파일을 쓰기 **전에** 검사한다.

| 검사 | 실패 시 |
|---|---|
| 절대경로 · 상위 경로(`..`) 참조 | 반영 거부 |
| 허용된 위치 밖 (do-not-touch 경계) | 반영 거부 |
| 계획에 없는 파일 / 계획에 있는데 누락 | 경고 후 반영 |
| JSON 형태가 스키마와 다름 | 어긋난 필드를 지목하고 거부 |

```
$ code-agent … --step entity --ingest bad.txt
오류: 경로 규칙을 어긴 파일이 있어 반영하지 않았습니다:
  - [do-not-touch 경계] …/repository/X.java: entity 단계가 만들 수 있는 위치가 아님 (허용: domain, cd)
```

### 채팅에 붙여넣을 때 API와 다른 점

1. **system 프롬프트가 분리되지 않는다.** API는 별도 필드로 보내지만 채팅에는 그런 필드가 없어 한 덩어리로 합쳐진다. 지시 준수 강도가 미묘하게 다를 수 있어 `# 역할·규칙` 머리말로 표시해 둔다.
2. **출력 스키마 강제가 없다.** 그래서 프롬프트 끝에 출력 형식을 본문으로 붙인다. 이걸 빼고 붙여넣으면 모델이 산문으로 답해 `--ingest`가 실패한다 — 프롬프트 전체를 그대로 붙여넣어야 한다.

---

## 프로젝트 설정 — `code-agent.json`

템플릿 디렉토리에 두고, 저장소 안에 둔다 (예: `<repo>/doc/templates/code-agent.json`).

```json
{
  "language": "java",
  "sourceExtensions": [".java"],

  "domainBase": "src/main/java/com/acme/app",
  "domainRoots": ["application", "admin"],

  "conventions": ["doc/guide"],
  "referenceDomain": "deal",
  "build": ["gradlew", "compileJava", "-q"],
  "test": ["gradlew", "test"],

  "stages": [
    {
      "key": "entity",
      "title": "Entity + 코드 enum",
      "template": "02-entity.md",
      "exemplars": ["domain/{Ref}.java", "cd/"],
      "outputDirs": ["domain", "cd"]
    },
    {
      "key": "test",
      "title": "테스트 코드",
      "template": "08-test.md",
      "base": "src/test/java/com/acme/app",
      "exemplars": ["domain/{Ref}Tests.java", "facade/{Ref}FacadeTests.java"],
      "outputDirs": ["domain", "facade", "."]
    }
  ]
}
```

| 키 | 뜻 |
|---|---|
| `language` | 프롬프트 문구와 코드블록 표기에만 쓴다. 생략 가능 |
| `sourceExtensions` | 참조 표준으로 읽을 확장자. 비면 디렉토리의 모든 파일 |
| `domainBase` | 도메인 디렉토리들이 놓이는 저장소 기준 경로 |
| `domainRoots` | 그 아래 분류. 분류가 없으면 `[]` |
| `conventions` | 컨벤션 문서 경로(파일 또는 디렉토리). 디렉토리면 안의 `.md` 전부 |
| `referenceDomain` | 복제할 기준 도메인 |
| `build` / `test` | `--build` / `--test` 시 실행할 명령. 첫 원소가 저장소 안의 실행 파일이면 그 경로로, 아니면 PATH에서 찾는다 |
| `stages[].base` | 이 단계의 도메인 루트. 생략하면 `domainBase`. 테스트처럼 같은 패키지를 다른 루트에 미러링할 때 |
| `stages[].scope` | `domain`(기본)이면 `outputDirs`를 도메인 디렉토리 기준, `project`면 저장소 루트 기준 |
| `stages[].exemplars` | 참조 도메인 기준 상대경로. `{Ref}`는 참조 도메인 PascalCase로 치환, `/`로 끝나면 디렉토리 전체 |
| `stages[].outputDirs` | 산출물 허용 위치(do-not-touch 경계). `"."`은 도메인 디렉토리 바로 아래, `[]`는 제한 없음 |

다른 언어라면 이렇게 된다 — 에이전트 코드는 그대로다.

```json
{
  "language": "python",
  "sourceExtensions": [".py"],
  "domainBase": "app/features",
  "domainRoots": [],
  "conventions": ["docs/conventions.md"],
  "referenceDomain": "orders",
  "test": ["pytest", "-q"],
  "stages": [
    { "key": "model", "title": "dataclass 모델", "template": "01-model.md",
      "exemplars": ["models.py"], "outputDirs": ["."] }
  ]
}
```

### JSON만으로 되는 것 / 소스를 고쳐야 하는 것

판별법은 하나다 — **스키마에 그걸 표현할 키가 있나?**

- **JSON만으로**: 단계 추가·삭제·순서 변경, 다른 언어·확장자, 다른 경로·분류, 다른 참조 도메인, 다른 빌드·테스트 명령, 다른 루트 미러링
- **소스 수정 필요**: 스키마에 없는 새 개념, 파이프라인 구조 자체의 변경

새 능력은 소스에 **한 번** 추가하고, 그 뒤로는 선언으로만 쓴다. 프로젝트 고유값이 소스에 들어가면 그때가 설계가 깨지는 지점이다.

---

## 단계 템플릿

각 단계의 규칙과 체크리스트는 코드가 아니라 문서에 있다. 규칙이 바뀌어도 에이전트를 고치지 않는다.

템플릿 하나는 6섹션으로 쓴다.

| 섹션 | 역할 |
|---|---|
| 0. 사용법 | 이 단계의 범위와 **do-not-touch 경계** |
| 1. 입력 게이트 | 선행 산출물이 갖춰졌는지 — 미충족이면 중단 |
| 2. 규칙 게이트 | 적용할 규칙 + **근거** + 위반 시 무효 여부 |
| 3. 작업 — 스켈레톤 | 참조 표준의 어느 파일을 어떻게 복제할지 |
| 4. 자가검증 체크리스트 | 전부 통과해야 다음 단계로 |
| 5. 산출물 → 다음 단계 입력 | 체인 연결 |

규칙에는 **근거를 적는다.** "컨벤션 §4" 또는 "참조 표준 `DealFacade.java`". 근거 없는 규칙은 나중에 누구도 검증할 수 없다.

---

## 자동 모드 — API 사용

API 키가 있으면 같은 파이프라인을 끝까지 자동으로 돌린다.

```bash
export ANTHROPIC_API_KEY=sk-ant-...

# 계획만 (API 1회) — 권장 시작점
code-agent --repo … --templates … --spec … --plan-only

# 전체 (API 1 + (생성 1 + 게이트 1) × 단계 수)
code-agent --repo … --templates … --spec … --out ./out --build
```

자동 모드에서만 되는 것: 게이트 실패 시 위반 내용을 붙여 그 단계만 **자동 재생성**(`--retries`).

`--dry-run`은 예시 계획으로 형식만 보여 주는 미리보기다. **실제로 붙여넣어 쓰려면 `--emit-prompt`를 쓴다** — 이쪽이 실제 계획과 실제 앞 단계 산출물을 넣어 준다.

---

## 옵션

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--repo` | (필수) | 대상 저장소 루트 |
| `--templates` | (필수) | `code-agent.json` + 템플릿 문서가 있는 디렉토리 |
| `--spec` | (`--ingest` 외 필수) | 요구사항 문서. 여러 번 지정 가능 |
| `--step` | — | 수동 모드 대상: `plan` \| 단계키 \| `gate:단계키` |
| `--emit-prompt` | off | 붙여넣을 프롬프트를 표준출력으로 |
| `--ingest <파일>` | — | 응답을 읽어 계획 저장 또는 파일 생성 |
| `--conventions` | 매니페스트 | 매니페스트의 `conventions` 선언을 덮어씀 |
| `--reference` | 매니페스트 | 매니페스트의 `referenceDomain`을 덮어씀 |
| `--out` | `./out` | 생성 결과를 쓸 staging 디렉토리 |
| `--policy` | — | 생성 범위 정책 문서. 모든 단계에 공통 주입 |
| `--stages` | 전체 | 자동 모드에서 일부 단계만 |
| `--plan-only` | off | 계획만 만들고 종료 (자동) |
| `--no-gate` | off | 단계별 자가검증 생략 (자동) |
| `--retries` | `1` | 게이트 실패 시 재생성 횟수 (자동) |
| `--build` | off | 임시 worktree에서 `build` 명령 |
| `--test` | off | `test` 명령 실행 — **실패해도 재생성하지 않는다** |
| `--force` | off | 미결 질문이 남아도 생성 강행 |
| `--dry-run` | off | 예시 계획으로 프롬프트 미리보기 |

`--templates`·`--conventions`·`--policy`의 상대경로는 **대상 저장소 기준으로 먼저** 해석하고, 없으면 실행 위치 기준으로 다시 찾는다.

### 출력 위치 — 대상 저장소는 건드리지 않는다

생성물은 `--out` 디렉토리에 **저장소 루트 기준 상대경로 그대로** 쌓인다.

```
out/src/main/java/com/acme/app/application/contractguarantee/domain/ContractGuarantee.java
```

확인 후 `out/` 내용을 저장소에 복사하면 그대로 반영된다. 브랜치·커밋·PR은 만들지 않는다.

`--build` / `--test`만 예외적으로 저장소를 읽는다. staging 파일만으로는 빌드할 수 없고, 그렇다고 작업트리에 직접 쓰면 무변경 약속이 깨지므로, **임시 git worktree**를 만들어 거기에만 얹고 실행한 뒤 지운다.

---

## 설계 원칙

| 원칙 | 구체적으로 |
|---|---|
| **근거 없으면 안 만든다** | 참조 표준·스캐폴더 출력·결정 문서 중 하나에 걸리지 않는 것은 지어내지 않는다. 물어야 할 목록을 내고 멈춘다 |
| **결정은 사람이** | 언어·프레임워크·계층·식별자 전략은 요구사항이 아니라 결정이다. 에이전트는 **무엇을 정해야 하는지**만 뽑는다 |
| **참조 표준 > 문서** | 컨벤션 문서와 참조 코드가 다르면 코드를 따르고 `note`에 남긴다. 문서는 뒤처질 수 있다 |
| **계층을 넘지 않는다** | 각 단계는 자기 `outputDirs` 밖의 파일을 만들지 않는다. 필요해 보여도 `note`에만 적는다 |
| **판단 불필요 = 코드** | 경로 대조·계획 준수·스캐폴딩은 결정론적이라 코드가 한다 |
| **실패를 덮지 않는다** | 테스트 실패는 자동 수정하지 않는다. 통과시키려고 단언을 지우는 것이 전형적인 실패 모드다 — 보고하고 사람에게 넘긴다 |

---

## 아직 안 되는 것

- **기존 도메인 수정** — 세 모드 모두 새로 만드는 것만 상정한다.
- **bootstrap·adopt는 스모크 테스트까지만 확인됐다.** 프롬프트 생성과 경로 검증은 돌지만, 실제 프로젝트를 끝까지 구성해 본 적은 없다.
- **자동 모드(API 경로)는 실행 검증이 안 돼 있다.** 타입체크·빌드·프롬프트 생성까지만 확인했다.
- **화면(템플릿·JS) 단계** — 기존 UI 메커니즘 복제 요구가 강해 별도 설계가 필요하다.
- **review-agent 연동** — 생성 → 리뷰 → 수정 루프는 아직 손으로 이어 붙여야 한다.
