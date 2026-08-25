/**
 * 文件：electron/main.mjs
 * 职责：Electron 主进程入口。负责窗口体系（panel / result / settings / overlay /
 *       long-toolbar / stitcher）、屏幕截图采集、离线 OCR 调度、长截图拼接与
 *       文本合并、托盘、全局快捷键、开机自启动、权限检测与状态广播（IPC）。
 * 依赖：electron、node:*、./ocr.swift、./stitcher.html
 * 导出：无（作为进程入口直接运行）
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  nativeImage,
  ipcMain,
  desktopCapturer,
  screen,
  shell,
  systemPreferences,
  clipboard,
  dialog,
} from 'electron';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, '..');
const rendererDistPath = path.join(appRoot, 'dist', 'index.html');
const devServerUrl = process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:3000';
const trayIconPath = path.join(appRoot, 'public', 'img', 'favicon', 'A_simple_flat_vector_tray_icon_2026-07-08T07-19-22.png');
const desktopStatePath = path.join(app.getPath('userData'), 'desktop-state.json');
const ocrScriptPath = path.join(__dirname, 'ocr.swift');

// 打包内置的 OCR 二进制优先放在 app.asar.unpacked 下（asarUnpack 解出），
// __dirname 在打包后指向虚拟的 app.asar/electron，需要映射到真实解包路径。
// 开发态 / 兼容历史逻辑时回退到 /tmp 下缓存的二进制。
function getBundledOcrBinaryPath() {
  const unpacked = __dirname.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
  return path.join(unpacked, 'screen-ocr-engine.bin');
}
const ocrBinaryPath = getBundledOcrBinaryPath();
const ocrBinaryPathFallback = path.join(os.tmpdir(), 'screen-ocr-engine.bin');

// 检查命令是否在 PATH 中可用（用于运行时回退判断）。
function has_cmd(name) {
  try {
    return Boolean(execFileSync('command', ['-v', name], { stdio: 'pipe' }).toString().trim());
  } catch {
    return false;
  }
}

const defaultSingleShortcut = 'CommandOrControl+Shift+1';
const defaultLongShortcut = 'CommandOrControl+Shift+2';
const defaultMenuShortcut = 'CommandOrControl+Shift+M';
const defaultQuickShortcut = 'CommandOrControl+Shift+3';

let tray = null;
let panelWindow = null;
let resultWindow = null;
let settingsWindow = null;
let overlayWindows = [];
let captureStarting = false;
let longToolbarWindow = null;
let stitcherWindow = null;
let stitcherReadyPromise = null;
let longCaptureTimer = null;
let _longCaptureBusy = false;
let _longCaptureNoChangeCount = 0;
const _longCaptureMaxSegments = 30;
const _longCaptureInterval = 800;

const hostState = {
  permissions: {
    screenCapture: 'unknown',
  },
  captureDisplays: [],
  recentCaptureResult: null,
  activeCaptureSession: null,
  longCaptureSession: null,
  captureErrorMessage: null,
  shortcutPreferences: {
    single: {
      accelerator: defaultSingleShortcut,
      displayText: '⌘/Ctrl + ⇧ + 1',
    },
    long: {
      accelerator: defaultLongShortcut,
      displayText: '⌘/Ctrl + ⇧ + 2',
    },
    menu: {
      accelerator: defaultMenuShortcut,
      displayText: '⌘/Ctrl + ⇧ + M',
    },
    quick: {
      accelerator: defaultQuickShortcut,
      displayText: '⌘/Ctrl + ⇧ + 3',
    },
  },
  shortcutRegistrationError: null,
  // Auto-launch on login. Defaults to ON per product requirement; the actual
  // system registration is applied at startup and on every toggle change.
  autoLaunch: true,
  advancedFeatures: {
    enabled: true,
    filterSymbols: [],
    charReplacements: [],
    regexRules: [],
  },
};

function isDevelopment() {
  return !app.isPackaged;
}

function loadPersistedState() {
  if (!fs.existsSync(desktopStatePath)) {
    return;
  }

  try {
    const persistedJson = fs.readFileSync(desktopStatePath, 'utf-8');
    const persistedState = JSON.parse(persistedJson);
    if (
      persistedState.shortcutPreferences?.single?.accelerator &&
      persistedState.shortcutPreferences?.single?.displayText &&
      persistedState.shortcutPreferences?.long?.accelerator &&
      persistedState.shortcutPreferences?.long?.displayText
    ) {
      // Load stored preferences but keep any missing keys (e.g. the menu
      // shortcut added later) on their defaults.
      hostState.shortcutPreferences = {
        single: persistedState.shortcutPreferences.single,
        long: persistedState.shortcutPreferences.long,
        menu: persistedState.shortcutPreferences.menu ?? hostState.shortcutPreferences.menu,
        quick: persistedState.shortcutPreferences.quick ?? hostState.shortcutPreferences.quick,
      };
    } else if (persistedState.shortcutPreference?.accelerator && persistedState.shortcutPreference?.displayText) {
      hostState.shortcutPreferences.single = persistedState.shortcutPreference;
    }

    if (persistedState.recentCaptureResult) {
      const r = persistedState.recentCaptureResult;
      // Never restore image data URLs from disk — they are large and stale.
      hostState.recentCaptureResult = {
        text: typeof r.text === 'string' ? r.text : '',
        capturedAt: typeof r.capturedAt === 'string' ? r.capturedAt : new Date().toISOString(),
        wasEmpty: Boolean(r.wasEmpty),
        imageDataUrl: null,
        longImageDataUrl: null,
        loading: false,
      };
    }

    if (typeof persistedState.autoLaunch === 'boolean') {
      hostState.autoLaunch = persistedState.autoLaunch;
    }

    if (persistedState.advancedFeatures && typeof persistedState.advancedFeatures === 'object') {
      const af = persistedState.advancedFeatures;
      hostState.advancedFeatures = {
        enabled: typeof af.enabled === 'boolean' ? af.enabled : true,
        filterSymbols: Array.isArray(af.filterSymbols)
          ? af.filterSymbols.filter((s) => typeof s === 'string').slice(0, 200)
          : [],
        charReplacements: Array.isArray(af.charReplacements)
          ? af.charReplacements
              .filter((r) => r && typeof r === 'object')
              .map((r) => ({
                source: typeof r.source === 'string' ? r.source : '',
                target: typeof r.target === 'string' ? r.target : '',
              }))
              .slice(0, 200)
          : [],
        regexRules: Array.isArray(af.regexRules)
          ? af.regexRules
              .filter((r) => r && typeof r === 'object')
              .map((r) => ({
                pattern: typeof r.pattern === 'string' ? r.pattern : '',
                replacement: typeof r.replacement === 'string' ? r.replacement : '',
                flags: typeof r.flags === 'string' ? r.flags : 'g',
                mode: r.mode === 'filter' ? 'filter' : 'replace',
              }))
              .slice(0, 200)
          : [],
      };
    }
  } catch {
    hostState.captureErrorMessage = '读取本地桌面设置失败，已使用默认配置继续。';
  }
}

function persistState() {
  fs.mkdirSync(path.dirname(desktopStatePath), { recursive: true });
  // Persist only the lightweight text result — never the multi-MB image
  // data URLs, which would bloat the JSON file and slow down startup.
  const result = hostState.recentCaptureResult;
  fs.writeFileSync(
    desktopStatePath,
    JSON.stringify(
      {
        shortcutPreferences: hostState.shortcutPreferences,
        autoLaunch: hostState.autoLaunch,
        advancedFeatures: hostState.advancedFeatures,
        recentCaptureResult: result
          ? {
              text: result.text,
              capturedAt: result.capturedAt,
              wasEmpty: result.wasEmpty,
            }
          : null,
      },
      null,
      2,
    ),
    'utf-8',
  );
}

function formatShortcutDisplay(accelerator) {
  return accelerator
    .replace(/CommandOrControl/g, '⌘/Ctrl')
    .replace(/Command/g, '⌘')
    .replace(/Control/g, 'Ctrl')
    .replace(/Shift/g, '⇧');
}

/**
 * 构建并 sanitize 当前要广播的宿主状态。
 * 图片等大体积 data URL 在此被剥离（置 null），仅通过按需接口下发，
 * 避免每次状态变更向所有窗口推送数 MB base64 造成 IPC/渲染卡顿。
 * @returns 剔除图片载荷后的宿主状态快照
 */
function getShellState() {
  // Sanitize the broadcast: image payloads (often several MB of base64) are
  // stripped here and delivered on-demand via `get-recent-capture-images`.
  // Broadcasting them to every window on every state change was the single
  // largest source of IPC/renderer latency.
  const result = hostState.recentCaptureResult;
  const session = hostState.longCaptureSession;

  return {
    platform: process.platform,
    surfaces: ['panel', 'result', 'settings', 'overlay', 'long-toolbar'],
    permissions: { ...hostState.permissions },
    recentCaptureResult: result
      ? {
          text: result.text,
          capturedAt: result.capturedAt,
          wasEmpty: result.wasEmpty,
          imageDataUrl: null,
          longImageDataUrl: null,
          loading: result.loading,
        }
      : null,
    activeCaptureSession: hostState.activeCaptureSession,
    longCaptureSession: session
      ? {
          selection: session.selection,
          displayId: session.displayId,
          displayBounds: session.displayBounds,
          segmentsCaptured: session.segmentsCaptured,
          mode: session.mode,
          isPaused: session.isPaused,
          // Tiny thumbnail only (full image stays in-process for stitch/save).
          latestSegmentThumbnail: session.latestSegmentThumbnail ?? null,
        }
      : null,
    captureErrorMessage: hostState.captureErrorMessage,
    shortcutPreferences: hostState.shortcutPreferences,
    shortcutRegistrationError: hostState.shortcutRegistrationError,
    autoLaunch: hostState.autoLaunch,
    advancedFeatures: hostState.advancedFeatures,
  };
}

