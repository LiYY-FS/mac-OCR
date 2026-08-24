#!/usr/bin/env bash
#
# 文件：build.sh
# 职责：一键将本项目（Electron + React + Vite 的 macOS OCR 桌面应用）打包为
#       可用的 .dmg 应用程序包。完整流程：清理旧产物 → 环境检查 → 前端全量构建 →
#       electron-builder 产出 .app → hdiutil 生成 .dmg。每次均执行全量构建。
# 用法：bash build.sh  （或 ./build.sh，需先 chmod +x）
# 环境：macOS + Bash；依赖 node/pnpm/electron-builder/swiftc(可选)/hdiutil。
#

set -euo pipefail

# ── 基础路径与常量 ───────────────────────────────────────────────────────────
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

LOG="$ROOT/build-dmg.log"
DIST_DIR="$ROOT/dist"
RELEASE_DIR="$ROOT/release"
ICON_PNG="$ROOT/public/img/icon.png"
BACKGROUND_PNG="$ROOT/public/img/background.png"
ELECTRON_BUILDER="$ROOT/node_modules/.bin/electron-builder"

# 从 package.json 读取 productName / version（无 jq 时用 node 兜底）。
APP_NAME="mac-OCR"
APP_VERSION="0.0.0"

# DMG 安装窗口内容区尺寸（宽度 640 / 高度 360）。
# 背景图会按此尺寸缩放，确保在安装窗口中完整显示、不裁剪。
DMG_WIN_WIDTH=440
DMG_WIN_HEIGHT=260
# bounds 包含标题栏，因此总高度 = 内容区高度 + 28（标题栏约 28px）。
DMG_WIN_BOUNDS="{100, 100, 540, 388}"
# 图标位置按窗口尺寸比例从 1280x720 缩放（0.5 倍）。
DMG_APP_ICON_POS="{125, 150}"
DMG_APPS_ICON_POS="{325, 150}"

# 临时挂载目录（dmg 制作用），trap 中清理。
DMG_STAGING=""

# 全局失败标记：ERR/EXIT 在 bash 3.2 下对退出码的处理存在偏差，
# 用显式标记确保即使退出码被重置也不会误报"全部完成"。
FAILED=0

# ── 日志与错误处理 ───────────────────────────────────────────────────────────
# 每次运行清空日志文件，便于定位本次构建问题。
: >"$LOG"

_ts() { date '+%Y-%m-%d %H:%M:%S'; }

log()  { printf '[%s] [INFO]  %s\n' "$(_ts)" "$*"  | tee -a "$LOG"; }
warn() { printf '[%s] [WARN]  %s\n' "$(_ts)" "$*"  | tee -a "$LOG" >&2; }
err()  { printf '[%s] [ERROR] %s\n' "$(_ts)" "$*"  | tee -a "$LOG" >&2; }

# 明确失败：记录错误、给出提示并以非零码退出。
fail() {
  FAILED=1
  err "$*"
  exit 1
}

# 阶段横幅，便于阅读日志。
stage() {
  printf '\n[%s] ===== %s =====\n' "$(_ts)" "$*" | tee -a "$LOG"
}

# 统一异常出口：ERR 由 set -e 触发时打印失败行，EXIT 负责清理临时资源。
on_error() {
  local code=$?
  FAILED=1
  err "流程在第 ${BASH_LINENO[0]} 行中断（退出码 ${code}）。完整日志见：${LOG}"
}

