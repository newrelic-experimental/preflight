terraform {
  required_version = ">= 1.5"

  required_providers {
    newrelic = {
      source  = "newrelic/newrelic"
      version = "~> 3.0"
    }
  }
}

locals {
  nerdgraph_url = var.staging ? "https://staging-api.newrelic.com/graphql" : null
}

provider "newrelic" {
  account_id       = var.account_id
  api_key          = var.api_key
  region           = upper(var.region)
  # nerdgraph_api_url is marked "NR internal use only" in the provider and
  # emits a deprecation warning — that warning is expected and intentional
  # here, since this project is an NR-internal tool. It has no effect when
  # var.staging = false (null is passed and the provider uses the default).
  nerdgraph_api_url = local.nerdgraph_url
}
