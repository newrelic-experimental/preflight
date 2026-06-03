<!--
Template for Wave-N release announcements + demo scripts.

Replace every {{PLACEHOLDER}} below. Delete any guidance comments (like this one)
once filled in. Past examples in git history: search `docs/DEMO_AND_ANNOUNCEMENT*.md`
on commits 877debb (Wave 1+2), 09d910a (Wave 3), 41bf692 (Wave 4).

Conventions observed across waves 1–4:
- Wave 1 introduces the project to a cold audience (longer setup).
- Waves 2+ assume returning audience and open with one-line "if you haven't seen
  the earlier demos…" recap, then go straight to features.
- Each feature gets a numbered Slack bullet AND a timed demo segment in the same
  order. Keep the numbering consistent between the two sections.
- Slack message ends with build/test/lint status one-liner + sign-off.
- Demo total runtime scales with feature count: ~2-3min (Wave 1, 1 topic),
  ~3-4min (Wave 2, 5 features), ~4-5min (Waves 3-4, 4-6 features).
-->

# NR AI Coding Observability — Wave {{WAVE_NUMBER}} Slack Message & Demo Script

---

## Slack Message (Team Dev Channel)

> Hey team :wave:
>
> Wave {{WAVE_NUMBER}} of the NR AI Coding Observability just landed. {{ONE_LINE_THEME — e.g. "Four new features this time, all centered on a single theme: making the observatory personal." or "Six new roadmap items shipped this week, plus a round of pricing engine fixes."}}
>
> **What shipped:**
>
> **1. {{FEATURE_1_TITLE}}** — {{FEATURE_1_DESCRIPTION. 2-4 sentences. If there's a code or config snippet that makes the feature concrete, embed it inline:}}
> ```
> {{optional code/config block}}
> ```
> {{Continue prose if needed — explain the *why* (what problem it solves) not just the *what*.}}
>
> **2. {{FEATURE_2_TITLE}}** — {{FEATURE_2_DESCRIPTION}}
>
> **3. {{FEATURE_3_TITLE}}** — {{FEATURE_3_DESCRIPTION}}
>
> **4. {{FEATURE_4_TITLE}}** — {{FEATURE_4_DESCRIPTION. The last (or most interesting) feature is often the "hero" — give it slightly more space and a sample of its output if it's user-facing:}}
> ```
> {{optional sample output}}
> ```
> {{Closing thought on why this one matters.}}
>
> **All {{FEATURE_COUNT}} features are in one PR. Build is green, {{TEST_COUNT}}+ tests, lint clean.**
>
> {{ONE_LINE_CALL_TO_ACTION — e.g. "The personal coaching report is probably the most interesting to demo — happy to walk anyone through it." or "The setup wizard is the most immediately useful thing for anyone who wants to try this."}}
>
> — @{{SLACK_HANDLE}}

---

## Demo Video Script ({{TARGET_RUNTIME_MIN}}-{{TARGET_RUNTIME_MAX}} minutes)

### Opening (15 seconds)

**[Screen: Terminal with Claude Code open]**

"{{NAME}} here. Wave {{WAVE_NUMBER}} of the NR AI Coding Observability — {{ONE_LINE_THEME_RESTATED}}. {{OPTIONAL: 'Quick disclaimer:' or 'If you haven't seen the earlier demos, short version: it's an MCP server that ships AI coding assistant telemetry to New Relic.'}}"

---

### Feature 1 — {{FEATURE_1_TITLE}} ({{SECONDS}} seconds)

**[Screen: {{SCREEN_DESCRIPTION — e.g. "Terminal — `nr_observe_get_session_stats` output", "NR One — dashboard opens", "`~/.nr-ai-observe/config.json`"}}]**

"{{NARRATION — set up the problem this feature solves in 1-2 sentences.}}"

"{{NARRATION — show the solution in action.}}"

**[Show {{WHAT_TO_HIGHLIGHT}}]**

```
{{optional code/config/output block}}
```

"{{NARRATION — close the loop on what the viewer just saw.}}"

---

### Feature 2 — {{FEATURE_2_TITLE}} ({{SECONDS}} seconds)

**[Screen: {{SCREEN_DESCRIPTION}}]**

"{{NARRATION}}"

```
{{optional command or config}}
```

**[Screen: {{NEXT_SCREEN}}]**

"{{NARRATION}}"

---

### Feature 3 — {{FEATURE_3_TITLE}} ({{SECONDS}} seconds)

**[Screen: {{SCREEN_DESCRIPTION}}]**

"{{NARRATION}}"

---

### Feature 4 — {{FEATURE_4_TITLE}} ({{SECONDS}} seconds)

<!-- Reserve the most time for the "hero" feature. Lead with the output, then explain. -->

**[Screen: {{SCREEN_DESCRIPTION}}]**

"{{HOOK — say upfront why this is the most interesting one.}}"

**[Show the output]**

```
{{sample output — make it feel real, not synthetic}}
```

"{{NARRATION — read or paraphrase the output, then explain what it tells you that you couldn't see before.}}"

**[Pause on {{KEY_DETAIL}}]**

"{{NARRATION — slow down on the most surprising/insightful piece.}}"

"{{NARRATION — caveats, prerequisites, or follow-up commands. Often the place to mention required setup, e.g. backfill scripts, minimum data history, env vars.}}"

```bash
{{optional follow-up command}}
```

---

### Putting It Together (20 seconds)

**[Screen: {{FINAL_HERO_SHOT — usually a dashboard or the headline output}}]**

"So: Wave {{WAVE_NUMBER}} is {{FEATURE_COUNT}} features that work together. {{ONE_SENTENCE_PER_FEATURE_RECAP}}."

"{{BIGGER_PICTURE — connect this wave to the project's overall direction.}}"

---

### Close (15 seconds)

**[Screen: {{CLOSING_SCREEN}}]**

"That's Wave {{WAVE_NUMBER}}. {{TOP_RECOMMENDATION_FOR_VIEWER — what should they try first?}}. Code is open inside the org. Thanks for watching."

---

## Production Notes

- **Total runtime target:** ~{{TARGET_RUNTIME}}
- **Screen recording tool:** QuickTime or OBS (terminal + browser side by side)
- **Key NRQL queries to have ready:**
  - `{{NRQL_QUERY_1}}`
  - `{{NRQL_QUERY_2}}`
  - `{{NRQL_QUERY_3}}`
- **MCP tools to demo (in order of impact):**
  - `{{TOOL_1}}` — {{why this one}}
  - `{{TOOL_2}}` — {{why this one}}
- **Dashboards to have open:**
  - {{DASHBOARD_1}} — {{notes, e.g. "deploy with --developer before recording"}}
  - {{DASHBOARD_2}}
- **Alert policy to have open:**
  - {{POLICY_NAME}} — {{notes, e.g. "having one condition in 'warning' state during the demo makes the story more concrete"}}
- **Before recording:**
  - {{PRECONDITION_1 — e.g. "Ensure at least 2 weeks of real session data so X tool returns a real result"}}
  - {{PRECONDITION_2 — e.g. "Set sessionCostUsd low enough that it's near the threshold during the demo"}}
  - {{PRECONDITION_3 — e.g. "Run backfill script if local session files are missing"}}
- **Tips for live walkthroughs:**
  - {{TIP_1 — e.g. "Lead with the hero feature if the audience already knows what the observatory does"}}
  - {{TIP_2 — e.g. "Copy-paste the headline output into Slack before the call so people can read it while you talk"}}
  - {{TIP_3 — audience-specific framing, e.g. "The X story resonates most with senior engineers who Y"}}
