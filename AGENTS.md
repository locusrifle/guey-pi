# Working on Guey

Read README.md, docs/architecture.md and CONTRIBUTING.md. This repository contains the stock Guey GUI and an experimental personal composition sharing one runtime implementation. Stock defaults must not require the personal composition's services or configuration.

Use the pinned Pi SDK's installed documentation when changing SDK or extension integration. Pi owns the agent loop and session persistence. Browser disconnect must not stop an agent; terminal watching must not create a second session writer.

Run `npm run test:all`; packaging changes also require a rebuilt archive and `npm run test:desktop`. Use isolated temporary directories and fake providers, not a maintainer's running session or credentials. Report browser skips and failures accurately. A server restart ends an active turn.

Keep credentials, session transcripts, recordings, generated state and local deployment instructions out of commits. Original code is MIT licensed; retain third-party notices. Public source, GitHub releases and package-registry listing are separate from building an archive.
