# 跨平台技术架构设计：macOS → Windows 无缝扩展

> 文档类型：架构决策与设计（ADR + 实施方案）
> 适用范围：`idl` 屏幕 OCR 桌面应用（Electron 43 + React 18 + Vite 5 + Tailwind v4）
> 目标：保留 macOS 全部现有能力，新增 Windows 支持，且后续可平滑扩展 Linux。
> 依据：基于本仓库真实代码（`electron/main.mjs`、`preload.mjs`、`build.sh`、`electron-builder.config.cjs`、`src/lib/desktopHost*`、`docs/DEV_DOCS.md`）分析，非凭空假设。

---

## 0. 现状盘点（代码实证）

### 0.1 现有 macOS 功能模块

| 模块 | 实现位置 | 平台耦合点 |
|------|----------|-----------|
| 离线 OCR | `ocr.swift` → `screen-ocr-engine.bin`（Apple Vision），`main.mjs:recognizeTextFromImage` | **强耦合**：Swift/Mach-O 二进制，`spawn('swiftc'/'swift')` 回退；非 darwin 直接抛错 |
| 屏幕捕获 | `desktopCapturer` + 每显示器 overlay `BrowserWindow` | 捕获内核跨平台；选区 overlay 与权限（TCC）macOS 专属 |
| 长截图拼接 | `stitcher.html`（Canvas，跨平台）+ `mergeLongCaptureText`（TS） | 几乎无耦合，可全量复用 |
| 全局快捷键 | `globalShortcut` | 跨平台 API，复用 |
| 托盘菜单 | `Tray`/`Menu` + `setTemplateImage` | API 跨平台；模板图标与行为 mac 专属 |
| 开机自启动 | 三通道：①`setLoginItemSettings` ②AppleScript ③LaunchAgent plist | **强耦合**：②/③纯 macOS |
| 权限模型 | `systemPreferences` 检测屏幕录制 | **强耦合**：macOS TCC |
| 窗口外壳 | `vibrancy`/`titleBarStyle:'customButtonsOnHover'`/`visualEffectState` | **强耦合**：仅 macOS 的 `BrowserWindow` 选项 |
| 持久化 | `userData/desktop-state.json` | 跨平台（`app.getPath`） |
| **IPC 边界** | `preload.mjs` → `contextBridge` → `window.desktopHost` | **无耦合，已跨平台** ← 核心可保留资产 |

### 0.2 关键发现

1. **IPC 契约是干净的**：渲染进程只依赖 `window.desktopHost` 的 TS 接口（`src/types/desktop-host.d.ts`），完全不涉及平台。这意味着**跨平台改造只需重构主进程实现，渲染进程与 preload 可零改动**。
2. **平台判断散落**：`main.mjs` 中 `process.platform === 'darwin'` 以散点 `if` 形式出现（自启动、OCR 报错），没有抽象层。这是扩展到 Windows 的最大阻力。
3. **构建脚本 100% macOS 专属**：`build.sh` 依赖 `hdiutil`/`codesign`/`osascript`/`sips`/`swiftc`，无任何跨平台分支；Windows 需要平行的另一套打包链路。
4. **OCR 是移植成本最高点**：引擎本体为 Apple Vision 原生二进制，Windows 必须提供等价引擎。其上层（图像解码 → 临时 PNG → `spawn` → 解析 `{"text":"..."}` → 文本后处理）是平台无关的，应完整保留。

---

## 1. 设计原则

| 原则 | 落地方式 |
|------|----------|
| **IPC 边界不可破** | `desktopHost` API 契约冻结，渲染进程零改动；所有平台差异收敛到主进程实现层 |
| **依赖倒置（DIP）** | 共享业务代码只依赖 `PlatformService` 接口，不依赖具体 OS 实现 |
| **运行时工厂 > 条件编译** | 主用运行时 `process.platform` 工厂分发，宁可有两份小实现，也不要 `#ifdef` 污染单一文件 |
| **复用优于重写** | 能跨平台的（overlay HTML、长截图拼接、快捷键、持久化、IPC）100% 复用；只替换原生介质 |
| **可测试性内建** | 每个平台实现都可被 mock，CI 双平台矩阵验证 |
| **YAGNI** | 不预设 Linux/移动端目录；但抽象层留 `factory` 扩展点，新增平台只需加一个实现类 |

---

## 2. 跨平台抽象层设计（核心）

### 2.1 分层结构（C4 组件视图）

