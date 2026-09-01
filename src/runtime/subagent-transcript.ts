import type { SubagentTranscriptItem, ToolCallView } from '../protocol/host-protocol';

export type SubagentTranscript = SubagentTranscriptItem[];

export const MAX_TRANSCRIPT_ITEMS = 500;
export const MAX_TOOL_PREVIEW_BYTES = 4096;

export function createEmptySubagentTranscript(): SubagentTranscript {
  return [];
}

function clamp(items: SubagentTranscript): SubagentTranscript {
  return items.length > MAX_TRANSCRIPT_ITEMS ? items.slice(-MAX_TRANSCRIPT_ITEMS) : items;
}

export function startSubagentAssistant(
  items: SubagentTranscript,
  id: string,
  initialText = ''
): SubagentTranscript {
  const existing = items.find((i) => i.id === id);
  if (existing) {
    return items.map((i) =>
      i.id === id && i.kind === 'assistant'
        ? { ...i, streaming: true, text: i.text || initialText }
        : i
    );
  }
  return clamp([
    ...items,
    {
      kind: 'assistant',
      id,
      text: initialText,
      streaming: true,
      ts: Date.now()
    }
  ]);
}

export function appendSubagentTextDelta(
  items: SubagentTranscript,
  id: string,
  delta: string
): SubagentTranscript {
  const existing = items.find((i) => i.id === id);
  if (!existing) {
    return clamp([
      ...items,
      {
        kind: 'assistant',
        id,
        text: delta,
        streaming: true,
        ts: Date.now()
      }
    ]);
  }
  return clamp(
    items.map((it) =>
      it.kind === 'assistant' && it.id === id
        ? { ...it, text: it.text + delta }
        : it
    )
  );
}

export function finalizeSubagentAssistant(
  items: SubagentTranscript,
  id?: string | null
): SubagentTranscript {
  return items.map((it) => {
    if (it.kind !== 'assistant') return it;
    if (id == null || it.id === id) {
      return { ...it, streaming: false };
    }
    return it;
  });
}

export function startSubagentThinking(
  items: SubagentTranscript,
  id: string
): SubagentTranscript {
  const existing = items.find((i) => i.id === id);
  if (existing) {
    return items;
  }
  return clamp([
    ...items,
    {
      kind: 'thinking',
      id,
      steps: [],
      streaming: true
    }
  ]);
}

export function appendSubagentThinkingDelta(
  items: SubagentTranscript,
  id: string,
  delta: string
): SubagentTranscript {
  const existing = items.find((i) => i.id === id);
  if (!existing) {
    return clamp([
      ...items,
      {
        kind: 'thinking',
        id,
        steps: [delta],
        streaming: true
      }
    ]);
  }
  return clamp(
    items.map((it) => {
      if (it.kind !== 'thinking' || it.id !== id) return it;
      const steps = it.steps.length === 0 ? [''] : [...it.steps];
      steps[steps.length - 1] = (steps[steps.length - 1] ?? '') + delta;
      return { ...it, steps };
    })
  );
}

export function finalizeSubagentThinking(
  items: SubagentTranscript,
  id?: string | null,
  durationMs?: number
): SubagentTranscript {
  return items.map((it) => {
    if (it.kind !== 'thinking') return it;
    if (id == null || it.id === id) {
      return {
        ...it,
        streaming: false,
        durationMs: durationMs ?? it.durationMs
      };
    }
    return it;
  });
}

export function startSubagentTool(
  items: SubagentTranscript,
  id: string,
  initial: {
    name: string;
    pluginId?: string;
    risk?: 'read' | 'write' | 'exec';
    preview?: string;
    startedAt?: number;
  }
): SubagentTranscript {
  const existing = items.find((i) => i.id === id);
  const toolCall: ToolCallView = {
    name: initial.name,
    pluginId: initial.pluginId,
    risk: initial.risk ?? 'exec',
    status: 'running',
    preview: initial.preview,
    inputPreview: initial.preview,
    startedAt: initial.startedAt ?? Date.now()
  };

  if (existing) {
    return items.map((it) =>
      it.id === id && it.kind === 'tool' ? { ...it, call: { ...it.call, ...toolCall } } : it
    );
  }

  return clamp([
    ...items,
    {
      kind: 'tool',
      id,
      call: toolCall
    }
  ]);
}

export function endSubagentTool(
  items: SubagentTranscript,
  id: string,
  patch: {
    status: 'ok' | 'error' | 'cancelled' | 'interrupted';
    preview?: string;
    error?: string;
    durationMs?: number;
    truncated?: boolean;
    artifactUri?: string;
  }
): SubagentTranscript {
  return items.map((it) => {
    if (it.kind !== 'tool' || it.id !== id) return it;

    let preview = patch.preview;
    let truncated = patch.truncated ?? false;
    if (preview && preview.length > MAX_TOOL_PREVIEW_BYTES) {
      preview = preview.slice(0, MAX_TOOL_PREVIEW_BYTES);
      truncated = true;
    }

    const durationMs =
      patch.durationMs ??
      (it.call.startedAt ? Math.max(0, Date.now() - it.call.startedAt) : undefined);

    const call: ToolCallView = {
      ...it.call,
      status: patch.status,
      preview,
      truncated,
      durationMs,
      errorMessage: patch.error,
      errorCode: patch.error ? (patch.status === 'cancelled' ? 'USER_CANCELLED' : 'TOOL_ERROR') : undefined,
      artifactUri: patch.artifactUri ?? it.call.artifactUri
    };

    return { ...it, call };
  });
}

export function getLastAssistantText(items: SubagentTranscript): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === 'assistant') {
      return item.text;
    }
  }
  return '';
}

export function deriveSubagentPreview(
  items?: SubagentTranscript,
  fallback?: string
): string {
  if (items && items.length > 0) {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === 'assistant' && item.text.trim()) {
        const t = item.text.trim();
        return t.length > 80 ? `${t.slice(0, 80)}…` : t;
      }
    }
  }
  return fallback ?? '';
}
