# dsh-godot：让智能体直接开发与调试 Godot 游戏

一个 DeepSeek Harness 插件包（Host 插件，零依赖），给 agent 六个 `godot_*` 工具，
把「建工程 → 写/改 GDScript → 真引擎校验 → 运行 → 读错误 → 操作正在运行的游戏」
串成闭环。

- 产物：`godot-agent/`（可安装 bundle，`@local/dsh-godot` 1.0.0）
- 安装状态：**已安装到 `desktop` profile**，以 link 方式指向本工作区，`application: applied`
- 生效状态：本会话模型工具表中已出现 6 个 `godot_*` 工具（下面「真实会话实录」就是在本会话里跑出来的）
- 引擎：本机 Godot `4.7.2.stable.official`（console 构建，自动发现）

---

## 1. 六个工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `godot_status` | 引擎路径/版本、项目根、默认超时、当前所有活动会话 | 无 |
| `godot_project_init` | 在空目录生成可运行 Godot 4 工程（project.godot / 主场景 / 主脚本 / 桥接 autoload），并跑一次 import | `directory`、`name`、`template`、`import` |
| `godot_check` | 用真引擎校验：可选 import + 对每个脚本 `--check-only --script`，返回带 `res://文件:行号` 的结构化诊断 | `project`、`scripts`、`import` |
| `godot_run` | 运行整个工程 / 单个场景 / 单个脚本；headless 或窗口；捕获输出并解析错误；可常驻会话 | `project`、`mode`、`scene`/`script`、`args`、`headless`、`timeoutMs`、`keepAlive`、`bridge` |
| `godot_bridge` | 对运行中的游戏发一条桥接命令并拿回 JSON 结果 | `session`、`command`、`args` |
| `godot_stop` | 结束会话并清理进程（不带 session 则全停） | `session` |

`godot_bridge` 支持：`ping`、`tree`、`node`、`node_set`、`node_call`、`action`、
`frames`、`screenshot`、`quit`。

工作流示例：

```
godot_status
godot_project_init {directory: ".../my-game", name: "My Game"}
（用 write/edit 写 main.gd、main.tscn …）
godot_check {project: ".../my-game"}                    # 有错按 res:// 行号改
godot_run {project: ".../my-game", headless: true, keepAlive: true, bridge: true}
godot_bridge {session: "g1", command: "node_call", args: {path: "/root/Main", method: "debug_state"}}
godot_bridge {session: "g1", command: "action",   args: {action: "ui_right", pressed: true}}
godot_bridge {session: "g1", command: "screenshot"}     # 窗口模式才有图
godot_stop {session: "g1"}
```

## 2. 真实会话实录（全部发生在本会话，非模拟）

1. `godot_status` → `Godot 4.7.2.stable.official.ed1daf0bf (console build)`，无会话。
2. `godot_project_init` → 在 `live-demo/` 生成 4 个文件，`import: ok (exit 0)`。
3. 用 write 覆盖成自写小游戏 `Star Catcher`（玩家、下落星星、分数、桥接调试方法）。
4. 故意把 `clampf` 写成 `clampff` → `godot_check` 返回
   `error: res://main.gd:26: Parse Error: Function "clampff()" not found in base self.`
   → 改回 `clampf` → `godot_check` → `OK: checked 2 script(s), 0 error(s)`。
5. `godot_run {headless: true, keepAlive: true, bridge: true}` → `session g1`，桥接已连上，
   输出含 `GAME_READY score=0`。
6. `godot_bridge`：`tree` 列出 `/root/Main/{Player,Star,Hud}`；`node_call debug_state` 取状态；
   `node_set star_pos`、`node_set player_x` + `frames` → **score 0 → 2**；`action ui_right` +
   `frames` → **player_x 400 → 760**（撞到右边界）。
7. `godot_run {headless: false}` → 桥接在 Vulkan 启动后连上 → `screenshot` →
   `live-demo/dsh_screenshot.png`（1152×648，画面里 HUD 显示 `score 1  misses 0`）。
8. `godot_stop` → `stopped: g2`，之后 `Get-Process godot*` 为空。

截图：[live-demo/dsh_screenshot.png](live-demo/dsh_screenshot.png)（真实窗口渲染）

## 3. 验证

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| Lead 端到端流程（建项目→写游戏→注入 bug→定位→修复→headless 运行→桥接操作→窗口截图→清理） | **22/22 PASS** | `e2e/run-flow.mjs`、`e2e/evidence/star-catcher.png` |
| host-core 单元/集成测试（含真引擎） | **63/63 PASS** | `godot-agent/test/*.test.mjs` |
| 独立 verifier 套件（真引擎 + 从 app.asar 取出的真实 `assertSupportedJsonSchema` 校验 6 个 output schema） | **62/62 PASS** | `verify/REPORT.md`、`verify/e2e-last-run.txt` |
| 参考游戏 `demo/`（21 条 headless 断言、桥接自测 24/24、真实窗口截图） | PASS | `demo/README.md`、`demo/evidence/` |
| 安装与生效（真实 Harness 路径） | `application: applied`；6 个工具进入模型工具表；`godot_status/check/init/run/bridge/stop/screenshot` 均已实调 | 本会话 |