```
┌──────────────────────────────────────────────────────────────────────┐
│  Renderer (React)  —— 仅依赖 window.desktopHost（已跨平台，不改）        │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ IPC (contextBridge, 不变)
┌───────────────────────────▼──────────────────────────────────────────┐
│  Electron Main  ──  IPC Handlers（薄层，只做参数校验 + 委托）            │
│       │                                                                 │
│       ├──► createPlatformService()  ── 工厂（按 process.platform 分发） │
│       │                                                                 │
│       ├── PlatformService 接口                                          │
│       │     ├── ocr:            OcrEngine                               │
│       │     ├── autoLaunch:     AutoLaunchProvider                     │
│       │     ├── permissions:    PermissionManager                       │
│       │     ├── screenCapture:  CaptureProvider                         │
│       │     ├── windowChrome:   WindowChromePolicy                      │
│       │     ├── tray:           TrayProvider                           │
│       │     └── packaging:      PackagingMeta                          │
│       │                                                                 │
│       ├── macPlatformService  (electron/platform/mac/*)                │
│       └── winPlatformService  (electron/platform/win/*)                │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 接口契约（TypeScript，置于 `electron/platform/types.ts`）

```ts
export interface PlatformService {
  readonly platform: 'mac' | 'win';
  readonly ocr: OcrEngine;
  readonly autoLaunch: AutoLaunchProvider;
  readonly permissions: PermissionManager;
  readonly capture: CaptureProvider;
  readonly windowChrome: WindowChromePolicy;
  readonly tray: TrayProvider;
}

export interface OcrEngine {
  isAvailable(): boolean;
  /** dataUrl -> 识别文本；契约与现有 {"text":"..."} 解析保持一致 */
  recognize(imageDataUrl: string): Promise<{ text: string }>;
}

export interface AutoLaunchProvider {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): { success: boolean; error?: string };
}

export interface PermissionManager {
  /** 'granted' | 'denied' | 'unknown' | 'unsupported' */
  checkScreenCapture(): 'granted' | 'denied' | 'unknown' | 'unsupported';
  openSettings(): void;
}

export interface CaptureProvider {
  /** 返回桌面源（跨平台用 desktopCapturer；mac 额外处理 TCC） */
  listSources(): Promise<Electron.DesktopCapturerSource[]>;
  /** 选区 overlay 所需的窗口选项（mac 给 vibrancy，win 给 transparent+自定义标题栏） */
  overlayWindowOptions(): Electron.BrowserWindowConstructorOptions;
}

export interface WindowChromePolicy {
  baseWindowOptions(): Electron.BrowserWindowConstructorOptions;
  /** 是否需要自定义标题栏拖拽区（win 需要，mac 用 traffic-light） */
  needsCustomTitleBar(): boolean;
}

export interface TrayProvider {
  iconPath(): string;          // mac: template png；win: .ico
  templateImage(): boolean;
}
```

### 2.3 工厂（单一分发点，`electron/platform/index.ts`）

```ts
import { PlatformService } from './types';
import { MacPlatformService } from './mac';
import { WinPlatformService } from './win';

let instance: PlatformService | null = null;

