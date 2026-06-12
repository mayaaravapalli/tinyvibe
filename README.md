# tinyroll

**Roll today's vibe.** One click, one mood, zero overthinking.

A sibling to [tinygoals](../tinygoals) and tinydecision — same neobrutalist shell, different gimmick.

## What it does

- Click **roll my vibe** to get a random daily mood (cozy goblin, main character, feral optimist, etc.)
- Each vibe includes a playful tagline and one tiny action for the day
- Tracks roll count, streak, and recent history in `localStorage`
- Rotating "tiny wisdom" footer copy

## Run locally

```bash
cd tinyroll
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Build

```bash
npm run build
npm run preview   # optional — serve the production build
```

## Stack

- Vite + React + TypeScript
- Geist + Geist Mono (`@fontsource-variable`)
- No UI libraries
