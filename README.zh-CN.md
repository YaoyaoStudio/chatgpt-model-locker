<a id="top"></a>

<div align="center">
  <img src="assets/icons/icon128.png" width="112" height="112" alt="GPT模型锁定器图标">
  <h1>GPT模型锁定器</h1>
  <p><strong>锁定你最喜欢的模型，以免每次打开GPT时手动调整</strong></p>
  <p>
    <a href="#development"><img src="https://img.shields.io/badge/%E7%89%88%E6%9C%AC-v0.1.0-8952EE?style=flat-square" alt="版本 v0.1.0"></a>
    <a href="#compatibility"><img src="https://img.shields.io/badge/%E6%B5%8F%E8%A7%88%E5%99%A8-Chrome%20%26%20Edge-3A83F7?style=flat-square" alt="支持 Chrome 和 Edge"></a>
    <a href="#privacy"><img src="https://img.shields.io/badge/%E6%95%B0%E6%8D%AE-%E6%9C%AC%E5%9C%B0%E4%BF%9D%E5%AD%98-238636?style=flat-square" alt="数据本地保存"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-64748B?style=flat-square" alt="MIT 许可证"></a>
  </p>
  <p>
    <a href="#installation"><img src="https://img.shields.io/badge/%E5%BC%80%E5%A7%8B%E5%AE%89%E8%A3%85-8952EE?style=for-the-badge" alt="开始安装"></a>
    <a href="#usage"><img src="https://img.shields.io/badge/%E4%BD%BF%E7%94%A8%E6%96%B9%E6%B3%95-3A83F7?style=for-the-badge" alt="使用方法"></a>
  </p>
  <p>
    <a href="#features">主要功能</a> ·
    <a href="#compatibility">兼容性</a> ·
    <a href="#installation"><strong>安装</strong></a> ·
    <a href="#usage">使用方法</a><br>
    <a href="#privacy">权限与数据</a> ·
    <a href="#development">构建与开发</a> ·
    <a href="#limitations">限制与反馈</a> ·
    <a href="#license">许可证</a>
  </p>
</div>

---

<a id="features"></a>

## ✨ 主要功能

- **记住常用模型**：选择一次默认模型，新建聊天时自动应用保存的配置。
- **记住推理强度**：不同模型分别保存强度设置，切换回来时继续使用对应的选择。
- **按你的习惯应用**：可以只在新聊天中生效，也可以允许覆盖原生菜单中的临时调整、应用到历史对话。
- **跟随网页配色**：控件随 ChatGPT 主题配色，多档滑条的最高有效档位带有渐变、光晕和粒子效果。
- **六种界面语言**：简体中文、繁體中文（香港／澳門／台灣）、English、日本語，支持跟随浏览器或手动选择。
- **设置自动保存**：配置保存在浏览器本地，刷新页面、重新打开浏览器后仍可使用。

模型选项来自当前账号的 ChatGPT **聊天模式**，工作模式的模型不会加入列表。滑条上方的档位名称始终使用英文，例如 `Instant`、`Medium`、`High`；模型名称保留原文。

<a id="compatibility"></a>

## 🌐 兼容性

支持桌面版 **Google Chrome** 和 **Microsoft Edge（Chromium）**。

| 浏览器 | 支持情况 | 已实测通过的版本 |
| --- | :---: | --- |
| Google Chrome | ✅ 支持 | `155.0.8059.81`、`156.0.8078.48` |
| Microsoft Edge | ✅ 支持 | `144.0.3719.115`、`156.0.4314.42` |

以上是维护者提供的实测记录；其他版本尚未逐一验证。Firefox、Safari 和手机浏览器不在当前适配范围内。

<a id="installation"></a>

## 📦 安装