// ── Auto-launch (login item) ────────────────────────────────────────────────
//
// Three‑channel strategy (macOS only):
//   Channel 1 – Electron's setLoginItemSettings (SMAppService, requires signing).
//   Channel 2 – AppleScript System Events (requires Automation permission).
//   Channel 3 – LaunchAgent plist (~/Library/LaunchAgents/… .plist, no permissions).
// We try Channel 1 → 2 → 3 in order. Channel 3 is the ultimate fallback —
// it writes a .plist that launchd picks up at login, requiring zero entitlements,
// zero code‑signing, and zero Automation approvals.

// ── Channel 2 helpers ────────────────────────────────────────────────────────

/** Derive the .app bundle path from the running executable. */
function _appBundlePath() {
  const exe = app.getPath('exe');
  // e.g. /Applications/mac-OCR.app/Contents/MacOS/mac-OCR → /Applications/mac-OCR.app
  return path.dirname(path.dirname(path.dirname(exe)));
}

/**
 * Enable / disable the login item via AppleScript System Events.
 * Returns true on success, false on failure.
 */
function _setLoginItemAppleScript(enabled) {
  const appName = app.getName();
  try {
    if (enabled) {
      execFileSync('osascript', [
        '-e', 'tell application "System Events"',
        '-e', `if not (exists login item "${appName}") then`,
        '-e', `make login item at end with properties {path:"${_appBundlePath()}", hidden:false}`,
        '-e', 'end if',
        '-e', 'end tell',
      ]);
    } else {
      execFileSync('osascript', [
        '-e', 'tell application "System Events"',
        '-e', `if exists login item "${appName}" then`,
        '-e', `delete login item "${appName}"`,
        '-e', 'end if',
        '-e', 'end tell',
      ]);
    }
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Read the current login‑item state via AppleScript.
 * Returns true/false, or null if the check could not complete.
 */
function _isLoginItemEnabledAppleScript() {
  try {
    const out = execFileSync('osascript', [
      '-e', 'tell application "System Events"',
      '-e', 'set _names to name of every login item',
      '-e', `if _names contains "${app.getName()}" then`,
      '-e', 'return "1"',
      '-e', 'else',
      '-e', 'return "0"',
      '-e', 'end if',
      '-e', 'end tell',
    ], { encoding: 'utf8', timeout: 5000 }).trim();
    return out === '1';
  } catch {
    return null;
  }
}

// ── Channel 3 helpers (LaunchAgent plist) ──────────────────────────────────

/**
 * LaunchAgent plist path: ~/Library/LaunchAgents/<app-name>.plist
 * Only used in packaged builds — dev builds use the Electron binary path
 * which won't work as a standalone login item.
 */
function _launchAgentPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${app.getName()}.plist`);
}

function _launchAgentPlistXML() {
  const exe = app.getPath('exe');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.idl.ocr</string>
    <key>ProgramArguments</key>
    <array>
        <string>${exe}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>`;
}

/**
 * Check whether the LaunchAgent plist file exists on disk.
 * This is the simplest and most reliable detection method — no permissions needed.
 */
function _isLoginItemEnabledLaunchAgent() {
  try {
    return fs.existsSync(_launchAgentPlistPath());
  } catch {
    return false;
  }
}

/**
 * Enable / disable the login item by writing / removing the LaunchAgent plist.
 * This is the final fallback because it requires zero system permissions:
 * no code‑signing, no Automation privileges. The only requirement is that
 * ~/Library/LaunchAgents/ exists (created by macOS for every user).
 *
 * Note: only effective in packaged builds. In dev mode the executable path
 * would be the Electron binary, which launchd cannot use correctly.
 */
function _setLoginItemLaunchAgent(enabled) {
  if (!app.isPackaged) {
    console.log('[autolaunch] LaunchAgent: skipped (not packaged)');
    return false;
  }
  try {
    const plistPath = _launchAgentPlistPath();
    if (enabled) {
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, _launchAgentPlistXML(), 'utf8');
      console.log('[autolaunch] LaunchAgent: plist written →', plistPath);
    } else {
      if (fs.existsSync(plistPath)) {
        fs.unlinkSync(plistPath);
        console.log('[autolaunch] LaunchAgent: plist removed →', plistPath);
      }
    }
    return true;
  } catch (err) {
    console.warn('[autolaunch] LaunchAgent: fs error:', err?.message ?? err);
    return false;
  }
}

// ── Multi‑method read ───────────────────────────────────────────────────────

/**
 * Determine whether the app is currently a login item by trying all available
 * channels. Returns a boolean (best‑effort), defaulting to the persisted
 * preference when no channel can be queried.
 */
function _readSystemLoginItemState() {
  // Channel 1 – Electron
  try {
    if (typeof app.getLoginItemSettings === 'function') {
      const s = app.getLoginItemSettings();
      if (typeof s.openAtLogin === 'boolean') return s.openAtLogin;
    }
  } catch { /* fall through */ }

  // Channel 2 – AppleScript (macOS only)
  if (process.platform === 'darwin') {
    const as = _isLoginItemEnabledAppleScript();
    if (as !== null) return as;
  }

  // Channel 3 – LaunchAgent plist (no permissions needed)
  if (process.platform === 'darwin') {
    return _isLoginItemEnabledLaunchAgent();
  }

  // Cannot determine – lean on persistence.
  return hostState.autoLaunch;
}

// ── Multi‑method write + verify ─────────────────────────────────────────────

/**
 * Enable or disable the login item by trying all available channels.
 * Verifies the result after each attempt.
 */
function applyLoginItemSettings(enabled) {
  if (typeof app.setLoginItemSettings !== 'function') {
    return { success: false, error: '当前平台不支持开机自启动设置。' };
  }

  // Channel 1 – Electron native API
  try {
    app.setLoginItemSettings({ openAtLogin: enabled });
    const after = app.getLoginItemSettings();
    if (typeof after.openAtLogin === 'boolean' && after.openAtLogin === enabled) {
      return { success: true, error: null };
    }
  } catch (err) {
    console.warn('[autolaunch] Electron API threw:', err?.message ?? err);
  }

  // Channel 2 – AppleScript (macOS only; works without code‑signing)
  // Also serves as verification for Channel 1 when it reports "success"
  // but the system has silently rejected the SMAppService call.
  if (process.platform === 'darwin') {
    if (_setLoginItemAppleScript(enabled)) {
      const verified = _isLoginItemEnabledAppleScript();
      if (verified === enabled) {
        console.log(`[autolaunch] AppleScript ${enabled ? 'registered' : 'unregistered'} successfully`);
        return { success: true, error: null };
      }
    }
    console.warn('[autolaunch] AppleScript method failed, trying LaunchAgent...');
  }

  // Channel 3 – LaunchAgent .plist (macOS only; zero permissions required)
  if (process.platform === 'darwin') {
    if (_setLoginItemLaunchAgent(enabled)) {
      const verified = _isLoginItemEnabledLaunchAgent();
      if (verified === enabled) {
        console.log(`[autolaunch] LaunchAgent ${enabled ? 'installed' : 'removed'} successfully`);
        return { success: true, error: null };
      }
    }
    console.warn('[autolaunch] LaunchAgent method also failed.');
  }

  return {
    success: false,
    error: '设置开机自启动失败。请在系统设置中手动添加/移除登录项，或检查自动化权限。',
  };
}

// ── Startup sync ────────────────────────────────────────────────────────────

/**
 * At startup: read the real system state and sync our in‑memory state to match.
 * NEVER calls setLoginItemSettings({openAtLogin:false}) here — that would
 * DELETE a login item the user manually added via System Settings.
 * Only conditionally ENABLES when the user explicitly wants it ON.
 */
function initAutoLaunch() {
  try {
    if (typeof app.getLoginItemSettings !== 'function') return;

    const systemOn = _readSystemLoginItemState();

    if (systemOn) {
      // System has the app as a login item — trust it unconditionally.
      console.log('[autolaunch] startup: system ON → sync persisted true');
      hostState.autoLaunch = true;
      persistState();
      return;
    }

    // System OFF — register only if the user explicitly wanted it ON.
    if (hostState.autoLaunch === true) {
      console.log('[autolaunch] startup: system OFF but persisted ON → attempting registration');
      const { success } = applyLoginItemSettings(true);
      hostState.autoLaunch = success ? true : false;
      persistState();
      return;
    }

    // System OFF + persisted OFF → already in sync.
    console.log('[autolaunch] startup: system OFF, persisted OFF → in sync');
  } catch (err) {
    console.warn('[autolaunch] init failed:', err?.message ?? err);
  }
}

// ── Runtime toggle ──────────────────────────────────────────────────────────

async function setAutoLaunch(request) {
  const desired = Boolean(request?.enabled);
  console.log(`[autolaunch] setAutoLaunch: requested=${desired}, current=${hostState.autoLaunch}`);

  const previous = hostState.autoLaunch;
  const { success, error } = applyLoginItemSettings(desired);

  if (!success) {
    // Roll back — system rejected the change.
    hostState.autoLaunch = previous;
    persistState();
    console.warn(`[autolaunch] setAutoLaunch FAILED → rolled back to ${previous}. ${error}`);
    broadcastShellState();
    return { success: false, error };
  }

  // Success — persist + broadcast.
  hostState.autoLaunch = desired;
  persistState();
  console.log(`[autolaunch] setAutoLaunch SUCCESS: autoLaunch=${desired}`);
  broadcastShellState();
  return { success: true };
}

// ── Open System Settings helper ─────────────────────────────────────────────

function openLoginItemsSettings() {
  if (process.platform !== 'darwin') {
    return { success: false, error: '当前平台不支持此操作。' };
  }
  try {
    shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension');
    return { success: true };
  } catch (err) {
    console.warn('[autolaunch] openLoginItemsSettings failed:', err?.message ?? err);
    return { success: false, error: '无法打开系统登录项设置。' };
  }
}

