const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const credit = require('../static/demo/credit.js');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'static/demo/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'static/demo/app.js'), 'utf8');
const domain = fs.readFileSync(path.join(root, 'static/demo/credit.js'), 'utf8');
const sample = {product: 'working', amount: 1500000, months: 24, company: 'ООО «Вектор»', inn: '7701234560', revenue: 1200000, expenses: 700000, debt: 20000, age: 24};
const tick = () => new Promise(resolve => setImmediate(resolve));

async function setup(t, options = {}) {
  const dom = new JSDOM(html, {url: options.url || 'http://localhost/demo', runScripts: 'outside-only'});
  t.after(() => dom.window.close());
  const {window} = dom;
  const calls = [];
  const clock = {value: 1800000000000};
  const intervals = [];
  window.Date.now = () => clock.value;
  window.AbortController = AbortController;
  window.scrollTo = () => {};
  window.setInterval = callback => {intervals.push(callback); return 1;};
  window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  window.HTMLDialogElement.prototype.close = function () {this.open = false; this.dispatchEvent(new window.Event('close'));};
  if (!window.crypto.randomUUID) window.crypto.randomUUID = () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  if (options.storage) for (const [key, value] of Object.entries(options.storage)) window.localStorage.setItem(key, value);
  window.fetch = async (...args) => {
    calls.push(args);
    return options.fetch ? options.fetch(...args) : new Response('{"detail":"Unauthorized"}', {status: 401});
  };
  window.eval(domain);
  window.eval(script);
  await tick();
  const get = id => window.document.getElementById(id);
  const click = selector => {
    const element = window.document.querySelector(selector);
    assert.ok(element, `Missing ${selector}`);
    element.click();
  };
  const set = (id, value) => {get(id).value = value; get(id).dispatchEvent(new window.Event('input', {bubbles: true}));};
  const submit = async id => {get(id).dispatchEvent(new window.Event('submit', {bubbles: true, cancelable: true})); await tick();};
  const advance = () => {clock.value += 7000; intervals.forEach(callback => callback());};
  const state = key => JSON.parse(window.localStorage.getItem(key || 'credit-cabinet-v1:guest'));
  return {window, calls, clock, get, click, set, submit, advance, state};
}
async function fillApplication(ui, overrides = {}) {
  ui.click('[data-action="apply"]');
  for (const key of ['amount', 'months']) if (overrides[key] !== undefined) ui.set(`app-${key}`, overrides[key]);
  await ui.submit('application-form');
  ui.click('[data-action="sample"]');
  for (const [key, value] of Object.entries(overrides)) if (ui.get(`app-${key}`)) ui.set(`app-${key}`, value);
  await ui.submit('application-form');
  ui.window.document.querySelector('[name="consent"]').checked = true;
  await ui.submit('application-form');
}

test('payment calculation and INN validation handle expected cases', () => {
  assert.equal(credit.payment(120000, 12, 0), 10000);
  assert.ok(credit.payment(1500000, 24, 24.9) > 70000);
  assert.ok(credit.validInn('7701234560'));
  assert.ok(!credit.validInn('7701234561'));
  assert.ok(!credit.validInn('٧٧٠١٢٣٤٥٦٠'));
  assert.equal(credit.validate(sample), null);
  assert.match(credit.validate({...sample, amount: 10000001}), /сумму/);
  assert.match(credit.validate({...sample, months: 7.5}), /срок/);
});

test('demonstration decisions cover approval, alternative, refusal and clarification', () => {
  assert.equal(credit.decide(sample).status, 'approved');
  const alternative = credit.decide({...sample, expenses: 1000000, debt: 50000});
  assert.equal(alternative.status, 'alternative');
  assert.ok(alternative.offeredAmount < sample.amount);
  assert.equal(credit.decide({...sample, expenses: 1200000}).status, 'declined');
  assert.equal(credit.decide({...sample, age: 2}).status, 'needs_info');
  assert.equal(credit.decide({...sample, age: 2, clarification: 'Подписаны договоры на поставки.'}).status, 'approved');
});

