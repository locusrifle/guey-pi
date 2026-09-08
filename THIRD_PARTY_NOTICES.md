# Third-party notices

Guey is MIT licensed. Third-party components keep their own licenses; MIT does not replace them.

## Assets committed to this repository

| Component | Location | License / source |
| --- | --- | --- |
| Commit Mono | `native/public/fonts/CommitMono-400-Regular.otf` | MIT, © 2023 Eigil Nikolajsen. [License](licenses/CommitMono-MIT.txt), [upstream](https://github.com/eigilnikolajsen/commit-mono). |
| Departure Mono | `native/public/fonts/DepartureMono-Regular.woff2` | MIT, © 2024 Helena Zhang & Tobias Fried. [License](licenses/DepartureMono-MIT.txt), [upstream](https://github.com/rektdeckard/departure-mono). |
| html2canvas 1.4.1 | `native/public/js/html2canvas.esm.js` | MIT. [License](licenses/html2canvas-MIT.txt), [upstream](https://github.com/niklasvh/html2canvas). |
| html2canvas-pro | `native/public/js/html2canvas-pro.esm.js` | MIT. [License](licenses/html2canvas-pro-MIT.txt), [upstream](https://github.com/yorickshan/html2canvas-pro). |
| noVNC 1.7.0 | `native/public/vendor/novnc/` | Primarily MPL-2.0; individual files have their own notices. [License inventory](native/public/vendor/novnc/LICENSE.txt), [authors](native/public/vendor/novnc/AUTHORS), [upstream source](https://github.com/novnc/noVNC). |
| pako (noVNC vendor copy) | `native/public/vendor/novnc/vendor/pako/` | MIT/Zlib; [license](native/public/vendor/novnc/vendor/pako/LICENSE). |

The font license texts were retrieved from upstream on 2026-09-08: Commit Mono commit `d407cd2bf8e01ca1db70544052fbbb9606406c3b`, Departure Mono commit `75152a3f1e6dacdd248a6c397c97dbf27e33eea0`. These identify the inspected license sources, not a claim that the local font binaries were built from those commits.

The original personal keyboard sound is excluded because redistribution provenance was unavailable. No Pi website logo, website JavaScript or proprietary website fonts are included.

## Installed dependencies

`package-lock.json` records the resolved dependency graph. The desktop archive includes production dependencies and their accompanying license files, plus source checksums. Notable dependencies include the Pi SDK (`@earendil-works/pi-coding-agent`, MIT), `@earendil-works/pi-server` (MIT) and `ws` (MIT). Playwright (Apache-2.0) is a development dependency and is not included in the desktop runtime archive.

Consult each package's notices for transitive dependencies. Browser binaries, Node.js and model weights are not bundled. Pi and provider names identify interoperability, not affiliation or endorsement.
