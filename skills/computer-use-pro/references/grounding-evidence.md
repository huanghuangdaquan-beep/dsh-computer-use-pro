# 电脑操控定位能力 · 实测证据

采集时间：2026-10-27 18:13–18:20（原始）+ 2026-11-08 DSH 侧复测（GMT+8）
主机：Windows 10 19045 x64，1600×900，scale 1.0
原生驱动：cua-driver 0.34.1（`~/.minimax/computer-use/components/0.34.1/win32-x64/42dd5ca4…/`）

## 结论一句话

**电脑操控并没有「看屏幕猜位置」。** 主路径是 Windows UI Automation 的语义树，带真实
`element_token`、角色名、值和 enabled/selected 状态。**但存在三个会让语义路径被误判为
「不可用」的缺陷**，一旦误判，表现形式就退化成看截图点坐标 —— 也就是用户感受到的「猜位置」。

## 一、语义路径确实可用（不是猜）

| 目标 | 类型 | `elements` | 证据形态 |
|---|---|---|---|
| Program Manager（explorer.exe） | 原生 Win32 | **74** | `Button "开始"`、`TabItem "主页"`、`ListItem "回收站"`，全部带 `element_token="s00000002:N"` |
| MiniMax Code（Electron） | Chromium | **357** | `Button "插件·技能"`、`Button "定时"`、`Text "娟nb"` |
| WorkBuddy（Electron，pid 3108） | Chromium | **136** | `Document "WorkBuddy"`、`MenuItem "编辑(E)"`，见第十节 |

窗口标题、控件名字、层级关系都是**读出来的**，不是从像素里认出来的。可访问性角色
（Button / TabItem / Text / Edit / ListItem）与 AX 状态（`ax_enabled`、`ax_selected`、`ax_value`）
都直接可用。

## 二、缺陷 1：Electron 首次走查只回 3 个元素

同一个窗口，前后两次观察：

| 次序 | `elements` | 内容 |
|---|---|---|
| 第一次 | **3** | 只有窗口框与标题栏按钮 |
| 第二次（同窗口，隔 2 分钟） | **357** | 完整树，含会话列表、文件树、输入框等全部控件 |

这正是驱动文档里写的 `ax_tree_empty: ... Chromium/Electron require a UIA-enable + settle`。

**危害**：第一次读到 3 个元素就下结论「没有语义目标」，后续只能靠截图坐标点击 —— 这就是
「看屏幕猜位置」的真实成因。

**修复**：判定树为空之前，必须对同一窗口重读一次。

## 三、缺陷 2：同名兄弟窗口 + 选到非渲染面

Windows 设置界面的顶层窗口有两个：

| pid | 进程 | `class_name` | 标题 |
|---|---|---|---|
| 13232 | `SystemSettings.exe` | `Windows.UI.Core.CoreWindow` | 设置 |
| 4196 | `ApplicationFrameHost.exe` | `ApplicationFrameWindow` | 设置 |

`SystemSettings.exe` 的那个是 **XAML core window —— 不是可见外壳**；真正渲染界面的是
`ApplicationFrameHost.exe` 的 `ApplicationFrameWindow`。两者标题相同、尺寸几乎相同，
按标题或按尺寸选窗都会踩坑。

`debug_window_info` 给出的判定字段：

```json
{ "exe_xaml_match": true, "xaml_routing_recommended": true,
  "windows": [{ "class_name": "Windows.UI.Core.CoreWindow", "hwnd": 263452 }],
  "focused_element": { "class_name": "Chrome_RenderWidgetHostHWND", "control_type_id": 50030 } }
```

## 四、缺陷 3：陈旧实例 —— 界面没渲染，树自然为空

初测时 `SystemSettings.exe` 窗口 `is_on_screen=true`、`minimized=false`，但按其 bounds 抓取
屏幕区域，得到的是**桌面壁纸** —— 界面根本没有渲染，UIA 树同样为空。

**关键验证**：按 AUMID 重新拉起该应用后 ——

