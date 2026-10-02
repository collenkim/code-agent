import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { execFileSync } from "child_process";
import { DOCS_SESSION_FILE, loadActive } from "./layout";
import { Stop } from "./stop";
import { docsStatus } from "./docsCommands";
import { loadManifestIfAny } from "./work";
import { SCHEMAS, POLICY_KINDS } from "./schemas";

/** 신규의 보편적인 시작점. 기존 프로젝트에는 적용하지 않는다. 버전·프레임워크를 임의로 올리지 않는다. */
const PRESETS = {
  node: { language: "JavaScript", title: "웹·API의 작은 시작", stack: "Node.js 22 이상, JavaScript, 내장 node:test. 외부 프레임워크·DB는 필요할 때 선택한다.", extensions: [".js"] },
  python: { language: "Python", title: "자동화·파일 처리의 작은 시작", stack: "Python 3, 표준 라이브러리와 unittest. 외부 패키지·DB는 필요할 때 선택한다.", extensions: [".py"] },
} as const;

export function recommendSetup(repoRoot: string): string {
  const manifest = loadManifestIfAny(repoRoot);
  if (manifest) return "추천: 기존 프로젝트 설정 유지. /ca-docs 로 빠진 절만 채우세요. 언어·빌드·테스트 명령을 다시 고르지 않습니다.";
  return ["프로젝트 시작 구성 — 7개 후보에서 목적에 맞는 하나를 선택", "",
    "- node: 웹·API의 작은 시작 — JavaScript와 Node 내장 도구. 설치할 외부 패키지가 없고 기능별 폴더로 시작합니다.",
    "- python: 자동화·파일 처리 — Python 표준 도구. 스크립트에서 시작해 기능별 모듈로 나눕니다.",
    "- typescript: 타입 검사를 쓰는 API — TypeScript + Node.js. 빌드와 테스트 구성을 함께 준비합니다.",
    "- fastapi: Python API — Python + FastAPI + pytest. 요청 검증과 API 문서가 필요한 경우의 후보입니다.",
    "- java-spring: Java 서버 — Java + Spring Boot + JUnit. Java 기반 팀 규칙과 서버 개발에 맞출 수 있습니다.",
    "- kotlin-spring: Kotlin 서버 — Kotlin + Spring Boot + JUnit. Kotlin을 쓰는 팀의 서버 구성 후보입니다.",
    "- go: 단일 실행 파일 API — Go 표준 HTTP 도구 + testing. 기능별 패키지로 시작합니다.",
    "그 밖의 언어·프레임워크·회사 규칙은 선택 도구의 직접 입력으로 받습니다.",
    "먼저 survey로 기존 구성을 확인하세요. 기존 코드가 있으면 재사용이 우선이며 다시 선택시키지 않습니다.",
    "메인은 요청 목적과 실제 설정을 근거로 추천 하나와 이유를 붙이고, 전체 후보를 보여 준 뒤 AskUserQuestion을 호출합니다. 폴더 이름으로 언어를 추측하지 않습니다.",
    "화면당 최대 4개 옵션: 처음은 후보 3개 + 다른 선택지, 이후는 앞 선택지 + 후보 + 필요 시 다른 선택지. ca-answer의 공통 절차를 따릅니다.",
    "node·python 선택은 code-agent docs setup node 또는 python으로 준비합니다. 나머지 후보는 /ca-adopt의 문서·설정 작성 절차로 연결합니다. docs setup의 인자로 넘기지 않습니다.",
    "프레임워크 구성은 선택 뒤 기존 버전·회사 규칙을 우선하고, 없으면 공식 지원 자료를 확인해 일관된 버전·빌드·테스트 기본안을 제시합니다. 애플리케이션 파일은 승인된 Task에서 만듭니다.",
    "소스 경로·단계·테스트 명령은 추천 구성에 포함됩니다. 제품 동작·권한·데이터 규칙은 임의로 정하지 않습니다."].join("\n");
}

function hasProjectFiles(root: string, relative = ""): boolean {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    if ([".git", ".claude", ".code-agent", ".idea", ".vscode", "doc", "docs"].includes(entry.name)) continue;
    const name = join(relative, entry.name);
    if (entry.isDirectory() && hasProjectFiles(root, name)) return true;
    if (entry.isFile() && !/\.md$/i.test(entry.name) && ![".gitignore", "LICENSE"].includes(entry.name)) return true;
  }
  return false;
}

const NODE_CHECK = "const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');let count=0;function scan(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())scan(f);else if(f.endsWith('.js')){count++;const r=cp.spawnSync(process.execPath,['--check',f],{stdio:'inherit'});if(r.error||r.status!==0)process.exit(1)}}}scan('src');if(!count)throw Error('No JavaScript source files');";
const PYTHON_CHECK = "from pathlib import Path; files=list(Path('src').rglob('*.py')); assert files, 'No Python source files'; [compile(f.read_text(encoding='utf-8-sig'),str(f),'exec') for f in files]";

