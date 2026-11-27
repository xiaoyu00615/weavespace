export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')); });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
    } else {
      for (const fn of [...(listeners.get(msg.method) ?? [])]) fn(msg.params);
    }
  };
  return {
    send(method, params = {}) {
      const mid = ++id;
      ws.send(JSON.stringify({ id: mid, method, params }));
      return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
    },
    /**
     * 注册事件监听器，**返回注销函数**（R1-03）。
     *
     * 之前只加不删：一个脚本里跑三个 UNKNOWN 场景，第一场景的 `failRequest` 会一直活着，
     * 第三场景的 `fulfillRequest` 与它同时处理同一个 requestId，谁先赢取决于事件顺序——
     * 证据看起来"通过"，实际是竞态的结果。注销是硬需求，不是卫生习惯。
     */
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
      return () => this.off(method, fn);
    },
    off(method, fn) {
      const list = listeners.get(method);
      if (!list) return false;
      const index = list.indexOf(fn);
      if (index < 0) return false;
      list.splice(index, 1);
      if (list.length === 0) listeners.delete(method);
      return true;
    },
    /** 当前监听器数量：每个场景开始前必须为 0（否则上一个场景还在抢同一个请求）。 */
    listenerCount(method) {
      return (listeners.get(method) ?? []).length;
    },
    listenerMethods() {
      return [...listeners.keys()];
    },
    close() { listeners.clear(); ws.close(); },
  };
}

const CDP_PORT = process.env.CDP_PORT ?? '9335';

export async function newTab(url) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const target = await res.json();
  const tab = await connect(target.webSocketDebuggerUrl);
  await tab.send('Runtime.enable');
  await tab.send('Page.enable');
  return { tab, targetId: target.id };
}

export async function ev(tab, expression, awaitPromise = true) {
  const r = await tab.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(tab, expression, timeoutMs = 15000, label = expression) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await ev(tab, `!!(${expression})`, false)) return true;
    await sleep(120);
  }
  throw new Error(`timeout waiting for ${label}`);
}