| 阶段 | UIA 树 | 渲染 |
|---|---|---|
| 陈旧实例 | **0** 元素 | 区域是桌面壁纸 |
| `launch_app` 重新拉起后 | **50** 元素 | Windows 设置首页完整渲染 |

50 个元素里包括 `ListItem "系统"`、`ListItem "设备"`、`ListItem "网络和 Internet"`、
`ListItem "个性化"`、`Edit "搜索框，查找设置"`、TitleBar 的最小化/还原/关闭。

**结论**：XAML/UWP 应用空树的首要成因是**实例陈旧/被挂起**，不是「界面不透明」。
**空树优先按「实例陈旧」处理，先重新拉起，别急着退化成像素点击。**

## 五、驱动原生 MCP 面（59 个工具）

驱动在 Windows 上提供 **MCP stdio server（direct runtime）**，不经过被安全策略拦下的命名管道。
`mcp` 子命令即可拉起，`tools/list` 返回 59 个工具（本机 2026-11-08 复测确认）。

| 工具 | 价值 |
|---|---|
| `debug_window_info` | 窗口类名、XAML 路由建议 → 判断幽灵窗口/陈旧实例最快的一手证据 |
| `get_window_state` | 全参数：`max_elements`/`max_depth`/`query`/`timeout_ms`/`screenshot_out_file` |
| `structuredContent` 诊断字段 | `element_count`/`total_element_count`/`nodes_pending`/`nodes_visited`/`truncated`/`truncation_reason`/`snapshot_id`/`walk_elapsed_ms` |
| `zoom` | 区域原生分辨率放大 |
| `health_report` | 端到端自检 |
| `parse_visual_regions` | 截图结构化解析（需 `cua-perception` 扩展，本机未安装） |
| `launch_app` | 支持 AUMID 精确启动（重拉起陈旧实例的关键） |

`health_report` 结论全绿：

```
✅ binary_version: cua-driver 0.34.1
✅ platform_supported: Windows [Version 10.0.19045.6456] (x86_64)
✅ ax_capability: UIAutomation is reachable; UI tree walking will succeed.
✅ screen_capture_capability: D3D11 device reachable; Windows Graphics Capture will succeed.
```

### 「元素数偏少」不等于「元素不存在」

走查有节点预算与墙钟预算，被截断时输出带明确告警：

```
⚠️ PARTIAL TREE: the max_elements node budget ran out after 50 node(s)
   (44 discovered but not visited). Every element listed is real; elements after
   the cut are missing.
```

超时扫描（MiniMax Code 窗口，原始 `get_window_state`）：

| timeout_ms | total | returned | pending | visited | truncated | walk_ms |
|---|---|---|---|---|---|---|
| 30 … 5000 | 201 | 201 | 0 | 301 | False | 2 |

热树走查只花 **2ms** 且不截断 —— 所以「3 → 357」不是超时造成的，而是 Chromium 渲染进程
尚未发布可访问性树（`UIA-enable + settle`）。

## 六、语义点击闭环验证

原生 `click` 的 `element_token` 模式走 UIA Invoke，不移动光标、不抢焦点：

```
1) get_window_state(pid=4504, window_id=393664)
   → ListItem "系统"  token=s00000001:11  enabled=true  actions=[invoke]
2) click(pid=4504, element_token=s00000001:11, delivery_mode=background)
   → route=accessibility  delivery=background  effect=unverifiable
   → summary="✅ Performed UIA Invoke on [11] (screen (260,246))."
3) 复核 get_window_state → 元素 50 → 84，新出现：
   ComboBox "显示器分辨率" (id=SystemSettings_Display_Resolution_ComboBox)
   ComboBox "显示方向"     (id=SystemSettings_Display_Orientation_ComboBox)
4) 截图比对 → 设置 › 系统 › 屏幕 页，逐项吻合
```

`effect` 取值：`confirmed` / `partial` / `unverifiable` / `suspected_noop` / `refused`。
`unverifiable` 表示驱动没有独立证据，**必须**重读树复核，不能当作成功。

