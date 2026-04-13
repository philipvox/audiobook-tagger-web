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

### Docker (recommended for self-hosting)

```bash
git clone https://github.com/philipvox/audiobook-tagger-web.git
cd audiobook-tagger-web

docker compose up -d
```

Access at `http://localhost:8080`. To change the port, edit `docker-compose.yml`.

Or build and run manually:

```bash
docker build -t audiobook-tagger .
docker run -d -p 8080:80 --name audiobook-tagger audiobook-tagger
```

**Tip:** Self-hosting over HTTP means your ABS server can also be HTTP - no mixed content issues.

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

## CORS & Connectivity

Browsers block cross-origin requests by default (CORS). The app tries to connect to your ABS server directly first. If that fails due to CORS, it falls back to a Cloudflare Worker proxy.

**To avoid the proxy entirely**, enable CORS in ABS or your reverse proxy. This means your data goes straight from your browser to your server — nothing in between. The Settings page shows whether you're connected directly or via the proxy.

### Option 1: Enable CORS in AudiobookShelf (easiest)

ABS has built-in CORS support. In your ABS web UI:

1. Go to **Settings** (gear icon)
2. Find the CORS / allowed origins setting
3. Add the URL where you're running the tagger (e.g., `https://tagger.mysecretlibrary.com`)
4. Save

That's it — the app will connect directly to your server with no proxy involved.

### Option 2: Add CORS Headers to Your Reverse Proxy

If you prefer to configure CORS at the reverse proxy level instead:

**Caddy** (add inside your ABS site block):
```
header {
    Access-Control-Allow-Origin  https://tagger.mysecretlibrary.com
    Access-Control-Allow-Methods "GET, POST, PATCH, DELETE, OPTIONS"
    Access-Control-Allow-Headers "Authorization, Content-Type"
}
@options method OPTIONS
respond @options 204
```

**Nginx** (add inside your ABS `location /` block):
```nginx
add_header Access-Control-Allow-Origin "https://tagger.mysecretlibrary.com" always;
add_header Access-Control-Allow-Methods "GET, POST, PATCH, DELETE, OPTIONS" always;
add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;

if ($request_method = OPTIONS) {
    return 204;
}
```

**Traefik** (middleware label):
```yaml
labels:
  - "traefik.http.middlewares.abs-cors.headers.accesscontrolalloworiginlist=https://tagger.mysecretlibrary.com"
  - "traefik.http.middlewares.abs-cors.headers.accesscontrolallowmethods=GET,POST,PATCH,DELETE,OPTIONS"
  - "traefik.http.middlewares.abs-cors.headers.accesscontrolallowheaders=Authorization,Content-Type"
```

Replace the origin URL with wherever you host the app. Use `*` to allow any origin (less secure but simpler).

### Option 3: Deploy Your Own Proxy

If you can't modify ABS or your reverse proxy, deploy your own Cloudflare Worker (free tier):

```bash
cd worker
npx wrangler deploy
```

Set `ALLOWED_ORIGINS` in the worker's environment to restrict which domains can use it. Then set `VITE_PROXY_URL` when building the app to point to your worker.

### Option 4: Use the Default Proxy

The app ships with a default proxy. The proxy code is fully open source (`worker/index.js`, ~100 lines) — it forwards requests and returns responses, nothing is stored or logged. If you'd rather not trust a third party, use Option 1, 2, or 3.

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
