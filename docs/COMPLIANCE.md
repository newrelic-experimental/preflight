# Compliance

This page helps a security team assess Preflight against its data-handling requirements. It covers where Preflight's data goes, which controls apply at each step, and which New Relic certifications cover the data once it reaches New Relic.

Two limits apply to everything below:

- The certifications listed here belong to New Relic, the platform that stores the data. Preflight itself holds no certification.
- Compliance of your own use remains your responsibility. That includes what you configure Preflight to send, who can query it, and which region and retention you choose. New Relic states the same for its platform: "Your organization is responsible for ensuring compliance with all applicable laws and regulations." ([Certifications, standards, and regulations](https://docs.newrelic.com/docs/security/security-privacy/compliance/regulatory-audits-new-relic-services/))

This page does not constitute legal advice.

---

## Data handling chain

Preflight runs on the developer's machine. It records tool calls from the AI coding assistant to local storage. In `mode: "local"` the chain stops there. In `mode: "cloud"` or `"both"` it also sends events, metrics and audit log entries to New Relic.

```text
+---------------------------+
| Developer machine         |
| AI coding assistant       |
|   hooks, MCP calls        |
+-------------+-------------+
              |  local process, no network
              |  controls: secret redaction before write
              v
+---------------------------+
| Preflight local storage   |
| ~/.newrelic-preflight/    |
|   buffers, sessions,      |
|   audit log               |
+-------------+-------------+
              |  mode "local": nothing leaves the machine
              |  mode "cloud" / "both": HTTPS, gzip
              |  controls: redaction, highSecurity, recordContent off,
              |            field opt-outs, region choice, tier routing
              v
+---------------------------+
| New Relic ingest APIs     |
|   Events API  (events)    |
|   Metric API  (metrics)   |
|   Logs API    (audit log) |
+-------------+-------------+
              |  controls: TLS in transit (New Relic)
              v
+---------------------------+
| New Relic platform        |
| (US, EU or JP region)     |
|   storage                 |
+---------------------------+
   controls: encryption at rest, retention settings,
             account access, certifications (New Relic)
```

### Hop 1: assistant to Preflight local storage

Preflight reads hook payloads and MCP calls on the same machine. No network is involved.

- Credential patterns are redacted before a command or free-form string is recorded. See [SECURITY.md § Secret Redaction](../SECURITY.md#secret-redaction).
- Directories under `~/.newrelic-preflight/` are created with mode `0o700` and files with `0o600`, so other users on the machine cannot read them. See [SECURITY.md § Storage permissions](../SECURITY.md#storage-permissions).
- File contents, command output and agent text are not recorded unless `recordContent` is enabled. See [PRIVACY.md § `recordContent`](../PRIVACY.md#recordcontent--off-by-default).

For how long local data is kept and how to shorten it, see [ADVANCED.md § Data Retention](./ADVANCED.md#data-retention).

### Hop 2: Preflight to New Relic ingest APIs

This hop exists only in `mode: "cloud"` or `"both"`. In `mode: "local"` Preflight does not construct its New Relic transport at all (`src/index.ts`), so nothing is sent. See [PRIVACY.md § `mode: 'local'`](../PRIVACY.md#mode-local--no-data-leaves-the-machine).

- Preflight sends events to the Events API, metrics to the Metric API, and audit records to the Logs API. Every endpoint URL is built with `https://`, including a custom `collectorHost` (`src/core/transport/http-client.ts`). Audit records become log entries in `src/transport/log-ingest.ts`.
- Payloads are gzip-compressed before sending (`src/core/transport/http-client.ts`).
- The license key selects the destination region. A key starting with `eu01` routes to the EU region and a `jp` key to the Japan region. See [PRIVACY.md § NR Account Region](../PRIVACY.md#nr-account-region).
- `highSecurity: true` forces `recordContent` off and cannot be overridden. See [SECURITY.md § High security mode](../SECURITY.md#high-security-mode).
- The `developer`, `projectId` and `repoUrl` values can be set to a pseudonym or turned off. See [PRIVACY.md § Privacy-Relevant Configuration Settings](../PRIVACY.md#privacy-relevant-configuration-settings).
- With `tiers`, each event type can go to a different New Relic account or a local directory. See [PRIVACY.md § `tiers`](../PRIVACY.md#tiers--routes-events-to-additional-destinations).

### Hop 3: New Relic ingest to New Relic platform

From here, New Relic's controls apply. Each claim links to the New Relic page it comes from.

- **Encryption in transit.** "TLS is required for all domains." New Relic's preferred protocol is TLS 1.3. ([Data encryption](https://docs.newrelic.com/docs/security/security-privacy/compliance/data-encryption/))
- **Encryption at rest.** New Relic encrypts all data at rest. Data in AWS and Azure is encrypted with AES-256. Encryption at rest cannot be disabled. ([Data encryption](https://docs.newrelic.com/docs/security/security-privacy/compliance/data-encryption/))
- **Access.** Any user in the target account with NRQL query access can read Preflight's data. See [PRIVACY.md § Who Can See This Data](../PRIVACY.md#who-can-see-this-data-in-your-new-relic-account).

---

## New Relic certifications

New Relic lists these certifications and attestations as currently maintained: FedRAMP, HIPAA enabled capabilities, ISO 27001, ISO 42001, PCI DSS, SOC 1, SOC 2 and TISAX. ([Certifications, standards, and regulations](https://docs.newrelic.com/docs/security/security-privacy/compliance/regulatory-audits-new-relic-services/))

The two most often requested:

| Certification | Scope stated by New Relic                                                      | Source                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| SOC 2 Type 2  | New Relic Observability Platform, on AWS, Azure and first-party infrastructure | [SOC 2](https://docs.newrelic.com/docs/security/security-privacy/compliance/certificates-standards-regulations/soc2/)          |
| ISO 27001     | ISO 27001:2022 certificate for the New Relic Observability Platform            | [ISO 27001](https://docs.newrelic.com/docs/security/security-privacy/compliance/certificates-standards-regulations/iso-27001/) |

Both pages note that not every New Relic service is in scope, and both list Pixie services as out of scope. New Relic also states that a newly released service may not yet be covered by every program. ([Certifications, standards, and regulations](https://docs.newrelic.com/docs/security/security-privacy/compliance/regulatory-audits-new-relic-services/))

Some programs do not cover every account. FedRAMP authorization applies to accounts that meet specific criteria ([Data encryption](https://docs.newrelic.com/docs/security/security-privacy/compliance/data-encryption/)), and FedRAMP and HIPAA compliance come with the Data Plus option ([View and manage data retention](https://docs.newrelic.com/docs/data-apis/manage-data/manage-data-retention/)). Check each program's page before relying on it. Reports and certificates are available from the [New Relic trust portal](https://trust.newrelic.com/).

Preflight sends data with the standard Events, Metric and Logs APIs. Whether those APIs fall within a given program's scope for your account is a question for New Relic. Confirm it with your New Relic account representative.

---

## What Preflight sends

[PRIVACY.md](../PRIVACY.md) is the field-level inventory. It lists each field sent in cloud mode and why it matters for privacy. [METRICS_TABLE.md](./METRICS_TABLE.md) documents every attribute of every event type.

The list of event types Preflight can send is `KNOWN_EVENT_TYPES` in [`src/transport/tier-types.ts`](../src/transport/tier-types.ts). The same file classifies each type in `EVENT_TYPE_SENSITIVITY`:

- `safe-shared` types carry aggregate counts, durations and costs. They contain no raw file paths, commands or user-authored text.
- `personal-only` types carry per-call detail such as bash commands, file paths, agent descriptions and audit specifics.

Use this classification to set the data class for each event type in your own assessment. A personal-only type routed to any tier other than `default` makes Preflight log a warning, but the event is still sent.

---

## Security FAQ

### Is data encrypted in transit and at rest?

In transit, yes. Preflight sends to New Relic only over HTTPS (`src/core/transport/http-client.ts`), and New Relic requires TLS for all domains. ([Data encryption](https://docs.newrelic.com/docs/security/security-privacy/compliance/data-encryption/))

At rest in New Relic, yes. New Relic encrypts all data at rest and the encryption cannot be disabled. ([Data encryption](https://docs.newrelic.com/docs/security/security-privacy/compliance/data-encryption/))

At rest on the developer's machine, Preflight does not encrypt its files. It protects them with owner-only file permissions (`0o700` directories, `0o600` files). Use disk encryption on the machine if your policy requires encryption of local data.

### What is the data retention period?

In New Relic, retention depends on the data type and your account settings. New Relic's defaults with the Original Data option:

- Custom events, which covers Preflight's events: 30 days.
- Logs, which covers Preflight's audit log entries: 30 days.
- Dimensional metrics from the Metric API: raw data points for 30 days and aggregated data points for 13 months. Metric retention is not editable.

Data Plus extends custom event retention to 120 days. ([View and manage data retention](https://docs.newrelic.com/docs/data-apis/manage-data/manage-data-retention/))

On the developer's machine, see [ADVANCED.md § Data Retention](./ADVANCED.md#data-retention).

### Can we request data deletion?

Yes, for personal data. An account admin or owner emails personaldatarequests@newrelic.com with enough detail to identify the data. New Relic states it has 30 days by law to fulfill a deletion request. ([New Relic personal data requests](https://docs.newrelic.com/docs/security/security-privacy/data-privacy/new-relic-personal-data-requests/))

To stop specific data from being stored in the first place, New Relic supports dropping events or attributes at ingest. ([Data privacy with New Relic](https://docs.newrelic.com/docs/security/security-privacy/data-privacy/data-privacy-new-relic/))

Local data can be deleted by removing files under `~/.newrelic-preflight/`.

### Is Preflight available in EU and GDPR-compliant New Relic regions?

Preflight supports the US, EU and JP regions. A license key starting with `eu01` routes to the EU region automatically. See [PRIVACY.md § NR Account Region](../PRIVACY.md#nr-account-region).

New Relic hosts data in a US region (the default), an EU region and a JP region. New Relic states that you are "solely responsible for the selection of the appropriate processing and storage region" under any data localization law that applies to you. ([Choose your data center](https://docs.newrelic.com/docs/accounts/accounts-billing/account-setup/choose-your-data-center/))

On GDPR, New Relic states that it strives to comply with applicable laws including the GDPR. It offers a data processing addendum that relies on the EU-U.S. Data Privacy Framework and Standard Contractual Clauses for transfers from the EU, Switzerland and the UK. ([Data privacy with New Relic](https://docs.newrelic.com/docs/security/security-privacy/data-privacy/data-privacy-new-relic/))

For personal data requests, you are the data controller and New Relic is your data processor. ([New Relic personal data requests](https://docs.newrelic.com/docs/security/security-privacy/data-privacy/new-relic-personal-data-requests/))

### What PII does Preflight collect?

Preflight does not record file contents, command output or agent text unless `recordContent` is enabled. Token usage is recorded as counts, not message text. It does send identifiers that can point to a person:

- The `developer` value, which defaults to the OS username or git user name.
- The working directory and file paths, which often contain the OS username.
- Bash commands, grep patterns, task subjects and agent descriptions, after credential redaction. These are free text and can contain anything a developer or the assistant typed.
- The repository identifier and remote URL.

[PRIVACY.md](../PRIVACY.md) lists every field, its privacy note, and the setting that turns it off or replaces it. Start with `mode: "local"` to evaluate Preflight without sending anything, and review the [checklist before enabling cloud telemetry](../PRIVACY.md#checklist-before-enabling-cloud-telemetry).
