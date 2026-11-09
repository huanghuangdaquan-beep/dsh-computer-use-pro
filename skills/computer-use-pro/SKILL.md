---
name: computer-use-pro
description: 桌面操控的**故障排除**规程，只在语义路径失效时加载（控件点不动 / 元素数没变化 / 树读不到 / 空窗口或陈旧实例 / 要判断菜单对话框在哪 / 要按 AUMID 重拉应用）。常规的点按钮、填输入框、读控件不需要加载它 —— cu_* 工具自带规程，直接调更快。
---

# 电脑操控 · 定位增强规程（DSH 版）

本技能是 `dsh-computer-use-pro` 插件自带的操作规程。插件把 MiniMax 电脑操控驱动
（`cua-driver`，本机 0.34.1）的原生 MCP stdio server 接进了 DeepSeek Harness，
**没有门面遮蔽**：驱动自身那 59 个工具全部可达（`cu_*` 直连 + `cu_call` 转发）。

## 核心立场

**读不到元素是要诊断的故障，不是改用像素坐标的理由。**

驱动的主定位链路是语义优先的：Windows UI Automation 走查出带 `element_token` 的可访问性树，
控件按名字和角色精确定位，**不猜坐标**。像素点击只是语义路径彻底失效后的兜底。
把它当默认路径，就会得到「看屏幕猜位置」的体验。

## 工具速查

| 工具 | 什么时候用 |
|---|---|
| `cu_doctor` | 一切开始之前。确认驱动在、握手通、工具面 59 个、屏幕与窗口数正常 |
| `cu_windows` | 找窗口。拿 `pid` + `windowId`；同名窗口会同时列出来。**多数情况不必调它** |
| `cu_window_info` | 树为空时的第一手证据：`class_name` 是 `CoreWindow`（非渲染面）还是 `ApplicationFrameWindow`（真外壳） |
| `cu_state` | 读语义树，行末是 `element_token`。**自带 settle**（首读 < 8 个元素自动重读）；默认只列可点元素 + 祖先链；支持 `query` 投影与 `title` 直接定位窗口；窗口最小化/离屏时会明确警告 |
| `cu_click` | 语义点击：label → token → 自动挑动作 → 三级升级（background → foreground → expand）→ 复核**元素数 + 目标控件状态 + 窗口状态**；同名多个用 `index` 选（输出带候选表）；最小化窗口先 `bring_to_front` 恢复；生效时附迷你快照 |
| `cu_key` | 键盘：单键 / 组合键 / 输入文本。**默认 foreground**，因为 Chromium 拒收 background 键盘 |
| `cu_recover` | **一条命令走完诊断阶梯**：重读 → 换同名兄弟窗口 → 按 AUMID 重拉；成功时直接给可用的 pid/windowId |
| `cu_verify` | window 级谓词验证（element 级在 0.34.1 恒 unknown，见下） |
| `cu_call` | 逃生口。不传 `tool` 列全部原生工具；传了就转发（`launch_app`/`invoke_menu`/`zoom`/录制…） |
| `cu_scroll` | 滚动窗口：`direction` + `amount` + `by`，可直接传 `title` |
| `cu_drag` | 按住拖动：`fromX/fromY → toX/toY`（窗口局部截图像素） |
| `cu_clipboard` | 读写剪贴板；`read` 默认不返回明文，`includeText:true` 才读 |
| `cu_cursor` | 鼠标 / 键盘覆盖层的诊断与控制：`status` / `show` / `hide` / `place` |

> `cu_state` / `cu_click` / `cu_key` / `cu_verify` / `cu_recover` 都可以直接传
> `title:"<窗口标题子串>"` 代替 `pid+windowId` —— 内部解析，省掉一整轮 `cu_windows`。
> 重名窗口会取最匹配的那个，并把其余候选写在输出里。

> 0.3.4 起滚动 / 拖拽 / 剪贴板都有直连工具：`cu_scroll({ title, direction:"down", amount:3 })`、
> `cu_drag({ title, fromX, fromY, toX, toY })`、`cu_clipboard({ action:"write", text })`；
> 更冷门的原生能力仍走 `cu_call`。鼠标 / 键盘覆盖层用 `cu_cursor` 诊断与控制。

