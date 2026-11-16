// Minimal CDP driver: no deps, talks to headless Chrome over WebSocket.
// Usage: node cdp.mjs <url> <actions.json>
// actions: [{eval:"js"}, {shot:{path,width,height,fullPage:true}}, {goto:"url"}]

const HOST = '127.0.0.1';
const PORT = process.env.CDP_PORT || 9333;

async function rpc(ws, id) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id === id) {
        ws.removeEventListener('message', onMsg);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', onMsg);
  });
}

let nextId = 1;
function send(ws, method, params = {}, sessionId) {
  const id = nextId++;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return rpc(ws, id);
}

const [url, actionsFile] = process.argv.slice(2);
const actions = JSON.parse(await (await import('node:fs/promises')).readFile(actionsFile, 'utf8'));

const version = await (await fetch(`http://${HOST}:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

const { targetId } = await send(ws, 'Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });

await send(ws, 'Page.enable', {}, sessionId);
await send(ws, 'Runtime.enable', {}, sessionId);
// Автосогласие на window.confirm(): в headless-режиме диалог блокирует
// выполнение навсегда, и проверка зависает без внятной ошибки.
if (process.env.CDP_ACCEPT_DIALOGS !== '0') {
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.method === 'Page.javascriptDialogOpening') {
      ws.send(JSON.stringify({
        id: nextId++,
        method: 'Page.handleJavaScriptDialog',
        params: { accept: true },
        sessionId,
      }));
    }
  });
}
await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

const results = [];
for (const a of actions) {
  if (a.goto) {
    await send(ws, 'Page.navigate', { url: a.goto }, sessionId);
    await new Promise((r) => setTimeout(r, a.wait || 1500));
  }
  if (a.viewport) {
    await send(ws, 'Emulation.setDeviceMetricsOverride', { width: a.viewport.w, height: a.viewport.h, deviceScaleFactor: 1, mobile: !!a.viewport.mobile }, sessionId);
  }
  if (a.eval) {
    const r = await send(ws, 'Runtime.evaluate', {
      expression: `(async () => { ${a.eval} })()`,
      awaitPromise: true, returnByValue: true, userGesture: true,
    }, sessionId);
    if (r.exceptionDetails) results.push({ eval: a.label || null, error: r.exceptionDetails.exception?.description || r.exceptionDetails.text });
    else results.push({ eval: a.label || null, value: r.result.value });
  }
  if (a.shot) {
    const params = { format: 'png' };
    if (a.shot.fullPage) params.captureBeyondViewport = true;
    if (a.shot.clip) params.clip = a.shot.clip;
    const r = await send(ws, 'Page.captureScreenshot', params, sessionId);
    const fs = await import('node:fs/promises');
    await fs.writeFile(a.shot.path, Buffer.from(r.data, 'base64'));
    results.push({ shot: a.shot.path });
  }
}

console.log(JSON.stringify(results, null, 2));
await send(ws, 'Target.closeTarget', { targetId });
ws.close();
process.exit(0);
