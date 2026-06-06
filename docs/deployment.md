# Deployment Guide

SolarGen is deployed as a static GitHub Pages site. It does not need a hosted server runtime, database, API key, or build pipeline for the public browser app.

The deployed static files are:

- `index.html`
- `styles.css`
- `src/`
- `docs/`

The local SQLite history app is not deployed. It stays on this computer.

## Primary Host: GitHub Pages

1. Push the repository to GitHub.
2. Open repository **Settings > Pages**.
3. Select **Deploy from a branch**.
4. Choose the `main` branch and `/ (root)` as the folder.
5. Save and wait for the GitHub Pages deployment to complete.

The `.nojekyll` file tells GitHub Pages to serve the repository as plain static files.

Manual redeploy options:

```sh
git push origin main
gh run list --branch main --limit 5
gh run watch <run-id> --exit-status
```

## Static Runtime Dependencies

The browser forecast fetches:

- Open-Meteo forecast API;
- Open-Meteo DWD ICON API.

Both are public JSON APIs. The browser applies the same production-transfer structure as the local history app.

## Optional Hosts

Netlify can deploy the same files without changes:

1. Import the Git repository in Netlify.
2. Leave the build command empty or use no build command.
3. Set the publish directory to `.`.

`netlify.toml` defines the publish directory and basic browser security headers.

Render Static Sites can also serve the repository, but GitHub Pages is the active deployment path for this project.

## Pre-Deployment Checks

Run these commands before publishing:

```sh
npm run check
npm test
python3 -m http.server 4173
```

Then open `http://localhost:4173/` and verify that the status card reaches `Live forecast` or `Forecast offline`. Do not use `file://` for final testing because Safari can block modules or forecast requests from local files.

## Privacy And Data

The public app has no account system and stores no personal data. It sends the configured forecast location and weather parameters to Open-Meteo and Open-Meteo's DWD ICON endpoint from the browser.

The local history app and SQLite database are private local tooling and are not part of the static deployment.
