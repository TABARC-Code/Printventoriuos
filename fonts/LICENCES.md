# Font licences

Printventory's stylesheet has always asked for **Inter** first and fallen back to whatever the operating system had, so the interface looked different on Windows, macOS and Linux (and in Docker, where there are usually no fonts at all). Inter is now bundled. It's self-hosted, so nothing is fetched from Google at runtime, which also matters for Server Mode on a machine with no internet.

| Family | Source | Copyright | Licence |
| --- | --- | --- | --- |
| Inter (variable, 100 to 900) | Google Fonts, downloaded 12 October 2026 | Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter) | SIL Open Font License 1.1, see [licences/Inter-OFL.txt](licences/Inter-OFL.txt) |

The licence text is the one in Google's own fonts repository (`ofl/inter/OFL.txt`). The OFL lets you use, copy and redistribute the font, commercial use included, as long as the copyright notice and licence text go with it. They do. The font can't be sold by itself, and a modified version mustn't reuse the name.

The file is the Latin subset exactly as Google serves it, about 48 KB. Accented Western European letters are in it. Characters outside it (Cyrillic, Greek, Vietnamese, Latin Extended such as Polish or Czech letters) fall back to the system font, which is what happened before. To add them, request the same family from Google Fonts and keep the extra subsets.
