# Contributing to Filepace

Set up the project and run the checks in the [README](README.en.md). The desktop app is the entry point for testing real file operations. The browser preview is suitable for layout and navigation changes.

## Report a problem

Include your operating system, Filepace build or commit, and the steps to reproduce the problem. For a file operation, describe the source and destination folders, how you selected the files, and any keys held during the action. Use sample files and redact personal paths or file contents from screenshots and logs.

## Submit a change

Keep each change focused. In the pull request, describe the visible behavior and list the platforms and scenarios you tested. Use English Git commit messages and follow the filesystem and platform rules in [AGENTS.md](AGENTS.md).

## Local macOS replacement

Build and verify the new bundle before closing the installed app. Keep a recoverable backup of the previous app, stage the replacement, and leave application data in place.

After closing Filepace through UI automation, check process termination without querying the closed app's accessibility tree. A stale app reference can return Launch Services `-600` (`procNotFound`) and may trigger an “application can no longer be opened” alert. After installation, acquire a fresh app reference using the full installed path; build and backup copies share the bundle identifier. Verify that the installed app opens and restores its session.
