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
  const pendingAssessments = new Map();
  let timerId = 100000;
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  window.setTimeout = (callback, delay, ...args) => {
    if (delay === 800) {const id = timerId++; pendingAssessments.set(id, callback); return id;}
    return realSetTimeout(callback, delay, ...args);
  };
  window.clearTimeout = id => {if (!pendingAssessments.delete(id)) realClearTimeout(id);};
  window.Date.now = () => clock.value;
  window.AbortController = AbortController;
  window.scrollTo = () => {};
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
  const advance = () => {clock.value += 7000;};
  const finishAssessment = async () => {
    for (const [id, callback] of [...pendingAssessments]) {pendingAssessments.delete(id); callback();}
    await tick();
  };
  const state = key => JSON.parse(window.localStorage.getItem(key || 'credit-cabinet-v1:guest'));
  return {window, calls, clock, get, click, set, submit, advance, finishAssessment, state};
}
async function prepareTerms(ui, overrides = {}) {
  ui.click('[data-action="apply"]');
  for (const key of ['requestedAmount', 'requestedMonths']) if (overrides[key] !== undefined) ui.set(`app-${key}`, overrides[key]);
  await ui.submit('application-form');
  ui.click(`[data-offer="${overrides.product || 'working'}"]`);
  await ui.submit('application-form');
  ui.click('[data-action="sample"]');
  for (const [key, value] of Object.entries(overrides)) if (ui.get(`app-${key}`)) ui.set(`app-${key}`, value);
  await ui.submit('application-form');
  await ui.finishAssessment();
}
async function fillApplication(ui, overrides = {}) {
  await prepareTerms(ui, overrides);
  ui.window.document.querySelector('[name="consent"]').checked = true;
  await ui.submit('application-form');
}

test('payment, INN validation, and request constraints handle expected cases', () => {
  assert.equal(credit.payment(120000, 12, 0), 10000);
  assert.ok(credit.validInn('7701234560'));
  assert.ok(!credit.validInn('7701234561'));
  assert.equal(credit.validate(sample), null);
  assert.match(credit.validateRequest({goal: 'working', requestedAmount: 99999, requestedMonths: 24}), /сумму/);
});

test('recommendations rank the goal first and respect each product limits', () => {
  const offers = credit.advisor.recommend({goal: 'equipment', requestedAmount: 10000000, requestedMonths: 60});
  assert.equal(offers[0].product, 'equipment');
  assert.equal(offers[0].recommended, true);
  const flex = offers.find(offer => offer.product === 'flex');
  assert.equal(flex.amount, 3000000);
  assert.equal(flex.months, 24);
  assert.equal(flex.limited, true);
});

test('risk assessment adjusts terms, requests information, or finds no affordable terms', () => {
  const ready = credit.advisor.assess(sample);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.terms.amount, sample.amount);
  const adjusted = credit.advisor.assess({...sample, expenses: 1000000, debt: 50000});
  assert.equal(adjusted.status, 'ready');
  assert.ok(adjusted.terms.amount < sample.amount);
  assert.ok(adjusted.terms.months > sample.months);
  assert.ok(adjusted.terms.rate > 24.9);
  assert.ok(adjusted.terms.payment <= 50000);
  assert.equal(credit.advisor.assess({...sample, expenses: 1200000}).status, 'unavailable');
  assert.equal(credit.advisor.assess({...sample, age: 2}).status, 'needs_info');
});

test('dashboard hides developer internals and calculator opens the needs stage', async t => {
  const ui = await setup(t);
  assert.doesNotMatch(ui.window.document.body.textContent, /REST|JSON|HTTP|Swagger|Ответ сервера/i);
  ui.set('calc-amount', 2000000);
  ui.get('calc-term').value = '60';
  ui.get('calculator-apply').click();
  assert.equal(ui.get('app-requestedAmount').value, '2 000 000');
  assert.equal(ui.get('app-requestedMonths').value, '60');
  assert.equal(ui.get('app-goal').value, 'equipment');
});

test('a user must explicitly select an offer before entering company details', async t => {
  const ui = await setup(t);
  ui.click('[data-action="apply"]');
  await ui.submit('application-form');
  assert.equal(ui.get('wizard-fields').querySelectorAll('[data-offer]').length, 3);
  assert.equal(ui.get('app-company'), null);
  await ui.submit('application-form');
  assert.match(ui.get('application-error').textContent, /Выберите/);
  ui.click('[data-offer="working"]');
  await ui.submit('application-form');
  assert.ok(ui.get('app-company'));
});

