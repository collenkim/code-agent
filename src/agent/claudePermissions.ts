import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const CLAUDE_PERMISSION_GUIDE = "Claude 명령 실행 권한은 작업 동의와 별개입니다. 반복 확인은 Claude 권한 화면에서 필요한 code-agent 명령 규칙을 검토해 설정하세요(doc/install.md의 명령 실행 권한). init은 허용 규칙을 자동 추가하지 않습니다. --setting-sources project는 settings.local.json의 규칙을 읽지 않습니다.";

/** 프로젝트 파일에 기록된 규칙만 보여 준다. 호스트의 사용자·관리 정책과 실행 인자를 합친 실효 권한 판정은 아니다. */
export function claudePermissionSummary(root: string): string {
  return ["settings.json", "settings.local.json"].map(name => {
    const file = join(root, ".claude", name);
    if (!existsSync(file)) return `${name}: 없음`;
    try {
      const allow: unknown = JSON.parse(readFileSync(file, "utf8")).permissions?.allow;
      const rules = Array.isArray(allow) ? allow.filter((rule): rule is string => typeof rule === "string" && /^Bash\(code-agent(?:\.cmd)?(?:[ :*]|\))/.test(rule)) : [];
      return `${name}: ${rules.length ? rules.join(" · ") : "code-agent 허용 규칙 없음"}`;
    } catch { return `${name}: 읽기·형식 확인 필요`; }
  }).join("; ") + "; 사용자·관리 정책과 실행 인자를 포함한 실효 권한은 Claude에서 확인합니다";
}