## 诊断阶梯（按顺序执行，每步都很便宜）

### 1. 懒发布是常态 —— 重读一次再判断

Web / Electron / UWP 的可访问性树是**懒发布**的：窗口刚启动或刚可见时，第一次走查往往只回
几个元素；隔一会儿重读就能拿到完整树，而且**之后还会继续增长**。

本机实测：

| 场景 | 读数序列 |
|---|---|
| DSH（Electron） | 首读 **3** 个（只有标题栏按钮）→ **137** → **148** → **155** → **171** |
| MiniMax Code（Electron） | 首读 **3** → **357** |

`cu_state` 已内置这一步：首读 < 8 个元素或标了 `degraded` 会自动重读（最多 3 次），
输出里带 `settle：读了 N 次，元素数 3 → 137`。**看到 settle 行就说明树是懒发布的，
不是「这个应用没有语义目标」**。要一次定稿设 `settle:false`。

### 2. 确认你观察的窗口，就是真正渲染 UI 的那个

三类坑，表现都是「树是空的」：

- **同名兄弟窗口**：同一界面同时挂在两个进程的同名顶层窗口上（UWP 本体 vs
  `ApplicationFrameHost.exe` 宿主；应用 vs 启动器）。按标题选窗会选中**幽灵窗口**。
- **选到非渲染面**：XAML 应用的 core window（`Windows.UI.Core.CoreWindow`）不是可见外壳，
  真正的外壳是宿主的 `ApplicationFrameWindow`。
- **实例陈旧 / 被挂起**：句柄在、bounds 正常、`is_on_screen=true`，但界面根本没渲染，树为空。

**这三步现在一条命令就能走完**：

```
cu_recover({ pid, windowId })                    // 重读 + 换兄弟窗口
cu_recover({ pid, windowId, relaunch: true })    // 仍空则按 AUMID 重拉该应用
```

它每步都报元素数，成功时直接告诉你「用 pid=X windowId=Y 继续」。

### 3. 先收窄再搜索

树很大时一次读几百节点会拖慢并让 token 反复失效。用 `cu_state` 的 `query`
按控件可见文本收窄：调用方只看到 4 行，而树实际有 259 个元素。

没命中就换 `query` 再读，**不要**为了少输出去调低 `maxDepth`——那会在过滤前就把目标截掉。

### 4. 像素定位必须锚定在「当前这张截图」上

- 坐标只来自**目标窗口当前这张原始截图**，不是 AX frame，不是旧观察里的标注。
- 看画面：`cu_state({ screenshot: true })` —— 截图会作为**图片直接返回**（同时落盘到
  `~/.dsh/computer-use/shots/`，也可用 `screenshotFile` 指定路径）。只回路径、看不到图，
  说明当前模型路由或宿主没有图片通道，输出里会明确写原因。
- 截图是**自然分辨率**、不含 1px 窗口边框（宽高比 `window_bounds` 少 2px）。
  图上的像素坐标就是 `cu_click` 的 `x,y`（原点左上，驱动与 PNG 同源，实测 1:1）。
- 点完 `cu_click` 会回一张**带红圈的新截图**（`screenshot:false` 可关）：先看画面确认再继续。
- 窗口动作用**窗口截图**像素，桌面动作用**桌面截图**像素，两套空间不能混用。
- agent cursor 覆盖层是**独立顶层窗口**：它只对真机用户可见，**不会出现在窗口截图里**
  （实测开/关覆盖层逐字节一致）。所以图上的红圈是插件按同一像素坐标画的，不是覆盖层。
  桌面截图里可能看到覆盖层本身，别把它当成界面元素。

### 5. 验证：window 级谓词可信，element 级谓词不可信

`cu_verify` 有三态：`satisfied` / `unsatisfied` / `unknown`。**`unknown` 不等于成功。**

本机实测（驱动 0.34.1）：

| 谓词 | 结果 |
|---|---|
| `{"window":{"exists":true}}` | ✅ `satisfied` |
| `{"window":{"bounds":{"x":476,"y":111,"width":800,"height":600,"tolerance_px":8}}}` | ✅ `satisfied`（bounds 必须给全 x/y/width/height） |
| 同上但尺寸故意写错 | ✅ `unsatisfied`（**能证伪**） |
| `{"element":{"selector":{"label_contains":"编辑"},"exists":true}}` | ⚠ 恒为 `unknown` + `untrusted_source`，哪怕 `observed_json` 里有 `matches:2` |