test('dashboard presents business actions without developer internals', async t => {
  const ui = await setup(t);
  assert.match(ui.get('home-page').textContent, /финансирования/);
  assert.equal(ui.get('home-products').querySelectorAll('.product-card').length, 3);
  assert.doesNotMatch(ui.window.document.body.textContent, /REST|JSON|HTTP|Swagger|Ответ сервера|Выберите метод/i);
  assert.equal(ui.calls.length, 1); // Restore login silently.
  ui.click('[data-page="applications"]');
  assert.equal(ui.get('applications-page').hidden, false);
  assert.equal(ui.get('home-page').hidden, true);
});

test('calculator transfers selected terms to the application', async t => {
  const ui = await setup(t);
  ui.set('calc-amount', 2000000);
  ui.get('calc-term').value = '60';
  ui.get('calculator-apply').click();
  assert.equal(ui.get('app-amount').value, '2 000 000');
  assert.equal(ui.get('app-months').value, '60');
  assert.equal(ui.get('app-product').value, 'equipment');
});

test('application completes, receives decision, accepts terms, and persists after reload', async t => {
  const ui = await setup(t);
  await fillApplication(ui);
  assert.equal(ui.state().draft, null);
  assert.equal(ui.state().applications[0].status, 'review');
  assert.match(ui.get('detail-content').textContent, /На рассмотрении/);
  ui.advance();
  assert.equal(ui.state().applications[0].status, 'approved');
  ui.click('[data-action="accept"]');
  assert.equal(ui.state().applications[0].status, 'accepted');
  assert.match(ui.get('detail-content').textContent, /средства не переводились/);
  const restored = await setup(t, {storage: {'credit-cabinet-v1:guest': JSON.stringify(ui.state())}});
  assert.match(restored.get('home-applications').textContent, /Условия приняты/);
  assert.equal(restored.calls.length, 1); // No financial API requests.
});

test('clarification resumes review and produces a new result', async t => {
  const ui = await setup(t);
  await fillApplication(ui, {age: 2});
  ui.advance();
  assert.equal(ui.state().applications[0].status, 'needs_info');
  ui.set('clarification', 'Уже заключены договоры на ежемесячные поставки товаров.');
  await ui.submit('clarification-form');
  assert.equal(ui.state().applications[0].status, 'review');
  ui.advance();
  assert.equal(ui.state().applications[0].status, 'approved');
});

test('invalid INN prevents application submission', async t => {
  const ui = await setup(t);
  ui.click('[data-action="apply"]');
  await ui.submit('application-form');
  ui.click('[data-action="sample"]');
  ui.set('app-inn', '7701234561');
  await ui.submit('application-form');
  assert.equal(ui.get('application-error').hidden, false);
  assert.match(ui.get('application-error').textContent, /ИНН/);
  assert.equal(ui.state().applications.length, 0);
});

test('draft survives closing and reload, and can be deleted', async t => {
  const ui = await setup(t);
  ui.click('[data-action="apply"]');
  ui.set('app-amount', 2100000);
  ui.click('[data-close="application-dialog"]');
  const restored = await setup(t, {storage: {'credit-cabinet-v1:guest': JSON.stringify(ui.state())}});
  restored.click('[data-action="apply"]');
  assert.equal(restored.get('app-amount').value, '2 100 000');
  restored.click('[data-close="application-dialog"]');
  restored.click('[data-action="delete-draft"]');
  assert.equal(restored.state().draft, null);
});

test('email deep link opens a human form and removes token without submitting it', async t => {
  const ui = await setup(t, {url: 'http://localhost/demo?flow=reset&token=secret%2Btoken'});
  assert.equal(ui.get('account-token').value, 'secret+token');
  assert.equal(ui.window.location.search, '');
  assert.equal(ui.get('account-title').textContent, 'Новый пароль');
  assert.equal(ui.calls.length, 1);
});

