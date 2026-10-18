// Both the CPA proxy and the browser use SSE. Decode complete events, including
// CRLF, fragmented UTF-8 and multi-line data, instead of assuming TCP boundaries.
export async function* readSSE(body, signal) {
  if (!body) throw new Error('上游未返回响应流');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  let eventSize = 0;
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
          eventSize = 0;
        } else if (line.startsWith('data:')) {
          eventSize += line.length;
          if (eventSize > 1024 * 1024) throw new Error('上游流式事件过大');
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
  let characters = 0;
  for await (const data of readSSE(response.body, signal)) {
    if (data === '[DONE]') {
      completed = true;
      break;
    }
    let parsed;
    try { parsed = JSON.parse(data); } catch { throw new Error('上游返回无效的流式数据'); }
    if (parsed.error) throw new Error('上游返回模型错误，请检查代理状态');
    const text = parsed.choices?.[0]?.delta?.content;
    if (typeof text === 'string' && text) {
      characters += text.length;
      if (characters > 100000) throw new Error('回答超过 100000 字符上限，请缩小问题范围');
      send({ type: 'chunk', text });
    }
    if (parsed.usage) send({ type: 'usage', usage: parsed.usage });
    const finish = parsed.choices?.[0]?.finish_reason;
    if (finish === 'length') throw new Error('模型达到输出长度限制，回答未完成，请缩小问题范围');
    if (finish === 'content_filter') throw new Error('模型未完成回答，请调整问题后重试');
    if (finish) completed = true;
  }
  signal?.throwIfAborted();
  if (!completed) throw new Error('上游流意外中断，回答未完成');
  if (!characters) throw new Error('模型没有返回可显示的回答');
  send({ type: 'finished' });
}

export function requestLifecycle(res, timeoutMs, timeoutMessage = '分析超时，请重试') {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort(new Error('客户端已断开'));
  };
  res.on('close', onClose);
  const timer = setTimeout(() => controller.abort(new Error(timeoutMessage)), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); res.off('close', onClose); }
  };
}