所以：想验「窗口还在/尺寸变了」→ window 级谓词；想验「某个控件出现了」→
**重读 `cu_state` 比对标签**（`cu_click` 已自动做一次）。

## 语义点击 + 键盘的完整闭环

```
1) cu_state(title="记事本")                  → MenuItem "编辑(E)" token=s00000001:7 actions=[invoke,expand]
2) cu_click({ title:"记事本", label:"编辑(E)" })
     → ① background invoke 没改动界面
     → ② 自动换 foreground 重投：元素数 11 → 20（+9）    ← 菜单真的开了
     → 附一份迷你新快照（菜单项全带新 token，可直接接着点）
3) cu_click({ pid, windowId, label:"全选(A)" })          ← 用迷你快照里的 token 定位
4) cu_key({ pid, key:"Escape" })                        → delivery=foreground（键盘必须前台）
```

`click` 的 `effect` 必须读：

| 值 | 含义 | 该干什么 |
|---|---|---|
| `confirmed` | 驱动自证生效 | 可以继续 |
| `unverifiable` | **驱动没有独立证据**（不是失败！） | 看复核行：元素数变了、或目标控件标签/值/选中变了，都是生效；若该元素本身没有可比对的状态（文本输入类，见下），点一下只是获得焦点，「没变化」不代表失败 |
| `suspected_noop` | 疑似没生效 | 换 action、换 element，或降级坐标 |
| `refused` | 被拒 | 看原因（`window_minimized` ≠ 没通道），换路径，别重试同一调用 |

### 0.3.1 实测：三个「点不到」的真凶（X 时间线，55 次点击没成）

| 现象 | 真因 | 现在的处理 |
|---|---|---|
| 点了完全没反应 | **窗口最小化了**：bounds `146x28@-31993,-32000` 是图标占位符，UIA 能读、invoke 也能生效，但 foreground/像素点击全落在占位符上 | `cu_state` 直接警告；`cu_click` 先 `bring_to_front`（`restored:true`）再点；驱动回 `window_minimized` 时恢复后重投一次 |
| 点成功了却报「没生效」，再点一次又变回去 | 复核只比元素数。点「喜欢」元素数不变，只有标签变（`945 喜欢次数。喜欢` → `948 喜欢次数。喜欢了`）→ 判失败 → 重投 → toggle 被点回去 | 复核比三样（元素数 + 整树指纹 + 目标控件自身），并 settle 0/220/380ms 重读；任一变即算生效 |
| 一屏 7 个「转帖」，点到别的推文去了 | 同名控件没有选择手段（模型会自己编 `index`，旧版没这个参数，静默忽略） | `cu_click` 新增 `index`（0 起），命中多个时输出带序号的候选表 |
| 点文本框（`Edit` / `Document`）报「很可能没生效，别在原路径上重试」，随后 `cu_key` 却输入正常 | 文本输入类点一下**只是获得焦点**：label/value/selected 全不动，复核必然「没变化」→ 误判成失败 | 先判元素有没有可比对的状态：没有就只回「已发送点击、无可比对状态、不能据此判定失败」，不升级重投（省 2 次读树 + ~600ms） |

**教训**：`元素数没变` 从来不是「没生效」的证据。toggle / 勾选 / 切换标签 / 最小化窗口
这些操作全都可能一个元素都不增不减。

### 0.3.0 实测：菜单项那三个通道坑

| 现象 | 真因 | 现在的处理 |
|---|---|---|
| `actions=[invoke,expand]` 的菜单项点了没反应 | Win11 菜单项的 `invoke` 是**静默空点**（PostMessage 到元素坐标，菜单不开也不报错） | 复核发现元素数没变 → 自动改走 `action:"expand"` |
| `action:"expand"` 回 `tool_invocation_failed / 0x80040200` | 该动作**要求窗口在前台**，background 下必失败 | 自动升 `foreground` 重投 |
| 升前台后仍回 `0x80040200`，但菜单已经开了 | 驱动在 ExpandCollapse 上**误报错误码** | 一律以复核结果为准（元素数 / 控件状态 / 新窗口），不信错误码 |

