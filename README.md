## Screenshots
# Homepage
<img width="1491" height="939" alt="image" src="https://github.com/user-attachments/assets/d26d58df-384a-4d5e-92f1-b77786b6247f" />
# Anime Page
<img width="1504" height="1168" alt="image" src="https://github.com/user-attachments/assets/9c8bd795-563a-456e-9d7b-4a8023037815" />
# Filters
<img width="1498" height="1096" alt="image" src="https://github.com/user-attachments/assets/bf6d325a-810f-40ab-8e10-150ecfa29cdb" />

# NZB Anime Seasonal

A local, mobile-first seasonal anime browser that pulls from AniList and lets you add series to Sonarr and movies to Radarr with one tap.

---

## Features

- Mobile UI for nzb360 integration
- Seasonal anime feed (AniList)
- Search by title, genres, and tags
- One-click add to Sonarr (TV)
- One-click add to Radarr (Movies)
- Library detection (Sonarr + Radarr)

---

## Quick Start (Docker)

### 1. Clone the repo

```bash
git clone https://github.com/feliciacos/nzbaniseasonals
cd nzbaniseasonals
```

---

### 2. Create `.env`

Create a file called `.env` in the project root (or rename the .env-example to .env):

```env
# Sonarr
SONARR_URL=http://YOUR_SONARR_IP:8989
SONARR_API_KEY=YOUR_API_KEY
SONARR_QUALITY_PROFILE_ID=1
SONARR_ROOT_FOLDER_PATH=YOUR_SONARR_ROOTFOLDER
SONARR_MONITOR_NEW_ITEMS=all
SONARR_SEASON_FOLDER=true

# Radarr
RADARR_URL=http://YOUR_RADARR_IP:7878
RADARR_API_KEY=YOUR_API_KEY
RADARR_QUALITY_PROFILE_ID=1
RADARR_ROOT_FOLDER_PATH=YOUR_RADARR_ROOTFOLDER
```

---

### Environment Variables Explained
## Sonarr
| Variable                    | Description                      |
| --------------------------- | -------------------------------- |
| `SONARR_URL`                | Full URL to your Sonarr instance |
| `SONARR_API_KEY`            | Your Sonarr API key              |
| `SONARR_QUALITY_PROFILE_ID` | Quality profile ID               |
| `SONARR_ROOT_FOLDER_PATH`   | Root folder for anime            |
| `SONARR_MONITOR_NEW_ITEMS`  | What to monitor                  |
| `SONARR_SEASON_FOLDER`      | Create season folders            |

## Radarr
| Variable                    | Description                      |
| --------------------------- | -------------------------------- |
| `RADARR_URL`                | Full URL to your Radarr instance |
| `RADARR_API_KEY`            | Your Radarr API key              |
| `RADARR_QUALITY_PROFILE_ID` | Quality profile ID               |
| `RADARR_ROOT_FOLDER_PATH`   | Root folder for movies           |
| `RADARR_MONITOR_NEW_ITEMS`  | What to monitor                  |

---

### 3. Run with Docker

```bash
docker compose up --build
```

---

### 4. Open the app

http://localhost:8787

---

## Development Notes

- The project uses a bind mount in Docker → no rebuild needed for changes
- If something looks outdated:
  - Hard refresh (`Ctrl + Shift + R`)
  - Or use incognito

---

## How it works

- Anime data comes from **AniList (GraphQL API)**
- The app checks your Sonarr and Radarr libraries
- Matching uses:
  - English + Japanese titles
  - Synonyms
  - Alternate titles
- Adding:
  1. Lookup in Sonarr / Radarr
  2. Select best match
  3. Send add request

---

## Using the Website

- Use **Last / Current / Next Season** buttons to browse
- Click **More** for:
  - Season/year selection
  - Search
  - Sorting
- Click an anime to open the full details page, shows description and other information, this page also allows adding to Sonarr/Radarr.
