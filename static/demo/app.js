'use strict';

const {products, payment, validInn, validate, decide} = window.CreditFlow;
const $ = id => document.getElementById(id);
const money = amount => new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 0}).format(amount) + ' ₽';
const moneyFields = new Set(['amount', 'revenue', 'expenses', 'debt']);
const ungroup = value => String(value).replace(/\s/g, '');
const groupDigits = value => ungroup(value).replace(/\D/g, '').replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
function formatMoneyInput(input) {
  const caret = input.selectionStart;
  const digitsBefore = caret === null ? null : input.value.slice(0, caret).replace(/\D/g, '').length;
  input.value = groupDigits(input.value);
  if (digitsBefore !== null && document.activeElement === input) {
    let position = 0;
    let count = 0;
    while (position < input.value.length && count < digitsBefore) {
      if (/\d/.test(input.value[position])) count += 1;
      position += 1;
    }
    input.setSelectionRange(position, position);
  }
  const amount = Number(ungroup(input.value));
  const invalid = input.value && (amount < Number(input.dataset.min) || amount > Number(input.dataset.max));
  input.setCustomValidity(invalid ? `Укажите сумму от ${money(Number(input.dataset.min))} до ${money(Number(input.dataset.max))}.` : '');
}
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const statusNames = {draft: 'Черновик', review: 'На рассмотрении', needs_info: 'Нужны уточнения', approved: 'Одобрено', alternative: 'Есть предложение', declined: 'Не одобрено', accepted: 'Условия приняты'};
const finished = ['declined', 'accepted'];
let user = null;
let currentPage = 'home';
let filter = 'all';
let draft = null;
let applications = [];
let wizardStep = 0;
let accountMode = 'login';
let accountBusy = false;
let detailId = null;
let toastTimer;
let saveTimer;
let storageAvailable = true;
let resolvingSession = true;

