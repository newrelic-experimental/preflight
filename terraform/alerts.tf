resource "newrelic_alert_policy" "ai_coding" {
  name               = "AI Coding Assistant Alerts"
  incident_preference = "PER_CONDITION"
}

# ── Shared conditions ────────────────────────────────────────────────────────

resource "newrelic_nrql_alert_condition" "hourly_cost_spike" {
  account_id   = var.account_id
  policy_id    = newrelic_alert_policy.ai_coding.id
  name         = "AI Hourly Cost Spike"
  description  = "Fires when AI coding cost exceeds $10 in any 1-hour window."
  enabled      = true

  nrql { query = "SELECT sum(estimated_cost_usd) FROM AiCodingTask" }

  aggregation_method = "event_flow"
  aggregation_delay  = 120
  aggregation_window = 3600

  critical {
    operator              = "above"
    threshold             = 10
    threshold_duration    = 3600
    threshold_occurrences = "all"
  }

  violation_time_limit_seconds = 86400
}

resource "newrelic_nrql_alert_condition" "low_efficiency_score" {
  account_id   = var.account_id
  policy_id    = newrelic_alert_policy.ai_coding.id
  name         = "AI Low Efficiency Score"
  description  = "Fires when the rolling efficiency score drops below 40 for 30+ minutes."
  enabled      = true

  nrql { query = "SELECT average(ai.efficiency.score) FROM Metric" }

  aggregation_method = "event_flow"
  aggregation_delay  = 120
  aggregation_window = 300

  critical {
    operator              = "below"
    threshold             = 40
    threshold_duration    = 1800
    threshold_occurrences = "all"
  }

  violation_time_limit_seconds = 86400
}

resource "newrelic_nrql_alert_condition" "stuck_loop_spike" {
  account_id   = var.account_id
  policy_id    = newrelic_alert_policy.ai_coding.id
  name         = "AI Stuck Loop Spike"
  description  = "Fires when stuck loop anti-patterns exceed 3 occurrences in a 5-minute window."
  enabled      = true

  nrql { query = "SELECT count(*) FROM AiAntiPattern WHERE type = 'stuck_loop'" }

  aggregation_method = "event_flow"
  aggregation_delay  = 120
  aggregation_window = 300

  critical {
    operator              = "above"
    threshold             = 3
    threshold_duration    = 300
    threshold_occurrences = "at_least_once"
  }

  violation_time_limit_seconds = 43200
}

resource "newrelic_nrql_alert_condition" "anti_pattern_rate" {
  account_id   = var.account_id
  policy_id    = newrelic_alert_policy.ai_coding.id
  name         = "AI Anti-Pattern Rate Elevated"
  description  = "Fires when total anti-patterns exceed 10 in any 10-minute window."
  enabled      = true

  nrql { query = "SELECT count(*) FROM AiAntiPattern" }

  aggregation_method = "event_flow"
  aggregation_delay  = 120
  aggregation_window = 600

  critical {
    operator              = "above"
    threshold             = 10
    threshold_duration    = 600
    threshold_occurrences = "at_least_once"
  }

  violation_time_limit_seconds = 43200
}

resource "newrelic_nrql_alert_condition" "session_cost_budget" {
  account_id   = var.account_id
  policy_id    = newrelic_alert_policy.ai_coding.id
  name         = "AI Session Cost Over Budget"
  description  = "Fires when a single session's cost exceeds $5. Adjust threshold to match your budget."
  enabled      = false

  nrql { query = "SELECT max(ai.cost.session_total_usd) FROM Metric FACET session_id" }

  aggregation_method = "event_flow"
  aggregation_delay  = 120
  aggregation_window = 300

  critical {
    operator              = "above"
    threshold             = 5
    threshold_duration    = 300
    threshold_occurrences = "at_least_once"
  }

  violation_time_limit_seconds = 86400
}

# ── Personal conditions (scoped to var.developer) ────────────────────────────
# Only deployed when var.developer is set.

