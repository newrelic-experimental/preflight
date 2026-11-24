---
'@newrelic/preflight': patch
---

A call made before its session id is known is now counted even when the engine waits more than 5 minutes to adopt its session. While its id is pending, an engine writes a `pending-<pid>.pid` marker to the storage directory, and cleanup leaves the no-session buffer alone while any such marker names a live process. Before, cleanup archived that buffer after 5 minutes without writes, and the engine adopted its session without ever counting the call. With no live pending engine, cleanup still archives the buffer after 5 minutes, and it removes markers whose process has exited.
