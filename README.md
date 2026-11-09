# dsh-computer-use-pro

给 **DeepSeek Harness** 装上一双手：把 MiniMax 电脑操控驱动（`cua-driver`）的原生
**MCP stdio server** 接进宿主，让模型真的能看窗口、点控件、打字，而不是靠猜坐标。

> 移植自 MiniMax Code 的用户插件 `~/.minimax/plugins/computer-use-pro`。
> 那边是「给门面补一层定位规程」，这边是「把门面遮蔽的原生面整条接过来」——
> 因为 DSH 自己没有任何 `computer_*` 工具，遮罩层不存在了。

## 它做什么

| 能力 | 实现 |
|---|---|
| 13 个 `cu_*` 工具 | `lib/tools.js`（窗口列表 / 归属诊断 / UIA 语义树 / 语义点击 / 键盘 / 一键恢复 / 谓词验证 / 原生转发 / 体检 / 覆盖层诊断 / 滚动 / 拖拽 / 剪贴板） |
| `computer-use-pro` 技能 | `skills/computer-use-pro/SKILL.md`，注册进宿主 skill catalog（runtime 层） |
| 常驻驱动子进程 | `lib/driver.js`：懒启动、空闲回收、超时杀进程重来，避免每次调用 1s 冷启动 |
| 定位规程 | UIA 语义优先、Electron 懒发布重读、幽灵窗口/陈旧实例辨析、像素定位纪律 |
| 系统提示路由 | 一小节「桌面控制工具路由」，解决「装了但模型不主动用」 |

## 0.3.6 浮窗再打磨：键帽、渐隐、主题、位置记忆

| 能力 | 说明 |
|---|---|
| 组合键键帽 | `Ctrl+Shift+T` 拆成独立键帽绘制，修饰键用强调色，中间显示 `+`；超宽自动换行，最多 8 个键帽。文本解析放在 JS 侧（`parseKeycaps`）便于离线断言，C# 只按 US 分隔符渲染 |
| 多键排版 | 每个键帽按文本宽度自适应，整窗宽度按实际右边界计算；`输入文本「…」` 渲染成一个文本块，中文不乱码 |
| 渐隐动画 | 25ms 定时器做 Opacity 淡入 → 停留 → 淡出，`overlayFadeMs`（默认 140ms）控制速度；重复按键重置淡入而不是闪一下 |
| 主题 / 字号 / 透明度 | `overlayTheme`：`dark` / `light` / `accent`（品红，呼应点击红圈）；`overlayFontSize` 10-32；`overlayOpacityPct` 40-100 |
| 位置记忆 | `overlayPosition`：`auto`（跟随目标窗口；无坐标则底部居中且记住）、`fixed`（记住首次位置不跳）、`center` / `top` / `bottom` |
| 协议 | 新增 `config\|<theme>\|<fontSize>\|<opacityPct>\|<position>\|<fadeMs>`，ready 后只发一次（幂等保护 —— 实测修掉了 `ok:ready` 累积匹配导致的 config 回环刷屏） |

真机复验：`READY=true`、`configCount=1`、`shownCount=2`、`errCount=0`；light / accent 主题、fixed 位置、渐隐均正常。
新增 19 条断言覆盖键帽解析（组合键 / 单键 / 输入文本 / 引号 / 数量上限）、config 协议与非法参数收敛、
show 协议兼容、外观配置归一化、文档防漂移。**离线 366 项、全量 376 项全通过。**

## 0.3.5 加了「真·桌面按键浮窗」并削掉一轮轮 RPC

驱动 59 个原生工具里没有任何「显示一段文字浮层」的能力，agent cursor 覆盖层也只能移动 / 换主题，
所以这一版由插件自己画：把一段 PowerShell / WinForms 脚本用 **UTF-16LE + Base64** 经
`powershell.exe -EncodedCommand` 传入（避开 Windows 命令行中文编码坑），`Add-Type` 编译一个 C# Form：
置顶、无边框、半透明圆角、`WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT`
（不抢焦点、不进任务栏、鼠标穿透）、`SetProcessDPIAware` + `Screen.FromPoint`（DPI / 多显示器）、
定时器自动隐藏。主线程跑消息循环，后台线程读 stdin；协议是纯 ASCII 的
`show|<ms>|<x>|<y>|<base64(utf8 文本)>`，文本 Base64 化让中文 / 竖线 / 换行都不破坏协议。

