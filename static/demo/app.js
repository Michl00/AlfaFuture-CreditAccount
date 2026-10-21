'use strict';

const email = {name: 'email', label: 'Электронная почта', type: 'email', placeholder: 'you@example.com', autocomplete: 'email'};
const password = {name: 'password', label: 'Пароль', type: 'password', placeholder: 'Не менее 8 символов', minLength: 8, maxLength: 128, autocomplete: 'new-password'};
const token = {name: 'token', label: 'Токен из письма', type: 'password', placeholder: 'Вставьте токен из ссылки', autocomplete: 'off'};
const operations = [
  {id: 'register', group: 'АККАУНТ', label: 'Регистрация', method: 'POST', path: '/auth/register', description: 'Создайте пользователя для проверки полного сценария авторизации.', fields: [email, password, {name: 'username', label: 'Имя пользователя', placeholder: 'demo_user', minLength: 3, maxLength: 20, autocomplete: 'username'}, {name: 'inn', label: 'ИНН', placeholder: '7707083893', pattern: '[0-9]{10}|[0-9]{12}', hint: '10 или 12 цифр с корректной контрольной суммой. Пример: 7707083893.'}]},
  {id: 'login', group: 'АККАУНТ', label: 'Вход', method: 'POST', path: '/auth/login', description: 'Войдите по почте и паролю. Сервер установит HttpOnly cookie.', fields: [email, {...password, minLength: undefined, maxLength: undefined, autocomplete: 'current-password', placeholder: 'Ваш пароль'}], note: 'Почта отправляется в поле username в формате application/x-www-form-urlencoded.'},
  {id: 'profile', group: 'АККАУНТ', label: 'Профиль', method: 'GET', path: '/profile', description: 'Получите ID, имя и почту текущего пользователя.', fields: [], note: 'Сначала выполните вход. Cookie отправляется браузером автоматически.'},
  {id: 'me', group: 'АККАУНТ', label: 'Мой аккаунт', method: 'GET', path: '/users/me', description: 'Прочитайте аккаунт, включая флаги активности и подтверждения почты.', fields: []},
  {id: 'update', group: 'АККАУНТ', label: 'Изменить имя', method: 'PATCH', path: '/users/me', description: 'Измените имя пользователя текущей сессии.', fields: [{name: 'username', label: 'Новое имя', placeholder: 'new_username', minLength: 3, maxLength: 20, autocomplete: 'username'}]},
  {id: 'logout', group: 'АККАУНТ', label: 'Выход', method: 'POST', path: '/auth/logout', description: 'Завершите текущую сессию. Сервер удалит cookie авторизации.', fields: []},
  {id: 'forgot', group: 'ПОЧТА И ДОСТУП', label: 'Забыли пароль', method: 'POST', path: '/auth/forgot-password', description: 'Запросите письмо со ссылкой для смены пароля.', fields: [email], note: 'Требуется настроенный SMTP. Ответ 202 не раскрывает, существует ли аккаунт.'},
  {id: 'reset', group: 'ПОЧТА И ДОСТУП', label: 'Сброс пароля', method: 'POST', path: '/auth/reset-password', description: 'Задайте новый пароль, используя токен из письма.', fields: [token, {...password, label: 'Новый пароль'}]},
  {id: 'request-verify', group: 'ПОЧТА И ДОСТУП', label: 'Запросить проверку', method: 'POST', path: '/auth/request-verify-token', description: 'Отправьте письмо для подтверждения электронной почты.', fields: [email], note: 'Требуется настроенный SMTP. Токен придёт в письме, а не в ответе API.'},
  {id: 'verify', group: 'ПОЧТА И ДОСТУП', label: 'Подтвердить почту', method: 'POST', path: '/auth/verify', description: 'Подтвердите адрес токеном из письма.', fields: [token]},
  {id: 'custom', group: 'ИНСТРУМЕНТЫ', label: 'Свой запрос', method: 'GET', path: '/profile', description: 'Вызовите любой REST-метод текущего приложения.', fields: [{name: 'method', label: 'Метод', options: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'], value: 'GET'}, {name: 'path', label: 'Путь запроса', value: '/profile', placeholder: '/users/me'}, {name: 'body', label: 'JSON-тело', multiline: true, optional: true, placeholder: '{\n  "username": "demo_user"\n}'}], note: 'Только текущий origin. Для GET тело не отправляется. Пустое тело допустимо.'},
];

const $ = id => document.getElementById(id);
let selected;
let busy = false;
let tab = 'response';
let hasResult = false;
const historyEntries = [];
const views = {response: '', request: '', headers: ''};

function maskSecrets(value) {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /password|token|secret|authorization|cookie/i.test(key) ? '••••••••' : maskSecrets(item)]));
  }
  return value;
}

