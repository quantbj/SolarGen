# Deployment Guide

SolarGen is a static browser application. It does not need a server runtime, database, API key, or build pipeline. The deployed files are `index.html`, `styles.css`, `src/`, and `docs/`. Forecast data is fetched directly in the visitor browser from Open-Meteo.

## Recommended Host: Render

Render is the closest match to the requested `runner.com` style service. Use Render Static Sites, not a web service.

1. Push this repository to GitHub, GitLab, or Bitbucket.
2. In Render, choose **New > Static Site**.
3. Connect the repository and select the main branch.
4. Use these settings if Render does not import `render.yaml` automatically:
   - Build command: `true`
   - Publish directory: `.`
   - Auto deploy: enabled
5. After the first deploy, Render provides a public `onrender.com` URL.

`render.yaml` stores these settings as infrastructure-as-code for repeatable setup.

## Alternative: Netlify

Netlify can deploy the same files without changes.

1. Import the Git repository in Netlify.
2. Leave the build command empty or use no build command.
3. Set the publish directory to `.`.
4. `netlify.toml` already defines the publish directory and basic browser security headers.

## Alternative: GitHub Pages

GitHub Pages is also suitable for this static app.

1. Push the repository to GitHub.
2. Open repository **Settings > Pages**.
3. Select **Deploy from a branch**.
4. Choose the main branch and `/ (root)` as the folder.
5. Save and wait for the GitHub Pages workflow to publish the site.

The `.nojekyll` file tells GitHub Pages to serve the repository as plain static files.

## Pre-Deployment Checks

Run these commands before publishing:

```sh
npm run check
npm test
python3 -m http.server 4173
```

Then open `http://localhost:4173/` and verify that the status card reaches `Live forecast` or `Local fallback`. Do not use `file://` for final testing because Safari can block module or forecast requests from local files.

## Privacy and Data

The app has no account system and stores no personal data. It sends the configured forecast location and weather parameters to Open-Meteo from the browser. The default location is OHZ / Osterholz-Scharmbeck.