| 类别 | 说明 |
|---|---|
| 浮窗 | `cu_key` 按组合键 / 单键 / 输入文本时弹出 `⌨ Ctrl+A` 一类提示，默认 1400ms 后消失；有目标窗口坐标就贴在窗口下方，没有就主屏底部居中（**零额外 RPC**） |
| 不拖慢键盘 | fire-and-forget：首次 PowerShell Add-Type 编译约 1 秒，不让键盘动作等它；`cu_cursor({action:"show"})` 可预热 |
| 生命周期 | 懒启动、60 秒空闲回收、进程 exit 兜底；PowerShell 缺席 / 启动超时会标记不可用并短路，**绝不因浮窗失败影响键盘** |
| title 缓存 | `targetCacheMs`（默认 1500ms）内连续用同一 `title` 不再重列全量窗口表，省一次 RPC / 一次 ~50ms |
| 复核档位 | `observeProfile`：`fast`(0/150ms，2 轮) / `balanced`(0/220/380，3 轮，默认) / `thorough`(0/220/380/600，4 轮)；也影响 `cu_state` 的 settle 轮数 |
| 文本输入类 | 点文本框本来就只取一次样且判不出成败，现在连窗口表都不列，直接复用点击前那份，再省一次 RPC |
| 可观测 | `cu_doctor` 输出当前档位、取样延迟、title 缓存命中情况、浮窗进程状态与已显示次数 |

> 浮窗是 Windows 专属（依赖 PowerShell 5.1 / WinForms）。真机实测 `ready → show → ok:shown` 通过，
> 中文文本经 Base64 正常送达；启动超时定时器特意**不 unref**，否则等待 ready 期间可能永远不 settle。
> `keyboardOverlayWindow:false` 可整体关闭。
>
> 测试：新增 22 条断言覆盖 -EncodedCommand 往返、Base64 文本协议、懒启动 / 复用 / stop / 超时降级 /
> `fast` 档确实比 `balanced` 少 RPC / title 缓存只列一次窗口表 / 新配置与文档防漂移。
> 当时 **离线 347 项、全量 357 项全通过**。

## 0.3.4 修的是「鼠标光标老是不见」+ 把冷门能力变成直连工具

现场：`get_agent_cursor_state` 回 `enabled:true` 却 `idle_hide_ms=15000`、`position=null`、
`timing=native / glide=0`。驱动闲置 15 秒就把覆盖层藏了，而插件从来只设过一次 120ms 直移、
从不主动 `set_agent_cursor_enabled`，所有失败还被 `catch {}` 吞掉 —— 于是「看不见，也查不出原因」。
另外实测确认 `move_cursor` **不能带 `scope`**（带 `scope:'window'` 回 `invalid_action_target`，
带扁平 `pid` 回 `unknown argument pid`），x,y 是窗口局部截图像素而非屏幕绝对点。

| 类别 | 0.3.4 的处理 |
|---|---|
| 鼠标 UI | 每次 `cu_click` / `cu_key` 前读回状态按需自愈：启用 + `idle_hide_ms:0`（永不自动隐藏）+ 120ms 直移 + 光晕/涟漪；回读验证，诊断写进工具输出，不再静默吞错。新增 `cu_cursor`（status / show / hide / place） |
| 键盘 UI | `cu_key` 增加 `⌨ 键盘动作` 行，并回读驱动的 `visual_state`（requested / resolved action、modifiers）作为桌面侧反馈；`keyboardOverlay:false` 可关 |
| 便捷动作 | 新增 `cu_scroll` / `cu_drag` / `cu_clipboard`，工具数 **9 → 13**；提示节与技能里「没有 cu_scroll 这个工具」的陈述同步撤掉 |
| 单一数据源 | 系统提示节的工具清单由 `toolRoster(defs)` 从实际注册定义生成，规则集中在 `ROUTING_RULES`；冒烟测试校验 README / SKILL.md 覆盖全部工具名，加工具不再漏改文档 |
| 截图生命周期 | `screenshotMaxFiles` / `screenshotMaxAgeDays` 默认 0（不删任何文件）；显式开启后只清理本插件命名的 PNG、每批最多 50 个；`cu_doctor` 报当前策略 |
| 驱动自愈 | `findDriverExe` 收集全部版本候选，最高版本启动 / 握手失败自动回退次新版本；只读工具在链路级失败后自动补一次，**动作类绝不重试**（防重复点击 / 重复输入）；连续 5 次失败熔断 30 秒；非 win32 给出明确诊断 |
| 原子写 | Windows 并发写聚合视图时 rename 的 EBUSY 加同步小退避 + 12 次重试，修掉冒烟测试偶发失败 |
| 测试 | 当时新增 34 条断言覆盖光标自愈 / 键盘 UI / 三个便捷工具 / 截图清理的安全边界 / 版本回退 / 只读重试 / 熔断 / 文档防漂移；离线 325 项、全量 335 项全通过。所有「注册了几套工具」的断言改为从 `tools.length` 派生，加工具不会再红 |

