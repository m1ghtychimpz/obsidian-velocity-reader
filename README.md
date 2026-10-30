# Velocity Reader for Obsidian

**Velocity Reader** is a high-performance speed reading plugin for [Obsidian](https://obsidian.md). It enables rapid comprehension of text (from 50 to 3000 WPM) directly inside your vault with minimal cognitive fatigue and eye strain.

---

## Features

### 1. Two Reading Modes
- **RSVP / Prime Reader Mode (Word-by-Word):**
  - Displays one word at a time in a distraction-free viewport.
  - Implements **Optimal Recognition Point (ORP)** alignment (Spritz style): calculates the focal letter index (roughly 30–35% into the word) and anchors it precisely to a horizontal reticle. Your eyes never have to saccade horizontally across the word.
  - The focal letter is prominently highlighted in a customizable accent color.
- **Contextual Flow Mode (Multi-Paragraph with Saccadic Letter Bridging):**
  - Displays a clean window of 1 to 3 paragraphs at a time.
  - Dims non-active text (`opacity: 0.45`) to minimize peripheral clutter.
  - The active word $N$ is highlighted at full brightness with a soft pill background.
  - **Saccadic Edge Highlighting:** Softly highlights trailing characters of word $N-1$ and pre-highlights leading characters of upcoming word $N+1$ to naturally pull peripheral vision forward.
  - Zero layout shifts or vertical scrolling jitter.

### 2. High-Precision Timing Engine (50 – 3000 WPM)
- Built with `requestAnimationFrame` tracking elapsed high-resolution timestamps via `performance.now()` with sub-frame compensation to prevent drift even at 3000 WPM (20 ms per word).
- **Smart Micro-Pauses (Toggleable):**
  - Minor punctuation (`,`, `;`, `:`): **1.3x** duration.
  - Sentence endings (`.`, `!`, `?`): **1.6x** duration.
  - Long words (>10 characters): **1.2x** duration.

### 3. Deep Obsidian Integration
- **Left Ribbon Icon:** Click the speedometer (`gauge`) icon in the left ribbon to launch the reader immediately from anywhere.
- **Choose Any Note:** Easily pick and speed read any document from any folder in your vault using fuzzy search (via ribbon icon, command palette, or the `📂 Choose Note` button inside the reader).
- **Selection or Cursor:** Select any text to read it. If nothing is selected, reads the entire document or from cursor to end.
- **Markdown Cleaner:** Automatically strips markdown symbols (`**`, `*`, `#`, `>`, `==`, inline backticks, raw URLs) and resolves wikilinks `[[note|alias]]` to clean display text while preserving natural paragraph breaks.
- Native Obsidian design variables (`--background-primary`, `--interactive-accent`, etc.) for seamless Light and Dark mode adaptation on both Desktop and Mobile.

---

## Keyboard Controls

| Key | Action |
| :--- | :--- |
| **`Space`** | Play / Pause playback |
| **`Tab`** / **`M`** | Switch mode (RSVP ↔ Context Flow) |
| **`ArrowUp`** | Increase speed (+25 WPM) |
| **`ArrowDown`** | Decrease speed (-25 WPM) |
| **`ArrowLeft`** | Skip backward 10 words or to previous sentence |
| **`ArrowRight`** | Skip forward 10 words or to next sentence |
| **`Escape`** | Close reader modal |

---

## Installation

### Manual Installation
1. Download or copy `main.js`, `manifest.json`, and `styles.css`.
2. In your Obsidian vault, navigate to `.obsidian/plugins/`.
3. Create a new folder named `velocity-reader`.
4. Place the three files inside that folder.
5. In Obsidian, go to **Settings** → **Community plugins**, click **Reload**, and enable **Velocity Reader**.

### Building from Source
```bash
npm install
npm run build
```

---

## Settings
- **Default Reading Speed:** Set default WPM (50 – 3000 WPM).
- **Default Reading Mode:** Choose RSVP or Contextual Flow as your initial view.
- **Smart Micro-Pauses:** Toggle micro-pauses for punctuation and long words.
- **ORP Focal Letter Accent Color:** Customize the reticle focal letter color.
- **Font Sizes:** Individually configure RSVP and Contextual Flow font sizes.
- **Paragraphs per Page:** Display 1, 2, or 3 paragraphs at a time in Context Flow mode.

---

## License
MIT