## 七、验证接口的冷调用陷阱

`verify_state` 在没有任何先验观察时，对语义谓词返回：

```
{"index":0,"status":"unknown","unknown_reason":"untrusted_source"}
```

`untrusted_source` 指的是**没有已登记的捕获源**，不是谓词不成立。
正确顺序：先 `get_window_state` 观察 → 再 `verify_state` 验证。

## 八、驱动与组件版本状态

| 项 | 状态 |
|---|---|
| 已安装组件 vs `component.json` | 11/11 文件哈希**完全一致** |
| 已安装组件 vs 宿主内置 payload | 5/5 关键二进制哈希**完全一致** |
| `check-update` | `update_available: false`，`error: updates are managed by the MiniMax component installer` |
| `doctor --json` | `ok: true`；UI Automation 探针 `CoCreateInstance(CUIAutomation) succeeded` |
| `extension status` | `cua-perception` **not installed**；安装需 `--catalog <signed-catalog.json>`，本机没有 |

**原生驱动没有过期，版本与宿主一致，无需更新。**

## 九、其他已记录的告警

- **最小化 / 离屏不是空树的原因**：最小化的 Chrome 仍返回 **31 个元素**、`visited=66`、
  `truncated=false`、`walk_ms=0`。所以「窗口不在屏上」不等于「读不到元素」。
- `SetWindowDisplayAffinity` 失败告警（0x80070008）意味着桌面截图可能混入 agent 光标覆盖层。
- `status` / `config` 子命令默认连 `\\.\pipe\minimax-computer-use`，而宿主拉起的守护进程用带
  随机后缀的管道，所以它们会报 "daemon is not running" —— **寻址口径问题，不是进程没起**。
  绕过办法就是 MCP stdio 桥（`mcp` 子命令在 Windows 上是 direct runtime，不需要命名管道）。

## 十、DSH 侧复测（2026-11-08）

环境：DeepSeek Harness desktop profile，驱动 0.34.1，插件 `dsh-computer-use-pro` 走常驻
MCP stdio 子进程。

| 观察项 | 结果 |
|---|---|
| `tools/list` | **59** 个原生工具 |
| `list_windows(on_screen_only)` | 6 个窗口 / 6 个进程，含驱动自身的光标覆盖层 `Cua.AgentCursorOverlay.default`（`minimax-computer-use.exe`）→ 插件默认把它过滤掉 |
| WorkBuddy（Electron, pid 3108） | `element_count=136`、`total_element_count=136`、`nodes_visited=148`、`truncated=false`、`walk_elapsed_ms=1`、`snapshot_id=s00000001` |
| 设置 · `SystemSettings.exe`（pid 13232，`Windows.UI.Core.CoreWindow`） | **0** 元素，`degraded=true`、`degraded_reason=ax_tree_empty…`、`escalation.recommended=px`、`nodes_visited=1` |
| 设置 · `ApplicationFrameHost.exe`（pid 4196，`ApplicationFrameWindow`） | 同一时刻也是 **0** 元素（该实例处于陈旧/未渲染状态）→ 本条正是「空树优先按实例陈旧处理」的现场证据 |

**读法**：`degraded=true` + `escalation.recommended=px` 是驱动在说「我要退化成像素了」，
但**那不是让你直接点坐标**，而是诊断阶梯的入口：重读 → 换兄弟窗口 → 重新拉起。
WorkBuddy 那行（136 元素、walk 1ms、未截断）说明同一时刻语义通道本身完全健康。

`element_token` 形态：`s00000001:N`（快照号 + 元素序号）。`get_window_state` 的
`tree_markdown` 里只有 `id=<数字>`，那是渲染用的序号，**不是** token —— 要点击必须从
`structuredContent.elements[].element_token` 取。`cu_state` 的输出已经把 token 摆在每行里。

### 谓词验证的真实可用性（0.34.1）

同一窗口（WorkBuddy pid 3108 / window 132326），同一 bridge 会话内先 `get_window_state`
再 `verify_state`，逐条实测：

