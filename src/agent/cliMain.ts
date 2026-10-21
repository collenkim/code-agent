/**
 * code-agent 명령 — hook 하위 명령을 뺀 모든 CLI 명령. 진입점(cli.ts)이 hook 이 아닐 때만 이 모듈을 읽는다
 * (hook 은 도구 호출마다 새 프로세스로 돌므로 명령 모듈 전체를 읽지 않는다).
 */
import { readFileSync } from "fs";
import { triageBegin, triageClose, triageHandoff, triageJira, triageLink, triageStatus, triageSubmit, triageIngest, triageReassess, triageDeployed, triageAttach } from "./triage";
import { readProjectFile } from "./read";
import { parseHost } from "./hosts";

import {
  abort,
  advancePassedIntegrate,
  back,
  BACK_PHASES,
  context,
  decide,
  requireReproable,
  requireValidatable,
  start,
  status,
  Stop,
  submitPlan,
} from "./commands";
import { deliver } from "./deliver";
import { doctor } from "./doctor";
import { confirmDoc, docsBegin, docsEnd, docsInterview, docsLink, docsSkeleton, docsStatus } from "./docsCommands";
import { initialize } from "./init";
import { execution } from "./executionCommands";
import { knowledge } from "./knowledgeCommands";
import { experience } from "./experienceCommands";
import { finding } from "./findings";
import { stateExitCode, stateView } from "./stateView";
import { findRepoRoot } from "./layout";
import { modelsTable, setModel } from "./models";
import { pluginAdd, pluginExample, pluginList, PLUGIN_USAGE, pluginRemove } from "./plugins/commands";
import { decideRequest, requestBegin, requestFormat, requestSubmit } from "./request";
import { openRound } from "./review";
import { preparePlanning, planningStatus, dispatchPlanning, cancelPlanning, repairPlanning, planningResult, planningContracts, planningReuseAnswer } from "./planning";
import { manifestCheck, survey } from "./survey";
import { usage, usageReport } from "./usage";
import { check, integrate, repro, runTests } from "./validate";
import { recommendSetup, setupProject } from "./setup";
import { setupBaseline, setupStatus } from "./bootstrap";
import { applyConsent, consentStatus, finishConsent, loadConsent, prepareConsent, renderConsentOutput } from "./consent";
import { APPLY_UNOBSERVED, parsePrepareArgs, PREPARE_UNOBSERVED, takeTicket, terminalCaller } from "./consentTicket";
import { contextHandoff, handoffPlanning, stageHandoff } from "./handoff";
import { planningAdvanceCli, planningAssignmentCli, planningJson } from "./planningChain";
import { crossCritic, crossReview } from "./crossCheck";
import { atNextWork, renderVersion, runUpdate, versionView } from "./runtimeGate";
import { notationFor, useNotation } from "./hostText";
import { releaseLease } from "./lease";