验证边界（如实说明）：

- 独立 verifier 不经过真实安装路径：它直接 ESM import `godot-agent/index.js` + 假 cordis ctx，
  只在 schema 这一项用真实 harness 校验器；**真实安装路径由 Lead 在本会话亲自走通**。
- **未做**：Godot 编辑器内的操作（不是编辑器插件，见限制）；GUI 中 locale 标题/图标的渲染效果
  （无浏览器控制能力，只验证了资源合法、可导出）；profile 重启后的重新加载（未重启）。

## 4. 设计与实现

```
godot-agent/
  package.json          # @local/dsh-godot，type: module，零依赖，dsh.bundle.patch
  cordis.patch.yml      # 插入 id: dsh-godot 的 Host 行（config: {}）
  index.js              # export inject=['tools']; apply(ctx, config) 注册 6 个工具 + 卸载清理
  icon.svg              # 自绘图标
  locale/{en,zh}.json   # meta.title / meta.description
  src/engine.js         # 引擎发现：config → GODOT_BIN → PATH → 常见目录扫描；优先 *_console.exe
  src/runner.js         # 进程/会话：输出 200KB 尾缓冲、超时 kill、taskkill 兜底、卸载销毁
  src/gdparse.js        # 引擎日志 → {severity,message,file,line,function,source}
  src/project.js        # 模板脚手架、autoload 写入、import、脚本发现、autoload 检测
  src/bridge.js         # 127.0.0.1 临时端口 NDJSON 监听 + 请求/响应关联 + 10s 超时
  src/tools.js          # 6 个工具定义（参数编译成标准 JSON Schema + 自校验 + render）
  templates/            # 复制进新工程：project.godot / main.tscn / main.gd / bridge/dsh_bridge.gd
  test/                 # 63 个 Node 测试（含真引擎集成）
```

- 协议：游戏**主动连出** `--dsh-bridge=127.0.0.1:<临时端口>`（在 `--` 之后的用户参数里），
  一行一个 JSON：`{"id":7,"cmd":"node","args":{...}}` ↔ `{"id":7,"ok":true,"result":{...}}`；
  GDScript 侧用 `StreamPeerTCP` 非阻塞 `poll()`，不阻塞帧；没有该参数时 autoload 完全惰性。
- 安全/健壮：所有进程用 argv 数组 spawn（不拼 shell）；不 `require` 任何 harness 包；
  插件卸载（HMR/关停）杀死所有子进程并关闭监听；`keepAlive+bridge` 只在项目确实装了
  `dsh_bridge` autoload 时才等待连接，否则约 1.5s 返回并给出提示，不会白等 15s。
- 配置（`godot-agent/cordis.patch.yml` 的 `config:`）：`enginePath`（可执行文件或目录，
  目录优先 console 版）、`projectRoot`、`defaultTimeoutMs`（默认 20000）。

## 5. 已知限制

1. **没有 Godot 编辑器插件**：不能在可视化编辑器里点场景/建节点；场景与脚本仍以文本文件写入，
   运行期用桥接操作。这是 v1 范围，编辑器内桥接可后续加。
2. **headless 无渲染**，`screenshot` 在 headless 下返回可解释的失败；要截屏请 `headless: false`。
3. 只支持 **Godot 4.x + GDScript**（在 4.7.2 上验证）；C# 项目、Godot 3.x 未验证。
4. **没有导出/发布**（未实现 `godot_export`）。
5. `node_call` 的参数/返回值限定 JSON 安全类型；需要传 `Vector2` 等对象时用游戏内辅助方法，
   `node_set` 会把 `[x,y]` 自动转成 `Vector2`。
6. 修改插件 JS 后需**重启 Harness**（或重装 bundle）才加载新代码；`cordis.patch.yml` 里的配置改动同理。
7. 两个已知小瑕疵（不影响功能）：缺少必填参数的错误消息末尾会有两个句号；
   `godot_project_init {import:false}` 仍返回 `import.ok: true`。

## 6. 卸载 / 重装

- 卸载：`plugin_manager` → `remove_bundle`，`target: "@local/dsh-godot"`。
- 重装（改了代码后）：重新 `install_bundle` 指向 `D:\DeepSeekHarness\plugins\godot-agent`，然后重启 Harness。

参考游戏在 `demo/`（可直接用引擎打开玩，也可当调试样例）；本次会话生成的示例游戏在 `live-demo/`。
`CONTRACT.md` 是构建时的接口契约（含最终实现与早期文字的差异说明）。
