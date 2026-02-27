# Food Otaku Map

This repo is a single-page map app for `rawdata.kmz`:
- 카테고리(Category)
- 장소명(Name)
- 좌표(Coordinate)
- 설명(Description)
- 유튜브 타임스탬프(YouTube timestamp)

## Run locally

```powershell
cd web
python -m http.server 8000
```

Open `http://localhost:8000`.

## Generate map data once from KMZ/KML

```powershell
.\scripts\build-places-from-kmz.ps1 -InputPath .\rawdata.kmz -OutputPath .\web\data\places.json
```

The app does **not** load `kmz` every visit.
It always uses `web/data/places.json` so updates only need this script when data changes.

### Data fields written to `places.json`

- `category`
- `name`
- `description`
- `lat`
- `lon`
- `youtubeUrl`
- `youtubeId`
- `youtubeStart` / `youtubeStartLabel`

## GitHub Pages deployment

1. Create a GitHub repository named `food-otaku-map`.
2. Push `main` branch from this directory.
3. `.github/workflows/deploy.yml` auto deploys `web` directory on each `main` push.

Current environment token cannot create the GitHub repo automatically, so remote creation must be done in your account once.

## Capture exact timestamp frames

After generating `web/data/places.json`, capture exact frames for each `youtubeStart`:

```powershell
python -m pip install imageio-ffmpeg
python scripts/capture-youtube-frames.py --force
```

The script writes frame images to `web/assets/frames/` and updates each place with `youtubeFrameImage`.
