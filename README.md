<a id="top"></a>

<div align="center">
  <img src="assets/icons/icon128.png" width="112" height="112" alt="GPT Model Locker icon">
  <h1>GPT Model Locker</h1>
  <p><strong>Keep your preferred model selected whenever you open ChatGPT</strong></p>
  <p>
    <a href="#development"><img src="https://img.shields.io/badge/Version-v0.1.0-8952EE?style=flat-square" alt="Version v0.1.0"></a>
    <a href="#compatibility"><img src="https://img.shields.io/badge/Browsers-Chrome%20%26%20Edge-3A83F7?style=flat-square" alt="Supports Chrome and Edge"></a>
    <a href="#privacy"><img src="https://img.shields.io/badge/Data-Stored%20locally-238636?style=flat-square" alt="Data stored locally"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-64748B?style=flat-square" alt="MIT License"></a>
  </p>
  <p>
    <a href="#installation"><img src="https://img.shields.io/badge/Install-8952EE?style=for-the-badge" alt="Install"></a>
    <a href="#usage"><img src="https://img.shields.io/badge/Usage-3A83F7?style=for-the-badge" alt="Usage"></a>
  </p>
  <p>
    <a href="#features">Features</a> ·
    <a href="#compatibility">Compatibility</a> ·
    <a href="#installation"><strong>Installation</strong></a> ·
    <a href="#usage">Usage</a><br>
    <a href="#privacy">Permissions and Data</a> ·
    <a href="#development">Building and Development</a> ·
    <a href="#limitations">Limitations and Feedback</a> ·
    <a href="#license">License</a>
  </p>
</div>

---

<a id="features"></a>

## ✨ Features

- **Remember your preferred model**: Choose your default model once. The extension automatically applies your saved settings when you start a new chat.
- **Save reasoning effort for each model**: Each model retains its own effort setting, ready to use when you switch back.
- **Control when settings apply**: Limit automatic application to new chats, or let the extension override temporary changes in ChatGPT's model menu and apply your saved settings to existing conversations.
- **Match your ChatGPT theme**: The controls adapt to ChatGPT's color scheme. On sliders with multiple levels, the highest available setting features a gradient, a glow, and particle effects.
- **Choose from six language options**: Simplified Chinese, Traditional Chinese (Hong Kong, Macao, and Taiwan variants), English, and Japanese. Match your browser's language automatically or select one manually.
- **Save settings automatically**: Your preferences are stored locally in your browser and retained when you refresh the page or restart the browser.

The model list reflects the options available to your current account in ChatGPT's **Chat mode**; models from Work mode are excluded. Reasoning effort labels above the slider always appear in English, such as `Instant`, `Medium`, and `High`. Model names remain exactly as they appear in ChatGPT.

<a id="compatibility"></a>

## 🌐 Compatibility

The extension supports the desktop versions of **Google Chrome** and **Microsoft Edge (Chromium)**.

| Browser | Support | Tested versions |
| --- | :---: | --- |
| Google Chrome | ✅ Supported | `155.0.8059.81`, `156.0.8078.48` |
| Microsoft Edge | ✅ Supported | `144.0.3719.115`, `156.0.4314.42` |

The table lists the versions tested by the maintainer. Other versions have not been individually verified. Firefox, Safari, and mobile browsers are not currently supported.

<a id="installation"></a>

## 📦 Installation