`cu_click` 内部就是这条三级阶梯（background → foreground → expand），每级用**最新快照**的
token 重取元素（重读会让旧 token 失效）。所以看到「（invoke 是静默空点，已改用 action:"expand" 并生效）」
这类括号说明，就表示它已经自己爬完了阶梯 —— 不要再去重复同一次点击。

**菜单/对话框到底长在哪，两种都要查**：有的长在自身树里（Win11 记事本点开「编辑」：
11 → 20 个元素，菜单项就在同一个 window 下），有的是独立 popup 窗口（经典 Win32 菜单 `#32768`、
右键菜单、模态对话框）。`cu_click` 的复核**两件事一起做**：比元素数，也比窗口表；
出现新窗口时直接点名 `pid / window_id`，用 `cu_state` 读它。

**键盘只有前台能落**：对 `Chrome_WidgetWin_1`（Electron/Chrome）发 `press_key`，
`background` 会被明确拒绝（`Background delivery is not available ... (keystroke)`）。
`cu_key` 默认就用 `foreground`：动作期间短暂置前，结束后驱动自己还原。
这**不是权限问题**，不要反复重试 background。

`element_token` 形如 `s00000001:11`，属于**当次快照**；下一次 `cu_state` 会让旧 token 失效。
所以「观察 → 取 token → 点击」要在同一轮内完成 —— `cu_click` 已把时序封好。

## 观察视图：默认就是压缩过的

`cu_state` 默认 `mode:"interactive"`：只列**可点元素 + 输入框 + 它们的祖先链**，
滚动条/状态栏/纯文本只报计数；同一层同角色超过 9 个（会话列表、工具调用记录）自动折叠成
「…同层另有 N 个 TreeItem」。本机实测：DSH 窗口 139 元素，输出从 **14.3KB 降到 4.9KB**。

| 想要 | 怎么调 |
|---|---|
| 目标在列表深处 | `query:"<控件文字>"`（驱动侧投影，只回命中的行 + 祖先链，实测 139 → 26 行） |
| 就是要看原始树 | `mode:"full"` |
| 要算像素点击 | `showBounds:true`（每行附带窗口内坐标与尺寸） |
| 行被预算截断 | 调大 `maxChars`（默认 8000）或收窄 `query` |

⚠ 别用 `maxDepth` 省输出：它在过滤前就截断，目标会被切掉。
⚠ `max_elements:0` 不是「不限制」，而是「只走 1 个节点」，整棵树会读成空的（插件已兜住，手写 `cu_call` 时注意）。

## 实测案例：Windows「设置」读不到元素（已闭环）

现场：同名两个窗口，`SystemSettings.exe`（`Windows.UI.Core.CoreWindow`）和
`ApplicationFrameHost.exe`（`ApplicationFrameWindow`），**两个都读 0 元素**，
重读两次仍是 0，`degraded_reason=ax_tree_empty`。这不是非渲染面问题，是**陈旧实例**。

恢复（`cu_recover` 的 ③ 步就是这套）：

```js
cu_call({ tool: 'launch_app', args: {
  aumid: 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel'
}})
// → 同一窗口（pid 4196 / window 197122）从 0 变 50 个元素
//   MenuItem "系统" / Edit "搜索框，查找设置" / ListItem "系统" …
```

踩过的两个坑：

- `bundle_id: "windows.immersivecontrolpanel_cw5n1h2txyewy!App"` 会失败
  （`0x80270254 此应用不支持指定的合约或未安装该应用`）—— `!App` 不是它的 AppId。
- `launch_path: "shell:appsFolder\\…!App"`（list_apps 原样回填）也会失败（`0x80070002`）。

**能用的是这两种**：`aumid: <bundle_id>!<真实 AppId>`，或直接给 `name: "设置"`
（驱动会去 shell:AppsFolder 索引里按显示名解析）。`cu_recover` 会依次试这几种。

## 语义路径确实不可用时

明确说出来，不要静默降级：写清「哪个应用、哪个窗口、树为空、已排除哪些成因」，
再说明退化到了什么方式（坐标 / 快捷键 / 换别的工具）。

## Windows 上的环境事实