export function createPlatformService(): PlatformService {
  if (instance) return instance;
  switch (process.platform) {
    case 'darwin': instance = new MacPlatformService(); break;
    case 'win32':  instance = new WinPlatformService();  break;
    default: throw new Error(`Unsupported platform: ${process.platform}`);
  }
  return instance;
}
```

> **关键约束**：共享业务代码（IPC handler、长截图、快捷键、持久化）只允许 `import { createPlatformService }`，**禁止**直接 `import 'node:child_process'` 调 `osascript`/`swiftc` 或读写 `~/Library/LaunchAgents`。所有原生介质访问一律下沉到 `platform/<os>/`。

### 2.4 目录重构目标

```
electron/
├── main.mjs (或拆分为 main.ts)        # 仅注册 app 生命周期 + 委托 IPC
├── ipc/
│   └── handlers.ts                    # 薄 handler，委托 platformService
├── platform/
│   ├── types.ts                       # 上面的接口契约
│   ├── index.ts                       # 工厂（唯一分发点）
│   ├── mac/
│   │   ├── MacPlatformService.ts
│   │   ├── ocr.mjs                    # 复用现有 ocr.swift + 二进制解析
│   │   ├── autoLaunch.mjs            # AppleScript + LaunchAgent（现有逻辑搬入）
│   │   ├── permissions.mjs           # systemPreferences TCC
│   │   ├── windowChrome.mjs          # vibrancy 等 mac 专属选项
│   │   └── tray.mjs
│   └── win/
│       ├── WinPlatformService.ts
│       ├── ocr.mjs                    # Windows OCR 引擎接入（见 §4.3）
│       ├── autoLaunch.mjs            # 注册表/Startup 快捷方式
│       ├── permissions.mjs           # Windows 隐私设置/能力声明
│       ├── windowChrome.mjs          # transparent + 自定义标题栏
│       └── tray.mjs
├── ocr.swift                         # 保留（mac 编译源）
└── stitcher.html                     # 保留（跨平台复用）
```

> 重构以**行为不变**为前提逐步迁移：先把 `main.mjs` 现有 macOS 逻辑原样搬到 `platform/mac/*`，工厂默认返回 mac，跑通后再实现 `platform/win/*`。这保证迁移过程 macOS 功能零回归。

---

## 3. 模块级 Windows 实现路径与复用方案

| 模块 | macOS 现有实现 | Windows 复用度 | Windows 实现路径 |
|------|----------------|----------------|------------------|
| **IPC 边界** | `preload.mjs` + `desktop-host.d.ts` | **100%** | 完全不改 |
| **长截图拼接** | `stitcher.html` + `mergeLongCaptureText` | **100%** | 完全不改 |
| **全局快捷键** | `globalShortcut` | **100%** | 完全不改（accelerator 字符串跨平台） |
| **持久化** | `userData/desktop-state.json` | **100%** | 完全不改 |
| **屏幕捕获** | `desktopCapturer` + overlay 窗口 | **~85%** | 捕获内核复用；overlay HTML 组件复用；仅 `overlayWindowOptions()` 与权限引导分平台 |
| **托盘菜单** | `Tray`/`Menu` + 模板图标 | **~80%** | API 复用；图标换 `.ico`，去掉 `setTemplateImage` |
| **OCR** | Apple Vision 二进制 | **~30%（仅上层管道）** | 引擎替换（见 §4.3），上层 decode→spawn→解析→后处理 全复用 |
| **开机自启动** | 三通道（含 AppleScript/LaunchAgent） | **~40%** | 用 `setLoginItemSettings`（Windows 走注册表）+ Startup 文件夹快捷方式兜底；删 AppleScript/LaunchAgent |
| **窗口外壳** | `vibrancy`/`titleBarStyle` | **~20%** | Windows 用 `frame:false`+透明窗体+CSS 自定义标题栏，或 `titleBarOverlay` |
| **权限模型** | `systemPreferences` TCC | **~30%** | Windows 无 TCC；改为隐私设置页跳转 + 运行时能力声明；UX 文案分平台 |
| **构建/打包** | `build.sh`（hdiutil/dmg） | **0%** | 平行 `build-win.mjs` + electron-builder `win` target（见 §5） |

**复用总览**：约 6/11 模块可近乎零成本复用，3 个模块（OCR/自启动/窗口外壳/权限）需平台实现替换但业务逻辑保留。

---

## 4. 平台差异处理细则

### 4.1 文件路径
- 现状已较规范（`node:path`/`os.tmpdir()`/`app.getPath('userData')`），**保持**。
- 仅两处需分平台解析，统一收口到 `PlatformService`：
  - OCR 二进制名：`screen-ocr-engine.bin`（mac）vs `screen-ocr-engine.exe`（win），由 `ocr.binaryPath()` 提供；
  - 临时 PNG 路径：两者均用 `os.tmpdir()`，无需区分。
- `asarUnpack` 列表按 OS 生成（见 §5）。

### 4.2 系统 API
- 任何 OS 原生调用（mac 的 `osascript`/`swiftc`/LaunchAgent；win 的 `reg`/`powershell`/注册表）**一律禁止出现在共享代码**，只能存在于 `platform/<os>/`。
- 共享层通过接口方法获得能力，例如 `platformService.autoLaunch.setEnabled(true)` 内部 mac 走 LaunchAgent、win 写 Startup 快捷方式，调用方无感知。

### 4.3 进程管理
- OCR 引擎以**独立 sidecar 进程**形式 `spawn`/`execFile` 调用，模式本身跨平台。
- mac：产物为 Mach-O，开发态可 `swiftc` 即时编译回退；
- win：**无 `swiftc` 回退**，必须预编译好 `.exe` 随包分发（与 mac 打包期预编译策略一致）。进程生命周期（启停、超时、stdout 解析、临时文件清理）抽成 `OcrEngine` 基类，mac/win 仅覆盖 `binaryPath()` 与可选参数。
- 其余子进程（无）保持现状。

### 4.4 权限模型
- **macOS（TCC）**：运行时弹窗、易失效、需 ad-hoc 签名稳定化（现有 `build.sh` 已处理）→ `permissions.mjs` 保留 `systemPreferences` 检测 + `openScreenCapturePreferences` 跳「安全性与隐私」。
- **Windows**：屏幕捕获在 Win10+ 受「设置→隐私→屏幕截图」保护，但 Electron `desktopCapturer` 通常已获授权；无需 TCC 式弹窗。实现 `openSettings()` 跳 `ms-settings:privacy-screen`；`checkScreenCapture()` 在 win 返回 `'unsupported'`（不可程序化检测）或基于首次捕获是否返回空源判断。
- 渲染层权限提示文案、引导按钮通过 `platformService.permissions` 暴露的文案/链接分平台，避免硬编码 mac 文案。

---

## 5. 构建与打包流程

### 5.1 拆分 `build.sh`
将单文件脚本拆为：

```
scripts/
├── build-frontend.mjs   # 跨平台：tsc -b && vite build（node 实现，mac/win 通用）
├── build-ocr-mac.mjs    # swiftc 编译 ocr.swift → .bin（仅 mac CI 跑）
├── build-ocr-win.mjs    # 编译/获取 win OCR 引擎 → .exe（仅 win CI 跑）
├── build-mac.mjs        # 调 electron-builder --mac + 生成 dmg（保留 hdiutil 逻辑）
└── build-win.mjs        # 调 electron-builder --win（NSIS/Squirrel）
```

根 `package.json` 增加：
```json
"scripts": {
  "dist:mac": "node scripts/build-frontend.mjs && node scripts/build-ocr-mac.mjs && node scripts/build-mac.mjs",
  "dist:win": "node scripts/build-frontend.mjs && node scripts/build-ocr-win.mjs && node scripts/build-win.mjs"
}
```

### 5.2 electron-builder 双 target（`electron-builder.config.cjs` 扩展）

```js
module.exports = {
  appId: 'com.idl.ocr',
  productName: 'idl-OCR',
  mac:   { /* 现有 universal/dmg/notarize 逻辑原样保留 */ },
  win:   {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    icon: 'public/img/icon.ico',
    artifactName: '${productName}-${version}-setup.${ext}',
    // Authenticode 签名：通过 env 注入证书，无需改文件
    // CSC_LINK / CSC_KEY_PASSWORD 或 AZURE_KEY_VAULT
  },
  nsis:  { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
  asarUnpack: process.platform === 'win32'
    ? ['electron/ocr-win.exe', 'electron/ocr.swift']
    : ['electron/screen-ocr-engine.bin', 'electron/ocr.swift'],
};
```

### 5.3 CI 双平台矩阵（推荐 GitHub Actions）

```
jobs:
  build-mac: runs-on: macos-latest   # 需 mac runner 才能公证
  build-win: runs-on: windows-latest # 需 win runner 才能 Authenticode
