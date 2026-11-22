<div align="center">

<img src="resources/icon-256.png" width="96" height="96" alt="anyshot logo">

# anyshot

**Capture, annotate and record your screen on Windows and Linux.**

</div>

> **Credit:** All inspiration and feature ideas for anyshot are taken from [macshot](https://github.com/sw33tLie/macshot) by sw33tLie.
> anyshot is an independent implementation written from scratch for Windows and Linux. It contains no macshot code or assets, and is released under the MIT licence.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

Only the Windows installers (`anyshot-Setup-<version>-x64.exe` and `-arm64.exe`) built by this repository's [Release workflow](https://github.com/mgamergo/anyshot/actions/workflows/release.yml) on GitHub-hosted runners are signed. Every release is approved by hand before it is signed. Linux packages (`.deb`, AppImage) are not code-signed.

Team roles:

- Committers and reviewers: [Chaitanya Swaroop (@mgamergo)](https://github.com/mgamergo) <!-- TODO(Chaitanya): add anyone else who gets write access or reviews PRs, e.g. "[@name](https://github.com/name)" -->
- Approvers: [Chaitanya Swaroop (@mgamergo)](https://github.com/mgamergo)

Contributions from people outside the team arrive as pull requests from forks, and a team member reviews each one before it is merged.

### Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

What that means in practice:

- **Update check.** When "Check for updates" is on (Settings, on by default), anyshot asks GitHub once at startup whether a newer release exists, by reading this repository's release metadata (`latest.yml` / `latest-linux.yml`). Nothing is downloaded unless you choose **Update**. Turn the toggle off to stop the check. These requests go to GitHub and are covered by the [GitHub Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).
- **Uploads.** anyshot uploads a capture only when you choose to, and only to the HTTP server or S3-compatible storage you configure yourself. That service's own privacy policy applies.
- **Links.** Links you click (for example in Settings or the update window) open in your web browser.
- **No telemetry.** anyshot has no analytics, crash reporting or tracking. OCR runs offline with a model that ships with the app. Captures, history and settings stay on your computer.

The website, [anyshot.xyz](https://anyshot.xyz), is hosted on GitHub Pages and uses no analytics or cookies of its own, and its fonts are self-hosted. When it loads, the page asks the GitHub API for the latest release so the download links stay current. GitHub may log these requests and page visits, as described in the [GitHub Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).

![Selecting an area and annotating it in the capture overlay](docs/screenshots/overlay.png)

anyshot sits quietly in your tray until you need it. Press a shortcut, drag over any part of your screen, and mark it up right there with arrows, text, highlights, numbered steps or blur. Then copy it, save it, pin it on top of your other windows or upload it in one keystroke. It also records your screen to MP4 or GIF, stitches scrolling pages into one tall image, and reads text out of screenshots offline.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/editor-beautify.png" alt="Editor with censored text, arrows and a gradient Beautify frame"></td>
    <td width="50%"><img src="docs/screenshots/beautify-on.png" alt="Beautify frame with gradient background, padding, rounded corners and shadow"></td>
  </tr>
  <tr>
    <td align="center"><sub>Annotate, blur sensitive details and frame the result</sub></td>
    <td align="center"><sub>One click turns any capture into a polished image</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/history-preview.png" alt="History window with a quick-look preview of a capture"></td>
    <td width="50%"><img src="docs/screenshots/settings-theme-dark.png" alt="Settings window in dark mode"></td>
  </tr>
  <tr>
    <td align="center"><sub>Every capture and recording, a keystroke away</sub></td>
    <td align="center"><sub>Light and dark themes with your own accent colour</sub></td>
  </tr>
</table>

## What it does

- **Capture anything.** An area, a whole screen, the last area again, or just the text in it. Works across multiple monitors at full resolution, with an optional countdown.
- **Annotate in place.** Pencil, lines, arrows, shapes, highlighter, text, numbered badges, stamps, spotlight, magnifier, measuring and a colour picker, with full undo and redo.
- **Hide what matters.** Pixelate, blur or black out passwords, emails and anything else you don't want to share.
- **Make it look good.** Beautify wraps a capture in a gradient background with padding, rounded corners and a soft shadow. Colour adjustments and presets are built in.
- **Share it your way.** Copy, save as PNG, JPEG or WebP, pin it on screen, drag it into another app, or upload to your own server or S3-compatible storage.
- **Record your screen.** Save an area as MP4 or GIF, with your microphone (and system audio on Windows). Controls beside the area show the time and pause, resume or stop the recording.
- **Scrolling capture.** Scroll through a long page and get one stitched image.
- **Read text from images.** Offline OCR copies the text out of any capture.
- **Pick up where you left off.** A history of everything you've captured, and an editor for captures, image files and your clipboard. Annotations stay editable.
- **Stays out of the way.** No windows and next to no resources while idle. Every shortcut and option is yours to change.

## Licence

[MIT](LICENSE)
