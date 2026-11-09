/**
 * lib/overlay.js — 桌面「键盘动作浮窗」
 *
 * 驱动 0.34.1 的 59 个原生工具里没有任何「显示一段文字浮层」的能力，
 * agent cursor 覆盖层也只能移动/换主题。所以键盘可视化只能由插件自己画。
 *
 * 实现方式（零 npm 依赖、不落盘 ps1）：
 *   · 把一段 PowerShell/WinForms 脚本用 UTF-16LE + Base64 编码，通过
 *     `powershell.exe -EncodedCommand` 传入（避开 Windows 命令行中文编码坑）；
 *   · 脚本里 Add-Type 编译一个 C# Form：置顶、无边框、半透明、圆角、
 *     WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW + WS_EX_TRANSPARENT（不抢焦点、不拦鼠标）、
 *     SetProcessDPIAware + Screen.FromPoint（DPI / 多显示器）；
 *   · 主线程跑 Application.Run() 消息循环，后台线程读 stdin；
 *   · 协议纯 ASCII：
 *       config|<theme>|<fontSize>|<opacity*100>|<position>|<fadeMs>
 *       show|<ms>|<x>|<y>|<base64(utf8 键帽串)>
 *     键帽串用 US(0x1F) 分隔，前缀 * 表示修饰键；文本走 Base64 让中文/竖线/换行都不破坏协议。
 *
 * 所有失败都降级为「没有浮窗」，绝不影响键盘动作本身。
 */

import { spawn } from 'node:child_process'

/** 键帽分隔符：选 US 控制字符，正常文本里几乎不可能出现 */
export const KEY_SEP = String.fromCharCode(31)
const MODIFIERS = new Set(['ctrl', 'control', 'shift', 'alt', 'option', 'win', 'cmd', 'meta', 'super'])
export const OVERLAY_THEMES = ['dark', 'light', 'accent']
export const OVERLAY_POSITIONS = ['auto', 'fixed', 'center', 'top', 'bottom']

/**
 * 把一条键盘动作文本拆成键帽。
 *   `⌨ Ctrl+Shift+T` → Ctrl* / Shift* / T（修饰键单独上色）
 *   `输入文本「hello」` / `⌨ "hello"` → 单个文本键帽
 *   `Escape` → 单个键帽
 * 放在 JS 侧解析是为了可离线断言；C# 侧只按 US 分隔渲染，不做二次猜测。
 */
