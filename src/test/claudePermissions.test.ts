import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { claudePermissionSummary } from "../agent/claudePermissions";
import { init } from "../agent/init";
import { createRepo, removeRepo, writeFixture } from "./repoFixture";

test("Claude 설치는 실행 권한을 안내하고 기존 allow·deny와 local 설정을 보존한다", () => {
  const root = createRepo("ca-permissions-");
  try {
    const permissions = { allow: ["Read", "Bash(code-agent status *)"], deny: ["Bash(code-agent update *)"] };
    writeFixture(root, ".claude/settings.json", JSON.stringify({ permissions }));
    const local = JSON.stringify({ permissions: { allow: ["Bash(code-agent *)"] } });
    writeFixture(root, ".claude/settings.local.json", local);
    const result = init(root);
    assert.match(result, /명령 실행 권한은 작업 동의와 별개/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")).permissions, permissions);
    assert.equal(readFileSync(join(root, ".claude/settings.local.json"), "utf8"), local);
    assert.match(claudePermissionSummary(root), /settings.json: Bash\(code-agent status \*\).*settings.local.json: Bash\(code-agent \*\)/);
    assert.match(claudePermissionSummary(root), /실효 권한은 Claude에서 확인/);
  } finally { removeRepo(root); }
});
