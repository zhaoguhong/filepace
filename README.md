# Filepace

[English](README.en.md)

Filepace 是一款适用于 macOS 和 Windows 的本地文件管理器。你可以用标签页或左右分栏浏览目录，拖放整理文件，也可以从右键菜单打开系统文件管理器或命令行。项目使用 Tauri、Rust、React 和 TypeScript。

## 下载安装

在 [GitHub Release](https://github.com/zhaoguhong/filepace/releases/tag/v0.4.0) 下载适合你的 v0.4.0 安装包。

| 系统 | 安装包 | 安装方式 |
| --- | --- | --- |
| macOS（Apple 芯片） | [下载 .dmg][mac-download] | 打开磁盘映像，将 Filepace 拖到「应用程序」。 |
| Windows（x64） | [下载 .exe][windows-download] | 运行安装程序，为当前用户安装。如果系统缺少 WebView2，安装程序需要联网下载。 |

macOS 版使用临时签名，尚未公证，首次打开可能出现「门禁」提示。Windows 版尚未签名，运行时可能出现 SmartScreen 提示。[Apple 支持](https://support.apple.com/zh-cn/102445) · [Microsoft SmartScreen 文档](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

## 同时整理两个目录

- 按 macOS 的 **⌘N** 或 Windows 的 **Ctrl+N**，在当前位置打开独立窗口。也可通过标签页右键菜单将标签移到新窗口。
- 点「左右分栏」会在当前窗口内打开右侧窗格。两侧各有独立的标签页、选区和浏览历史。侧栏导航和键盘快捷键作用于当前窗格。
- 把文件或文件夹拖到另一侧窗格或另一个 Filepace 窗口，默认移动。松开鼠标时按住 macOS 的 **Option** 或 Windows 的 **Ctrl** 就会复制。拖到文件夹上会放入该文件夹，拖到空白处会放入当前目录。
- 点「合并分栏」会回到单栏，并保留两边的标签页。

右键单击文件、文件夹或文件列表的空白处，可以复制完整路径、在 Finder 或资源管理器中显示，或打开命令行。macOS 使用终端，Windows 使用 PowerShell。右键单击文件时，命令行会在文件所在目录启动。

## 存储概览

- 点击窗口顶部的「存储概览」查看已挂载卷的容量、可用空间和使用比例。可以从卷卡片进入对应目录或选择扫描范围。
- 选择当前目录、常用位置或一个卷，点击「开始扫描」。扫描统计文件逻辑大小与数量，列出文件分类、最大的文件和占用最多的子目录。扫描中可停止，点击分类可筛选大文件列表。
- 点击结果可回到文件所在目录，也可以把一个子目录设为下一次扫描的范围。扫描在本机读取文件元数据，跳过链接和无法访问的项目。

## 查看与系统操作

文件列表和图标视图区分 Word、Excel、PowerPoint、PDF、图片及其他常见类型。工具栏可切换列表和小、中、大、超大图标。拖动时会显示文件图标、名称和多选数量。

新标签默认使用列视图。单击文件夹会在右侧展开下一列，选中文件会显示预览或基本信息。每个标签可用工具栏切换列视图、列表和图标。

从侧栏底部打开「设置」，在「浏览」中可选择新标签的默认视图。在「外观」中分别选显示模式与主题。显示模式默认跟随系统，默认、雾蓝和暖砂主题各有浅色和深色版本。

右键「打开方式」可选用系统提供的应用。右键「属性」或按 macOS 的 **⌘I**、Windows 的 **Alt+Enter**，可查看选中项目的系统简介或属性。系统窗口无法打开时会显示基本信息。「复制名称」可复制所选项目的名称，存储概览可直达 macOS 磁盘工具或 Windows 存储设置。

## 应用更新

从 v0.4.0 起，Filepace 会后台检查、下载并校验 GitHub 上的正式更新。在「设置 → 更新」可以手动检查，或关闭自动更新。选择「重启更新」前请完成正在运行的文件任务。v0.3.0 和更早版本可从发布页下载安装包升级一次。

## 跨目录搜索

点窗口顶部的「搜索」，或按 macOS 的 **⌘F**、Windows 的 **Ctrl+F**，在当前文件夹和子文件夹里按名称和类型查找。Filepace 优先查询 Spotlight 或 Windows Search。索引不可用时会扫描目录，也可从索引结果切换到「扫描全部子目录」。点结果可直接定位项目。

## 文件操作

文件任务会显示进度，遇到同名文件时会询问如何处理。移动时先在目标位置写入文件，再移除源文件。删除和替换的文件会进入系统废纸篓或回收站。关闭最后一个窗口时，如果还有文件任务在运行，Filepace 会询问是继续任务，还是取消任务并关闭窗口。

- 从状态栏的「撤销」或按 **⌘Z** / **Ctrl+Z**，撤销本次会话最近一次移动或改名。原位置被占用或文件已被替换时会停下来。被替换的旧项目可从系统废纸篓或回收站恢复。
- 右键「压缩为 ZIP」会把选中的项目归档到当前目录，优先使用系统工具。右键 ZIP 可「解压到同名文件夹」。解压会检查包内路径，验证完成后才提交目标文件夹。

Filepace 保存各窗口的标签页和分栏打开的目录，并使用当前用户的文件系统权限。可以浏览符号链接，文件传输暂不支持符号链接。[平台验证和已知限制](docs/scope.md)

## 从源码运行

安装 Node.js 24 或更高版本、稳定版 Rust，以及对应系统的构建工具。[Tauri 环境要求](https://v2.tauri.app/start/prerequisites/)

```sh
npm ci
npm run tauri dev
```

`npm run dev` 启动的是使用示例文件的只读浏览器预览。验证真实文件操作时，请在桌面应用中使用临时目录。

## 测试与打包

```sh
npm test
npm run build
npm run test:e2e
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

本地浏览器测试使用 Google Chrome。CI 使用 Playwright 安装的 Chromium。

```sh
# macOS
npm run tauri -- build --bundles app,dmg

# Windows
npm run tauri -- build --bundles nsis
```

安装包生成在 `src-tauri/target/release/bundle/` 下。GitHub Actions 会在两个平台运行检查，手动运行工作流时可以上传安装包产物。[Windows 安装说明](docs/windows-installation.md) · [发布检查](docs/releases.md)

## 贡献与许可证

提交问题或代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [AGENTS.md](AGENTS.md)。Filepace 采用 [MIT 许可证](LICENSE)，依赖使用各自的许可证。

[mac-download]: https://github.com/zhaoguhong/filepace/releases/download/v0.4.0/Filepace_0.4.0_aarch64.dmg
[windows-download]: https://github.com/zhaoguhong/filepace/releases/download/v0.4.0/Filepace_0.4.0_x64-setup.exe