export function parseKeycaps(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return []
  const quoted = /^(?:⌨\s*)?(?:输入文本)?[「"'](.+)[」"']$/u.exec(raw)
  if (quoted) return [{ label: quoted[1].slice(0, 48), modifier: false, kind: 'text' }]
  const body = raw.replace(/^⌨\s*/u, '').replace(/^输入文本\s*/u, '')
  return body
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((label) => ({ label: label.slice(0, 24), modifier: MODIFIERS.has(label.toLowerCase()), kind: 'key' }))
}

/** 生成一条 config 命令（全是简单标量，C# 侧 Split('|') 即可解析） */
export function buildConfigLine({ theme = 'dark', fontSize = 15, opacity = 0.93, position = 'auto', fadeMs = 140 } = {}) {
  const t = OVERLAY_THEMES.includes(theme) ? theme : 'dark'
  const p = OVERLAY_POSITIONS.includes(position) ? position : 'auto'
  const fs = Math.min(32, Math.max(10, Math.round(Number(fontSize) || 15)))
  const op = Math.min(100, Math.max(40, Math.round((Number(opacity) || 0.93) * 100)))
  const fade = Math.min(600, Math.max(40, Math.round(Number(fadeMs) || 140)))
  return `config|${t}|${fs}|${op}|${p}|${fade}\n`
}

/** 脚本保持纯 ASCII：PowerShell 5.1 对无 BOM 的 UTF-8 文件会按 ANSI 解析，中文会乱 */
export const PS_SCRIPT = `$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;
using System.Runtime.InteropServices;

public class KeyOverlayForm : Form {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  private class Cap {
    public string Label;
    public bool Mod;
    public Rectangle Rect;
  }

  private System.Windows.Forms.Timer holdTimer;
  private System.Windows.Forms.Timer fadeTimer;
  private List<Cap> layout = new List<Cap>();
  private List<Point> plusAt = new List<Point>();
  private Font capFont;
  private Font plusFont;
  private string theme = "dark";
  private string position = "auto";
  private double targetOpacity = 0.93;
  private int fadeMs = 140;
  private int fadeDir = 0;
  private bool located = false;
  private Color bg, fg, capBg, capFg, modBg, modFg, plusFg;

  public KeyOverlayForm() {
    FormBorderStyle = FormBorderStyle.None;
    StartPosition = FormStartPosition.Manual;
    TopMost = true;
    ShowInTaskbar = false;
    Opacity = 0;
    DoubleBuffered = true;
    Width = 240;
    Height = 60;
    AutoScaleMode = AutoScaleMode.Dpi;
    capFont = new Font("Segoe UI", 15, FontStyle.Bold);
    plusFont = new Font("Segoe UI", 12, FontStyle.Regular);
    ApplyTheme();
    holdTimer = new System.Windows.Forms.Timer();
    holdTimer.Tick += delegate { holdTimer.Stop(); StartFade(-1); };
    fadeTimer = new System.Windows.Forms.Timer();
    fadeTimer.Interval = 25;
    fadeTimer.Tick += delegate {
      double delta = targetOpacity * 25.0 / Math.Max(40, fadeMs);
      double next = Opacity + fadeDir * delta;
      if (fadeDir > 0 && next >= targetOpacity) { Opacity = targetOpacity; fadeDir = 0; fadeTimer.Stop(); }
      else if (fadeDir < 0 && next <= 0.02) { Opacity = 0; fadeDir = 0; fadeTimer.Stop(); Hide(); }
      else Opacity = next;
    };
  }

  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x08000000;
      cp.ExStyle |= 0x00000080;
      cp.ExStyle |= 0x00000020;
      return cp;
    }
  }

  private void ApplyTheme() {
    if (theme == "light") {
      bg = Color.FromArgb(244, 246, 250); fg = Color.FromArgb(28, 30, 38);
      capBg = Color.FromArgb(222, 226, 235); capFg = Color.FromArgb(28, 30, 38);
      modBg = Color.FromArgb(58, 108, 205); modFg = Color.White;
      plusFg = Color.FromArgb(120, 126, 140);
    } else if (theme == "accent") {
      bg = Color.FromArgb(38, 24, 48); fg = Color.White;
      capBg = Color.FromArgb(72, 46, 88); capFg = Color.White;
      modBg = Color.FromArgb(230, 0, 92); modFg = Color.White;
      plusFg = Color.FromArgb(196, 150, 190);
    } else {
      bg = Color.FromArgb(26, 28, 36); fg = Color.White;
      capBg = Color.FromArgb(50, 54, 66); capFg = Color.White;
      modBg = Color.FromArgb(88, 120, 220); modFg = Color.White;
      plusFg = Color.FromArgb(150, 156, 170);
    }
    BackColor = bg; ForeColor = fg; Invalidate();
  }

  public void Configure(string t, int fs, int op100, string pos, int fade) {
    theme = t;
    fs = Math.Max(10, Math.Min(32, fs));
    capFont = new Font("Segoe UI", fs, FontStyle.Bold);
    plusFont = new Font("Segoe UI", Math.Max(9, fs - 3), FontStyle.Regular);
    targetOpacity = Math.Max(0.4, Math.Min(1.0, op100 / 100.0));
    position = pos;
    fadeMs = Math.Max(40, Math.Min(600, fade));
    ApplyTheme();
    located = false;
    Console.Out.WriteLine("ok:config");
    Console.Out.Flush();
  }

  private static GraphicsPath RoundPath(Rectangle r, int rad) {
    GraphicsPath p = new GraphicsPath();
    p.AddArc(r.X, r.Y, rad, rad, 180, 90);
    p.AddArc(r.Right - rad, r.Y, rad, rad, 270, 90);
    p.AddArc(r.Right - rad, r.Bottom - rad, rad, rad, 0, 90);
    p.AddArc(r.X, r.Bottom - rad, rad, rad, 90, 90);
    p.CloseAllFigures();
    return p;
  }

  private void Relayout(string[] caps) {
    layout.Clear(); plusAt.Clear();
    int pad = 14, gap = 8, x = pad, y = pad, rowH = 0, maxW = 560;
    using (Graphics g = CreateGraphics()) {
      for (int i = 0; i < caps.Length; i++) {
        string c = caps[i];
        bool mod = c.StartsWith("*");
        string label = mod ? c.Substring(1) : c;
        if (label.Length == 0) label = "?";
        SizeF s = g.MeasureString(label, capFont);
        int w = Math.Max(36, (int)s.Width + 26);
        int h = Math.Max(32, (int)s.Height + 16);
        if (x + w > maxW - pad && x > pad) { x = pad; y += rowH + gap; rowH = 0; }
        layout.Add(new Cap { Label = label, Mod = mod, Rect = new Rectangle(x, y, w, h) });
        x += w;
        rowH = Math.Max(rowH, h);
        if (i < caps.Length - 1) {
          SizeF ps = g.MeasureString("+", plusFont);
          plusAt.Add(new Point(x + 2, y + (rowH - (int)ps.Height) / 2));
          x += (int)ps.Width + 8;
        }
      }
      int right = pad;
      foreach (Cap c in layout) right = Math.Max(right, c.Rect.Right);
      Width = Math.Max(150, right + pad);
      Height = y + rowH + pad;
    }
    using (GraphicsPath p = RoundPath(new Rectangle(0, 0, Width, Height), 14)) Region = new Region(p);
  }

  protected override void OnPaint(PaintEventArgs e) {
    Graphics g = e.Graphics;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    g.Clear(bg);
    using (SolidBrush b = new SolidBrush(bg)) g.FillRectangle(b, ClientRectangle);
    foreach (Cap c in layout) {
      Color back = c.Mod ? modBg : capBg;
      Color fore = c.Mod ? modFg : capFg;
      using (GraphicsPath p = RoundPath(c.Rect, 8))
      using (SolidBrush b = new SolidBrush(back)) g.FillPath(b, p);
      using (StringFormat sf = new StringFormat()) {
        sf.Alignment = StringAlignment.Center;
        sf.LineAlignment = StringAlignment.Center;
        using (SolidBrush t = new SolidBrush(fore)) g.DrawString(c.Label, capFont, t, c.Rect, sf);
      }
    }
    using (SolidBrush pb = new SolidBrush(plusFg)) {
      foreach (Point at in plusAt) g.DrawString("+", plusFont, pb, at.X, at.Y);
    }
  }

  private void StartFade(int dir) {
    fadeDir = dir;
    fadeTimer.Interval = 25;
    fadeTimer.Start();
  }

  public void ShowText(string encoded, int x, int y, int ms) {
    try {
      string[] caps = encoded.Split((char)31);
      if (caps.Length == 0 || caps[0].Length == 0) caps = new string[] { "?" };
      Relayout(caps);
      if (!located) {
        int px, py;
        Rectangle area = Screen.PrimaryScreen.WorkingArea;
        if (position == "center") {
          px = area.Left + (area.Width - Width) / 2; py = area.Top + (area.Height - Height) / 2;
        } else if (position == "top") {
          px = area.Left + (area.Width - Width) / 2; py = area.Top + 60;
        } else if (position == "bottom" || x < 0 || y < 0) {
          px = area.Left + (area.Width - Width) / 2; py = area.Bottom - Height - 80;
        } else {
          Rectangle near = Screen.FromPoint(new Point(x, y)).WorkingArea;
          px = Math.Min(Math.Max(near.Left + 8, x - Width / 2), near.Right - Width - 8);
          py = Math.Min(Math.Max(near.Top + 8, y - Height - 28), near.Bottom - Height - 8);
        }
        Location = new Point(px, py);
        // fixed = 记住第一次位置；auto 且不指定坐标时也记住，避免连续按键来回跳
        if (position == "fixed" || position == "center" || position == "top" || position == "bottom" || x < 0 || y < 0) located = true;
      }
      holdTimer.Stop();
      fadeTimer.Stop();
      if (!Visible) { Opacity = 0; Show(); }
      StartFade(1);
      holdTimer.Interval = Math.Max(250, ms);
      holdTimer.Start();
      Invalidate();
      Console.Out.WriteLine("ok:shown");
    } catch (Exception ex) {
      Console.Out.WriteLine("err:" + ex.Message);
    }
    Console.Out.Flush();
  }

  public void HideNow() {
    holdTimer.Stop();
    StartFade(-1);
    Console.Out.WriteLine("ok:hidden");
    Console.Out.Flush();
  }

  public void StartReader() {
    Thread t = new Thread(delegate() {
      try {
        string line;
        while ((line = Console.In.ReadLine()) != null) {
          if (line.Length == 0) continue;
          string[] p = line.Split('|');
          if (p[0] == "show" && p.Length >= 5) {
            try {
              string text = Encoding.UTF8.GetString(Convert.FromBase64String(p[4]));
              int ms = int.Parse(p[1]);
              int x = int.Parse(p[2]);
              int y = int.Parse(p[3]);
              BeginInvoke((Action)delegate() { ShowText(text, x, y, ms); });
            } catch (Exception ex) {
              Console.Out.WriteLine("err:" + ex.Message);
              Console.Out.Flush();
            }
          } else if (p[0] == "config" && p.Length >= 6) {
            try {
              string t2 = p[1]; int fs = int.Parse(p[2]); int op = int.Parse(p[3]);
              string pos = p[4]; int fade = int.Parse(p[5]);
              BeginInvoke((Action)delegate() { Configure(t2, fs, op, pos, fade); });
            } catch (Exception ex) {
              Console.Out.WriteLine("err:" + ex.Message);
              Console.Out.Flush();
            }
          } else if (p[0] == "hide") {
            BeginInvoke((Action)delegate() { HideNow(); });
          } else if (p[0] == "exit") {
            BeginInvoke((Action)delegate() { Application.Exit(); Close(); });
            break;
          }
        }
      } catch { }
    });
    t.IsBackground = true;
    t.Start();
  }
}
'@
[KeyOverlayForm]::SetProcessDPIAware() | Out-Null
$form = New-Object KeyOverlayForm
$handle = $form.Handle
$form.Hide()
$form.StartReader()
[Console]::Out.WriteLine("ok:ready")
[Console]::Out.Flush()
[System.Windows.Forms.Application]::Run()
`

/** PowerShell 的 -EncodedCommand 要求 UTF-16LE + Base64 */
export function encodeEncodedCommand(script = PS_SCRIPT) {
  return Buffer.from(String(script), 'utf16le').toString('base64')
}

/** 生成一条 show 命令；键帽串 Base64 化，协议全程 ASCII */
export function buildShowLine(text, { x = -1, y = -1, durationMs = 1400 } = {}) {
  const int = (v, fallback) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : fallback)
  const caps = parseKeycaps(text)
  const encoded = Buffer.from(caps.map((c) => `${c.modifier ? '*' : ''}${c.label}`).join(KEY_SEP), 'utf8').toString('base64')
  // x/y 为负数表示「不指定窗口，主屏底部居中」
  return `show|${Math.max(250, int(durationMs, 1400))}|${int(x, -1)}|${int(y, -1)}|${encoded}\n`
}