1. **Download the extension**: Get the ZIP package from this repository's **Releases** section. **There is no need to extract it.**
2. **Open the extensions page**: Enter `chrome://extensions/` in Chrome's address bar or `edge://extensions/` in Edge's address bar.
3. **Install the extension**: Enable **Developer mode**, then **drag the downloaded ZIP package directly onto the extensions page** and wait for installation to finish.
4. **Open ChatGPT**: Visit or refresh [chatgpt.com](https://chatgpt.com/), sign in, and switch to Chat mode. Once the page is ready, a **floating GPT button** appears in the upper-left corner. Click it to configure the extension.

<a id="usage"></a>

## 🚀 Usage

### Initial setup

1. Click **GPT** in the upper-left corner of the page, then choose **Settings** → **Refresh model list**.
2. Return to the main panel and choose your **Target model** and **Reasoning effort**. Your selections are saved automatically.
3. Open the advanced settings to further customize your preferences.

> [!TIP]
> If no reasoning effort options are shown for the selected model, open Settings and click **Apply configuration** once. This allows the extension to switch to that model and read its available effort levels. Then return to the main panel to choose a level.

### Preferences

| Setting | Default | Behavior when enabled |
| --- | :---: | --- |
| Apply settings on each new chat | On | Controls automatic application of your saved settings. Once a new chat is ready, the extension applies your saved model and reasoning effort. |
| Apply settings even when the native model menu is open | Off | **Recommended: enable.** When automatic application is enabled for the current chat, the extension restores your saved model and reasoning effort even if you open ChatGPT's built-in model menu or change the selection manually. |
| Apply settings even when opening an existing chat | Off | **Recommended: enable.** Also allows your saved settings to be applied automatically when you open an existing conversation. |
| Follow browser language | On | Matches the interface language to your browser's language. Turn this off to choose a language from the selector below. |

Both “even when…” options also require **Apply settings on each new chat** to be enabled. By default, **manually changing the model or reasoning effort in ChatGPT, or opening a new chat, pauses automatic application for that session**. Enable both “even when…” options to have the extension restore your saved settings in these situations.

### Refreshing the model list and applying settings

| Button | What it does |
| --- | --- |
| **Refresh model list** | Updates the model list using the options currently available on the page and reads the effort levels for the model selected in ChatGPT's menu. Keeps your saved model and reasoning effort unchanged. |
| **Apply configuration** | Attempts to apply your saved model and reasoning effort to the current chat immediately. |

The extension leaves the model and reasoning effort unchanged while ChatGPT is generating a response or whenever it cannot confirm that the page is idle. Check the result in Settings, or open ChatGPT's built-in menu to verify the active selection.

<details>
<summary><b>Updating a locally installed extension</b></summary>

Replace the files in the directory from which you originally loaded the extension, or rebuild the extension if you are using the source code. Then click **Reload** on your browser's extensions page and refresh any open ChatGPT tabs.

Clicking “New chat” within ChatGPT does not load the updated extension scripts.

</details>

[↑ Back to top](#top)

<a id="privacy"></a>

## 🔐 Permissions and Data Handling

### What permissions are required?

| Permission / scope | Purpose |
| --- | --- |
| `storage` | Saves your settings and detected model options locally in the browser. |
| `https://chatgpt.com/*` | Displays the floating GPT button and allows the extension to read and interact with ChatGPT's model and reasoning effort controls. |
| `https://chat.openai.com/*` | Allows the extension to run on ChatGPT's legacy domain as well. |

- **Scope**: The extension runs only on the ChatGPT pages listed above. It changes the model and reasoning effort through ChatGPT's built-in menus.
- **Local storage**: Your settings, cached model list, language preference, and theme colors stay in the current browser. They are not synced across devices or stored separately for different ChatGPT accounts.
- **Chat privacy**: The extension does not save or upload chat content, unsent drafts, or conversation URLs. It does not read cookies or access tokens.
- **Network activity**: The extension makes no network requests of its own and collects no telemetry. Interactions with ChatGPT's menus may trigger requests from the page itself, so ChatGPT still needs an internet connection.

<a id="development"></a>

## 🛠️ Building and Development

Use **Node.js 24 and npm**. The project has been built with Node.js `24.12.0`. Run all commands from the project root, which contains `package.json`.

```sh
npm ci
npm run build
```

| Command | Purpose |
| --- | --- |
| `npm ci` | Installs the dependency versions specified in the lockfile. An internet connection is required for the initial installation. |
| `npm run check` | Runs TypeScript type checking. |
| `npm test` | Runs automated tests. |
| `npm run build` | Runs type checking and builds the extension into `dist/`, ready to load in the browser. |
| `npm run package` | Rebuilds the extension and creates `release/chatgpt-model-effort-<version>.zip`. |

The build output directories, `dist/` and `release/`, are not committed to source control. The installation ZIP contains `manifest.json` at the archive root.

<details>
<summary><b>Project structure and development notes</b></summary>

```text
assets/icons/   Extension icons and SVG source files
scripts/        Build, packaging, and optional icon export scripts
src/            Page inspection, settings panel, settings application, storage, and localization
tests/          Automated tests covering data handling, page integration, interaction flows, and more
LICENSE         MIT License
```

Standard builds use the existing PNG icons. You only need the additional dependency `sharp` if you run `scripts/generate-icons.mjs` to regenerate them.

If you change model detection or the logic for applying settings automatically, also check the resulting selection in ChatGPT's built-in menu in Chrome or Edge. Tests against simulated pages cannot replace verification on the actual website.

</details>

[↑ Back to top](#top)

<a id="limitations"></a>

## 💬 Known Limitations and Feedback

- **Depends on ChatGPT's interface**: The extension can select only the models and effort levels available to your current account in ChatGPT. Interface changes, experiments enabled for particular accounts, and differences in interface language may affect detection. The current detection rules support Chinese, English, and Japanese interfaces.
- **Waits for the page to be ready**: Automatic application is deferred while a response is being generated, the tab is hidden, or the page's state cannot be determined. If the first attempt to open the menu automatically fails, the extension waits briefly and retries once. It does not retry indefinitely.

<details>
<summary><b>Why are old models still in the list?</b></summary>

Refreshing adds newly detected options to the cached list without removing models that were not found during that refresh. The list may therefore retain models that are no longer available on the page. Cached options can also carry over when you switch accounts. Refresh the list, and check ChatGPT's current model menu to confirm what is available.

</details>

<details>
<summary><b>Why is the GPT button sometimes missing from the upper-left corner?</b></summary>

The GPT button depends on ChatGPT's built-in model selector. If the selector remains absent for approximately **1.45 seconds**, the button is hidden; it reappears when the selector returns. During the initial page load, the button stays hidden until the selector becomes available. If you are in Work mode or the page controls have not loaded, return to Chat mode and wait for the page to finish loading.

</details>

<a id="feedback"></a>

### Reporting issues and sharing feedback

Please use this repository's **Issues** section to report a problem or suggest an improvement. Where possible, include:

- **Observed and expected behavior**: What happened and what you expected instead.
- **Steps to reproduce**: The sequence of actions that led to the problem, so we can reproduce it.
- **Browser and version**: For example, Chrome `156.0.8078.48`.

Screenshots and error messages are also helpful. Please redact any personal information from screenshots before sharing them. Contributions via pull requests are welcome.

<a id="license"></a>

## 📄 License

This project is licensed under the [MIT License](LICENSE).

Copyright © 2026 YaoyaoStudio.

<div align="center">
  <a href="#top">↑ Back to top</a>
</div>
