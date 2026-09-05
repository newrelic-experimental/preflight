# Dashboard JSON files store "accountIds": [] and "accountIds": [0] as blank
# placeholders — the same pattern the deploy script fills via injectAccountId().
# Terraform has no built-in JSON mutation, so we use nested replace() to inject
# var.account_id before the JSON is sent to the provider.

locals {
  _acct = tostring(var.account_id)

  _inject = {
    adoption_cost      = "ai-coding-assistant-adoption-cost.json"
    overview           = "ai-coding-assistant-overview.json"
    manager_view       = "ai-coding-assistant-manager-view.json"
    personal           = "ai-coding-assistant-personal.json"
    platform_comparison = "ai-coding-assistant-platform-comparison.json"
    security           = "ai-coding-assistant-security.json"
    session_detail     = "ai-coding-assistant-session-detail.json"
    team_view          = "ai-coding-assistant-team-view.json"
  }

  dashboards = {
    for key, filename in local._inject :
    key => replace(
      replace(
        file("${path.module}/../dashboards/${filename}"),
        "\"accountIds\": []",
        "\"accountIds\": [${local._acct}]"
      ),
      "\"accountIds\": [0]",
      "\"accountIds\": [${local._acct}]"
    )
  }
}

resource "newrelic_one_dashboard_json" "overview" {
  account_id = var.account_id
  json       = local.dashboards["overview"]
}

resource "newrelic_one_dashboard_json" "manager_view" {
  account_id = var.account_id
  json       = local.dashboards["manager_view"]
}

resource "newrelic_one_dashboard_json" "personal" {
  account_id = var.account_id
  json       = local.dashboards["personal"]
}

resource "newrelic_one_dashboard_json" "platform_comparison" {
  account_id = var.account_id
  json       = local.dashboards["platform_comparison"]
}

resource "newrelic_one_dashboard_json" "security" {
  account_id = var.account_id
  json       = local.dashboards["security"]
}

resource "newrelic_one_dashboard_json" "session_detail" {
  account_id = var.account_id
  json       = local.dashboards["session_detail"]
}

resource "newrelic_one_dashboard_json" "team_view" {
  account_id = var.account_id
  json       = local.dashboards["team_view"]
}

resource "newrelic_one_dashboard_json" "adoption_cost" {
  account_id = var.account_id
  json       = local.dashboards["adoption_cost"]
}
