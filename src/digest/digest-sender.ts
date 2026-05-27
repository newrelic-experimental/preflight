export async function sendSlackDigest(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  if (!webhookUrl.startsWith('https://hooks.slack.com/')) {
    throw new Error('Invalid webhook URL: must start with https://hooks.slack.com/');
  }

  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    throw new Error(`Slack webhook returned ${resp.status}: ${await resp.text()}`);
  }
}
