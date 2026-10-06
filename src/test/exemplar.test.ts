/**
 * 참조 표준 선정 — 코드가 결정론적으로 고른다는 축이 실제로 서는가.
 *
 * 여기서 판정되는 것은 둘이다. `{Ref}` 치환이 낱말 경계를 모르는 도메인에서도 실제 파일에 닿는가,
 * 그리고 상한에 걸려 잘린 것이 **잘렸다고 드러나는가**.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { collectExemplars } from "../core/exemplar";
import type { Manifest, StageDef } from "../core/manifest";

let root: string;

/**
 * 대소문자만 다른 파일 둘이 공존할 수 있는가. Windows(NTFS)·macOS 기본 볼륨은 아니다 —
 * 그 위에서는 "후보가 둘" 인 상황 자체가 생기지 않으므로 그 테스트는 건너뛴다.
 */
function caseSensitiveFs(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "code-agent-cs-"));
  try {
    writeFileSync(join(probe, "a.tmp"), "", "utf-8");
    return !existsSync(join(probe, "A.tmp"));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
const CASE_SENSITIVE = caseSensitiveFs();

function write(relative: string, content = "x = 1\n") {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

const MANIFEST: Manifest = {
  language: "python",
  sourceExtensions: [".py"],
  domainBase: "app/features",
  domainRoots: [],
  conventions: [],
  fixRounds: 2,
  commandTimeoutMinutes: 10,
  plugins: {},
  commands: {},
  docs: {},
  git: { base: "master" },
  workOrder: { attributes: [], requireApprover: false, requireVerifiedApproval: false },
  stages: [],
};

function stage(exemplars: string[]): StageDef {
  return {
    key: "model",
    title: "모델",
    template: "01-model.md",
    kind: "code",
    kinds: [],
    confirm: true,
    exemplars,
    scope: "domain",
    outputDirs: ["."],
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-exemplar-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("{Ref} 는 디스크의 실제 이름에 닿는다", () => {
  test("대소문자만 다른 파일이 하나면 그것을 쓴다 — salesmaterial → SalesMaterial", () => {
    // 도메인 디렉토리는 소문자 한 덩어리, 클래스 이름은 낱말 경계가 있다. 첫 글자만 올린
    // Salesmaterial.py 는 없다 — 하지만 디스크에는 답이 있다.
    write("app/features/salesmaterial/SalesMaterial.py");

    const { files, missing } = collectExemplars(root, MANIFEST, "salesmaterial", stage(["{Ref}.py"]));

    assert.equal(missing.length, 0);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "app/features/salesmaterial/SalesMaterial.py", "실제 이름으로 보고한다");
  });

  test(
    "대소문자만 다른 후보가 둘이면 고르지 않는다 — 추측한 참조는 없는 것보다 나쁘다",
    { skip: !CASE_SENSITIVE && "대소문자 구분 없는 파일시스템에서는 후보가 둘일 수 없다" },
    () => {
    write("app/features/salesmaterial/SalesMaterial.py");
    write("app/features/salesmaterial/Salesmaterial.py");

    const { files, missing } = collectExemplars(root, MANIFEST, "salesmaterial", stage(["{Ref}.py"]));

    assert.equal(files.length, 0);
    assert.deepEqual(missing, ["Salesmaterial.py"]);
    },
  );

  test(
    "정확히 같은 이름이 있으면 그것이 우선이다",
    { skip: !CASE_SENSITIVE && "대소문자 구분 없는 파일시스템에서는 두 파일이 하나로 합쳐진다" },
    () => {
      write("app/features/deal/Deal.py", "exact\n");
      write("app/features/deal/DEAL.py", "loose\n");

      const { files } = collectExemplars(root, MANIFEST, "deal", stage(["{Ref}.py"]));

      assert.equal(files.length, 1);
      assert.equal(files[0].content, "exact\n");
    },
  );
});

describe("상한에 잘린 것은 잘렸다고 드러난다", () => {
  test("디렉토리형 참조는 내용은 상한까지, 이름은 전부", () => {
    for (let index = 0; index < 8; index += 1) {
      write(`app/features/deal/command/C${index}.py`);
    }

    const { files, omitted } = collectExemplars(root, MANIFEST, "deal", stage(["command/"]));

    assert.equal(files.length, 5, "내용은 상한(5)까지");
    assert.equal(omitted.length, 1);
    assert.equal(omitted[0].pattern, "command/");
    assert.equal(omitted[0].shown, 5);
    assert.deepEqual(omitted[0].names, ["C5.py", "C6.py", "C7.py"], "나머지 이름은 전부 알려 준다");
  });

  test("상한 안이면 잘린 것이 없다고 말한다", () => {
    write("app/features/deal/command/A.py");

    const { omitted } = collectExemplars(root, MANIFEST, "deal", stage(["command/"]));

    assert.deepEqual(omitted, []);
  });

});