/** 进程退出兜底：宿主异常退出时不留一个常驻 PowerShell / 悬浮窗 */
const LIVE = new Set()
let exitHookInstalled = false
function track(proc) {
  LIVE.add(proc)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const p of LIVE) {
      try {
        p.kill?.()
      } catch {
        /* exit 相位不能再抛 */
      }
      for (const s of [p.stdin, p.stdout, p.stderr]) {
        try {
          s?.destroy?.()
        } catch {
          /* 同上 */
        }
      }
    }
    LIVE.clear()
  })
}
function untrack(proc) {
  LIVE.delete(proc)
}

/**
 * 浮窗控制器。懒启动（第一次按键才起进程）、空闲回收、失败后不再反复重试。
 * spawnImpl 仅供测试注入假进程 —— 生产路径永远是 node:child_process 的 spawn。
 */
export class KeyboardOverlay {
  constructor({
    enabled = true, durationMs = 1400, idleShutdownMs = 60000, startTimeoutMs = 5000,
    theme = 'dark', fontSize = 15, opacity = 0.93, position = 'auto', fadeMs = 140,
    spawnImpl = spawn, logger = null,
  } = {}) {
    this.enabled = enabled
    this.durationMs = durationMs
    this.idleShutdownMs = idleShutdownMs
    this.startTimeoutMs = startTimeoutMs
    this.style = { theme, fontSize, opacity, position, fadeMs }
    this.spawnImpl = spawnImpl
    this.logger = logger
    this.proc = null
    this.ready = null
    this.unavailable = false
    this.lastError = ''
    this.shows = 0
    this.idleTimer = null
  }

