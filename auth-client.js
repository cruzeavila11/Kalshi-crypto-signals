// Remove only this origin's obsolete root service worker and named app caches.
// Never clear localStorage: position/history records are independent of login.
export async function cleanupAppCaches() {
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.filter(reg => reg.scope === new URL('/', location.origin).href)
      .map(reg => reg.unregister()));
  }
  if ('caches' in globalThis) {
    const names = await caches.keys();
    await Promise.all(names.filter(name => /^kalshi/i.test(name)).map(name => caches.delete(name)));
  }
}
let locked = false;
let suspended = false;
let channel;
export function installAuthLifecycle(stopPolling) {
  const lock = (broadcast = true) => {
    if (locked) return;
    locked = true;
    stopPolling();
    document.body.textContent = 'Session ended. Returning to login…';
    if (broadcast) channel?.postMessage('logout');
    void cleanupAppCaches().catch(() => {});
    location.replace('/login');
  };
  if ('BroadcastChannel' in globalThis) {
    channel = new BroadcastChannel('kalshi-auth');
    channel.onmessage = event => { if (event.data === 'logout') lock(false); };
  }
  const check = async () => {
    if (locked || suspended) return false;
    try {
      const response = await fetch('/auth/session', { cache: 'no-store' });
      if (!response.ok) { lock(); return false; }
      return !locked && !suspended;
    } catch { lock(); return false; }
  };
  const guardedFetch = async (...args) => {
    if (locked || suspended) throw new Error('Session ended');
    const response = await fetch(...args);
    if (response.status === 401) { lock(); throw new Error('Session ended'); }
    if (locked || suspended) throw new Error('Session ended');
    return response;
  };
  document.querySelector('#logoutBtn')?.addEventListener('click', async () => {
    suspended = true;
    stopPolling();
    document.body.textContent = 'Logging out…';
    try {
      const response = await fetch('/auth/logout', { method: 'POST', cache: 'no-store' });
      if (!response.ok && response.status !== 401) throw new Error('Logout failed');
      lock();
    } catch {
      // Do not claim the server cookie was cleared when offline.
      document.body.textContent = 'Logout could not reach the server. Close this tab and retry logout when online.';
    }
  });
  window.addEventListener('pagehide', () => { document.body.style.visibility = 'hidden'; });
  window.addEventListener('pageshow', async () => {
    document.body.style.visibility = 'hidden';
    if (await check()) document.body.style.visibility = '';
  });
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) document.body.style.visibility = 'hidden';
    else if (await check()) document.body.style.visibility = '';
  });
  void cleanupAppCaches().catch(() => {});
  return { fetch: guardedFetch, check, isActive: () => !locked && !suspended };
}