function broadcastShellState() {
  const nextState = getShellState();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('desktop-host:shell-state-updated', nextState);
    }
  }
}

function refreshPermissionState() {
  if (process.platform !== 'darwin') {
    hostState.permissions.screenCapture = 'granted';
    return;
  }

  const status = systemPreferences.getMediaAccessStatus('screen');
  hostState.permissions.screenCapture = status === 'not-determined' ? 'unknown' : status;
}

async function loadRenderer(window, surface) {
  const targetUrl = isDevelopment()
    ? `${devServerUrl}?surface=${surface}`
    : `file://${rendererDistPath}?surface=${surface}`;

  await window.loadURL(targetUrl);
}

function createHostWindow(options) {
  return new BrowserWindow({
    show: false,
    frame: false,
    // Hide the native traffic lights by default on macOS; they only appear on
    // hover, so the custom top-right close button becomes the primary control.
    titleBarStyle: 'customButtonsOnHover',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    transparent: false,
    hasShadow: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    ...options,
  });
}

function ensurePanelWindow() {
  if (panelWindow && !panelWindow.isDestroyed()) {
    return panelWindow;
  }

  panelWindow = createHostWindow({
    width: 420,
    height: 580,
    resizable: true,
    hiddenInMissionControl: true,
  });

  panelWindow.on('blur', () => {
    if (!panelWindow?.webContents.isDevToolsOpened()) {
      panelWindow?.hide();
    }
  });

  panelWindow.on('closed', () => {
    panelWindow = null;
  });

  void loadRenderer(panelWindow, 'panel');
  return panelWindow;
}

function ensureResultWindow() {
  if (resultWindow && !resultWindow.isDestroyed()) {
    return resultWindow;
  }

  resultWindow = createHostWindow({
    width: 560,
    height: 800,
    minWidth: 360,
    minHeight: 460,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    hiddenInMissionControl: true,
  });

  resultWindow.on('closed', () => {
    resultWindow = null;
  });

  void loadRenderer(resultWindow, 'result');
  return resultWindow;
}

function ensureSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    return settingsWindow;
  }

  settingsWindow = createHostWindow({
    width: 460,
    height: 600,
    minHeight: 420,
    maxHeight: Math.floor(screen.getPrimaryDisplay().workArea.height - 60),
    resizable: true,
    movable: true,
    skipTaskbar: true,
    hiddenInMissionControl: true,
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  void loadRenderer(settingsWindow, 'settings');
  return settingsWindow;
}

function createOverlayWindow() {
  const window = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    // Prevent Chromium from painting a default white layer before the
    // React app renders. With transparent:true this paint is normally
    // skipped, but the explicit backgroundColor hedge guarantees it on
    // every macOS / Electron version.
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    fullscreenable: true,
    minimizable: false,
    maximizable: false,
    movable: false,
    focusable: true,
    skipTaskbar: true,
    roundedCorners: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Start loading the renderer immediately (fire-and-forget).  Loading is
  // NOT awaited here because the dev server may be temporarily unreachable
  // (e.g. HMR restart), and a rejected promise would crash the caller.
  // Instead, startScreenCapture waits for did-finish-load downstream.
  loadRendererWithRetry(window, 'overlay');

  return window;
}

/**
 * Load the renderer URL into the given window, retrying once on transient
 * failures (e.g. Vite dev server restart or file:// timing issues).
 */
async function loadRendererWithRetry(window, surface) {
  try {
    await loadRenderer(window, surface);
  } catch (err) {
    // Give the dev server / filesystem a moment to recover, then retry once.
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      await loadRenderer(window, surface);
    } catch {
      // Silently accept the failure — the window will be transparent
      // (backgroundColor + injected CSS) and the user can retry capture.
    }
  }
}

function ensureOverlayWindowsForDisplays(displayBoundsList) {
  closeCaptureOverlay();

  for (let i = 0; i < displayBoundsList.length; i += 1) {
    const bounds = displayBoundsList[i];
    const window = createOverlayWindow();
    window.setBounds(bounds);
    window.on('closed', () => {
      overlayWindows = overlayWindows.filter((w) => w !== window && !w.isDestroyed());
    });
    overlayWindows.push(window);
  }

  return overlayWindows;
}

function ensureLongToolbarWindow() {
  if (longToolbarWindow && !longToolbarWindow.isDestroyed()) {
    return longToolbarWindow;
  }

  longToolbarWindow = createHostWindow({
    width: 460,
    height: 200,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    alwaysOnTop: true,
  });

  longToolbarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  longToolbarWindow.on('closed', () => {
    longToolbarWindow = null;
  });

  void loadRenderer(longToolbarWindow, 'long-toolbar');
  return longToolbarWindow;
}

function togglePanelWindow() {
  const window = ensurePanelWindow();
  if (window.isVisible()) {
    window.hide();
    return;
  }

  const trayBounds = tray?.getBounds();
  if (trayBounds) {
    const [windowWidth] = window.getSize();
    const x = Math.round(trayBounds.x + trayBounds.width / 2 - windowWidth / 2);
    const y = Math.round(trayBounds.y + trayBounds.height + 8);
    window.setPosition(x, y, false);
  }

  window.show();
  window.focus();
}

function showResultWindow() {
  const window = ensureResultWindow();
  window.showInactive();
}

function showSettingsWindow() {
  const window = ensureSettingsWindow();
  window.center();
  window.show();
  window.focus();
}

function showLongToolbarWindow() {
  const window = ensureLongToolbarWindow();
  const primaryDisplay = screen.getPrimaryDisplay();
  const { x, y, width } = primaryDisplay.workArea;
  const [windowWidth] = window.getSize();
  window.setPosition(Math.round(x + width / 2 - windowWidth / 2), y + 24, false);
  window.showInactive();
}

function closeCaptureOverlay() {
  for (const window of overlayWindows) {
    if (!window.isDestroyed()) {
      window.close();
    }
  }
  overlayWindows = [];
}

function closeLongToolbarWindow() {
  if (longToolbarWindow && !longToolbarWindow.isDestroyed()) {
    longToolbarWindow.close();
  }
}

function ensureStitcherWindow() {
  if (stitcherWindow && !stitcherWindow.isDestroyed()) {
    return stitcherWindow;
  }

  stitcherWindow = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  stitcherWindow.on('closed', () => {
    stitcherWindow = null;
    stitcherReadyPromise = null;
  });

  const stitcherPath = path.join(__dirname, 'stitcher.html');
  stitcherReadyPromise = new Promise((resolve) => {
    stitcherWindow.webContents.once('did-finish-load', () => resolve());
  });
  void stitcherWindow.loadFile(stitcherPath);
  return stitcherWindow;
}

async function whenStitcherReady() {
  if (!stitcherWindow || stitcherWindow.isDestroyed()) {
    ensureStitcherWindow();
  }
  if (stitcherReadyPromise) {
    try {
      await stitcherReadyPromise;
    } catch {
      // ignore
    }
  }
  // Extra safety: poll until the stitch function is defined
  try {
    await stitcherWindow.webContents.executeJavaScript(`
      new Promise((resolve) => {
        if (typeof window.__stitchImages === 'function') return resolve(true);
        let tries = 0;
        const iv = setInterval(() => {
          if (typeof window.__stitchImages === 'function' || tries++ > 60) {
            clearInterval(iv);
            resolve(true);
          }
        }, 50);
      })
    `);
  } catch {
    // ignore
  }
}

function destroyStitcherWindow() {
  if (longCaptureTimer) {
    clearInterval(longCaptureTimer);
    longCaptureTimer = null;
  }
  if (stitcherWindow && !stitcherWindow.isDestroyed()) {
    stitcherWindow.close();
  }
  stitcherReadyPromise = null;
}

async function stitchLongImage(segments) {
  if (!segments || segments.length === 0) return null;
  if (segments.length === 1) return segments[0];

  const window = ensureStitcherWindow();
  await whenStitcherReady();

  try {
    const result = await window.webContents.executeJavaScript(
      `window.__stitchImages(${JSON.stringify(segments)})`,
    );
    return typeof result === 'string' && result.startsWith('data:image/png') ? result : null;
  } catch (err) {
    console.error('Stitch failed:', err);
    return null;
  }
}

function startAutoCaptureTimer() {
  stopAutoCaptureTimer();
  _longCaptureNoChangeCount = 0;
  _longCaptureBusy = false;
  longCaptureTimer = setInterval(async () => {
    if (_longCaptureBusy) {
      return;
    }
    if (!hostState.longCaptureSession ||
        hostState.longCaptureSession.isPaused ||
        hostState.longCaptureSession.mode !== 'auto') {
      return;
    }

    _longCaptureBusy = true;
    const prevImage = hostState.longCaptureSession.capturedImages?.length
      ? hostState.longCaptureSession.capturedImages[hostState.longCaptureSession.capturedImages.length - 1]
      : null;
    const result = await captureLongSegment();

    if (!result.success) return;

    // After capture, check if content has changed compared to previous segment
    if (prevImage && hostState.longCaptureSession?.capturedImages?.length) {
      const currImage = hostState.longCaptureSession.capturedImages[
        hostState.longCaptureSession.capturedImages.length - 1
      ];
      if (currImage && prevImage) {
        const hasChanged = await detectScrollChange(prevImage, currImage);
        if (!hasChanged) {
          _longCaptureNoChangeCount += 1;
          if (_longCaptureNoChangeCount >= 3) {
            stopAutoCaptureTimer();
            await finishLongCapture();
            return;
          }
        } else {
          _longCaptureNoChangeCount = 0;
        }
      }
    }

    // Check max segments
    if (hostState.longCaptureSession &&
        hostState.longCaptureSession.segmentsCaptured >= _longCaptureMaxSegments) {
      stopAutoCaptureTimer();
      await finishLongCapture();
    }

    _longCaptureBusy = false;
  }, _longCaptureInterval);
}

