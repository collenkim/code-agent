# code-agent

스펙 기반 소스 코드 생성 AI-Agent. `review-agent`와 짝을 이루는 반대편 — review-agent가 diff를 읽고 지적한다면, code-agent는 스펙을 읽고 코드를 만든다.

## 에이전트는 프로젝트를 모른다

프로젝트마다 언어·라이브러리·패키지 구조·계층 이름·빌드 명령·코드 컨벤션이 전부 다르다. 그래서 이 에이전트에는 특정 프로젝트의 지식이 하나도 들어 있지 않다.

| 프로젝트마다 다른 것 | 어디서 오는가 |
|---|---|
| 코드 컨벤션 | 대상 저장소의 문서 (`conventions`) |
| 도메인 디렉토리 위치·분류 | `domainBase` / `domainRoots` |
| 계층 이름과 단계 구성 | `stages` |
| 참조할 표준 파일 | `stages[].exemplars` |
| 언어·확장자 | `language` / `sourceExtensions` |
| 빌드·테스트 명령 | `build` |
| 단계별 규칙·체크리스트 | 템플릿 문서 (`stages[].template`) |

전부 **대상 저장소가 선언**한다. 에이전트가 하는 일은 그 선언대로 파이프라인을 도는 것뿐이다.

## 설계의 축 — 참조 표준(exemplar)이 문서보다 강하다

컨벤션 문서를 프롬프트에 통째로 넣어도 **발명**은 막지 못한다. "파사드는 트랜잭션 경계다"라는 문장보다 "이 프로젝트의 `DealFacade.java`가 실제로 이렇게 생겼다"가 훨씬 강하게 작동한다.

그래서 중심 결정은 하나다.

> **참조할 파일은 모델이 아니라 코드가 결정론적으로 고른다.**

계층과 도메인이 정해지면 읽을 파일 경로는 이미 정해져 있다. 탐색을 모델에게 맡기면 실행마다 참조가 달라져 결과가 흔들리므로, `src/core/exemplar.ts`가 매니페스트의 `exemplars` 패턴대로 경로를 계산해 읽어 넣는다.

부수 효과로 **문서와 코드가 어긋난 지점이 드러난다**. 계획 단계가 이를 `conflicts`로 뽑아 주며, 조용히 한쪽을 고르지 않고 기본 판단(참조 표준을 따름)과 그 이유를 함께 남긴다.

## 프로젝트 설정 — `code-agent.json`

템플릿 디렉토리에 두고, 저장소 안에 둔다 (예: `<repo>/doc/templates/code-agent.json`).

```json
{
  "language": "java",
  "sourceExtensions": [".java"],

  "domainBase": "src/main/java/com/finger/fingersales",
  "domainRoots": ["application", "admin"],

  "conventions": ["doc/guide"],
  "referenceDomain": "deal",
  "build": ["gradlew", "compileJava", "-q"],

  "stages": [
    {
      "key": "entity",
      "title": "Entity + 코드 enum",
      "template": "02-entity.md",
      "exemplars": ["domain/{Ref}.java", "cd/"],
      "outputDirs": ["domain", "cd"]
    }
  ]
}
```

| 키 | 뜻 |
|---|---|
| `language` | 프롬프트 문구와 코드블록 표기에만 쓴다. 생략 가능 |
| `sourceExtensions` | 참조 표준으로 읽을 확장자. 비면 디렉토리의 모든 파일 |
| `domainBase` | 도메인 디렉토리들이 놓이는 저장소 기준 경로 |
| `domainRoots` | 그 아래 분류(`application`/`admin` 등). 분류가 없으면 `[]` |
| `conventions` | 컨벤션 문서 경로(파일 또는 디렉토리). 디렉토리면 안의 `.md` 전부 |
| `referenceDomain` | 복제할 기준 도메인 |
| `build` | `--build` 시 실행할 명령. 첫 원소가 저장소 안의 실행 파일이면 그 경로로 실행(`gradlew`, `mvnw`, 프로젝트 스크립트), 아니면 PATH에서 찾는다 |
| `stages[].exemplars` | 참조 도메인 디렉토리 기준 상대경로. `{Ref}`는 참조 도메인 PascalCase로 치환, `/`로 끝나면 디렉토리 전체 |
| `stages[].outputDirs` | 산출물 허용 위치(do-not-touch 경계). `"."`은 도메인 디렉토리 바로 아래, `[]`는 소스가 아닌 문서 산출물 |

다른 언어라면 이렇게 된다 — 에이전트 코드는 그대로다.

```json
{
  "language": "python",
  "sourceExtensions": [".py"],
  "domainBase": "app/features",
  "domainRoots": [],
  "conventions": ["docs/conventions.md"],
  "referenceDomain": "orders",
  "build": ["pytest", "-q"],
  "stages": [
    { "key": "model", "title": "dataclass 모델", "template": "01-model.md",
      "exemplars": ["models.py"], "outputDirs": ["."] }
  ]
}
```

## 파이프라인