resource "newrelic_nrql_alert_condition" "personal_daily_cost" {
  count = var.developer != "" ? 1 : 0

  account_id   = var.account_id
  policy_id    = newrelic_alert_policy.ai_coding.id
  name         = "AI Personal Daily Cost — ${var.developer}"
  description  = "Fires when ${var.developer}'s AI coding cost exceeds the personal threshold in any 1-hour window."
  enabled      = true

  nrql { query = "SELECT sum(estimated_cost_usd) FROM AiCodingTask WHERE developer = '${var.developer}'" }

  aggregation_method = "event_flow"
  aggregation_delay  = 120
  aggregation_window = 3600

  critical {
    operator              = "above"
    threshold             = var.personal_daily_cost_usd
    threshold_duration    = 3600
    threshold_occurrences = "all"
  }

  violation_time_limit_seconds = 86400
}

resource "newrelic_nrql_alert_condition" "personal_session_cost" {
  count = var.developer != "" ? 1 : 0

  account_id   = var.account_id
  policy_id    = newrelic_alert_policy.ai_coding.id
  name         = "AI Personal Session Cost — ${var.developer}"
  description  = "Fires when a single session by ${var.developer} exceeds the personal session cost threshold."
  enabled      = true

  nrql { query = "SELECT max(ai.cost.session_total_usd) FROM Metric WHERE developer = '${var.developer}' FACET session_id" }

  aggregation_method = "event_flow"
  aggregation_delay  = 120
  aggregation_window = 300

  critical {
    operator              = "above"
    threshold             = var.personal_session_cost_usd
    threshold_duration    = 300
    threshold_occurrences = "at_least_once"
  }

  violation_time_limit_seconds = 86400
}

resource "newrelic_nrql_alert_condition" "personal_low_efficiency" {
  count = var.developer != "" ? 1 : 0

  account_id   = var.account_id
  policy_id    = newrelic_alert_policy.ai_coding.id
  name         = "AI Personal Low Efficiency — ${var.developer}"
  description  = "Fires when ${var.developer}'s efficiency score stays below personal threshold for 30 minutes."
  enabled      = true

  nrql { query = "SELECT average(ai.efficiency.score) FROM Metric WHERE developer = '${var.developer}'" }

  aggregation_method = "event_flow"
  aggregation_delay  = 120
  aggregation_window = 300

  critical {
    operator              = "below"
    threshold             = var.personal_efficiency_score_min
    threshold_duration    = 1800
    threshold_occurrences = "all"
  }

  violation_time_limit_seconds = 86400
}

resource "newrelic_nrql_alert_condition" "personal_anti_pattern_rate" {
  count = var.developer != "" ? 1 : 0

  account_id   = var.account_id
  policy_id    = newrelic_alert_policy.ai_coding.id
  name         = "AI Personal Anti-Pattern Rate — ${var.developer}"
  description  = "Fires when ${var.developer}'s anti-pattern rate exceeds personal threshold in a 5-minute window."
  enabled      = true

  nrql { query = "SELECT count(*) FROM AiAntiPattern WHERE developer = '${var.developer}'" }

  aggregation_method = "event_flow"
  aggregation_delay  = 120
  aggregation_window = 300

  critical {
    operator              = "above"
    threshold             = var.personal_anti_pattern_max
    threshold_duration    = 300
    threshold_occurrences = "at_least_once"
  }

  violation_time_limit_seconds = 43200
}

resource "newrelic_nrql_alert_condition" "personal_stuck_loop" {
  count = var.developer != "" ? 1 : 0

  account_id   = var.account_id
  policy_id    = newrelic_alert_policy.ai_coding.id
  name         = "AI Personal Stuck Loop — ${var.developer}"
  description  = "Fires when ${var.developer} triggers more than the personal stuck loop threshold in a 5-minute window."
  enabled      = true

  nrql { query = "SELECT count(*) FROM AiAntiPattern WHERE developer = '${var.developer}' AND type = 'stuck_loop'" }

  aggregation_method = "event_flow"
  aggregation_delay  = 120
  aggregation_window = 300

  critical {
    operator              = "above"
    threshold             = var.personal_stuck_loop_max
    threshold_duration    = 300
    threshold_occurrences = "at_least_once"
  }

  violation_time_limit_seconds = 43200
}