on_exit() {
  local code=$?
  # 清理 dmg 制作过程中的临时挂载/暂存目录。
  if [ -n "${DMG_STAGING}" ] && [ -d "${DMG_STAGING}" ]; then
    rm -rf "${DMG_STAGING}" 2>/dev/null || true
  fi
  # 兜底卸载可能残留的挂载点（含带序号的同名卷与设备）。
  # cleanup_stale_volumes 在下方定义，但 EXIT trap 于脚本结束时才执行，届时已就绪。
  if declare -f cleanup_stale_volumes >/dev/null 2>&1; then
    cleanup_stale_volumes 2>/dev/null || true
  elif [ -d "/Volumes/${APP_NAME}" ]; then
    hdiutil detach "/Volumes/${APP_NAME}" -quiet 2>/dev/null || true
  fi
  # 注意：bash 3.2 在 set -u 触发时 EXIT trap 看到的退出码可能被重置为 0，
  # 因此"全部完成"统一放在 main() 末尾显式输出；这里仅用 FAILED 标记兜底。
  if [ "${FAILED}" -ne 0 ]; then
    err "打包流程异常结束。完整日志见：${LOG}"
  fi
}

trap on_error ERR
trap on_exit EXIT

# ── 工具函数 ─────────────────────────────────────────────────────────────────
has_cmd() { command -v "$1" >/dev/null 2>&1; }

# 卸载所有与本应用同名的残留卷/设备（含 "mac-OCR 1" 之类带序号的挂载）。
# 处理上次构建异常退出未卸载导致的残留，避免新卷被挂到带序号路径。
cleanup_stale_volumes() {
  # 1) 按挂载路径卸载（含空格序号变体）。
  local vol
  for vol in "/Volumes/${APP_NAME}" "/Volumes/${APP_NAME} "*; do
    if [ -d "$vol" ]; then
      log "清理残留卷：${vol}"
      hdiutil detach "$vol" -force -quiet 2>/dev/null || true
    fi
  done

  # 2) 按 hdiutil 记录卸载：凡 image-path 指向本项目 rw.dmg 的设备一并 detach。
  local dev
  for dev in $(hdiutil info 2>/dev/null \
    | awk -v name="${APP_NAME}" '/^\/dev\// && $0 ~ ("/Volumes/" name) {print $1}'); do
    log "清理残留设备：${dev}"
    hdiutil detach "$dev" -force -quiet 2>/dev/null || true
  done
}

# 运行命令并把 stdout/stderr 同时打进日志；失败时返回非零由调用方处理。
run() {
  log "\$ $*"
  "$@" 2>&1 | tee -a "$LOG"
  return "${PIPESTATUS[0]}"
}