function stopAutoCaptureTimer() {
  if (longCaptureTimer) {
    clearInterval(longCaptureTimer);
    longCaptureTimer = null;
  }
}

async function detectScrollChange(prevDataUrl, currDataUrl) {
  if (!prevDataUrl || !currDataUrl) return true;

  const window = ensureStitcherWindow();
  try {
    const result = await window.webContents.executeJavaScript(`
      (function() {
        const urls = ${JSON.stringify([prevDataUrl, currDataUrl])};
        return new Promise((resolve) => {
          let loaded = 0;
          const imgs = [new Image(), new Image()];
          function check() { if (++loaded === 2) resolve(compare(imgs[0], imgs[1])); }
          imgs[0].onload = check; imgs[0].onerror = () => resolve(true);
          imgs[1].onload = check; imgs[1].onerror = () => resolve(true);
          imgs[0].src = urls[0]; imgs[1].src = urls[1];

          function compare(a, b) {
            const w = Math.min(a.naturalWidth, b.naturalWidth);
            const h = Math.min(a.naturalHeight, b.naturalHeight);
            if (w < 1 || h < 1) return true;

            const scale = 0.15;
            const sw = Math.max(1, Math.floor(w * scale));
            const sh = Math.max(1, Math.floor(h * scale));

            const canvas = document.createElement('canvas');
            canvas.width = sw * 2; canvas.height = sh;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(a, 0, 0, w, h, 0, 0, sw, sh);
            ctx.drawImage(b, 0, 0, w, h, sw, 0, sw, sh);

            const dataA = ctx.getImageData(0, 0, sw, sh).data;
            const dataB = ctx.getImageData(sw, 0, sw, sh).data;

            let totalDiff = 0;
            const len = sw * sh * 4;
            for (let i = 0; i < len; i += 4) {
              totalDiff += Math.abs(dataA[i] - dataB[i]) +
                           Math.abs(dataA[i+1] - dataB[i+1]) +
                           Math.abs(dataA[i+2] - dataB[i+2]);
            }
            const avgDiff = totalDiff / (sw * sh * 3);
            return avgDiff > 8;
          }
        });
      })()
    `);
    return Boolean(result);
  } catch {
    return true;
  }
}

function writeImageDataUrlToTempFile(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') {
    throw new Error('Missing or invalid data URL.');
  }
  const matches = dataUrl.match(/^data:image\/png;base64,([\s\S]+)$/);
  if (!matches) {
    const prefix = dataUrl.substring(0, 50);
    throw new Error(`Invalid PNG data URL (starts with: "${prefix}").`);
  }

  const tempFilePath = path.join(os.tmpdir(), `screen-ocr-${Date.now()}.png`);
  const buffer = Buffer.from(matches[1], 'base64');
  fs.writeFileSync(tempFilePath, buffer);
  console.log(`[ocr] Wrote temp image: ${tempFilePath} (${buffer.length} bytes)`);
  return tempFilePath;
}

// ── OCR engine caching ──────────────────────────────────────────────────────
// `swift ocr.swift` re-compiles the Vision-backed script on EVERY invocation,
// adding ~1-3s of startup/jit overhead per capture. Compile it once into a
// native binary (cached in tmp, rebuilt only when the source changes) so
// subsequent recognitions start instantly. Falls back to `swift` if anything
// goes wrong so behaviour stays stable.
// 注：生产环境使用 build.sh 预编译并打进 app 的二进制（见 ocrBinaryPath 定义）。
let ocrBinaryReady = false;
let ocrBinaryFailed = false;
// 缓存已解析为可用的 OCR 可执行文件路径，避免"下次调用返回错误路径"的 bug
//（例如上一条分支用的是 fallback 缓存，下次却返回 ocrBinaryPath 打包路径）。
let ocrResolvedPath = null;

async function ensureOcrExecutable() {
  if (ocrBinaryReady) return ocrResolvedPath;
  if (ocrBinaryFailed) return null;

  try {
    // 1) 优先使用打包内置的二进制（生产环境无需 swiftc/swift）。
    if (fs.existsSync(ocrBinaryPath)) {
      ocrBinaryReady = true;
      ocrResolvedPath = ocrBinaryPath;
      return ocrResolvedPath;
    }

    // 2) 回退到 /tmp 下缓存的二进制（开发态或历史编译产物）。
    if (fs.existsSync(ocrBinaryPathFallback)) {
      ocrBinaryReady = true;
      ocrResolvedPath = ocrBinaryPathFallback;
      return ocrResolvedPath;
    }

    // 3) 本机存在 swiftc 时，编译到 /tmp 缓存（仅开发态可用）。
    await new Promise((resolve) => {
      const child = spawn('swiftc', ['-O', ocrScriptPath, '-o', ocrBinaryPathFallback], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      child.stderr.on('data', (chunk) => {
        err += chunk.toString();
      });
      child.on('close', (code) => {
        if (code !== 0) {
          console.warn('[ocr] swiftc compile failed, falling back to `swift`:', err.trim().slice(0, 240));
        }
        resolve();
      });
    });

    if (fs.existsSync(ocrBinaryPathFallback)) {
      ocrBinaryReady = true;
      ocrResolvedPath = ocrBinaryPathFallback;
      return ocrResolvedPath;
    }

    ocrBinaryFailed = true;
  } catch {
    ocrBinaryFailed = true;
  }

  return null;
}

// Downscale very large images before OCR. Vision `.accurate` cost scales with
// pixel count, so a 2000px-longest-side cap keeps small/normal crops untouched
// (accuracy preserved) while drastically shrinking full stitched long images.
function downscaleImageDataUrl(dataUrl, maxSide) {
  try {
    const image = nativeImage.createFromDataURL(dataUrl);
    const { width, height } = image.getSize();
    const longest = Math.max(width, height);
    if (longest <= maxSide) {
      return dataUrl;
    }
    const scale = maxSide / longest;
    const resized = image.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    });
    const out = resized.toDataURL();
    return out && out.length > 100 ? out : dataUrl;
  } catch {
    return dataUrl;
  }
}

const OCR_MAX_SIDE = 2000;

// Tiny (≈160px) preview for the long-capture toolbar thumbnail.
function makeThumbnailDataUrl(dataUrl, maxWidth = 160) {
  try {
    const image = nativeImage.createFromDataURL(dataUrl);
    const { width, height } = image.getSize();
    if (width <= maxWidth) {
      return dataUrl;
    }
    const scale = maxWidth / width;
    const resized = image.resize({
      width: maxWidth,
      height: Math.max(1, Math.round(height * scale)),
    });
    const out = resized.toDataURL();
    return out && out.length > 100 ? out : dataUrl;
  } catch {
    return dataUrl;
  }
}

/**
 * 离线 OCR 识别：写临时 PNG → 调用 Vision（优先用预编译二进制，失败回退 swift）
 * → 解析 JSON 结果。非 darwin 平台直接抛错；超大图先降采样到 2000px 以内。
 * 临时文件无论成功失败均在 finally 中清理。
 * @param imageDataUrl 待识别图片（PNG data URL）
 * @returns 识别出的文本（空串表示未识别到）
 */
async function recognizeTextFromImage(imageDataUrl) {
  if (!imageDataUrl) {
    return '';
  }

  if (process.platform !== 'darwin') {
    throw new Error('离线 OCR 当前仅支持 macOS。');
  }

  const downscaled = downscaleImageDataUrl(imageDataUrl, OCR_MAX_SIDE);
  const tempFilePath = writeImageDataUrlToTempFile(downscaled);

  const ocrStart = Date.now();
  try {
    const exe = await ensureOcrExecutable();
    const useBinary = Boolean(exe);
    // 无内置二进制时回退到 swift 解释执行，但生产环境通常不携带 swift，
    // 提前给出明确错误而非等到 spawn 报 ENOENT。
    if (!useBinary && !has_cmd('swift')) {
      throw new Error('离线 OCR 引擎不可用：内置二进制缺失且系统未安装 swift。');
    }
    const command = useBinary ? exe : 'swift';
    const args = useBinary ? [tempFilePath] : [ocrScriptPath, tempFilePath];

    const ocrJson = await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('close', (code) => {
        if (stderr.trim()) {
          console.log('[ocr stderr]', stderr.trim());
        }
        if (code !== 0) {
          reject(new Error(stderr.trim() || 'Vision OCR execution failed.'));
          return;
        }

        resolve(stdout.trim());
      });
    });

    const elapsed = Date.now() - ocrStart;
    if (elapsed > 300) {
      console.log(`[perf] OCR ${useBinary ? 'binary' : 'swift'} took ${elapsed}ms`);
    }

    const parsed = JSON.parse(ocrJson);
    return typeof parsed.text === 'string' ? parsed.text : '';
  } finally {
    fs.rmSync(tempFilePath, { force: true });
  }
}

/**
 * 合并多段长截图文本。对相邻两段做最多 8 行的尾部/首部重叠检测，
 * 重叠一致则去重拼接；无重叠则换行连接。
 * @param parts 各段文本数组
 * @returns 去重合并后的完整文本
 */
function mergeLongCaptureText(parts) {
  return parts.reduce((mergedText, nextPart) => {
    const nextText = nextPart.trim();
    if (!nextText) {
      return mergedText;
    }

    if (!mergedText) {
      return nextText;
    }

    const mergedLines = mergedText.split('\n');
    const nextLines = nextText.split('\n');
    const maxOverlap = Math.min(mergedLines.length, nextLines.length, 8);

    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
      const mergedTail = mergedLines.slice(-overlap).join('\n').trim();
      const nextHead = nextLines.slice(0, overlap).join('\n').trim();
      if (mergedTail && mergedTail === nextHead) {
        return [...mergedLines, ...nextLines.slice(overlap)].join('\n').trim();
      }
    }

    return `${mergedText}\n${nextText}`.trim();
  }, '');
}

function buildTrayContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()
        ? '隐藏面板'
        : '显示面板',
      click: togglePanelWindow,
    },
    { label: '截图', click: () => void startScreenCapture('quick') },
    { label: '截图识别', click: () => void startScreenCapture('single') },
    { label: '长截图识别', click: () => void startScreenCapture('long') },
    { label: '结果窗口', click: showResultWindow },
    { label: '设置', click: showSettingsWindow },
    { type: 'separator' },
    { label: '退出', role: 'quit' },
  ]);
}

function createTray() {
  const trayIcon = nativeImage.createFromPath(trayIconPath).resize({
    width: 18,
    height: 18,
  });

  trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip('Screen OCR');

  // Left-click → pop up context menu
  tray.on('click', () => {
    tray.popUpContextMenu(buildTrayContextMenu());
  });

  // Right-click → no action (avoid competing with left-click context menu)
}

function registerScreenshotShortcut() {
  globalShortcut.unregisterAll();
  hostState.shortcutRegistrationError = null;

  const prefs = hostState.shortcutPreferences;
  const accelerators = [prefs.single.accelerator, prefs.long.accelerator, prefs.menu.accelerator, prefs.quick.accelerator];

  // 1) Intra-app duplicate detection: no two shortcuts may collide.
  if (new Set(accelerators).size < accelerators.length) {
    hostState.shortcutRegistrationError = '普通截图、长截图、唤出菜单与截图（复制到剪贴板）不能使用相同的快捷键，请修改后重试。';
    globalShortcut.unregisterAll();
    return false;
  }

  // 2) Register each shortcut. A `false` return means the OS or another app
  //    already owns that combination — treat it as a conflict and report it.
  try {
    const registrations = [
      ['single', () => void startScreenCapture('single')],
      ['long', () => void startScreenCapture('long')],
      ['quick', () => void startScreenCapture('quick')],
      ['menu', () => void togglePanelWindow()],
    ].map(([key, handler]) => globalShortcut.register(prefs[key].accelerator, handler));

    if (registrations.some((ok) => !ok)) {
      globalShortcut.unregisterAll();
      hostState.shortcutRegistrationError =
        '部分快捷键注册失败，可能已被系统功能或其他应用占用，请更换按键组合后重试。';
      return false;
    }

    return true;
  } catch {
    hostState.shortcutRegistrationError = '快捷键格式无效，无法完成注册。';
    globalShortcut.unregisterAll();
    return false;
  }
}

function updateShortcutPreference(mode, accelerator) {
  hostState.shortcutPreferences[mode] = {
    accelerator,
    displayText: formatShortcutDisplay(accelerator),
  };
  persistState();
}

/**
 * 启动一次截图会话（single / long / quick）。校验无进行中会话与屏幕录制权限，
 * 截取所有显示器并为每个显示器创建 overlay 窗口，最后广播状态。
 * @param mode 'single' | 'long' | 'quick'
 * @returns { success } 是否成功发起
 */
/**
 * 给 Promise 加超时。desktopCapturer.getSources 在 macOS 权限未决/未生效时
 * 可能既不 resolve 也不 reject（挂起），必须有时间上限，否则截图流程会
 * 永久卡住且界面上毫无反馈。
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * 「权限已开启但需重启生效」的一键重启引导。
 * macOS TCC 特性：「屏幕录制」授权变更仅对新启动的进程生效。本应用常驻
 * 菜单栏（托盘），用户手动「重新打开」并不会重建进程——这正是
 * 「明明已添加权限却一直提示需要权限」的根因。这里在检测到
 * 「状态已 granted 但当前进程仍采集不到屏幕」时，弹原生对话框提供
 * 一键自动重启（app.relaunch），让授权立即生效。
 * 每个进程生命周期只自动弹一次，避免反复打扰。
 */
let relaunchOfferedForPermission = false;
function offerRelaunchForPermission() {
  if (relaunchOfferedForPermission) {
    return;
  }
  relaunchOfferedForPermission = true;

  dialog
    .showMessageBox({
      type: 'info',
      buttons: ['立即重启', '稍后再说'],
      defaultId: 0,
      cancelId: 1,
      message: '屏幕录制权限已开启，重启应用后生效',
      detail:
        'macOS 规定「屏幕录制」权限变更仅对新启动的应用进程生效；本应用常驻菜单栏，'
        + '直接重新打开窗口并不会重建进程。点击「立即重启」将自动退出并重新启动应用，'
        + '权限随即生效，截图功能可正常使用。',
    })
    .then(({ response }) => {
      if (response === 0) {
        app.relaunch();
        app.exit(0);
      }
    })
    .catch(() => {
      // 对话框失败（如无可用窗口）时忽略，用户仍可按错误提示手动重启。
    });
}