const USAGE = `code-agent — Claude Code·Codex 위에서 도는 개발 절차 CLI

실행: code-agent init → 호스트를 다시 열고 → ca-request 실행 명령으로 접수 (Claude Code: /ca-request, Codex: $ca-request)
  init은 실행 절차·서브에이전트·hook 설치만 합니다. 별도 서버나 수동 에이전트 등록은 필요 없습니다.
  ca-request는 모든 요구사항 접수, ca-feature는 신규·기능 변경, ca-fix는 결함 수정, ca-refactor는 동작 보존 구조 개선 실행 절차입니다.
  질문·확정·승인은 현재 호스트 세션의 ca-answer 확인 절차로 받고 자동으로 이어갑니다 (Claude Code: 선택 도구, Codex: 로컬 MCP 선택 UI). 중단한 작업은 ca-next 실행 명령으로 재개합니다.

설치·조회 및 선택 사항인 직접 CLI (일반 개발에서는 같은 세션의 확인 도구 사용):
  code-agent help [<명령>]            이 사용법 — 명령을 주면 그 명령의 줄만
  code-agent init [--cli <path>]  이 저장소에 두 호스트의 실행 절차·에이전트·훅 설치
  code-agent execution [claude|codex|both] [--main claude|codex] [--handoff]  실행 선택·인계(호스트 밖 TTY) · --json은 인계 상태 조회
  code-agent status                   문서·작업·스테이지·질문·승인 상태
  code-agent flow advance [--json]     LangGraph 전체 흐름 재개 — 반환한 담당·사람 작업을 수행하고 결과 기록 뒤 같은 명령으로 잇는다
  code-agent status --json [--expect-state <v>] [--expect-work <ID>] [--expect-attempt <시도>] [--session <ID>] [--run-id <ID>]
                                      기계 판독용 상태(스키마 code-agent.state v1) — 읽기 전용. 재개 코드·근거·stateVersion, 기대와 다르면 stale-request(종료 코드 3)
  code-agent setup                    기존 설정·실행 환경·Git 준비 확인 (테스트 실행 없음)
  code-agent setup baseline           준비 파일 목록 확인 후 최초 기준 커밋 (TTY)
  code-agent doctor [--host claude|codex|both] [--cross]  설치·환경 점검 (생략하면 설치된 호스트). --cross 는 두 호스트 설치 때 다른 호스트의 --help 로 교차 실행 옵션을 점검한다(모델 호출 없음) — 작업 중에도 조회할 수 있다
  code-agent update [--cli <path>]    Git 소스 설치: 미리보기 뒤 update 입력으로 upstream 커밋을 릴리스 저장소의 새 폴더에 설치·검증하고
                                      이 프로젝트에 적용 — 진행 중인 일이 있으면 다음 작업부터 (호스트 밖 TTY 에서만, 호스트 종료 불필요)
  code-agent update --templates-only [--host claude|codex|both] [--cli <path>]  원격 조회 없이 적용 대기 버전을 적용하거나 지금 적용 버전의 템플릿을 다시 반영
                                      (npm 패키지 진입점이면 설치된 패키지를 릴리스로 들인다. 진행 중인 일이 있으면 바꾸지 않고 종료 코드 3)
  code-agent update --release <ID> | --bundled   설치된 릴리스로 되돌리거나 다시 앞으로(TTY 확인) · 고정을 풀고 진입점 번들로 (진행 중인 일이 없을 때)
  code-agent version [--json]         이 명령을 돌린 코드 · 이 프로젝트의 적용 버전 · 적용 대기 · 설치된 릴리스 · 실행 중인 선택 UI MCP (읽기 전용)
  code-agent usage [--work <ID>] [--since <날짜>] [--json]   이 저장소에 쓴 토큰·비용(추정)·요청·도구 호출·재시도 기록을 스테이지별·에이전트별로
  code-agent knowledge                공통 KNOWLEDGE 항목 · 그 키를 마지막으로 쓴 작업 · 최신성(재검토 필요·참조 없음·보류)
  code-agent knowledge prune          근거 경로가 전부 사라진 항목을 하나씩 보여 주고 지운다 (TTY 에서만)
  code-agent knowledge find <낱말|키|경로...>  KNOWLEDGE 항목·POLICY 절을 키·경로·별칭·본문으로 찾아 줄 범위·상태·연결을 보여 준다 (읽기 전용 — 작업 중에도 된다). 작업 경험은 따로 묶어 보인다
  code-agent experience [add <초안.json> | list [--all] | show <EXP-ID>]  작업 경험 기록(선택) — add 는 이 작업 폴더의 experience.md 에 ID·버전을 정해 쓴다. 확정 정책이 아니다
  code-agent finding [report <초안.json> | list [--json] [--work <ID>]]  진행 중 발견 보고 — 분류(a~d)·근거·영향·차단·상태. 보고일 뿐 권한이 아니다
  code-agent docs                     공통 POLICY 4종 · KNOWLEDGE 5종 — 섹션·확정 상태
  code-agent confirm doc <all|종류>   공통 문서 한 번에 확정 또는 개별 확정 (TTY)
  code-agent confirm request <ID> [<지시서>]   1 요구사항 확정 (TTY 에서만) — 원문과 정리를 나란히 보여 주고 확정해야 작업이 시작된다
                                      지시서를 생략하면 doc/work/<ID>/requirement.md (손으로 쓴 지시서가 다른 자리면 경로를 준다)
  code-agent reject request <ID> [<지시서>] --comment <사유>   요구사항 반려 (TTY 에서만) — ca-request 실행 절차가 사유를 읽고 다시 정리한다
  code-agent approve [--comment <메모>]   제출된 계획 승인 (TTY 에서만) — 요구사항 확정은 confirm request
  code-agent reject --comment <사유>  제출된 계획 반려 (TTY 에서만)
  code-agent abort                    진행 중인 작업 커서 지우기 (작업이 없으면 접수 세션을 닫는다)
  code-agent takeover                 다른 세션이 쥔 작업 진행 기록을 풀어 다음 명령을 실행하는 세션이 이어받게 한다 (저쪽 세션 종료를 사용자가 확인한 뒤)
  code-agent deliver                  13 반영 (TTY 에서만) — 게이트를 다시 돌리고 추적표·검증을 보여 준 뒤 작업 브랜치에 로컬 커밋. push · MR/PR 없음
  code-agent model [<역할|all> <모델|default>] [--host claude|codex] [--reasoning|--effort 강도]   역할별 모델·추론 강도 조회·변경·기본값 복원
  code-agent plugin add <이름> --command "<argv>" [--slots a,b] [--sends-code]   판정 플러그인 등록 (TTY 에서만 — 키는 ~/.code-agent 에)
  code-agent plugin remove <이름>     등록 해제 (TTY 에서만) — 키·동의를 함께 지운다
  code-agent plugin example [--out <경로>]   번들에 든 예시 어댑터를 파일로 꺼낸다 (기본 ./echo-adapter.js)
  code-agent master status [--json]   master 연동(선택) 상태 — 제어자·소유 세대·인계·위임 권한·최근 실행 (읽기 전용)
  code-agent master enable --controller <ID> [--label <설명>] [--token-out <파일>] [--policy <정책.json>] [--host <호스트설정.json>]
                                      master 연동 켜기·제어자 추가 (TTY 에서만) — 토큰은 한 번만 보인다. 연결만으로 승인 권한은 생기지 않는다
  code-agent master grant <권한.json> | revoke <권한 ID> [--reason <사유>]   위임 권한 주기·회수 (TTY 에서만 — 작업·임무·동작·경로·만료·한도로 좁힌다)
  code-agent master handover --to <제어자 ID> [--force-stop]   사람의 강제 인계 (TTY 에서만 — 실행이 멈춘 것을 확인한 뒤 넘긴다)
  code-agent master disable           master 연동 끄기 (TTY 에서만, 실행 중인 실행이 없을 때)
  code-agent master call              master 러너의 요청 한 건(stdin JSON, code-agent.master v1) → 응답 한 건(stdout JSON) — doc/master-control.md
  code-agent master human enable|disable --controller <ID>   대시보드 사람 채널 등록·폐기(TTY)
  code-agent master trust --controller <ID> [--preview | --shown-hash <해시>] | trust --list | untrust --controller <ID>
                                      대시보드 제어자의 PC 신뢰 등록(TTY 또는 대시보드 확인 화면, PC 당 1회)·해제(TTY)·목록 — 저장소 밖에서도 실행. 이후 프로젝트 연결은 대시보드 확인(pair)
  code-agent master recover <요청ID> [--transcript <원본.jsonl>] [--json]   종료 독립 세션 조회·복원(TTY)
  code-agent interaction publish <질문.json> | consume <ID> | complete <ID> <결과.json> | list
                                      영속 질문 발행·같은 세션 답 소비·처리 결과 기록 — doc/dashboard-interactions.md

실행 절차가 부른다 (호스트 세션 안):
  code-agent triage begin <조직/프로젝트/이슈ID> [--base <브랜치>]  Sentry 오류 사전 판별 (제품 코드 읽기 전용)
  code-agent triage status | submit | jira | handoff | close  조사 조회·제출·Jira 본문·fix 인계·조사 닫기
  code-agent triage link <Jira티켓키> <URL>   사람이 생성·확인한 Jira 연결 (원격 검증 없음)
  code-agent triage ingest <입력JSON>  project·errorLog·선택 release/base로 접수·중복 확인
  code-agent triage status <조사ID> | reassess <조사ID> <사유> | attach <조사ID> <근거>
  code-agent triage deployed <조사ID> <버전> <근거>  사람이 확인한 배포 기록 (원격 검증 없음)
  code-agent consent prepare <작업.json> | --action <동작> [--id <ID>] [--kind <종류>] [--spec <지시서>] [--for claude|codex]
                                      확인할 내용·파일·질문을 준비 (이 단계에서 승인·커밋하지 않음 — --for 를 주면 그 호스트가 쓰는 필드만 출력)
  code-agent consent status <ID>           실제 선택 응답과 다음 질문 조회
  code-agent consent apply <ID>            현재 세션에서 확인된 내용만 실행하고 계속 진행
  code-agent consent finish <ID>           응답 뒤 한 번에 — 승인이면 적용하고 지금 할 일(next)·스테이지(phase)까지, 아니면 status와 같은 내용
                                      prepare·apply·finish 는 hook 이 있는 그 세션의 셸에서 이 꼴 그대로만 실행된다
                                      (hook 이 본 명령의 티켓이 필요하다 — apply·finish 는 호스트 밖 사람의 TTY 에서도 된다)
  code-agent docs begin | end         문서 작성 세션 (도는 동안 문서 자리 밖 쓰기 금지, 열 때 KNOWLEDGE 빈 뼈대 생성)
  code-agent docs recommend           기존 구성 유지 또는 신규 시작 구성 추천
  code-agent docs setup <node|python>  선택한 신규 구성의 설정·공통 문서 생성 (기존 파일 보존)
  code-agent docs skeleton <종류>     빈 문서의 섹션 뼈대 (POLICY 4종 · knowledge · 작업 문서 01-requirements · 02-analysis · 03-design · 04-functional · 07-test-spec)
  code-agent docs interview <종류> [--sections a,b]   사용자 입력으로 채울 때 묻는 것
  code-agent docs link <종류> <경로...>  이미 있는 문서를 등록
  code-agent survey                   뼈대 역공학용 저장소 개요 (빌드·언어·구조·계층 후보·표본)
  code-agent manifest check           code-agent.json 이 실제 참조 파일을 찾는지
  code-agent plugin list              자리·기본 구현·감지된 무료 도구·등록된 플러그인·저장소 선언
  code-agent request begin [작업ID] --kind <feature|fix|refactor> [--base <기준 브랜치>] [--target <대상>]
                                      1 요구사항 접수를 연다 (도는 동안 그 작업 폴더 밖 쓰기 금지 · 시작 인자는 확정 뒤 start 가 쓴다)
  code-agent request                  접수 초안(request.json) 형식 · 규칙 · 대상 후보 · 지금 상태 (작업 중이면 그 작업의 요구사항을 고칠 때)
  code-agent request submit <request.json>   접수 초안 검사 → doc/work/<ID>/requirement.md 렌더 (확정은 사람이)
  code-agent start <지시서> [--target <대상>] [--base <기준 브랜치>]   사람이 확정한 요구사항만 받는다
  code-agent next                     게이트를 확인하고 다음 스테이지·단계로
  code-agent back <스테이지>          커서를 앞 스테이지로 되감기 — 앞으로는 못 가고, 증거·리뷰 회차·원장은 그대로 남는다
                                      ${BACK_PHASES.join(" | ")}
  code-agent context [--file]         지금 스테이지에 필요한 것 (참조 코드·계획·규칙). --file은 전문을 파일로 두고 경로만 출력
  code-agent read <파일> [시작 줄] [줄 수]  저장소 텍스트를 줄 번호와 함께 읽기 (기본 200줄, 최대 400줄)
  code-agent plan submit <초안.json>  계획 검사 후 제출
  code-agent plan preflight <파일작업.json>  분석부터 파일 작업의 형식·기준 파일·경계 검사 (읽기 전용)
  code-agent plan apply-files        승인된 현재 구현 Task의 파일 삭제·이동
  code-agent planning prepare [작업.json]  현재 단계 작업 등록 (생략하면 기본 작업)
  code-agent planning contracts <계약.json>  지정 Git 근거의 경로·커밋·해시를 검증해 담당 입력으로 등록 (계획 단계)
  code-agent planning reuse-answer <Q번호> <계약ID> <항목키>  검증된 계약 원문 재인용 (사람 답·승인 아님)
  code-agent planning advance [--chain]   준비·재사용·선행 조건 판정 후 실행할 배정 묶음과 다음 행동(next) 반환 (배정 전문은 assignmentFile에)
                                      --chain 이면 analysis·impact·design 결과가 모두 준비됐을 때 같은 호출에서 게이트(next)까지 지난다 (거부되면 exit 1, 다음 단계 배정은 하지 않는다)
  code-agent planning status          배정·입력 변경·선행 조건·미결 질문 요약
  code-agent planning result <ID>     원문 산출물을 포함한 상세 결과와 최신성 조회
  code-agent planning repair <ID>     관찰된 출력 형식 오류를 같은 입력에서 한 번 교정
  code-agent planning dispatch <ID>   입력 묶음·담당 에이전트·결과 계약 반환 (같은 입력은 재사용)
  code-agent planning cancel <ID>     중단된 배정 취소 (이전 실행 결과는 거부)
  code-agent planning cross --by <claude|codex>   두 호스트 설치 시 — 다른 호스트가 critic 입력으로 계획을 교차 검토 (읽기 전용 실행)
  code-agent repro                    fix 전용 — 재현 TC 의 실패를 보고 증거로 남긴다 (그 전에는 고칠 파일을 쓸 수 없다)
  code-agent check                    8 정적 분석·컴파일 — build + 품질·보안 기준의 명령을 돌리고 증거로 기록
  code-agent test                     9 테스트 — test + 테스트 전략의 명령을 돌리고 ⑦ 의 TC별 실제 결과를 대조
  code-agent verify [--json] [--retry]  check·test 노드를 연속 실행하고 수정·실행 문제 확인·리뷰 요청을 반환 (retry는 check부터 재실행)
  code-agent review                   11 코드 리뷰 — 회차를 열고 독립 리뷰어의 시작·완료와 결과는 hook이 기록
  code-agent review cross --by <claude|codex>   두 호스트 설치 시 — 다른 호스트가 같은 회차를 교차 리뷰 (읽기 전용 실행)
  code-agent integrate                12 통합 검증 — 기준 커밋 위의 깨끗한 worktree 에서 전체 build · test

hook 이 부른다:
  code-agent codex-event              Codex 도구·사용자 메시지·서브 에이전트·종료 관찰 (stdin JSON)
  code-agent hook                     PreToolUse 판정 (stdin JSON)
  code-agent review-event             ca-reviewer 시작·완료 관찰 및 결과 기록 (stdin JSON)
  code-agent planning-event           분석·조사·설계·계획 담당의 시작·완료 관찰 (stdin JSON)
  code-agent consent-event            Claude Code 질문 도구(AskUserQuestion) 시작·응답 관찰 및 확인 기록 (stdin JSON)
  code-agent session-event            SessionStart — 대화 시작·재개·압축·비우기 뒤 진행 상태 요약을 붙인다 (stdin JSON)
  code-agent stop                     Stop 판정 — 계획 밖 변경·답 없는 질문을 턴 끝에 한 번 (stdin JSON)`;

