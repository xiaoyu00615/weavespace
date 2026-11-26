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
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
    }
  };
  return {
    send(method, params = {}) {
      const mid = ++id;
      ws.send(JSON.stringify({ id: mid, method, params }));
      return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    close() { ws.close(); },
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