# ── 阶段 1：环境检查 ─────────────────────────────────────────────────────────
check_environment() {
  stage "阶段 1/4：环境检查"

  # 1) 必须在 macOS 上运行（Electron mac 打包 + hdiutil + Vision OCR）。
  if [ "$(uname -s)" != "Darwin" ]; then
    fail "当前系统不是 macOS，无法打包 .dmg。请在 macOS 上执行本脚本。"
  fi
  log "操作系统：macOS $(sw_vers -productVersion 2>/dev/null || echo '未知版本')"

  # 2) hdiutil（macOS 内置，用于生成 dmg）。
  if ! has_cmd hdiutil; then
    fail "未找到 hdiutil（macOS 内置工具），无法生成 .dmg。请确认系统完整性。"
  fi

  # 3) Node.js。
  if ! has_cmd node; then
    warn "未检测到 Node.js，尝试通过 Homebrew 安装…"
    if has_cmd brew; then
      run brew install node || fail "Node.js 自动安装失败，请手动安装：https://nodejs.org/"
    else
      fail "未安装 Node.js 且未检测到 Homebrew。请先安装 Node.js（https://nodejs.org/）后重试。"
    fi
  fi
  log "Node.js 版本：$(node -v)"

  # 4) 包管理器：优先 pnpm，缺失则尝试安装（corepack / brew / npm）。
  if ! has_cmd pnpm; then
    warn "未检测到 pnpm，尝试自动安装…"
    if has_cmd corepack; then
      run corepack enable && run corepack prepare pnpm@latest --activate || true
    fi
    if ! has_cmd pnpm && has_cmd brew; then
      run brew install pnpm || true
    fi
    if ! has_cmd pnpm && has_cmd npm; then
      run npm install -g pnpm || true
    fi
    has_cmd pnpm || fail "pnpm 自动安装失败，请手动安装：https://pnpm.io/installation"
  fi
  log "pnpm 版本：$(pnpm -v)"

  # 5) Xcode Command Line Tools / swiftc（离线 OCR 需要；缺失给出明确提示）。
  if ! has_cmd swiftc; then
    warn "未检测到 swiftc（Xcode Command Line Tools）。应用的离线 OCR 功能在运行时需要它。"
    warn "无法静默安装，请手动执行：xcode-select --install"
    warn "（打包过程本身可继续，但强烈建议安装以保证 OCR 可用。）"
  else
    log "swiftc：$(swiftc --version 2>/dev/null | head -n1 || echo '已安装')"
  fi

  # 6) 项目依赖：node_modules 与 electron-builder。缺失则安装。
  if [ ! -d "$ROOT/node_modules" ] || [ ! -x "$ELECTRON_BUILDER" ]; then
    warn "缺少项目依赖（node_modules / electron-builder），执行 pnpm install…"
    run pnpm install --frozen-lockfile \
      || run pnpm install \
      || fail "依赖安装失败，请检查网络或 pnpm-lock.yaml 后重试。"
  fi
  [ -x "${ELECTRON_BUILDER}" ] || fail "electron-builder 未就绪（${ELECTRON_BUILDER} 不存在）。请重新执行 pnpm install。"
  log "electron-builder：$("${ELECTRON_BUILDER}" --version 2>/dev/null || echo '已安装')"

  # 7) 校验图标资源存在（package.json build.mac.icon 引用）。
  if [ ! -f "${ICON_PNG}" ]; then
    fail "未找到应用图标：${ICON_PNG}（package.json 中 mac.icon 引用此文件）。"
  fi
  log "应用图标：${ICON_PNG}"

  # 8) 读取应用名与版本（用于 dmg 命名）。
  read_app_meta
  log "应用信息：${APP_NAME} v${APP_VERSION}"

  log "环境检查通过。"
}

# 从 electron-builder.config.cjs 与 package.json 解析 productName / version。
read_app_meta() {
  local name version
  name="$(node -p "try{require('./electron-builder.config.cjs').productName}catch(e){require('./package.json').name}" 2>/dev/null || true)"
  version="$(node -p "require('./package.json').version" 2>/dev/null || true)"
  [ -n "${name}" ] && APP_NAME="${name}"
  [ -n "${version}" ] && APP_VERSION="${version}"
  return 0
}