/**
 * `--<이름> <값>`. 깃발이 있으면 **값을 요구한다**.
 *
 * 조용히 `undefined` 를 돌려주면 `usage --since` 가 날짜 없이 전 기간을 세고 `usage --work` 가
 * 저장소 전체를 세면서도 깃발이 무시됐다는 말을 하지 않는다. 오타 하나가 그럴듯한데 틀린 숫자를
 * 만드는 유일한 자리라 여기서 막는다.
 */
function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Stop(`--${name} 에 값이 필요합니다: code-agent … --${name} <값>`);
  }
  return value;
}

/** 깃발과 그 값을 뺀 나머지 인자 — `confirm request <ID> [<지시서>]` 처럼 자리로 받는 것들 */
function positional(args: string[], valued: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      if (valued.includes(arg.slice(2))) index += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/**
 * 깃발만 받는 설치 명령(init·update·doctor)의 인자 검사 — 모르는 깃발·남는 인자는 설치·점검 전에 사용법으로 멈춘다.
 * `--help`·`-h` 는 사용법만 돌려준다(아무것도 쓰지 않는다). 값 깃발의 값은 option() 이 따로 검사한다.
 */
function optionsOnly(args: string[], valued: string[], flags: string[], usage: string): "help" | undefined {
  if (args.includes("--help") || args.includes("-h")) return "help";
  const extra: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--") && valued.includes(arg.slice(2))) index += 1;
    else if (!flags.includes(arg)) extra.push(arg);
  }
  if (extra.length) throw new Stop(`${usage} — 받지 않는 인자: ${extra.join(" ")}`);
  return undefined;
}