- 「窗口最小化 / 不在屏上」**不等于**读不到元素：最小化的 Chrome 仍返回 31 个元素、
  `truncated=false`。别拿「看不见」解释空树。但它**等于点不到**：最小化窗口的 bounds 是
  `146x28@-31993,-32000`（图标占位符），`foreground` / 像素点击会落在占位符上、静默无效，
  只有 UIA `invoke` / `expand` 还能生效。先 `bring_to_front`（返回 `restored:true` 才算真恢复）。
- `list_windows(on_screen_only:true)` **不含最小化窗口**（实测 7 个窗口只回来 3 个）：
  按标题找不到窗口时，先怀疑它被最小化了，而不是「窗口关了」。
- `bring_to_front` 可能只提升 z-order 而拿不到前台（`foreground_unavailable`），
  不是权限问题，别反复重试同一路径。
- 驱动不支持自更新（更新由 MiniMax 组件安装器接管）。

## 深挖：原生 MCP 面（59 个工具）

`cu_call` 不传 `tool` 时列出全部原生工具（可传 `query` 过滤）。`cu_*` 没覆盖的高价值能力：

| 工具 | 价值 |
|---|---|
| `launch_app` | 按 AUMID / 显示名 / exe 拉起；恢复陈旧实例的关键 |
| `list_apps` | 140 个应用的 `bundle_id` / `launch_path` / pid（`cu_call` 会重排成带 AUMID 的清单） |
| `get_window_state` | 全参数版：`max_elements` / `max_depth` / `query` / `timeout_ms` / `screenshot_out_file` / `capture_mode` |
| `get_desktop_state` | 整屏观察（可 `screenshot_out_file` 落盘） |
| `drag` / `scroll` / `set_value` / `invoke_menu` | 未覆盖的动作；`invoke_menu` 按菜单路径调用比逐级点更稳 |
| `set_window_frame` | 把窗口摆到确定位置尺寸，方便截图坐标可复现 |

`get_window_state` 的诊断字段（`cu_state` 已透出）：`element_count` / `total_element_count` /
`returned_element_count` / `nodes_pending` / `nodes_visited` / `elements_complete` /
`truncated` / `truncation_reason` / `snapshot_id` / `walk_elapsed_ms`。
**判断「树是被截断了还是真的没有」只能靠这几个字段。**

## 0.3.6 增补：浮窗键帽与渐隐

- 组合键不再是一行字：`Ctrl+Shift+T` 会拆成独立**键帽**，修饰键上强调色、中间 `+` 连接，
  超宽自动换行，最多 8 个；`输入文本「…」` 渲染成单个文本块，中文不乱码。
- 浮窗有**渐隐**淡入 / 淡出（`overlayFadeMs`），连续按键不会闪一下。
- 外观可配：`overlayTheme`（dark / light / accent）、`overlayFontSize`、`overlayOpacityPct`；
  位置可配 `overlayPosition`（`auto` 跟随窗口 / `fixed` **记住首次位置**不再跳 / center / top / bottom）。
- 真实按键仍走 `cu_key`，浮窗只是可视化；`keyboardOverlayWindow:false` 关掉不影响任何动作。

## 0.3.5 增补：桌面按键浮窗与 RPC 精简

- **键盘动作现在真的能「看见」了**：`cu_key` 发组合键 / 单键 / 输入文本时，桌面会弹一个
  置顶半透明浮窗显示 `⌨ Ctrl+A` 或输入内容，默认 1400ms 自动消失。它由插件自绘
  （PowerShell `Add-Type` 编译 WinForms 窗体，`-EncodedCommand` 传脚本），
  `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT` 保证**不抢焦点、不拦鼠标**，
  `SetProcessDPIAware` + `Screen.FromPoint` 处理 DPI 与多显示器。文本走 Base64，中文不乱码。
- **不影响键盘速度**：浮窗是 fire-and-forget，首次 PowerShell 编译约 1 秒也不会拖慢按键；
  `cu_cursor({action:"show"})` 可预热。`keyboardOverlayWindow:false` 可关整个浮窗，
  `keyboardOverlay:false` 连覆盖层自愈与 `⌨` 行一起关。