function safePath(path) {
  const url = new URL(path, window.location.origin);
  if (!path.startsWith('/') || path.startsWith('//') || url.origin !== window.location.origin || url.username || url.password) {
    throw new Error('Укажите путь текущего приложения, начиная с /');
  }
  for (const key of [...url.searchParams.keys()]) {
    if (/password|token|secret|authorization|cookie/i.test(key)) url.searchParams.set(key, '••••••••');
  }
  return url.pathname + url.search;
}

function selectOperation(id) {
  if (busy) return;
  selected = operations.find(operation => operation.id === id) || operations[0];
  for (const button of document.querySelectorAll('.operation')) {
    button.classList.toggle('active', button.dataset.operation === selected.id);
    if (button.dataset.operation === selected.id) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
  $('operation-title').textContent = selected.label;
  $('operation-description').textContent = selected.description;
  $('method-badge').textContent = selected.method;
  $('method-badge').className = `method ${selected.method.toLowerCase()}`;
  $('endpoint-path').textContent = selected.path;
  $('operation-note').textContent = selected.note || '';
  $('fields').replaceChildren();
  for (const field of selected.fields) {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';
    const label = document.createElement('label');
    label.htmlFor = `field-${field.name}`;
    label.textContent = field.label;
    if (!field.optional) {
      const required = document.createElement('span');
      required.className = 'required';
      required.textContent = '*';
      label.append(required);
    }
    const input = document.createElement(field.options ? 'select' : field.multiline ? 'textarea' : 'input');
    input.id = label.htmlFor;
    input.name = field.name;
    input.required = !field.optional;
    if (input.tagName === 'INPUT') input.type = field.type || 'text';
    input.autocomplete = field.autocomplete || 'off';
    for (const key of ['minLength', 'maxLength', 'pattern', 'placeholder']) {
      if (field[key] !== undefined) input[key] = field[key];
    }
    if (field.options) for (const option of field.options) input.add(new Option(option, option));
    if (field.value) input.value = field.value;
    wrapper.append(label, input);
    if (field.hint) {
      const hint = document.createElement('p');
      hint.className = 'field-hint';
      hint.id = `${input.id}-hint`;
      hint.textContent = field.hint;
      input.setAttribute('aria-describedby', hint.id);
      wrapper.append(hint);
    }
    $('fields').append(wrapper);
  }
}

let group;
for (const operation of operations) {
  if (operation.group !== group) {
    group = operation.group;
    const heading = document.createElement('div');
    heading.className = 'nav-group';
    heading.textContent = group;
    $('operations').append(heading);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'operation';
  button.dataset.operation = operation.id;
  const method = document.createElement('span');
  method.className = `mini-method ${operation.method.toLowerCase()}`;
  method.textContent = operation.id === 'custom' ? '↗' : operation.method;
  button.append(method, document.createTextNode(operation.label));
  button.addEventListener('click', () => selectOperation(operation.id));
  $('operations').append(button);
}

function renderView() {
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
    button.tabIndex = button.dataset.tab === tab ? 0 : -1;
  }
  $('empty-state').hidden = hasResult;
  for (const name of Object.keys(views)) {
    $(`${name}-view`).hidden = !hasResult || name !== tab;
    $(`${name}-view`).textContent = views[name];
  }
}

for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => { tab = button.dataset.tab; renderView(); });
  button.addEventListener('keydown', event => {
    const names = Object.keys(views);
    let index = names.indexOf(tab);
    if (event.key === 'ArrowRight') index = (index + 1) % names.length;
    else if (event.key === 'ArrowLeft') index = (index + names.length - 1) % names.length;
    else return;
    event.preventDefault();
    tab = names[index];
    renderView();
    $(`tab-${tab}`).focus();
  });
}

function renderHistory() {
  $('history-count').textContent = historyEntries.length;
  $('history').replaceChildren();
  if (!historyEntries.length) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = 'История запросов появится здесь и исчезнет после перезагрузки страницы.';
    $('history').append(empty);
  }
  for (const entry of historyEntries) {
    const row = document.createElement('div');
    row.className = 'history-row';
    for (const [text, className] of [[entry.time, ''], [entry.method, `mini-method ${entry.method.toLowerCase()}`], [entry.path, 'history-path'], [entry.status, `history-status ${entry.ok ? '' : 'error'}`], [`${entry.ms} мс`, '']]) {
      const cell = document.createElement('span');
      cell.className = className;
      cell.textContent = text;
      row.append(cell);
    }
    $('history').append(row);
  }
}

