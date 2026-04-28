const NERDGRAPH_URL = 'https://api.newrelic.com/graphql';

const NRQL_QUERY = `
query NrqlQuery($accountId: Int!, $nrql: String!) {
  actor {
    account(id: $accountId) {
      nrql(query: $nrql) {
        results
      }
    }
  }
}`;

interface NrqlResult {
  actor: {
    account: {
      nrql: {
        results: Array<Record<string, unknown>>;
      };
    };
  };
}

export async function runNrql(
  apiKey: string,
  accountId: number,
  nrql: string,
): Promise<Array<Record<string, unknown>>> {
  const resp = await fetch(NERDGRAPH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'API-Key': apiKey },
    body: JSON.stringify({ query: NRQL_QUERY, variables: { accountId, nrql } }),
  });
  if (!resp.ok) {
    throw new Error(`NerdGraph HTTP ${resp.status}: ${await resp.text()}`);
  }
  const json = (await resp.json()) as unknown as {
    data?: NrqlResult;
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) {
    throw new Error(`NerdGraph errors: ${json.errors.map((e) => e.message).join(', ')}`);
  }
  return json.data?.actor.account.nrql.results ?? [];
}
