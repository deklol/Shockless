Shockless Engine Source
=======================

This folder contains the Shockless engine source and standalone importer source used by Shockless.

License: GNU Affero General Public License v3.0.

Build:

  npm install
  npm run build
  cd standalone
  npm install
  npm run compile

The standalone compile step generates dist/main/cli/profile-import.js and the browser/runtime assets that Shockless packages into its portable Import/Build Client flow.

Generated clients, local caches, extracted reference corpora, and direction notes are not included in this public release.
