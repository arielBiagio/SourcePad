const $ = id => document.getElementById(id);
const signInForm = $('signInForm');
const signUpForm = $('signUpForm');
let config;
let submitting = false;

function showFeedback(message, type = 'info') {
  $('authFeedback').classList.remove('is-error', 'is-info');
  void $('authFeedback').offsetWidth;
  $('authFeedback').textContent = message;
  $('authFeedback').classList.add(type === 'error' ? 'is-error' : 'is-info');
}
function setBusy(value) {
  submitting = value;
  for (const form of [signInForm, signUpForm]) form.querySelector('button[type="submit"]').disabled = value || !config?.ready;
  $('signInTab').disabled = value;
  $('signUpTab').disabled = value;
  $('connectionStatus').textContent = value ? 'conectando…' : config?.ready ? 'listo' : 'pendiente';
}
function setMode(mode) {
  const signIn = mode === 'sign-in';
  signInForm.classList.toggle('hidden', !signIn);
  signUpForm.classList.toggle('hidden', signIn);
  for (const [id, active] of [['signInTab', signIn], ['signUpTab', !signIn]]) {
    $(id).classList.toggle('tab-active', active);
    $(id).setAttribute('aria-selected', String(active));
    $(id).style.color = active ? 'var(--text)' : 'var(--text-dim)';
  }
  $('authTitle').textContent = signIn ? 'Iniciar sesión' : 'Crear cuenta';
  $('authDescription').textContent = signIn ? 'Ingresá para abrir tu espacio personal.' : 'Creá tu cuenta para organizar tus ideas en cuadernos.';
  if (config?.ready) showFeedback('');
}
async function requestAuth(path, body) {
  const response = await fetch(`/api/auth/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.message || payload?.error?.message || payload?.error || 'Intentá nuevamente.');
  return payload;
}
async function submit(event, registration) {
  event.preventDefault();
  const form = registration ? signUpForm : signInForm;
  if (!config?.ready || submitting || !form.reportValidity()) return;
  setBusy(true);
  showFeedback(registration ? 'Creando tu cuenta…' : 'Validando credenciales…');
  try {
    const result = await requestAuth(registration ? 'sign-up/email' : 'sign-in/email', {
      email: form.elements.email.value.trim(),
      password: form.elements.password.value,
      ...(registration ? { name: form.elements.name.value.trim() } : { rememberMe: form.elements.remember.checked }),
    });
    form.elements.password.value = '';
    if (result.confirmationRequired) {
      showFeedback('Revisá tu email y abrí el enlace de confirmación en este mismo navegador. Si ya tenías cuenta, iniciá sesión.');
      setBusy(false);
      return;
    }
    location.assign(config.home);
  } catch (error) {
    showFeedback(error.name === 'TimeoutError' ? 'La conexión tardó demasiado. Intentá nuevamente.' : `No se pudo ${registration ? 'crear la cuenta' : 'iniciar sesión'}: ${error.message}`, 'error');
    setBusy(false);
  }
}
$('signInTab').addEventListener('click', () => setMode('sign-in'));
$('signUpTab').addEventListener('click', () => setMode('sign-up'));
signInForm.addEventListener('submit', event => submit(event, false));
signUpForm.addEventListener('submit', event => submit(event, true));
$('forgotPassword').addEventListener('click', () => showFeedback('La recuperación de contraseña estará disponible en una próxima actualización.'));
setBusy(false);
try {
  const response = await fetch('/api/config', { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error();
  config = await response.json();
  setBusy(false);
  if (!config.ready) showFeedback('Tu espacio todavía no está conectado. Mientras tanto, podés explorar los cuadernos de ejemplo.');
  else {
    const session = await fetch('/api/me', { credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
    if (session.ok) location.replace(config.home);
    else if (session.status !== 401) showFeedback('No se pudo comprobar tu sesión. Intentá iniciar sesión nuevamente.', 'error');
  }
  const confirmation = new URLSearchParams(location.search).get('confirmation');
  if (confirmation === 'error' || confirmation === 'browser') {
    showFeedback(confirmation === 'browser'
      ? 'Para entrar automáticamente, abrí el enlace en el navegador donde te registraste. Si ya confirmaste tu email, podés iniciar sesión con tu email y contraseña.'
      : 'El enlace de confirmación venció o ya fue usado. Si ya confirmaste tu email, iniciá sesión con tu email y contraseña.', 'error');
    history.replaceState({}, '', '/auth.html');
  }
} catch {
  showFeedback('No se pudo conectar con la aplicación. Recargá la página para intentar de nuevo.', 'error');
}