/** USAGE 에 나오는 명령 이름 — `help <명령>` 과 오타 제안이 쓴다 */
function usageNames(): string[] {
  return [...new Set([...USAGE.matchAll(/^ {2}code-agent ([a-z][a-z-]*)/gm)].map((match) => match[1]))];
}

/** `help <명령>` — USAGE 에서 그 명령의 줄과 이어지는 들여쓴 설명 줄만 */
function commandUsage(name: string): string | undefined {
  const out: string[] = [];
  let taking = false;
  for (const line of USAGE.split("\n")) {
    if (line === `  code-agent ${name}` || line.startsWith(`  code-agent ${name} `)) { out.push(line); taking = true; }
    else if (taking && /^ {10,}\S/.test(line)) out.push(line);
    else taking = false;
  }
  return out.length ? out.join("\n") : undefined;
}

/** 편집 거리 — 오타 제안에만 쓴다 */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) next.push(Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    row = next;
  }
  return row[b.length];
}

/** 모르는 명령 — 사용법 전문(약 8천 자) 대신 가까운 명령과 도움말 명령만. 모델이 오타를 내도 전문이 대화에 다시 실리지 않는다 */
function unknownCommand(command: string): string {
  const near = usageNames().map((name) => ({ name, gap: name.startsWith(command) ? 0 : distance(command, name) }))
    .filter((item) => item.gap <= 2).sort((a, b) => a.gap - b.gap)[0]?.name;
  return `모르는 명령입니다: ${command}${near ? ` — ${near} 이면 code-agent help ${near}` : ""}\n사용법: code-agent help <명령> · 전체: code-agent help`;
}

const INIT_USAGE = "사용법: code-agent init [--cli <path>]";
const DOCTOR_USAGE = "사용법: code-agent doctor [--host claude|codex|both] [--cross]";
const MASTER_USAGE = "사용법: code-agent master status [--json] | enable --controller <ID> [--label <설명>] [--token-out <파일>] [--policy <정책.json>] [--host <호스트설정.json>] | " +
  "disable | grant <권한.json> | revoke <권한 ID> [--reason <사유>] | handover --to <제어자 ID> [--force-stop] | recover <요청ID> [--transcript <원본.jsonl>] [--json] | " +
  "trust --controller <ID> [--preview | --shown-hash <해시>] | trust --list | untrust --controller <ID> | call (stdin 요청 → stdout 응답)";
const UPDATE_USAGE = "사용법: code-agent update [--cli <path>] | code-agent update --templates-only [--host claude|codex|both] [--cli <path>] | code-agent update --release <ID> | code-agent update --bundled";

