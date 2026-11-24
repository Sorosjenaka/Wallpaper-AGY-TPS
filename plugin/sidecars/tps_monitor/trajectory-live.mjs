const ROUTE = '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps';

export async function readLiveSteps(conversationId, stepOffset) {
  const address = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!address || !csrf) return { reason: 'unavailable' };

  try {
    const endpoint = new URL(address.includes('://') ? address : `http://${address}`);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
      return { reason: 'nonlocal' };
    }
    const response = await fetch(new URL(ROUTE, endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrf,
      },
      redirect: 'error',
      body: JSON.stringify({ cascadeId: conversationId, stepOffset }),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return { reason: `http-${response.status}` };
    const value = await response.json();
    return { steps: Array.isArray(value.steps) ? value.steps : [] };
  } catch (error) {
    return { reason: error.name === 'TimeoutError' ? 'timeout' : 'unavailable' };
  }
}

export function summarizeLiveSteps(steps, offset, now = Date.now()) {
  const index = steps.findLastIndex(step => step.plannerResponse && step.metadata);
  if (index < 0) return null;

  const { status, metadata, plannerResponse } = steps[index];
  const generating = status === 'CORTEX_STEP_STATUS_GENERATING';
  const complete = status === 'CORTEX_STEP_STATUS_DONE';
  const usage = metadata.modelUsage;
  const output = Number(usage?.outputTokens) || 0;
  const context = (Number(usage?.inputTokens) || 0) + (Number(usage?.cacheReadTokens) || 0);
  const visible = Date.parse(metadata.viewableAt);
  const created = Date.parse(metadata.createdAt);
  const end = generating
    ? Date.parse(metadata.lastCompletedChunkAt) || now
    : Date.parse(metadata.finishedGeneratingAt || metadata.completedAt);
  const fromVisible = Number.isFinite(visible) && visible < end;
  const start = fromVisible ? visible : created;
  const seconds = (end - start) / 1000;

  return {
    step: offset + index,
    generating,
    complete,
    characters: typeof plannerResponse.response === 'string' ? plannerResponse.response.length : 0,
    output,
    context,
    fromVisible,
    seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    tps: (generating || complete) && output > 0 && seconds >= 0.5
      ? Math.round(output / seconds * 10) / 10
      : null,
  };
}