  get running() {
    return this.proc !== null && this.proc.exitCode === null
  }

  /** 启动浮窗进程并等 ready；失败只记原因并标记不可用，不抛给键盘路径 */
  ensure() {
    if (!this.enabled || this.unavailable) return Promise.resolve(false)
    if (this.ready) return this.ready
    this.ready = new Promise((resolve) => {
      let proc
      try {
        proc = this.spawnImpl(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodeEncodedCommand()],
          { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
        )
      } catch (err) {
        this.lastError = `启动浮窗进程失败：${err instanceof Error ? err.message : err}`
        this.unavailable = true
        resolve(false)
        return
      }
      track(proc)
      this.proc = proc
      let out = ''
      let settled = false
      const finish = (ok) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(ok)
      }
      // 这个 timer **不能 unref**：等待 ready 期间它是唯一能保证「超时一定会触发」的
      // handle。unref 后若子进程还没提供活跃 stdio（或测试注入的是内存流），事件循环
      // 会直接空转，ensure() 的 Promise 永远不 settle —— 键盘路径就被挂住了。
      const timer = setTimeout(() => {
        this.lastError = `浮窗启动超时（${this.startTimeoutMs}ms，首次 Add-Type 编译可能较慢）`
        this.unavailable = true
        this.stop()
        finish(false)
      }, this.startTimeoutMs)
      // 管道 error 没有监听者会变成 uncaughtException，把宿主一起带走
      for (const s of [proc.stdin, proc.stdout, proc.stderr]) s?.on?.('error', () => {})
      proc.stdout?.setEncoding?.('utf8')
      proc.stdout?.on?.('data', (chunk) => {
        // out 是累积的，不做幂等保护的话 ok:ready 会在每个后续 data 事件里再次命中，
        // 于是反复发 config、config 又回 ok:config，形成无限回环（真机实测踩到）
        if (settled) return
        out = (out + chunk).slice(-4000)
        if (/ok:ready/.test(out)) {
          // 主题 / 字号 / 位置策略只发一次，配置变化时由 buildConfigLine 重新生成
          try {
            proc.stdin?.write?.(buildConfigLine(this.style))
          } catch {
            /* 配置发不进去就用默认皮肤，不影响浮窗 */
          }
          this.lastError = ''
          finish(true)
        }
      })
      proc.stderr?.on?.('data', (chunk) => {
        const s = String(chunk).trim()
        // PowerShell 在重定向错误流时会吐一段 CLIXML 序列化前缀，不是真错误
        if (!s || /^#<\s*CLIXML/i.test(s)) return
        this.lastError = `浮窗 stderr：${s.slice(0, 200)}`
      })
      proc.on?.('error', (err) => {
        this.lastError = `浮窗进程错误：${err?.message ?? err}`
        this.unavailable = true
        finish(false)
      })
      proc.on?.('exit', () => {
        this.proc = null
        this.ready = null
        untrack(proc)
        finish(false)
      })
    })
    return this.ready
  }

