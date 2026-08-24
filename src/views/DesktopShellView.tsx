/**
 * 文件：src/views/DesktopShellView.tsx
 * 职责：应用主视图，按当前 surface 渲染不同界面：panel（菜单面板）、
 *       result（识别结果编辑）、settings（快捷键/主题/自启动）、overlay（框选）、
 *       long-toolbar（长截图控制条）。聚合桌面宿主状态、主题、OCR 后处理与窗口自适应。
 * 依赖：react、lucide-react、@/components/ui/*、@/lib/*、window.desktopHost
 * 导出：默认 DesktopShellView
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  MonitorUp,
  PanelsTopLeft,
  Play,
  Pause,
  Plus,
  Rows3,
  ScanLine,
  Settings2,
  Sparkles,
  X,
  TextSelect,
  Image as ImageIcon,
  Save,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { getDesktopSurface, isDesktopHostAvailable } from '@/lib/desktopHost';
import DesktopCaptureOverlay from '@/components/DesktopCaptureOverlay';
import {
  useDesktopHostState,
  type AdvancedFeaturesConfig,
  type CharReplacement,
  type RegexRule,
} from '@/lib/desktopHostState';
import { applyTextTransforms } from '@/lib/textTransforms';
import { cn } from '@/lib/utils';
import { useThemeStore } from '@/lib/themeStore';
import { THEME_LIST } from '@/lib/theme';
import { triggerFireworks } from '@/lib/fireworks';

const surfaceMetadata = {
  panel: {
    title: '最近一次识别',
    description: '从菜单栏面板发起普通截图或手动长截图，并回看最近一次结果。',
    icon: PanelsTopLeft,
  },
  result: {
    title: '识别结果',
    description: '识别完成后可直接编辑文本、复制并再次截图。',
    icon: MonitorUp,
  },
  settings: {
    title: '设置面板',
    description: '查看并修改全局快捷键。',
    icon: Settings2,
  },
  overlay: {
    title: '截图框选',
    description: '拖拽框选任意区域后继续。',
    icon: ScanLine,
  },
  'long-toolbar': {
    title: '长截图控制条',
    description: '框选区域后自动（或手动）采集多段屏幕内容，拼接为完整长图并 OCR 识别。',
    icon: Rows3,
  },
} as const;

type AdvancedFeaturesPanelProps = {
  config: AdvancedFeaturesConfig;
  onConfigChange: (config: AdvancedFeaturesConfig) => void;
};

/**
 * 高级功能面板：直接内联在结果页内（非弹窗 / 非路由跳转）。
 * 结果页中的「高级功能」开关控制其显隐，本组件仅渲染展开后的主体内容。
 *
 * 所有改动由父组件自动保存（无「保存 / 取消」按钮），且任一配置项被修改时
 * 也会自动停用该功能。
 */
