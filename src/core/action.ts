/**
 * 모델이 한 턴에 요청할 수 있는 행동들.
 *
 * 기존 `{files: [...]}` 응답을 일반화한 것이다. 파일을 만드는 것만이 아니라 "더 읽고 싶다",
 * "명령을 돌려 달라", "사람에게 묻고 싶다"까지 같은 자리에서 표현된다. 실행은 전부 코드가
 * 하므로, 전송이 사람의 클립보드든 API든 이 모델은 그대로다.
 */
export type Action =
  | { type: "write"; path: string; content: string }
  | { type: "edit"; path: string; find: string; replace: string }
  | { type: "read"; path: string }
  | { type: "list"; path: string }
  | { type: "run"; command: string }
  | { type: "ask"; question: string }
  | { type: "note"; text: string }
  | { type: "done" };

export type ActionType = Action["type"];

/** 파일을 바꾸는 액션 — 경계 검사를 받아야 하는 것들 */
export function isMutation(action: Action): action is Extract<Action, { type: "write" | "edit" }> {
  return action.type === "write" || action.type === "edit";
}

/** 결과를 되돌려줘야 하는 액션 — 이게 있으면 턴이 한 번 더 필요하다 */
export function isObservation(action: Action): action is Extract<
  Action,
  { type: "read" | "list" | "run" }
> {
  return action.type === "read" || action.type === "list" || action.type === "run";
}

/**
 * 프롬프트 끝에 붙이는 출력 형식 지시.
 *
 * JSON을 쓰지 않는 이유는 전송이 사람의 복사·붙여넣기이기 때문이다. 파일 내용을 JSON 문자열에
 * 넣으면 줄바꿈·따옴표를 전부 이스케이프해야 하는데, 채팅 응답에서 그게 한 글자만 틀려도 통째로
 * 파싱에 실패하고 어디가 틀렸는지도 알 수 없다. 코드블록은 이스케이프가 필요 없고, 사람이 눈으로
 * 읽어 고칠 수 있으며, 응답이 중간에 잘렸다는 사실까지 드러난다.
 */
export const ACTION_FORMAT = `# 출력 형식 — 반드시 지킬 것

설명·인사말 없이 **아래 지시 블록만** 출력한다. 각 블록은 \`### \` 로 시작한다.

\`\`\`\`
### write <저장소 루트 기준 상대경로>
\`\`\`
파일 전체 내용
\`\`\`

### edit <저장소 루트 기준 상대경로>
#### find
\`\`\`
원본에 정확히 일치하는 부분
\`\`\`
#### replace
\`\`\`
바꿀 내용
\`\`\`

### read <경로>

### list <디렉토리 경로>

### run <명령 키>

### ask
사람이 답해야 하는 질문 하나

### note
판단이 필요했던 지점

### done
\`\`\`\`

규칙:

- 파일 내용은 코드블록 안에 **그대로** 넣는다. 이스케이프하지 않는다.
- 내용 안에 \`\`\` 가 있으면 바깥 코드블록을 백틱 4개로 감싼다.
- 내용을 잘라내지 않는다. \`...\` 같은 생략 표시를 쓰지 않는다.
- \`edit\` 의 find 는 원본과 **공백까지 정확히** 일치해야 하고, 파일 안에서 한 곳에만 걸려야 한다.
- 더 봐야 할 파일이 있으면 추측해서 만들지 말고 \`read\` 만 요청한다. 결과를 받은 뒤 이어서 한다.
- 사람이 정해야 하는 것은 \`ask\` 로 묻는다. 임의로 고르지 않는다.
- 이번 단계에서 할 일이 끝났으면 마지막에 \`### done\` 을 넣는다.`;
