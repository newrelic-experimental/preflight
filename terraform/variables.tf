variable "account_id" {
  description = "New Relic account ID. Pass via -var, .tfvars, or TF_VAR_account_id=$NEW_RELIC_ACCOUNT_ID."
  type        = number
}

variable "api_key" {
  description = "New Relic User API Key (NRAK-...). Pass via TF_VAR_api_key=$NEW_RELIC_API_KEY, -var, or .tfvars."
  type        = string
  sensitive   = true
}

variable "region" {
  description = "New Relic region: US or EU"
  type        = string
  default     = "US"

  validation {
    condition     = contains(["US", "EU"], upper(var.region))
    error_message = "region must be US or EU"
  }
}

variable "developer" {
  description = "Developer identifier used as a filter dimension in personal dashboards (optional)"
  type        = string
  default     = ""
}

# ── Personal alert thresholds ────────────────────────────────────────────────
# These are only used when var.developer is set.

variable "personal_daily_cost_usd" {
  description = "Personal hourly cost threshold in USD"
  type        = number
  default     = 10
}

variable "personal_session_cost_usd" {
  description = "Personal per-session cost threshold in USD"
  type        = number
  default     = 5
}

variable "personal_efficiency_score_min" {
  description = "Personal minimum efficiency score (alert fires below this)"
  type        = number
  default     = 40
}

variable "personal_anti_pattern_max" {
  description = "Personal maximum anti-pattern count per 5-minute window"
  type        = number
  default     = 10
}

variable "personal_stuck_loop_max" {
  description = "Personal maximum stuck-loop count per 5-minute window"
  type        = number
  default     = 3
}
