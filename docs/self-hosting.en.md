[日本語](self-hosting.md)

> This is a translation of [self-hosting.md](self-hosting.md) as of commit dfe60fe. If they differ, the Japanese version is authoritative.

# Running the app yourself

Anyone can run the Nostr-Rating app with their own GitHub account. GitHub Pages and GitHub Actions are free for public repositories, so it costs nothing.

An app you run yourself uses the same public relays unless you change the settings. So you can play against people using other URLs as they are.

## What you need

- A GitHub account
- A browser (you do not need to install anything locally)

## Steps

### 1. Fork the repository

Press "Fork" on the original repository's page to create a copy in your account. You may rename the repository. The app's URL will be `https://<account>.github.io/<repository>/`. If you name the repository `<account>.github.io`, it will be `https://<account>.github.io/`.

### 2. Enable GitHub Actions

In a forked repository, GitHub Actions starts disabled. Open the repository's "Actions" tab and press the button to enable it.

### 3. Choose the GitHub Pages source

Open "Settings" → "Pages" and choose "GitHub Actions" as the "Source" under "Build and deployment".

### 4. Deploy the app

On the "Actions" tab, choose "Deploy to GitHub Pages" and press "Run workflow". It finishes in a few minutes, and the app opens at the URL from step 1.

From then on, it is redeployed every time you push to the `main` branch.

### 5. Start the scheduled snapshots

On the "Actions" tab, choose "Snapshot" and press "Run workflow" once. From then on, every day at 5:00 (Japan time), matches past their deadline are tallied for each game. The snapshot parts are uploaded to Releases, the TOC is stacked in `snapshots/<game>/`, and GitHub Pages is redeployed. The app reads snapshots from your own Pages. Until a snapshot exists, it calculates from the start of the current season.

Part releases (`snapshot-<game>-…`) increase by one per game every day. Do not delete them: if you do, snapshots that point to that release can no longer be continued. Keep the repository public. If it is private, Actions cannot fetch the previous parts from Releases.

GitHub disables scheduled runs in repositories with no activity for 60 days. If that happens, enable it again from "Snapshot" on the "Actions" tab.

### 6. Release the recovery tool

On the "Actions" tab, choose "Recovery tool" and press "Run workflow". Enter a tag (for example `recovery-v1`), and the recovery tool (`nostr-rating-recovery.html`) is built and attached to a release. Publishing the release also rebuilds GitHub Pages, and the download links in the app and Help point to the newest recovery tool release. Recovery tool releases are not marked "Latest", so you can keep publishing other releases, such as the app, as before.

The recovery tool is a file meant to be opened outside the normal app. Do not put it on GitHub Pages.

## Things to watch out for

### Do not change the settings if you want to play with others

If you change `configs/relays.json` (the relay list) or the game definitions (`configs/<game>.json` for the games in `configs/games.json`), you may no longer be able to play with people on other URLs, or the rating calculations may stop matching. Leave them as they are unless you want to play by your own rules.

### Sharing an origin with your account's other Pages

All pages under `<account>.github.io` are the same place (origin) to the browser. The app's device key is stored per origin. Do not publish pages you have not checked under the same account; they could use your key. If you are concerned, create a GitHub account dedicated to this app or set up your own domain.

### Pulling in changes from the original repository

Changes to the original repository do not arrive in your fork automatically. You can pull them in with GitHub's "Sync fork", but check what the changes are before you do. You are the one who decides what code is served from your URL.

### Renaming or deleting your account

Renaming your account changes the app's URL too. Device keys stored at the old URL can no longer be used, so register the new URL as a device before renaming (the same steps as "運営やアプリの URL が変わったとき" (when the operator or the app's URL changes) in Help). If you delete your account and someone else takes the name, they can serve pages at the old URL. Revoke the devices you were using.
