
# NZB Anime Seasonal

A local, mobile-first seasonal anime browser that pulls from AniList and lets you add series to Sonarr with one tap.

---

## ✨ Features

- Mobile UI for nzb360 integration
- Seasonal anime feed (AniList)
- Search by title, genres, and tags
- One-click add to Sonarr

---

## 🐳 Quick Start (Docker)

### 1. Clone the repo

```bash
git clone https://github.com/feliciacos/nzbaniseasonals
cd nzbaniseasonals
```

---

### 2. Create `.env`

Create a file called `.env` in the project root (or rename the .env-example to .env):

```env
SONARR_URL=http://YOUR_SONARR_IP:8989
SONARR_API_KEY=YOUR_API_KEY
SONARR_QUALITY_PROFILE_ID=1
SONARR_ROOT_FOLDER_PATH=YOUR_SONARR_ROOTFOLDER
SONARR_MONITOR_NEW_ITEMS=all
SONARR_SEASON_FOLDER=true
```

---

### 🔧 Environment Variables Explained

| Variable | Description |
|--------|------------|
| `SONARR_URL` | Full URL to your Sonarr instance (e.g. `http://x.x.x.x:8989`) |
| `SONARR_API_KEY` | Your Sonarr API key (Settings → General) |
| `SONARR_QUALITY_PROFILE_ID` | ID of the quality profile (usually `1` or your custom profile) |
| `SONARR_ROOT_FOLDER_PATH` | Root folder for anime (e.g. `/data/Anime`) |
| `SONARR_MONITOR_NEW_ITEMS` | What to monitor (`all`, `future`, etc.) |
| `SONARR_SEASON_FOLDER` | Whether to create season folders (`true` / `false`) |

---

### 3. Run with Docker

```bash
docker compose up --build
```

---

### 4. Open the app

http://localhost:8787

---

## 🧪 Development Notes

- The project uses a bind mount in Docker → no rebuild needed for changes
- If something looks outdated:
  - Hard refresh (`Ctrl + Shift + R`)
  - Or use incognito

---

## 🧠 How it works

- Anime data comes from **AniList (GraphQL API)**
- The app checks your **Sonarr library first**
- Matching uses:
  - English + Japanese titles
  - synonyms
  - alternate titles from Sonarr
- Adding:
  1. lookup in Sonarr
  2. select best match
  3. send add request to Sonarr

---

## 🧭 Using the Website

- Use **Last / Current / Next Season** buttons to browse
- Click **More** for:
  - season/year selection
  - search
  - sorting

- Click an anime:
  - opens detail page
  - shows full info
  - allows adding to Sonarr

- Button states:
  - `Add to Sonarr` → not added yet
  - `Added` → already in Sonarr