async function startScreenCapture(mode = 'single') {
  // Guard against re-entrant triggers. `activeCaptureSession` is only set
  // *after* the long `await`s below (getSources + did-finish-load wait).
  // Without this flag, a second shortcut press during those awaits would
  // pass the check below and call ensureOverlayWindowsForDisplays() ->
  // closeCaptureOverlay(), destroying the windows this invocation is still
  // using — which later throws "Object has been destroyed" at `.focus()`.
  //
  // 自愈：若上次会话异常中断（overlay 窗口已全部销毁但会话状态未清理），
  // 先清掉僵尸会话再继续，避免「一次失败后按钮永远提示会话进行中」。
  if (
    hostState.activeCaptureSession &&
    !overlayWindows.some((win) => !win.isDestroyed())
  ) {
    hostState.activeCaptureSession = null;
  }

  if (captureStarting || hostState.activeCaptureSession || hostState.longCaptureSession) {
    hostState.captureErrorMessage = '当前已有截图会话进行中，请先完成或取消当前会话。';
    broadcastShellState();
    return { success: false };
  }
  captureStarting = true;
  try {

  hostState.captureErrorMessage = null;

  // 关键修正：macOS「屏幕录制」授权弹窗只能由真正的截图采集 API
  //（desktopCapturer.getSources）触发；systemPreferences.askForMediaAccess('screen')
  // 在 Electron 43 并非合法参数（仅支持 microphone/camera），调用会抛错且不会弹窗。
  // 因此不再前置拦截权限，而是先发起 getSources：权限未决时系统会自动弹出授权请求，
  // 用户允许后本次调用即返回屏幕源，框选 overlay 随即出现。
  // 若用户在「系统设置」手动开启权限，macOS 的 TCC 决策需应用完全退出并重新打开才会
  // 生效，运行中的进程读到的仍是旧状态；故失败时提示必须告知「重启应用」。
  const displays = screen.getAllDisplays();
  const displayBoundsList = displays.map((d) => ({ ...d.bounds }));
  const overlayWindows = ensureOverlayWindowsForDisplays(displayBoundsList);

  // 按显示器「物理像素」请求缩略图，保证截图为原生分辨率。
  // desktopCapturer 的 thumbnail 会被缩放到不超过 thumbnailSize（只缩不放）；
  // 此前固定 2560px 上限，在 Retina / 4K / 5K 屏上物理像素远超该值（如
  // 3024×1964、5120×2880），缩略图被降采样，最终保存的截图明显模糊。
  // 这里按每个显示器 bounds × scaleFactor 计算物理分辨率并取各屏最大值，
  // 确保每个屏都按原生分辨率采集。下游裁剪的缩放系数按
  // thumbnailSize / bounds 动态计算，会自动适配，无需改动。
  // 性能说明：原生分辨率采集比 2560 上限略慢，但仅发生在用户点击截图的
  // 单次操作中，换来的是原图级清晰度。
  const nativeMaxWidth = Math.max(
    ...displays.map((d) => Math.ceil(d.bounds.width * (d.scaleFactor || 1))),
  );
  const nativeMaxHeight = Math.max(
    ...displays.map((d) => Math.ceil(d.bounds.height * (d.scaleFactor || 1))),
  );
  // loadRenderer was fire-and-forget inside createOverlayWindow() so the
  // overlay windows are already loading in the background.  We resume
  // the capture pipeline immediately while loading proceeds in parallel.
  //
  // 关键：desktopCapturer.getSources 在 macOS 上权限未决/未生效时可能抛错，
  // 也可能挂起（既不 resolve 也不 reject）。绝不能让异常沿 IPC 静默传播到
  // 渲染端——渲染端没有对应 catch，会表现为「点击截图按钮无任何反应」。
  // 这里必须捕获一切错误并转换为用户可读的提示。
  let sources;
  try {
    sources = await withTimeout(
      desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: nativeMaxWidth, height: nativeMaxHeight },
      }),
      20000,
      '读取屏幕内容超时（20 秒）',
    );
  } catch (err) {
    refreshPermissionState();
    const st = hostState.permissions.screenCapture;
    console.error('[capture] getSources failed:', err?.message ?? err);
    if (st === 'denied' || st === 'restricted') {
      hostState.captureErrorMessage =
        '屏幕录制权限已被拒绝或受限。请打开「系统设置 → 隐私与安全性 → 屏幕录制」允许本应用，然后完全退出并重新打开本应用（macOS 权限变更需重启后生效）。';
    } else if (st === 'granted') {
      // 权限显示已授予却仍失败：授权后未重启（TCC 对运行中进程不生效）。
      // 主动提供一键自动重启，彻底终结「已添加权限却一直提示需要权限」的循环。
      offerRelaunchForPermission();
      hostState.captureErrorMessage =
        '「屏幕录制」权限已开启，但对当前正在运行的进程尚未生效。请在弹出的对话框中点击「立即重启」（或从菜单栏托盘图标右键退出后重新打开），权限即生效。';
    } else {
      hostState.captureErrorMessage =
        '未能读取屏幕内容：尚未获得「屏幕录制」权限。请允许系统弹出的授权请求；若未弹出，请到「系统设置 → 隐私与安全性 → 屏幕录制」手动开启权限，然后完全退出并重新打开本应用再试。';
    }
    broadcastShellState();
    closeCaptureOverlay();
    return { success: false };
  }

  if (!sources || sources.length === 0) {
    // 未读到屏幕内容：权限未授予 / 被拒绝 / 受限 / 已授予但未重启生效。
    // 读取运行进程内的真实状态给出指引。
    refreshPermissionState();
    const st = hostState.permissions.screenCapture;
    if (st === 'granted') {
      // 状态已 granted 却采集不到屏幕：授权后未重启（TCC 对运行中进程不生效）。
      offerRelaunchForPermission();
      hostState.captureErrorMessage =
        '「屏幕录制」权限已开启，但对当前正在运行的进程尚未生效。请在弹出的对话框中点击「立即重启」（或从菜单栏托盘图标右键退出后重新打开），权限即生效。';
    } else if (st === 'denied' || st === 'restricted') {
      hostState.captureErrorMessage =
        '屏幕录制权限已被拒绝或受限。请打开「系统设置 → 隐私与安全性 → 屏幕录制」允许本应用，然后完全退出并重新打开本应用（macOS 权限变更需重启后生效）。';
    } else {
      hostState.captureErrorMessage =
        '未能读取屏幕内容：尚未获得「屏幕录制」权限。请允许系统弹出的授权请求；若未弹出，请到系统设置开启权限后重启本应用再试。';
    }
    broadcastShellState();
    closeCaptureOverlay();
    return { success: false };
  }

  const sourceByDisplayId = new Map();
  for (const source of sources) {
    sourceByDisplayId.set(source.display_id, source);
  }

  hostState.captureDisplays = [];
  const usedSourceIds = new Set();
  for (const display of displays) {
    // 优先按 display_id 精确匹配。macOS 上 source.display_id 可能为空串或
    // 与 screen.getAllDisplays 的 id 不一致，此时按剩余未分配的 source 顺序
    // 回退匹配，保证每个显示器都能拿到屏幕内容（单屏场景必然命中第一个），
    // 避免「权限已授予、getSources 成功却仍进不了框选」的错配。
    let source = sourceByDisplayId.get(`${display.id}`);
    if (!source || usedSourceIds.has(source.id)) {
      source = sources.find((s) => !usedSourceIds.has(s.id)) ?? null;
    }
    if (source) {
      usedSourceIds.add(source.id);
      hostState.captureDisplays.push({
        displayId: `${display.id}`,
        bounds: { ...display.bounds },
        thumbnailSize: source.thumbnail.getSize(),
        screenshotDataUrl: source.thumbnail.toDataURL(),
      });
    }
  }

  if (hostState.captureDisplays.length === 0) {
    hostState.captureErrorMessage = '当前未能读取屏幕内容，请稍后再试。';
    broadcastShellState();
    closeCaptureOverlay();
    return { success: false };
  }

  // Wait for every overlay window to finish its initial paint.  On slow
  // machines or with `file://` protocol the React bundle and CSS may
  // trail behind the `loadURL` resolve; the `did-finish-load` event
  // signals that the document (including sourced scripts) is ready.
  // A 12 s timeout prevents a permanent hang when the dev server is down
  // (isLoading() stays true after a failed loadURL in some Electron versions).
  await Promise.race([
    Promise.all(
      overlayWindows.map((win) => {
        return new Promise((resolve) => {
          if (win.isDestroyed()) return resolve();
          if (win.webContents.isLoading()) {
            win.webContents.once('did-finish-load', resolve);
          } else {
            resolve();
          }
        });
      }),
    ),
    new Promise((resolve) => setTimeout(resolve, 12000)),
  ]);

  // Inject transparent background CSS into every overlay window to guard
  // against the FOUC (Flash of Unstyled Content) that would show the
  // default gradient background before React sets data-desktop-surface.
  for (const win of overlayWindows) {
    if (win.isDestroyed()) continue;
    try {
      await win.webContents.insertCSS(
        'html,body,#root{background:transparent!important}',
      );
    } catch {
      // CSS injection is a best-effort safeguard.
    }
  }

  // 至少一个 overlay 窗口真正加载出了渲染页面，才认为框选界面可用；
  // 否则会出现「窗口已显示但完全透明、挡住点击却看不到任何内容」的假死状态。
  const loadedOverlays = overlayWindows.filter(
    (win) => !win.isDestroyed() && win.webContents.getURL().includes('index.html'),
  );
  if (loadedOverlays.length === 0) {
    hostState.captureErrorMessage = '截图框选界面加载失败，请重试；若持续失败请重新安装或更新应用。';
    broadcastShellState();
    closeCaptureOverlay();
    return { success: false };
  }

  hostState.activeCaptureSession = {
    mode,
    overlayBounds: displays.map((d) => ({ ...d.bounds })),
  };

  // Broadcast state BEFORE showing overlay windows.  This guarantees
  // that when the React component calls getShellState() it receives
  // the activeCaptureSession immediately, avoiding a frame where the
  // component renders the transparent fallback guard before the real
  // overlay UI.
  broadcastShellState();

  for (const win of overlayWindows) {
    if (!win.isDestroyed()) {
      win.show();
      // Force the OS-level screenshot cursor on every overlay window so it stays
      // consistent when the pointer crosses between physical displays. CSS alone
      // resets to the system default at window (screen) boundaries.
      try {
        win.setCursor('crosshair');
      } catch {
        // Ignore transient cursor errors.
      }
    }
  }

  // `?.` only guards against null/undefined — a destroyed BrowserWindow still
  // throws "Object has been destroyed" on .focus(). Guard explicitly.
  if (overlayWindows[0] && !overlayWindows[0].isDestroyed()) {
    overlayWindows[0].focus();
  }
  return { success: true };
  } catch (err) {
    // 兜底：任何未预期异常都不能沿 IPC 静默抛给渲染端——渲染端表现为
    // 「点击截图按钮无任何反应」。统一转换为用户可见的错误提示并清理现场。
    console.error('[capture] startScreenCapture unexpected error:', err);
    hostState.activeCaptureSession = null;
    hostState.captureErrorMessage = `发起截图失败：${err?.message ?? String(err)}。请重试；若持续失败请完全退出并重新打开本应用。`;
    broadcastShellState();
    closeCaptureOverlay();
    return { success: false };
  } finally {
    captureStarting = false;
  }
}

/**
 * 按选区从整屏截图（data URL）中裁剪出目标区域，返回裁剪后的 data URL。
 * 坐标已缩放到实际像素；越界会被钳制到图像范围内。
 * @param dataUrl 整屏截图（display-local 缩略图）
 * @param selection 选区（已乘缩放比的实际像素坐标）
 * @returns 裁剪后的 PNG data URL
 */
function cropScreenshot(dataUrl, selection) {
  const image = nativeImage.createFromDataURL(dataUrl);
  const imageSize = image.getSize();
  const cropRect = {
    x: Math.max(0, Math.min(imageSize.width - 1, Math.round(selection.x))),
    y: Math.max(0, Math.min(imageSize.height - 1, Math.round(selection.y))),
    width: Math.max(1, Math.min(imageSize.width, Math.round(selection.width))),
    height: Math.max(1, Math.min(imageSize.height, Math.round(selection.height))),
  };

  return image.crop(cropRect).toDataURL();
}

/**
 * 根据截图框选选区与发送方 overlay 窗口，定位所属显示器并裁剪出选区图像。
 * 选区坐标为显示器本地坐标；优先按窗口 bounds 精确匹配，失败则按中心点回退。
 * @param selection overlay 回传的选区（display-local）
 * @param senderWindow 触发确认的 overlay 窗口
 * @returns 包含所属 displayId 与裁剪图像的对象；定位失败返回 null
 */
function resolveCaptureFromOverlaySelection(selection, senderWindow) {
  // Per-display overlay: selection coords are already display-local.
  // Match by center point — most robust across macOS window manager quirks.
  let windowBounds;
  try {
    windowBounds = senderWindow.getBounds();
  } catch {
    return null;
  }

  const centerX = windowBounds.x + selection.x + selection.width / 2;
  const centerY = windowBounds.y + selection.y + selection.height / 2;

  // Try exact bounds match first, then center-point fallback
  const captureDisplay = hostState.captureDisplays.find((display) => {
    const db = display.bounds;
    return (Math.abs(db.x - windowBounds.x) <= 1 &&
      Math.abs(db.y - windowBounds.y) <= 1 &&
      Math.abs(db.width - windowBounds.width) <= 1 &&
      Math.abs(db.height - windowBounds.height) <= 1);
  }) ?? hostState.captureDisplays.find((display) => {
    const { x, y, width, height } = display.bounds;
    return centerX >= x && centerX <= x + width && centerY >= y && centerY <= y + height;
  });

  if (!captureDisplay) {
    return null;
  }

  return resolveForDisplay(captureDisplay, selection);
}

function resolveForDisplay(captureDisplay, selection) {
  const scaleX = captureDisplay.thumbnailSize.width / captureDisplay.bounds.width;
  const scaleY = captureDisplay.thumbnailSize.height / captureDisplay.bounds.height;
  return {
    displayId: captureDisplay.displayId,
    imageDataUrl: cropScreenshot(captureDisplay.screenshotDataUrl, {
      x: selection.x * scaleX,
      y: selection.y * scaleY,
      width: selection.width * scaleX,
      height: selection.height * scaleY,
    }),
  };
}

