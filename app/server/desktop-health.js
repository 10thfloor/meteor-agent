/** Read-only readiness for the desktop supervisor. An HTML response from
 * Meteor's development proxy is not proof the application process is alive. */
export function createDesktopHealthHandler({ ready, probe, timeoutMs = 1500 }) {
  let inFlight = null;
  const healthy = () => {
    if (!inFlight) {
      const pending = Promise.resolve().then(probe).then(() => true, () => false);
      inFlight = pending;
      void pending.then(() => { if (inFlight === pending) inFlight = null; });
    }
    return inFlight;
  };
  return async (request, response, next) => {
    if (request.url?.split('?')[0] !== '/__constellation/health') return next();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      response.statusCode = 405;
      response.end(JSON.stringify({ service: 'constellation', status: 'unavailable' }));
      return;
    }
    let timer;
    let available = false;
    try {
      if (ready()) available = await Promise.race([
        healthy(),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } catch {
      // Never expose database errors, credentials or workspace information.
    } finally { clearTimeout(timer); }
    if (response.destroyed || response.writableEnded) return;
    response.statusCode = available ? 200 : 503;
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({
      service: 'constellation', status: available ? 'ready' : 'unavailable',
    }));
  };
}