# 预编译 OCR 引擎二进制，将其打进 app，使生产环境无需依赖 swiftc/swift。
# 打包后的应用运行环境通常不含 Xcode 工具链，若不预编译，离线识别会静默失败。
compile_ocr_binary() {
  stage "预编译 OCR 引擎（打包内置，避免生产环境缺 swift）"

  local ocr_src="$ROOT/electron/ocr.swift"
  local ocr_bin="$ROOT/electron/screen-ocr-engine.bin"

  if [ ! -f "$ocr_src" ]; then
    warn "未找到 OCR 源码：${ocr_src}，跳过预编译。"
    return 0
  fi

  if ! has_cmd swiftc; then
    warn "未找到 swiftc，无法预编译 OCR 二进制；打包后的应用将缺少离线识别能力。"
    return 0
  fi

  log "使用 swiftc 交叉编译 x86_64 与 arm64 并 lipo 合并为通用（Universal）二进制…"
  # 通用打包要求 OCR 引擎在两套架构切片中均为合法通用二进制；
  # 若其为单架构且两份相同，electron-builder 的合并步骤会直接报错。
  # 因此这里分别产出 x64 / arm64 两个 Mach-O，再用 lipo 合并为 fat 二进制，
  # 这样无论打包目标是 universal / x64 / arm64 都能正确合并。
  # 部署目标至少 macOS 13（源码用到 automaticallyDetectsLanguage，需 13.0+）。
  local ocr_x64="$ROOT/electron/screen-ocr-engine.x64.bin"
  local ocr_arm64="$ROOT/electron/screen-ocr-engine.arm64.bin"

  if run swiftc -O -target x86_64-apple-macosx13.0 "$ocr_src" -o "$ocr_x64" \
     && run swiftc -O -target arm64-apple-macosx13.0 "$ocr_src" -o "$ocr_arm64" \
     && run lipo -create -output "$ocr_bin" "$ocr_x64" "$ocr_arm64"; then
    rm -f "$ocr_x64" "$ocr_arm64" 2>/dev/null || true
    chmod +x "$ocr_bin" 2>/dev/null || true
    log "OCR 引擎通用二进制已生成：${ocr_bin}"
    log "$(lipo -info "$ocr_bin" 2>/dev/null || echo '（架构信息获取失败）')"
  else
    # 交叉编译/合并失败（极端环境）时回退为单架构编译；
    # 配合配置中的 x64ArchFiles，合并步骤会跳过该文件（异架构 Mac 经 Rosetta 运行 OCR），
    # 不阻断整体通用打包。
    warn "OCR 通用二进制编译失败，回退为单架构编译（异架构 Mac 上将经 Rosetta 运行）。"
    rm -f "$ocr_x64" "$ocr_arm64" 2>/dev/null || true
    if run swiftc -O "$ocr_src" -o "$ocr_bin"; then
      chmod +x "$ocr_bin" 2>/dev/null || true
      log "OCR 引擎单架构二进制已生成：${ocr_bin}"
    else
      warn "OCR 引擎编译失败，打包后的应用将缺少离线识别能力（开发态仍可回退 swift）。"
    fi
  fi
}

# ── 阶段 2：清理旧产物 & 前端全量构建 ────────────────────────────────────────
build_frontend() {
  stage "阶段 2/4：清理旧产物 & 前端全量构建"

  # 强制删除旧产物，确保每次都是全量构建。
  if [ -d "$DIST_DIR" ]; then
    log "删除旧构建产物：${DIST_DIR}"
    rm -rf "$DIST_DIR"
  fi

  log "执行 pnpm build（全量构建）…"
  run pnpm build || fail "前端生产构建失败（tsc -b && vite build --mode live）。请查看上方日志定位类型/构建错误。"

  # 构建后校验产物完整性。
  if [ ! -f "$DIST_DIR/index.html" ]; then
    fail "构建完成但产物不完整：未找到 ${DIST_DIR}/index.html。"
  fi
  if [ ! -d "$DIST_DIR/assets" ] || ! find "$DIST_DIR/assets" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    fail "构建完成但产物不完整：${DIST_DIR}/assets 为空。"
  fi
  log "前端构建产物校验通过。"
}

# ── 阶段 3：electron-builder 产出 .app ───────────────────────────────────────
build_app() {
  stage "阶段 3/4：electron-builder 打包 .app"

  # 清理旧的 mac 产物目录，避免残留导致定位到过期 .app。
  # 通用（universal）打包的 --dir 产物位于 release/mac；
  # 同时清理历史 arm64/x64/universal 目录，防止交叉架构残留。
  rm -rf "$RELEASE_DIR/mac" "$RELEASE_DIR/mac-arm64" "$RELEASE_DIR/mac-x64" "$RELEASE_DIR/mac-universal" 2>/dev/null || true

  # --dir 仅产出解包后的 .app（沿用现有 pack 逻辑），dmg 交由 hdiutil 生成。
  # 显式传入 --universal --mac 强制通用（Universal）打包：electron-builder 会
  # 分别下载 x64 / arm64 的 Electron 并用 lipo 合并，确保生成的 .dmg 在 Intel 与
  # Apple Silicon 上均可安装使用（配置 mac.target.arch 已设为 universal，此处显式
  # 兜底，避免默认回退到宿主单机架构）。
  run "${ELECTRON_BUILDER}" --dir --universal --mac --config electron-builder.config.cjs \
    || fail "electron-builder 打包中断。常见原因：依赖损坏、Electron 二进制下载失败、磁盘空间不足。详见 ${LOG}。"

  APP_PATH="$(locate_app_bundle)"
  [ -n "${APP_PATH}" ] || fail "未能在 ${RELEASE_DIR} 下定位到生成的 .app 包。"

  # 校验 .app 结构完整性。
  [ -d "${APP_PATH}/Contents/MacOS" ] || fail "生成的应用不完整：缺少 ${APP_PATH}/Contents/MacOS。"
  [ -f "${APP_PATH}/Contents/Info.plist" ] || fail "生成的应用不完整：缺少 ${APP_PATH}/Contents/Info.plist。"

  log ".app 打包完成并校验通过：${APP_PATH}"
}