| expect | 返回 |
|---|---|
| `[{"window":{"exists":true}}]` | `satisfied` · `stable=true` · 205–207ms |
| `[{"window":{"bounds":{"x":476,"y":111,"width":800,"height":600,"tolerance_px":8}}}]` | `satisfied` |
| `[{"window":{"bounds":{"x":0,"y":0,"width":100,"height":100,"tolerance_px":2}}}]` | `unsatisfied`（3s 采样 21 次） |
| `[{"element":{"selector":{"label_contains":"编辑"},"exists":true}}]` | `unknown` · `unknown_reason=untrusted_source` · `observed_json={"matches":2}` |
| `[{"element":{"selector":{"role":"MenuItem","label_contains":"编辑"},"exists":true}}]` | 同上，`matches:1` |

结论：**element 级谓词在该版本恒为 `untrusted_source`**（`observed_json` 明明算出了匹配数），
哪怕刚观察过同一窗口。所以「验证某个控件出现了」只能靠重读 `get_window_state` 比对，
不能靠 element 谓词。另外 `window.bounds` 必须**四个字段给全**，缺一个就回
`{"code":"invalid_arguments","detail":"missing field \`x\`"}`。

### 键盘事件的投递限制

对 `Chrome_WidgetWin_1`（Electron/Chrome）做 `press_key` / `type_text`，`background` 会被拒：

```
Background delivery is not available for target window class 'Chrome_WidgetWin_1'
on this event kind (keystroke). Retry this action with delivery_mode:"foreground";
Cua Driver will activate the target for the action and restore the previous foreground afterward.
```

这是**事件类型 × 窗口类的限制**，不是权限问题。同一窗口的**元素点击**仍可用 `background`。

## 十一、0.2.0 修复对应的现场证据（2026-11-08 复测）

### 1. 懒发布是连续的，不是「3 和 357 两档」

DSH 主窗口（Electron，pid 6196）：首读 3 个（只有标题栏按钮）→ 137 → 148 → 155 → 171，
每次观察都在涨。所以判定标准不是「够不够 3 个」，而是**首读的小数字永远不能当结论**。
`cu_state` 的 settle（< 8 个或 degraded 就重读，最多 3 次）就是按这个行为设计的。

### 2. 陈旧 UWP 实例：两个 pid 都读 0，重拉即恢复

| 阶段 | `SystemSettings.exe`<br>pid 13232 / wid 197142<br>class=`Windows.UI.Core.CoreWindow` | `ApplicationFrameHost.exe`<br>pid 4196 / wid 197122<br>class=`ApplicationFrameWindow` |
|---|---|---|
| 修复前 | **0** 元素（degraded=ax_tree_empty），重读 2 次仍 0 | **0** 元素（同样 degraded），重读 2 次仍 0 |
| `launch_app` 重拉后 | 窗口消失（幽灵进程随之退出） | **50** 元素：`MenuItem "系统"`、`Edit "搜索框，查找设置"`、`ListItem "系统"`、`Button "关闭 设置"` |

拉起方式与结果（同一现场实测）：

| 参数 | 结果 |
|---|---|
| `{ aumid: "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel" }` | ✅ 成功，pid 4196，树 0 → 50 |
| `{ name: "设置" }` | ✅ 成功（驱动按显示名在 shell:AppsFolder 里解析） |
| `{ bundle_id: "windows.immersivecontrolpanel_cw5n1h2txyewy!App" }` | ✗ `0x80270254 此应用不支持指定的合约或未安装该应用` |
| `{ launch_path: "shell:appsFolder\windows.immersivecontrolpanel_cw5n1h2txyewy!App" }` | ✗ `0x80070002 系统找不到指定的文件` |

`list_apps` 的 `launch_path` 里的 `!App` **不是** AUMID 的 AppId，原样回填给 `launch_app`
会失败 —— 这是 `cu_recover` 要按 `aumid → name → bundle_id!App → launch_path` 顺序试的原因。

