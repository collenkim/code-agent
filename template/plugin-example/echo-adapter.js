#!/usr/bin/env node
// code-agent 플러그인 어댑터의 가장 작은 예시.
//
// 어댑터는 **stdin 으로 JSON 한 벌을 받아 stdout 으로 JSON 한 벌을 낸다** (hook 과 같은 규약, 언어 무관).
// 이 파일은 `candidates.rank` 자리 하나를 채우고, 경로 문자열만 보고 점수를 매긴다 —
// 파일 내용을 읽지 않으니 `sendsCode` 는 false 이고 키도 필요 없다.
//
// 등록:
//   code-agent plugin add example --command "node <패키지>/template/plugin-example/echo-adapter.js"
//   그리고 저장소의 code-agent.json 에  "plugins": { "example": { "slots": ["candidates.rank"] } }
//
// 규칙 셋만 지키면 어떤 언어로 써도 된다.
//   1. 응답에 protocol "code-agent.plugin" · version "1" · **요청의 requestId 를 그대로** 싣는다
//      (하나라도 다르면 code-agent 가 응답을 버린다 — 앞 호출의 답을 캐시해 되돌려 주는 길을 막는 검사다).
//   2. stdout 에는 JSON 한 벌만 — 로그·진행 표시는 전부 stderr 로.
//   3. 실패는 프로세스를 죽이지 말고 {"ok": false, "error": "<사람이 읽을 이유>"} 로 알린다.
//      어느 쪽이든 code-agent 는 기본 구현으로 떨어지고 한 줄 알릴 뿐, 명령을 세우지 않는다.

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  let request;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    // 요청을 못 읽으면 requestId 도 모른다 — exit 1 로 알린다.
    process.stderr.write("요청이 JSON 이 아닙니다\n");
    process.exit(1);
  }
  const reply = (body) =>
    process.stdout.write(
      JSON.stringify({
        protocol: "code-agent.plugin",
        version: "1",
        requestId: request.requestId,
        ...body,
      }),
    );

  if (request.protocol !== "code-agent.plugin" || request.version !== "1") {
    // 모르는 규약이면 지어내지 않고 말한다 — code-agent 는 기본 구현으로 떨어진다.
    return reply({ ok: false, error: `이 어댑터는 version "1" 만 압니다 (받은 것: ${request.version})` });
  }

  if (request.op === "describe") {
    // 등록 때 한 번. 무엇을 채우고, 코드를 밖으로 보내는지, 키가 필요한지를 어댑터가 스스로 밝힌다.
    return reply({
      ok: true,
      output: {
        name: "example",
        adapterVersion: "1.0.0",
        slots: ["candidates.rank"],
        sendsCode: false,
        // 키가 필요하면 secret: { required: true, delivery: "stdin" } — delivery 는 뺄 수 없다
        // ("env" 로 받으려면 { required: true, delivery: "env", env: "MY_API_KEY" }).
        // 필요 없으면 secret 을 아예 쓰지 않는다.
        note: "경로 문자열만 보고 순위를 매깁니다 — 파일 내용을 읽지도, 네트워크를 쓰지도 않습니다",
      },
    });
  }

  if (request.op === "probe") {
    // 등록 때 한 번. 실패하면 등록이 되지 않는다 — 키·엔드포인트를 여기서 확인한다.
    return reply({ ok: true, output: { ready: true, detail: "로컬 전용 — 확인할 것이 없습니다" } });
  }

  if (request.op === "run" && request.slot === "candidates.rank") {
    const keywords = (request.input.keywords ?? []).map((word) => word.toLowerCase());
    const ranked = request.input.files
      .map((file) => {
        const path = file.path.toLowerCase();
        const hits = keywords.filter((word) => path.includes(word));
        return { path: file.path, score: keywords.length ? hits.length / keywords.length : 0, why: hits.join(" · ") };
      })
      .filter((row) => row.score > 0)
      // 동점은 경로 사전순 — 같은 트리에서 항상 같은 순서가 나와야 한다.
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, request.input.limit ?? 20);
    return reply({ ok: true, output: { ranked } });
  }

  reply({ ok: false, error: `이 어댑터가 모르는 요청입니다: op=${request.op} slot=${request.slot ?? "-"}` });
});