# 在 release 目录下定位 .app（通用打包产物位于 release/mac，find 自动覆盖）。
locate_app_bundle() {
  local candidate
  candidate="$(find "$RELEASE_DIR" -maxdepth 2 -name '*.app' -type d 2>/dev/null | head -n1)"
  printf '%s' "$candidate"
}

# ── 阶段 4：hdiutil 生成 .dmg ────────────────────────────────────────────────
make_dmg() {
  stage "阶段 4/4：hdiutil 生成 .dmg"

  [ -n "${APP_PATH:-}" ] || fail "内部错误：APP_PATH 未设置。"

  local dmg_name="${APP_NAME}-${APP_VERSION}.dmg"
  local dmg_path="$RELEASE_DIR/${dmg_name}"
  local rw_dmg="$RELEASE_DIR/${APP_NAME}-${APP_VERSION}-rw.dmg"

  # 暂存目录：内含 .app + Applications 软链接（拖拽安装的标准布局）。
  DMG_STAGING="$(mktemp -d "${TMPDIR:-/tmp}/${APP_NAME}-dmg.XXXXXX")"
  log "创建 dmg 暂存目录：${DMG_STAGING}"

  cp -R "${APP_PATH}" "${DMG_STAGING}/" || fail "拷贝 .app 到暂存目录失败。"
  ln -s /Applications "${DMG_STAGING}/Applications" || fail "创建 Applications 软链接失败。"

  # 附带背景图（放到隐藏目录，供 Finder 展示，不影响拖拽安装）。
  local has_background=0
  if [ -f "$BACKGROUND_PNG" ]; then
    mkdir -p "$DMG_STAGING/.background"
    # 将背景图缩放为窗口内容区尺寸，避免原图过大导致只显示左上角。
    sips -z "${DMG_WIN_HEIGHT}" "${DMG_WIN_WIDTH}" "$BACKGROUND_PNG" \
      --out "$DMG_STAGING/.background/background.png" >/dev/null 2>&1 \
      || fail "缩放背景图失败（请检查 $BACKGROUND_PNG 与 sips 是否可用）。"
    has_background=1
    log "已附带背景图：background.png（已缩放为 ${DMG_WIN_WIDTH}x${DMG_WIN_HEIGHT}）"
  fi

  # 删除旧的 dmg 与中间产物。
  rm -f "$dmg_path" "$rw_dmg" 2>/dev/null || true

  # 清理上次失败残留的同名卷（如 /Volumes/mac-OCR、/Volumes/mac-OCR 1）。
  # 若不清理，新卷会被挂到带序号的路径，导致后续基于卷名/路径的逻辑全部失效，
  # 并使源 DMG 一直被残留设备占用，convert 报"资源暂时不可用"。
  cleanup_stale_volumes

  # 估算可读写 DMG 大小（比实际内容稍大，避免文件系统创建失败）。
  local size_mb
  size_mb="$(($(du -sm "$DMG_STAGING" | awk '{print $1}') + 20))"
  log "预估 DMG 大小：${size_mb} MB"

  # 第一步：创建可读写 DMG，以便挂载后设置 Finder 视图属性。
  run hdiutil create \
    -volname "$APP_NAME" \
    -srcfolder "$DMG_STAGING" \
    -fs HFS+ \
    -format UDRW \
    -size "${size_mb}m" \
    -ov \
    "$rw_dmg" \
    || fail "hdiutil 创建可读写 DMG 失败。请确认磁盘空间充足。"

  [ -f "${rw_dmg}" ] || fail "未找到可读写 DMG：${rw_dmg}。"

  # 第二步：挂载可读写 DMG（-nobrowse 避免桌面出现图标、减少闪烁）。
  # 解析 attach 输出，同时取得设备节点与实际挂载点（不再假设 /Volumes/$APP_NAME，
  # 因为存在同名卷时系统会挂到带序号的路径，如 /Volumes/mac-OCR 1）。
  local attach_output
  attach_output="$(hdiutil attach -nobrowse -readwrite -noverify -noautoopen "$rw_dmg" 2>/dev/null)"

  local device volume
  # 含 /Volumes 的那一行才是数据分区（设备节点 + 挂载点）。
  device="$(printf '%s\n' "$attach_output" | grep '/Volumes/' | awk '{print $1}' | head -n1)"
  volume="$(printf '%s\n' "$attach_output" | grep -o '/Volumes/.*' | head -n1)"
  # 兜底：若未解析到挂载点，退回按 volname 猜测。
  [ -n "${device}" ] || device="$(printf '%s\n' "$attach_output" | grep -E '/dev/' | awk '{print $1}' | head -n1)"
  [ -n "${volume}" ] || volume="/Volumes/$APP_NAME"

  [ -n "${device}" ] || fail "挂载 DMG 失败，无法获取设备名。"
  log "DMG 已挂载：设备 ${device}，挂载点 ${volume}"

  # 实际卷名（供 AppleScript 的 tell disk / eject disk 精确定位）。
  local vol_name
  vol_name="$(basename "$volume")"

  # 等待卷目录就绪。
  local wait_count=0
  while [ ! -d "$volume" ] && [ "$wait_count" -lt 30 ]; do
    sleep 1
    wait_count=$((wait_count + 1))
  done
  [ -d "$volume" ] || fail "DMG 设备已挂载，但卷未出现在 ${volume}。"

  if [ "$has_background" -eq 1 ]; then
    # 第三步：通过 AppleScript 设置 Finder 窗口背景图与图标布局。
    log "配置 DMG 窗口背景图与图标位置…"
    sleep 2

    local app_basename
    app_basename="$(basename "$APP_PATH")"

    # 窗口尺寸已从 1280x720 缩小为 ${DMG_WIN_WIDTH}x${DMG_WIN_HEIGHT}（内容区），整体更紧凑。
    # 需要先 open 窗口以初始化 container window，否则 toolbar/statusbar 等属性无法设置；
    # 背景图已缩放为窗口内容区尺寸，可完整显示。
    # 若后续设计稿调整，请同步修改 DMG_WIN_WIDTH / DMG_WIN_HEIGHT 与 icon 位置。
    if ! osascript <<EOF
tell application "Finder"
  tell disk "$vol_name"
    open
    set current view of container window to icon view
    set theViewOptions to icon view options of container window
    set background picture of theViewOptions to file ".background:background.png"
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to ${DMG_WIN_BOUNDS}
    set arrangement of theViewOptions to not arranged
    set icon size of theViewOptions to 48
    set text size of theViewOptions to 11
    set label position of theViewOptions to bottom
    set position of item "$app_basename" to ${DMG_APP_ICON_POS}
    set position of item "Applications" to ${DMG_APPS_ICON_POS}
    update
    close
  end tell
end tell
EOF
    then
      warn "AppleScript 配置 DMG 窗口失败；DMG 仍可安装，但无背景图与固定图标位置。"
    else
      log "DMG 窗口背景图与图标位置配置成功。"
    fi

    # 给 Finder 时间写入 .DS_Store，避免视图设置未持久化。
    sleep 2
  fi

  # 第四步：通过 Finder eject 卸载（确保 .DS_Store 被 Finder 写入磁盘）。
  # hdiutil detach 不会通知 Finder 刷新缓存，导致 .DS_Store 丢失。
  # 注意：Finder eject 为异步操作，需确认设备真正释放，否则 hdiutil convert
  # 会因源 DMG 仍被占用而报"资源暂时不可用"（EAGAIN）。
  # 通过 Finder eject 卸载（确保 .DS_Store 被 Finder 写入磁盘）。
  # hdiutil detach 不会通知 Finder 刷新缓存，导致 .DS_Store 丢失。
  # 注意：Finder eject 为异步操作，需确认设备真正释放，否则 hdiutil convert
  # 会因源 DMG 仍被占用而报"资源暂时不可用"（EAGAIN）。
  log "卸载 DMG（Finder eject，确保视图设置持久化）…"
  osascript -e "tell application \"Finder\" to eject disk \"$vol_name\"" 2>/dev/null || true

  # 轮询等待卷从 /Volumes 消失（Finder eject 生效）。
  local wait_count=0
  while [ -d "$volume" ] && [ "$wait_count" -lt 15 ]; do
    sleep 1
    wait_count=$((wait_count + 1))
  done

  # 循环强制卸载，直到设备节点从 hdiutil 中彻底消失（最多 10 次）。
  # 仅卷路径消失不代表底层设备已释放，必须以 device 是否仍被 attach 为准。
  local detach_try=0
  while hdiutil info 2>/dev/null | grep -q "${device}"; do
    detach_try=$((detach_try + 1))
    if [ "$detach_try" -gt 10 ]; then
      warn "设备 ${device} 多次卸载后仍未释放，继续尝试转换…"
      break
    fi
    hdiutil detach "${device}" -force -quiet 2>/dev/null \
      || hdiutil detach "$volume" -force -quiet 2>/dev/null \
      || true
    sleep 1
  done

  # 刷新磁盘缓冲，确保 rw.dmg 的写入已落盘。
  sync
  sleep 1

  # hdiutil convert 偶发 EAGAIN（资源暂时不可用），加退避重试。
  local convert_try=0
  local convert_ok=0
  while [ "$convert_try" -lt 5 ]; do
    convert_try=$((convert_try + 1))
    if hdiutil convert "$rw_dmg" -format UDZO -ov -o "$dmg_path" >>"$LOG" 2>&1; then
      convert_ok=1
      log "hdiutil convert 成功（第 ${convert_try} 次尝试）。"
      break
    fi
    warn "hdiutil convert 第 ${convert_try} 次失败（资源占用），等待后重试…"
    # 再次确认设备已释放后重试。
    hdiutil detach "${device}" -force -quiet 2>/dev/null || true
    sync
    sleep 3
  done

  if [ "$convert_ok" -ne 1 ]; then
    rm -f "$dmg_path" "$rw_dmg" 2>/dev/null || true
    fail "hdiutil 转换 DMG 失败（多次重试后仍报资源占用）。请关闭正在访问该镜像的程序后重试。"
  fi

  [ -f "${dmg_path}" ] || fail "hdiutil 转换结束但未找到输出文件：${dmg_path}。"

  # 清理中间产物。
  rm -f "$rw_dmg" 2>/dev/null || true

  # 校验镜像可正常挂载（verify）。
  run hdiutil verify "${dmg_path}" || warn "dmg 校验（verify）未通过，镜像可能仍可用，请谨慎分发。"

  local size
  size="$(du -h "${dmg_path}" | awk '{print $1}')"
  log "🎉 打包成功：${dmg_path} （大小 ${size}）"
}