function AdvancedFeaturesPanel({ config, onConfigChange }: AdvancedFeaturesPanelProps) {
  const [symbolInput, setSymbolInput] = useState('');

  const regexErrors = useMemo(() => {
    const map = new Map<number, string>();
    config.regexRules.forEach((rule, i) => {
      if (!rule.pattern) {
        return;
      }
      try {
        new RegExp(rule.pattern, rule.flags || 'g');
      } catch (error) {
        map.set(i, error instanceof Error ? error.message : '无效的正则表达式');
      }
    });
    return map;
  }, [config.regexRules]);

  // 配置项变更实时生效：保持当前 enabled 状态不变，
  // 通过 onConfigChange 即时保存并触发文本重新计算。
  const update = (next: AdvancedFeaturesConfig) => {
    onConfigChange(next);
  };

  // 启用/停用开关是用户主动的状态切换，不能被上面的自动停用联动逻辑覆盖。
  const toggleEnabled = (checked: boolean) => {
    onConfigChange({ ...config, enabled: checked });
    if (checked) triggerFireworks();
  };

  const addSymbol = () => {
    const value = symbolInput;
    if (!value || config.filterSymbols.includes(value)) {
      setSymbolInput('');
      return;
    }
    update({ ...config, filterSymbols: [...config.filterSymbols, value] });
    setSymbolInput('');
  };

  const removeSymbol = (symbol: string) =>
    update({ ...config, filterSymbols: config.filterSymbols.filter((s) => s !== symbol) });

  const addReplacement = () =>
    update({ ...config, charReplacements: [...config.charReplacements, { source: '', target: '' }] });

  const updateReplacement = (index: number, patch: Partial<CharReplacement>) =>
    update({
      ...config,
      charReplacements: config.charReplacements.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    });

  const removeReplacement = (index: number) =>
    update({ ...config, charReplacements: config.charReplacements.filter((_, i) => i !== index) });

  const addRegex = () =>
    update({
      ...config,
      regexRules: [...config.regexRules, { pattern: '', replacement: '', flags: 'g', mode: 'replace' }],
    });

  const updateRegex = (index: number, patch: Partial<RegexRule>) =>
    update({
      ...config,
      regexRules: config.regexRules.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    });

  const removeRegex = (index: number) =>
    update({ ...config, regexRules: config.regexRules.filter((_, i) => i !== index) });

  return (
    <div className="overflow-hidden rounded-2xl border border-glass-border bg-glass-bg backdrop-blur-xl">
      {/* 头部：启用开关 */}
      <div className="flex items-center justify-between gap-2 border-b border-border/20 px-3.5 py-2.5">
        <span className="text-[12px] font-semibold tracking-tight text-foreground/85">高级功能</span>
        <label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5">
          <Switch
            size="sm"
            checked={config.enabled}
            onCheckedChange={toggleEnabled}
          />
          <span className="text-[11px] font-medium text-muted-foreground">
            {config.enabled ? '已启用' : '已停用'}
          </span>
        </label>
      </div>

      {/* 主体：内联展开，高度随内容自动增长 */}
      <div className="space-y-4 px-3.5 py-3">
        {/* 1. Filter symbols */}
        <section className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            过滤符号
          </h3>
          <div className="flex items-center gap-2">
            <Input
              value={symbolInput}
              onChange={(e) => setSymbolInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addSymbol();
                }
              }}
              placeholder="输入要过滤的符号，如 # 或 ·"
              className="h-8 text-[12px]"
            />
            <Button
              size="sm"
              variant="secondary"
              className="h-8 shrink-0 rounded-xl text-[12px]"
              onClick={addSymbol}
            >
              <Plus className="h-3.5 w-3.5" />
              添加
            </Button>
          </div>
          {config.filterSymbols.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {config.filterSymbols.map((symbol) => (
                <span
                  key={symbol}
                  className="inline-flex items-center gap-1 rounded-lg border border-border/40 bg-muted/40 px-2 py-0.5 text-[12px] text-foreground/80"
                >
                  {symbol}
                  <button
                    type="button"
                    onClick={() => removeSymbol(symbol)}
                    className="cursor-pointer text-muted-foreground transition-colors hover:text-destructive"
                    title="移除"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </section>

        <Separator />

        {/* 2. Character replacements */}
        <section className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            指定字符替换
          </h3>
          {config.charReplacements.length === 0 && (
            <p className="text-[11px] text-muted-foreground/60">尚未添加替换规则。</p>
          )}
          <div className="space-y-1.5">
            {config.charReplacements.map((replacement, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <Input
                  value={replacement.source}
                  onChange={(e) => updateReplacement(index, { source: e.target.value })}
                  placeholder="原字符"
                  className="h-8 text-[12px]"
                />
                <span className="text-muted-foreground">→</span>
                <Input
                  value={replacement.target}
                  onChange={(e) => updateReplacement(index, { target: e.target.value })}
                  placeholder="替换为"
                  className="h-8 text-[12px]"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:text-destructive"
                  onClick={() => removeReplacement(index)}
                  title="移除"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="h-8 rounded-xl text-[12px]"
            onClick={addReplacement}
          >
            <Plus className="h-3.5 w-3.5" />
            添加替换项
          </Button>
        </section>

        <Separator />

        {/* 3. Regex rules */}
        <section className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            正则替换与过滤
          </h3>
          {config.regexRules.length === 0 && (
            <p className="text-[11px] text-muted-foreground/60">尚未添加正则规则。</p>
          )}
          <div className="space-y-2">
            {config.regexRules.map((rule, index) => (
              <div key={index} className="space-y-1 rounded-xl border border-border/30 bg-muted/20 p-2">
                <div className="flex items-center gap-1.5">
                  <Input
                    value={rule.pattern}
                    onChange={(e) => updateRegex(index, { pattern: e.target.value })}
                    placeholder="正则 pattern，如 \d+"
                    className="h-8 text-[12px] font-mono"
                  />
                  <Input
                    value={rule.flags}
                    onChange={(e) => updateRegex(index, { flags: e.target.value })}
                    placeholder="flags"
                    className="h-8 w-16 shrink-0 text-[12px] font-mono"
                  />
                  <div className="flex shrink-0 overflow-hidden rounded-lg border border-border/40">
                    <button
                      type="button"
                      onClick={() => updateRegex(index, { mode: 'replace' })}
                      className={`cursor-pointer px-2 py-1 text-[11px] font-medium transition-colors ${
                        rule.mode === 'replace'
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      替换
                    </button>
                    <button
                      type="button"
                      onClick={() => updateRegex(index, { mode: 'filter' })}
                      className={`cursor-pointer px-2 py-1 text-[11px] font-medium transition-colors ${
                        rule.mode === 'filter'
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      过滤
                    </button>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:text-destructive"
                    onClick={() => removeRegex(index)}
                    title="移除"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <Input
                  value={rule.replacement}
                  onChange={(e) => updateRegex(index, { replacement: e.target.value })}
                  placeholder={rule.mode === 'filter' ? '过滤模式将直接删除匹配内容' : '替换为'}
                  className="h-8 text-[12px] font-mono"
                  disabled={rule.mode === 'filter'}
                />
                {regexErrors.get(index) && (
                  <p className="flex items-center gap-1 text-[11px] text-destructive">
                    <AlertTriangle className="h-3 w-3" />
                    {regexErrors.get(index)}
                  </p>
                )}
              </div>
            ))}
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="h-8 rounded-xl text-[12px]"
            onClick={addRegex}
          >
            <Plus className="h-3.5 w-3.5" />
            添加规则
          </Button>
        </section>
      </div>

      {/* 底部：无「保存 / 取消」按钮，改动自动保存并自动停用 */}
      <div className="flex items-center border-t border-border/20 px-3.5 py-2.5">
        <span className="text-[11px] leading-snug text-muted-foreground/55">
          修改配置后会自动保存，并自动停用该功能
        </span>
      </div>
    </div>
  );
}

const DesktopShellView = () => {
  const surface = getDesktopSurface();
  const metadata = surfaceMetadata[surface];
  const isDesktopHost = isDesktopHostAvailable();

  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);

  const settingsCardRef = useRef<HTMLDivElement>(null);
  const panelContentRef = useRef<HTMLDivElement>(null);
  const panelHeaderRef = useRef<HTMLElement>(null);
  const resultContentRef = useRef<HTMLElement>(null);

  const { state, refresh } = useDesktopHostState();

  /**
   * 将一次键盘事件转换为 Electron 风格的快捷键字符串（如 "Command+Shift+1"）。
   * 忽略纯修饰键；仅允许命名键 / 单字母数字 / F1-F12；无修饰键或非法键返回 null。
   */
  function toAccelerator(event: React.KeyboardEvent<HTMLInputElement>) {
    const modifierParts = [
      event.metaKey ? 'Command' : null,
      event.ctrlKey ? 'Control' : null,
      event.altKey ? 'Option' : null,
      event.shiftKey ? 'Shift' : null,
    ].filter(Boolean) as string[];

    const ignoredKeys = new Set(['Meta', 'Control', 'Alt', 'Shift']);
    if (ignoredKeys.has(event.key)) {
      return null;
    }

    let keyPart = event.key;
    if (keyPart === ' ') {
      keyPart = 'Space';
    } else if (keyPart === 'Escape') {
      keyPart = 'Esc';
    } else if (keyPart.length === 1) {
      keyPart = keyPart.toUpperCase();
    }

    const allowedNamedKeys = new Set([
      'Space',
      'Tab',
      'Enter',
      'Backspace',
      'Delete',
      'Insert',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'Up',
      'Down',
      'Left',
      'Right',
      'Esc',
    ]);

    if (
      !modifierParts.length ||
      !(allowedNamedKeys.has(keyPart) || /^[A-Z0-9]$/.test(keyPart) || /^F\d{1,2}$/.test(keyPart))
    ) {
      return null;
    }

    return [...modifierParts, keyPart].join('+');
  }

  const [editableText, setEditableText] = useState('');
  const [removeNewlines, setRemoveNewlines] = useState(false);
  const originalTextRef = useRef('');
  const [singleShortcutInput, setSingleShortcutInput] = useState('');
  const [longShortcutInput, setLongShortcutInput] = useState('');
  const [menuShortcutInput, setMenuShortcutInput] = useState('');
  const [quickShortcutInput, setQuickShortcutInput] = useState('');
  const [shortcutSaved, setShortcutSaved] = useState(false);
  const [resultSaved, setResultSaved] = useState(false);
  const [longImageAction, setLongImageAction] = useState<'idle' | 'saved' | 'copied' | 'error'>('idle');
  const [autoLaunchError, setAutoLaunchError] = useState('');

  // 全分辨率截图图片按需拉取（不通过 shell 状态广播，否则会把数 MB 的
  // base64 推送给每个窗口，造成性能问题）。
  const [captureImages, setCaptureImages] = useState<{
    imageDataUrl: string | null;
    longImageDataUrl: string | null;
  }>({ imageDataUrl: null, longImageDataUrl: null });

  const advancedFeatures = state.advancedFeatures;
  const rawText = state.recentCaptureResult?.text ?? '';

  // 高级功能展开时编辑草稿，以便实时预览结果文本（取消可还原）；收起时
  // 以持久化配置驱动结果。面板在本页内联展开，不使用弹窗或路由跳转。
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [advancedDraft, setAdvancedDraft] = useState<AdvancedFeaturesConfig>(advancedFeatures);

  const effectiveConfig = advancedExpanded ? advancedDraft : advancedFeatures;
  const applied = useMemo(
    () => applyTextTransforms(rawText, effectiveConfig),
    [rawText, effectiveConfig],
  );

  // 自动保存：高级功能的每次改动都会立即持久化（无显式「保存」按钮）。
  // 改动时面板也会自动停用该功能。
  const handleAdvancedChange = async (next: AdvancedFeaturesConfig) => {
    setAdvancedDraft(next);
    await window.desktopHost?.saveAdvancedFeatures({ config: next });
  };

  useEffect(() => {
    setEditableText(applied.text);
    originalTextRef.current = applied.text;
    setResultSaved(false);
    setRemoveNewlines(false);
  }, [applied.text]);

  useEffect(() => {
    let cancelled = false;
    if (!state.recentCaptureResult?.capturedAt) {
      setCaptureImages({ imageDataUrl: null, longImageDataUrl: null });
      return;
    }
    void window.desktopHost?.getRecentCaptureImages().then((imgs) => {
      if (!cancelled) {
        setCaptureImages(imgs ?? { imageDataUrl: null, longImageDataUrl: null });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [state.recentCaptureResult?.capturedAt]);

  useEffect(() => {
    const transparentSurfaces = new Set(['overlay', 'long-toolbar']);
    const shouldBeTransparent = transparentSurfaces.has(surface);

    document.body.dataset.desktopSurface = surface;
    document.documentElement.dataset.desktopSurface = surface;

    if (shouldBeTransparent) {
      document.body.style.backgroundColor = 'transparent';
      document.documentElement.style.backgroundColor = 'transparent';
    }

    return () => {
      document.body.style.backgroundColor = '';
      document.documentElement.style.backgroundColor = '';
    };
  }, [surface]);

  useEffect(() => {
    setSingleShortcutInput(state.shortcutPreferences.single.accelerator);
    setLongShortcutInput(state.shortcutPreferences.long.accelerator);
    setMenuShortcutInput(state.shortcutPreferences.menu.accelerator);
    setQuickShortcutInput(state.shortcutPreferences.quick.accelerator);
  }, [
    state.shortcutPreferences.single.accelerator,
    state.shortcutPreferences.long.accelerator,
    state.shortcutPreferences.menu.accelerator,
    state.shortcutPreferences.quick.accelerator,
  ]);

  const saveShortcuts = async () => {
    triggerFireworks();
    const singleResult = await window.desktopHost?.saveShortcutPreference({
      mode: 'single',
      accelerator: singleShortcutInput,
    });
    const longResult = await window.desktopHost?.saveShortcutPreference({
      mode: 'long',
      accelerator: longShortcutInput,
    });
    const menuResult = await window.desktopHost?.saveShortcutPreference({
      mode: 'menu',
      accelerator: menuShortcutInput,
    });
    const quickResult = await window.desktopHost?.saveShortcutPreference({
      mode: 'quick',
      accelerator: quickShortcutInput,
    });
    setShortcutSaved(
      Boolean(singleResult?.success && longResult?.success && menuResult?.success && quickResult?.success),
    );
    await refresh();
  };

  // 设置窗口自适应高度：测量卡片自然高度，并请求宿主调整窗口尺寸，使
  // 各分区完整可见不被截断。surface 挂载或内容增长时都会重新适配。
  useEffect(() => {
    const el = settingsCardRef.current;
    const fitApi = window.desktopHost?.requestWindowFit;
    if (surface !== 'settings' || !el || !fitApi) return;
    const fit = () => {
      const height = el.offsetHeight + 32; // <main> 的 p-4 上下内边距
      void fitApi(height);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [surface]);

  // 主菜单（panel）窗口自适应高度：将窗口尺寸设为「头部 + 内容」，无论显示
  // 多少分区（权限提示、长截图状态、最近结果等）都不会溢出或被截断。
  useEffect(() => {
    const el = panelContentRef.current;
    const header = panelHeaderRef.current;
    const fitApi = window.desktopHost?.requestWindowFit;
    // 截图 / 长截图会话进行中，全屏覆盖层已遮罩屏幕，此时调整面板尺寸既无
    // 意义，又会触发窗口重设动画造成可见的“放大闪烁”，因此跳过适配。
    if (
      surface !== 'panel' ||
      state.activeCaptureSession ||
      state.longCaptureSession ||
      !el ||
      !fitApi
    ) {
      return;
    }
    const fit = () => {
      const height = el.scrollHeight + (header?.offsetHeight ?? 0);
      void fitApi(height);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [surface, state.activeCaptureSession, state.longCaptureSession]);

  // 结果窗口自适应高度：
  // - 高级面板展开时：记录当前窗口高度，计算内容所需高度，若超出则增长窗口
  // - 高级面板折叠时：恢复到展开前的高度，消除多余空白
  // 不使用 scrollHeight 或 ResizeObserver，因为 h-screen + flex-1 布局下
  // flex 子元素会吸收剩余空间，scrollHeight 始终等于窗口高度无法感知变化。
  useEffect(() => {
    if (surface !== 'result') return;
    const el = resultContentRef.current;
    const fitApi = window.desktopHost?.requestWindowFit;
    if (!el || !fitApi) return;

    // 等待 React 完成条件渲染（AdvancedFeaturesPanel 挂载/卸载）
    // 面板内容可能包含异步加载的配置，300ms 确保 DOM 已稳定。
    const timer = setTimeout(() => {
      if (!el) return;

      // 计算内容所需的最小高度：遍历所有子元素
      // flex-1（文本区）使用固定 340px 最小高度，其他子元素取实际 offsetHeight
      let needed = 0;
      for (let i = 0; i < el.children.length; i++) {
        const child = el.children[i] as HTMLElement;
        if (child.className.includes('flex-1')) {
          needed += 340; // 文本区最低可用高度
        } else {
          needed += child.offsetHeight;
        }
      }

      if (advancedExpanded) {
        // 展开：若当前窗口不足以容纳面板，则增长窗口
        if (needed > el.clientHeight + 10) {
          void fitApi(needed);
        }
      } else {
        // 折叠：根据剩余内容高度缩小窗口，不低于 minHeight（460）
        const collapseTarget = Math.max(needed, 460);
        if (collapseTarget < el.clientHeight - 20) {
          void fitApi(collapseTarget);
        }
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [advancedExpanded, surface]);

  const permissionHint = useMemo(() => {
    if (!isDesktopHost) {
      return '当前页面运行在浏览器预览中。截图、权限检测和系统级窗体只能在 Electron 桌面宿主里使用，请用桌面宿主方式启动应用。';
    }

    if (state.permissions.screenCapture === 'granted') {
      return null;
    }

    if (state.permissions.screenCapture === 'denied' || state.permissions.screenCapture === 'restricted') {
      return '屏幕录制权限已被拒绝或受限。请在「系统设置 → 隐私与安全性 → 屏幕录制」中允许本应用，然后重启应用以启用截图。';
    }

    // not-determined / unknown：首次使用会在点击截图按钮时请求系统授权
    return '首次使用截图功能时，系统会请求「屏幕录制」权限，请在弹窗中点击允许以启用框选截图。';
  }, [isDesktopHost, state.permissions.screenCapture]);

  async function startCapture() {
    if (!window.desktopHost) {
      return;
    }

    await window.desktopHost.startScreenCapture();
    await refresh();
  }

  async function startLongCapture() {
    if (!window.desktopHost) {
      return;
    }

    await window.desktopHost.startLongScreenCapture();
    await refresh();
  }

  async function startQuickCapture() {
    if (!window.desktopHost) {
      return;
    }

    await window.desktopHost.startQuickScreenCapture();
    await refresh();
  }

  async function handleSaveLongImage() {
    const res = await window.desktopHost?.saveLongImage();
    if (res?.success) {
      setLongImageAction('saved');
    } else if (res?.canceled) {
      setLongImageAction('idle');
    } else {
      setLongImageAction('error');
    }
    setTimeout(() => setLongImageAction('idle'), 2200);
  }

  async function handleCopyLongImage() {
    if (!captureImages.longImageDataUrl) {
      return;
    }
    await window.desktopHost?.copyResultText({
      text: captureImages.longImageDataUrl,
    });
    setLongImageAction('copied');
    // 短暂反馈后关闭结果窗口
    setTimeout(() => {
      void window.desktopHost?.closeCurrentWindow();
    }, 900);
  }

  // ── 框选覆盖层 surface ──
  if (surface === 'overlay' && state.activeCaptureSession) {
    return (
      <DesktopCaptureOverlay
        mode={state.activeCaptureSession.mode}
        onCancel={() => void window.desktopHost?.cancelCaptureSession()}
        onConfirm={(selection) => void window.desktopHost?.completeScreenCapture(selection)}
      />
    );
  }

  // ── 长截图控制条 surface ──
  if (surface === 'long-toolbar' && state.longCaptureSession) {
    const seg = state.longCaptureSession.segmentsCaptured;
    const mode = state.longCaptureSession.mode ?? 'auto';
    const isPaused = state.longCaptureSession.isPaused ?? false;
    const maxDots = 8;
    const preview = state.longCaptureSession.latestSegmentThumbnail;
    const isAutoActive = mode === 'auto' && !isPaused;

    return (
      <main className="flex h-screen items-center justify-center bg-transparent text-foreground">
        <div className="w-full max-w-[460px] rounded-2xl border border-glass-border bg-glass-bg px-4 py-3.5 shadow-xl backdrop-blur-xl">
          {/* 模式切换 + 状态 */}
          <div className="mb-3 flex items-center gap-3">
            <div className="flex rounded-lg border border-border/40 bg-muted/40 p-0.5">
              <button
                type="button"
                className={`cursor-pointer rounded-md px-3 py-1 text-[11px] font-medium transition-all duration-200 ${
                  mode === 'auto'
                    ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/20'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => void window.desktopHost?.setLongCaptureMode({ mode: 'auto' })}
              >
                自动采集
              </button>
              <button
                type="button"
                className={`cursor-pointer rounded-md px-3 py-1 text-[11px] font-medium transition-all duration-200 ${
                  mode === 'manual'
                    ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/20'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => void window.desktopHost?.setLongCaptureMode({ mode: 'manual' })}
              >
                手动采集
              </button>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
              {isAutoActive ? (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                </span>
              ) : mode === 'manual' ? (
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              ) : null}
              {mode === 'auto'
                ? isPaused
                  ? '已暂停'
                  : '采集中…'
                : '等待采集'}
            </div>
          </div>

          {/* 进度 + 预览行 */}
          <div className="mb-3 flex items-center gap-3">
            <div className="flex flex-1 items-center gap-1.5">
              {Array.from({ length: maxDots }, (_, i) => (
                <span
                  key={i}
                  className={`block h-1.5 rounded-full transition-all duration-300 ${
                    i < Math.min(seg, maxDots)
                      ? 'w-5 bg-primary shadow-sm shadow-primary/30'
                      : 'w-1.5 bg-muted-foreground/12'
                  }`}
                />
              ))}
            </div>
            {/* 预览缩略图 */}
            {preview ? (
              <div className="h-9 w-14 shrink-0 overflow-hidden rounded-lg border border-border/30 bg-muted/30 shadow-sm">
                <img
                  src={preview}
                  alt="预览"
                  className="h-full w-full object-cover opacity-70"
                />
              </div>
            ) : null}
            <span className="text-[11px] font-semibold text-muted-foreground tabular-nums shrink-0">
              {seg} 段
            </span>
          </div>

          {/* 提示 */}
          <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground/55">
            {mode === 'auto'
              ? '滚动目标内容后应用将自动采集，暂停采集后可随时完成'
              : '滚动内容后点击「继续采集」追加分段'}
          </p>

          {/* 操作按钮 */}
          <div className="flex items-center gap-2">
            {mode === 'auto' ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 flex-1 rounded-xl border-primary/15 bg-primary/5 text-[12px] font-medium text-primary hover:bg-primary/10 hover:border-primary/25"
                  onClick={() => void window.desktopHost?.toggleLongCapturePause()}
                >
                  {isPaused ? (
                    <><Play className="mr-1 h-3 w-3" />恢复采集</>
                  ) : (
                    <><Pause className="mr-1 h-3 w-3" />暂停采集</>
                  )}
                </Button>
                <Button
                  size="sm"
                  className="h-8 rounded-xl px-5 text-[12px] font-semibold shadow-sm shadow-primary/25"
                  onClick={() => void window.desktopHost?.finishLongCapture()}
                >
                  完成
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 flex-1 rounded-xl border-primary/15 bg-primary/5 text-[12px] font-medium text-primary hover:bg-primary/10 hover:border-primary/25"
                  onClick={() => void window.desktopHost?.captureLongSegment()}
                >
                  继续采集
                </Button>
                <Button
                  size="sm"
                  className="h-8 rounded-xl px-5 text-[12px] font-semibold shadow-sm shadow-primary/25"
                  onClick={() => void window.desktopHost?.finishLongCapture()}
                >
                  完成
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 rounded-full border border-border/40 bg-muted/30 text-foreground/70 shadow-sm hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive transition-colors"
              onClick={() => void window.desktopHost?.cancelCaptureSession()}
              title="取消长截图"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </main>
    );
  }

  // ── 结果窗口 surface ──
  if (surface === 'result') {
    const hasContent = editableText.trim().length > 0;
    const capturedTime = state.recentCaptureResult?.capturedAt
      ? new Date(state.recentCaptureResult.capturedAt).toLocaleString('zh-CN', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : null;

    return (
      <main
        ref={resultContentRef}
        className="relative flex h-screen flex-col overflow-hidden bg-transparent text-foreground"
      >
        {/* 顶部高亮渐变 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-primary/40 via-primary to-primary/40" />

        {/* 头部 */}
        <header className="drag-region flex shrink-0 items-center justify-between pl-4 pr-3 pt-4 pb-3">
          <div className="flex items-center gap-3 no-drag">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm shadow-primary/25">
              <Sparkles className="h-4 w-4" />
            </span>
            <div>
              <h1 className="text-[15px] font-bold leading-tight tracking-tight">
                识别结果
              </h1>
              {capturedTime && (
                <p className="text-[11px] leading-none text-muted-foreground/55">
                  {capturedTime}
                </p>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="no-drag rounded-full border border-border/40 bg-muted/30 text-foreground/70 shadow-sm hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive transition-colors"
            onClick={() => void window.desktopHost?.closeCurrentWindow()}
            title="关闭"
          >
            <X className="h-5 w-5" />
          </Button>
        </header>

        {/* 长图预览（长截图结果时显示） */}
        {captureImages.longImageDataUrl && (
          <div className="shrink-0 px-4 pb-2">
            <div className="overflow-hidden rounded-2xl border border-border/30 bg-muted/10">
              <div className="relative max-h-[180px] overflow-y-auto">
                <img
                  src={captureImages.longImageDataUrl}
                  alt="长截图"
                  className="w-full cursor-pointer object-contain"
                  onClick={() => void handleSaveLongImage()}
                  title="点击保存长图"
                />
                {/* 底部渐变遮罩 */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-glass-bg to-transparent" />
              </div>
              {/* 图片操作按钮 + 反馈 */}
              <div className="flex items-center gap-2 border-t border-border/20 px-3 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 flex-1 rounded-xl text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted"
                  onClick={() => void handleSaveLongImage()}
                >
                  <Save className="mr-1 h-3 w-3" />
                  保存长图
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 flex-1 rounded-xl text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted"
                  onClick={() => void handleCopyLongImage()}
                >
                  <ImageIcon className="mr-1 h-3 w-3" />
                  复制图片
                </Button>
                {longImageAction === 'saved' && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600">
                    <Check className="h-3 w-3" />已保存
                  </span>
                )}
                {longImageAction === 'copied' && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600">
                    <Check className="h-3 w-3" />已复制
                  </span>
                )}
                {longImageAction === 'error' && (
                  <span className="text-[11px] font-medium text-destructive">保存失败</span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 文本编辑区 */}
        <div className="flex-1 min-h-0 px-4 pb-1">
          <div className="relative h-full overflow-hidden rounded-2xl border border-border/30 bg-glass-bg shadow-inner backdrop-blur-xl transition-all duration-200 focus-within:border-primary/30 focus-within:ring-2 focus-within:ring-primary/10 focus-within:bg-glass-bg">
            {state.recentCaptureResult?.loading ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-primary/50">
                <Loader2 className="h-8 w-8 animate-spin" strokeWidth={1.5} />
                <span className="text-[13px] tracking-wide">识别中…</span>
              </div>
            ) : !hasContent && state.recentCaptureResult?.wasEmpty ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground/25">
                <TextSelect className="h-10 w-10 opacity-20" strokeWidth={1.2} />
                <span className="text-[13px] tracking-wide">当前区域未识别到文字</span>
              </div>
            ) : !hasContent ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground/20">
                <TextSelect className="h-10 w-10 opacity-25" strokeWidth={1.2} />
                <span className="text-[13px] tracking-wide">等待截图识别结果</span>
              </div>
            ) : null}
            <textarea
              value={removeNewlines ? editableText.replace(/\r?\n/g, '') : editableText}
              onChange={(event) => {
                setEditableText(
                  removeNewlines
                    ? event.target.value.replace(/\r?\n/g, '')
                    : event.target.value,
                );
                setResultSaved(false);
              }}
              className="absolute inset-0 h-full w-full resize-none border-0 bg-transparent px-5 py-4 font-mono text-[12.5px] leading-relaxed text-foreground/85 placeholder:text-transparent outline-none tabular-nums"
              placeholder="截图结果将显示在这里"
            />
          </div>
        </div>

        {/* 高级功能：在结果页内联展开（非弹窗 / 非路由跳转） */}
        <div className="shrink-0 px-4 pb-2">
          <Button
            variant={advancedExpanded ? 'secondary' : 'outline'}
            size="sm"
            className="h-8 w-full rounded-xl text-[12px] font-medium"
            onClick={() => {
              if (!advancedExpanded) {
                setAdvancedDraft(advancedFeatures);
              }
              setAdvancedExpanded((prev) => !prev);
            }}
          >
            <Settings2 className="h-3.5 w-3.5" />
            高级功能
            {!advancedFeatures.enabled && (
              <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                已停用
              </span>
            )}
            {advancedExpanded ? (
              <ChevronDown className="ml-1 h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="ml-1 h-3.5 w-3.5" />
            )}
          </Button>

          {advancedExpanded && (
            <div className="pt-2">
              <AdvancedFeaturesPanel
                config={advancedDraft}
                onConfigChange={handleAdvancedChange}
              />
            </div>
          )}
        </div>

        {/* 底部操作区 */}
        <footer className="shrink-0 px-4 pt-2 pb-4">
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-glass-border bg-glass-bg px-3.5 py-3 backdrop-blur-xl shadow-sm">
            <div className="flex items-center gap-3 min-w-0">
              {/* 去除换行符开关 */}
              <label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5">
                <Switch
                  size="sm"
                  checked={removeNewlines}
                  onCheckedChange={(checked) => {
                    setRemoveNewlines(checked);
                    if (checked) {
                      setEditableText((prev) => prev.replace(/\r?\n/g, ''));
                    } else {
                      setEditableText(originalTextRef.current);
                    }
                    setResultSaved(false);
                  }}
                />
                <span className="text-[11px] font-medium text-muted-foreground">
                  去除换行符
                </span>
              </label>
              {resultSaved ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-600">
                  <Check className="h-3 w-3" />
                  <span className="truncate">已保存</span>
                </span>
              ) : state.recentCaptureResult?.wasEmpty ? (
                <span className="text-[11px] text-muted-foreground/50">未识别到文字</span>
              ) : capturedTime ? (
                <span className="text-[11px] text-muted-foreground/50 truncate">
                  {capturedTime} 识别完成
                </span>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 rounded-xl text-[12px] font-normal text-muted-foreground hover:text-foreground hover:bg-muted"
                onClick={async () => {
                  await window.desktopHost?.closeCurrentWindow();
                  await startCapture();
                }}
              >
                <ScanLine className="h-3.5 w-3.5" />
                重新截图
              </Button>
              <Button
                size="sm"
                className="h-7 rounded-xl px-4 text-[12px] font-semibold shadow-sm shadow-primary/20"
                onClick={async () => {
                  triggerFireworks();
                  await window.desktopHost?.saveRecentResultText({ text: editableText });
                  await window.desktopHost?.copyResultText({ text: editableText });
                  await window.desktopHost?.closeCurrentWindow();
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                复制并关闭
              </Button>
            </div>
          </div>
        </footer>
      </main>
    );
  }

  // ── 设置窗口 surface ──
  if (surface === 'settings') {
    return (
      <main className="overflow-y-auto bg-transparent p-4 text-foreground">
        <Card ref={settingsCardRef} className="border-glass-border shadow-lg shadow-black/5">
          <CardHeader className="space-y-3 pb-4 pl-4 pr-3">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1.5">
                <CardTitle className="text-base font-bold tracking-tight">{metadata.title}</CardTitle>
                <CardDescription className="text-sm leading-6">{metadata.description}</CardDescription>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-full border border-border/40 bg-muted/30 text-foreground/70 shadow-sm hover:border-primary/30 hover:bg-primary/10 hover:text-primary transition-colors"
                  onClick={() => void saveShortcuts()}
                  title="保存快捷键设置"
                >
                  <Save className="h-5 w-5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-full border border-border/40 bg-muted/30 text-foreground/70 shadow-sm hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive transition-colors"
                  onClick={() => void window.desktopHost?.closeCurrentWindow()}
                  title="关闭设置"
                >
                  <X className="h-5 w-5" />
                </Button>
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-5 text-sm">
            {/* 截图识别快捷键 */}
            <div className="space-y-2.5">
              <label className="text-[13px] font-semibold text-foreground">截图识别快捷键</label>
              <p className="text-[12px] text-muted-foreground/70">
                当前已生效：{state.shortcutPreferences.single.displayText}
              </p>
              <Input
                readOnly
                value={singleShortcutInput}
                onFocus={() => setShortcutSaved(false)}
                onKeyDown={(event) => {
                  event.preventDefault();
                  const accelerator = toAccelerator(event);
                  if (!accelerator) return;
                  setSingleShortcutInput(accelerator);
                  setShortcutSaved(false);
                }}
                placeholder="聚焦后直接按下组合键"
                className="rounded-xl border-border/40 bg-muted/30 font-mono text-[13px] placeholder:text-muted-foreground/30"
              />
              <p className="text-[11px] leading-5 text-muted-foreground/50">
                点击输入框后，直接按下你想使用的组合键进行录制。
              </p>
            </div>

            {/* 长截图识别快捷键 */}
            <div className="space-y-2.5">
              <label className="text-[13px] font-semibold text-foreground">长截图识别快捷键</label>
              <p className="text-[12px] text-muted-foreground/70">
                当前已生效：{state.shortcutPreferences.long.displayText}
              </p>
              <Input
                readOnly
                value={longShortcutInput}
                onFocus={() => setShortcutSaved(false)}
                onKeyDown={(event) => {
                  event.preventDefault();
                  const accelerator = toAccelerator(event);
                  if (!accelerator) return;
                  setLongShortcutInput(accelerator);
                  setShortcutSaved(false);
                }}
                placeholder="聚焦后直接按下组合键"
                className="rounded-xl border-border/40 bg-muted/30 font-mono text-[13px] placeholder:text-muted-foreground/30"
              />
              <p className="text-[11px] leading-5 text-muted-foreground/50">
                建议为长截图设置一个与普通截图不同的快捷键。
              </p>
            </div>

            {/* 唤起菜单快捷键 */}
            <div className="space-y-2.5">
              <label className="text-[13px] font-semibold text-foreground">唤起菜单快捷键</label>
              <p className="text-[12px] text-muted-foreground/70">
                当前已生效：{state.shortcutPreferences.menu.displayText}
              </p>
              <Input
                readOnly
                value={menuShortcutInput}
                onFocus={() => setShortcutSaved(false)}
                onKeyDown={(event) => {
                  event.preventDefault();
                  const accelerator = toAccelerator(event);
                  if (!accelerator) return;
                  setMenuShortcutInput(accelerator);
                  setShortcutSaved(false);
                }}
                placeholder="聚焦后直接按下组合键"
                className="rounded-xl border-border/40 bg-muted/30 font-mono text-[13px] placeholder:text-muted-foreground/30"
              />
              <p className="text-[11px] leading-5 text-muted-foreground/50">
                按下该组合键可显示或隐藏主菜单面板。
              </p>
            </div>

            {/* 截图（复制到剪贴板）快捷键 */}
            <div className="space-y-2.5">
              <label className="text-[13px] font-semibold text-foreground">截图（复制到剪贴板）快捷键</label>
              <p className="text-[12px] text-muted-foreground/70">
                当前已生效：{state.shortcutPreferences.quick.displayText}
              </p>
              <Input
                readOnly
                value={quickShortcutInput}
                onFocus={() => setShortcutSaved(false)}
                onKeyDown={(event) => {
                  event.preventDefault();
                  const accelerator = toAccelerator(event);
                  if (!accelerator) return;
                  setQuickShortcutInput(accelerator);
                  setShortcutSaved(false);
                }}
                placeholder="聚焦后直接按下组合键"
                className="rounded-xl border-border/40 bg-muted/30 font-mono text-[13px] placeholder:text-muted-foreground/30"
              />
              <p className="text-[11px] leading-5 text-muted-foreground/50">
                按下该组合键直接启动截图框选，完成后将图像复制到系统剪贴板。
              </p>
            </div>

            {/* 动态主题色 */}
            <div className="space-y-2.5">
              <label className="text-[13px] font-semibold text-foreground">主题色</label>
              <p className="text-[12px] text-muted-foreground/70">
                选择主色调，界面将实时切换为对应的浅色过渡与中性配色。
              </p>
              <div className="flex flex-wrap gap-2">
                {THEME_LIST.map((t) => {
                  const active = themeId === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      title={t.name}
                      onClick={() => setTheme(t.id)}
                      className={cn(
                        'flex h-9 cursor-pointer items-center gap-2 rounded-xl border px-3 text-[12px] font-medium transition-all duration-200',
                        active
                          ? 'border-primary/50 bg-primary/10 text-foreground shadow-sm shadow-primary/15'
                          : 'border-glass-border bg-glass-bg text-muted-foreground hover:border-border/60 hover:text-foreground',
                      )}
                    >
                      <span
                        className="h-4 w-4 rounded-full ring-1 ring-black/10"
                        style={{ background: `oklch(0.6 0.17 ${t.hue})` }}
                      />
                      {t.name}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 开机自启动 */}
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-glass-border bg-glass-bg px-3.5 py-3">
              <div className="min-w-0 space-y-0.5">
                <label className="text-[13px] font-semibold text-foreground">
                  开机自启动
                </label>
                <p className="text-[11px] leading-5 text-muted-foreground/50">
                  登录系统后自动在后台启动本应用。
                </p>
              </div>
              <Switch
                size="sm"
                checked={state.autoLaunch}
                onCheckedChange={async (checked) => {
                  if (!window.desktopHost) {
                    setAutoLaunchError('桌面宿主不可用，请在 Electron 环境中操作。');
                    return;
                  }
                  try {
                    const res = await window.desktopHost.setAutoLaunch({ enabled: checked });
                    if (res && !res.success) {
                      setAutoLaunchError(
                        res.error ?? '设置开机自启动失败，请检查系统权限。',
                      );
                      console.warn('[autolaunch] setAutoLaunch failed:', res.error);
                    } else {
                      setAutoLaunchError('');
                    }
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error('[autolaunch] setAutoLaunch IPC error:', msg);
                    setAutoLaunchError(`开机自启动设置异常：${msg}`);
                  }
                }}
              />
            </div>

            {autoLaunchError && (
              <div className="space-y-2 rounded-2xl border border-destructive/15 bg-destructive/5 px-3.5 py-3">
                <p className="text-[13px] leading-relaxed text-destructive">
                  {autoLaunchError}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-[11px]"
                  onClick={() => void window.desktopHost?.openLoginItemsSettings()}
                >
                  <ExternalLink className="h-3 w-3" />
                  打开系统登录项设置
                </Button>
              </div>
            )}

            {/* 错误提示 */}
            {state.shortcutRegistrationError && (
              <div className="rounded-2xl border border-destructive/15 bg-destructive/5 px-3.5 py-3 text-[13px] leading-relaxed text-destructive">
                {state.shortcutRegistrationError}
              </div>
            )}

            {/* 成功提示 */}
            {shortcutSaved && (
              <div className="rounded-2xl border border-emerald-200/60 bg-emerald-50/60 px-3.5 py-3 text-[13px] leading-relaxed text-emerald-700">
                快捷键已保存并重新注册。
              </div>
            )}

            <Separator />
          </CardContent>
        </Card>
      </main>
    );
  }

  // 守卫：仅当 surface 明确为 panel 时才渲染主菜单。overlay / long-toolbar 等
  // 窗口在会话状态经 IPC 到达前，此前会「穿透」到下方的主菜单渲染，导致点击
  // 截图瞬间整屏闪过一帧面板 UI。此处对非 panel surface 返回透明占位以消除闪烁。
  // 生产构建中 Tailwind 类可能延迟解析，补充内联样式确保透明背景立即生效。
  if (surface !== 'panel') {
    return (
      <div
        className="h-screen w-screen bg-transparent"
        style={{ background: 'transparent' }}
      />
    );
  }

  // ── 面板 surface（主菜单） ──
  return (
    <main className="bg-transparent text-foreground select-none">
      {/* 头部 — 可拖拽，并为 macOS 红绿灯按钮预留内边距 */}
      <header
        ref={panelHeaderRef}
        className="drag-region shrink-0 border-b border-border/20 pl-4 pr-3 py-3.5"
      >
        <div className="flex items-center justify-between no-drag">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm shadow-primary/25">
              <ScanLine className="h-4 w-4" />
            </span>
            <div>
              <h1 className="text-[14px] font-bold leading-tight tracking-tight">
                屏幕 OCR
              </h1>
              <p className="text-[10px] leading-none text-muted-foreground/45">
                {isDesktopHost ? 'macOS 桌面版' : '浏览器预览'}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full border border-border/40 bg-muted/30 text-foreground/70 shadow-sm hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive transition-colors"
            onClick={() => void window.desktopHost?.closeCurrentWindow()}
            title="关闭面板"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
      </header>

      {/* 内容区 — 尺寸随内容自适应；仅当窗口被限制到可视区域时才滚动，
          确保内容永远不会被截断。 */}
      <div
        ref={panelContentRef}
        className="max-h-[calc(100vh-96px)] space-y-4 overflow-y-auto px-4 py-4"
      >
        {/* 权限警告 */}
        {permissionHint ? (
          <div className="flex items-start gap-2.5 rounded-2xl border border-amber-200/60 bg-amber-50/60 px-3.5 py-3 text-[12px] leading-relaxed text-amber-800 backdrop-blur-sm">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">需要屏幕录制权限</p>
              <p className="mt-1 text-amber-700/70">{permissionHint}</p>
              {isDesktopHost ? (
                <button
                  type="button"
                  className="mt-2 inline-flex cursor-pointer items-center gap-1 text-[11px] font-medium text-amber-700 underline decoration-amber-300 underline-offset-4 hover:text-amber-900 transition-colors"
                  onClick={() => void window.desktopHost?.openScreenCapturePreferences()}
                >
                  打开系统权限设置
                  <ExternalLink className="h-3 w-3" />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Error message */}
        {state.captureErrorMessage ? (
          <div className="rounded-2xl border border-destructive/10 bg-destructive/5 px-3.5 py-3 text-[12px] leading-relaxed text-destructive/80 backdrop-blur-sm">
            {state.captureErrorMessage}
          </div>
        ) : null}

        {/* 长截图进行中指示 */}
        {state.longCaptureSession ? (
          <div className="flex items-center gap-3 rounded-2xl border border-sky-200/60 bg-sky-50/60 px-3.5 py-3 backdrop-blur-sm">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-sky-200/70 text-[11px] font-bold text-sky-700">
              {state.longCaptureSession.segmentsCaptured}
            </span>
            <span className="text-[12px] font-medium leading-snug text-sky-800">
              长截图进行中（{state.longCaptureSession.mode === 'manual' ? '手动' : '自动'}
              {state.longCaptureSession.isPaused ? '·已暂停' : ''}），
              已采集 {state.longCaptureSession.segmentsCaptured} 段
            </span>
          </div>
        ) : null}

        {/* 主要操作：快速截图（复制到剪贴板） */}
        <button
          type="button"
          disabled={!isDesktopHost || Boolean(state.longCaptureSession)}
          onClick={() => void startQuickCapture()}
          className="group relative flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-glass-border bg-glass-bg px-4 py-5 text-left shadow-sm backdrop-blur-xl transition-all duration-200 hover:border-primary/30 hover:bg-glass-bg hover:shadow-md disabled:cursor-not-allowed disabled:opacity-35"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 transition-colors duration-200 group-hover:bg-primary/20">
            <Camera className="h-5 w-5 text-primary/75 transition-colors duration-200 group-hover:text-primary" />
          </div>
          <div className="flex-1">
            <div className="text-[14px] font-bold tracking-tight">截图</div>
            <div className="mt-0.5 text-[10px] leading-none text-muted-foreground/55">
              框选区域后自动复制到剪贴板 · {state.shortcutPreferences.quick.displayText}
            </div>
          </div>
        </button>

        {/* Primary action cards */}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            disabled={!isDesktopHost || Boolean(state.longCaptureSession)}
            onClick={() => void startCapture()}
            className="group relative flex cursor-pointer flex-col items-center gap-3 rounded-2xl border border-glass-border bg-glass-bg px-3.5 py-5 text-center shadow-sm backdrop-blur-xl transition-all duration-200 hover:border-primary/30 hover:bg-glass-bg hover:shadow-md disabled:cursor-not-allowed disabled:opacity-35"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/8 transition-colors duration-200 group-hover:bg-primary/15">
              <ScanLine className="h-5 w-5 text-primary/70 transition-colors duration-200 group-hover:text-primary" />
            </div>
            <div>
              <div className="text-[13px] font-semibold leading-tight">截图识别</div>
              <div className="mt-1 text-[10px] leading-none text-muted-foreground/55">
                {state.shortcutPreferences.single.displayText}
              </div>
            </div>
          </button>

          <button
            type="button"
            disabled={!isDesktopHost || Boolean(state.longCaptureSession)}
            onClick={() => void startLongCapture()}
            className="group relative flex cursor-pointer flex-col items-center gap-3 rounded-2xl border border-glass-border bg-glass-bg px-3.5 py-5 text-center shadow-sm backdrop-blur-xl transition-all duration-200 hover:border-primary/30 hover:bg-glass-bg hover:shadow-md disabled:cursor-not-allowed disabled:opacity-35"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-secondary/90 transition-colors duration-200 group-hover:bg-secondary">
              <Rows3 className="h-5 w-5 text-secondary-foreground/55 transition-colors duration-200 group-hover:text-secondary-foreground" />
            </div>
            <div>
              <div className="text-[13px] font-semibold leading-tight">长截图识别</div>
              <div className="mt-1 text-[10px] leading-none text-muted-foreground/55">
                {state.shortcutPreferences.long.displayText}
              </div>
            </div>
          </button>
        </div>

        {/* 次要导航链接 */}
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-9 w-full justify-start gap-2.5 rounded-xl border border-glass-border bg-glass-bg px-3 text-[12px] font-normal text-muted-foreground hover:border-border/40 hover:bg-muted/40 hover:text-foreground transition-all duration-200"
            onClick={() => void window.desktopHost?.showResultWindow()}
          >
            <div className="flex h-5 w-5 items-center justify-center rounded-md bg-primary/6">
              <Sparkles className="h-3 w-3 text-primary/55" />
            </div>
            结果窗口
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-9 w-full justify-start gap-2.5 rounded-xl border border-glass-border bg-glass-bg px-3 text-[12px] font-normal text-muted-foreground hover:border-border/40 hover:bg-muted/40 hover:text-foreground transition-all duration-200"
            onClick={() => void window.desktopHost?.showSettingsWindow()}
          >
            <div className="flex h-5 w-5 items-center justify-center rounded-md bg-muted">
              <Settings2 className="h-3 w-3 text-muted-foreground/55" />
            </div>
            快捷键设置
          </Button>
        </div>

        {/* 最近识别结果预览 */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between px-0.5">
            <span className="text-[11px] font-semibold text-muted-foreground/60">
              最近识别结果
            </span>
            {state.recentCaptureResult?.capturedAt && (
              <span className="text-[10px] text-muted-foreground/35">
                {new Date(state.recentCaptureResult.capturedAt).toLocaleString('zh-CN', {
                  month: 'numeric',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            )}
          </div>
          <div className="max-h-40 overflow-y-auto rounded-2xl border border-glass-border bg-glass-bg px-3.5 py-3 text-[12px] leading-relaxed text-muted-foreground/65 backdrop-blur-xl select-text cursor-auto transition-colors duration-200 hover:border-border/35">
            {state.recentCaptureResult?.text ? (
              <p className="whitespace-pre-wrap break-words">{state.recentCaptureResult.text}</p>
            ) : (
              <p className="text-muted-foreground/25 italic">暂无识别结果</p>
            )}
          </div>
        </div>
      </div>
    </main>
  );
};

export default DesktopShellView;