$('request-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const fields = Object.fromEntries(new FormData(event.currentTarget));
  let method = selected.method;
  let path = selected.path;
  let body;
  let payload;
  const headers = {};
  let displayPath;
  try {
    if (selected.id === 'custom') {
      method = fields.method;
      path = fields.path.trim();
      if (method !== 'GET' && fields.body.trim()) payload = JSON.parse(fields.body);
    } else if (selected.fields.length) payload = fields;
    displayPath = safePath(path);
    if (selected.id === 'login') {
      payload = {username: fields.email, password: fields.password};
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(payload);
    } else if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(payload);
    }
  } catch (error) {
    hasResult = true;
    tab = 'response';
    // JSON parser errors may include sensitive input; do not echo them.
    views.response = error instanceof SyntaxError ? 'Некорректный JSON. Проверьте тело запроса.' : error.message;
    views.request = '';
    views.headers = '';
    $('response-status').textContent = 'Ошибка ввода';
    $('response-status').className = 'status error';
    $('response-meta').textContent = 'Запрос не отправлен';
    renderView();
    return;
  }
  views.request = `${method} ${displayPath}\nCredentials: same-origin\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\n')}\n\n${payload === undefined ? '(без тела)' : JSON.stringify(maskSecrets(payload), null, 2)}`;
  views.response = 'Ожидаем ответ сервера…';
  views.headers = '';
  hasResult = true;
  tab = 'response';
  busy = true;
  $('send').disabled = true;
  $('send').firstElementChild.textContent = 'Отправляем…';
  $('response-status').textContent = 'Выполняется';
  $('response-status').className = 'status';
  $('response-meta').textContent = 'Таймаут: 30 секунд';
  renderView();
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let status = 'ERR';
  let ok = false;
  try {
    const response = await fetch(path, {method, headers, body, credentials: 'same-origin', signal: controller.signal, redirect: 'error'});
    status = response.status;
    ok = response.ok;
    const text = await response.text();
    try { views.response = JSON.stringify(JSON.parse(text), null, 2); }
    catch { views.response = text || '(пустой ответ)'; }
    views.headers = [...response.headers.entries()].map(([key, value]) => `${key}: ${value}`).join('\n') || '(нет доступных заголовков)';
    $('response-status').textContent = `${status} ${response.statusText}`;
    $('response-status').className = `status ${ok ? 'success' : 'error'}`;
    $('response-meta').textContent = `${Math.round(performance.now() - started)} мс · ${new TextEncoder().encode(text).length} байт`;
  } catch (error) {
    views.response = error.name === 'AbortError' ? 'Превышено время ожидания (30 секунд). Сервер мог продолжить обработку запроса.' : 'Не удалось получить ответ. Проверьте доступность сервера. Перенаправления не поддерживаются.';
    $('response-status').textContent = error.name === 'AbortError' ? 'Таймаут' : 'Ошибка сети';
    $('response-status').className = 'status error';
    $('response-meta').textContent = `${Math.round(performance.now() - started)} мс`;
  } finally {
    clearTimeout(timeout);
    busy = false;
    $('send').disabled = false;
    $('send').firstElementChild.textContent = 'Отправить запрос';
    historyEntries.unshift({method, path: displayPath, status, ok, ms: Math.round(performance.now() - started), time: new Date().toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'})});
    historyEntries.splice(20);
    renderView();
    renderHistory();
  }
});

$('copy').addEventListener('click', async () => {
  if (!hasResult) return;
  try {
    await navigator.clipboard.writeText(views[tab]);
    $('copy-status').textContent = 'Скопировано';
  } catch { $('copy-status').textContent = 'Выделите и скопируйте текст вручную'; }
});
$('clear-history').addEventListener('click', () => { historyEntries.length = 0; renderHistory(); });
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    $('request-form').requestSubmit();
  }
});

const params = new URLSearchParams(window.location.search);
const flow = params.get('flow');
selectOperation(flow === 'reset' || flow === 'verify' ? flow : 'register');
if ((flow === 'reset' || flow === 'verify') && params.has('token')) {
  $('field-token').value = params.get('token');
  // Remove the token from the address bar without triggering a request.
  window.history.replaceState(null, '', '/demo');
}
