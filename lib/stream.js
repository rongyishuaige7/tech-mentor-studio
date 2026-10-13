// Both the CPA proxy and the browser use SSE. Decode complete events, including
// CRLF, fragmented UTF-8 and multi-line data, instead of assuming TCP boundaries.
export async function* readSSE(body, signal) {
  if (!body) throw new Error('上游未返回响应流');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      if (done && buffer) lines.push(buffer.replace(/\r$/, ''), '');
      for (let line of lines) {
        line = line.replace(/\r$/, '');
        if (line === '') {
          if (data.length) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (done) {
        if (data.length) yield data.join('\n');
        break;
      }
      if (buffer.length > 1024 * 1024) throw new Error('上游流式事件过大');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function relayCompletion(response, send, signal) {
  let completed = false;
  for await (const data of readSSE(response.body, signal)) {
    if (data === '[DONE]') {
      completed = true;
      break;
    }
    let parsed;
    try { parsed = JSON.parse(data); } catch { throw new Error('上游返回无效的流式数据'); }
    if (parsed.error) throw new Error('上游返回模型错误，请检查代理状态');
    const text = parsed.choices?.[0]?.delta?.content;
    if (typeof text === 'string' && text) send({ type: 'chunk', text });
    if (parsed.usage) send({ type: 'usage', usage: parsed.usage });
    if (parsed.choices?.some(choice => choice.finish_reason)) completed = true;
  }
  signal?.throwIfAborted();
  if (!completed) throw new Error('上游流意外中断，回答未完成');
  send({ type: 'finished' });
}

export function requestLifecycle(res, timeoutMs) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort(new Error('客户端已断开'));
  };
  res.on('close', onClose);
  const timer = setTimeout(() => controller.abort(new Error('分析超时，请重试')), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); res.off('close', onClose); }
  };
}
