# Font licences

Printventory's stylesheet has always asked for **Inter** first and fallen back to whatever the operating system had, so the interface looked different on Windows, macOS and Linux (and in Docker, where there are usually no fonts at all). Inter is now bundled, along with two reading-friendly alternatives offered in **Display and accessibility**. Everything is self-hosted, so nothing is fetched from Google at runtime, which also matters for Server Mode on a machine with no internet.

| Family | Used for | Copyright | Licence |
| --- | --- | --- | --- |
| Inter (variable, 100 to 900) | The standard interface font | Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter) | SIL OFL 1.1, [licences/Inter-OFL.txt](licences/Inter-OFL.txt) |
| Atkinson Hyperlegible (regular, bold, italics) | The "Easy-read" font choice | Copyright 2020 Braille Institute of America, Inc. | SIL OFL 1.1, [licences/Atkinson-Hyperlegible-OFL.txt](licences/Atkinson-Hyperlegible-OFL.txt) |
| Lexend (variable, 100 to 900) | The "Lexend" font choice | Copyright 2018 The Lexend Project Authors (https://github.com/googlefonts/lexend), Reserved Font Name "RevReading Lexend" | SIL OFL 1.1, [licences/Lexend-OFL.txt](licences/Lexend-OFL.txt) |

All three were downloaded from Google Fonts on 12 October 2026; the licence texts are the ones in Google's own fonts repository (`ofl/<family>/OFL.txt`). The OFL lets you use, copy and redistribute the fonts, commercial use included, as long as the copyright notice and licence text go with them. They do. A font can't be sold by itself, and a modified version mustn't reuse a reserved name.

The files are the Latin subset exactly as Google serves them (Inter about 48 KB, Atkinson about 71 KB for all four styles, Lexend about 40 KB). Accented Western European letters are covered. Characters outside it (Cyrillic, Greek, Vietnamese, Latin Extended such as Polish or Czech letters) fall back to the system font, which is what happened before. A browser only downloads Atkinson or Lexend if one of them is actually chosen. To add more scripts, request the same family from Google Fonts and keep the extra subsets.
