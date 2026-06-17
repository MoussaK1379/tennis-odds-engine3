# Deuce — tennis match model

A surface-aware ATP/WTA match predictor. Pick two players, a surface, and a
format; it gives each player a win probability, fair (no-vig) decimal odds,
serve hold rates, and a quarter-Kelly stake suggestion against a price you
enter.

The model blends two views, 50/50:

- **Elo** — surface-specific ratings (Hard / Clay / Grass) built from match
  history, K-factor 32.
- **Serve model** — each player's serve points won on the surface, adjusted by
  the opponent's return strength, run through a Markov game → set → match
  calculation (includes a 7-point tiebreak).

## Files

| File | What it is |
|------|------------|
| `index.html` | The whole app. Self-contained, no build step. Reads `players.json`, falls back to a built-in seed if that file is missing. |
| `players.json` | The player field. Starts as a small seed and is **replaced with the full ATP + WTA field** the first time the updater runs. |
| `update_data.py` | Rebuilds `players.json` from Jeff Sackmann's public match data. Python 3.8+, no extra packages. |
| `.github/workflows/update.yml` | Runs the updater daily on GitHub's servers, commits the fresh `players.json`, which triggers a Netlify redeploy. |
| `netlify.toml` | Tells Netlify to serve the repo root with no build. |

## Why the live site only showed a handful of players

Netlify only serves static files — it cannot run `update_data.py`. So a
drag-and-drop deploy freezes `players.json` at the seed forever. The fix is to
let **GitHub** run the updater (it can reach the data) and have **Netlify deploy
from the GitHub repo**, so every refresh is published automatically.

## Deploy (all in the browser, no terminal)

1. **GitHub account** — sign up at github.com if you don't have one.
2. **New repo** — click `+` (top right) → *New repository*. Name it
   `tennis-site`, set **Public**, click *Create repository*.
3. **Upload files** — on the new repo page click *uploading an existing file*.
   Drag in everything from this folder, **including the hidden `.github`
   folder**. Commit.
   - Tip: if the `.github` folder is hard to drag on its own, upload the
     `update.yml` into a path named `.github/workflows/update.yml` using
     *Add file → Create new file* and pasting the path.
4. **Run the updater once** — open the **Actions** tab → enable workflows if
   prompted → click the **update** workflow → **Run workflow**. Wait ~1 minute;
   it commits a full `players.json`.
5. **Connect Netlify** — app.netlify.com → *Add new site* → *Import an existing
   project* → **GitHub** → authorize → pick `tennis-site`. Leave build settings
   default. Deploy.

After that it's hands-off: the Action refreshes data daily, pushes it, and
Netlify rebuilds. You get a new Netlify URL — delete the old drag-and-drop site
or point your custom domain at the new one.

## Run the updater yourself (optional)

```bash
python update_data.py            # last 8 seasons, ATP + WTA
python update_data.py --years 10 # steadier Elo
```

## Data / license

Match data: Jeff Sackmann / Tennis Abstract `tennis_atp` and `tennis_wta`,
licensed CC BY-NC-SA 4.0 (attribution, non-commercial). Keep this attribution if
you publish the site.

This is a model for learning and entertainment, not betting advice.
