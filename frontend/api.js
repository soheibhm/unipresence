/**
 * UniPresence — API Helper
 * Centralises all fetch calls + token management
 */

const API = (() => {
  const BASE = '/api';

  function getToken() { return localStorage.getItem('up_token'); }
  function setToken(t){ localStorage.setItem('up_token', t); }
  function getUser()  { return JSON.parse(localStorage.getItem('up_user') || 'null'); }
  function setUser(u) { localStorage.setItem('up_user', JSON.stringify(u)); }
  function logout()   {
    localStorage.removeItem('up_token');
    localStorage.removeItem('up_user');
    window.location.href = '/login.html';
  }

  async function request(method, path, body, isFormData = false) {
    const headers = { Authorization: `Bearer ${getToken()}` };
    if (!isFormData) headers['Content-Type'] = 'application/json';
    const opts = { method, headers };
    if (body) opts.body = isFormData ? body : JSON.stringify(body);
    const res = await fetch(BASE + path, opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { logout(); return; }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  return {
    getToken, setToken, getUser, setUser, logout,
    get:    (path)         => request('GET',    path),
    post:   (path, body)   => request('POST',   path, body),
    put:    (path, body)   => request('PUT',    path, body),
    delete: (path)         => request('DELETE', path),
    upload: (path, form)   => request('POST',   path, form, true),

    // ── Auth ──────────────────────────────────────────────────
    login(email, password) {
      return fetch(BASE + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      }).then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        setToken(d.token);
        setUser(d.user);
        return d;
      });
    },

    // ── Guard: redirect if not authenticated or wrong role ───
    requireAuth(expectedRole) {
      const token = getToken();
      const user  = getUser();
      if (!token || !user) { window.location.href = '/login.html'; return null; }
      if (expectedRole && user.role !== expectedRole) {
        window.location.href = `/${user.role === 'admin' ? 'admin' : user.role === 'professeur' ? 'professor' : 'student'}.html`;
        return null;
      }
      return user;
    }
  };
})();

// Expose globally
window.API = API;
