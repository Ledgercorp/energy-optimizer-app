# Energy Optimizer

A private, offline-first web app for planning thermostat schedules and understanding home electricity use.

**Open it:** https://ledgercorp.github.io/energy-optimizer-app/

## Privacy

- Everything you enter (settings, thermostat readings, imported usage files) is stored **only in your browser on your device**. There is no server, account, analytics or cookie.
- Usage files are read inside the browser and never uploaded.
- The page's Content-Security-Policy only allows requests to `api.weather.gov` (forecast) and `archive-api.open-meteo.com` (past temperatures), always for a fixed city-centre location.
- GitHub Pages and the weather services can see your IP address when the app loads, as with any website.

## Install on iPhone

1. Open the link above in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open **Energy** from the Home Screen. The installed app works offline and keeps its own data, separate from Safari.

The app only recommends settings; it never sends commands to a thermostat.
