# Düsseldorf appointment watcher

This project automates checking appointment availability on the Düsseldorf appointment portal. You navigate manually to the appointment time page; the script keeps that session active, selects the earliest visible slot, fills the form using your local profile, and submits the reservation. The user will be informed of a successful booking via an email notification sent from the website.

## Prepare the environment

1. Install a current [Node.js LTS release](https://nodejs.org/) with npm. In a terminal, verify the installation with `node --version` and `npm --version`.
2. Open a terminal in this `outputs` folder and install the project dependencies:

   ```sh
   npm install
   ```

   Playwright is installed as a project dependency. The script uses the installed Google Chrome when available; otherwise Playwright uses its configured Chromium browser.
3. Create `personal-data.json` in this folder using the required fields and date format below. Keep the file private: it contains personal information and is excluded from git.
4. Start the script with `npm start`. On the first run, allow the browser to open and use it to navigate manually to the desired appointment request and then to `/suggest`. Return to the same terminal and press Enter.

### Personal data file

Use this JSON structure, replacing the example values with your own:

```json
{
  "salutation": "Herr",
  "firstName": "Max",
  "lastName": "Mustermann",
  "email": "max@example.com",
  "phone": "",
  "birthDate": {
    "day": "1",
    "month": "1",
    "year": "1990"
  }
}
```

`salutation` must match one of the choices shown on the form. The day and month are separate fields; use a four-digit year. Phone is optional.

## Run

The script checks once per minute and reloads the same page/session to keep it active. When it finds a visible slot, it selects the earliest one, clicks a visible `Ja` confirmation button if present, fills the form, and marks the data-processing consent. Before clicking `Reservieren`, it verifies that the summary is either the test case with Bürgerbüro and `Einwohnerangelegenheiten / Personalausweis - Antrag` or the target `Fahrerlaubnisbehörde / Umschreibung ausländischer Führerschein (EU+EWR)`. Other services are blocked.

After `Reservieren`, check the portal and email for confirmation. The browser remains open. You can manually cancel the test case through email.

The browser session is stored in `browser-profile/` so it can persist between runs. Both that folder and `personal-data.json` are excluded by `.gitignore`; keep them private.