```
- 签名：mac 用 `CSC_NAME`+`APPLE_API_KEY*`；win 用 `CSC_LINK`(p12)+`CSC_KEY_PASSWORD`（或 Azure Key Vault），均走 secret，不进仓库。
- 产物分别上传 artifact，release 时合并为跨平台发布。

---

## 6. 自动化测试（双平台覆盖）

| 层级 | 内容 | 环境 | 平台策略 |
|------|------|------|----------|
| 单元测试（共享逻辑） | `mergeLongCaptureText`、选区坐标缩放、`createPlatformService` 工厂选择 | `vitest` + `node` env | 每个 OS 提供 mock 实现，验证工厂分发正确 |
| 平台实现单测 | `win/autoLaunch`、`win/permissions` 等 | `vitest`+`node` | 在对应 runner 上跑真实实现；跨平台 runner 上跑 mock |
| IPC 契约测试 | 渲染层只依赖 `desktopHost` 接口 | `jsdom`（现有） | 用 mock `platformService` 注入，验证 handler 委托正确 |
| 引擎契约测试 | 喂固定 PNG，断言 OCR 输出文本 | win/mac runner 各跑 | 校验 `OcrEngine.recognize` 契约一致 |
| E2E | 启动真实 app → 触发捕获 → 结果回填 | Playwright + electron | mac/windows runner 双跑 |

- 现有 `test:vitest` 保留；新增 `test:node`（node env）以测试主进程逻辑。
- `setup-tests.ts` 增加全局 mock：`vi.mock('../platform', ...)` 让渲染测试不依赖真实 OS。

---

## 7. 依赖管理与条件编译策略

1. **主用运行时工厂**（§2.3），不引入编译期 `#ifdef`，保持单一打包产物逻辑。
2. **原生依赖按 OS 可选安装**：将 macOS/Windows 专属的 npm 原生包（如有，如 `node-mac-permissions`）放入 `optionalDependencies`，或用**动态 `import()`** 懒加载，避免跨平台 `pnpm install` 失败。
3. **`package.json` 可选依赖声明示例**：
   ```json
   "optionalDependencies": {
     "node-mac-permissions": ">=2.0.0"   // os: darwin
   }
   ```
   Windows 专属包同理；缺失时 `platform/<os>` 内部降级，不阻断安装。
