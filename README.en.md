<div align="center">

# dsh-ask-mode

**会话内一键切换「咨询模式」——只读问答，产出仅限新建文档**

[![version](https://img.shields.io/badge/version-0.1.0-181717)](./package.json)
[![license](https://img.shields.io/badge/license-MIT-38a834)](./LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows-0078D6)](https://github.com/longhao666666/dsh-ask-mode)
[![dsh](https://img.shields.io/badge/DeepSeek_Harness-%3E%3D_0.2.0--rc.2-5D45B0)](https://github.com/longhao666666/dsh-ask-mode)
[![stars](https://img.shields.io/github/stars/longhao666666/dsh-ask-mode?color=F9C513)](https://github.com/longhao666666/dsh-ask-mode/stargazers)

[简体中文](./README.md) | English

</div>

---

> **零依赖**：常规 Cordis 插件，纯 JS 源码直接加载——无需编译、无需 Token / API Key、无需额外服务。

Ask questions, browse, read code and docs — without letting the agent touch anything that already exists. When you need a deliverable, it can only create a **new** txt / markdown / docx file.

## Features

| Capability | Details |
| --- | --- |
| Runtime switch | A badge next to the "创造模式" preset label in the session header; toggle any time, no new session needed. If a round is in progress, the switch applies from the next round (badge shows 「咨询中（下一步生效）」) |
| Dual read-only fence | Editing tools are removed, **and** the sandbox switches to read-only — writes to existing files are rejected outright. Enforced on the host side; refreshing the page cannot bypass it |
| `save_artifact` | The single sanctioned write path: creates **new** txt / markdown / docx files only, refuses to overwrite anything; docx is generated from simple markdown (`#` headings, paragraphs, `-` lists) |
| Deliverables | Just say "整理成 markdown" / "生成一份报告" — the model calls `save_artifact` with a fresh path |

## Requirements

- Windows
- DeepSeek Harness desktop installed and launched at least once (developed against 0.2.0-rc.2)

## Installation

One-click script (detects DSH, creates the `node_modules/@local` link, updates the profile config):

```powershell
git clone https://github.com/longhao666666/dsh-ask-mode.git
cd dsh-ask-mode
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

<details>
<summary>Manual mount (click to expand)</summary>

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
$repo    = "<path-to-clone>"    # e.g. "$HOME\code\dsh-ask-mode"

New-Item -ItemType Directory -Force "$profile\node_modules\@local" | Out-Null
New-Item -ItemType Junction -Path "$profile\node_modules\@local\dsh-ask-mode" -Target $repo
```

Then merge these fields into `$profile\package.json` (append inside existing fields):

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

</details>

Either way, **restart DeepSeek Harness** afterwards and confirm `@local/dsh-ask-mode` is enabled on the plugin management page.

## Usage

1. Open any session after restarting DSH — a 「咨询模式」 badge appears right of the preset label.
2. Click it to enter consultation mode (badge lights up as 「咨询中」; hover for the constraint summary).
3. Ask as usual. In consultation mode the agent **can** research, search, read code/docs, answer, and create new deliverable files; it **cannot** modify or delete existing files or perform system-changing actions.
4. For a deliverable, just ask ("turn the conclusions above into a markdown report") — the model uses `save_artifact` to create a new file.
5. Click the badge again to exit and restore the full toolset and sandbox.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

Takes effect after restarting DSH; the cloned repo files are left untouched.

<details>
<summary>How it works (click to expand)</summary>

- `host.js` (Node side): owns the mode state and the fence — dynamically adds/removes tools, flips the sandbox to read-only, provides the `save_artifact` tool, and serves the `/ask-mode` route.
- `client.js` (browser side): renders the badge only (preferring the projection hook from the slot host, falling back to polling `/ask-mode`). All restrictions are enforced host-side.

</details>

## Related plugins

- [dsh-element-context](https://github.com/longhao666666/dsh-element-context) — pick UI elements into the conversation context
- [dsh-session-delete](https://github.com/longhao666666/dsh-session-delete) — one-click session deletion in the sidebar

## License

[MIT](./LICENSE)