## 0.3.3 补齐的是「同步落地 + 零覆盖路径 + 可观测性」

这一版没有改定位算法，改的是「修了却没跑到」和「出问题时看不见」：

| 类别 | 之前 | 现在 |
|---|---|---|
| 安装同步 | 11-09 早上的像素点击 foreground 升级只留在源码目录，DSH 里仍跑旧版 | 源码与 `~/.dsh/plugins/dsh-computer-use-pro` 对齐；安装副本与 `node_modules` 副本是硬链接，同步一处即可，**仍须完全重启 DSH** |
| 像素点击 | background 合成事件点不动原生 Win32 菜单项（Chrome「打开新的标签页」实测：菜单不关、命令不执行） | 复核判定没生效后自动改用 foreground 真鼠标事件重点一次；已生效绝不重投（toggle 不会被点回去）；`window_minimized` 恢复窗口那次重投已用过 foreground 时不再重复升级 |
| 驱动生命周期 | `spawn` **同步**抛错时 proc / stdio 无人回收，后续调用卡在「正在启动」 | 同步异常也走清理并转成 `SPAWN_FAILED`，`proc` / `ready` 清空可重试 |
| 技能正文 | appendix 硬编码 `~/.dsh/computer-use/shots`，改了 `screenshotDir` 后技能仍指旧路径 | 技能正文跟随配置的当前值，省略时回落默认 |
| 祖先链 | `element_index` / `parent_index` 类型混用（number vs string）会断掉整条祖先链 | 统一字符串键，`fmtState` 跨驱动版本稳定 |
| 探针 | `click-by` 自己实现一套「匹配 + background 点一下 + 比元素数」，结论常与宿主相反 | 直接复用 `lib/tools.js` 的 `cu_click`（settle / index / 三级阶梯 / 控件状态复核全在），新增 `--index` / `--delivery` / `--no-observe` |
| 可观测性 | 一次 `cu_click` 要 3~7 次 RPC + settle，没有任何耗时 / 错误统计 | `DriverBridge` 累计 calls / errors / timeouts / avg / max；`cu_doctor` 输出调用画像，并只读盘点截图目录的文件数与占用 |
| 配置 | `defaultDelivery` 写错、数值给 0 或超大值都静默透传给驱动 | 枚举回落 + 数值收敛到安全区间，非法值打 warn 留痕 |
| 测试 | `tool-kit.js` / `mcp-probe.mjs` 零覆盖，PNG 标记、空闲回收、工具主路径无断言；脚本顶层 await 抛错连合计都不打印 | 当时新增 46 条断言（离线 275 项 / 真机 285 项全通过）；补未捕获异常兜底、去掉 2 个恒真占位断言、把钉死 RPC 次数的断言改成语义契约 |

> 断言数随环境浮动：装没装驱动、有没有官方 Schemastery / dsh-tools、源码是否在 homedir 内，
> 都会改变个别条件分支的执行条数。上面的数字是本机 2026-11-09 的实测值。

## 0.3.2 修的是「复核误判与生命周期」

静态审查后又修掉一批现有断言没覆盖到的缺陷并补了回归断言
（当时全量 237 项 / 离线 227 项；没覆盖到的路径在 0.3.3 才补齐，见 `test/smoke.mjs`）：

