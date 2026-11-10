'use strict';
// Temporary device-test page for v2. No third-party code: a minimal Telegram
// bridge speaking the documented web-events protocol
// (https://core.telegram.org/api/web-events) plus the checks we need.

const $ = (id) => document.getElementById(id);
const results = new Map(); // name -> { state: 'ok'|'bad'|'wait', detail }
const order = [];
const logLines = [];
const viewportEvents = [];
const TELEGRAM_PUBLIC_KEY = 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d';
const WEB_ORIGIN = 'https://web.telegram.org';

// ---------------------------------------------------------------- results UI

function set(name, state, detail) {
  if (!results.has(name)) order.push(name);
  results.set(name, { state, detail: String(detail ?? '') });
  renderResults();
}

function renderResults() {
  const list = $('results');
  list.replaceChildren(...order.map((name) => {
    const { state, detail } = results.get(name);
    const li = document.createElement('li');
    const badge = document.createElement('span');
    badge.className = 'badge ' + state;
    badge.textContent = state === 'ok' ? 'OK' : state === 'bad' ? 'FAIL' : 'WAIT';
    const title = document.createElement('strong');
    title.textContent = name;
    const small = document.createElement('span');
    small.className = 'detail';
    small.textContent = detail;
    li.append(badge, title, small);
    return li;
  }));
}

function log(line) {
  logLines.push(new Date().toISOString().slice(11, 19) + ' ' + line);
  if (logLines.length > 200) logLines.shift();
  $('log').textContent = logLines.join('\n');
}

function errText(e) {
  return e && e.name ? `${e.name}: ${e.message}` : String(e);
}

// ---------------------------------------------------------- launch parameters

function readLaunch() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  let launch = {
    initData: hash.get('tgWebAppData') || '',
    version: hash.get('tgWebAppVersion') || '',
    platform: hash.get('tgWebAppPlatform') || '',
    themeParams: hash.get('tgWebAppThemeParams') || '',
    startParamUrl: query.get('tgWebAppStartParam') || hash.get('tgWebAppStartParam') || '',
    fromSession: false,
  };
  // A reload can lose the fragment, so keep this launch's values for the tab.
  try {
    if (launch.initData) sessionStorage.setItem('spike-launch', JSON.stringify(launch));
    else {
      const saved = sessionStorage.getItem('spike-launch');
      if (saved) launch = { ...JSON.parse(saved), fromSession: true };
    }
  } catch { /* storage may be unavailable */ }
  launch.init = new URLSearchParams(launch.initData);
  return launch;
}

const launch = readLaunch();

// --------------------------------------------------------------------- bridge

const listeners = {};
function on(type, fn) { (listeners[type] ||= []).push(fn); }

function receive(type, data) {
  log('← ' + type + (data ? ' ' + JSON.stringify(data).slice(0, 120) : ''));
  for (const fn of listeners[type] || []) {
    try { fn(data || {}); } catch (e) { log('handler error: ' + errText(e)); }
  }
}

window.Telegram = window.Telegram || {};
window.Telegram.WebView = Object.assign(window.Telegram.WebView || {}, { receiveEvent: receive });
window.TelegramGameProxy = { receiveEvent: receive };
window.TelegramGameProxy_receiveEvent = receive;

