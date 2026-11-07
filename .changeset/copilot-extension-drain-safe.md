---
'@newrelic/preflight': patch
---

**The Copilot SDK extension no longer loses a token line that races a buffer drain.** A line the extension wrote while a drain was reading the buffer could land in a file the drain then deleted, so the session under-reported token cost for that API call. The extension now writes through the same drain-safe writer as the collector. It is still one plain JavaScript file that users copy to `~/.copilot/extensions/preflight/extension.mjs`, now built from `src/hooks/copilot-sdk-extension.ts` by `npm run build:copilot-extension`.
