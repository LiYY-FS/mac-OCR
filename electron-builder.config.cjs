/**
 * electron-builder 配置文件（取代 package.json 中的 "build" 键）。
 *
 * 打包策略：通用（Universal）打包。mac.target 的 arch 设为 ['universal']，
 * electron-builder 会分别下载 x64 与 arm64 的 Electron 二进制，并用 lipo
 * 合并为单一通用 Mach-O，产出一个同时兼容 Intel 与 Apple Silicon 的 .app，
 * 最终由 build.sh 经 hdiutil 封装为单一 .dmg，任何 Mac 均可直接安装使用。
 *
 * 注意：不要在此固定 electronDist 为本地单架构 electron——通用打包要求
 * electron-builder 自行拉取两套架构并合并，固定 electronDist 会破坏通用构建。
 *
 * 签名与公证通过环境变量驱动，无需修改本文件：
 *   export CSC_NAME="Developer ID Application: Your Name (TEAMID)"
 *   export APPLE_API_KEY="/path/to/AuthKey_*.p8"
 *   export APPLE_API_KEY_ID="KEYID"
 *   export APPLE_API_ISSUER="UUID"  # App Store Connect 团队中的 Issuer ID
 *
 * 或使用 Apple ID + 专用密码：
 *   export APPLE_ID="you@example.com"
 *   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
 *   export APPLE_TEAM_ID="10位TeamID"
 *
 * 未设置上述变量时：本地构建不签名、不公证（仅限本机自用）。
 *
 * @type {import('electron-builder').Configuration}
 */
const fs = require('fs');

/**
 * 仅当 OCR 引擎二进制存在时才列为需要解包的资源。
 * CI 环境可能因 swiftc 不可用而跳过编译，避免 electron-builder 报文件不存在。
 */
const ocrBin = 'electron/screen-ocr-engine.bin';
const asarUnpack = ['electron/ocr.swift'];
if (fs.existsSync(ocrBin)) {
  asarUnpack.push(ocrBin);
}

const identity = process.env.CSC_NAME || null;
const hasNotarizeCreds = identity && Boolean(
  (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)
  || (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)
);

module.exports = {
  appId: 'com.idl.ocr',
  productName: 'mac-OCR',
  copyright: 'Copyright © 2026',
  directories: {
    output: 'release',
    buildResources: 'public/img',
  },
  files: [
    'dist/**/*',
    'electron/**/*',
    '!electron/dev.mjs',
    'public/**/*',
    'package.json',
    '!node_modules',
    '!**/node_modules/**/*',
    '!dist/**/*.map',
  ],
  asar: true,
  asarUnpack,
  npmRebuild: false,
  nodeGypRebuild: false,
  compression: 'maximum',
  electronLanguages: ['en', 'zh-CN'],
  mac: {
    target: [
      {
        target: 'dir',
        arch: ['universal'],
      },
    ],
    category: 'public.app-category.productivity',
    darkModeSupport: true,
    // hardenedRuntime + entitlements 是 macOS 公证（notarization）的前置条件。
    // 开启后 electron-builder 打包时会以 "runtime" 选项签名，使 .app 可被公证。
    // 仅在签名身份可用时启用，否则 electron-builder 会因无身份而报错。
    hardenedRuntime: Boolean(identity),
    gatekeeperAssess: false,
    identity,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // CSC_NAME 且公证凭据就绪时启用 notarize；true 让 electron-builder 从环境变量
    // 自动检测认证方式（APPLE_API_KEY 系列 或 APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD）。
    // 仅用 API Key 时 teamId 可省略，electron-builder 会从 APPLE_API_ISSUER 推断。
    notarize: hasNotarizeCreds ? true : false,
    icon: 'public/img/icon.png',
    // 预编译的 OCR 引擎为单文件原生二进制（electron/screen-ocr-engine.bin），
    // 通用打包时会被原样打进 x64 / arm64 两个切片。编译阶段已尽量将其产出为
    // 通用（fat）二进制，合并步骤会直接接受；若某环境回退为单架构，此处声明
    // x64ArchFiles 让 @electron/universal 跳过该文件（异架构 Mac 经 Rosetta 运行
    // OCR），避免合并因"两份相同的单架构二进制"而报错。
    x64ArchFiles: '**/screen-ocr-engine.bin',
  },
};