### 3. 键盘：foreground 是唯一能落的方式

对 `Chrome_WidgetWin_1`（Electron/DSH）发 `press_key`，`background` 直接报
`Background delivery is not available for target window class 'Chrome_WidgetWin_1' on this
event kind (keystroke)`；改 `foreground` 后一次成功（Escape 收起菜单，元素数回落）。
`cu_key` 因此默认 `foreground`，并把「送达 ≠ 生效」写进返回。

### 4. effect=unverifiable 的真实案例

`cu_click` 点 DSH 菜单栏「编辑(E)」（`MenuItem`，`actions=[invoke,expand]`）：
返回 `effect=unverifiable`，但**同一次复核里元素数 137 → 155（+18）**，
且截图能直接看到菜单展开（「浏览更多插件」「创建你的插件」）。
说明 `unverifiable` 只表示「驱动没有独立证据」，不代表失败；元素数变化就是可用证据。

### 5. 点击为什么不生效：动作通道与投递方式的两道门（0.3.0 实测）

现场：Win11 记事本（`notepad.exe`，pid 8020 / window 722136），目标 `MenuItem "编辑(E)"`。
同一元素在不同时刻暴露的 `actions` 会变：

| 时刻 | `actions` | `click` 参数 | 驱动返回 | 元素数 |
|---|---|---|---|---|
| 菜单关闭 | `[invoke,expand]` | `{delivery_mode:"background"}`（默认 invoke） | `route=synthetic_events effect=unverifiable` | 11 → **11**（静默空点） |
| 菜单关闭 | `[invoke,expand]` | `{delivery_mode:"background", action:"expand"}` | `isError` `tool_invocation_failed: ExpandCollapse.Expand failed: 0x80040200` | 11 → **11** |
| 菜单关闭 | `[invoke,expand]` | `{delivery_mode:"foreground", action:"expand"}` | **同样报** `0x80040200` | 11 → **20** ✅ 菜单真的开了 |
| 菜单关闭 | `[invoke]` | `{delivery_mode:"foreground"}`（SendInput 点击元素坐标） | `route=global_input effect=unverifiable` | 11 → **20** ✅ |
| 菜单已开 | `[invoke]` | `{delivery_mode:"foreground"}` 同一元素 | 同上 | 20 → **11**（当开关用，点第二下会关掉） |

三条结论：

1. **`isError` 不能当结论**：`0x80040200`（`ExpandCollapse.Expand failed`）在动作**成功**时也会返回。
   判定只能看复核（元素数 / 窗口表 / 截图）。
2. **`background` 对 ExpandCollapse 无效**：同一调用换 `foreground` 才生效 —— 但错误码一模一样，
   所以「换投递方式重试」必须由**复核没变化**触发，不能靠错误码触发。
3. **菜单项长在自身树里也可能长在别处**：记事本的下拉菜单展开后仍是同一个 window（11 → 20，
   菜单项 `MenuItem "全选(A)\tCtrl+A"` 直接可选）；经典 Win32 下拉菜单/右键菜单是独立 popup
   窗口。所以复核要**同时**比元素数与 `list_windows`。

`cu_click` 现在的三级阶梯就是按这三条写的：background → foreground → 换 `action:"expand"`，
每级都从**最新快照**重新取 token（重读会让旧 token 进 `invalidated_snapshot_ids`）。

### 6. 参数为 0 的语义陷阱

- `get_window_state({max_elements: 0})` **不是**「不限制」，而是「只走 1 个节点」：
  实测返回 `element_count=0, nodes_visited=1, truncated=true, nodes_pending=5`，
  整棵树读成空的。插件里所有数值参数都走 `posInt(x) || 默认值`，不会把 0 透给驱动。
- 带 `query` 时 `element_count` 仍是**整棵树**的总数（139），只有 `returned_element_count`
  是投影行数（26）。拿前者当「读到了没有」的判据，settle 永远不会重读、空投影会被当成成功。
