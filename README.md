# dsh-ask-mode

DeepSeek Harness（DSH 桌面版）插件：在会话头部增加「咨询模式」徽标，一键把当前会话切成**只读问答**——可以查资料、搜索、读代码和文档，但不能修改任何已有内容；需要产出时只能**新建** txt / markdown / docx 文档。

## 功能

- **运行时切换**：徽标位于会话头部、「创造模式」标签右侧，随时点击切换，无需新建会话。正在生成时切换，会在本轮结束后生效（徽标显示「咨询中（下一步生效）」）。
- **只读约束（双重硬限制）**：
  - 移除修改类工具，仅保留读取类工具；
  - 沙箱切换为只读模式，对已有文件的写入被直接拒绝。
- **唯一产出通道 `save_artifact`**：仅允许创建**新**文件（txt / markdown / docx），拒绝覆盖任何已有文件；docx 由简单 markdown（`#` 标题、段落、`-` 列表）生成。适合「帮我整理成 markdown」「生成一份报告」这类需求。

## 环境要求

- Windows
- DeepSeek Harness 桌面版已安装，并至少启动过一次（开发时基于 0.2.0-rc.2 验证）

## 安装

### 方式一：一键脚本

```powershell
git clone https://github.com/longhao666666/dsh-ask-mode.git
cd dsh-ask-mode
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会自动检测 DSH、建立 `node_modules/@local` 链接、把插件写进 profile 配置。

### 方式二：手动挂载

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
$repo    = "<你的克隆路径>"    # 例如 "$HOME\code\dsh-ask-mode"

New-Item -ItemType Directory -Force "$profile\node_modules\@local" | Out-Null
New-Item -ItemType Junction -Path "$profile\node_modules\@local\dsh-ask-mode" -Target $repo
```

然后编辑 `$profile\package.json`，合并以下字段（已存在的字段里追加即可）：

```json
{
  "dependencies": {
    "@local/dsh-ask-mode": "link:C:/Users/you/code/dsh-ask-mode"
  },
  "dsh": {
    "profile": {
      "bundles": ["@local/dsh-ask-mode"]
    }
  }
}
```

两种方式完成后都需**重启 DeepSeek Harness**，并在「插件管理」页确认 `@local/dsh-ask-mode` 已启用。

## 使用说明

1. 重启 DSH 后打开任意会话，头部「创造模式」标签右侧出现「咨询模式」徽标。
2. 点击徽标进入咨询模式：徽标点亮为「咨询中」，悬停可查看当前约束说明。
3. 像平常一样提问。咨询模式下：
   - **可以**：查资料、搜索、阅读代码与文档、回答问题、新建产出文档；
   - **不可以**：修改或删除已有文件、执行任何改动系统的操作。
4. 需要产出时直接说，例如「把上面的结论整理成一份 markdown 报告」，模型会调用 `save_artifact` 新建文件。
5. 再次点击徽标退出，恢复完整的工具与沙箱。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

重启 DSH 后生效；克隆下来的仓库文件不会被删除。

## 工作原理

- `host.js`（Node 侧）：模式状态与围栏的真正持有者——切换时动态增删工具、把沙箱切成只读、提供 `save_artifact` 工具，并注册 `/ask-mode` 路由。
- `client.js`（浏览器侧）：只负责徽标 UI 与状态展示（优先使用槽位宿主传入的投影钩子，回退为轮询 `/ask-mode`），真正的限制都在 host 侧强制执行，刷新页面也无法绕过。

## 相关插件

- [dsh-element-context](https://github.com/longhao666666/dsh-element-context) — 对话中圈选 UI 元素注入上下文
- [dsh-session-delete](https://github.com/longhao666666/dsh-session-delete) — 侧栏一键删除会话

## 许可证

[MIT](./LICENSE)
