#!/usr/bin/env node
"use strict";
/**
 * 단일 실행 파일(Node SEA) 만들기 — `npm run build:bin`.
 *
 * 산출물은 **이 OS 것 하나**다. 5단계가 *지금 도는* node 실행 파일을 복사해 거기에 blob 을 주입하므로
 * 크로스 컴파일이 되지 않는다. Windows·macOS·Linux 각각에서 한 번씩 돌린다.
 *
 * 배포용 코드 서명은 여기서 하지 않는다 — 인증서가 이 저장소에 없다. macOS 의 ad-hoc 서명만 한다
 * (그것이 없으면 arm64 에서 실행 자체가 되지 않는다). 자세한 것은 doc/install.md.
 */
const { execFileSync } = require("node:child_process");
const { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const OUT = "dist-bin";
/** 이 값이 없으면 postject 가 주입할 자리를 찾지 못한다 (`Could not find the sentinel`) */
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const DARWIN = process.platform === "darwin";
const EXE = join(OUT, process.platform === "win32" ? "code-agent.exe" : "code-agent");

function node(args) {
  process.stdout.write(`  $ node ${args.join(" ")}\n`);
  execFileSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
}

function tool(command, args) {
  process.stdout.write(`  $ ${command} ${args.join(" ")}\n`);
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit" });
}

/** ROOT 기준 `/` 상대경로. SEA 의 자원 키는 이 문자열이고, npm 모드의 파일 경로와 같아야 한다 */
function walk(dir, out = []) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/**
 * 0. 이 Node 로 만들어도 되는가.
 *
 * `node:sea.getAssetKeys` 는 **24.8** 에 들어왔다. 그것이 없는 Node 로 묶으면 빌드는 조용히 끝나지만,
 * 나온 바이너리는 자기가 단일 실행 파일인 줄 모르고 실행 파일 두 단계 위의 패키지 폴더를 읽으려다
 * 맨 ENOENT 로 죽는다 (init 도 doctor 도). doctor 는 Node 22 이상을 받고 install.md §1 도 그렇게
 * 적어 두므로, 22 로 빌드하는 사람이 실제로 있을 수 있다 — 여기서 선다.
 */
{
  let hasAssetKeys = false;
  try {
    hasAssetKeys = typeof require("node:sea").getAssetKeys === "function";
  } catch {
    hasAssetKeys = false; // node:sea 자체가 없는 Node
  }
  if (!hasAssetKeys) {
    throw new Error(
      `단일 실행 파일은 Node 24.8 이상에서만 만듭니다 — 지금 ${process.version} 에는 node:sea.getAssetKeys 가 없어, ` +
        "만들어도 안에 든 템플릿을 읽지 못하는 바이너리가 나옵니다.",
    );
  }
}

// 0-1. 이전 산출물을 치운다 — 이미 주입된 exe 에 다시 주입하면 두 번 들어간다
rmSync(join(ROOT, OUT), { recursive: true, force: true });
mkdirSync(join(ROOT, OUT), { recursive: true });

// 1. 타입 검사 + dist/ — 번들은 src 에서 바로 뜨지만, 타입이 깨진 채로 바이너리를 내지는 않는다
node([join(ROOT, "node_modules", "typescript", "bin", "tsc")]);

// 2. 한 파일로 묶는다 (zod 포함). node:sea 는 런타임에 잡는 것이라 밖으로 둔다
node([
  join(ROOT, "node_modules", "esbuild", "bin", "esbuild"),
  "src/agent/cli.ts",
  "--bundle",
  "--platform=node",
  `--target=node${process.versions.node.split(".")[0]}`,
  "--format=cjs",
  "--external:node:sea",
  `--outfile=${OUT}/bundle.cjs`,
]);

// 3. 설정 — template/ 아래 전 파일과 package.json(버전을 읽는다)을 자원으로 넣는다
const assets = {};
for (const file of walk("template")) assets[file] = file;
assets["package.json"] = "package.json";
const config = `${OUT}/sea-config.json`;
writeFileSync(
  join(ROOT, config),
  `${JSON.stringify(
    {
      main: `${OUT}/bundle.cjs`,
      output: `${OUT}/prep.blob`,
      disableExperimentalSEAWarning: true,
      // 코드 캐시는 빌드 Node 와 주입 대상 Node 가 같아야 하고, 스냅샷은 최상위에서 쓸 수 있는 API 를
      // 제한한다. 지금 얻을 것이 없다.
      useSnapshot: false,
      useCodeCache: false,
      assets,
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`  자원 ${Object.keys(assets).length}개\n`);

// 4. blob
node(["--experimental-sea-config", config]);

// 5. 이 PC 의 node 를 복사한다 — 그래서 크로스 컴파일이 안 된다
copyFileSync(process.execPath, join(ROOT, EXE));
// macOS 는 서명이 붙어 있으면 주입이 깨진다. 떼고 주입한 뒤 ad-hoc 으로 다시 붙인다
if (DARWIN) tool("codesign", ["--remove-signature", EXE]);

// 6. 주입
node([
  join(ROOT, "node_modules", "postject", "dist", "cli.js"),
  EXE,
  "NODE_SEA_BLOB",
  `${OUT}/prep.blob`,
  "--sentinel-fuse",
  FUSE,
  ...(DARWIN ? ["--macho-segment-name", "NODE_SEA"] : []),
]);
if (DARWIN) tool("codesign", ["--sign", "-", EXE]);

const size = (statSync(join(ROOT, EXE)).size / (1024 * 1024)).toFixed(1);
process.stdout.write(
  [
    "",
    `${EXE} (${size} MB) — 이 OS(${process.platform}) 용입니다. 다른 OS 것은 그 OS 에서 만드세요.`,
    process.platform === "win32"
      ? "주입이 Authenticode 서명을 깨뜨립니다 (postject 의 경고는 정상). 배포하려면 signtool 로 다시 서명하세요 — doc/install.md."
      : DARWIN
        ? "ad-hoc 서명만 되어 있습니다. 배포하려면 실제 ID 로 서명하고 notarize 하세요 — doc/install.md."
        : "서명 단계는 없습니다.",
    "",
  ].join("\n"),
);