4. **Vite `define` 注入 `TARGET_PLATFORM`**（仅用于构建期 UI 文案/图标选择等轻量分支），不用于主流程分发（主流程走运行时工厂），避免双重真相源。
5. **OCR 二进制**通过 `electron-builder` `asarUnpack` + 工厂 `binaryPath()` 选择，不进条件编译。

---

## 8. 架构决策记录（ADR）

### ADR-1：冻结 IPC 边界，仅重构主进程实现
- **状态**：Accepted
- **背景**：渲染进程只依赖 `window.desktopHost` 接口，与平台无关。
- **决策**：跨平台改造零改动 preload/渲染；所有平台差异收敛到 `electron/platform/*`。
- **后果**：渲染层无需回归；主进程模块化，可读性提升；代价是主进程需一次性搬迁。

### ADR-2：运行时工厂分发优先于条件编译
- **状态**：Accepted
- **背景**：散点 `if (darwin)` 难以维护且不可测。
- **决策**：单一 `createPlatformService()` 工厂 + 接口契约；原生介质下沉到 `platform/<os>`。
- **后果**：易测、易扩展（加 Linux 只加一个实现）；代价是少量重复的小实现文件。

### ADR-3：Windows OCR 引擎选型（待确认）
- **状态**：Proposed
- **选项**：
  - A. **原生 sidecar（推荐，对齐 mac 离线优先定位）**：Rust/C++ 封装 Windows.Media.OCR（WinRT）或 Tesseract，编译为 `.exe` 随包分发，沿用 spawn+JSON 契约。
  - B. Tesseract 官方/预编译二进制直接打包。
  - C. 云端 OCR（弃用离线卖点，不推荐）。
- **倾向**：A，因其保留「离线、隐私、多语言」产品定位，且与现有上层管道 100% 兼容。

### ADR-4：electron-builder 多 target + CI 矩阵 + 双签名
- **状态**：Accepted
- **背景**：`build.sh` 仅 macOS。
- **决策**：拆分脚本 + 双 `electron-builder` target + GitHub Actions 双 runner；mac 公证 / win Authenticode，凭据走 secret。
- **后果**：CI 即可出双平台安装包；代价需维护两套 signing 凭据。

---

## 9. 分阶段实施路线

| 阶段 | 目标 | 风险 | macOS 影响 |
|------|------|------|-----------|
| **P0 接缝** | 建 `platform/types.ts`+工厂，把现有 mac 逻辑原样搬入 `platform/mac/*`，工厂默认返回 mac | 低 | 零回归（行为不变） |
| **P1 高复用模块** | 实现 `platform/win/*` 的 capture/long/shortcut/tray（85-100% 复用） | 低 | 无 |
| **P2 外壳/自启动/权限** | win 窗口外壳、自启动（注册表/Startup）、权限引导 | 中 | 无 |
| **P3 OCR 引擎** | 选定 ADR-3 方案，实现 `win/ocr.mjs` + 预编译 `.exe` | 高（识别质量） | 无 |
| **P4 打包/CI/签名** | `build-win.mjs` + electron-builder win target + Actions 矩阵 + Authenticode | 中 | 无 |

每阶段结尾均由 CI 双平台 job 回归；P0 完成即合并，避免长分支。

---

## 10. 待你确认的决策点

1. **Windows OCR 引擎（ADR-3）**：倾向「原生 sidecar 离线引擎」对齐 mac 离线定位，还是接受 Tesseract/云端？这决定 P3 工作量与识别质量上限。
2. **Windows 安装包格式**：NSIS（推荐，灵活）/ Squirrel（自动更新友好）/ MSI（企业分发）？
3. **功能对等范围**：是否要求 Windows 与 mac **完全对等**（含同等精度离线 OCR）？还是首版允许 OCR 精度略低、后续迭代？
4. **CI 环境**：是否有 GitHub Actions / 其他 CI？若无，Windows 构建需在开发者本机或自托管 runner 完成。

> 以上任一项确认后，我可据此把 P0–P4 拆为带验收标准的实施计划（writing-plans），并逐步落地。