```
[1] plan       "어떤 컨벤션으로 어떻게 만들지" 작업 명세서
               도메인 이름·위치 · 파일 목록 · 적용 규칙(+출처) · 문서-코드 충돌 · 미결 질문
               ↓  미결 질문이 남으면 여기서 중단 (--force 로 강행)
[2] generate   stages 를 선언 순서대로. 단계 입력 =
               스펙 + 계획 + 템플릿 + 참조 표준 파일(코드가 주입) + 앞 단계 산출물
[3] gate       규칙 대조(경로·계획 준수)는 코드가, 컨벤션 판단은 모델이.
               실패하면 위반 내용을 붙여 그 단계만 재생성 (--retries)
[4] emit       staging 디렉토리에 저장 — 대상 저장소는 건드리지 않는다
[5] build      (--build) 임시 git worktree에 얹어 프로젝트 선언 명령으로 검증
```

## 사용법

```bash
npm install
npm run build

export ANTHROPIC_API_KEY=sk-ant-...

# 계획만 먼저 뽑아 사람이 검토 (권장 시작점)
code-agent --spec ./spec.md --repo /path/to/project --templates doc/templates --plan-only

# 전체 생성
code-agent --spec ./spec.md --repo /path/to/project --templates doc/templates --out ./out

# 스펙 문서가 여러 장이면 --spec 을 반복
code-agent --spec ./요구사항.md --spec ./화면정의.md --spec ./schema.sql ...

# 특정 단계만
code-agent ... --stages entity,repository

# 빌드까지 검증
code-agent ... --build
```

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--spec` | (필수) | 요구사항·정책·기능·입출력 문서. 여러 번 지정 가능 |
| `--repo` | (필수) | 대상 저장소 루트 |
| `--templates` | (필수) | `code-agent.json` + 템플릿 문서가 있는 디렉토리 |
| `--conventions` | 매니페스트 | 매니페스트의 `conventions` 선언을 덮어씀 |
| `--reference` | 매니페스트 | 매니페스트의 `referenceDomain` 을 덮어씀 |
| `--out` | `./out` | 생성 결과를 쓸 staging 디렉토리 |
| `--policy` | — | 생성 범위 정책 문서. 모든 단계에 공통 주입 |
| `--stages` | 전체 | 매니페스트에 선언된 단계 키 중 선택 |
| `--plan-only` | off | 계획만 만들고 종료 |
| `--no-gate` | off | 단계별 자가검증 생략 (속도/비용 우선) |
| `--retries` | `1` | 게이트 실패 시 재생성 횟수 |
| `--build` | off | 임시 worktree에서 `build` 명령 실행 |
| `--force` | off | 미결 질문이 남아도 생성 강행 |
| `--dry-run` | off | API 호출 없이 프롬프트만 출력 |

`--templates`·`--conventions`·`--policy` 의 상대경로는 **대상 저장소 기준으로 먼저** 해석하고, 거기 없으면 실행 위치 기준으로 다시 찾는다. 실제로 어떤 컨벤션 문서를 썼는지는 실행할 때마다 첫 줄에 출력된다.

## 출력 위치 — 대상 저장소는 건드리지 않는다

생성물은 `--out` 디렉토리에 **저장소 루트 기준 상대경로 그대로** 쌓인다.

```
out/src/main/java/com/finger/fingersales/application/quotationitem/domain/QuotationItem.java
```

확인 후 `out/` 내용을 저장소에 복사하면 그대로 반영된다. 브랜치·커밋·PR은 만들지 않는다.

`--build`만 예외적으로 저장소를 읽는다. staging 파일만으로는 빌드할 수 없고(의존 코드가 저장소에 있다), 그렇다고 작업트리에 직접 쓰면 무변경 약속이 깨지므로, **임시 git worktree**를 만들어 거기에만 얹고 실행한 뒤 통째로 지운다. 원본 작업트리는 그대로다. 대신 새 worktree라 첫 빌드가 오래 걸릴 수 있어 기본 off다.

## 판단이 필요 없는 것은 코드가 한다

게이트는 두 종류를 합쳐서 돌린다.

- **코드가 하는 대조** (`src/core/gate.ts`) — 경로 traversal, 도메인 디렉토리 밖 생성, 단계별 허용 위치(do-not-touch 경계), 계획에 있는 파일 누락/계획에 없는 파일 추가. 전부 규칙 비교라 모델에 맡길 이유가 없다.
- **모델이 하는 판단** — 템플릿 체크리스트와 컨벤션 준수 여부.

## 프롬프트 dry-run

`--dry-run`은 API를 전혀 호출하지 않고 각 단계가 보낼 system/user 프롬프트만 출력한다. API 키 없이 동작한다.

재현 정도는 단계마다 다르다.

- `plan` — 단일 호출이라 완전히 재현됨.
- 그 외 단계 — 앞 단계 산출물과 계획을 입력으로 받는데 dry-run에는 둘 다 없어(예시값) **형식만** 확인 가능하다.

## review-agent와의 관계

지금은 서로 독립이다. code-agent가 `out/`을 만들면, 그 내용을 저장소에 반영한 뒤 review-agent로 리뷰하는 식으로 손으로 이어 붙인다.

두 에이전트를 한 루프로 묶는 것(생성 → 리뷰 → high finding 수정 → 재생성)은 다음 단계이며 아직 구현하지 않았다.

## 아직 안 되는 것

- 기존 도메인 **수정**. 지금은 새 도메인 추가만 상정한다 (계획이 파일을 새로 만드는 것으로 가정).
- 도메인 디렉토리 하나로 떨어지지 않는 산출물 — 공통 설정, 마이그레이션, 인프라 정의 등. 경로 화이트리스트가 도메인 디렉토리 기준이라 지금 구조로는 못 만든다.
- GitHub Action 진입점.