# ── 阶段 5：签名与公证 dmg（仅当提供开发者证书时）──────────────────────────
# 目标：对外分发的 dmg 经签名与公证后，在全新 Mac 上可正常安装启动，
# 不被 Gatekeeper 以"无法验证开发者"拦截。
#
# 前置要求（所有变量均为可选，缺一则跳过）：
#   export CSC_NAME="Developer ID Application: Your Name (TEAMID)"
#   export APPLE_API_KEY="/path/to/AuthKey_*.p8"
#   export APPLE_API_KEY_ID="KEYID"
#   export APPLE_API_ISSUER="xxxx-xxxx-xxxx-xxxx"
# 或（Apple ID + 专用密码方式）：
#   export APPLE_ID="you@example.com"
#   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
#   export APPLE_TEAM_ID="10位TeamID"
#
# 原理：electron-builder 在 build_app 阶段已签名+公证 .app（通过 electron-builder.config.cjs
# 中的 notarize 配置），并将公证票装订进 .app bundle。本步骤将最终 .dmg 也签名+公证，
# 确保拖拽安装体验中不会出现任何安全警告。
sign_dmg() {
  local dmg_name="${APP_NAME}-${APP_VERSION}.dmg"
  local dmg_path="$RELEASE_DIR/${dmg_name}"

  if [ -z "${CSC_NAME:-}" ]; then
    warn "未设置 CSC_NAME：跳过 dmg 签名/公证。"
    warn "该 dmg 仅供本机自用；在全新 Mac 上首次打开会被 Gatekeeper 拦截。"
    warn "对外分发请设置 CSC_NAME + 公证凭据（APPLE_API_KEY 或 APPLE_ID，见本函数注释）。"
    return 0
  fi

  stage "阶段 5/5：签名与公证 dmg"

  [ -f "${dmg_path}" ] || fail "找不到 dmg 文件：${dmg_path}"

  # 1) 签署 .dmg（含时间戳，确保过期后仍可用）。
  run codesign --sign "${CSC_NAME}" --timestamp --options runtime "${dmg_path}" \
    || warn "dmg 代码签名失败（不影响 .app 内部已公证票，但推荐重新签名）。"

  # 2) 公证 .dmg。
  local notary_opts=()
  if [ -n "${APPLE_API_KEY:-}" ]; then
    notary_opts=(--key "${APPLE_API_KEY}" --key-id "${APPLE_API_KEY_ID:-}" --issuer "${APPLE_API_ISSUER:-}")
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
    notary_opts=(--apple-id "${APPLE_ID}" --password "${APPLE_APP_SPECIFIC_PASSWORD}" --team-id "${APPLE_TEAM_ID:-}")
  else
    warn "未提供公证凭据（APPLE_API_KEY 或 APPLE_ID），跳过 dmg 公证。"
    warn ".app 内部公证票通常已足够通过 Gatekeeper（electron-builder 在打包阶段已公证 .app）。"
    return 0
  fi

  if run xcrun notarytool submit "${dmg_path}" "${notary_opts[@]}" --wait; then
    run xcrun stapler staple "${dmg_path}" \
      || warn "公证成功但 stapler 装订 dmg 票证失败；可稍后手动执行 xcrun stapler staple \"${dmg_path}\"。"
    log "dmg 公证完成并已装订票证。"
  else
    warn "dmg 公证失败；.app 内部公证票通常已足够通过 Gatekeeper，可继续分发。"
  fi
}

# ── 主流程 ───────────────────────────────────────────────────────────────────
main() {
  log "开始一键打包 .dmg（项目根目录：${ROOT}）"

  # 强制清空 release 目录，确保打包产物干净无残留。
  if [ -d "$RELEASE_DIR" ]; then
    log "删除旧打包产物：${RELEASE_DIR}"
    rm -rf "$RELEASE_DIR"
  fi

  check_environment
  compile_ocr_binary
  build_frontend
  build_app
  make_dmg
  sign_dmg

  # 清理 electron-builder 生成的临时配置文件。
  if [ -f "$ROOT/builder-effective-config.yaml" ]; then
    rm -f "$ROOT/builder-effective-config.yaml"
    log "已清理 builder-effective-config.yaml"
  fi

  log "全部完成。"
}

main