- **RPC 精简**：`observeProfile` 控制复核取样轮数（`fast` 2 轮 / `balanced` 3 轮默认 /
  `thorough` 4 轮）；`targetCacheMs`（默认 1500ms）内同 `title` 不重列窗口表；
  文本输入类点击连窗口表都不列。`cu_doctor` 会报当前档位与缓存情况。
- 需要「稳」胜过「快」时设 `thorough`（菜单弹窗慢的应用）；连续批量操作同一窗口时
  `fast` + `targetCacheMs:3000` 最省往返。

## 0.3.4 增补：鼠标 / 键盘可视化与便捷动作

- **鼠标光标「老是不见」有确切根因**：实测 `get_agent_cursor_state` 回 `enabled:true`
  但 `idle_hide_ms=15000`（闲置 15 秒自动隐藏）、`position=null`、`timing=native / glide=0`。
  插件以前既不关 idle_hide，也从不主动 `set_agent_cursor_enabled`，失败还全被 `catch {}`
  吞掉。现在每次 `cu_click` / `cu_key` 前都会读回状态并自愈（启用 + `idle_hide_ms:0` +
  120ms 直移 + 光晕/涟漪），诊断直接写进输出。手动查 / 修：
  `cu_cursor({action:"status"})` → `cu_cursor({action:"show"})`。
- **`move_cursor` 的参数形状**：`{ session, target:{kind:'window',pid,window_id}, x, y }`，
  **不能带 `scope`**（实测带 `scope:'window'` 回 `invalid_action_target`，带扁平 pid 回
  `unknown argument pid`）；x,y 是窗口局部截图像素，不是屏幕绝对点。
- **键盘 UI（0.3.5 已增强为桌面浮窗）**：`cu_key` 输出 `⌨ 键盘动作` 行、回读驱动的
  `visual_state`，并弹出置顶浮窗显示具体按键 / 文本；`keyboardOverlay:false` 可关，详见上节。
- **便捷动作**：`cu_scroll` / `cu_drag` / `cu_clipboard`，不必再拼 `cu_call`。
- **截图保留**：`screenshotMaxFiles` / `screenshotMaxAgeDays` 默认 0（不删任何文件）；
  显式开启后只清理本插件命名的 PNG，每批最多 50 个，`cu_doctor` 会报当前策略。
- **驱动自愈**：`findDriverExe` 收集全部版本候选，最高版本启动失败自动回退次新版本；
  只读工具在链路级失败后自动补一次，**动作类绝不重试**（防止重复点击 / 重复输入）；
  连续 5 次失败熔断 30 秒；非 Windows 平台给出明确诊断而不是静默扫空。

## 0.3.3 增补（排障时用得上）

- **像素点击也有升级阶梯**：原生 Win32 菜单项（Chrome 的「Chrome」菜单 → 「打开新的标签页」）
  对 background 合成事件走「取消」分支，界面一点不变；`cu_click` 复核判定没生效后会自动改用
  `foreground` 真鼠标事件重点一次。**已经生效绝不重投**（toggle 被点第二下会变回去）。
- **agent cursor 会话**：覆盖层用 `session:"dsh-computer-use-pro"`，插件把默认 1430ms 滑动
  改成本 session 的 120ms 直移（只设一次），再用 `move_cursor` 挪到目标控件中心。
  覆盖层是独立顶层窗口，窗口截图拍不到它，模型看到的红圈是插件按同一像素坐标画上的。
- **先看体检再开工**：`cu_doctor` 现在给出累计调用画像（次数 / 失败 / 超时 / 平均与最慢耗时）
  和截图目录的只读占用盘点。怀疑「这轮怎么这么慢」「驱动是不是在超时重启」时先看这几行。
- **命令行探针**：`click-by` 复用宿主同款 `cu_click`，支持 `--index` / `--delivery` /
  `--no-observe`；另有 `verify` / `describe` / `list` / `info` / `call` 子命令，完整用法见 README。
- **配置写错不再静默**：`defaultDelivery` 只认 `background` / `foreground`，数值项收敛到安全区间，
  非法值会在宿主日志里留痕。技能正文的截图目录跟随 `screenshotDir` 当前值，不再是写死的默认路径。

## 复检

链路可疑时先 `cu_doctor`。实测证据（含复现步骤与原始字段）见
`references/grounding-evidence.md`。
