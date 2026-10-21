'use strict';

const {products, payment, validate, validateRequest, advisor} = window.CreditFlow;
const $ = id => document.getElementById(id);
const money = amount => new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 0}).format(amount) + ' ₽';
const moneyFields = new Set(['requestedAmount', 'amount', 'revenue', 'expenses', 'debt']);
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
const statusNames = {bank_review: 'Ожидает подтверждения банка', draft: 'Черновик', review: 'На рассмотрении', needs_info: 'Нужны уточнения', approved: 'Одобрено', alternative: 'Есть предложение', declined: 'Не одобрено', accepted: 'Условия приняты'};
const finished = ['declined', 'accepted'];
let user = null;
let currentPage = 'home';
let filter = 'all';
let draft = null;
let applications = [];
let wizardStep = 0;
let assessmentBusy = false;
let assessmentTimer;
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
  clearTimeout(saveTimer);
  clearTimeout(assessmentTimer);
  assessmentBusy = false;
  draft = null;
  applications = [];
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey()) || '{}');
    if (saved.draft && typeof saved.draft === 'object' && products.some(p => p.id === saved.draft.product)) {
      draft = {...emptyDraft(), ...saved.draft};
      draft.requestedAmount = saved.draft.requestedAmount ?? saved.draft.amount ?? 1500000;
      draft.requestedMonths = saved.draft.requestedMonths ?? saved.draft.months ?? 24;
      draft.stage = Number.isInteger(draft.stage) && draft.stage >= 0 && draft.stage <= 3 ? draft.stage : 0;
      if (draft.stage >= 2 && !draft.selectedOffer) draft.stage = 1;
      if (draft.stage === 3 && validate(draft)) draft.stage = 2;
    }
    if (Array.isArray(saved.applications)) applications = saved.applications.filter(item => item && typeof item.id === 'string' && !validate(item) && Object.hasOwn(statusNames, item.status) && item.status !== 'draft' && Number.isFinite(item.createdAt)).slice(0, 100);
  } catch { notify('Не удалось восстановить сохранённые заявки. Можно начать новую.'); }
  renderAll();
}
function emptyDraft() {
  return {goal: 'working', requestedAmount: 1500000, requestedMonths: 24, selectedOffer: null, stage: 0, product: 'working', amount: 1500000, months: 24, company: '', inn: '', revenue: '', expenses: '', debt: 0, age: '', clarification: ''};
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
  if (productId || fromCalculator) {
    clearTimeout(assessmentTimer);
    assessmentBusy = false;
    draft.stage = 0;
    draft.selectedOffer = null;
    draft.assessment = null;
  }
  if (productId) draft.goal = productId;
  if (fromCalculator) {
    draft.goal = Number($('calc-term').value) > 36 ? 'equipment' : 'working';
    draft.requestedAmount = Number(ungroup($('calc-amount').value));
    draft.requestedMonths = Number($('calc-term').value);
  }
  wizardStep = draft.stage || 0;
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
function reviewData(item, amount = Number(item.amount)) {
  const product = products.find(p => p.id === item.product);
  const rate = Number(item.rate ?? product.rate);
  return `<div class="review-data"><div><span>Цель финансирования</span><strong>${product.short}</strong></div><div><span>Компания</span><strong>${escapeHTML(item.company)}</strong></div><div><span>Сумма</span><strong>${money(amount)}</strong></div><div><span>Срок</span><strong>${item.months} мес.</strong></div><div><span>Предварительная ставка</span><strong>${String(rate).replace('.', ',')}% годовых</strong></div><div><span>Ежемесячный платёж</span><strong>${money(payment(amount, Number(item.months), rate))}</strong></div></div>`;
}
function comparison(assessment) {
  const product = products.find(p => p.id === draft.product);
  const before = [money(Number(draft.amount)), `${draft.months} мес.`, `${String(product.rate).replace('.', ',')}%`, money(payment(Number(draft.amount), Number(draft.months), product.rate))];
  const after = [money(assessment.terms.amount), `${assessment.terms.months} мес.`, `${String(assessment.terms.rate).replace('.', ',')}%`, money(assessment.terms.payment)];
  return `<div class="terms-comparison"><div class="comparison-row comparison-head"><span>Параметр</span><span>Вы выбрали</span><span>К согласованию</span></div>${['Сумма', 'Срок', 'Ставка', 'Платёж в месяц'].map((label, index) => `<div class="comparison-row"><span>${label}</span><span>${before[index]}</span><strong class="${before[index] !== after[index] ? 'changed' : ''}">${after[index]}</strong></div>`).join('')}</div>`;
}
function offerCards() {
  return advisor.recommend(draft).map(offer => {
    const product = products.find(p => p.id === offer.product);
    const selected = draft.selectedOffer === offer.product;
    return `<article class="offer-card ${selected ? 'selected' : ''}"><div class="section-heading"><h3>${product.name}</h3>${offer.recommended ? '<span class="offer-tag">Под вашу цель</span>' : ''}</div><p class="muted">${offer.reason}</p><div class="offer-facts"><strong>${money(offer.amount)}<small>на ${offer.months} мес.</small></strong><strong>${money(offer.payment)}<small>в месяц · ${String(offer.rate).replace('.', ',')}%</small></strong></div>${offer.limited ? '<p class="field-hint">Сумма или срок ограничены условиями этого варианта.</p>' : ''}<button type="button" class="button ${selected ? 'primary' : 'secondary'} full" data-offer="${offer.product}" aria-pressed="${selected}">${selected ? 'Выбрано ✓' : 'Выбрать вариант →'}</button></article>`;
  }).join('');
}
function renderWizard() {
  $('application-error').hidden = true;
  $('wizard-progress').innerHTML = ['1. Ваши планы', '2. Варианты', '3. О компании', '4. Согласование'].map((label, index) => `<span class="${index <= wizardStep ? 'active' : ''}" ${index === wizardStep ? 'aria-current="step"' : ''}>${label}</span>`).join('');
  $('wizard-back').hidden = wizardStep === 0;
  $('wizard-back').disabled = assessmentBusy;
  $('wizard-next').disabled = assessmentBusy;
  $('wizard-next').innerHTML = wizardStep === 0 ? 'Подобрать варианты <span>→</span>' : wizardStep === 2 ? 'Оценить условия <span>→</span>' : wizardStep === 3 ? 'Согласовать и отправить в банк <span>→</span>' : 'Продолжить <span>→</span>';
  if (wizardStep === 0) {
    $('wizard-fields').innerHTML = `<div class="field"><label for="app-goal">Для чего нужны деньги?</label><select id="app-goal" name="goal">${products.map(p => `<option value="${p.id}" ${p.id === draft.goal ? 'selected' : ''}>${p.name}</option>`).join('')}</select></div><div class="form-grid">${field('requestedAmount', 'Сколько нужно, ₽', {min: 100000, max: 10000000})}${field('requestedMonths', 'На какой срок, месяцев', {type: 'number', min: 6, max: 60, step: 1})}</div><p class="muted">Сначала подберём варианты под ваши планы. Сведения о компании понадобятся после выбора.</p>`;
  } else if (wizardStep === 1) {
    $('wizard-fields').innerHTML = `<p class="muted">Варианты под запрос ${money(Number(draft.requestedAmount))} на ${draft.requestedMonths} мес. Выберите один, чтобы продолжить.</p><div class="offers-list">${offerCards()}</div><p class="small-note">Предварительные условия. После оценки бизнеса они могут измениться.</p>`;
  } else if (wizardStep === 2) {
    const product = products.find(p => p.id === draft.product);
    $('wizard-fields').innerHTML = `<div class="info-banner"><p>Выбрано: <strong>${product.name}</strong> · ${money(Number(draft.amount))} на ${draft.months} мес.</p></div><div class="section-heading"><p class="muted">Расскажите о компании, чтобы оценить условия.</p><button type="button" class="text-button" data-action="sample">Заполнить примером →</button></div><div class="form-grid">${field('company', 'Название компании или ИП', {maxLength: 120})}${field('inn', 'ИНН', {maxLength: 12, hint: '10 или 12 цифр'})}${field('revenue', 'Среднемесячная выручка, ₽', {min: 1, max: 1000000000})}${field('expenses', 'Среднемесячные расходы, ₽', {min: 0, max: 1000000000})}${field('debt', 'Платежи по кредитам, ₽/мес.', {min: 0, max: 1000000000})}${field('age', 'Возраст бизнеса, месяцев', {type: 'number', min: 0, max: 1200, step: 1})}</div><p class="field-hint">Используйте вымышленные данные. Оценка пока демонстрационная.</p>`;
  } else if (assessmentBusy) {
    $('wizard-fields').innerHTML = '<div class="assessment-loading" role="status"><span class="loading-ring"></span><h3>Подбираем посильные условия</h3><p>Учитываем доходы, расходы и действующие обязательства компании.</p></div>';
  } else {
    const assessment = advisor.assess(draft);
    draft.assessment = assessment;
    const reasons = `<ul class="assessment-reasons">${assessment.reasons.map(reason => `<li>${escapeHTML(reason)}</li>`).join('')}</ul>`;
    if (assessment.status === 'needs_info') {
      $('wizard-fields').innerHTML = `<h3>Нужно немного больше информации</h3>${reasons}<div class="field"><label for="app-clarification">Расскажите о договорах и источниках выручки</label><textarea id="app-clarification" name="clarification" minlength="20" maxlength="2000" required>${escapeHTML(draft.clarification)}</textarea></div>`;
      $('wizard-next').innerHTML = 'Продолжить оценку <span>→</span>';
    } else if (assessment.status === 'unavailable') {
      $('wizard-fields').innerHTML = `<h3>Пока не получается подобрать условия</h3>${reasons}<p class="muted">Это предварительная оценка, а не решение банка. Заявка не отправлена.</p>`;
      $('wizard-next').innerHTML = 'Изменить параметры <span>→</span>';
    } else {
      $('wizard-fields').innerHTML = `<div class="section-heading"><h3>Ваши условия к согласованию</h3><span class="offer-tag">Предварительная оценка</span></div>${comparison(assessment)}${reasons}<div class="info-banner"><p>Банк ещё не получил заявку и не принимал решение. Проверьте изменения и подтвердите согласие на отправку.</p></div><label class="checkbox-label"><input name="consent" type="checkbox" required><span>Согласен с указанными выше суммой, сроком, ставкой и платежом и хочу отправить заявку на подтверждение в банк.</span></label>`;
    }
  }
  $('draft-status').textContent = storageAvailable ? 'Черновик сохранён на этом устройстве' : 'Изменения доступны до закрытия вкладки';
}
function captureDraft() {
  if (!draft) return;
  for (const [key, value] of new FormData($('application-form'))) if (key !== 'consent') draft[key] = moneyFields.has(key) ? ungroup(value) : value;
}
function wizardError(message) {
  $('application-error').textContent = message;
  $('application-error').hidden = false;
}
function moveToStep(step) {
  wizardStep = step;
  draft.stage = step;
  persist();
  renderWizard();
}
function runAssessment() {
  clearTimeout(saveTimer);
  assessmentBusy = true;
  draft.stage = 3;
  wizardStep = 3;
  persist();
  renderWizard();
  const snapshot = draft;
  assessmentTimer = setTimeout(() => {
    if (draft !== snapshot) return;
    assessmentBusy = false;
    draft.assessment = advisor.assess(draft);
    persist();
    if ($('application-dialog').open) renderWizard();
  }, 800);
}
$('application-form').addEventListener('input', event => {
  if (event.target.hasAttribute('data-money')) formatMoneyInput(event.target);
  captureDraft();
  if (wizardStep < 3) draft.assessment = null;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 250);
});
$('application-form').addEventListener('submit', event => {
  event.preventDefault();
  if (assessmentBusy || !draft) return;
  captureDraft();
  if (wizardStep === 0) {
    const error = validateRequest(draft);
    if (error) return wizardError(error);
    draft.selectedOffer = null;
    draft.assessment = null;
    moveToStep(1);
  } else if (wizardStep === 1) {
    const offer = advisor.recommend(draft).find(item => item.product === draft.selectedOffer);
    if (!offer) return wizardError('Выберите один из предложенных вариантов.');
    Object.assign(draft, {product: offer.product, amount: offer.amount, months: offer.months});
    moveToStep(2);
  } else if (wizardStep === 2) {
    const error = validate(draft);
    if (error) return wizardError(error);
    runAssessment();
  } else {
    const error = validate(draft);
    if (error) return wizardError(error);
    const assessment = advisor.assess(draft);
    if (assessment.status === 'unavailable') {moveToStep(0); return;}
    if (assessment.status === 'needs_info') return wizardError('Добавьте описание доходов и договоров — минимум 20 символов.');
    // Clarifications need a fresh assessment and a separate consent, never implicit submission.
    if (!$('application-form').querySelector('[name="consent"]')) {runAssessment(); return;}
    if (!new FormData($('application-form')).get('consent')) return;
    clearTimeout(saveTimer);
    const createdAt = Date.now();
    const item = {...draft, ...assessment.terms, assessment, selectedTerms: {amount: Number(draft.amount), months: Number(draft.months), rate: products.find(p => p.id === draft.product).rate}, flowVersion: 2, id: `${createdAt.toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`, status: 'bank_review', createdAt, agreedAt: createdAt};
    applications.unshift(item);
    applications.splice(100);
    draft = null;
    persist();
    closeDialog('application-dialog');
    renderApplications();
    navigate('profile');
    notify('Условия согласованы. Демо-заявка ожидает подтверждения банка и доступна в профиле.');
  }
});
$('wizard-back').addEventListener('click', () => {
  if (assessmentBusy) return;
  captureDraft();
  draft.assessment = null;
  moveToStep(Math.max(0, wizardStep - 1));
});
function openDetail(id) { detailId = id; renderDetail(); showDialog('detail-dialog'); }
function renderDetail() {
  const item = applications.find(a => a.id === detailId);
  if (!item) return;
  $('detail-title').textContent = `Заявка № ${item.id}`;
  const current = item.status === 'bank_review';
  $('detail-content').innerHTML = `<span class="status ${item.status}">${statusNames[item.status]}</span><p class="detail-intro">${current ? 'Вы согласовали условия. Заявка направлена на подтверждение банка. До его решения условия остаются предварительными.' : 'Эта заявка сохранена в предыдущем демонстрационном сценарии. Её статус не является подтверждением банка.'}</p><div class="timeline"><div class="done">Вариант выбран</div><div class="done">Условия согласованы</div><div class="${current ? 'current' : ''}">Подтверждение банка</div></div>${reviewData(item)}${current ? `<p class="field-hint">Согласовано ${new Date(item.agreedAt).toLocaleString('ru-RU')}.</p><div class="info-banner"><p>Отправка в банк пока моделируется. Реальный банк не подключён, автоматического одобрения нет.</p></div>` : ''}`;
}
function renderProfile() {
  const account = !user ? '<div class="card profile-card"><h2>Рады знакомству</h2><p class="muted">Войдите или создайте аккаунт для работы с профилем. Демо-заявки гостя сохраняются отдельно на этом устройстве.</p><button class="button primary" data-action="login">Войти</button><button class="button secondary" data-action="register">Создать аккаунт</button></div>' : `<div class="card profile-card"><h2>${escapeHTML(user.username)}</h2><div class="profile-data"><span>Электронная почта</span><strong>${escapeHTML(user.email)}</strong></div><div class="profile-data"><span>Почта подтверждена</span><strong>${user.is_verified ? 'Да' : 'Пока нет'}</strong></div><button class="button secondary" data-action="edit-profile">Изменить имя</button>${!user.is_verified ? '<button class="button secondary" data-action="request-verify">Подтвердить почту</button>' : ''}<button class="text-button" data-action="logout">Выйти из кабинета</button></div>`;
  $('profile-content').innerHTML = `${account}<section class="section"><div class="section-heading"><h2>Заявки на подтверждении <span class="inline-count">${applications.filter(item => item.status === 'bank_review').length}</span></h2></div><div id="profile-applications">${applications.map(applicationCard).join('') || emptyApplications()}</div></section><div class="info-banner"><p>Демонстрационные заявки сохраняются на этом устройстве отдельно для каждого аккаунта и гостя.</p></div>`;
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
  if (button.dataset.offer && draft && wizardStep === 1) {
    draft.selectedOffer = button.dataset.offer;
    persist();
    renderWizard();
  }
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
