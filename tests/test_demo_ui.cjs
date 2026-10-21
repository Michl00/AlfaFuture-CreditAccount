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

function mockCredit(url, options) {
  const data = options?.body && typeof options.body === 'string' ? JSON.parse(options.body) : {};
  if (url === '/credit/recommendations') return new Response(JSON.stringify({recommendation_token: 'signed-recommendation-fixture', offers: credit.products.map((product, index) => {
    const amount = Math.min(data.requestedAmount, product.max);
    const months = Math.min(data.requestedMonths, product.months);
    return {id: product.id, product: product.id, name: product.name, reason: 'Вариант под цель', amount, months, rate: product.rate, payment: credit.payment(amount, months, product.rate), recommended: index === 0, high_chance: index === 1};
  })}));
  if (url === '/credit/assessments') {
    if (data.age < 6 && data.clarification.length < 20) return new Response(JSON.stringify({status: 'needs_info', risk: 'medium', reasons: ['Уточните доходы бизнеса'], assessment_token: null}));
    const adjusted = data.expenses >= 1000000;
    const terms = {amount: adjusted ? Math.min(data.amount, 1200000) : data.amount, months: adjusted ? 36 : 24, rate: adjusted ? 27.9 : 24.9};
    terms.payment = credit.payment(terms.amount, terms.months, terms.rate);
    return new Response(JSON.stringify({status: 'ready', risk: adjusted ? 'high' : 'low', reasons: [adjusted ? 'Сумма уменьшена для посильного платежа' : 'Корректировки не нужны'], terms, assessment_token: 'signed-assessment-fixture'}));
  }
  if (url === '/credit/confirm') return new Response(JSON.stringify({id: 'server-confirmation-fixture', status: 'bank_review', createdAt: Date.now(), product: 'working', goal: 'Пополнение оборотных средств'}));
  return undefined;
}

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
    if (String(args[0]).startsWith('/credit/')) {
      const override = options.creditFetch ? await options.creditFetch(...args) : undefined;
      if (override) return override;
      return mockCredit(...args);
    }
    return options.fetch ? options.fetch(...args) : options.guest ? new Response('{}', {status: 401}) : new Response(JSON.stringify({id: 1, username: 'Тест', email: 'test@example.com'}));
  };
  window.eval(domain);
  window.eval(script);
  if (options.bank) window.eval(fs.readFileSync(path.join(root, 'static/demo/bank.js'), 'utf8'));
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
  const state = key => JSON.parse(window.localStorage.getItem(key || 'credit-cabinet-v1:1'));
  return {window, calls, clock, get, click, set, submit, advance, finishAssessment, state};
}
async function prepareTerms(ui, overrides = {}) {
  ui.click('[data-action="apply"]');
  if (ui.get('app-goal')) ui.set('app-goal', 'Пополнение оборотных средств');
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

test('income indicator is continuous across category boundaries', () => {
  const before = credit.approvalEstimate({...sample, rate: 24.9, amount: 1000000});
  const after = credit.approvalEstimate({...sample, rate: 24.9, amount: 1000100});
  assert.ok(Math.abs(before.score - after.score) < 0.1);
  const available = (sample.revenue - sample.expenses) * .5 - sample.debt;
  const boundary = available / (1.25 * credit.payment(1, 24, 24.9));
  const left = credit.approvalEstimate({...sample, amount: boundary - 100});
  const right = credit.approvalEstimate({...sample, amount: boundary + 100});
  assert.ok(Math.abs(left.score - right.score) < 0.1);
});

test('dashboard hides developer internals and calculator opens the needs stage', async t => {
  const ui = await setup(t);
  assert.doesNotMatch(ui.window.document.body.textContent, /REST|JSON|HTTP|Swagger|Ответ сервера/i);
  ui.set('calc-amount', 2000000);
  ui.get('calc-term').value = '60';
  ui.get('calculator-apply').click();
  assert.equal(ui.get('app-requestedAmount').value, '2 000 000');
  assert.equal(ui.get('app-requestedMonths').value, '60');
  assert.equal(ui.get('app-goal').value, '');
});

test('a user must explicitly select an offer before entering company details', async t => {
  const ui = await setup(t);
  ui.click('[data-action="apply"]');
  if (ui.get('app-goal')) ui.set('app-goal', 'Пополнение оборотных средств');
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
  const restored = await setup(t, {storage: {'credit-cabinet-v1:1': JSON.stringify(ui.state())}});
  restored.click('[data-page="profile"]');
  assert.match(restored.get('profile-applications').textContent, /Ожидает подтверждения банка/);
  assert.equal(restored.calls.filter(([, options]) => options?.method === 'POST').length, 0);
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

test('extremely low chances block advancement and provide an edit button', async t => {
  const ui = await setup(t);
  ui.click('[data-action="apply"]');
  ui.set('app-goal', 'Закупка товаров');
  await ui.submit('application-form');
  ui.click('[data-offer="working"]');
  await ui.submit('application-form');
  ui.click('[data-action="sample"]');
  ui.set('app-expenses', 1200000);
  assert.equal(ui.get('wizard-next').disabled, true);
  assert.match(ui.get('approval-indicator').textContent, /Слишком низкие шансы/);
  assert.ok(ui.get('approval-indicator').querySelector('[data-action="adjust-amount"]'));
  await ui.submit('application-form');
  assert.equal(ui.calls.filter(([path]) => path === '/credit/assessments').length, 0);
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
  const restored = await setup(t, {storage: {'credit-cabinet-v1:1': JSON.stringify(ui.state())}});
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
  assert.equal(ui.get('wizard-next').disabled, true);
  assert.equal(ui.state().applications.length, 0);
});

test('draft amount survives closing and reload and can be deleted', async t => {
  const ui = await setup(t);
  ui.click('[data-action="apply"]');
  if (ui.get('app-goal')) ui.set('app-goal', 'Пополнение оборотных средств');
  ui.set('app-requestedAmount', 2100000);
  ui.click('[data-close="application-dialog"]');
  const restored = await setup(t, {storage: {'credit-cabinet-v1:1': JSON.stringify(ui.state())}});
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
  assert.equal(ui.calls.filter(([, options]) => options?.method === 'POST').length, 0);
});

test('login uses form encoding, restores user workspace and never stores credentials', async t => {
  let loggedIn = false;
  const ui = await setup(t, {fetch: async (url, options) => {
    if (url === '/auth/login') {loggedIn = true; return new Response(null, {status: 204});}
    return loggedIn ? new Response(JSON.stringify({id: 3, username: 'Мария', email: 'demo@example.com'})) : new Response('{}', {status: 401});
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
  if (ui.get('app-goal')) ui.set('app-goal', 'Пополнение оборотных средств');
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
  if (ui.get('app-goal')) ui.set('app-goal', 'Пополнение оборотных средств');
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
  ui.set('app-goal', 'Закупка товаров');
  await ui.submit('application-form');
  ui.click('[data-offer="working"]');
  await ui.submit('application-form');
  ui.click('[data-action="sample"]');
  assert.equal(ui.get('app-revenue').value, '1 200 000');
  ui.set('app-revenue', '2 500 000');
  await ui.submit('application-form');
  assert.equal(ui.state().draft.revenue, '2500000');
});


test('registration is the first required step and guests cannot create drafts', async t => {
  const ui = await setup(t, {guest: true});
  ui.click('[data-action="apply"]');
  assert.match(ui.get('wizard-fields').textContent, /Сначала создайте аккаунт/);
  assert.equal(ui.get('app-goal'), null);
  assert.equal(ui.get('wizard-next').hidden, true);
  await ui.submit('application-form');
  assert.equal(ui.window.localStorage.length, 0);
  assert.equal(ui.get('app-requestedAmount'), null);
});

test('successful registration logs in and resumes the application with no guest workspace', async t => {
  let loggedIn = false;
  const ui = await setup(t, {fetch: async url => {
    if (url === '/auth/register') return new Response('{}', {status: 201});
    if (url === '/auth/login') {loggedIn = true; return new Response(null, {status: 204});}
    return loggedIn ? new Response(JSON.stringify({id: 8, username: 'Новый', email: 'new@example.com'})) : new Response('{}', {status: 401});
  }});
  ui.click('[data-action="apply"]');
  ui.click('#application-dialog [data-action="register"]');
  for (const [name, value] of Object.entries({email: 'new@example.com', password: 'secret-password', username: 'Новый', inn: '7701234560'})) ui.set(`account-${name}`, value);
  await ui.submit('account-form');
  assert.equal(ui.get('account-dialog').open, false);
  assert.equal(ui.get('application-dialog').open, true);
  assert.ok(ui.get('app-goal'));
  assert.equal(ui.window.localStorage.getItem('credit-cabinet-v1:guest'), null);
  assert.ok(ui.window.localStorage.getItem('credit-cabinet-v1:8'));
});

test('expired server session prevents final submission and asks for an account', async t => {
  let expired = false;
  const ui = await setup(t, {creditFetch: async path => path === '/credit/confirm' && expired ? new Response('{}', {status: 401}) : undefined, fetch: async () => expired ? new Response('{}', {status: 401}) : new Response(JSON.stringify({id: 1, username: 'Тест', email: 'test@example.com'}))});
  await prepareTerms(ui);
  ui.window.document.querySelector('[name="consent"]').checked = true;
  expired = true;
  await ui.submit('application-form');
  assert.equal(ui.state().applications.length, 0);
  assert.equal(ui.window.localStorage.getItem('credit-cabinet-v1:guest'), null);
  assert.match(ui.get('wizard-fields').textContent, /Сначала создайте аккаунт/);
});

test('free-form purposes and suggestions preserve arbitrary user wording', async t => {
  const ui = await setup(t);
  ui.click('[data-action="apply"]');
  assert.equal(ui.get('app-goal').tagName, 'INPUT');
  assert.ok(ui.window.document.querySelectorAll('[data-goal]').length >= 4);
  ui.click('[data-goal="Покупка оборудования"]');
  assert.equal(ui.get('app-goal').value, 'Покупка оборудования');
  ui.set('app-goal', 'Запуск мастерской керамики и обучение команды');
  await ui.submit('application-form');
  assert.equal(ui.state().draft.goal, 'Запуск мастерской керамики и обучение команды');
  assert.equal(ui.get('wizard-fields').querySelectorAll('[data-offer]').length, 3);
});

test('low approval estimate offers a slider, recalculates live and applies only on confirmation', async t => {
  const ui = await setup(t);
  ui.click('[data-action="apply"]');
  ui.set('app-goal', 'Закупка товаров');
  await ui.submit('application-form');
  ui.click('[data-offer="working"]');
  await ui.submit('application-form');
  assert.match(ui.get('approval-indicator').textContent, /Добавьте доходы/);
  ui.click('[data-action="sample"]');
  ui.set('app-expenses', 1000000);
  ui.set('app-debt', 50000);
  assert.match(ui.get('approval-indicator').textContent, /Низкая/);
  ui.click('[data-action="adjust-amount"]');
  assert.equal(ui.get('amount-dialog').open, true);
  ui.set('adjust-amount', 500000);
  assert.match(ui.get('adjust-estimate').textContent, /Высокая/);
  assert.equal(ui.state().draft.amount, 1500000);
  await ui.submit('amount-adjust-form');
  assert.equal(ui.get('amount-dialog').open, false);
  assert.equal(ui.state().draft.amount, 500000);
  assert.match(ui.get('approval-indicator').textContent, /Высокая/);
  assert.equal(ui.get('app-expenses').value, '1 000 000');
  assert.equal(ui.get('wizard-fields').querySelector('[data-action="adjust-amount"]'), null);
});

test('approval estimate remains qualitative and handles incomplete or unaffordable income', () => {
  assert.equal(credit.approvalEstimate({...sample, revenue: ''}).level, 'unknown');
  assert.equal(credit.approvalEstimate({...sample, expenses: 1200000}).level, 'critical');
  assert.equal(credit.approvalEstimate(sample).level, 'high');
});


test('provider failure never falls back to local generated offers', async t => {
  const ui = await setup(t, {creditFetch: async () => new Response(JSON.stringify({detail: 'CREDIT_AI_NOT_CONFIGURED'}), {status: 503})});
  ui.click('[data-action="apply"]');
  ui.set('app-goal', 'Новая мастерская');
  await ui.submit('application-form');
  assert.equal(ui.get('wizard-fields').querySelectorAll('[data-offer]').length, 0);
  assert.match(ui.get('application-error').textContent, /не настроен/);
  assert.equal(ui.state().applications.length, 0);
});

test('conservative AI offers display the high-chance badge', async t => {
  const ui = await setup(t);
  ui.click('[data-action="apply"]');
  ui.set('app-goal', 'Новая мастерская');
  await ui.submit('application-form');
  assert.match(ui.get('wizard-fields').querySelector('.high-chance').textContent, /Высокий шанс одобрения/);
});

test('model risk rejection prevents consent even when local income indicator is high', async t => {
  const ui = await setup(t, {creditFetch: async path => path === '/credit/assessments' ? new Response(JSON.stringify({status: 'blocked', risk: 'critical', reasons: ['Слишком низкие шансы'], terms: null, assessment_token: null})) : undefined});
  await prepareTerms(ui);
  assert.match(ui.get('wizard-fields').textContent, /Слишком низкие шансы/);
  assert.equal(ui.get('wizard-fields').querySelector('[name="consent"]'), null);
  await ui.submit('application-form');
  assert.ok(ui.get('app-company'));
  assert.equal(ui.state().applications.length, 0);
});

test('document upload previews fields and only applies selected values', async t => {
  const ui = await setup(t, {creditFetch: async path => path === '/credit/documents' ? new Response(JSON.stringify({id: 'doc-fixture', filename: 'company.json', warnings: [], fields: {company: 'Из документа', revenue: 1250000, debt: 40000}}), {status: 201}) : undefined});
  ui.click('[data-action="apply"]');
  ui.set('app-goal', 'Закупка оборудования');
  await ui.submit('application-form');
  ui.click('[data-offer="working"]');
  await ui.submit('application-form');
  ui.set('app-company', 'Введено вручную');
  const input = ui.get('company-document');
  Object.defineProperty(input, 'files', {value: [new ui.window.File(['{}'], 'company.json', {type: 'application/json'})]});
  input.dispatchEvent(new ui.window.Event('change', {bubbles: true}));
  await tick(); await tick();
  assert.equal(ui.get('document-preview-dialog').open, true);
  assert.equal(ui.get('app-company').value, 'Введено вручную');
  assert.equal(ui.get('document-preview-fields').querySelector('[name="company"]').checked, false);
  assert.equal(ui.get('document-preview-fields').querySelector('[name="revenue"]').checked, true);
  await ui.submit('document-apply-form');
  assert.equal(ui.get('app-company').value, 'Введено вручную');
  assert.equal(ui.get('app-revenue').value, '1 250 000');
  assert.equal(ui.state().draft.document_ids[0], 'doc-fixture');
});

test('bank cabinet shows scoring and sends an explicit versioned decision', async t => {
  const check = {source: 'БКИ', mock: true, status: 'warning', summary: 'Просрочка (мок)', data: {overdue_days: 45}};
  let item = {...sample, id: 'application-fixture', status: 'bank_review', version: 1, assigned_to: null, goal: 'Закупка', rate: 24.9, createdAt: Date.now(), updatedAt: Date.now(), applicant: {username: 'Клиент', email: 'client@example.com'}, documents: [], events: [], ai_reasons: ['Платёж посилен'], checks: {registry: check, bki: check, transparent: check, documents: check}, score: {value: 800, risk: 'medium', parts: {financial: 400}, manual_review: true, manual_reasons: ['Просрочка'], method: 'Моки'}};
  const ui = await setup(t, {bank: true, fetch: async (url, options) => {
    if (url === '/bank/me') return new Response(JSON.stringify({id: 1, username: 'Сотрудник'}));
    if (url.startsWith('/bank/applications?')) return new Response(JSON.stringify({items: [item], has_more: false}));
    if (url.endsWith('/actions')) {
      const action = JSON.parse(options.body);
      assert.equal(action.version, item.version);
      item = {...item, version: item.version + 1, assigned_to: 1, status: action.action === 'claim' ? 'in_review' : 'approved'};
      return new Response(JSON.stringify(item));
    }
    if (url === '/bank/applications/application-fixture') return new Response(JSON.stringify(item));
    return new Response(JSON.stringify({id: 1, username: 'Сотрудник', email: 'staff@example.com'}));
  }});
  await tick();
  assert.equal(ui.get('bank-menu').hidden, false);
  ui.click('[data-page="bank"]'); await tick();
  assert.match(ui.get('bank-queue').textContent, /Нестандартная/);
  ui.click('[data-bank-id="application-fixture"]'); await tick();
  assert.match(ui.get('bank-detail').textContent, /800/);
  assert.match(ui.get('bank-detail').textContent, /Просрочка/);
  ui.click('[data-bank-action="claim"]'); await tick(); await tick();
  ui.set('bank-decision-comment', 'Проверены документы и источники дохода');
  await ui.submit('bank-decision-form'); await tick();
  const actions = ui.calls.filter(([url]) => url.endsWith('/actions')).map(([, options]) => JSON.parse(options.body));
  assert.deepEqual(actions.map(action => action.action), ['claim', 'approve']);
  assert.equal(actions[1].version, 2);
  assert.match(ui.get('bank-detail').textContent, /Решение зафиксировано/);
});

test('bank menu stays hidden for an ordinary client', async t => {
  const ui = await setup(t, {bank: true, fetch: async url => url === '/bank/me' ? new Response('{}', {status: 403}) : new Response(JSON.stringify({id: 1, username: 'Клиент'}))});
  await tick();
  assert.equal(ui.get('bank-menu').hidden, true);
});
