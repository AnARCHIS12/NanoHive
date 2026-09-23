<img src="docs/nanohive-logo.png" width="88" align="right" alt="NanoHive">

# NanoHive Audiobookshelf Theme (Secure Edition)

A hardened, privacy-first reverse proxy that themes **Audiobookshelf Web** for every user.
No Tampermonkey, no per-browser setup: put it in front of your ABS server and it injects the theme into the pages it serves. Nothing touches your ABS container, remove the proxy and you're back to stock.

> [!NOTE]
> **NanoHive Secure Edition**:
> - **100% Offline / Zero External Leaks**: No external font requests (`fonts.googleapis.com` / `fonts.gstatic.com`), no external CDNs (`cdn.jsdelivr.net`), and no third-party cloud syncs.
> - **Attack Surface Reduction**: `abs-tract`, Goodreads background scraping, and Hardcover GraphQL relays have been completely removed.
> - **Privacy First**: Cross-user listening statistics, reading espionage, and inter-user progress scraping have been disabled.
> - **Hardened Container & Nginx**: Strict Content Security Policy (CSP), security headers (`X-Frame-Options`, `X-Content-Type-Options`), pinned dependencies, and non-privileged volume ownership.

|  |  |
|:--:|:--:|
| ![Home](docs/main.png) | ![Book details](docs/book.png) |
| ![Series](docs/series.png) | ![Collections](docs/collections.png) |
| ![Narrators](docs/narrators.png) | ![Server ranking](docs/ranking.jpg) |

## What you get

**Look & Personalization**
- Warm cinematic dark look, 12 base themes, any accent colour
- Native system typography with zero external network requests
- Real mobile layout: drawer nav, touch-friendly appbar, nothing overflows
- Home you can rearrange: hero carousel of your in-progress books, expanded Recent Series, a "Rate what you finished" row
- Custom local logo support: upload from settings or mount in `/data/nh/logo.png`

**Local Ratings & Reviews (Self-Hosted)**
- Internal stars and reviews on every book, shared locally on your server only
- Rate whole series
- Full, half or quarter star steps; podcasts excluded; per-library switches
- All data stored locally in `/data/nh/ratings.json`

**Finding things**
- Search all libraries at once
- One Filter & sort panel instead of ABS's two dropdowns: multi-level sort, stackable filters (genre, author, narrator, tag, year, progress, format, rating...), active choices as chips
- Per-user start page and theme preferences

**Rebuilt pages**
- Book page: HD cover, cinematic background, editable finished date
- Collections as instant icon grids, narrators and authors as proper cards
- Series covers show how far through you are

---

## Quick start

```yaml
services:
  audiobookshelf:
    image: ghcr.io/advplyr/audiobookshelf:latest
    restart: unless-stopped
    expose:
      - "80"

  abs-theme:
    image: ghcr.io/rodzalendo/nanohive-abs-theme:latest
    # Or build locally: build: .
    restart: unless-stopped
    depends_on:
      - audiobookshelf
    ports:
      - "13379:80"
    volumes:
      - nh_theme_data:/data/nh
    environment:
      ABS_UPSTREAM: "http://audiobookshelf:80"
      # NH_APP_NAME: "My Library"
      # NH_ACCENT_COLOR: "#e0c27a"
      # NH_BASE_THEME: "warm"

volumes:
  nh_theme_data:
```

Direct your reverse proxy (or browser) to port `13379` instead of ABS directly.

---

## Environment Variables

| Variable | Default | Description |
|:---|:---:|:---|
| `ABS_UPSTREAM` | **required** | Address of your Audiobookshelf server, e.g. `http://audiobookshelf:80` |
| `NH_APP_NAME` | *(empty)* | App title in the top-left corner |
| `NH_LOGO_URL` | *(empty)* | Custom logo image path or URL |
| `NH_SHOW_LOGO_TEXT` | `true` | Show the app name beside the logo |
| `NH_COLORIZE_LOGO` | `false` | Tint the logo with the accent |
| `NH_ACCENT_COLOR` | `#e0c27a` | Any hex colour |
| `NH_BASE_THEME` | `warm` | `warm` `slate` `black` `navy` `mocha` `pine` `plum` `crimson` `ocean` `sand` `steel` `wine` |
| `NH_MAIN_FONT` | `system-ui` | Typography stack (defaults to system UI font) |
| `NH_FONT_SCALE` | `1.0` | Global text scale |
| `NH_CAROUSEL_TIMING` | `15` | Seconds per hero slide, `0` = no auto-advance |
| `NH_SHOW_HERO_CAROUSEL` | `true` | Home hero carousel |
| `NH_SHOW_RECENT_SERIES` | `true` | Expanded Recent Series shelf |
| `NH_RECENT_SERIES_COUNT` | `12` | Series in that shelf |
| `NH_CUSTOM_SERIES_CARDS` | `true` | Stacked series covers, `false` = stock cards |
| `NH_SHOW_RATINGS` | `true` | Local book ratings |
| `NH_FOUC_BG` | `#181512` | Background before the theme loads, match your base theme |
| `NH_PROXY_BUFFER_SIZE` | `16k` | Nginx upstream header buffer |

---

## Security & Architecture

- **No Remote Calls**: The client browser never contacts Google Fonts, third-party CDNs, or external tracking services.
- **Server Authentication Verification**: Every request to `/_nh/api/` replays the client's Bearer token against Audiobookshelf's `/api/me` internal endpoint via Nginx `auth_request`.
- **Administrative Endpoints Protection**: Endpoints modifying global data (avatars, reports, server settings) are verified by checking against ABS's `/api/users` endpoint.
