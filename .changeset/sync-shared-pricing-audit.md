---
'@newrelic/preflight': minor
---

**Model pricing was refreshed, 1-hour cache writes and audio output are now costed, and OTLP over plain `http://` is limited to localhost.** The vendored shared library is synced from ai-telemetry.

- **Pricing corrections.** `claude-sonnet-5-5` cache reads bill at $0.10 per million tokens (was $0.20; on Bedrock $0.10 global / $0.11 geo). Bedrock `claude-haiku-5-5` prompts over 100k tokens bill cache writes at 5x the base rate. GPT-5.4, GPT-5.5 and GPT-5.6 cached input above 272k tokens bills at 2x the cached rate. Mistral Large 4 is back to its list price ($1.36 in / $4.18 out) now that the preview sale has ended. Gemini Robotics ER 2 bills cache reads.
- **New models priced.** Kimi K3.1 Pro and highspeed, Gemini 4 Argon, Gemini Robotics ER 2 streaming, and the legacy Bedrock Claude 3.5 Sonnet v1, 2.0, 2.1 and Instant.
- **1-hour cache writes.** Anthropic `cache_creation.ephemeral_1h_input_tokens` is read from usage and billed at the model's 1-hour rate (Anthropic direct and Bedrock Claude), instead of the 5-minute rate. Models with no 1-hour rate keep using the 5-minute rate.
- **Audio output.** Gemini audio output tokens are billed at the audio output rate where the model has one.
- **OTLP over `http://`.** An OTLP endpoint using plain `http://` is rejected unless it points at localhost. Before, private-network hosts were allowed and public hosts only logged a warning. Point non-local collectors at `https://`.
- **Model-name matching.** Stripping context-window suffixes such as `[1m]` from model names no longer backtracks on pathological input (CodeQL `js/polynomial-redos`).