| 类别 | 缺陷 | 现在的处理 |
|---|---|---|
| 复核误判 | `bring_to_front` 只要「没报错」就算恢复成功 | 以复核后的窗口表为准（在屏且未最小化），驱动自报只作辅助；误报会让后续 `window_minimized` 不再重投 |
| 复核误判 | 复核期间任意新窗口 / 窗口状态变化都被当成「点中了」 | 只认同 pid 的新窗口与目标窗口真的恢复在屏；无关通知弹窗不再提前停掉三级阶梯 |
| 像素点击 | 复核只看原窗口、窗口表只取一次样；用已失效的 token 认人 | 每次 settle 都重列全量窗口表，弹出的同进程窗口能看见；改用 index+role+rect 找回同一控件 |
| 像素点击 | 驱动回 `window_minimized` 时不恢复重投 | 与语义点击一致：恢复窗口后同参数重投一次 |
| 拒绝判定 | `window_minimized` 的拒绝被「复核有变化」翻案成有效 | 拒绝优先，不再谎称有效 |
| 坐标同源 | `cu_state` 不输出 `capture_id`、`cu_click` 也没法绑定 | `cu_state` 给出 capture_id；`cu_click` 新增 `captureId` 参数 |
| 截图 | 附件服务不回尺寸 → 图片块是 0×0；红圈重编码整图可能超限把图弄丢 | 用 PNG 真实宽高兜底；标记膨胀超 1.5 倍就不画，超限时退回原图再交一次 |
| 多实例 | 工具层被宿主清空但旧 owner 还活着时，轮询接管会造出双 primary | 先请仍存活的 owner 主动让位（拆 prompt/skill/工具），再由新实例接管 |
| 生命周期 | 宿主异常退出时驱动子进程变孤儿；`spawn` 失败时 stdio 句柄不回收 | 模块级进程退出兜底 + spawn error 统一走 stop() |
| 宿主兼容 | `skills.register` 载荷缺 `provider`（catalog 可见但加载必失败）；官方包版本残缺时 Config 构造抛错拖垮加载；CJS `default` 导出被误判降级 | 补齐字段、构造失败降级为无 schema、兼容 default 导出 |
| 配置 | 字符串 `"false"` 关不掉总开关；`%VAR%` / `~somebody` 路径处理不对；布尔字段口径不一致 | 统一 `asBool`；展开 `%VAR%`/`$VAR`，只展开 `~/` |
| 参数校验 | `cu_verify` 声称 1-8 条却什么脏谓词都转发；`cu_call` 把 `query` 当成 `listTools(force)` | 逐条校验 + 条数上限；新增 `refresh` 显式强拉，query 只做过滤 |
| 杂项 | `cu_key(observe:true)` 只给 pid 时静默跳过；`cu_windows` 带 query 会删掉空表提示；`cu_recover` 打出负数元素数；探针 200ms 强退截断输出 | 全部按「如实说明 / 保留提示 / 自然退出」修正 |

## 0.3.1 修的是「点不到」

真实现场（2026-11-08，Chrome 里的 X 时间线，模型连点 55 次没成）：

| 现象 | 真因 | 现在的处理 |
|---|---|---|
| 点了「喜欢」，界面一点没动 | **窗口被最小化了**：bounds `146x28@-31993,-32000` 是图标占位符。UIA 树照常能读、`invoke` 也能生效，但 `foreground` / 像素点击全落到占位符上，**静默无效** | `cu_click` 动手前先 `bring_to_front` 恢复（并说明原本是什么状态）；驱动亲口回 `window_minimized` 时恢复窗口再用新 token 重投一次。`cu_state` 也会拿 bounds 直接警告 |
| 明明点成功了，工具说「很可能没生效」，然后模型再点一次，结果又变回去了 | 复核只比**元素数**。点「喜欢」时元素数一个不变，变的只是那个按钮的标签（`945 喜欢次数。喜欢` → `948 喜欢次数。喜欢了`）→ 判失败 → 按阶梯重投 → toggle 被点回去 | 复核改成**三样一起看**：元素数 + 整树指纹（role/label/value/selected）+ 目标控件自身；任一变即算生效，不再重投。另外加 settle（0/220/380ms 各读一次），因为客户端渲染不是瞬时的 |
| 「转帖」有 7 个，点谁？ | 同名控件没有选择手段，模型只能自己编 `index`（`cu_click` 没有这个参数，静默被忽略 → 永远点第一个） | 新增 `index`（0 起）；命中多个时输出**带序号的候选表**（角色/标签/坐标/token），越界明确报错 |
| 点文本框（`Edit`/`Document` 这类）说「很可能没生效，别在原路径上重试」，之后 `cu_key` 输入却是好的 | 文本输入类点一下**只是获得焦点**：label/value/selected 全不动 → 复核必然是「没变化」，被误判成失败 | 先判「这个元素有没有可比对的状态」：没有就如实说「已发送点击，但无可比对状态，不能据此判定失败」，不阻止重试；同时不再做 foreground/expand 升级重投，settle 只取一次样（省 2 次读树 + ~600ms） |