async function finalizeSingleCapture(imageDataUrl) {
  // Show result window immediately with loading state
  hostState.recentCaptureResult = {
    text: '',
    capturedAt: new Date().toISOString(),
    wasEmpty: false,
    imageDataUrl,
    loading: true,
  };
  showResultWindow();
  broadcastShellState();

  try {
    console.log(`[ocr] Recognising image, data URL length: ${imageDataUrl?.length ?? 0}`);
    const recognizedText = await recognizeTextFromImage(imageDataUrl);
    console.log(`[ocr] Recognition complete, text length: ${recognizedText.length}`);
    hostState.recentCaptureResult = {
      text: recognizedText,
      capturedAt: new Date().toISOString(),
      wasEmpty: recognizedText.trim().length === 0,
      imageDataUrl,
      loading: false,
    };
  } catch (err) {
    console.error('[ocr] Recognition failed:', err.message);
    hostState.captureErrorMessage = '本机离线识别失败，请确认当前 macOS 可用 Vision OCR 后重试。';
    hostState.recentCaptureResult = {
      text: '',
      capturedAt: new Date().toISOString(),
      wasEmpty: true,
      imageDataUrl,
      loading: false,
    };
  }

  persistState();
  broadcastShellState();
}

/**
 * 处理 overlay 提交的框选结果：在关闭 overlay 前定位发送方窗口与选区并裁剪；
 * long 模式进入长截图会话并启动自动采集，否则走单次识别流程。
 * @param event IPC 事件（用于定位 sender 窗口）
 * @param selection 框选选区
 * @returns { success }
 */
async function completeScreenCapture(event, selection) {
  if (!hostState.activeCaptureSession) {
    return { success: false };
  }

  const session = hostState.activeCaptureSession;
  const senderWindow = BrowserWindow.fromWebContents(event.sender);

  // Capture sender window info BEFORE closing overlays (windows get destroyed)
  let resolvedCapture;
  let senderBounds = null;
  try {
    if (senderWindow && !senderWindow.isDestroyed()) {
      senderBounds = senderWindow.getBounds();
      resolvedCapture = resolveCaptureFromOverlaySelection(selection, senderWindow);
    }
  } catch {
    // Window may already be gone
  }

  hostState.activeCaptureSession = null;
  hostState.captureErrorMessage = null;
  closeCaptureOverlay();

  if (!resolvedCapture) {
    hostState.captureDisplays = [];
    hostState.captureErrorMessage = '当前未能定位你选择的屏幕区域，请重新框选。';
    broadcastShellState();
    return { success: false };
  }

  const imageDataUrl = resolvedCapture.imageDataUrl;

  if (session.mode === 'quick') {
    // Copy cropped image to system clipboard and end — no OCR.
    const image = nativeImage.createFromDataURL(imageDataUrl);
    clipboard.writeImage(image);
    hostState.captureDisplays = [];
    hostState.captureErrorMessage = null;
    broadcastShellState();
    return { success: true };
  }

  if (session.mode === 'long') {
    // Use the SAME capture path as subsequent segments so the first segment
    // has identical resolution/coordinates (avoids stitch misalignment).
    const firstSegmentImage = await captureLongSegmentImage({
      selection,
      displayId: resolvedCapture.displayId,
    });
    const firstImageDataUrl = firstSegmentImage ?? imageDataUrl;

    let recognizedText = '';

    try {
      recognizedText = await recognizeTextFromImage(firstImageDataUrl);
    } catch {
      hostState.captureErrorMessage = '长截图首段识别失败，你仍可继续采集后续分段并在完成后统一编辑。';
    }

    const targetDisplay = hostState.captureDisplays.find(
      (d) => d.displayId === resolvedCapture.displayId,
    );

    hostState.longCaptureSession = {
      selection,
      displayId: resolvedCapture.displayId,
      displayBounds: senderBounds ?? targetDisplay?.bounds ?? { x: 0, y: 0, width: 1920, height: 1080 },
      segmentsCaptured: 1,
      latestSegmentPreview: firstImageDataUrl,
      latestSegmentThumbnail: makeThumbnailDataUrl(firstImageDataUrl),
      capturedTexts: [recognizedText],
      mode: 'auto',
      isPaused: false,
      capturedImages: [firstImageDataUrl],
    };
    hostState.captureDisplays = [];
    showLongToolbarWindow();
    broadcastShellState();
    // Start auto-capture timer (default mode is 'auto')
    startAutoCaptureTimer();
    return { success: true };
  }

  hostState.captureDisplays = [];

  await finalizeSingleCapture(imageDataUrl);
  broadcastShellState();
  return { success: true };
}

// Shared capture path so the FIRST segment and subsequent segments use the
// exact same resolution (native physical pixels) and coordinate handling.
// This keeps all stitched images dimensionally consistent.
async function captureLongSegmentImage(session) {
  const displays = screen.getAllDisplays();
  const targetDisplay = displays.find((d) => `${d.id}` === session.displayId) ?? screen.getPrimaryDisplay();

  // 逻辑点 × scaleFactor = 物理像素。此前仅用逻辑尺寸（display.size）请求缩略图，
  // Retina 屏上相当于以 1x 分辨率采集（原生的一半），长截图每一段都被降采样而模糊。
  // 所有分段（含首段）都走本函数，分辨率必然一致，拼接按 naturalWidth 取最小值
  // 绘制、重叠检测分辨率无关，提升到原生分辨率不影响拼接一致性。
  const scaleFactor = targetDisplay.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.ceil(targetDisplay.size.width * scaleFactor),
      height: Math.ceil(targetDisplay.size.height * scaleFactor),
    },
  });
  const source =
    sources.find((item) => item.display_id === session.displayId) ??
    sources.find((item) => item.display_id === `${targetDisplay.id}`) ??
    sources[0];
  if (!source) {
    return null;
  }

  // Selection is in display-local logical coords (overlay matches its display bounds)
  const displayBounds = targetDisplay.bounds;
  const thumbnailSize = source.thumbnail.getSize();
  const scaleX = thumbnailSize.width / displayBounds.width;
  const scaleY = thumbnailSize.height / displayBounds.height;

  const displayLocalSelection = {
    x: Math.round(session.selection.x * scaleX),
    y: Math.round(session.selection.y * scaleY),
    width: Math.round(session.selection.width * scaleX),
    height: Math.round(session.selection.height * scaleY),
  };

  return cropScreenshot(source.thumbnail.toDataURL(), displayLocalSelection);
}

async function captureLongSegment() {
  if (!hostState.longCaptureSession) {
    return { success: false };
  }

  // 不在采集前按运行进程内的权限状态硬性中止：macOS 的 TCC 决策在手动变更后需重启
  // 才生效，运行中的进程可能读到过时的 denied；直接发起采集，getSources 返回空时由
  // 下方 imageDataUrl 为空分支给出明确提示，避免长截图采集中途被误中断。
  refreshPermissionState();

  const session = hostState.longCaptureSession;
  const imageDataUrl = await captureLongSegmentImage(session);
  if (!imageDataUrl) {
    hostState.captureErrorMessage =
      '当前未能读取下一段屏幕内容：可能是「屏幕录制」权限未授予。请在系统设置中开启本应用的屏幕录制权限，并完全退出重新打开本应用后重试。';
    broadcastShellState();
    return { success: false };
  }

  hostState.longCaptureSession.latestSegmentPreview = imageDataUrl;
  hostState.longCaptureSession.latestSegmentThumbnail = makeThumbnailDataUrl(imageDataUrl);
  hostState.captureErrorMessage = null;

  // Store image for stitching
  if (!hostState.longCaptureSession.capturedImages) {
    hostState.longCaptureSession.capturedImages = [];
  }
  hostState.longCaptureSession.capturedImages.push(imageDataUrl);

  try {
    const recognizedText = await recognizeTextFromImage(imageDataUrl);
    hostState.longCaptureSession.capturedTexts.push(recognizedText);
    hostState.longCaptureSession.segmentsCaptured += 1;
  } catch {
    hostState.captureErrorMessage = '当前分段识别失败，你可以继续采集下一段或直接完成本次长截图。';
    hostState.longCaptureSession.capturedTexts.push('');
    hostState.longCaptureSession.segmentsCaptured += 1;
  }

  broadcastShellState();
  return { success: true };
}

async function finishLongCapture() {
  if (!hostState.longCaptureSession) {
    return { success: false };
  }

  stopAutoCaptureTimer();

  const session = hostState.longCaptureSession;
  const mergedText = (session.capturedTexts?.length ?? 0) > 0
    ? mergeLongCaptureText(session.capturedTexts)
    : '';

  // Step 1: Stitch captured images (relatively fast)
  let longImageDataUrl = null;

  if (session.capturedImages && session.capturedImages.length > 0) {
    try {
      longImageDataUrl = await stitchLongImage(session.capturedImages);
    } catch (err) {
      console.error('Long image stitching failed:', err);
    }
  }

  if (!longImageDataUrl && session.latestSegmentPreview) {
    longImageDataUrl = session.latestSegmentPreview;
  }

  // Step 2: Show result window immediately with loading + long image preview
  hostState.recentCaptureResult = {
    text: mergedText,
    capturedAt: new Date().toISOString(),
    wasEmpty: mergedText.trim().length === 0,
    imageDataUrl: session.capturedImages?.[0] ?? session.latestSegmentPreview ?? null,
    longImageDataUrl,
    loading: true,
  };

  hostState.longCaptureSession = null;
  hostState.captureErrorMessage = null;
  _longCaptureNoChangeCount = 0;
  closeLongToolbarWindow();
  destroyStitcherWindow();
  persistState();
  showResultWindow();
  broadcastShellState();

  // Step 3: OCR the full long image (may take time)
  let fullOcrText = '';
  if (longImageDataUrl) {
    try {
      fullOcrText = await recognizeTextFromImage(longImageDataUrl);
    } catch {
      // Fall back to merged segment text
    }
  }

  const finalText = fullOcrText.trim() || mergedText;
  hostState.recentCaptureResult = {
    text: finalText,
    capturedAt: new Date().toISOString(),
    wasEmpty: finalText.trim().length === 0,
    imageDataUrl: session.latestSegmentPreview,
    longImageDataUrl,
    loading: false,
  };

  persistState();
  broadcastShellState();
  return { success: true };
}

