'use strict';
(() => {
  const {api, money, escapeHTML: esc, notify, getUser} = window.Cabinet;
  const get = id => document.getElementById(id);
  const labels = {bank_review: 'Ожидает рассмотрения', in_review: 'В работе', needs_info: 'Ожидает уточнения', approved: 'Одобрено', rejected: 'Отказ'};
  const riskLabels = {low: 'Низкий риск', medium: 'Умеренный риск', high: 'Повышенный риск', critical: 'Критический риск'};
  const partLabels = {financial: 'Финансовые показатели', credit_history: 'Кредитная история', registry: 'Статус регистрации', business_transparency: 'Прозрачность бизнеса', document_penalty: 'Расхождения документов'};
  const dataLabels = {active: 'Действующий бизнес', legal_form: 'Форма', registered_months_ago: 'Возраст по моку, мес.', credit_score: 'Оценка БКИ', overdue_days: 'Просрочка, дней', active_loans: 'Действующие кредиты', tax_debt: 'Налоговая задолженность', mass_address: 'Массовый адрес', bankruptcy: 'Банкротство', count: 'Документов', conflicts: 'Расхождения'};
  const actionLabels = {submit: 'Отправлено клиентом', claim: 'Взято в работу', approve: 'Одобрено', reject: 'Отказ', request_info: 'Запрошено уточнение', clarification: 'Ответ клиента', recheck: 'Проверки обновлены'};
  let employee = null;
  let offset = 0;
  let rows = [];
  let detail = null;
  let queueVersion = 0;
  let actionBusy = false;

  async function checkRole() {
    const owner = getUser();
    employee = null;
    get('bank-menu').hidden = true;
    rows = [];
    get('bank-queue').replaceChildren();
    get('bank-detail').replaceChildren();
    if (get('bank-detail-dialog').open) get('bank-detail-dialog').close();
    if (!owner) return;
    try {
      const result = await api('/bank/me');
      if (result.ok && getUser()?.id === owner.id) {
        employee = result.data;
        get('bank-menu').hidden = false;
      }
    } catch { /* The protected server routes remain authoritative. */ }
  }
  async function loadQueue(append = false) {
    if (!employee) {get('bank-message').textContent = 'Доступ только сотрудникам банка.'; return;}
    const version = ++queueVersion;
    if (!append) {offset = 0; rows = [];}
    get('bank-message').textContent = 'Загружаем заявки…';
    const params = new URLSearchParams({status: get('bank-status').value, only_mine: get('bank-mine').checked, manual_only: get('bank-manual').checked, offset, limit: 50});
    try {
      const result = await api('/bank/applications?' + params);
      if (version !== queueVersion) return;
      if (!result.ok) throw new Error('Не удалось загрузить очередь. Проверьте доступ и обновите страницу.');
      rows = append ? [...rows, ...result.data.items] : result.data.items;
      get('bank-more').hidden = !result.data.has_more;
      get('bank-message').textContent = rows.length ? `Показано заявок: ${rows.length}` : 'В этой очереди пока нет заявок.';
      get('bank-queue').innerHTML = rows.map(item => `<button class="bank-row card" data-bank-id="${esc(item.id)}"><span><small>№ ${esc(item.id)}</small><strong>${esc(item.company)}</strong><small>ИНН ${esc(item.inn)} · ${new Date(item.createdAt).toLocaleDateString('ru-RU')}</small></span><span class="bank-row-amount">${money(item.amount)}<small>${item.months} мес. · ${item.rate}%</small></span><span><strong>${item.score.value} / 1000</strong><small>${riskLabels[item.score.risk]}</small></span><span class="status ${item.status}">${labels[item.status]}</span>${item.score.manual_review ? '<span class="offer-tag">Нестандартная</span>' : '<span class="muted">Без замечаний</span>'}</button>`).join('');
    } catch (error) {get('bank-message').textContent = error.message;}
  }
  async function openApplication(id) {
    get('bank-detail-dialog').showModal();
    get('bank-detail').textContent = 'Загружаем карточку…';
    try {
      const result = await api('/bank/applications/' + encodeURIComponent(id));
      if (!result.ok) throw new Error('Карточка недоступна.');
      detail = result.data; renderDetail();
    } catch (error) {get('bank-detail').textContent = error.message;}
  }
  function checkCard(check) {
    const data = Object.entries(check.data).map(([key, value]) => {
      const text = typeof value === 'boolean' ? value ? 'Да' : 'Нет' : Array.isArray(value) ? value.length : value;
      return `<div><span>${dataLabels[key] || esc(key)}</span><strong>${esc(text)}</strong></div>`;
    }).join('');
    return `<article class="check-card ${esc(check.status)}"><div class="section-heading"><h4>${esc(check.source)}</h4><span class="offer-tag">${check.mock ? 'Мок' : 'Сверка'}</span></div><p>${esc(check.summary)}</p><div class="check-values">${data}</div></article>`;
  }
  function renderDetail() {
    if (!detail || !employee) return;
    const score = detail.score;
    const mine = detail.assigned_to === employee.id && detail.status === 'in_review';
    const canClaim = ['bank_review', 'in_review'].includes(detail.status) && [null, employee.id].includes(detail.assigned_to);
    const final = ['approved', 'rejected'].includes(detail.status);
    get('bank-detail-title').textContent = 'Заявка · ' + detail.company;
    get('bank-detail').innerHTML = `<div class="section-heading"><span class="status ${detail.status}">${labels[detail.status]}</span><span class="muted">Версия ${detail.version} · ${new Date(detail.updatedAt).toLocaleString('ru-RU')}</span></div><div class="bank-summary"><div><span>Клиент</span><strong>${esc(detail.applicant.username)}</strong><small>${esc(detail.applicant.email)}</small></div><div><span>Компания</span><strong>${esc(detail.company)}</strong><small>ИНН ${esc(detail.inn)}</small></div><div><span>Согласованные условия</span><strong>${money(detail.amount)}</strong><small>${detail.months} мес. · ${detail.rate}% годовых</small></div></div><p class="muted">Цель: ${esc(detail.goal)}</p><div class="scoring-card"><div><span>Скоринг</span><strong>${score.value}<small> / 1000</small></strong><span>${riskLabels[score.risk]}</span></div><div class="score-parts">${Object.entries(score.parts).map(([key, value]) => `<div><span>${partLabels[key] || key}</span><strong>${value}</strong></div>`).join('')}</div></div><p class="field-hint">${esc(score.method)}</p>${score.manual_review ? `<div class="info-banner"><div><strong>Требуется ручное рассмотрение</strong><ul>${score.manual_reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul></div></div>` : ''}<h3>Результаты проверок</h3><div class="checks-grid">${['registry', 'bki', 'transparent', 'documents'].map(key => checkCard(detail.checks[key])).join('')}</div><h3>Финансовые показатели</h3><div class="review-data">${[['Выручка / мес.', money(detail.revenue)], ['Расходы / мес.', money(detail.expenses)], ['Кредитные платежи / мес.', money(detail.debt)], ['Возраст бизнеса', `${detail.age} мес.`]].map(([name, value]) => `<div><span>${name}</span><strong>${value}</strong></div>`).join('')}</div><h3>Предварительная оценка ИИ</h3><ul class="assessment-reasons">${(detail.ai_reasons || []).map(reason => `<li>${esc(reason)}</li>`).join('')}</ul><h3>Документы</h3><div class="document-links">${detail.documents.map(document => `<a href="/credit/documents/${encodeURIComponent(document.id)}">↓ ${esc(document.filename)}</a>`).join('') || '<span class="muted">Документы не приложены.</span>'}</div><h3>История действий</h3><div>${detail.events.map(event => `<div class="client-event"><strong>${actionLabels[event.action] || esc(event.action)}</strong><p>${esc(event.comment)}</p><small>${new Date(event.createdAt).toLocaleString('ru-RU')} · участник ${event.actor_id}</small></div>`).join('')}</div><div class="bank-decision">${final ? '<p class="muted">Решение зафиксировано. Изменять завершённую заявку нельзя.</p>' : `${canClaim && !mine ? '<button class="button primary" data-bank-action="claim">Взять в работу →</button>' : ''}${mine ? '<button class="button secondary" data-bank-action="recheck">Повторить проверки</button><form id="bank-decision-form"><div class="field"><label for="bank-decision-action">Решение сотрудника</label><select id="bank-decision-action" name="action"><option value="approve">Одобрить согласованные условия</option><option value="reject">Отказать</option><option value="request_info">Запросить уточнение</option></select></div><div class="field"><label for="bank-decision-comment">Обоснование (обязательно)</label><textarea id="bank-decision-comment" name="comment" required minlength="10" maxlength="2000" placeholder="Опишите причину решения или какие сведения нужны от клиента"></textarea></div><button class="button primary" type="submit">Зафиксировать решение →</button></form>' : '<p class="muted">Для решения возьмите заявку в работу. Заявки другого сотрудника недоступны для изменения.</p>'}`}</div>`;
  }
  async function act(action, comment = '') {
    if (actionBusy || !detail) return;
    actionBusy = true;
    const id = detail.id;
    try {
      const result = await api('/bank/applications/' + encodeURIComponent(id) + '/actions', 'POST', {version: detail.version, action, comment});
      if (!result.ok) {
        const messages = {APPLICATION_CHANGED: 'Заявка уже изменена. Карточка обновлена — проверьте данные.', APPLICATION_HARD_STOP: 'Одобрение невозможно: есть блокирующие факторы.', DECISION_COMMENT_REQUIRED: 'Добавьте обоснование решения (минимум 10 символов).', APPLICATION_CLAIM_REQUIRED: 'Сначала возьмите заявку в работу.', APPLICATION_ASSIGNED: 'Заявка уже закреплена за другим сотрудником.', APPLICATION_FINAL: 'Решение уже принято.'};
        notify(messages[result.data?.detail] || 'Не удалось сохранить действие.');
        const fresh = await api('/bank/applications/' + encodeURIComponent(id));
        if (fresh.ok) {detail = fresh.data; renderDetail();}
        return;
      }
      detail = result.data; renderDetail(); await loadQueue();
      notify('Действие сохранено в истории заявки.');
    } catch {notify('Не удалось связаться с сервером. Попробуйте ещё раз.');}
    finally {actionBusy = false;}
  }
  get('bank-refresh').addEventListener('click', () => loadQueue());
  for (const id of ['bank-status', 'bank-mine', 'bank-manual']) get(id).addEventListener('change', () => loadQueue());
  get('bank-more').addEventListener('click', () => {offset += 50; loadQueue(true);});
  document.addEventListener('click', event => {
    const card = event.target.closest('[data-bank-id]');
    if (card) openApplication(card.dataset.bankId);
    const action = event.target.closest('[data-bank-action]');
    if (action) act(action.dataset.bankAction);
  });
  document.addEventListener('submit', event => {
    if (event.target.id !== 'bank-decision-form') return;
    event.preventDefault();
    const data = new FormData(event.target);
    if (data.get('comment').trim().length < 10) return;
    act(data.get('action'), data.get('comment').trim());
  });
  window.addEventListener('cabinet-auth', checkRole);
  window.addEventListener('bank-open', async () => {if (!employee) await checkRole(); await loadQueue();});
  checkRole();
})();