顺带修掉的：

- 复核的「目标控件」认人不再只看 `element_index`（菜单展开会在前面插节点，index 6 从「文件(F)」变成「打印(P)」，diff 出一条假变化）：改为「同 index + 同角色 + 同矩形」→「标签命中」→「同 index + 同角色 + 同尺寸（标签变了也算同一个）」。
- `resolveTarget` 按标题找窗口时，`on_screen_only` 会把最小化窗口整个筛掉 → 现在回落到全量窗口表，并说明「该窗口当前最小化」。
- 拒绝类的文案不再一律甩「该元素没有 Invoke 通道」：`window_minimized` 单独给原因和修法。
- 阶梯结束语改成「已试过：background invoke → foreground invoke → foreground expand」，不再谎称「三级都试过了」。

## 0.3.0 修的是「模型老想很久，然后还是不行」

四个根因，按影响排序：

1. **观察太吵**：一次 `cu_state` 吐 14.3KB —— 4 个状态栏文字、2 条滚动条的 4 个按钮、
   每行还带 `actions=[...]`、窗口内坐标、`[idx]` 前缀。模型每轮都要啃一遍，注意力全花在噪声上。
   现在默认视图只留**可点元素 + 输入框 + 祖先链**，同层同角色 > 9 个自动折叠（会话列表那种），
   同一棵树 **14.3KB → 4.9KB**；带 `query` 时 **1.6KB**（139 → 26 行投影）。
2. **点错了通道**：`actions=[invoke,expand]` 的菜单项，`invoke` 是**静默空点**（PostMessage 到元素坐标，
   菜单不开也不报错）；`action:"expand"` 又要求窗口在前台，background 下必回 `0x80040200`。
   现在按元素 actions 挑动作，并按「复核没变化」自动爬三级阶梯
   （background → foreground → expand），每级都用最新快照的 token 重取元素。
3. **结果不可判**：点了菜单，树长在**另一个窗口**里，旧逻辑只重读原窗口 → 元素数不变 → 模型以为失败 →
   来回重试（这就是「想很久」）。现在复核同时对比窗口表，新窗口直接点名 pid/windowId。
   另外驱动在 ExpandCollapse 上会**误报** `0x80040200`（动作其实成功了），现在一律以复核为准。
4. **往返太多**：以前每次都要先 `cu_windows`。现在 `cu_state` / `cu_click` / `cu_key` / `cu_verify` /
   `cu_recover` 都能直接吃 `title:"<标题子串>"`，内部解析；`cu_click` 成功后还附一份迷你快照，
   可以直接接着点，省掉一次 `cu_state`。

顺带修掉的自己的坑（写在这里免得再踩）：

- `max_elements: 0` 不是「不限制」，而是「只走 1 个节点」→ 整棵树读成空。
  插件的 `readState` 现在用 `posInt(x) || 默认值`，不再把 0 透给驱动。
- 带 `query` 时 `element_count` 仍是整棵树的总数，`returned_element_count` 才是投影行数。
  拿前者当「读到了没有」的判据，会把「投影没命中」误判成成功，settle 也永远不会重读。
- `elements_complete` 在本版驱动恒 `false`，显示它只会让模型以为树没读全，已不再输出。

## 依赖

- Windows（驱动只有 win32 payload）
- 本机装过 MiniMax Code 的**电脑操控组件**：
  `~/.minimax/computer-use/components/<版本>/win32-x64/<sha>/minimax-computer-use.exe`
  找不到就装组件，或在插件设置里把 `driverPath` 指到 exe / 目录。
- 不需要任何 npm 依赖（`@deepseek-ai/*` 一律韧性加载，解析不到就走本地等价实现）。

## 工具