async function cancelCaptureSession() {
  hostState.activeCaptureSession = null;
  hostState.longCaptureSession = null;
  hostState.captureErrorMessage = '已取消当前截图会话。';
  _longCaptureNoChangeCount = 0;
  stopAutoCaptureTimer();
  closeCaptureOverlay();
  closeLongToolbarWindow();
  destroyStitcherWindow();
  broadcastShellState();
  return { success: true };
}

function closeCurrentWindow(event) {
  const window = BrowserWindow.fromWebContents(event.sender);
  window?.hide();
  return { success: true };
}

function saveShortcutPreference(_, request) {
  const mode = request?.mode;
  const accelerator = request?.accelerator?.trim();
  if ((mode !== 'single' && mode !== 'long' && mode !== 'menu' && mode !== 'quick') || !accelerator) {
    hostState.shortcutRegistrationError = '请输入可注册的快捷键格式，例如 CommandOrControl+Shift+1。';
    broadcastShellState();
    return { success: false };
  }

  const previousPreferences = {
    single: { ...hostState.shortcutPreferences.single },
    long: { ...hostState.shortcutPreferences.long },
    menu: { ...hostState.shortcutPreferences.menu },
    quick: { ...hostState.shortcutPreferences.quick },
  };
  updateShortcutPreference(mode, accelerator);
  const registered = registerScreenshotShortcut();

  if (!registered) {
    hostState.shortcutPreferences = previousPreferences;
    registerScreenshotShortcut();
    persistState();
    broadcastShellState();
    return { success: false };
  }

  broadcastShellState();
  return { success: true };
}

function saveAdvancedFeatures(_, request) {
  const value = request?.config;
  const af = value && typeof value === 'object' ? value : {};

  hostState.advancedFeatures = {
    enabled: typeof af.enabled === 'boolean' ? af.enabled : true,
    filterSymbols: Array.isArray(af.filterSymbols)
      ? af.filterSymbols.filter((s) => typeof s === 'string').slice(0, 200)
      : [],
    charReplacements: Array.isArray(af.charReplacements)
      ? af.charReplacements
          .filter((r) => r && typeof r === 'object')
          .map((r) => ({
            source: typeof r.source === 'string' ? r.source : '',
            target: typeof r.target === 'string' ? r.target : '',
          }))
          .slice(0, 200)
      : [],
    regexRules: Array.isArray(af.regexRules)
      ? af.regexRules
          .filter((r) => r && typeof r === 'object')
          .map((r) => ({
            pattern: typeof r.pattern === 'string' ? r.pattern : '',
            replacement: typeof r.replacement === 'string' ? r.replacement : '',
            flags: typeof r.flags === 'string' ? r.flags : 'g',
            mode: r.mode === 'filter' ? 'filter' : 'replace',
          }))
          .slice(0, 200)
      : [],
  };

  persistState();
  broadcastShellState();
  return { success: true };
}

function saveRecentResultText(_, request) {
  if (!hostState.recentCaptureResult) {
    return { success: false };
  }

  const text = typeof request?.text === 'string' ? request.text : '';
  hostState.recentCaptureResult = {
    ...hostState.recentCaptureResult,
    text,
    wasEmpty: text.trim().length === 0,
  };
  persistState();
  broadcastShellState();
  return { success: true };
}

function copyResultText(_, request) {
  const text = typeof request?.text === 'string' ? request.text : '';
  if (text.startsWith('data:image/')) {
    try {
      const image = nativeImage.createFromDataURL(text);
      clipboard.writeImage(image);
      return { success: true };
    } catch {
      // fall through to text copy
    }
  }
  clipboard.writeText(text);
  return { success: true };
}

function setLongCaptureMode(_, request) {
  if (!hostState.longCaptureSession) {
    return { success: false };
  }

  const mode = request?.mode;
  if (mode !== 'auto' && mode !== 'manual') {
    return { success: false };
  }

  hostState.longCaptureSession.mode = mode;
  hostState.longCaptureSession.isPaused = false;
  _longCaptureNoChangeCount = 0;

  if (mode === 'auto') {
    startAutoCaptureTimer();
  } else {
    stopAutoCaptureTimer();
  }

  broadcastShellState();
  return { success: true };
}

function toggleLongCapturePause() {
  if (!hostState.longCaptureSession) {
    return { success: false };
  }

  if (hostState.longCaptureSession.mode !== 'auto') {
    return { success: false };
  }

  hostState.longCaptureSession.isPaused = !hostState.longCaptureSession.isPaused;
  _longCaptureNoChangeCount = 0;
  broadcastShellState();
  return { success: true };
}

async function saveLongImage() {
  if (!hostState.recentCaptureResult?.longImageDataUrl) {
    return { success: false };
  }

  const defaultPath = path.join(
    app.getPath('desktop'),
    `long-screenshot-${Date.now()}.png`,
  );

  try {
    const { canceled, filePath } = await dialog.showSaveDialog(
      resultWindow && !resultWindow.isDestroyed() ? resultWindow : undefined,
      {
        title: '保存长图',
        defaultPath,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      },
    );

    if (canceled || !filePath) {
      return { success: false, canceled: true };
    }

    const tempPath = writeImageDataUrlToTempFile(hostState.recentCaptureResult.longImageDataUrl);
    fs.copyFileSync(tempPath, filePath);
    fs.rmSync(tempPath, { force: true });
    return { success: true, path: filePath };
  } catch (err) {
    console.error('Save long image failed:', err);
    return { success: false };
  }
}

function openScreenCapturePreferences() {
  if (process.platform !== 'darwin') {
    return { success: false };
  }

  execFile('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']);
  return { success: true };
}

function registerIpcHandlers() {
  ipcMain.handle('desktop-host:get-shell-state', () => {
    refreshPermissionState();
    return getShellState();
  });

  ipcMain.handle('desktop-host:show-result-window', () => {
    showResultWindow();
    return { success: true };
  });

  ipcMain.handle('desktop-host:show-settings-window', () => {
    showSettingsWindow();
    return { success: true };
  });

  ipcMain.handle('desktop-host:toggle-panel-window', () => {
    togglePanelWindow();
    return { success: true };
  });

  ipcMain.handle('desktop-host:start-screen-capture', () => startScreenCapture('single'));
  ipcMain.handle('desktop-host:start-long-screen-capture', () => startScreenCapture('long'));
  ipcMain.handle('desktop-host:start-quick-screen-capture', () => startScreenCapture('quick'));

  // Keep the screenshot cursor consistent across every physical display.
  // On macOS, win.setCursor() only sticks for the *key* window. When the pointer
  // crosses from one overlay (screen) to another, the newly-entered window is not
  // key, so macOS reverts to the system default arrow. Re-asserting the cursor and
  // focusing the window under the pointer fixes the cross-screen reset.
  ipcMain.handle('desktop-host:activate-overlay', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      try {
        win.setCursor('crosshair');
      } catch {
        // Ignore transient cursor errors.
      }
      if (!win.isFocused()) {
        try {
          win.focus();
        } catch {
          // Ignore focus errors (window may be closing).
        }
      }
    }
    return { success: true };
  });
  ipcMain.handle('desktop-host:complete-screen-capture', completeScreenCapture);
  ipcMain.handle('desktop-host:cancel-capture-session', cancelCaptureSession);
  ipcMain.handle('desktop-host:capture-long-segment', captureLongSegment);
  ipcMain.handle('desktop-host:finish-long-capture', finishLongCapture);
  ipcMain.handle('desktop-host:set-long-capture-mode', setLongCaptureMode);
  ipcMain.handle('desktop-host:toggle-long-capture-pause', toggleLongCapturePause);
  ipcMain.handle('desktop-host:save-long-image', saveLongImage);
  ipcMain.handle('desktop-host:save-recent-result-text', saveRecentResultText);
  ipcMain.handle('desktop-host:save-shortcut-preference', saveShortcutPreference);
  ipcMain.handle('desktop-host:save-advanced-features', saveAdvancedFeatures);
  ipcMain.handle('desktop-host:copy-result-text', copyResultText);
  ipcMain.handle('desktop-host:get-recent-capture-images', () => {
    const r = hostState.recentCaptureResult;
    return {
      imageDataUrl: r?.imageDataUrl ?? null,
      longImageDataUrl: r?.longImageDataUrl ?? null,
    };
  });
  ipcMain.handle('desktop-host:open-screen-capture-preferences', openScreenCapturePreferences);
  ipcMain.handle('desktop-host:set-auto-launch', setAutoLaunch);
  ipcMain.handle('desktop-host:open-login-items-settings', openLoginItemsSettings);
  ipcMain.handle('desktop-host:close-current-window', closeCurrentWindow);
  ipcMain.handle('desktop-host:request-window-fit', (event, contentHeight) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      return { success: false };
    }
    try {
      const maxH = Math.max(360, Math.floor(screen.getPrimaryDisplay().workArea.height - 40));
      const target = Math.min(Math.max(Math.round(Number(contentHeight) || 0), 200), maxH);
      const [width] = win.getSize();
      win.setSize(width, target, true);
      return { success: true };
    } catch {
      return { success: false };
    }
  });
}

app.whenReady().then(() => {
  const startTs = Date.now();
  loadPersistedState();
  initAutoLaunch();
  refreshPermissionState();
  registerScreenshotShortcut();
  registerIpcHandlers();
  createTray();
  ensurePanelWindow();
  // Each window fetches its own state on mount (`useDesktopHostState` calls
  // getShellState), so the eager broadcast is unnecessary and would otherwise
  // push a full shell snapshot over IPC right at startup.
  console.log(`[perf] App ready in ${Date.now() - startTs}ms`);

  // Warm the compiled OCR binary in the background so the first capture does
  // not pay the swiftc cost. Non-blocking; falls back to `swift` if needed.
  void ensureOcrExecutable();

  app.on('activate', () => {
    togglePanelWindow();
  });

  if (isDevelopment()) {
    const window = ensurePanelWindow();
    window.center();
    window.show();
    window.focus();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});
