'use strict'

// Explicit-config builds do not merge package.json's `build` object. Export
// only that object so beta builds inherit the exact stable files/signing/
// runtime payload without asking electron-builder to parse the whole package
// manifest as configuration.
const { publish: _stablePublish, ...betaBase } = require('./package.json').build
module.exports = betaBase
