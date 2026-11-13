---
'@newrelic/preflight': patch
---

**A secret that crosses the 1 MB redaction limit is no longer stored in part.** Text over 1 MB is cut before it is redacted, so a token split by the cut no longer matched its pattern, and its first part was stored. The cut now also drops the word it splits. A PEM block whose end line falls past the cut is still stored up to the cut. A quoted value with a space that the cut splits reads as a quote that never closes, so its words after the first are still stored, as on main.
