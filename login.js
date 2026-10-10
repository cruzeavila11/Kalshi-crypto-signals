import { cleanupAppCaches } from '/auth-client.js';
void cleanupAppCaches().catch(() => {});
const form = document.querySelector('#loginForm');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  const message = document.querySelector('#loginMessage');
  try {
    const response = await fetch('/auth/login', { method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        username: document.querySelector('#username').value,
        password: document.querySelector('#password').value
      }) });
    document.querySelector('#password').value = '';
    if (response.ok) location.replace('/');
    else message.textContent = response.status === 429 ? 'Too many login attempts. Try again later.' : 'Invalid credentials';
  } catch { message.textContent = 'Unable to reach the server. Try again.'; }
  finally { button.disabled = false; }
});
