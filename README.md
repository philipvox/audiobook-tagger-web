# Audiobook Tagger Web

A browser-based metadata manager for [AudiobookShelf](https://www.audiobookshelf.org/). Pull your library, enrich metadata with AI, and push clean results back — all from your browser.

**100% client-side.** No backend server. Your API keys never leave your browser.

![React](https://img.shields.io/badge/React-18-blue)
![Vite](https://img.shields.io/badge/Vite-5-purple)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

### Library Management
- Pull entire library from AudiobookShelf via API
- Browse, search, filter, and multi-select books
- Edit metadata inline (title, author, narrator, series, genres, tags, description)
- Bulk edit multiple books at once
- Push updated metadata back to ABS

### AI-Powered Metadata
- **Metadata resolution** — Fix titles, subtitles, authors, series using AI
- **Classification** — Genres, tags, age ratings, and BookDNA fingerprints in one pass
- **Descriptions** — Validate, clean, or generate book descriptions
- **BookDNA** — Structured fingerprints with moods, spectrums, tropes, and comparable vibes
- **ISBN/ASIN lookup** and publication date correction

### AI Providers (bring your own key)
- **OpenAI** — GPT-5.4 Nano (recommended, ~$0.003/book), plus GPT-5 Nano, GPT-5.4 Mini, GPT-4o
- **Anthropic Claude** — Haiku 4.5 (fast/cheap), Sonnet 4.6

### Authors Tab
- Browse and analyze all authors in your library
- Detect duplicates, normalize names, fix descriptions
- Auto-merge duplicate authors

### Validation & Analysis
- Scan for metadata errors and warnings
- Series consistency analysis
- Author normalization detection
- Genre enforcement against approved taxonomy

### Additional Tools
- Cover art search and bulk assignment
- Export/import library data (CSV/JSON)
- Customizable AI prompts
- Performance presets for batch processing

## Quick Start

1. Visit the hosted app or deploy your own (see below)
2. Go to **Settings**:
   - Enter your AudiobookShelf server URL and API token
   - Add an OpenAI or Anthropic API key
   - Pick your AI model
3. Click the import button to pull your library
4. Select books, use the enrichment menu to process metadata
5. Push changes back to ABS

## Self-Hosting

### GitHub Pages (free)

Fork this repo and enable GitHub Pages — the included workflow auto-deploys on push.

### Any Static Host

```bash
git clone https://github.com/philipvox/audiobook-tagger-web.git
cd audiobook-tagger-web

npm install
npm run build
```

Serve the `dist/` folder with any static file server (Nginx, Caddy, Netlify, Vercel, etc.).

### Development

```bash
npm install
npm run dev
```

Open `http://localhost:5173`

## CORS Proxy

Your browser can't call your ABS server directly due to CORS. The app includes a Cloudflare Worker (`worker/`) that acts as a proxy.

To deploy your own:

```bash
cd worker
npx wrangler deploy
```

Set `ALLOWED_ORIGINS` in the worker's environment to restrict which domains can use it.

The app tries direct fetch first and falls back to the proxy only when needed.

## Architecture

```
Browser (static HTML/JS/CSS)
  ├── localStorage (config, API keys)
  ├── src/lib/ (prompts, normalize, genres, ABS client)
  └── Cloudflare Worker (CORS proxy)
       ├── -> User's ABS server
       ├── -> OpenAI API
       └── -> Anthropic API
```

**Frontend:** React 18, Vite, TailwindCSS, Lucide Icons

**Key directories:**
```
src/
  pages/          # ScannerPage, AuthorsPage, SettingsPage
  components/     # Modals, action bars, book list, metadata panel
  hooks/          # useAuthors, useAbsCache, useBatchOperations
  context/        # AppContext (global state)
  lib/            # ABS client, AI proxy, genres, normalization, prompts
worker/           # Cloudflare Worker CORS proxy
```

## Configuration

All settings are stored in browser `localStorage`. Nothing is sent to any server except:
- Your ABS server (to fetch/push metadata)
- OpenAI or Anthropic API (for AI enrichment)

Required:
- AudiobookShelf URL and API token
- At least one AI API key (OpenAI or Anthropic)

## License

MIT

## Acknowledgments

- [AudiobookShelf](https://www.audiobookshelf.org/) — Audiobook server
- [OpenAI](https://openai.com/) — GPT API
- [Anthropic](https://www.anthropic.com/) — Claude API
