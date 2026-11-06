import { useEffect } from 'react';
import type { JSX } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';

import { digestSendStatus, fetchDigestPreview, postDigestSend, qk } from '../api/client';
import { Button } from './ui';

interface DigestPreview {
  readonly week: string;
  readonly text: string;
}

interface DigestPreviewDialogProps {
  readonly webhookConfigured: boolean;
  readonly onClose: () => void;
}

export function DigestPreviewDialog({
  webhookConfigured,
  onClose,
}: DigestPreviewDialogProps): JSX.Element {
  const previewQ = useQuery({
    queryKey: qk.digestPreview,
    queryFn: async (): Promise<DigestPreview> =>
      JSON.parse((await fetchDigestPreview()).content[0]?.text ?? '{}') as DigestPreview,
  });

  const sendMutation = useMutation({ mutationFn: postDigestSend });
  const status = sendMutation.isError
    ? `Error: ${String(sendMutation.error)}`
    : sendMutation.data
      ? digestSendStatus(sendMutation.data)
      : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const preview = previewQ.data;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="digest-preview-title"
        className="fixed left-1/2 top-1/2 z-50 w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex flex-col gap-4 bg-bg-panel border border-border-medium rounded-lg p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="digest-preview-title" className="text-sm font-semibold text-ink-base">
              Digest preview
            </h2>
            {preview && (
              <p className="mt-1 text-[10px] text-ink-muted">
                Week {preview.week}. Nothing is sent until you choose Send now.
              </p>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        {previewQ.isPending && <p className="text-xs text-ink-muted">Loading preview…</p>}
        {previewQ.isError && (
          <p className="text-xs text-accent-red">
            Could not load the preview: {String(previewQ.error)}
          </p>
        )}
        {preview && (
          <pre className="text-xs font-mono text-ink-base whitespace-pre-wrap bg-surface-3 rounded-md p-3 max-h-[60vh] overflow-auto">
            {preview.text}
          </pre>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <Button
            variant="primary"
            size="md"
            onClick={() => sendMutation.mutate()}
            disabled={!preview || !webhookConfigured || sendMutation.isPending}
            loading={sendMutation.isPending}
          >
            {sendMutation.isPending ? 'Sending…' : 'Send now'}
          </Button>
          {!webhookConfigured && (
            <span className="text-xs text-ink-subtle">Save a webhook URL to send.</span>
          )}
          {status && (
            <span role="status" className="text-xs text-ink-subtle">
              {status}
            </span>
          )}
        </div>
      </div>
    </>
  );
}