const inIframe = window.parent !== window;
window.addEventListener('message', (e) => {
  if (e.source !== window.parent || e.origin !== WEB_ORIGIN) return;
  let msg;
  try { msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
  if (msg && msg.eventType) receive(msg.eventType, msg.eventData);
});

function transport() {
  if (window.TelegramWebviewProxy && typeof window.TelegramWebviewProxy.postEvent === 'function') return 'webview-proxy';
  if (window.external && 'notify' in window.external) return 'external-notify';
  if (inIframe) return 'iframe-postMessage';
  return 'none';
}

function post(type, data) {
  log('→ ' + type + (data ? ' ' + JSON.stringify(data).slice(0, 120) : ''));
  const how = transport();
  try {
    if (how === 'webview-proxy') window.TelegramWebviewProxy.postEvent(type, JSON.stringify(data));
    else if (how === 'external-notify') window.external.notify(JSON.stringify({ eventType: type, eventData: data }));
    else if (how === 'iframe-postMessage') window.parent.postMessage(JSON.stringify({ eventType: type, eventData: data }), WEB_ORIGIN);
  } catch (e) {
    log('post failed: ' + errText(e));
  }
  return how;
}

// ---------------------------------------------------------------------- theme

function applyTheme(params) {
  if (!params) return;
  document.documentElement.classList.add('tg');
  const map = { bg_color: '--tg-bg', text_color: '--tg-text', hint_color: '--tg-hint',
    secondary_bg_color: '--tg-secondary-bg', button_color: '--tg-button', button_text_color: '--tg-button-text' };
  for (const [key, cssVar] of Object.entries(map)) {
    if (params[key]) document.documentElement.style.setProperty(cssVar, params[key]);
  }
}

// ---------------------------------------------------------------- base64url

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(text) {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
function fromHex(hex) {
  return Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
}

// ------------------------------------------------------------- settings (local)

function setting(key) { try { return localStorage.getItem('spike-' + key) || ''; } catch { return ''; } }
function saveSetting(key, value) { try { localStorage.setItem('spike-' + key, value); } catch { /* ignore */ } }

// ----------------------------------------------------------------------- tests

function testEnvironment() {
  set('Environment', 'ok',
    `platform=${launch.platform || '?'} telegram=${launch.version || '?'} bridge=${transport()} ` +
    `iframe=${inIframe} secureContext=${window.isSecureContext} subtle=${!!(crypto && crypto.subtle)}`);
}

async function testCrypto() {
  const s = crypto.subtle;
  const steps = [];
  try {
    const ecdhA = await s.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const ecdhB = await s.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const ab = new Uint8Array(await s.deriveBits({ name: 'ECDH', public: ecdhB.publicKey }, ecdhA.privateKey, 256));
    const ba = new Uint8Array(await s.deriveBits({ name: 'ECDH', public: ecdhA.publicKey }, ecdhB.privateKey, 256));
    if (ab.join() !== ba.join()) throw new Error('ECDH secrets differ');
    steps.push('ECDH');

    const ecdsa = await s.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const data = new TextEncoder().encode('spike');
    const sig = await s.sign({ name: 'ECDSA', hash: 'SHA-256' }, ecdsa.privateKey, data);
    if (!(await s.verify({ name: 'ECDSA', hash: 'SHA-256' }, ecdsa.publicKey, sig, data))) throw new Error('ECDSA verify failed');
    if (sig.byteLength !== 64) throw new Error('ECDSA signature is ' + sig.byteLength + ' bytes, expected 64 (P1363)');
    steps.push('ECDSA');

    const ikm = await s.importKey('raw', ab, 'HKDF', false, ['deriveBits']);
    const okm = await s.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: data }, ikm, 256);
    steps.push('HKDF');

    const aes = await s.importKey('raw', okm, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await s.encrypt({ name: 'AES-GCM', iv }, aes, data);
    const pt = new Uint8Array(await s.decrypt({ name: 'AES-GCM', iv }, aes, ct));
    if (new TextDecoder().decode(pt) !== 'spike') throw new Error('AES-GCM round trip failed');
    steps.push('AES-GCM');

    const spki = await s.exportKey('raw', ecdhA.publicKey);
    if (spki.byteLength !== 65) throw new Error('raw P-256 public key is not 65 bytes');
    let privateExported = true;
    try { await s.exportKey('pkcs8', ecdhA.privateKey); } catch { privateExported = false; }
    if (privateExported) throw new Error('a non-extractable private key could be exported');
    steps.push('non-extractable');

    // Wrapping a copyable key for the vault (extractable PKCS8 under AES-GCM).
    const copyable = await s.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const vault = await s.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
    const wiv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await s.wrapKey('pkcs8', copyable.privateKey, vault, { name: 'AES-GCM', iv: wiv });
    await s.unwrapKey('pkcs8', wrapped, vault, { name: 'AES-GCM', iv: wiv },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    steps.push('wrap/unwrap');

    set('Crypto P-256', 'ok', steps.join(', '));
  } catch (e) {
    set('Crypto P-256', 'bad', `passed: ${steps.join(', ') || 'none'}; failed: ${errText(e)}`);
  }

  const extra = [];
  for (const [name, alg, usages] of [['X25519', { name: 'X25519' }, ['deriveBits']], ['Ed25519', { name: 'Ed25519' }, ['sign', 'verify']]]) {
    try { await crypto.subtle.generateKey(alg, false, usages); extra.push(name + ' yes'); } catch { extra.push(name + ' no'); }
  }
  set('Crypto extras (info only)', 'ok', extra.join(', '));
}

// IndexedDB helpers.
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('spike-v1', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('keys'); req.result.createObjectStore('meta'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idb(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function testStorage() {
  let lsOpens = 'n/a';
  try {
    const n = Number(localStorage.getItem('spike-opens') || '0') + 1;
    localStorage.setItem('spike-opens', String(n));
    lsOpens = n;
  } catch { /* ignore */ }

  try {
    const db = await openDb();
    const now = Date.now();
    let meta = await idb(db, 'meta', 'readonly', (st) => st.get('state'));
    let keys = await idb(db, 'keys', 'readonly', (st) => st.get('signing'));
    const fresh = !meta || !keys;
    if (fresh) {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      keys = { privateKey: pair.privateKey, publicKey: pair.publicKey };
      meta = { createdAt: now, opens: 0, lastOpen: now };
      await idb(db, 'keys', 'readwrite', (st) => st.put(keys, 'signing'));
    }
    meta.opens += 1;
    const sinceLast = now - meta.lastOpen;
    meta.lastOpen = now;
    await idb(db, 'meta', 'readwrite', (st) => st.put(meta, 'state'));

    const data = new TextEncoder().encode('survives?');
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, data);
    const usable = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, sig, data);
    let stillLocked = true;
    try { await crypto.subtle.exportKey('pkcs8', keys.privateKey); stillLocked = false; } catch { /* expected */ }

    const ageHours = ((now - meta.createdAt) / 3600000).toFixed(1);
    set('Stored key', usable && stillLocked ? 'ok' : 'bad',
      `${fresh ? 'NEW key created now' : 'key SURVIVED'}; age ${ageHours} h; opens ${meta.opens}; ` +
      `last open ${(sinceLast / 60000).toFixed(0)} min ago; usable=${usable}; non-extractable=${stillLocked}; localStorage opens=${lsOpens}`);
  } catch (e) {
    set('Stored key', 'bad', 'IndexedDB/CryptoKey failed: ' + errText(e));
  }

  try {
    const before = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : 'n/a';
    const asked = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : 'n/a';
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    set('Storage persistence (info)', 'ok',
      `persisted before=${before}, after asking=${asked}` + (est ? `, quota≈${Math.round(est.quota / 1048576)} MB` : ''));
  } catch (e) {
    set('Storage persistence (info)', 'bad', errText(e));
  }
}

async function testLaunch() {
  const init = launch.init;
  const startParam = init.get('start_param') || '';
  const expected = setting('expected-reg');
  const authAge = init.get('auth_date') ? Math.round(Date.now() / 1000 - Number(init.get('auth_date'))) : null;
  set('Launch data', launch.initData ? 'ok' : 'bad',
    `initData=${launch.initData ? 'present' : 'MISSING'}${launch.fromSession ? ' (from this tab, after reload)' : ''}; ` +
    `signature field=${init.has('signature') ? 'present' : 'MISSING'}; hash field=${init.has('hash') ? 'present' : 'missing'}; ` +
    `chat_type=${init.get('chat_type') || '-'}; auth_date age=${authAge === null ? '-' : authAge + ' s'}; ` +
    `fields=${[...init.keys()].sort().join(',')}`);

  if (expected) {
    const arrived = startParam === expected;
    set('Reopen with reg code', arrived ? 'ok' : 'bad',
      arrived ? `start_param matches the code (via ${setting('expected-reg-via')}); url param ${launch.startParamUrl === expected ? 'matches' : 'differs/missing'}`
        : `expected the code from the last reopen, got start_param=${startParam ? startParam.slice(0, 12) + '…' : '(none)'}`);
    if (arrived) saveSetting('expected-reg', '');
  } else {
    set('Reopen with reg code', 'wait', startParam ? `opened with start_param=${startParam.slice(0, 12)}…` : 'press a "Reopen" button below');
  }

  const botId = setting('botid');
  if (!init.has('signature')) {
    set('Ed25519 signature', 'bad', 'no signature field in initData');
  } else if (!botId) {
    set('Ed25519 signature', 'wait', 'enter the bot ID in Setup to check it');
  } else {
    try {
      const pairs = [...init.entries()].filter(([k]) => k !== 'hash' && k !== 'signature')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`);
      const checkString = `${botId}:WebAppData\n` + pairs.join('\n');
      const key = await crypto.subtle.importKey('raw', fromHex(TELEGRAM_PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
      const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, fromB64url(init.get('signature')), new TextEncoder().encode(checkString));
      set('Ed25519 signature', ok ? 'ok' : 'bad', ok ? `valid; covers start_param=${startParam ? 'yes' : '(none in this launch)'}` : 'INVALID (wrong bot ID?)');
    } catch (e) {
      set('Ed25519 signature', 'wait', 'this browser cannot check Ed25519 itself (' + errText(e) + '); the server will');
    }
  }
}

function reopen(via) {
  const bot = setting('bot');
  if (!bot) { set('Reopen with reg code', 'bad', 'enter the bot username in Setup first'); return; }
  const code = 'reg' + b64url(crypto.getRandomValues(new Uint8Array(32)));
  saveSetting('expected-reg', code);
  saveSetting('expected-reg-via', via);
  const path = via === 'direct link' ? `/${bot}/app?startapp=${code}` : `/${bot}?startapp=${code}`;
  set('Reopen with reg code', 'wait', `asked Telegram to open ${via} (${path.length} chars); if nothing happens, that's a FAIL`);
  post('web_app_open_tg_link', { path_full: path });
}

function testBackButton() {
  set('Back button', 'wait', 'press the back button in Telegram\'s header');
  post('web_app_setup_back_button', { is_visible: true });
}
on('back_button_pressed', () => {
  set('Back button', 'ok', 'press received');
  post('web_app_setup_back_button', { is_visible: false });
});

function testWriteAccess() {
  set('Write access', 'wait', 'answer Telegram\'s prompt');
  post('web_app_request_write_access');
}
on('write_access_requested', (d) => set('Write access', d.status === 'allowed' ? 'ok' : 'bad', 'status=' + d.status));

function testFullscreen() {
  set('Fullscreen', 'wait', 'requested');
  post('web_app_request_fullscreen');
}
on('fullscreen_changed', (d) => {
  set('Fullscreen', 'ok', 'is_fullscreen=' + d.is_fullscreen);
  if (d.is_fullscreen) setTimeout(() => post('web_app_exit_fullscreen'), 3000);
});
on('fullscreen_failed', (d) => set('Fullscreen', 'bad', 'error=' + d.error));

on('theme_changed', (d) => { applyTheme(d.theme_params); set('Theme', 'ok', 'theme_changed received'); });
on('viewport_changed', (d) => {
  viewportEvents.push({ h: d.height, stable: d.is_state_stable, expanded: d.is_expanded });
  set('Viewport', 'ok', `height=${d.height} expanded=${d.is_expanded} stable=${d.is_state_stable} (events: ${viewportEvents.length})`);
});
on('safe_area_changed', (d) => set('Safe area', 'ok', JSON.stringify(d)));
on('content_safe_area_changed', (d) => set('Content safe area', 'ok', JSON.stringify(d)));

async function testCamera() {
  const video = $('video');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.hidden = false;
    video.srcObject = stream;
    await video.play();
    set('Camera', 'ok', 'preview running (stops in 8 s)');
    setTimeout(() => { stream.getTracks().forEach((t) => t.stop()); video.hidden = true; }, 8000);
  } catch (e) {
    set('Camera', 'bad', errText(e));
  }
}

function watchKeyboard() {
  const box = $('kbd');
  box.addEventListener('focus', () => {
    const vv = window.visualViewport;
    const start = { inner: window.innerHeight, vv: vv ? Math.round(vv.height) : null };
    set('Keyboard', 'wait', 'measuring…');
    setTimeout(() => {
      const end = { inner: window.innerHeight, vv: vv ? Math.round(vv.height) : null };
      const rect = box.getBoundingClientRect();
      const visible = vv ? rect.bottom <= vv.height + vv.offsetTop + 1 : true;
      set('Keyboard', visible ? 'ok' : 'bad',
        `innerHeight ${start.inner}→${end.inner}; visualViewport ${start.vv}→${end.vv}; text box visible above keyboard=${visible}`);
    }, 1200);
  });
}

async function reach(url, cors) {
  const t0 = performance.now();
  try {
    await fetch(url, { mode: cors ? 'cors' : 'no-cors', cache: 'no-store', credentials: 'omit' });
    return `ok ${Math.round(performance.now() - t0)} ms`;
  } catch (e) {
    return 'FAIL ' + (e.name || 'error');
  }
}

async function testNetwork() {
  set('Network', 'wait', 'checking…');
  const checks = [
    ['this site', './ping.txt', true],
    ['telegram.org', 'https://telegram.org/js/telegram-web-app.js', false],
    ['AWS function URL us-east-1', 'https://spike-test.lambda-url.us-east-1.on.aws/', false],
    ['AWS function URL eu-west-1', 'https://spike-test.lambda-url.eu-west-1.on.aws/', false],
    ['AWS us-east-1', 'https://lambda.us-east-1.amazonaws.com/', false],
    ['AWS eu-west-1', 'https://lambda.eu-west-1.amazonaws.com/', false],
    ['AWS eu-central-1', 'https://lambda.eu-central-1.amazonaws.com/', false],
  ];
  const out = [];
  for (const [name, url, cors] of checks) out.push(`${name}: ${await reach(url, cors)}`);
  set('Network', out.every((l) => l.includes(': ok')) ? 'ok' : 'bad', out.join('; '));
}

// --------------------------------------------------------------------- report

function report() {
  const lines = [`v2 device test report, ${new Date().toISOString()}`, `UA: ${navigator.userAgent}`];
  for (const name of order) {
    const r = results.get(name);
    lines.push(`[${r.state.toUpperCase()}] ${name}: ${r.detail}`);
  }
  lines.push('Bridge events: ' + logLines.filter((l) => l.includes('← ')).map((l) => l.split('← ')[1].split(' ')[0]).join(', '));
  return lines.join('\n');
}

async function copyReport() {
  const text = report();
  const area = $('report');
  area.value = text;
  area.hidden = false;
  try {
    await navigator.clipboard.writeText(text);
    set('Copy report', 'ok', 'copied to the clipboard');
  } catch {
    area.focus();
    area.select();
    set('Copy report', 'wait', 'clipboard not allowed here: select the text in the box and copy it');
  }
}

async function resetData() {
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
  await new Promise((resolve) => { const r = indexedDB.deleteDatabase('spike-v1'); r.onsuccess = r.onerror = r.onblocked = resolve; });
  set('Reset', 'ok', 'test data deleted; reopen the app to start fresh');
}

// ----------------------------------------------------------------------- start

window.addEventListener('error', (e) => set('Page error', 'bad', `${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => set('Page error', 'bad', 'unhandled: ' + errText(e.reason)));

function start() {
  if (launch.themeParams) { try { applyTheme(JSON.parse(launch.themeParams)); } catch { /* ignore */ } }

  $('bot').value = setting('bot');
  $('botid').value = setting('botid');
  const showSetup = () => {
    const bot = setting('bot');
    const id = setting('botid');
    $('setup-status').textContent = bot
      ? `Saved on this device: @${bot}${id ? ', bot ID set' : ', no bot ID'}.`
      : 'Nothing saved yet.';
  };
  showSetup();
  $('save-setup').addEventListener('click', () => {
    const bot = $('bot').value.trim().replace(/^@/, '');
    saveSetting('bot', bot);
    saveSetting('botid', $('botid').value.trim());
    if (setting('bot') !== bot) {
      $('setup-status').textContent = 'Could not save: this browser blocks local storage here.';
      set('Setup', 'bad', 'localStorage write did not stick');
      return;
    }
    showSetup();
    $('setup-status').textContent += ' ✓';
    set('Setup', 'ok', 'saved and read back');
    post('web_app_trigger_haptic_feedback', { type: 'notification', notification_type: 'success' });
    testLaunch();
  });
  $('reopen-direct').onclick = () => reopen('direct link');
  $('reopen-main').onclick = () => reopen('main app');
  $('back').onclick = testBackButton;
  $('write').onclick = testWriteAccess;
  $('fullscreen').onclick = testFullscreen;
  $('haptic').onclick = () => { post('web_app_trigger_haptic_feedback', { type: 'impact', impact_style: 'medium' }); set('Haptic', 'wait', 'did you feel it? (report manually)'); };
  $('camera').onclick = testCamera;
  $('network').onclick = testNetwork;
  $('close').onclick = () => post('web_app_close');
  $('copy').onclick = copyReport;
  $('reset').onclick = resetData;
  watchKeyboard();

  if (inIframe) post('iframe_ready', { reload_supported: true });
  post('web_app_ready');
  post('web_app_expand');
  post('web_app_request_theme');
  post('web_app_request_viewport');
  post('web_app_request_safe_area');
  post('web_app_request_content_safe_area');

  testEnvironment();
  if (!(crypto && crypto.subtle)) set('Crypto P-256', 'bad', 'crypto.subtle is missing');
  else testCrypto();
  testStorage();
  testLaunch();
  set('Theme', 'wait', 'waiting for theme_changed');
  set('Viewport', 'wait', 'waiting for viewport_changed');
}

start();