| 工具 | 用途 |
|---|---|
| `cu_doctor` | 链路体检：驱动路径/版本、MCP 握手、原生工具数、屏幕、可见窗口数；附累计调用画像（次数/失败/超时/平均与最慢耗时）和截图目录的**只读**占用盘点 |
| `cu_windows` | 列顶层窗口（默认隐藏驱动自己的光标覆盖层），拿 `pid` + `windowId` |
| `cu_window_info` | `debug_window_info`：`class_name` 是 `CoreWindow`（非渲染面）还是 `ApplicationFrameWindow`（真外壳） |
| `cu_state` | 读 UIA 语义树，行末是 `element_token`；**自带 settle**；默认只列可点元素 + 祖先链（`mode:"full"` 看全量）；支持 `query` 投影与 `title` 定位；窗口最小化/离屏时直接警告（这种状态下点击必空）；`screenshot:true` 时输出 `capture_id`，可传给 `cu_click` 的 `captureId` 绑定同一张画面 |
| `cu_click` | 语义点击：label(+role) → token → 自动挑动作 → 三级升级（background → foreground → expand）→ 复核**元素数 + 目标控件状态 + 窗口状态**；同名多个用 `index` 选；最小化窗口先 `bring_to_front`；生效时附迷你快照 |
| `cu_key` | 键盘：单键 / 组合键 / 输入文本，**默认 foreground**（Chromium 拒收 background 键盘）；可传 `observe:true` 顺手复核 |
| `cu_recover` | **一键走完诊断阶梯**：重读 → 换同名兄弟窗口 → 按 AUMID 重拉，成功时给可用的 pid/windowId |
| `cu_verify` | window 级谓词验证（element 级在 0.34.1 恒 unknown，见下） |
| `cu_scroll` | 滚动窗口：`direction` / `amount` / `by`，可直接传 `title`（不必再拼 `cu_call`） |
| `cu_drag` | 按住拖动：`fromX/fromY → toX/toY`（窗口局部截图像素，与截图同源） |
| `cu_clipboard` | 读写系统剪贴板；`read` 默认只列类型，`includeText:true` 才返回明文 |
| `cu_cursor` | 鼠标 / 键盘覆盖层诊断与控制：`status` / `show`（自愈）/ `hide` / `place`；**「光标老是不见」先跑它** |
| `cu_call` | 转发驱动原生 59 工具；不传 `tool` 就是列清单（`query` 过滤；`refresh:true` 才强拉缓存） |

## 实测要点（驱动 0.34.1，2026-11-08）

- `tools/list` = **59** 个原生工具。
- WorkBuddy（Electron）：`element_count=136`、`nodes_visited=148`、`truncated=false`、`walk=1ms`。
- Windows 设置：`SystemSettings.exe` 的 `Windows.UI.Core.CoreWindow` 树恒空（非渲染面）；
  陈旧实例下 `ApplicationFrameWindow` 也会是 0 元素 → 按 AUMID 重新拉起可恢复（实测 0 → 50 元素）。
- `verify_state` 的 **element 级谓词恒 `unknown` + `untrusted_source`**（`observed_json` 里
  明明有 `matches`），window 级谓词（`exists` / `bounds`）可正常 `satisfied`/`unsatisfied`。
- 对 `Chrome_WidgetWin_1` 做 `press_key`/`type_text` 时 `background` 会被拒，按提示改
  `delivery_mode:"foreground"`；元素点击仍可 `background`。
- **懒发布是连续的**：DSH 窗口 3 → 137 → 148 → 155 → 171，首读永远不能当结论。
- **菜单项的动作通道**（Win11 记事本，驱动 0.34.1）：`MenuItem` 同时暴露 `invoke,expand`，
  但 `invoke` 是**静默空点**（PostMessage 到元素坐标，菜单不开、元素数不变、也不报错）；
  `action:"expand"` 在 `background` 下回 `tool_invocation_failed / 0x80040200` 且真的不生效，
  换 `foreground` 才生效 —— 但**仍然回 0x80040200**。错误的码 + 成功的动作，
  所以判定只能看复核（元素数 11 → 20），不能看 `isError`。
- **菜单长在哪不固定**：Win11 记事本的菜单项长在**自身树**里（11 → 20）；
  经典 Win32 下拉菜单/右键菜单/模态框是**独立 popup 窗口**。复核要同时比元素数与窗口表。
- **陈旧 UWP 实例**：Windows「设置」两个 pid（`SystemSettings.exe` / `ApplicationFrameHost.exe`）
  同时读 0 元素、重读两次仍 0；按 AUMID 重拉后同一窗口 **0 → 50 元素**。
  可用的拉起方式：`aumid: <bundle_id>!<真实AppId>` 或 `name: "设置"`；
  `bundle_id: "…!App"` 与 `launch_path: "shell:appsFolder\…!App"` 都失败。`cu_recover` 会按顺序试。