test('login uses form encoding, restores user workspace and never stores credentials', async t => {
  let loggedIn = false;
  const ui = await setup(t, {fetch: async (url, options) => {
    if (url === '/auth/login') {loggedIn = true; return new Response(null, {status: 204});}
    return loggedIn ? new Response(JSON.stringify({id: 3, username: 'Мария', email: 'demo@example.com', is_verified: false})) : new Response('{}', {status: 401});
  }});
  ui.click('[data-action="account"]');
  ui.set('account-email', 'demo+test@example.com');
  ui.set('account-password', 'secret-password');
  await ui.submit('account-form');
  const [, options] = ui.calls.find(([url]) => url === '/auth/login');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(options.body), {username: 'demo+test@example.com', password: 'secret-password'});
  assert.equal(ui.get('account-name').textContent, 'Мария');
  assert.equal(ui.get('account-dialog').open, false);
  ui.click('[data-action="apply"]');
  assert.ok(ui.window.localStorage.getItem('credit-cabinet-v1:3'));
  assert.doesNotMatch(ui.window.localStorage.getItem('credit-cabinet-v1:3'), /secret-password|demo\+test/);
});

test('login failures show useful text instead of raw server details', async t => {
  const ui = await setup(t, {fetch: async url => new Response(JSON.stringify({detail: url === '/auth/login' ? 'LOGIN_BAD_CREDENTIALS' : 'Unauthorized'}), {status: url === '/auth/login' ? 400 : 401})});
  ui.click('[data-action="account"]');
  ui.set('account-email', 'demo@example.com');
  ui.set('account-password', 'wrong-password');
  await ui.submit('account-form');
  assert.match(ui.get('account-message').textContent, /Проверьте почту и пароль/);
  assert.doesNotMatch(ui.get('account-message').textContent, /LOGIN_BAD_CREDENTIALS|400|detail/);
  assert.equal(ui.get('account-submit').disabled, false);
});

test('company names are rendered as text, not HTML', async t => {
  const ui = await setup(t);
  await fillApplication(ui, {company: '<img src=x onerror="window.injected=true">'});
  assert.equal(ui.get('applications-list').querySelector('img'), null);
  assert.equal(ui.get('detail-content').querySelector('img'), null);
  assert.equal(ui.window.injected, undefined);
});

test('unavailable storage leaves the working flow usable and warns the user', async t => {
  const ui = await setup(t);
  ui.window.Storage.prototype.setItem = () => {throw new Error('Quota exceeded');};
  ui.click('[data-action="apply"]');
  assert.equal(ui.get('application-dialog').open, true);
  assert.match(ui.get('draft-status').textContent, /до закрытия вкладки/);
});


test('money inputs group digits while preserving numeric calculations and range limits', async t => {
  const ui = await setup(t);
  assert.equal(ui.get('calc-amount').value, '1 500 000');
  ui.set('calc-amount', '10\u00a0000\u00a0000');
  assert.equal(ui.get('calc-amount').value, '10 000 000');
  assert.equal(ui.get('calc-range').value, '10000000');
  assert.equal(ui.get('calculator-apply').disabled, false);
  ui.get('calculator-apply').click();
  assert.equal(ui.get('app-amount').value, '10 000 000');
  await ui.submit('application-form');
  ui.click('[data-action="sample"]');
  assert.equal(ui.get('app-revenue').value, '1 200 000');
  assert.equal(ui.get('app-expenses').value, '700 000');
  assert.equal(ui.get('app-debt').value, '20 000');
  ui.set('app-revenue', '2 500 000');
  await ui.submit('application-form');
  assert.equal(ui.state().draft.revenue, '2500000');
  ui.get('application-dialog').close();
  ui.set('calc-amount', '10 000 001');
  assert.equal(ui.get('calculator-apply').disabled, true);
});

test('formatting an amount keeps the cursor near the edited digit', async t => {
  const ui = await setup(t);
  const input = ui.get('calc-amount');
  input.focus();
  input.value = '12500000';
  input.setSelectionRange(3, 3);
  input.dispatchEvent(new ui.window.Event('input', {bubbles: true}));
  assert.equal(input.value, '12 500 000');
  assert.equal(input.selectionStart, 4);
  ui.set('calc-range', '3500000');
  assert.equal(input.value, '3 500 000');
});
