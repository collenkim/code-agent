#!/usr/bin/env node
import { readFileSync } from "fs";
import { runCodexHook } from "./codexHook";
import { readProjectFile } from "./read";
import { parseHost } from "./hosts";

import {
  abort,
  back,
  BACK_PHASES,
  context,
  decide,
  next,
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
import { runHook } from "./hook";
import { init } from "./init";
import { knowledge } from "./knowledgeCommands";
import { findRepoRoot } from "./layout";
import { modelsTable, setModel } from "./models";
import { pluginAdd, pluginExample, pluginList, PLUGIN_USAGE, pluginRemove } from "./plugins/commands";
import { decideRequest, requestBegin, requestFormat, requestSubmit } from "./request";
import { openRound } from "./review";
import { runReviewHook } from "./reviewHook";
import { runPlanningHook } from "./planningHook";
import { preparePlanning, planningStatus, dispatchPlanning, cancelPlanning, advancePlanning, repairPlanning, planningResult } from "./planning";
import { runStopHook } from "./stopHook";
import { manifestCheck, survey } from "./survey";
import { update } from "./update";
import { usage } from "./usage";
import { check, integrate, repro, runTests } from "./validate";
import { recommendSetup, setupProject } from "./setup";
import { setupBaseline, setupStatus } from "./bootstrap";
import { applyConsent, consentStatus, prepareConsent, runConsentHook } from "./consent";
import { updateFromSource } from "./sourceUpdate";
import { renderVerification, verify } from "./verificationFlow";

const USAGE = `code-agent — Claude Code 위에서 도는 코드 작성 에이전트

실행: code-agent init --host claude → claude → /ca-request <요구사항>
      code-agent init --host codex → codex → $ca-request <요구사항>
  init은 스킬·서브에이전트·hook 설치만 합니다. 별도 서버나 수동 에이전트 등록은 필요 없습니다.
  /ca-request는 모든 요구사항 접수, /ca-feature는 신규·기능 변경, /ca-fix는 결함 수정, /ca-refactor는 동작 보존 구조 개선입니다.
  질문·확정·승인은 현재 Claude Code의 선택 도구에서 처리하고 자동으로 이어갑니다. 중단한 작업은 /ca-next 로 재개합니다.

설치·조회 및 선택 사항인 직접 CLI (일반 개발에서는 같은 세션의 확인 도구 사용):
  code-agent init [--host claude|codex|both] [--cli <path>]  이 저장소에 호스트별 스킬·에이전트·훅 설치
  code-agent status                   문서·작업·스테이지·질문·승인 상태
  code-agent setup                    기존 설정·실행 환경·Git 준비 확인 (테스트 실행 없음)
  code-agent setup baseline           준비 파일 목록 확인 후 최초 기준 커밋 (TTY)
  code-agent doctor [--host claude|codex|both]  설치·환경 점검 (생략하면 설치된 호스트)
  code-agent update [--cli <path>]    Git 소스 설치: upstream 갱신·의존성·빌드·프로젝트 적용·점검
  code-agent update --templates-only [--host claude|codex|both] [--cli <path>]  원격 조회 없이 현재 번들을 프로젝트에 적용
  code-agent usage [--work <ID>] [--since <날짜>]   이 저장소에 쓴 토큰·비용을 스테이지별·에이전트별로 (추정)
  code-agent knowledge                공통 KNOWLEDGE 항목과 그 키를 마지막으로 쓴 작업
  code-agent knowledge prune          근거 경로가 전부 사라진 항목을 하나씩 보여 주고 지운다 (TTY 에서만)
  code-agent docs                     공통 POLICY 4종 · KNOWLEDGE 3종 — 섹션·확정 상태
  code-agent confirm doc <all|종류>   공통 문서 한 번에 확정 또는 개별 확정 (TTY)
  code-agent confirm request <ID> [<지시서>]   1 요구사항 확정 (TTY 에서만) — 원문과 정리를 나란히 보여 주고 확정해야 작업이 시작된다
                                      지시서를 생략하면 doc/work/<ID>/requirement.md (손으로 쓴 지시서가 다른 자리면 경로를 준다)
  code-agent reject request <ID> [<지시서>] --comment <사유>   요구사항 반려 (TTY 에서만) — /ca-request 가 사유를 읽고 다시 정리한다
  code-agent approve                  제출된 계획 승인 (TTY 에서만)
  code-agent reject --comment <사유>  제출된 계획 반려 (TTY 에서만)
  code-agent abort                    진행 중인 작업 커서 지우기 (작업이 없으면 접수 세션을 닫는다)
  code-agent deliver                  13 반영 (TTY 에서만) — 게이트를 다시 돌리고 추적표·검증을 보여 준 뒤 작업 브랜치에 로컬 커밋. push · MR/PR 없음
  code-agent model [<에이전트|all> <모델|default>] [--host claude|codex] [--reasoning 강도]   역할별 모델 조회·변경·기본값 복원
  code-agent plugin add <이름> --command "<argv>" [--slots a,b] [--sends-code]   판정 플러그인 등록 (TTY 에서만 — 키는 ~/.code-agent 에)
  code-agent plugin remove <이름>     등록 해제 (TTY 에서만) — 키·동의를 함께 지운다
  code-agent plugin example [--out <경로>]   번들에 든 예시 어댑터를 파일로 꺼낸다 (기본 ./echo-adapter.js)

스킬이 부른다 (Claude Code 안):
  code-agent consent prepare <작업.json>   확인할 내용·파일·질문을 준비 (이 단계에서 승인·커밋하지 않음)
  code-agent consent status <ID>           실제 선택 응답과 다음 질문 조회
  code-agent consent apply <ID>            현재 세션에서 확인된 내용만 실행하고 계속 진행
  code-agent docs begin | end         문서 작성 세션 (도는 동안 문서 자리 밖 쓰기 금지, 열 때 KNOWLEDGE 빈 뼈대 생성)
  code-agent docs recommend           기존 구성 유지 또는 신규 시작 구성 추천
  code-agent docs setup <node|python>  선택한 신규 구성의 설정·공통 문서 생성 (기존 파일 보존)
  code-agent docs skeleton <종류>     빈 문서의 섹션 뼈대 (POLICY 4종 · knowledge · 작업 문서 01-requirements · 02-analysis · 03-design · 04-functional · 07-test-spec)
  code-agent docs interview <종류> [--sections a,b]   사용자 입력으로 채울 때 묻는 것
  code-agent docs link <종류> <경로...>  이미 있는 문서를 등록
  code-agent survey                   뼈대 역공학용 저장소 개요 (빌드·언어·구조·계층 후보·표본)
  code-agent manifest check           code-agent.json 이 실제 참조 파일을 찾는지
  code-agent plugin list              자리·기본 구현·감지된 무료 도구·등록된 플러그인·저장소 선언
  code-agent request begin [ID] --kind <feature|fix|refactor> [--base <기준 브랜치>] [--target <대상>]
                                      1 요구사항 접수를 연다 (도는 동안 그 작업 폴더 밖 쓰기 금지 · 시작 인자는 확정 뒤 start 가 쓴다)
  code-agent request                  접수 초안(request.json) 형식 · 규칙 · 대상 후보 · 지금 상태 (작업 중이면 그 작업의 요구사항을 고칠 때)
  code-agent request submit <request.json>   접수 초안 검사 → doc/work/<ID>/requirement.md 렌더 (확정은 사람이)
  code-agent start <지시서> [--target <대상>] [--base <기준 브랜치>]   사람이 확정한 요구사항만 받는다
  code-agent next                     게이트를 확인하고 다음 스테이지·단계로
  code-agent back <스테이지>          커서를 앞 스테이지로 되감기 — 앞으로는 못 가고, 증거·리뷰 회차·원장은 그대로 남는다
                                      ${BACK_PHASES.join(" | ")}
  code-agent context                  지금 스테이지에 필요한 것 (참조 코드·계획·규칙)
  code-agent read <파일> [시작 줄] [줄 수]  저장소 텍스트를 줄 번호와 함께 읽기 (기본 200줄, 최대 400줄)
  code-agent plan submit <초안.json>  계획 검사 후 제출
  code-agent planning prepare [작업.json]  현재 단계 작업 등록 (생략하면 기본 작업)
  code-agent planning advance         준비·재사용·선행 조건 판정 후 실행할 배정 묶음 반환
  code-agent planning status          배정·입력 변경·선행 조건·미결 질문 요약
  code-agent planning result <ID>     원문 산출물을 포함한 상세 결과와 최신성 조회
  code-agent planning repair <ID>     관찰된 출력 형식 오류를 같은 입력에서 한 번 교정
  code-agent planning dispatch <ID>   입력 묶음·담당 에이전트·결과 계약 반환 (같은 입력은 재사용)
  code-agent planning cancel <ID>     중단된 배정 취소 (이전 실행 결과는 거부)
  code-agent repro                    fix 전용 — 재현 TC 의 실패를 보고 증거로 남긴다 (그 전에는 고칠 파일을 쓸 수 없다)
  code-agent check                    8 정적 분석·컴파일 — build + 품질·보안 기준의 명령을 돌리고 증거로 기록
  code-agent test                     9 테스트 — test + 테스트 전략의 명령을 돌리고 ⑦ 의 TC별 실제 결과를 대조
  code-agent verify [--json] [--retry]  check·test 노드를 연속 실행하고 수정·실행 문제 확인·리뷰 요청을 반환 (retry는 check부터 재실행)
  code-agent review                   11 코드 리뷰 — 회차를 열고 독립 리뷰어의 시작·완료와 결과는 hook이 기록
  code-agent integrate                12 통합 검증 — 기준 커밋 위의 깨끗한 worktree 에서 전체 build · test

hook 이 부른다:
  code-agent codex-event              Codex 도구·사용자 메시지·서브 에이전트·종료 관찰 (stdin JSON)
  code-agent hook                     PreToolUse 판정 (stdin JSON)
  code-agent review-event             ca-reviewer 시작·완료 관찰 및 결과 기록 (stdin JSON)
  code-agent planning-event           분석·조사·설계·계획 담당의 시작·완료 관찰 (stdin JSON)
  code-agent consent-event            AskUserQuestion 시작·응답 관찰 및 확인 기록 (stdin JSON)
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

/** 검증 명령은 자식 프로세스를 기다린다 — main 이 async 인 유일한 이유다 */
async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === "codex-event") return runCodexHook(readFileSync(0, "utf-8"));
  if (command === "hook") {
    return runHook(readFileSync(0, "utf-8"));
  }
  if (command === "stop") {
    return runStopHook(readFileSync(0, "utf-8"));
  }
  if (command === "review-event") return runReviewHook(readFileSync(0, "utf-8"));
  if (command === "planning-event") return runPlanningHook(readFileSync(0, "utf-8"));
  if (command === "consent-event") return runConsentHook(readFileSync(0, "utf-8"));

  const repoRoot = findRepoRoot(process.cwd());
  const print = (text: string) => process.stdout.write(`${text}\n`);
  switch (command) {
    case "planning":
      if (args[0] === "prepare") print(preparePlanning(repoRoot, args[1] ? JSON.parse(readFileSync(args[1], "utf8")) : undefined));
      else if (args[0] === "advance") print(advancePlanning(repoRoot));
      else if (args[0] === "status") print(planningStatus(repoRoot));
      else if (args[0] === "result" && args[1]) print(planningResult(repoRoot, args[1]));
      else if (args[0] === "repair" && args[1]) print(repairPlanning(repoRoot, args[1]));
      else if (args[0] === "dispatch" && args[1]) print(dispatchPlanning(repoRoot, args[1]));
      else if (args[0] === "cancel" && args[1]) print(cancelPlanning(repoRoot, args[1]));
      else throw new Stop("planning advance | prepare [작업.json] | status | result <ID> | dispatch <ID> | repair <ID> | cancel <ID>");
      return 0;
    case "consent":
      if (args[0] === "prepare" && args[1]) print(prepareConsent(repoRoot, JSON.parse(readFileSync(args[1], "utf8"))));
      else if (args[0] === "status" && args[1]) print(consentStatus(repoRoot, args[1]));
      else if (args[0] === "apply" && args[1]) print(applyConsent(repoRoot, args[1]));
      else throw new Stop("사용법: code-agent consent prepare <작업.json> | status <ID> | apply <ID>");
      return 0;
    case "setup":
      if (args[0] && args[0] !== "baseline") throw new Stop("사용법: code-agent setup [baseline]");
      print(args[0] === "baseline" ? setupBaseline(repoRoot) : setupStatus(repoRoot));
      return 0;
    case "init":
      print(init(repoRoot, { cli: option(args, "cli"), host: parseHost(option(args, "host")) }));
      return 0;
    case "status":
      print(status(repoRoot));
      return 0;
    case "doctor": {
      const report = doctor(repoRoot, parseHost(option(args, "host")));
      print(report.text);
      return report.ok ? 0 : 1;
    }
    case "update":
      print(args.includes("--templates-only") ? update(repoRoot, { cli: option(args, "cli"), host: parseHost(option(args, "host")) }) : updateFromSource(repoRoot, { cli: option(args, "cli"), host: parseHost(option(args, "host")) }));
      return 0;
    case "usage":
      print(usage(repoRoot, { work: option(args, "work"), since: option(args, "since") }));
      return 0;
    case "knowledge":
      print(knowledge(repoRoot, args[0]));
      return 0;
    case "start":
      if (!args[0] || args[0].startsWith("--")) {
        throw new Stop("지시서 경로가 필요합니다: code-agent start <지시서>");
      }
      print(start(repoRoot, args[0], { target: option(args, "target"), base: option(args, "base") }));
      return 0;
    case "next":
      print(next(repoRoot));
      return 0;
    case "back":
      print(back(repoRoot, args[0] ?? ""));
      return 0;
    case "context":
      print(context(repoRoot));
      return 0;
    case "read":
      if (args.length < 1 || args.length > 3) throw new Stop("사용법: code-agent read <파일> [시작 줄] [줄 수]");
      print(readProjectFile(repoRoot, args[0], args[1] === undefined ? 1 : Number(args[1]), args[2] === undefined ? 200 : Number(args[2])));
      return 0;
    case "repro":
      print(await repro(requireReproable(repoRoot)));
      return 0;
    case "check":
      print(await check(requireValidatable(repoRoot, "check")));
      return 0;
    case "test":
      print(await runTests(requireValidatable(repoRoot, "test")));
      return 0;
    case "verify": {
      if (args.some((arg) => arg !== "--json" && arg !== "--retry")) throw new Stop("사용법: code-agent verify [--json] [--retry]");
      const result = await verify(repoRoot, { retry: args.includes("--retry") });
      print(args.includes("--json") ? JSON.stringify(result, null, 2) : renderVerification(result));
      return result.node === "review" ? 0 : 1;
    }
    case "review":
      print(openRound(requireValidatable(repoRoot, "review")));
      return 0;
    case "integrate":
      print(await integrate(requireValidatable(repoRoot, "integrate")));
      return 0;
    case "deliver":
      print(deliver(requireValidatable(repoRoot, "deliver")));
      return 0;
    case "plan":
      if (args[0] !== "submit" || !args[1]) {
        throw new Stop("사용법: code-agent plan submit <초안.json>");
      }
      print(submitPlan(repoRoot, args[1]));
      return 0;
    case "approve":
      print(decide(repoRoot, "approved", option(args, "comment")));
      return 0;
    case "reject":
      if (args[0] === "request") {
        const [id, spec] = positional(args.slice(1), ["comment"]);
        print(decideRequest(repoRoot, id, "rejected", option(args, "comment"), spec));
        return 0;
      }
      print(decide(repoRoot, "rejected", option(args, "comment")));
      return 0;
    case "request":
      switch (args[0]) {
        case undefined:
          print(requestFormat(repoRoot));
          return 0;
        case "begin":
          print(
            requestBegin(repoRoot, positional(args.slice(1), ["kind", "base", "target"])[0], option(args, "kind"), {
              base: option(args, "base"),
              target: option(args, "target"),
            }),
          );
          return 0;
        case "submit":
          print(requestSubmit(repoRoot, args[1]));
          return 0;
        default:
          throw new Stop("사용법: code-agent request [begin [ID] --kind <feature|fix|refactor> | submit <request.json>]");
      }
    case "abort":
      print(abort(repoRoot));
      return 0;
    case "docs":
      switch (args[0]) {
        case "recommend":
          print(recommendSetup(repoRoot));
          return 0;
        case "setup":
          print(setupProject(repoRoot, args[1]));
          return 0;
        case undefined:
          print(docsStatus(repoRoot));
          return 0;
        case "begin":
          print(docsBegin(repoRoot));
          return 0;
        case "end":
          print(docsEnd(repoRoot));
          return 0;
        case "skeleton":
          print(docsSkeleton(args[1]));
          return 0;
        case "interview":
          print(docsInterview(args[1], option(args, "sections")));
          return 0;
        case "link":
          print(docsLink(repoRoot, args[1], args.slice(2)));
          return 0;
        default:
          throw new Stop("사용법: code-agent docs [recommend | setup <node|python> | begin | end | skeleton <종류> | interview <종류> | link <종류> <경로...>]");
      }
    case "confirm":
      if (args[0] === "request") {
        const [id, spec] = positional(args.slice(1), []);
        print(decideRequest(repoRoot, id, "confirmed", undefined, spec));
        return 0;
      }
      if (args[0] !== "doc") {
        throw new Stop(
          "사용법: code-agent confirm doc <all | architecture | conventions | test-strategy | quality> | code-agent confirm request <ID>",
        );
      }
      print(confirmDoc(repoRoot, args[1]));
      return 0;
    case "model": {
      const host = parseHost(option(args, "host"));
      if (host === "both") throw new Stop("모델 변경 호스트는 claude 또는 codex 하나를 지정하세요.");
      const values = positional(args, ["host", "reasoning"]), reasoning = option(args, "reasoning");
      if (values.length > 2 || (!values.length && reasoning)) throw new Stop("모델 조회에는 --host만, 변경에는 역할·모델과 선택적인 --reasoning을 지정하세요.");
      print(values.length === 0 ? modelsTable(repoRoot, host) : setModel(repoRoot, values[0], values[1], {host,reasoning}));
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
    default:
      print(USAGE);
      return command === undefined || command === "help" || command === "--help" ? 0 : 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof Stop ? 1 : 2;
  },
);