test('assessment and corrections precede consent and submission to the bank', async t => {
  const ui = await setup(t);
  await prepareTerms(ui, {expenses: 1000000, debt: 50000});
  assert.equal(ui.state().applications.length, 0);
  assert.equal(ui.state().draft.assessment.status, 'ready');
  assert.ok(ui.get('wizard-fields').querySelector('.terms-comparison'));
  assert.match(ui.get('wizard-fields').textContent, /Сумма уменьшена/);
  await ui.submit('application-form'); // Unchecked consent must never send.
  assert.equal(ui.state().applications.length, 0);
  ui.window.document.querySelector('[name="consent"]').checked = true;
  const agreed = ui.state().draft.assessment.terms;
  await ui.submit('application-form');
  const item = ui.state().applications[0];
  assert.equal(item.status, 'bank_review');
  assert.equal(item.amount, agreed.amount);
  assert.equal(item.months, agreed.months);
  assert.equal(item.rate, agreed.rate);
  assert.equal(ui.get('profile-page').hidden, false);
  assert.match(ui.get('profile-applications').textContent, /Ожидает подтверждения банка/);
  ui.advance();
  assert.equal(ui.state().applications[0].status, 'bank_review');
  const restored = await setup(t, {storage: {'credit-cabinet-v1:guest': JSON.stringify(ui.state())}});
  restored.click('[data-page="profile"]');
  assert.match(restored.get('profile-applications').textContent, /Ожидает подтверждения банка/);
  assert.equal(restored.calls.length, 1); // No CometAPI or real bank calls.
});

test('clarification must be reassessed and separately consented before sending', async t => {
  const ui = await setup(t);
  await prepareTerms(ui, {age: 2});
  assert.equal(ui.state().draft.assessment.status, 'needs_info');
  ui.set('app-clarification', 'Заключены договоры на регулярные поставки товаров.');
  await ui.submit('application-form');
  assert.equal(ui.state().applications.length, 0);
  await ui.finishAssessment();
  assert.equal(ui.window.document.querySelector('[name="consent"]').checked, false);
  assert.equal(ui.state().draft.assessment.status, 'ready');
});

test('unaffordable conditions never produce a bank application', async t => {
  const ui = await setup(t);
  await prepareTerms(ui, {expenses: 1200000});
  assert.equal(ui.state().draft.assessment.status, 'unavailable');
  assert.equal(ui.window.document.querySelector('[name="consent"]'), null);
  await ui.submit('application-form');
  assert.ok(ui.get('app-requestedAmount'));
  assert.equal(ui.state().applications.length, 0);
});

test('invalid INN prevents assessment and submission', async t => {
  const ui = await setup(t);
  await prepareTerms(ui, {inn: '7701234561'});
  assert.match(ui.get('application-error').textContent, /ИНН/);
  assert.equal(ui.state().applications.length, 0);
  assert.ok(ui.get('app-company'));
});

test('reopening a saved assessment never restores consent', async t => {
  const ui = await setup(t);
  await prepareTerms(ui);
  ui.window.document.querySelector('[name="consent"]').checked = true;
  ui.click('[data-close="application-dialog"]');
  const restored = await setup(t, {storage: {'credit-cabinet-v1:guest': JSON.stringify(ui.state())}});
  restored.click('[data-action="apply"]');
  assert.equal(restored.window.document.querySelector('[name="consent"]').checked, false);
  assert.equal(restored.state().applications.length, 0);
});

test('changing company data after assessment requires a fresh evaluation', async t => {
  const ui = await setup(t);
  await prepareTerms(ui);
  ui.get('wizard-back').click();
  ui.set('app-expenses', 1200000);
  await ui.submit('application-form');
  await ui.finishAssessment();
  assert.equal(ui.state().draft.assessment.status, 'unavailable');
  assert.equal(ui.state().applications.length, 0);
});

test('draft amount survives closing and reload and can be deleted', async t => {
  const ui = await setup(t);
  ui.click('[data-action="apply"]');
  ui.set('app-requestedAmount', 2100000);
  ui.click('[data-close="application-dialog"]');
  const restored = await setup(t, {storage: {'credit-cabinet-v1:guest': JSON.stringify(ui.state())}});
  restored.click('[data-action="apply"]');
  assert.equal(restored.get('app-requestedAmount').value, '2 100 000');
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

test('company names are rendered as text in profile and application details', async t => {
  const ui = await setup(t);
  await fillApplication(ui, {company: '<img src=x onerror="window.injected=true">'});
  ui.click('#profile-applications [data-detail]');
  assert.equal(ui.get('profile-content').querySelector('img'), null);
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

test('monetary fields preserve grouping and numeric values across the new stages', async t => {
  const ui = await setup(t);
  ui.set('calc-amount', '10\u00a0000\u00a0000');
  assert.equal(ui.get('calc-amount').value, '10 000 000');
  assert.equal(ui.get('calc-range').value, '10000000');
  ui.get('calculator-apply').click();
  assert.equal(ui.get('app-requestedAmount').value, '10 000 000');
  await ui.submit('application-form');
  ui.click('[data-offer="working"]');
  await ui.submit('application-form');
  ui.click('[data-action="sample"]');
  assert.equal(ui.get('app-revenue').value, '1 200 000');
  ui.set('app-revenue', '2 500 000');
  await ui.submit('application-form');
  assert.equal(ui.state().draft.revenue, '2500000');
});
