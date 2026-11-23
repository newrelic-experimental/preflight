---
'@newrelic/preflight': patch
---

**Antigravity calls from two conversations no longer pair with each other.** The collector set an Antigravity call's `toolUseId` to its `stepIdx`, which counts steps within one conversation, so two conversations can both have a step 3. An engine that drained both, such as a `--local` server, could pair one conversation's pre with the other's post, recording one call with the wrong tool, timing and session and the other as a timeout. The id is now `<conversationId>:<stepIdx>`, so it is unique across conversations, and `AiToolCall.tool_use_id` for Antigravity calls carries that form.
