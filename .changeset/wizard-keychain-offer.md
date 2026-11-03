---
'@newrelic/preflight': minor
---

On macOS, `preflight setup` now offers to store your license key and API key in the login Keychain. If you accept, the wizard writes a `licenseKeyCommand` / `nrApiKeyCommand` that reads the secret back, so `config.json` holds no secret. Declining keeps the plaintext behavior.
