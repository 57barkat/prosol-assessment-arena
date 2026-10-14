# ProSol Assessment Arena

A quiz web app with participant, admin and main console screens. A small Node.js server keeps quiz attempts in one shared JSON file so submissions from separate devices are visible to the admin and console.

## What is included

- Participant quiz screen with a floating personal timer.
- Light and dark mode switch on participant, admin and main console screens.
- Admin-controlled question count and quiz duration.
- Default sample mode: 5 random questions in 3 minutes.
- Main console showing only guidelines, group submission status and admin-approved group scores.
- Admin-only detailed participant results and answer review.
- Clean colour system with improved contrast in both light and dark modes.

## Run locally

Requires Node.js 20.6 or newer. Edit `.env` and replace the example `ADMIN_PASSWORD` with a unique password of at least 12 characters, then run:

```sh
npm start
```

Open `http://localhost:3000`. Do not open the HTML files directly or serve them with a static-only server: participant and admin screens use the API provided by `server.js`.

The `.env` file is for local development and is excluded from version control. On live hosting, set these values in the host's environment configuration instead; never upload your local `.env` file.

The server creates `data/assessment-state.json` automatically and writes participant answers, quiz settings, and score-release state there. Back up this file regularly. It must stay on persistent storage, and this JSON-file setup is intended for a single server instance.

## Live hosting

The current static-only HosterPK site cannot run the API or write shared files. Deploy the whole app on a Node.js-capable host with persistent disk storage, configure `ADMIN_PASSWORD` in the host's environment settings, and use HTTPS. Keep the `data` directory on persistent, private storage; do not publish the JSON file as a downloadable static asset. A multi-instance deployment needs a shared database instead of local JSON storage.

## Admin access

The admin password is configured only on the server with `ADMIN_PASSWORD`; it is no longer embedded in the public JavaScript or HTML. Admin sessions are stored in an HTTP-only cookie.

## Notes

- Settings apply to new participant attempts. Existing attempts keep the timer and question count that were active when they started.
- Participant submission unlocks after at least 70% of questions are answered.
- Old attempts saved only in individual browsers are not automatically migrated. New submissions are saved centrally and shared between devices.