- **最小化窗口**：`list_windows(on_screen_only:true)` 会把它整条筛掉（只剩 3 个可见窗口时
  实际有 7 个），`bounds` 是 `146x28@-31993,-32000`；UIA 树照读（记事本 11 个元素）、
  `invoke`/`expand` 照生效，但 **foreground / 像素点击投到占位符上，静默无效**
  （`effect=unverifiable` + 元素数不变）。`bring_to_front` 返回 `{restored:true, raised:true}` 后一切正常。
- **toggle 类控件的复核**：X 的「喜欢」按钮 `actions=[invoke]`，点成功后元素数 **不变**，
  只有标签和计数变（`945 → 948`、`喜欢 → 喜欢了`，约 100ms 后刷新）。
  只比元素数就会判失败并重投，把点赞点回去 —— 复核必须比控件自身状态。
- **同名控件是常态**：X 时间线一屏 7 个「N 次转帖。转帖」，`query:"转帖。转帖"` 还会 0 命中
  （驱动侧 query 不做全串匹配），只能靠 `role` / `index` 收窄。

完整证据与复现方法：`skills/computer-use-pro/references/grounding-evidence.md`。

## 安装

源码在 `~/Desktop/plugins/dsh-computer-use-pro`，按本机既有流程：

```bash
cd ~/WorkBuddy/2026-10-17-23-29-21
python install_one.py dsh-computer-use-pro          # 复制 + 写 profile deps/bundles

cd ~/.dsh/profiles/desktop
"<DSH>/resources/runtime/primary-runtime/dependencies/node/bin/node.exe" \
  "<DSH>/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs" install
```

然后**完全退出并重启 DeepSeek Harness**。重启后：

```bash
cat ~/.dsh/computer-use-pro-status.json          # 聚合视图：当前实例 + 所有实例（instances[]）
cat ~/.dsh/computer-use-pro-status/instances/*.json  # 每个实例独占一份，互不覆盖
```

## 多实例 / 多 profile

宿主里同时存在多份本插件（同一 profile 重复启用、多个 dsh 进程、多个 profile 各装一份）时：

- **不同进程 / 不同 profile**：各用各的驱动子进程，互不阻塞；状态文件按实例隔离，
  `~/.dsh/computer-use-pro-status.json` 只是「扫描 instances 目录得到的聚合视图」，
  后加载的实例不会覆盖前一个的诊断。
- **同一宿主里两份副本**：`cu_*` 是全局工具名，只能有一套。先注册的实例为 `primary`，
  后加载的实例检测到同名注册失败后**回滚自己已注册的部分并降级为 `standby`**，
  在状态文件里写 `role: "standby"` + 冲突原因，并在宿主日志打出可读警告；
  前一个实例卸载/停用后，待命的那个会自动接管（不必重启）。
- 没有任何「静默失败」路径：注册失败、降级、接管都会落到状态文件或日志。

## 不用宿主也能验

```bash
node scripts/mcp-probe.mjs doctor
node scripts/mcp-probe.mjs list [--query=文本]
node scripts/mcp-probe.mjs describe <tool>
node scripts/mcp-probe.mjs windows [--all]
node scripts/mcp-probe.mjs info <pid>
node scripts/mcp-probe.mjs state <pid> <windowId> [--query=文本] [--shot=文件名]
node scripts/mcp-probe.mjs verify <pid> <windowId> '{"window":{"exists":true}}'
node scripts/mcp-probe.mjs click-by <pid> <windowId> "系统" --role=ListItem --index=0 --delivery=foreground --dry
node scripts/mcp-probe.mjs call launch_app -        # 参数走 stdin（PowerShell 5.1 安全）
```

`click-by` 复用插件的 `cu_click`，所以终端里看到的定位、三级阶梯、复核判定与模型在对话里
看到的是同一套；`--no-observe` 可关掉点击后复核。

