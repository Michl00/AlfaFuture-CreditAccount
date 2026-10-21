const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'static/demo/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'static/demo/app.js'), 'utf8');

function setup(t, url = 'http://localhost/demo') {
  const dom = new JSDOM(html, {url, runScripts: 'outside-only'});
  t.after(() => dom.window.close());
  const {window} = dom;
  const calls = [];
  window.TextEncoder = TextEncoder;
  window.AbortController = AbortController;
  window.fetch = async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify({id: 1, username: 'demo_user'}), {
      status: 200, headers: {'Content-Type': 'application/json'},
    });
  };
  window.eval(script);
  const get = id => window.document.getElementById(id);
  const select = id => window.document.querySelector(`[data-operation="${id}"]`).click();
  const set = (name, value) => {get(`field-${name}`).value = value;};
  const submit = async () => {
    get('request-form').dispatchEvent(new window.Event('submit', {bubbles: true, cancelable: true}));
    await new Promise(resolve => setImmediate(resolve));
  };
  return {window, calls, get, select, set, submit};
}

test('registration sends JSON, masks password, and displays response and history', async t => {
  const ui = setup(t);
  for (const [key, value] of Object.entries({email: 'demo@example.com', password: 'secret-password', username: 'demo_user', inn: '7707083893'})) ui.set(key, value);
  await ui.submit();
  const [url, options] = ui.calls[0];
  assert.equal(url, '/auth/register');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(options.body).password, 'secret-password');
  assert.ok(!ui.get('request-view').textContent.includes('secret-password'));
  assert.match(ui.get('response-view').textContent, /demo_user/);
  assert.match(ui.get('response-status').textContent, /200/);
  assert.equal(ui.get('history-count').textContent, '1');
  ui.get('clear-history').click();
  assert.equal(ui.get('history-count').textContent, '0');
});

test('login uses OAuth2 form encoding and handles empty 204 response', async t => {
  const ui = setup(t);
  ui.select('login');
  ui.set('email', 'demo+test@example.com');
  ui.set('password', 'p&ss=word');
  ui.window.fetch = async (...args) => {ui.calls.push(args); return new Response(null, {status: 204});};
  await ui.submit();
  const [url, options] = ui.calls[0];
  assert.equal(url, '/auth/login');
  assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(options.body), {username: 'demo+test@example.com', password: 'p&ss=word'});
  assert.equal(ui.get('response-view').textContent, '(пустой ответ)');
});

test('email deep link fills token, removes URL token, and waits for user action', t => {
  const ui = setup(t, 'http://localhost/demo?flow=reset&token=secret%2Btoken');
  assert.equal(ui.get('field-token').value, 'secret+token');
  assert.equal(ui.window.location.search, '');
  assert.equal(ui.get('endpoint-path').textContent, '/auth/reset-password');
  assert.equal(ui.calls.length, 0);
});

test('custom request rejects external origins and invalid JSON without sending', async t => {
  const ui = setup(t);
  ui.select('custom');
  for (const url of ['https://evil.example/profile', '//evil.example/profile', '/\\evil.example/profile']) {
    ui.set('path', url);
    await ui.submit();
    assert.equal(ui.calls.length, 0);
    assert.match(ui.get('response-status').textContent, /Ошибка ввода/);
  }
  ui.set('path', '/users/me');
  ui.set('method', 'PATCH');
  ui.set('body', '{"password": "sensitive-invalid-json');
  await ui.submit();
  assert.equal(ui.calls.length, 0);
  assert.ok(!ui.get('response-view').textContent.includes('sensitive'));
});

test('custom request masks query and nested body secrets, but sends original values', async t => {
  const ui = setup(t);
  ui.select('custom');
  ui.set('path', '/auth/verify?token=query-secret');
  ui.set('method', 'POST');
  ui.set('body', '{"nested":{"token":"body-secret"}}');
  await ui.submit();
  assert.equal(ui.calls[0][0], '/auth/verify?token=query-secret');
  assert.match(ui.calls[0][1].body, /body-secret/);
  assert.ok(!ui.get('request-view').textContent.includes('query-secret'));
  assert.ok(!ui.get('request-view').textContent.includes('body-secret'));
  assert.ok(!ui.get('history').textContent.includes('query-secret'));
});

test('HTTP errors are shown as errors and response markup is rendered as text', async t => {
  const ui = setup(t);
  ui.select('profile');
  ui.window.fetch = async () => new Response('<script>window.injected = true</script>', {status: 500});
  await ui.submit();
  assert.ok(ui.get('response-status').classList.contains('error'));
  assert.match(ui.get('response-view').textContent, /<script>/);
  assert.equal(ui.get('response-view').querySelector('script'), null);
  assert.equal(ui.window.injected, undefined);
});

test('network failure restores submit button and shows useful error', async t => {
  const ui = setup(t);
  ui.select('profile');
  ui.window.fetch = async () => {throw new TypeError('Failed to fetch');};
  await ui.submit();
  assert.equal(ui.get('send').disabled, false);
  assert.match(ui.get('response-status').textContent, /Ошибка сети/);
});

test('tabs expose the selected panel and support arrow keys', async t => {
  const ui = setup(t);
  ui.select('profile');
  await ui.submit();
  ui.get('tab-request').click();
  assert.equal(ui.get('request-view').hidden, false);
  assert.equal(ui.get('response-view').hidden, true);
  ui.get('tab-request').dispatchEvent(new ui.window.KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
  assert.equal(ui.get('headers-view').hidden, false);
  assert.equal(ui.get('tab-headers').getAttribute('aria-selected'), 'true');
});
