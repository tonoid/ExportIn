# ExportIn privacy policy

Last updated: September 24, 2026

ExportIn is a Chrome extension published by tonoïd. It exports your LinkedIn connections, Facebook friends and Instagram mutuals, with their birthdays and contact details, to files on your computer.

## What the extension reads

When you press Start or Sync, ExportIn reads, from your own LinkedIn, Facebook and Instagram sessions:

- **On LinkedIn:** your connections' names, headlines, profile links, the date you connected, and what each connection shares in their Contact info panel: email, phone, birthday, website, address, Twitter and messaging handles. With the matching options on, it also reads their company, location, number of connections and About section.
- **On Facebook:** your friends' names, profile links, photos, birthdays (with the birth year when the friend shares it), gender and number of mutual friends.
- **On Instagram:** the accounts you follow and the accounts that follow you, to find the people who do both. For those mutuals only, it keeps their name, username, photo and profile link, and reads their public profile: bio, links, category and follower count.
- **Profile photos**, when you press Save photos.

To replay Facebook's own requests, the extension watches the GraphQL requests the Facebook page sends while a collection runs. It keeps them in memory in that tab only, never writes them to disk, and never sends them anywhere.

## Where it goes

Everything stays in your browser, in the extension's local storage (`chrome.storage.local`) and IndexedDB. It leaves your computer only when you export a file yourself.

ExportIn has no server. It sends nothing to tonoïd or anyone else: no analytics, no telemetry, no crash reporting, no AI service. The only sites it contacts are `linkedin.com`, `media.licdn.com`, `facebook.com`, `fbcdn.net`, `instagram.com` and `cdninstagram.com`, with your own session.

**Report a problem** opens a GitHub issue page in your browser with a prefilled report. That report holds counters only (extension version, network, interface language, how many requests succeeded), never a name, identifier or record. Nothing is sent until you submit the issue yourself on GitHub.

## Deleting your data

- **Clear stored data**, in the Export menu, deletes everything collected for the network on screen.
- **Reset everything**, at the top of the panel, deletes every network, the photos and the settings.
- Uninstalling the extension deletes all of it.

## Your responsibility

The data you export is other people's personal data. Once it is in your CRM or given to an AI service, you are responsible for it under the GDPR and similar laws.

## Contact

Questions: [open an issue](https://github.com/tonoid/ExportIn/issues) or see [tonoid.com](https://www.tonoid.com).