- 截图别单独发一次 `get_window_state(include_accessibility_tree:false)`：它会推进 snapshot，
  把刚打印给模型的 `element_token` 全部作废（返回里带 `invalidated_snapshot_ids`）。
  截图要和树**同一次调用**出来（`include_screenshot:false` + `screenshot_out_file` 可共存）。

### 7. 「点不到」的三个真实现场（2026-11-08，Chrome 里的 X，0.3.1）

复现素材：一次真实任务（OpenMausBot 的「X 点赞助手」用 minimax M3.1-Flash 驱动本插件刷时间线）
的完整会话记录 —— `cu_click` 被调用 **55 次**，任务仍然失败。

#### 7.1 窗口最小化：clicks 静默落空

会话里 `cu_windows` 读到的 Chrome 窗口长这样：

```
pid      window_id  app        标题                                             状态      尺寸
6332     197538     chrome.exe X 上的 Narfeyer：…                             off/min   146x21@-31993,-32000
```

| 动作 | 驱动返回 | 元素数 |
|---|---|---|
| `click(element_token, delivery_mode:"background")` | `route=global_input … effect=unverifiable` | 268 → 268 |
| `click(..., delivery_mode:"foreground")` | 同上 | 294 → 294 |
| `click` 一个 `TabItem` | `refused: window_minimized`（"Element [46] resolves to (672,169), which is the Win32 iconic sentinel"） | 293 → 293 |
| `bring_to_front {pid, window_id}` | `{restored:true, raised:true, landed_on_target:true}` | 窗口回到 `754x391@377,261` |

要点：**最小化不影响 UIA 读取，也不影响 `invoke`/`expand`**（同一会话里 `MenuItem "转帖"` 的
`invoke` 在最小化状态下照样把菜单开出来了，299 → 300），**只让 foreground / 像素点击失效**。
所以「树读得到、点了没反应」这个组合，第一嫌疑就是窗口被最小化。

`list_windows(on_screen_only:true)` 会把最小化窗口整条筛掉：同一时刻全量 7 个窗口、
在屏只有 3 个 —— 按 `title` 找窗口时找不到，别当成窗口已关闭。

#### 7.2 toggle 类控件：元素数不变的成功

X 的「喜欢」按钮（`Button "945 喜欢次数。喜欢"`，`actions=[invoke]`）：

| 时刻 | 标签 |
|---|---|
| 点击前 | `945 喜欢次数。喜欢` |
| 点击后（约 100ms） | `948 喜欢次数。喜欢了` |

元素数 **268 → 268（0）**。旧逻辑据此判「没生效」，按阶梯换 `foreground` 又点一次 ——
toggle 被点回去，界面上就是「点了没反应」。正确判据只能是**控件自身状态**：
标签、`value`、`selected` 任一变化都算生效。

同现场的「转帖」也验证了这一点：`Button "67 次转帖。转帖"` → `已转帖`，`element_count` 不变。

#### 7.3 同名控件：一屏 7 个「转帖」

`cu_state({query:"转帖"})` 回来的清单：

```
Button "66 次转帖。转帖"  ▾expand
Button "125 次转帖。转帖" ▾expand
Button "93 次转帖。转帖"  ▾expand
Button "11 次转帖。转帖"  ▾expand
Button "277 次转帖。转帖" ▾expand
Button "2 次转帖。转帖"   ▾expand
Button "19 次转帖。转帖"  ▾expand
```

- 纯标签 `"转帖"` 会命中 7 个 → 旧版只能取第一个（很可能不是要看的那条）。
- 会话里模型自己传了 `index:"0"` / `index:"1"`（旧 schema 没这个参数，**静默忽略**），
  于是它在「点错推文」和「找不到目标」之间来回。
- 还有个小坑：`query:"转帖。转帖"` 会 **0 命中**（整棵树 296 元素），而 `query:"次转帖"` 正常 ——
  驱动侧 query 不做整串包含匹配，带标点的长串别指望它。

结论：`cu_click` 必须提供**序号选择**并**列出候选表**，否则「点不到」变成「点错」。