  /** 显示一条键盘动作；fire-and-forget 友好，失败返回 false 而不抛 */
  async show(text, pos = {}) {
    if (!this.enabled || this.unavailable) return false
    const ok = await this.ensure()
    if (!ok || !this.proc?.stdin) return false
    try {
      this.proc.stdin.write(buildShowLine(text, { ...pos, durationMs: this.durationMs }))
      this.shows += 1
      this._touch()
      return true
    } catch (err) {
      this.lastError = `写浮窗命令失败：${err instanceof Error ? err.message : err}`
      return false
    }
  }

  hide() {
    try {
      this.proc?.stdin?.write?.('hide\n')
    } catch {
      /* 浮窗缺席无所谓 */
    }
  }

  _touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (!this.idleShutdownMs || this.idleShutdownMs <= 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.stop()
    }, this.idleShutdownMs)
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref()
  }

  stop() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const proc = this.proc
    this.proc = null
    this.ready = null
    if (!proc) return
    try {
      proc.stdin?.write?.('exit\n')
      proc.stdin?.end?.()
    } catch {
      /* 已经关了 */
    }
    try {
      proc.kill?.()
    } catch {
      /* 已经死了 */
    }
    untrack(proc)
  }

  describe() {
    return {
      enabled: this.enabled,
      running: this.running,
      unavailable: this.unavailable,
      shows: this.shows,
      lastError: this.lastError,
      style: { ...this.style },
    }
  }
}
