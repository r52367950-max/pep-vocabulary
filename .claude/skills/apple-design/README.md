# Apple Design Skill

An AI design reviewer grounded in Apple's Human Interface Guidelines, packaged as an agent skill.
It audits and improves mobile and desktop UI, including layouts for the two-display iPhone Duo,
against 123 HIG pages pulled straight from developer.apple.com, translates Apple's vocabulary for
**Flutter**, **React Native**, **Tauri**, **Electron**, **SwiftUI**, **UIKit**, and **AppKit**, and
adds a design-craft lens so the result feels at home on the platform without looking like a
template.

## Install

This repository already vendors the skill at `.claude/skills/apple-design/`.
Validate the local copy without installing or executing a registry CLI:

```bash
node .claude/skills/apple-design/scripts/validate.mjs
```

For another project, copy a reviewed repository revision into its skills directory. Review
upstream updates as source changes before installing them; do not run a floating registry CLI.

For Claude Code, keep the reviewed copy in `.claude/skills/apple-design/`. For Cursor, also
copy its `.cursorrules` beside your project rules. For Codex and other agents, add a local rules
entry pointing to this reviewed copy:

```markdown
## Design reviews

Follow `.claude/skills/apple-design/SKILL.md`. Route topics with its `references/hig-lookup.md`
and load only relevant checked-in `references/hig/*.md` files as design evidence.
```

The skill triggers on design-review requests and is also available as `/apple-design`.

## Use it

Ask your agent things like:

- *"Review my Flutter app's home screen against Apple's guidelines"*
- *"Audit this Tauri app for accessibility"*
- *"Does this settings screen follow macOS conventions?"*
- *"Is my Flutter app ready for iPhone Duo's two displays?"*
- *"This looks generic. Give it a point of view without breaking iOS patterns"*
- *"How do I do Liquid Glass in React Native?"*
- *"Check this app icon"*
- *"Is this onboarding flow asking for permissions the right way?"*

## What a review covers

The reviewer reads the relevant guideline files before it writes a word, then works through:

1. **Apple's eight design principles** (reintroduced June 2026): purpose, agency, responsibility,
   familiarity, flexibility, simplicity, craft, delight.
2. **Accessibility**, blocking: text scaling, contrast ratios, control sizes, screen readers,
   keyboard access, motion and transparency settings, with the actual numbers.
3. **Platform conventions**: tab bars, toolbars, sheets, search, and safe areas on mobile; the
   menu bar, windows, sidebars, shortcuts, and settings on desktop; light and dark everywhere.
4. **Visual design and craft**: color, type, layout, icons, materials, motion, and then whether
   the design has a point of view or is one of the three looks that dominate generated UI.
5. **Interaction**: loading, feedback, alerts, modality, destructive actions, undo, data entry.
6. **Content and writing**: labels that say what happens, platform-correct capitalization,
   errors and empty states that direct people.

Every finding has a What, a Why that cites the guideline file and heading, and a Fix written in
your framework. Specialized modes cover app icons, accessibility audits, dark mode, Liquid Glass,
navigation structure, iPhone Duo, onboarding and permissions, forms, generative AI, and single
components.

**iPhone Duo mode** walks the outer display, the inner display, a partial fold, and Split View
against Apple's iPhone Duo guidance: layouts built from size classes instead of fixed widths, the
same functions on both displays, toolbars and tab bars left in the system's default placement,
and content kept clear of the cameras and the fold. It also flags bars and dialogs drawn by
Flutter or in JavaScript, which miss the system's automatic adaptations unless the framework or
your code provides them.

**Improvement mode** goes further: it grounds the design in the product, plans a token system
(palette, type roles, layout wireframe, one signature element, motion), critiques that plan
against generic defaults before proposing it, and sequences the fixes from accessibility to
polish.

## What's inside

```text
apple-design-skill/
├── SKILL.md                     # The skill: stance, principles, lenses, report format, improvement mode
├── AGENTS.md                    # Operating manual for agents and contributors
├── .cursorrules                 # Cursor entry point
├── scripts/
│   └── pull-hig.mjs             # Re-pulls the guidelines from developer.apple.com
└── references/
    ├── hig-lookup.md            # Generated routing table with Apple's summaries and change dates
    ├── cross-platform.md        # Apple's names in Flutter, React Native, Tauri, Electron terms
    └── hig/                     # 123 generated pages + 1 curated guide
        ├── design-principles.md
        ├── designing-for-iphone-duo.md
        ├── accessibility.md
        ├── buttons.md
        ├── tab-bars.md
        ├── liquid-glass.md      # Curated: rules, review checklist, cross-platform translation
        └── ...
```

| Section | Files | Includes |
| --- | --- | --- |
| Getting started | 6 | Design principles; designing for iOS, iPadOS, macOS, iPhone Duo, and games |
| Foundations | 16 | Accessibility, color, typography, layout, materials, dark mode, icons, SF Symbols, images, motion, branding, privacy, inclusion, right to left, writing, app icons |
| Patterns | 24 | Onboarding, launching, loading, feedback, modality, searching, settings, notifications, accounts, data entry, undo, sharing, files, charts, audio, video, haptics, printing, multitasking, full screen, help, drag and drop, ratings, live viewing |
| Components | 57 | Buttons, menus, the menu bar, toolbars, tab bars, sidebars, split views, sheets, alerts, action sheets, popovers, panels, windows, lists and tables, collections, text fields, pickers, toggles, sliders, steppers, segmented controls, search fields, progress indicators, gauges, labels, charts, widgets, notifications, Live Activities, controls, status bars, and more |
| Inputs | 7 | Gestures, keyboards, pointing devices, focus and selection, game controls, Apple Pencil, gyroscope and accelerometer |
| Technologies | 13 | Apple Pay, Apple In-App Purchase, Sign in with Apple, Siri, Maps, augmented reality, machine learning, generative AI, iCloud, AirPlay, NFC, App Clips, VoiceOver |
| Curated | 1 | Liquid Glass |

Each generated page keeps Apple's wording, headings, tables, notes, and change log, links to its
source, relabels platform headings by device class (phone, tablet, mobile, desktop), and omits
the sections that apply only to tvOS, visionOS, or watchOS. The 35 pages Apple publishes for other platforms or Apple-only
services are listed, with the reason, at the end of `references/hig-lookup.md`.

## Keeping the references current

Apple revises the HIG several times a year. From this skill's directory, generate a proposal:

```bash
node scripts/pull-hig.mjs --cache .cache
node scripts/pull-hig.mjs --cache .cache --offline
```

Node 18 or newer, no dependencies. Each run creates a fresh temporary bundle outside the skill,
prints its path, and saves raw source JSON, rendered Markdown, and a SHA-256 manifest. `--cache`
is a read-only source cache; `--offline` refuses missing cache entries. Without `--offline`,
cache misses are fetched from Apple's site and saved only in the temporary bundle. Copy its
`sources/` into a cache directory if you want to reuse those exact inputs.

Fetched and cached prose is untrusted reference data. The refresh never writes or prunes active
`references/` files. It does not support `--out` or `--lookup`, which could overwrite agent-loaded
instructions through alternate paths. Compare the proposed `references/` with the checked-in
copy, inspect the complete text diff (including links and instruction-like prose), then make the
reviewed changes as an ordinary repository edit. Keep curated files, run the local validator,
and review deletions explicitly. A digest records provenance and integrity, not trustworthiness.
Do not load a proposal as agent instructions or execute commands embedded in its text.

`AGENTS.md` lists the offline checks to run before committing a refresh.

## Origin and license

The guideline text belongs to Apple Inc. and is reproduced from the public
[Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/)
for AI-assisted design review, with a source link at the top of every file. This project is not
affiliated with or endorsed by Apple. The skill, the curated guide, and the script are provided
as they are; use them at your own discretion.