export function setupProject(repoRoot: string, chosen: string | undefined): string {
  if (chosen !== "node" && chosen !== "python") throw new Stop("시작 구성은 node | python 입니다. code-agent docs recommend 로 설명을 확인하세요.");
  if (loadActive(repoRoot)) throw new Stop("작업 중에는 프로젝트 구성을 바꾸지 않습니다.");
  if (!existsSync(join(repoRoot, DOCS_SESSION_FILE))) throw new Stop("code-agent docs begin 으로 준비 세션을 먼저 여세요.");
  if (existsSync(join(repoRoot, "code-agent.json")) || hasProjectFiles(repoRoot)) {
    throw new Stop("기존 설정이나 프로젝트 파일이 있습니다 — 추천 구성으로 덮지 않습니다. /ca-adopt 로 기존 구성을 읽고 빠진 문서만 채우세요.");
  }
  const preset = PRESETS[chosen];
  let base = "master";
  try { base = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || base; } catch { /* 저장소 초기화 전 */ }
  const manifest = {
    language: preset.language.toLowerCase(), sourceExtensions: preset.extensions, domainBase: "src", domainRoots: [""],
    conventions: ["doc/conventions.md"], docs: { architecture: "doc/architecture.md" }, git: { base },
    build: chosen === "node" ? ["node", "-e", NODE_CHECK] : ["python", "-B", "-c", PYTHON_CHECK],
    test: chosen === "node" ? ["node", "--test", "--test-reporter=tap"] : ["python", "-B", "-m", "unittest", "discover", "-s", "tests", "-v"],
    stages: [
      { key: "code", title: "기능 구현", scope: "project", outputDirs: ["src"], template: "doc/code-agent/stages/code.md", exemplars: [] },
      { key: "test", title: "동작 검증", kind: "test", scope: "project", outputDirs: ["tests"], template: "doc/code-agent/stages/test.md", exemplars: [] },
      { key: "config", title: "실행 설정", scope: "project", outputDirs: ["package.json", "package-lock.json", "pyproject.toml", "requirements.txt", "README.md", ".gitignore"], template: "doc/code-agent/stages/config.md", exemplars: [] },
    ],
  };
  const sections: Record<string, Record<string, string>> = {
    architecture: {
      stack: preset.stack, structure: "src/ 아래 기능별 폴더, tests/ 에 테스트. 설정은 저장소 루트.",
      layers: "진입점은 입력·출력을 맡고 기능 모듈은 로직을 맡는다. 외부 연결은 별도 함수로 분리한다.",
      dependencies: "진입점 → 기능 모듈 → 외부 연결. 기능 모듈끼리 순환 참조하지 않는다.",
      common: "초기에는 없음. 반복이 확인되면 승인된 Task로 공통 모듈을 추가한다.",
      decisions: "단일 애플리케이션, 기능별 폴더로 시작한다. 인증·저장 방식·외부 연동은 요구가 있을 때 결정한다.",
    },
    conventions: {
      naming: chosen === "node" ? "함수·변수 camelCase, 클래스 PascalCase. 파일 이름은 기능을 나타낸다." : "함수·변수·파일 snake_case, 클래스 PascalCase.",
      layerRules: "입력 검증은 진입점, 업무 규칙은 기능 모듈. 테스트 가능한 작은 함수로 나눈다.",
      errors: "잘못된 입력과 외부 실패를 구분하고 오류를 숨기지 않는다. 세부 오류 응답은 요구사항에서 정한다.",
      tests: chosen === "node" ? "tests/*.test.js, node:test와 node:assert. 테스트 이름에 TC ID를 적는다." : "tests/test_*.py, unittest. 테스트 docstring에 TC ID를 적는다.",
    },
    "test-strategy": { levels: "- Unit: 필수\n- Integration: 외부 연동 변경 시 필요\n- E2E: 사용자 흐름 변경 시 검토", tools: "- `test`: 테스트 전체 실행", criteria: "AC마다 정상 케이스, 예외 요구가 있으면 실패 케이스를 작성한다. 필수 케이스의 생략을 성공으로 보고하지 않는다." },
    quality: { static: "- `build`: 소스 구문 검사", security: "- 없음 — 자동 보안 도구는 아직 없다. 입력 검증·비밀정보 노출은 리뷰에서 확인한다.", gate: "빌드·테스트 실패와 열린 리뷰 지적이 있으면 반영하지 않는다." },
  };
  const files: Record<string, string> = { "code-agent.json": JSON.stringify(manifest, null, 2) + "\n" };
  for (const kind of POLICY_KINDS) {
    const schema = SCHEMAS[kind];
    files[schema.defaultPath] = [`# ${schema.label}`, "", `추천 시작 구성: ${preset.title}. 사용자가 변경할 수 있으며 문서 확정 전에는 구현하지 않는다.`, "",
      ...schema.sections.filter((section) => section.required || sections[kind][section.id]).flatMap((section) => [
        `## ${section.heading}`, sections[kind][section.id] ?? "기본 원칙을 따르고 변경이 필요하면 계획에서 근거를 명시한다.", "",
      ])].join("\n");
  }
  for (const stage of manifest.stages) files[stage.template] = `# ${stage.title}\n\n승인된 Task의 파일과 요구사항만 구현한다. 공통 컨벤션을 따르고 완료 후 다음 Task로 진행한다.\n`;
  const conflicts = Object.keys(files).filter((file) => existsSync(join(repoRoot, file)));
  if (conflicts.length) throw new Stop(`기존 파일을 덮지 않았습니다: ${conflicts.join(", ")} — /ca-docs 로 기존 문서를 사용하세요.`);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repoRoot, file)), { recursive: true });
    writeFileSync(join(repoRoot, file), content, { flag: "wx" });
  }
  return `추천 구성 ${chosen} 의 설정·공통 문서·단계 규칙을 만들었습니다. 소스·실행 설정·테스트 생성은 승인된 구현 Task에서 합니다.\n\n${docsStatus(repoRoot)}\n\n문서를 읽고 code-agent docs end로 준비를 마친 뒤 code-agent setup으로 환경을 확인하세요. 현재 Claude 세션에서 ca-answer의 setup 동의 절차로 공통 문서 확정과 필요한 기준 커밋 생성을 함께 확인합니다 (기준 커밋만 필요하면 baseline). 적용 뒤 ca-next 흐름을 자동으로 이어갑니다. CLI를 직접 쓰려는 사용자는 TTY에서 code-agent confirm doc all과 code-agent setup baseline을 수동 대체 경로로 사용할 수 있습니다.`;
}