## 配置（DSH 设置 → 插件 → computer-use-pro）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（volatile，改完即时生效；工具常驻但拒绝执行） |
| `driverPath` | `''` | 驱动 exe 或目录；空 = 自动扫组件目录 |
| `promptSection` | `true` | 往系统提示注入工具路由 |
| `defaultDelivery` | `background` | 点击投递方式，`background` 不抢前台 |
| `maxElements` | `400` | 一次走查元素上限 |
| `maxChars` | `8000` | 元素清单输出预算 |
| `idleShutdownMs` | `120000` | 驱动子进程空闲回收 |
| `announceOnLoad` | `false` | 加载时打印一条就绪日志（patch 里默认开） |
| `screenshotDir` | `~/.dsh/computer-use/shots` | 截图落盘目录（技能正文也会跟随这个值） |
| `keyboardOverlay` | `true` | `cu_key` 时自愈覆盖层并输出 `⌨` 动作行与视觉状态 |
| `keyboardOverlayWindow` | `true` | 自绘置顶按键浮窗（Windows / PowerShell）；关掉则只有文字反馈 |
| `overlayDurationMs` | `1400` | 浮窗显示时长 |
| `overlayIdleShutdownMs` | `60000` | 浮窗进程空闲回收（`0` = 不回收） |
| `overlayTheme` | `dark` | 浮窗主题：`dark` / `light` / `accent` |
| `overlayFontSize` | `15` | 键帽字号（10-32） |
| `overlayOpacityPct` | `93` | 不透明度百分比（40-100） |
| `overlayPosition` | `auto` | `auto` / `fixed`（记住首次位置）/ `center` / `top` / `bottom` |
| `overlayFadeMs` | `140` | 淡入 / 淡出时长 |
| `targetCacheMs` | `1500` | 按 `title` 解析窗口的缓存时长（`0` = 不缓存） |
| `observeProfile` | `balanced` | 复核取样档位：`fast` / `balanced` / `thorough` |
| `screenshotMaxFiles` | `0` | 截图最多保留几张；`0` = 不清理（只清理本插件生成的 PNG） |
| `screenshotMaxAgeDays` | `0` | 截图最多保留几天；`0` = 不清理 |

配置在 `apply()` 里统一归一化并留痕：

- `enabled` / `promptSection` / `announceOnLoad` 接受 `true/false/1/0/on/off/yes/no` 等写法（字符串 `"false"` 也能关掉总开关）。
- `defaultDelivery` 只接受 `background` / `foreground`，其它值回落到 `background` 并打 warn。
- 数值项收敛到安全区间：`defaultTimeoutMs` / `stateTimeoutMs` 1000–600000、`maxElements` 1–5000、
  `maxChars` 200–100000、`idleShutdownMs` 0–3600000（0 = 不回收）。
  这条主要防 `max_elements:0` 那种「配置写错 → 整棵树读成空」的静默故障。

## 已知限制

- **只有 Windows**：驱动只发 win32 payload，darwin/linux 分支只是占位扫描。
- **元素级谓词验证不可用**（0.34.1）：要确认控件出现，重读 `cu_state` 比 `cu_verify` 靠谱。
- **截图依赖宿主 attachments 服务**：有图片通道时截图作为 image content block 直接返回；通道缺席时只落盘给路径，并在输出里说明原因（不内联 base64）。
- **截图默认只盘点不清理**：每次 `cu_click` 会落一张带标记的 PNG。要自动清理需显式设置 `screenshotMaxFiles` / `screenshotMaxAgeDays`；开启后只删本插件命名的 PNG、每批最多 50 个，目录里其它文件一律不碰。
- **`max_elements:0` 与 `maxDepth` 都是陷阱**：前者只走 1 个节点，后者在 query 过滤前就截断。
- **`cua-perception` 扩展装不了**：需要签名 catalog，属上游托管项。

## 目录

```
lib/index.js     入口（inject=['tools']，Config，apply，系统提示节，多实例协调）
lib/status.js    按实例隔离的状态文件（原子写 + 旧路径聚合视图）
lib/driver.js    驱动发现 + 常驻 MCP stdio 客户端（握手/串行化/超时/回收）
lib/format.js    把驱动结构化结果压成模型会读的文本（token 摆在每行）
lib/tools.js     13 个 cu_* 工具 + 系统提示节的共享工具清单 / 规则
lib/overlay.js   桌面按键浮窗（PowerShell -EncodedCommand 自绘 WinForms，stdin 协议）
lib/skill.js     技能注册（register 优先，registerProvider 兜底）
lib/tool-kit.js  韧性 defineTool（官方包解析不到时用同 DSL 的本地实现）
lib/schema-kit.js 韧性 Schemastery（同上，拿不到就返回 undefined）
skills/          技能正文 + 实测证据
scripts/         独立命令行探针
test/smoke.mjs   366 项离线断言 + 真实驱动只读实测（共 376 项，随环境浮动）
```