/** 실행 명령은 LangGraph·검증 자식 프로세스를 기다리고, 조회 명령은 기록을 바꾸지 않는다. */
export async function runCommand(command: string | undefined, args: string[]): Promise<number> {
  const repoRoot = findRepoRoot(process.cwd());
  // 출력 문구의 실행 절차·역할·도구 표기 — CODE_AGENT_HOST → hosts.json(설치 호스트 하나) → 실행 환경 → 중립
  useNotation(notationFor(repoRoot));
  const print = (text: string) => process.stdout.write(`${text}\n`);
  // 다음 작업을 여는 명령 — 예약된 새 버전을 먼저 적용하고 세션은 실행 잠금 안에서 연다(runtimeGate.atNextWork)
  const operation = <T>(action: string, apply: () => T | Promise<T>) =>
    (require("./graph/operation") as typeof import("./graph/operation")).runOperation(repoRoot, command!, action, apply);
  const opening = async (open: () => string): Promise<number> => {
    const out = await atNextWork(repoRoot, [command!, ...args], () => operation("open", open), print);
    if (typeof out === "number") return out;
    print(out);
    return 0;
  };
  switch (command) {
    case "flow": {
      if (args[0] !== "advance" || args.slice(1).some(arg => arg !== "--json")) throw new Stop("사용법: code-agent flow advance [--json]");
      const result = await (require("./graph/lifecycle") as typeof import("./graph/lifecycle")).advanceFlow(repoRoot);
      print(args.includes("--json") ? JSON.stringify(result, null, 2) : [result.instruction, ...(result.procedure ? [`절차: ${result.procedure}`] : []), `재개: ${result.resume}`].join("\n"));
      return 0;
    }
    case "interaction": {
      const service = require("./interactionService") as typeof import("./interactionService");
      if (args[0] === "drain" && args.length === 2 && /^[a-f0-9-]{36}$/.test(args[1])) { print(JSON.stringify(service.drainInteraction(repoRoot, args[1]))); return 0; }
      if (args[0] === "list" && args.length === 1) {
        (require("./interactionSources") as typeof import("./interactionSources")).synchronizeInteractions(repoRoot);
        print(JSON.stringify((require("./interactions") as typeof import("./interactions")).currentInteractions(repoRoot))); return 0;
      }
      if (!((args[0] === "publish" || args[0] === "consume") && args.length === 2 || args[0] === "complete" && args.length === 3)) throw new Stop("사용법: code-agent interaction publish <질문.json> | consume <ID> | complete <ID> <결과.json> | list");
      const ticket = (require("./interactionTicket") as typeof import("./interactionTicket")).takeInteractionTicket(repoRoot, JSON.stringify(args));
      if (args[0] === "publish") print(JSON.stringify((require("./interactionSources") as typeof import("./interactionSources")).publishHostInteraction(repoRoot, JSON.parse(readFileSync(args[1], "utf8")), ticket)));
      else print(JSON.stringify(service.consumeInteraction(repoRoot, args[1], ticket.sessionId, args[0] === "complete" ? JSON.parse(readFileSync(args[2], "utf8")) : undefined)));
      return 0;
    }
    case "triage": {
      const [action, ...rest] = args;
      if (action === "begin" && rest.length === 1) return opening(() => triageBegin(repoRoot, rest[0]));
      else if (action === "begin" && rest.length === 3 && rest[1] === "--base") return opening(() => triageBegin(repoRoot, rest[0], rest[2]));
      else if (action === "link" && rest.length === 2) print(await operation("link", () => triageLink(repoRoot, rest[0], rest[1])));
      else if (action === "ingest" && rest.length === 1) return opening(() => triageIngest(repoRoot, rest[0]));
      else if (action === "status" && rest.length === 1) print(triageStatus(repoRoot, rest[0]));
      else if (action === "reassess" && rest.length === 2) return opening(() => triageReassess(repoRoot, rest[0], rest[1]));
      else if (action === "attach" && rest.length === 2) print(await operation("attach", () => triageAttach(repoRoot, rest[0], rest[1])));
      else if (action === "deployed" && rest.length === 3) print(await operation("deployed", () => triageDeployed(repoRoot, rest[0], rest[1], rest[2])));
      else if (rest.length === 0 && action === "status") print(triageStatus(repoRoot));
      else if (rest.length === 0 && action === "submit") print(await operation("submit", () => triageSubmit(repoRoot)));
      else if (rest.length === 0 && action === "jira") print(triageJira(repoRoot));
      else if (rest.length === 0 && action === "handoff") print(await operation("handoff", () => triageHandoff(repoRoot)));
      else if (rest.length === 0 && action === "close") print(await operation("close", () => triageClose(repoRoot)));
      else throw new Stop("사용법: code-agent triage ingest <입력JSON> | begin <출처> [--base <브랜치>] | status [조사ID] | submit | jira | link <Jira티켓키> <URL> | handoff | close | attach <조사ID> <근거> | reassess <조사ID> <사유> | deployed <조사ID> <버전> <근거>");
      return 0;
    }
    case "planning":
      if (args[0] === "advance") {
        // --chain: analysis·impact·design 결과가 모두 준비됐으면 같은 호출에서 게이트(next)까지 — 거부면 exit 1(JSON 은 그대로)
        const rest = args.slice(1);
        if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--chain")) throw new Stop("사용법: code-agent planning advance [--chain]");
        const out = await planningAdvanceCli(repoRoot, { chain: rest[0] === "--chain" });
        print(out.text);
        return out.exit;
      }
      if (args[0] === "prepare") print(await operation("prepare", () => preparePlanning(repoRoot, args[1] ? JSON.parse(readFileSync(args[1], "utf8")) : undefined)));
      else if (args[0] === "contracts" && args.length === 2) print(await operation("contracts", () => planningContracts(repoRoot, args[1])));
      else if (args[0] === "reuse-answer" && args.length === 4) print(await operation("reuse-answer", () => planningReuseAnswer(repoRoot, args[1], args[2], args[3])));
      else if (args[0] === "status") print(planningJson(JSON.parse(planningStatus(repoRoot))));
      else if (args[0] === "result" && args[1]) print(planningJson(JSON.parse(planningResult(repoRoot, args[1]))));
      else if (args[0] === "repair" && args[1]) print(await operation("repair", () => planningAssignmentCli(handoffPlanning(repoRoot, repairPlanning(repoRoot, args[1])))));
      else if (args[0] === "dispatch" && args[1]) print(await operation("dispatch", () => planningAssignmentCli(handoffPlanning(repoRoot, dispatchPlanning(repoRoot, args[1])))));
      else if (args[0] === "cancel" && args[1]) print(await operation("cancel", () => cancelPlanning(repoRoot, args[1])));
      else if (args[0] === "cross") print(await operation("cross", () => crossCritic(repoRoot, option(args, "by"))));
      else throw new Stop("planning advance [--chain] | prepare [작업.json] | status | result <ID> | dispatch <ID> | repair <ID> | cancel <ID> | cross --by <claude|codex>");
      return 0;
    case "consent":
      if (args[0] === "prepare") {
        // 문법 오류는 티켓을 꺼내기 전에 사용법으로 알린다(hook 도 같은 함수로 보고 그런 명령에는 티켓을 내지 않는다)
        const parsed = parsePrepareArgs(args.slice(1));
        // hook 이 이 준비 명령을 본 세션(티켓)에 동의를 묶는다 — 티켓이 없으면 세션을 확인할 수 없어 준비하지 않는다
        const ticket = takeTicket(repoRoot, "prepare");
        if (!ticket) throw new Stop(PREPARE_UNOBSERVED);
        if (parsed.form && parsed.form !== ticket.host) {
          throw new Stop(`--for ${parsed.form} 는 이 명령을 실행한 세션(${ticket.host})과 다릅니다 — --for ${ticket.host} 로 다시 준비하세요.`);
        }
        const raw = parsed.file !== undefined ? JSON.parse(readFileSync(parsed.file, "utf8"))
          : { action: parsed.action, ...(parsed.id ? { id: parsed.id } : {}), ...(parsed.kind ? { kind: parsed.kind } : {}), ...(parsed.spec ? { spec: parsed.spec } : {}) };
        print(await operation("prepare", () => renderConsentOutput(repoRoot, prepareConsent(repoRoot, raw, { binding: { id: ticket.sessionId, host: ticket.host }, form: parsed.form }))));
      } else if ((args[0] === "apply" || args[0] === "finish") && args[1]) {
        // 사람의 터미널(TTY, 호스트 표지 없음)이거나 hook 이 이 적용 명령을 본 세션만 — 적용 함수가 응답을 관찰한 세션과 대조한다
        const tty = terminalCaller(process.stdin.isTTY, process.env);
        const ticket = tty ? undefined : takeTicket(repoRoot, "apply", args[1]);
        if (!tty && !ticket) throw new Stop(APPLY_UNOBSERVED);
        const caller = tty ?? { sessionId: ticket!.sessionId };
        const apply = () => args[0] === "apply" ? applyConsent(repoRoot, args[1], caller) : renderConsentOutput(repoRoot, finishConsent(repoRoot, args[1], caller));
        // 릴리스 교체는 실행 중인 그래프 바깥에서 수행한다. 업데이트 자체의 잠금·동의 검사는 유지한다.
        print(loadConsent(repoRoot, args[1]).action.action === "update" ? apply() : await operation(args[0], apply));
      } else if (args[0] === "status" && args[1]) print(renderConsentOutput(repoRoot, consentStatus(repoRoot, args[1])));
      else throw new Stop("사용법: code-agent consent prepare <작업.json> | --action <동작> … [--for claude|codex] | status <ID> | apply <ID> | finish <ID>");
      return 0;
    case "setup":
      if (args[0] && args[0] !== "baseline") throw new Stop("사용법: code-agent setup [baseline]");
      print(args[0] === "baseline" ? await operation("baseline", () => setupBaseline(repoRoot)) : setupStatus(repoRoot));
      return 0;
    case "init":
      if (optionsOnly(args, ["host", "cli"], [], INIT_USAGE)) { print(INIT_USAGE); return 0; }
      print(initialize(repoRoot, { cli: option(args, "cli"), host: parseHost(option(args, "host")) }));
      return 0;
    case "execution":
      {
        const mode = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
        const flags = mode ? args.slice(1) : args;
        const usage = "사용법: code-agent execution [claude|codex|both] [--main claude|codex] [--handoff] | --json";
        if (optionsOnly(flags, ["main"], ["--handoff", "--json"], usage)) { print(usage); return 0; }
        print(execution(repoRoot, mode, { main: option(flags, "main"), handoff: flags.includes("--handoff"), json: flags.includes("--json") }));
      }
      return 0;
    case "status": {
      if (args.length === 0) { print(status(repoRoot)); return 0; }
      const STATUS_USAGE = "사용법: code-agent status [--json [--expect-state <v>] [--expect-work <ID>] [--expect-attempt <시도>] [--session <ID>] [--run-id <ID>]]";
      if (optionsOnly(args, ["expect-state", "expect-work", "expect-attempt", "session", "run-id"], ["--json"], STATUS_USAGE)) { print(STATUS_USAGE); return 0; }
      if (!args.includes("--json")) throw new Stop(`${STATUS_USAGE} — 대조·식별 옵션은 --json 과 함께 씁니다`);
      // master 실행 세션 안에서 부른 조회는 그 실행의 세션으로 본다 — 자기 임대를 다른 세션의 임대로 읽지 않는다(감독이 넣은 실행 환경 변수가 있을 때만)
      const session = option(args, "session") ?? (require("./master/runGuard") as typeof import("./master/runGuard")).masterRun(repoRoot)?.sessionId;
      const view = stateView(repoRoot, { expectState: option(args, "expect-state"), expectWork: option(args, "expect-work"), expectAttempt: option(args, "expect-attempt"),
        session, runId: option(args, "run-id") });
      print(JSON.stringify(view, null, 2));
      return stateExitCode(view);
    }
    case "doctor": {
      if (optionsOnly(args, ["host"], ["--cross"], DOCTOR_USAGE)) { print(DOCTOR_USAGE); return 0; }
      const report = doctor(repoRoot, parseHost(option(args, "host")), { cross: args.includes("--cross") });
      print(report.text);
      return report.ok ? 0 : 1;
    }
    case "update": {
      // 새 버전 설치(fetch·npm ci·build)와 버전 선택은 미리보기를 보여 주고 터미널에서 확인받는다 — 동의 적용은 이미 확인을 받았다.
      // --apply-release 는 갱신·다음 작업 관문이 새 릴리스의 CLI 로 부르는 내부 갈래다
      if (optionsOnly(args, ["host", "cli", "release", "apply-release", "trigger", "consent"], ["--templates-only", "--bundled"], UPDATE_USAGE)) { print(UPDATE_USAGE); return 0; }
      const result = runUpdate(repoRoot, {
        templatesOnly: args.includes("--templates-only"), bundled: args.includes("--bundled"), release: option(args, "release"),
        applyRelease: option(args, "apply-release"), trigger: option(args, "trigger"), consent: option(args, "consent"),
        cli: option(args, "cli"), host: parseHost(option(args, "host")),
      });
      print(result.text);
      return result.code;
    }
    case "version":
      if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) throw new Stop("사용법: code-agent version [--json]");
      print(args[0] === "--json" ? JSON.stringify(versionView(repoRoot), null, 2) : renderVersion(versionView(repoRoot)));
      return 0;
    case "usage": {
      // 값 없는 깃발이 먼저다 — `--work --since x` 는 사용법이 아니라 --work 의 값이 없다고 알린다
      const options = { work: option(args, "work"), since: option(args, "since") };
      const extra = positional(args, ["work", "since"]).concat(args.filter((arg) => arg.startsWith("--") && !["--work", "--since", "--json"].includes(arg)));
      if (extra.length) throw new Stop("사용법: code-agent usage [--work <ID>] [--since <날짜>] [--json]");
      print(args.includes("--json") ? JSON.stringify(usageReport(repoRoot, options), null, 2) : usage(repoRoot, options));
      return 0;
    }
    case "knowledge":
      print(knowledge(repoRoot, args));
      return 0;
    case "experience":
      print(args[0] === "add" ? await operation("add", () => experience(repoRoot, args)) : experience(repoRoot, args));
      return 0;
    case "finding":
      print(args[0] === "report" ? await operation("report", () => finding(repoRoot, args)) : finding(repoRoot, args));
      return 0;
    case "start":
      if (!args[0] || args[0].startsWith("--")) {
        throw new Stop("지시서 경로가 필요합니다: code-agent start <지시서>");
      }
      return opening(() => start(repoRoot, args[0], { target: option(args, "target"), base: option(args, "base") }));
    case "next":
      // 구현 Task 로 옮겼으면 그 Task 의 context 파일도 쓴다 — context --file 왕복을 줄인다
      print([await (require("./graph/transition") as typeof import("./graph/transition")).advancePhase(repoRoot), ...(stageHandoff(repoRoot, "implement")?.lines ?? [])].join("\n"));
      return 0;
    case "back":
      print(await operation("rewind", () => back(repoRoot, args[0] ?? "")));
      return 0;
    case "context":
      print(args.includes("--file") ? contextHandoff(repoRoot) : context(repoRoot));
      return 0;
    case "read":
      if (args.length < 1 || args.length > 3) throw new Stop("사용법: code-agent read <파일> [시작 줄] [줄 수]");
      print(readProjectFile(repoRoot, args[0], args[1] === undefined ? 1 : Number(args[1]), args[2] === undefined ? 200 : Number(args[2])));
      return 0;
    case "repro":
      print(await operation("reproduce", () => repro(requireReproable(repoRoot))));
      return 0;
    case "check":
      print(await operation("check", () => check(requireValidatable(repoRoot, "check"))));
      return 0;
    case "test":
      print(await operation("test", () => runTests(requireValidatable(repoRoot, "test"))));
      return 0;
    case "verify": {
      if (args.some((arg) => arg !== "--json" && arg !== "--retry")) throw new Stop("사용법: code-agent verify [--json] [--retry]");
      const { renderVerification, verificationJson, verify } = require("./verificationFlow") as typeof import("./verificationFlow");
      const result = await verify(repoRoot, { retry: args.includes("--retry") });
      print(args.includes("--json") ? verificationJson(result) : renderVerification(result));
      return result.node === "review" ? 0 : 1;
    }
    case "review":
      // 회차를 열면 리뷰어에게 넘길 context 파일도 쓴다
      print(await operation(args[0] === "cross" ? "cross" : "open-round", () => args[0] === "cross" ? crossReview(repoRoot, option(args, "by")) : [openRound(requireValidatable(repoRoot, "review")), "", ...(stageHandoff(repoRoot, "review")?.lines ?? [])].join("\n")));
      return 0;
    case "integrate": {
      print(await operation("integrate", async () => {
        const result = await integrate(requireValidatable(repoRoot, "integrate"));
        const moved = advancePassedIntegrate(repoRoot);
        return moved ? `${result}\n\n${moved}` : result;
      }));
      return 0;
    }
    case "deliver":
      print(await operation("commit", () => deliver(requireValidatable(repoRoot, "deliver"))));
      return 0;
    case "plan":
      if (args[0] === "preflight" && args.length === 2) {
        print((require("./fileOperations") as typeof import("./fileOperations")).inspectFiles(repoRoot, args[1])); return 0;
      }
      if (args[0] === "apply-files" && args.length === 1) {
        print(await operation("apply-files", () => (require("./fileOperations") as typeof import("./fileOperations")).applyFileOperations(repoRoot))); return 0;
      }
      if (args[0] !== "submit" || !args[1]) {
        throw new Stop("사용법: code-agent plan submit <초안.json> | plan preflight <파일작업.json> | plan apply-files");
      }
      print(await operation("submit", () => submitPlan(repoRoot, args[1])));
      return 0;
    case "approve": {
      // 남는 인자는 사용법 오류다 — `approve request X` 를 요구사항 확정으로 오해해 계획 승인 화면으로 가지 않게
      const extra = positional(args, ["comment"]);
      if (extra[0] === "request") throw new Stop("요구사항 확정은 code-agent confirm request <ID> [<지시서>] 입니다 — approve 는 제출된 계획을 승인합니다.");
      if (extra.length) throw new Stop(`사용법: code-agent approve [--comment <메모>] — 받지 않는 인자: ${extra.join(" ")}`);
      print(await operation("approve", () => decide(repoRoot, "approved", option(args, "comment"))));
      return 0;
    }
    case "reject":
      if (args[0] === "request") {
        const [id, spec, ...rest] = positional(args.slice(1), ["comment"]);
        if (rest.length) throw new Stop(`사용법: code-agent reject request <ID> [<지시서>] --comment <사유> — 받지 않는 인자: ${rest.join(" ")}`);
        print(await operation("reject-request", () => decideRequest(repoRoot, id, "rejected", option(args, "comment"), spec)));
        return 0;
      }
      if (positional(args, ["comment"]).length) throw new Stop("사용법: code-agent reject --comment <사유> | code-agent reject request <ID> [<지시서>] --comment <사유>");
      print(await operation("reject", () => decide(repoRoot, "rejected", option(args, "comment"))));
      return 0;
    case "takeover":
      if (args.length) throw new Stop("사용법: code-agent takeover");
      print(releaseLease(repoRoot));
      return 0;
    case "master": {
      // master 연동 — call·supervise 는 러너가, 나머지는 사람이 터미널에서 부른다(설정 명령은 TTY 확인). 연동 모듈은 이 명령에서만 읽는다
      const sub = args[0];
      if (sub === "call") {
        if (args.length !== 1) throw new Stop(MASTER_USAGE);
        const response = (require("./master/control") as typeof import("./master/control")).call(repoRoot, readFileSync(0, "utf8"));
        print(JSON.stringify(response));
        return response.ok ? 0 : 1;
      }
      if (sub === "supervise" && args.length === 2) return (require("./master/supervisor") as typeof import("./master/supervisor")).supervise(repoRoot, args[1]);
      if (sub === "recover") {
        const usage = "사용법: code-agent master recover <요청ID> [--transcript <원본.jsonl>] [--json]";
        if (!args[1] || args[1].startsWith("--")) throw new Stop(usage);
        if (optionsOnly(args.slice(2), ["transcript"], ["--json"], usage)) { print(usage); return 0; }
        print((require("./master/recovery") as typeof import("./master/recovery")).recoverSession(repoRoot, args[1], { transcript: option(args, "transcript"), json: args.includes("--json") })); return 0;
      }
      // PC 신뢰는 저장소와 무관하다(키 저장소에만 쓴다) — 저장소 밖에서도 실행한다
      if (sub === "trust" || sub === "untrust") {
        const trust = require("./master/trust") as typeof import("./master/trust");
        if (sub === "trust" && args.length === 2 && args[1] === "--list") { print(trust.masterTrustList()); return 0; }
        // 대시보드 확인 화면 — 문구·해시를 읽고(--preview), 사람이 확인한 해시로 등록한다(--shown-hash). 둘 다 JSON 한 줄을 낸다
        if (sub === "trust" && args.length === 4 && args[1] === "--controller" && args[3] === "--preview") { print(trust.masterTrustPreview(args[2])); return 0; }
        if (sub === "trust" && args.length === 5 && args[1] === "--controller" && args[3] === "--shown-hash") { print(trust.masterTrustConfirmed(args[2], args[4])); return 0; }
        if (args.length !== 3 || args[1] !== "--controller") throw new Stop(trust.TRUST_USAGE);
        print(sub === "trust" ? trust.masterTrust(args[2]) : trust.masterUntrust(args[2])); return 0;
      }
      if (sub === "human" && ["enable", "disable"].includes(args[1])) {
        const controller = option(args, "controller");
        if (!controller || args.length !== 4) throw new Stop("사용법: code-agent master human enable|disable --controller <ID>");
        print((require("./interactionHuman") as typeof import("./interactionHuman")).configureHumanChannel(repoRoot, controller, args[1] === "enable")); return 0;
      }
      const admin = require("./master/admin") as typeof import("./master/admin");
      if (sub === "enable") print(admin.masterEnable(repoRoot, { controller: option(args, "controller"), label: option(args, "label"), tokenOut: option(args, "token-out"), policy: option(args, "policy"), host: option(args, "host") }));
      else if (sub === "disable" && args.length === 1) print(admin.masterDisable(repoRoot));
      else if (sub === "grant" && args.length === 2) print(admin.masterGrant(repoRoot, args[1]));
      else if (sub === "revoke" && args[1]) print(admin.masterRevoke(repoRoot, args[1], option(args, "reason")));
      else if (sub === "handover") print(admin.masterHandover(repoRoot, option(args, "to"), args.includes("--force-stop")));
      else if (sub === "status" && args.length <= 2 && (args.length === 1 || args[1] === "--json")) print(admin.masterStatus(repoRoot, args[1] === "--json"));
      else throw new Stop(MASTER_USAGE);
      return 0;
    }
    case "request":
      switch (args[0]) {
        case undefined:
          print(requestFormat(repoRoot));
          return 0;
        case "begin":
          return opening(() =>
            requestBegin(repoRoot, positional(args.slice(1), ["kind", "base", "target"])[0], option(args, "kind"), {
              base: option(args, "base"),
              target: option(args, "target"),
            }),
          );
        case "submit":
          print(await operation("submit", () => requestSubmit(repoRoot, args[1])));
          return 0;
        default:
          throw new Stop("사용법: code-agent request [begin [ID] --kind <feature|fix|refactor> | submit <request.json>]");
      }
    case "abort":
      print(await operation("abort", () => abort(repoRoot)));
      return 0;
    case "docs":
      switch (args[0]) {
        case "recommend":
          print(recommendSetup(repoRoot));
          return 0;
        case "setup":
          print(await operation("setup", () => setupProject(repoRoot, args[1])));
          return 0;
        case undefined:
          print(docsStatus(repoRoot));
          return 0;
        case "begin":
          return opening(() => docsBegin(repoRoot));
        case "end":
          print(await operation("end", () => docsEnd(repoRoot)));
          return 0;
        case "skeleton":
          print(docsSkeleton(args[1]));
          return 0;
        case "interview":
          print(docsInterview(args[1], option(args, "sections")));
          return 0;
        case "link":
          print(await operation("link", () => docsLink(repoRoot, args[1], args.slice(2))));
          return 0;
        default:
          throw new Stop("사용법: code-agent docs [recommend | setup <node|python> | begin | end | skeleton <종류> | interview <종류> | link <종류> <경로...>]");
      }
    case "confirm":
      if (args[0] === "request") {
        const [id, spec, ...rest] = positional(args.slice(1), []);
        if (rest.length) throw new Stop(`사용법: code-agent confirm request <ID> [<지시서>] — 받지 않는 인자: ${rest.join(" ")}`);
        print(await operation("confirm-request", () => decideRequest(repoRoot, id, "confirmed", undefined, spec)));
        return 0;
      }
      if (args[0] !== "doc") {
        throw new Stop(
          "사용법: code-agent confirm doc <all | architecture | conventions | test-strategy | quality> | code-agent confirm request <ID> [<지시서>]",
        );
      }
      print(await operation("confirm-doc", () => confirmDoc(repoRoot, args[1])));
      return 0;
    case "model": {
      const host = parseHost(option(args, "host"));
      if (host === "both") throw new Stop("모델 변경 호스트는 claude 또는 codex 하나를 지정하세요.");
      const values = positional(args, ["host", "reasoning", "effort"]);
      const reasoning = option(args, "reasoning"), effort = option(args, "effort");
      if (reasoning !== undefined && effort !== undefined) throw new Stop("추론 강도는 --reasoning 또는 --effort 하나로 지정하세요 — 두 깃발은 같은 뜻입니다.");
      const strength = reasoning ?? effort;
      if (values.length > 2 || (!values.length && strength)) throw new Stop("모델 조회에는 --host만, 변경에는 역할·모델과 선택적인 --reasoning(또는 --effort)을 지정하세요.");
      print(values.length === 0 ? modelsTable(repoRoot, host) : setModel(repoRoot, values[0], values[1], { host, reasoning: strength }));
      return 0;
    }
    case "plugin":
      switch (args[0]) {
        case "list":
          print(pluginList(repoRoot));
          return 0;
        case "example":
          print(pluginExample(option(args, "out")));
          return 0;
        case "add":
          print(
            pluginAdd(repoRoot, {
              name: args[1],
              command: option(args, "command"),
              slots: option(args, "slots"),
              sendsCode: args.includes("--sends-code"),
              secretEnv: option(args, "secret-env"),
            }),
          );
          return 0;
        case "remove":
          print(pluginRemove(args[1]));
          return 0;
        default:
          throw new Stop(PLUGIN_USAGE);
      }
    case "survey":
      print(survey(repoRoot));
      return 0;
    case "manifest": {
      if (args[0] !== "check") {
        throw new Stop("사용법: code-agent manifest check");
      }
      const result = manifestCheck(repoRoot);
      print(result.text);
      return result.ok ? 0 : 1;
    }
    case undefined:
    case "--help":
    case "-h":
      print(USAGE);
      return 0;
    case "help": {
      if (args.length === 0) { print(USAGE); return 0; }
      const lines = args.length === 1 ? commandUsage(args[0]) : undefined;
      if (!lines) throw new Stop(unknownCommand(args.join(" ")));
      print(lines);
      return 0;
    }
    default:
      throw new Stop(unknownCommand(command));
  }
}