1. **获取文件**：到本仓库的 **Releases** 下载扩展安装包 ZIP，**无需手动解压**。
2. **打开扩展管理页**：在地址栏输入 Chrome 的 `chrome://extensions/`，或 Edge 的 `edge://extensions/`。
3. **安装扩展**：开启“开发者模式”，将下载的**扩展安装包 ZIP 直接拖入扩展管理页**，等待安装完成。
4. **打开 ChatGPT**：访问或刷新 [chatgpt.com](https://chatgpt.com/)，登录后进入聊天模式。页面就绪后，左上角出现 **GPT 悬浮入口**，即可开始设置。

<a id="usage"></a>

## 🚀 使用方法

### 第一次设置

1. 点击网页左上角的 **GPT** → **设置** → **刷新模型列表**。
2. 返回首页，选择 **目标模型** 和 **推理强度**，设置会自动保存。
3. 可以进一步进入高级设置更改习惯设置。

> [!TIP]
> 如果所选模型还没有推理强度选项，先到设置中点击一次 **立即应用配置**，让扩展应用该模型并读取它的强度，再返回选择。

### 习惯设置

| 设置 | 默认 | 开启后的作用 |
| --- | :---: | --- |
| 每次新建会话时应用设置 | 开启 | 自动应用总开关，新聊天就绪后应用保存的模型和强度。 |
| 即使打开原生模型菜单也应用设置 | 关闭 | **（推荐开启）** 在允许自动应用的页面中，即使打开 ChatGPT 自带的模型菜单或手动改选，也会恢复插件里保存的模型和强度。 |
| 即使打开历史对话也应用设置 | 关闭 | **（推荐开启）** 打开历史对话时，也允许自动应用保存的配置。 |
| 语言跟随浏览器 | 开启 | 自动选择匹配的界面语言；关闭后可在下方手动选择。 |

两个“即使…”开关都需要同时开启自动应用总开关。默认情况下，**手动调整 ChatGPT 自带的模型或推理强度/打开新对话 会暂停本轮自动选择**；开启两个“即使…”开关后，扩展才会恢复保存的配置。

### 两个按钮有什么作用？

| 按钮 | 什么时候用 |
| --- | --- |
| **刷新模型列表** | 更新网页当前提供的模型选项，并读取当前原生选中模型的推理强度；不改写保存的目标配置。 |
| **立即应用配置** | 现在就尝试把保存的模型和强度应用到当前聊天。 |

正在生成回复或无法确认空闲时，扩展不会切换模型和强度。实际应用结果可在设置页查看，也可以打开 ChatGPT 原生菜单核对。

<details>
<summary><b>更新本地安装的扩展</b></summary>

将新版文件放回原加载目录（源码版则重新构建），到浏览器扩展管理页点击 **重新加载**，再刷新已打开的 ChatGPT 标签页。

只点击网页里的“新聊天”不会载入新版扩展脚本。

</details>

[↑ 返回顶部](#top)

<a id="privacy"></a>

## 🔐 权限与数据处理

### 需要什么权限？

| 权限／范围 | 用途 |
| --- | --- |
| `storage` | 在浏览器本地保存设置和已读取的模型选项。 |
| `https://chatgpt.com/*` | 显示悬浮入口，读取并操作原生模型与强度控件。 |
| `https://chat.openai.com/*` | 为 ChatGPT 旧域名提供相同的页面匹配。 |

- **运行范围**：仅在上述 ChatGPT 页面运行，通过原生菜单调整模型和推理强度。
- **本地保存**：配置、模型列表缓存、语言和主题色保存在当前浏览器中，不跨设备同步，也不按 ChatGPT 账号分别保存。
- **聊天隐私**：不保存或上传聊天正文、输入草稿和对话地址，不读取 Cookie 或访问令牌。
- **联网行为**：扩展自身没有独立网络请求或遥测；操作原生菜单可能触发 ChatGPT 网页自身的请求，网页仍需正常联网。

<a id="development"></a>

## 🛠️ 构建与开发

使用 **Node.js 24 和 npm**；已有构建记录使用 Node.js `24.12.0`。所有命令都在包含 `package.json` 的项目根目录运行。

```sh
npm ci
npm run build
```

| 命令 | 作用 |
| --- | --- |
| `npm ci` | 按锁文件安装依赖，首次安装需要联网。 |
| `npm run check` | TypeScript 类型检查。 |
| `npm test` | 自动化测试。 |
| `npm run build` | 类型检查并生成浏览器可加载的 `dist/`。 |
| `npm run package` | 重新构建，并生成 `release/chatgpt-model-effort-<版本号>.zip`。 |

`dist/` 和 `release/` 是生成目录，不随源码提交。安装 ZIP 的根层包含 `manifest.json`。

<details>
<summary><b>源码目录与开发说明</b></summary>

```text
assets/icons/   扩展图标与 SVG 源文件
scripts/        构建、打包和可选的图标导出脚本
src/            页面读取、设置面板、配置应用、存储和多语言
tests/          数据、页面适配与交互流程等自动化测试
LICENSE         MIT 许可证
```

正常构建直接使用已保存的 PNG 图标。仅在重新导出图标时，`scripts/generate-icons.mjs` 需要额外提供 `sharp`。

涉及模型读取或自动应用的修改，还应在 Chrome／Edge 中核对原生选中结果。模拟页面测试不能替代真实网页验证。

</details>

[↑ 返回顶部](#top)

<a id="limitations"></a>

## 💬 已知限制与反馈方式

- **依赖原生网页**：只能操作当前账号网页实际提供的模型和强度。页面改版、账号实验或网页语言差异可能影响识别；当前识别规则围绕中文、英语和日语网页编写。
- **应用需要页面就绪**：生成回复、标签页隐藏或页面状态不明时，不会立即自动应用。首次自动打开菜单失败后会短暂等待并补试一次，没有无限循环重试。

<details>
<summary><b>为什么列表里还有旧模型？</b></summary>

刷新会合并新读到的选项，保留本次没有看到的旧模型，因此缓存可能有已从网页移除的项目。切换账号后也可能看到之前的缓存，请刷新并以当前原生菜单为准。

</details>

<details>
<summary><b>为什么左上角的 GPT 入口有时看不到？</b></summary>

入口依赖聊天页面的原生模型选择控件。该控件持续缺失约 **1.45 秒**后，入口会隐藏，控件恢复后重新出现；首次加载尚无控件时也会保持隐藏。切到工作模式或网页控件尚未就绪时，请先回到聊天模式并等页面加载完成。

</details>

<a id="feedback"></a>

### 提交反馈

欢迎您在 **Issues** 提交问题或建议，如果方便的话请附上：

- **问题表现**：遇到了什么问题，预期应该是什么效果。
- **操作步骤**：进行了哪些操作后出现问题，方便我们尝试复现。
- **浏览器及版本号**：例如 Chrome `156.0.8078.48`。

方便的话，也可以附上截图或错误提示，截图请遮盖个人信息。也欢迎通过 Pull Request 参与改进。

<a id="license"></a>

## 📄 许可证

本项目采用 [MIT License](LICENSE)。

Copyright © 2026 YaoyaoStudio。

<div align="center">
  <a href="#top">↑ 返回顶部</a>
</div>
