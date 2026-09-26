document.querySelector('#login').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  const error = document.querySelector('#error'); error.textContent = '';
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.querySelector('#password').value }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error);
    location.href = '/';
  } catch (e) { error.textContent = e.message || 'Unable to sign in.'; } finally { button.disabled = false; }
});