function notify(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {$('toast').hidden = true;}, 5000);
}
function showDialog(id) { if (!$(id).open) $(id).showModal(); }
function closeDialog(id) { $(id).close(); }
function storageKey() { return `credit-cabinet-v1:${user ? user.id : 'guest'}`; }
function persist() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify({draft, applications}));
    storageAvailable = true;
  } catch {
    storageAvailable = false;
    notify('Не удалось сохранить изменения на устройстве. Не закрывайте вкладку, чтобы продолжить.');
  }
  $('draft-status').textContent = storageAvailable ? 'Черновик сохранён на этом устройстве' : 'Изменения доступны до закрытия вкладки';
}
function loadWorkspace() {
  draft = null;
  applications = [];
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey()) || '{}');
    if (saved.draft && !validate(saved.draft)) draft = saved.draft;
    // Partial drafts are useful too; validate the schema before using saved values.
    else if (saved.draft && typeof saved.draft === 'object' && products.some(p => p.id === saved.draft.product)) draft = {...emptyDraft(), ...saved.draft};
    if (Array.isArray(saved.applications)) applications = saved.applications.filter(item => item && typeof item.id === 'string' && !validate(item) && statusNames[item.status] && item.status !== 'draft' && Number.isFinite(item.createdAt) && Number.isFinite(item.decisionAt)).slice(0, 100);
  } catch { notify('Не удалось восстановить сохранённые заявки. Можно начать новую.'); }
  updateDecisions();
  renderAll();
}
function emptyDraft() {
  return {product: 'working', amount: 1500000, months: 24, company: '', inn: '', revenue: '', expenses: '', debt: 0, age: '', clarification: ''};
}
function navigate(page) {
  currentPage = page;
  for (const section of document.querySelectorAll('.page')) section.hidden = section.id !== `${page}-page`;
  for (const button of document.querySelectorAll('.nav-item')) {
    button.classList.toggle('active', button.dataset.page === page);
    if (button.dataset.page === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (page === 'profile') renderProfile();
  $('main').focus({preventScroll: true});
  window.scrollTo({top: 0, behavior: 'instant'});
}
function renderProducts() {
  const html = products.map(product => `<article class="card product-card"><div class="product-top"><span>${product.tag}</span><span class="product-icon" aria-hidden="true">${product.icon}</span></div><h3>${product.name}</h3><p>${product.description}</p><div class="product-facts"><div><strong>до ${product.max / 1000000} млн ₽</strong><span>сумма кредита</span></div><div><strong>${String(product.rate).replace('.', ',')}%</strong><span>пример ставки</span></div></div><button class="button secondary full" data-product="${product.id}">Выбрать <span>→</span></button></article>`).join('');
  $('home-products').innerHTML = html;
  $('all-products').innerHTML = html;
}
function updateCalculator(source) {
  if (source === 'calc-range') $('calc-amount').value = $('calc-range').value;
  formatMoneyInput($('calc-amount'));
  const amount = Number(ungroup($('calc-amount').value));
  if (Number.isFinite(amount)) $('calc-range').value = amount;
  const valid = amount >= 100000 && amount <= 10000000;
  $('calc-payment').textContent = valid ? money(payment(amount, Number($('calc-term').value), 24.9)) : 'Уточните сумму';
  $('calculator-apply').disabled = !valid;
}
function emptyApplications() {
  return '<div class="empty-card"><span class="empty-icon" aria-hidden="true">▤</span><div><h3>Здесь начнётся новая история бизнеса</h3><p>Оформите первую заявку — её статус и решение появятся здесь.</p></div><button class="button secondary" data-action="apply">Создать заявку <span>+</span></button></div>';
}
function applicationCard(item) {
  const product = products.find(p => p.id === item.product);
  return `<article class="card application-card"><div class="application-main"><span class="application-reference">№ ${escapeHTML(item.id)} · ${new Date(item.createdAt).toLocaleDateString('ru-RU')}</span><h3>${product.short}</h3><p>${escapeHTML(item.company)}</p></div><div class="application-amount">${money(Number(item.amount))}<small>на ${item.months} мес.</small></div><span class="status ${item.status}">${statusNames[item.status]}</span><button class="button secondary" data-detail="${escapeHTML(item.id)}">Подробнее <span>→</span></button></article>`;
}
function renderApplications() {
  const total = applications.length + (draft ? 1 : 0);
  $('application-count').textContent = total;
  $('home-application-count').textContent = total;
  let draftHTML = '';
  if (draft) draftHTML = `<article class="card application-card"><div class="application-main"><span class="application-reference">ВЫ МОЖЕТЕ ПРОДОЛЖИТЬ</span><h3>Незавершённая заявка</h3><p>Черновик доступен на этом устройстве</p></div><span class="status">Черновик</span><button class="button secondary" data-action="apply">Продолжить <span>→</span></button><button class="text-button" data-action="delete-draft">Удалить черновик</button></article>`;
  $('home-applications').innerHTML = draftHTML + applications.slice(0, 2).map(applicationCard).join('') || emptyApplications();
  const visible = applications.filter(item => filter === 'all' || (filter === 'completed' ? finished.includes(item.status) : !finished.includes(item.status)));
  const content = (filter !== 'completed' ? draftHTML : '') + visible.map(applicationCard).join('');
  $('applications-list').innerHTML = content || (filter === 'all' ? emptyApplications() : '<div class="empty-card"><div><h3>Таких заявок пока нет</h3><p>Выберите другой фильтр или создайте новую заявку.</p></div></div>');
}
function renderAll() {
  $('company-heading').textContent = user ? user.username : 'Демо-компания';
  $('account-name').textContent = user ? user.username : 'Войти';
  $('avatar').textContent = user ? user.username.slice(0, 2).toUpperCase() : '→';
  renderApplications();
  if (currentPage === 'profile') renderProfile();
}
function beginApplication(productId, fromCalculator = false) {
  if (resolvingSession) { notify('Подождите, проверяем вход в кабинет.'); return; }
  if (!draft) draft = emptyDraft();
  if (productId) {
    const product = products.find(p => p.id === productId);
    draft.product = product.id;
    draft.amount = Math.min(Number(draft.amount) || 1500000, product.max);
    draft.months = Math.min(Number(draft.months) || 24, product.months);
  }
  if (fromCalculator) {
    draft.product = Number($('calc-term').value) > 36 ? 'equipment' : 'working';
    draft.amount = Number(ungroup($('calc-amount').value));
    draft.months = Number($('calc-term').value);
  }
  wizardStep = 0;
  persist();
  renderWizard();
  renderApplications();
  showDialog('application-dialog');
}
function field(name, label, options = {}) {
  const monetary = moneyFields.has(name);
  const value = escapeHTML(monetary ? groupDigits(draft[name] ?? '') : draft[name] ?? '');
  const constraints = monetary ? `inputmode="numeric" data-money data-min="${options.min}" data-max="${options.max}"` : `${options.min !== undefined ? `min="${options.min}"` : ''} ${options.max !== undefined ? `max="${options.max}"` : ''} ${options.step ? `step="${options.step}"` : ''}`;
  return `<div class="field"><label for="app-${name}">${label}</label><input id="app-${name}" name="${name}" value="${value}" type="${monetary ? 'text' : options.type || 'text'}" ${constraints} ${options.maxLength ? `maxlength="${options.maxLength}"` : ''} required>${options.hint ? `<p class="field-hint">${options.hint}</p>` : ''}</div>`;
}
function draftPayment() {
  const product = products.find(p => p.id === draft.product);
  const monthly = payment(Number(draft.amount), Number(draft.months), product.rate);
  return Number.isFinite(monthly) && monthly > 0 ? money(monthly) : '—';
}
function reviewData(item, amount = Number(item.amount)) {
  const product = products.find(p => p.id === item.product);
  return `<div class="review-data"><div><span>Цель финансирования</span><strong>${product.short}</strong></div><div><span>Компания</span><strong>${escapeHTML(item.company)}</strong></div><div><span>Сумма</span><strong>${money(amount)}</strong></div><div><span>Срок</span><strong>${item.months} мес.</strong></div><div><span>Ставка в демо-сценарии</span><strong>${String(product.rate).replace('.', ',')}% годовых</strong></div><div><span>Ежемесячный платёж</span><strong>${money(payment(amount, Number(item.months), product.rate))}</strong></div></div>`;
}
function renderWizard() {
  $('application-error').hidden = true;
  $('wizard-progress').innerHTML = ['1. Ваши планы', '2. О бизнесе', '3. Проверка'].map((label, index) => `<span class="${index <= wizardStep ? 'active' : ''}" ${index === wizardStep ? 'aria-current="step"' : ''}>${label}</span>`).join('');
  $('wizard-back').hidden = wizardStep === 0;
  $('wizard-next').innerHTML = wizardStep === 2 ? 'Отправить заявку <span>→</span>' : 'Продолжить <span>→</span>';
  const product = products.find(p => p.id === draft.product);
  if (wizardStep === 0) {
    $('wizard-fields').innerHTML = `<div class="field"><label for="app-product">Для чего нужны деньги?</label><select id="app-product" name="product">${products.map(p => `<option value="${p.id}" ${p.id === draft.product ? 'selected' : ''}>${p.name}</option>`).join('')}</select></div><div class="form-grid">${field('amount', 'Сумма, ₽', {type: 'number', min: 100000, max: product.max, step: 10000})}${field('months', 'Срок, месяцев', {type: 'number', min: 6, max: product.months, step: 1})}</div><div class="wizard-summary"><span>Примерный платёж в месяц</span><strong id="wizard-payment">${draftPayment()}</strong></div><p class="small-note">Расчёт предварительный. Условия используются только в учебном прототипе.</p>`;
  } else if (wizardStep === 1) {
    $('wizard-fields').innerHTML = `<div class="section-heading"><p class="muted">Несколько деталей, чтобы подобрать посильные условия.</p><button type="button" class="text-button" data-action="sample">Заполнить примером →</button></div><div class="form-grid">${field('company', 'Название компании или ИП', {maxLength: 120})}${field('inn', 'ИНН', {maxLength: 12, hint: '10 или 12 цифр'})}${field('revenue', 'Среднемесячная выручка, ₽', {type: 'number', min: 1, max: 1000000000})}${field('expenses', 'Среднемесячные расходы, ₽', {type: 'number', min: 0, max: 1000000000})}${field('debt', 'Платежи по действующим кредитам, ₽/мес.', {type: 'number', min: 0, max: 1000000000})}${field('age', 'Сколько месяцев работает бизнес?', {type: 'number', min: 0, max: 1200, step: 1})}</div><p class="field-hint">Для демонстрации используйте вымышленные данные. Проверки по реестрам не выполняются.</p>`;
  } else {
    $('wizard-fields').innerHTML = `${reviewData(draft)}<label class="checkbox-label"><input name="consent" type="checkbox" required><span>Данные проверены. Я понимаю, что отправляю демонстрационную заявку, которая сохранится только в этом браузере.</span></label>`;
  }
  $('draft-status').textContent = storageAvailable ? 'Черновик сохранён на этом устройстве' : 'Изменения доступны до закрытия вкладки';
}
function captureDraft() {
  if (!draft) return;
  for (const [key, value] of new FormData($('application-form'))) if (key !== 'consent') draft[key] = moneyFields.has(key) ? ungroup(value) : value;
}
$('application-form').addEventListener('input', event => {
  if (event.target.hasAttribute('data-money')) formatMoneyInput(event.target);
  captureDraft();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 250);
  if (wizardStep === 0) {
    if (event.target.name === 'product') {
      const product = products.find(p => p.id === draft.product);
      $('app-amount').dataset.max = product.max;
      formatMoneyInput($('app-amount'));
      $('app-months').max = product.months;
    }
    $('wizard-payment').textContent = draftPayment();
  }
});
$('application-form').addEventListener('submit', event => {
  event.preventDefault();
  captureDraft();
  let error = null;
  if (wizardStep === 0) {
    const product = products.find(p => p.id === draft.product);
    if (Number(draft.amount) < 100000 || Number(draft.amount) > product.max || Number(draft.months) < 6 || Number(draft.months) > product.months || !Number.isInteger(Number(draft.months))) error = 'Проверьте сумму и срок для выбранной цели.';
  } else error = validate(draft);
  if (error) {
    $('application-error').textContent = error;
    $('application-error').hidden = false;
    return;
  }
  if (wizardStep < 2) {
    wizardStep += 1;
    persist();
    renderWizard();
    $('wizard-fields').querySelector('input, select')?.focus();
    return;
  }
  if (!new FormData($('application-form')).get('consent')) return;
  clearTimeout(saveTimer);
  const createdAt = Date.now();
  const item = {...draft, id: `${createdAt.toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`, status: 'review', createdAt, decisionAt: createdAt + 6000};
  applications.unshift(item);
  applications.splice(100);
  draft = null;
  persist();
  closeDialog('application-dialog');
  navigate('applications');
  renderApplications();
  openDetail(item.id);
  notify('Заявка принята. Решение скоро появится в кабинете.');
});
$('wizard-back').addEventListener('click', () => {captureDraft(); persist(); wizardStep = Math.max(0, wizardStep - 1); renderWizard();});

function updateDecisions() {
  let changed = false;
  for (const item of applications) {
    if (item.status === 'review' && Date.now() >= item.decisionAt) {
      Object.assign(item, decide(item));
      changed = true;
    }
  }
  if (changed) {
    persist();
    renderApplications();
    if ($('detail-dialog').open) renderDetail();
  }
}
function openDetail(id) { detailId = id; renderDetail(); showDialog('detail-dialog'); }
function renderDetail() {
  const item = applications.find(a => a.id === detailId);
  if (!item) return;
  const messages = {
    review: 'Заявка принята. Пока можно вернуться к делам — статус обновится здесь автоматически.',
    needs_info: 'Ваш бизнес работает меньше полугода. Расскажите об источниках выручки и планах, чтобы мы могли продолжить рассмотрение.',
    approved: 'Для вашей заявки подобраны условия. Проверьте сумму, срок и платёж. Если всё подходит, примите предложение.',
    alternative: 'На запрошенную сумму пока не получается подобрать посильный платёж. Есть предложение на меньшую сумму — ознакомьтесь с условиями ниже.',
    declined: 'Сейчас не удалось подобрать финансирование: свободного дохода недостаточно для платежей. Вы можете пересмотреть расходы или сумму и подать новую заявку.',
    accepted: 'Условия приняты. Демонстрационный сценарий завершён. Реальный договор не заключён, денежные средства не переводились.',
  };
  $('detail-title').textContent = `Заявка № ${item.id}`;
  const amount = ['approved', 'alternative', 'accepted'].includes(item.status) ? item.offeredAmount : Number(item.amount);
  $('detail-content').innerHTML = `<span class="status ${item.status}">${statusNames[item.status]}</span><p class="detail-intro">${messages[item.status]}</p><div class="timeline"><div class="done">Заявка отправлена</div><div class="${item.status === 'review' || item.status === 'needs_info' ? 'current' : 'done'}">${item.status === 'needs_info' ? 'Нужны уточнения' : 'Рассмотрение'}</div><div class="${['review', 'needs_info'].includes(item.status) ? '' : 'done'}">${item.status === 'accepted' ? 'Условия приняты' : 'Решение'}</div></div>${reviewData(item, amount)}${item.status === 'alternative' ? `<p class="field-hint">Вы запрашивали ${money(Number(item.amount))}. Выше показаны предлагаемые условия.</p>` : ''}<div class="detail-actions">${['approved', 'alternative'].includes(item.status) ? '<button class="button primary" data-action="accept">Принять демо-условия <span>→</span></button><p class="field-hint">Это действие не создаёт финансовых обязательств.</p>' : ''}${item.status === 'needs_info' ? '<form id="clarification-form"><div class="field"><label for="clarification">Расскажите о доходах и планах бизнеса</label><textarea id="clarification" name="clarification" required minlength="20" maxlength="2000" placeholder="Например, какие договоры уже заключены и откуда поступает выручка"></textarea></div><button class="button primary" type="submit">Отправить уточнение <span>→</span></button></form>' : ''}${item.status === 'declined' ? '<button class="button secondary" data-action="reapply">Подать новую заявку <span>→</span></button>' : ''}</div>`;
}
$('detail-content').addEventListener('submit', event => {
  if (event.target.id !== 'clarification-form') return;
  event.preventDefault();
  const text = new FormData(event.target).get('clarification').trim();
  if (text.length < 20) return;
  const item = applications.find(a => a.id === detailId);
  item.clarification = text;
  item.status = 'review';
  item.decisionAt = Date.now() + 6000;
  persist(); renderApplications(); renderDetail();
});

function renderProfile() {
  if (!user) {
    $('profile-content').innerHTML = '<div class="card profile-card"><h2>Рады знакомству</h2><p class="muted">Войдите или создайте аккаунт, чтобы управлять данными профиля. Демо-заявку можно пройти без регистрации.</p><button class="button primary" data-action="login">Войти</button><button class="button secondary" data-action="register">Создать аккаунт</button></div>';
    return;
  }
  $('profile-content').innerHTML = `<div class="card profile-card"><h2>${escapeHTML(user.username)}</h2><div class="profile-data"><span>Электронная почта</span><strong>${escapeHTML(user.email)}</strong></div><div class="profile-data"><span>Почта подтверждена</span><strong>${user.is_verified ? 'Да' : 'Пока нет'}</strong></div><button class="button secondary" data-action="edit-profile">Изменить имя</button>${!user.is_verified ? '<button class="button secondary" data-action="request-verify">Подтвердить почту</button>' : ''}<button class="text-button" data-action="logout">Выйти из кабинета</button></div><div class="info-banner"><span>i</span><p>Демонстрационные заявки привязаны к этому аккаунту на текущем устройстве. При входе с другого устройства они не появятся.</p></div>`;
}
const accountFields = {
  email: {label: 'Электронная почта', type: 'email', autocomplete: 'email'},
  password: {label: 'Пароль', type: 'password', min: 8, max: 128, autocomplete: 'new-password'},
  username: {label: 'Ваше имя', min: 3, max: 20, autocomplete: 'username'},
  inn: {label: 'ИНН компании или ИП', max: 12},
  token: {label: 'Код из ссылки в письме', type: 'password', autocomplete: 'off'},
};
const accountModes = {
  login: {title: 'Вход в кабинет', description: 'Рады видеть вас снова.', fields: ['email', 'password'], button: 'Войти'},
  register: {title: 'Давайте знакомиться', description: 'Создайте аккаунт для своего бизнеса.', fields: ['email', 'password', 'username', 'inn'], button: 'Создать аккаунт'},
  forgot: {title: 'Восстановить доступ', description: 'Отправим ссылку для смены пароля на вашу почту.', fields: ['email'], button: 'Получить ссылку'},
  reset: {title: 'Новый пароль', description: 'Придумайте пароль от 8 до 128 символов.', fields: ['token', 'password'], button: 'Сохранить пароль'},
  verify: {title: 'Подтверждение почты', description: 'Подтвердите адрес, нажав кнопку ниже.', fields: ['token'], button: 'Подтвердить почту'},
  edit: {title: 'Как к вам обращаться?', description: 'Обновите имя в профиле.', fields: ['username'], button: 'Сохранить'},
};
function openAccount(mode) {
  if (accountBusy) return;
  accountMode = mode;
  const config = accountModes[mode];
  $('account-submit').hidden = false;
  $('account-title').textContent = config.title;
  $('account-description').textContent = config.description;
  $('account-message').hidden = true;
  $('account-submit').textContent = config.button;
  $('account-fields').innerHTML = config.fields.map(name => {
    const field = accountFields[name];
    const value = mode === 'edit' ? user.username : '';
    return `<div class="field"><label for="account-${name}">${field.label}</label><input id="account-${name}" name="${name}" type="${field.type || 'text'}" autocomplete="${mode === 'login' && name === 'password' ? 'current-password' : field.autocomplete || 'off'}" ${field.min && mode !== 'login' ? `minlength="${field.min}"` : ''} ${field.max && mode !== 'login' ? `maxlength="${field.max}"` : ''} value="${escapeHTML(value)}" required></div>`;
  }).join('');
  $('account-links').innerHTML = mode === 'login' ? '<button type="button" data-action="register">Создать аккаунт</button><button type="button" data-action="forgot">Не помню пароль</button>' : mode === 'register' || mode === 'forgot' ? '<button type="button" data-action="login">Уже есть аккаунт? Войти</button>' : '';
  showDialog('account-dialog');
}
function errorMessage(data, mode) {
  const detail = data?.detail;
  if (Array.isArray(detail)) {
    const key = detail[0]?.loc?.at(-1);
    return ({email: 'Проверьте адрес электронной почты.', inn: 'Проверьте ИНН компании.', username: 'Укажите имя от 3 до 20 символов.', password: 'Пароль должен содержать от 8 до 128 символов.'})[key] || 'Проверьте заполненные поля.';
  }
  const code = typeof detail === 'string' ? detail : detail?.code;
  const messages = {LOGIN_BAD_CREDENTIALS: 'Не получилось войти. Проверьте почту и пароль.', REGISTER_USER_ALREADY_EXISTS: 'Аккаунт с такой почтой уже есть. Попробуйте войти.', REGISTER_INVALID_PASSWORD: 'Пароль должен содержать от 8 до 128 символов.', RESET_PASSWORD_BAD_TOKEN: 'Ссылка устарела или уже использована. Запросите новую.', RESET_PASSWORD_INVALID_PASSWORD: 'Пароль должен содержать от 8 до 128 символов.', VERIFY_USER_BAD_TOKEN: 'Ссылка недействительна или срок её действия истёк.', VERIFY_USER_ALREADY_VERIFIED: 'Эта почта уже подтверждена.'};
  return messages[code] || (mode === 'login' ? 'Не удалось войти. Попробуйте ещё раз.' : 'Не удалось завершить действие. Попробуйте позже.');
}
async function api(path, method = 'GET', payload, form = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, {method, credentials: 'same-origin', headers: payload ? {'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json'} : {}, body: payload ? (form ? new URLSearchParams(payload) : JSON.stringify(payload)) : undefined, signal: controller.signal});
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* Present a friendly error for unexpected responses. */ }
    return {ok: response.ok, status: response.status, data};
  } finally { clearTimeout(timeout); }
}
async function syncUser() {
  const result = await api('/users/me');
  if (result.ok && result.data && typeof result.data.username === 'string') return result.data;
  if (result.status === 401 || result.status === 403) return null;
  throw new Error('Profile unavailable');
}
$('account-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (accountBusy) return;
  accountBusy = true;
  $('account-submit').disabled = true;
  $('account-message').hidden = true;
  const mode = accountMode;
  const fields = Object.fromEntries(new FormData(event.target));
  const paths = {login: '/auth/login', register: '/auth/register', forgot: '/auth/forgot-password', reset: '/auth/reset-password', verify: '/auth/verify', edit: '/users/me'};
  try {
    const result = await api(paths[mode], mode === 'edit' ? 'PATCH' : 'POST', mode === 'login' ? {username: fields.email, password: fields.password} : fields, mode === 'login');
    if (!result.ok) {
      $('account-message').textContent = result.status === 401 && mode === 'edit' ? 'Сессия закончилась. Войдите снова.' : errorMessage(result.data, mode);
      $('account-message').className = 'form-message error';
      $('account-message').hidden = false;
      return;
    }
    if (mode === 'login') {
      user = await syncUser();
      if (!user) throw new Error('Session unavailable');
      loadWorkspace();
      closeDialog('account-dialog');
      notify('Вы вошли в кабинет.');
    } else if (mode === 'edit') {
      user = result.data;
      renderAll();
      closeDialog('account-dialog');
      notify('Имя в профиле обновлено.');
    } else if (mode === 'register') {
      accountBusy = false;
      openAccount('login');
      $('account-email').value = fields.email;
      $('account-message').textContent = 'Аккаунт создан. Войдите с вашим паролем.';
      $('account-message').className = 'form-message';
      $('account-message').hidden = false;
    } else {
      $('account-message').textContent = mode === 'forgot' ? 'Если аккаунт с такой почтой существует, мы отправим ссылку для восстановления.' : mode === 'reset' ? 'Пароль изменён. Теперь можно войти с новым паролем.' : 'Почта подтверждена. Можно вернуться в кабинет.';
      $('account-message').className = 'form-message';
      $('account-message').hidden = false;
      $('account-fields').replaceChildren();
      $('account-submit').hidden = true;
      $('account-links').innerHTML = '<button type="button" data-action="login">Перейти ко входу</button>';
      if (mode === 'verify' && user) { user.is_verified = true; renderAll(); }
    }
  } catch {
    $('account-message').textContent = 'Не удалось связаться с сервисом. Проверьте соединение и попробуйте ещё раз.';
    $('account-message').className = 'form-message error';
    $('account-message').hidden = false;
  } finally { accountBusy = false; $('account-submit').disabled = false; }
});
async function logout() {
  try {
    const result = await api('/auth/logout', 'POST');
    if (!result.ok && result.status !== 401) throw new Error('Logout failed');
    user = null;
    loadWorkspace();
    navigate('home');
    notify('Вы вышли из аккаунта.');
  } catch { notify('Не получилось выйти. Попробуйте ещё раз.'); }
}

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.close) {
    if (button.dataset.close === 'application-dialog') {captureDraft(); clearTimeout(saveTimer); persist(); renderApplications();}
    closeDialog(button.dataset.close);
  }
  if (button.dataset.page) navigate(button.dataset.page);
  if (button.dataset.product) beginApplication(button.dataset.product);
  if (button.dataset.detail) openDetail(button.dataset.detail);
  if (button.dataset.filter) {
    filter = button.dataset.filter;
    for (const tab of document.querySelectorAll('[data-filter]')) {tab.classList.toggle('active', tab.dataset.filter === filter); tab.setAttribute('aria-pressed', String(tab.dataset.filter === filter));}
    renderApplications();
  }
  const action = button.dataset.action;
  if (action === 'apply') beginApplication();
  if (action === 'help') showDialog('help-dialog');
  if (action === 'delete-draft') {clearTimeout(saveTimer); draft = null; persist(); renderApplications(); notify('Черновик удалён.');}
  if (action === 'account') user ? navigate('profile') : openAccount('login');
  if (['login', 'register', 'forgot'].includes(action)) { $('account-submit').hidden = false; openAccount(action); }
  if (action === 'edit-profile' && user) openAccount('edit');
  if (action === 'logout') logout();
  if (action === 'request-verify' && user) {
    button.disabled = true;
    api('/auth/request-verify-token', 'POST', {email: user.email}).then(result => {
      notify(result.ok ? 'Если почта ожидает подтверждения, мы отправим письмо со ссылкой.' : 'Не удалось отправить письмо. Попробуйте позже.');
    }).catch(() => notify('Проверьте соединение и попробуйте ещё раз.')).finally(() => {button.disabled = false;});
  }
  if (action === 'sample') {
    Object.assign(draft, {company: 'ООО «Вектор»', inn: '7701234560', revenue: 1200000, expenses: 700000, debt: 20000, age: 24});
    persist(); renderWizard();
  }
  if (action === 'accept') {
    const item = applications.find(a => a.id === detailId);
    if (item && ['approved', 'alternative'].includes(item.status)) {item.status = 'accepted'; persist(); renderApplications(); renderDetail(); notify('Демо-условия приняты. Денежные операции не выполнялись.');}
  }
  if (action === 'reapply') {closeDialog('detail-dialog'); beginApplication(applications.find(a => a.id === detailId).product);}
});
$('application-dialog').addEventListener('cancel', () => {captureDraft(); clearTimeout(saveTimer); persist(); renderApplications();});
$('account-dialog').addEventListener('close', () => {
  if (!accountBusy) {$('account-fields').replaceChildren(); $('account-submit').hidden = false;}
});
$('calc-range').addEventListener('input', () => updateCalculator('calc-range'));
$('calc-amount').addEventListener('input', () => updateCalculator('calc-amount'));
$('calc-term').addEventListener('change', () => updateCalculator('calc-amount'));
$('calculator-apply').addEventListener('click', () => beginApplication(null, true));
window.addEventListener('pagehide', () => {if (draft) {captureDraft(); clearTimeout(saveTimer); persist();}});

renderProducts();
updateCalculator('calc-amount');
const params = new URLSearchParams(window.location.search);
const flow = params.get('flow');
const linkToken = params.get('token');
if (params.has('token')) window.history.replaceState(null, '', '/demo');
if (flow === 'reset' || flow === 'verify') {
  openAccount(flow);
  if (linkToken) $('account-token').value = linkToken;
}
(async () => {
  try { user = await syncUser(); }
  catch { notify('Сервис профиля временно недоступен. Демонстрационные заявки доступны без входа.'); }
  finally { resolvingSession = false; loadWorkspace(); }
})();
setInterval(updateDecisions, 1000);
