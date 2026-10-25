// Server state is authoritative. No application or role is stored in localStorage.
type Dict = Record<string, any>;
const $ = <T extends HTMLElement = HTMLElement>(q: string) =>
  document.querySelector<T>(q);
const $$ = (q: string) => Array.from(document.querySelectorAll<HTMLElement>(q));
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const rub = (n: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
const date = (n: number) => new Date(n).toLocaleString("ru-RU");
const labels: Dict = {
  approved: "Одобрено",
  rejected: "Отказ",
  in_review: "На рассмотрении",
  needs_info: "Нужны сведения",
  technical_hold: "Ожидание источника",
  funded: "Выдано · симуляция",
  settled: "Погашено · симуляция",
  offer_pending: "Новые условия",
  offer_declined: "Условия отклонены",
};
const badge = (s: string) =>
  `<span class="status-badge status-${esc(s)}">${esc(labels[s] || s)}</span>`;
const screen = document.body.dataset.screen;
let sessionSummary: Dict = {};
let chatPending = false;
let detailTimer: ReturnType<typeof setInterval> | undefined;
let csrf = "",
  account: Dict,
  products: Dict[] = [],
  scenarios: Dict[] = [];
let attached = false;
let submissionKey = crypto.randomUUID();
let editApplication: Dict | null = null;
const errors: Dict = {
  SESSION_REQUIRED: "Сессия завершена. Войдите снова.",
  CSRF_REQUIRED: "Обновите страницу для восстановления сессии.",
  ASSESSMENT_CHANGED:
    "Изменились обязательства компании. Выполните расчёт заново и подтвердите новые условия.",
  APPLICATION_CHANGED: "Заявка уже изменена. Обновите страницу.",
  POLICY_BLOCKED:
    "Правила не позволяют одобрить эту заявку. Проверьте основания.",
  FINAL_APPLICATION: "Для этого состояния действие недоступно.",
  OFFER_POLICY_BLOCKED:
    "Предложенные условия не проходят обязательные проверки.",
  OFFER_CHANGED:
    "Нагрузка изменилась. Сотруднику нужно сформировать новый оффер.",
  OFFER_EXPIRED: "Время действия условий истекло. Запросите новый оффер.",
  COMPANY_INN_MISMATCH: "ИНН должен соответствовать выбранному демопрофилю.",
  DEMO_DISABLED: "Демовход отключён. Запустите сервер с DEMO_MODE=true.",
  INTERNAL_ERROR:
    "Не удалось выполнить действие. Повторите попытку; данные на экране сохранены.",
  REVIEW_RETRY_LATER: "Подождите 30 секунд перед повторной ИИ-оценкой.",
  AI_REVIEW_REQUIRED: "Дождитесь заключения по этой версии заявки.",
  ASSESSMENT_EXPIRED: "Время действия расчёта истекло. Выполните его заново.",
  CONTRACT_REQUIRED: "Сначала завершите учебное оформление договора.",
  CONTRACT_ALREADY_SIGNED: "Учебное оформление уже завершено.",
  OFFER_TERMS_REQUIRED: "Укажите сумму и срок альтернативных условий.",
};
function error(err: unknown) {
  const box = $("[data-error]")!;
  box.hidden = false;
  box.textContent = err instanceof Error ? err.message : String(err);
  box.scrollIntoView({ behavior: "smooth", block: "center" });
}
function toast(text: string) {
  const box = $(".toast")!;
  box.textContent = text;
  box.hidden = false;
  setTimeout(() => {
    box.hidden = true;
  }, 4500);
}
async function api(
  path: string,
  method = "GET",
  data?: unknown,
  headers: Dict = {},
): Promise<any> {
  const response = await fetch("/api/v1" + path, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
      ...headers,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  let result: Dict;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      "Сервис вернул некорректный ответ. Повторите действие; введённые данные сохранены на экране.",
    );
  }
  if (!response.ok) {
    if (response.status === 401 && screen !== "overview")
      location.assign("/cabinet/");
    const detail = result.detail;
    throw new Error(
      typeof detail === "string"
        ? errors[detail] || detail
        : "Проверьте введённые значения и лимиты выбранного продукта.",
    );
  }
  return result;
}
async function busy(button: HTMLButtonElement, task: () => Promise<void>) {
  const text = button.textContent;
  button.disabled = true;
  button.textContent = "Подождите…";
  $("[data-error]")!.hidden = true;
  try {
    await task();
  } catch (e) {
    error(e);
  } finally {
    button.disabled = false;
    button.textContent = text;
  }
}
function product(id: string): Dict {
  return products.find((p) => p.id === id)!;
}
function header(title: string, subtitle: string, extra = "") {
  return `<div class="product-heading"><div><p class="product-eyebrow">КРЕДИТНЫЙ КАБИНЕТ</p><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${extra}</div>`;
}
function table(items: Dict[]) {
  if (!items.length)
    return `<div class="product-card empty-state"><h2>Здесь появятся заявки</h2><p>Создайте заявку и проверьте весь путь до решения.</p>${account.role === "client" ? '<a href="/cabinet/new/" class="button button--primary">Новая заявка</a>' : ""}</div>`;
  return `<div class="product-card data-table-wrap"><table class="data-table"><thead><tr><th>Продукт и задача</th><th>Сумма</th><th>Срок / ставка</th><th>Риск</th><th>Статус</th><th>Дата</th></tr></thead><tbody>${items.map((a) => `<tr><td><a href="/cabinet/application/?id=${esc(a.id)}">${esc(product(a.data.product)?.name)}</a><span class="muted">${esc(a.data.goal.slice(0, 45))} · ${esc(a.data.inn)}</span></td><td>${rub(a.data.amount)}</td><td>${a.data.months} мес. · ${a.assessment.terms.rate}%</td><td>${esc({ low: "Низкий", high: "Повышенный", critical: "Критический", unknown: "Нет данных" }[a.assessment.risk as string])}</td><td>${badge(a.status)}</td><td>${date(a.created_at)}</td></tr>`).join("")}</tbody></table></div>`;
}
async function overview() {
  const listing = await api("/applications");
  const items = listing.items as Dict[];
  sessionSummary = listing.summary || sessionSummary;
  $("[data-count]")!.textContent = String(items.length);
  const active = items.filter((a) => ["approved", "funded"].includes(a.status));
  const stats = [
    ["Всего заявок", sessionSummary.total ?? items.length],
    [
      "На рассмотрении",
      (sessionSummary.counts?.in_review || 0) +
        (sessionSummary.counts?.technical_hold || 0),
    ],
    [
      "Нужны действия",
      (sessionSummary.counts?.needs_info || 0) +
        (sessionSummary.counts?.offer_pending || 0),
    ],
    [
      "Резерв обязательств",
      rub(
        sessionSummary.exposure ??
          active.reduce((n, a) => n + a.assessment.plan.exposure, 0),
      ),
    ],
  ];
  $("[data-overview]")!.innerHTML =
    header(
      account.role === "staff"
        ? "Пульс кредитного конвейера"
        : "Финансирование бизнеса",
      account.name,
    ) +
    `<div class="product-stats">${stats.map(([s, n]) => `<div class="product-stat"><small>${s}</small><strong>${n}</strong></div>`).join("")}</div>` +
    (account.role === "staff"
      ? `<section class="product-hero"><div><p class="product-eyebrow">РАБОЧЕЕ МЕСТО АНАЛИТИКА</p><h2>Данные, риски и решения — в одном окне</h2><p>Проверьте основания автоматического решения, уточните сведения и предложите альтернативные условия.</p><a href="/cabinet/bank/" class="button button--primary">Открыть очередь →</a></div></section>`
      : `<section class="product-hero"><div><p class="product-eyebrow">УМНОЕ ФИНАНСИРОВАНИЕ</p><h2>Посмотрите на бизнес<br />после кредита</h2><p>Сравните платёж и переплату, проверьте сезонность и узнайте, что будет, если выручка снизится.</p><a href="/cabinet/new/" class="button button--primary">Подобрать финансирование →</a></div><img src="/assets/business-credit.png" alt="" /></section>`) +
    `<div class="product-section-heading"><h2>Последние заявки</h2><a class="credit-text-link" href="/cabinet/applications/">Все заявки →</a></div>${table(items.slice(0, 5))}<div data-activity-feed></div>` +
    (account.role === "client"
      ? `<div class="product-section-heading"><h2>Продукты для вашей задачи</h2><span class="product-pill">ДЕМОНСТРАЦИОННЫЕ УСЛОВИЯ</span></div><div class="catalog-filter" role="group" aria-label="Категории финансирования"><button data-catalog-filter="all" aria-pressed="true">Все продукты</button>${[...new Set(products.map((p) => p.group))].map((group) => `<button data-catalog-filter="${esc(group)}" aria-pressed="false">${esc(group)}</button>`).join("")}</div><div class="catalog-grid">${products.map((p) => `<article class="catalog-card" data-product-group="${esc(p.group)}"><h3>${esc(p.name)}</h3><p>${esc(p.description)}</p><div class="catalog-rate">от ${p.rate}% <small>· до ${p.max_months} мес.</small></div><a href="/cabinet/new/?product=${p.id}">Рассчитать условия →</a></article>`).join("")}</div>`
      : "");
}
async function activityFeed() {
  const target = $("[data-activity-feed]");
  if (!target) return;
  const data = await api("/feed");
  target.innerHTML = `<div class="product-section-heading"><h2>${account.role === "staff" ? "Лента кредитного конвейера" : "События вашей компании"}</h2><span class="product-pill">ОБНОВЛЯЕТСЯ ПО ВАШИМ ЗАЯВКАМ</span></div><div class="product-card">${
    data.items
      .slice(0, 5)
      .map(
        (e: Dict) =>
          `<a class="feed-event" href="/cabinet/application/?id=${esc(e.application_id)}"><span class="feed-marker">↗</span><span><b>${esc(e.comment)}</b><small>${esc(e.actor)} · ${date(e.at)} · ${esc(e.company_inn)}</small></span><span class="feed-arrow">→</span></a>`,
      )
      .join("") ||
    '<p class="field-help">После отправки заявки здесь появятся результаты проверок, решения и запросы банка.</p>'
  }</div>`;
}

function bindCatalogFilters() {
  $$("[data-catalog-filter]").forEach(
    (button) =>
      (button.onclick = () => {
        const group = button.dataset.catalogFilter;
        $$("[data-catalog-filter]").forEach((el) =>
          el.setAttribute("aria-pressed", String(el === button)),
        );
        $$("[data-product-group]").forEach(
          (card) =>
            (card.hidden =
              group !== "all" && card.dataset.productGroup !== group),
        );
      }),
  );
}
function graph(base: Dict, stress: Dict, without?: Dict) {
  const all = [...base.rows, ...stress.rows, ...(without?.rows || [])].map(
    (r) => r.balance,
  );
  const min = Math.min(0, ...all),
    max = Math.max(1, ...all),
    range = max - min;
  const y = (v: number) => 170 - ((v - min) / range) * 145;
  const points = (rows: Dict[]) =>
    rows
      .map(
        (r, i) =>
          `${30 + (i / Math.max(1, rows.length - 1)) * 770},${y(r.balance)}`,
      )
      .join(" ");
  return `<div class="chart-legend"><span>Базовый сценарий</span><span>Стресс-сценарий</span><span>Без нового проекта</span></div><div class="chart-wrap"><svg viewBox="0 0 830 200" class="cash-chart" role="img" aria-label="Денежный остаток по месяцам: базовый и стресс-сценарий"><line x1="30" y1="${y(0)}" x2="800" y2="${y(0)}" stroke="#c4c9d2" stroke-dasharray="4 4"/><text x="30" y="15" fill="#858b95" font-size="10">Максимум ${rub(max)}</text>${without ? `<polyline class="without-line" fill="none" stroke="#9aa1ad" stroke-width="2" points="${points(without.rows)}"/>` : ""}<polyline fill="none" stroke="#2b837d" stroke-width="2.5" points="${points(base.rows)}"/><polyline fill="none" stroke="#e25d4e" stroke-width="2.5" points="${points(stress.rows)}"/></svg><div class="chart-bottom"><span>1-й месяц</span><span>${base.rows.length}-й месяц</span></div></div>`;
}
function reviewHTML(review: Dict, retry = false) {
  const names: Dict = {
    approve: "Рекомендует одобрить по имеющимся данным",
    manual_review: "Рекомендует ручное рассмотрение",
    decline: "Рекомендует отказ",
    request_info: "Нужны сведения",
    wait_source: "Нужно дождаться источника",
  };
  return `${retry && review.mode !== "llm" ? '<button type="button" class="credit-text-link" data-review-retry>Повторить ИИ-оценку</button>' : ""}<div class="review-heading"><h2>Заключение по данным заявки</h2><span class="review-model">${esc(review.mode === "llm" ? review.model : "Расчёт по правилам · ИИ недоступен")}</span></div><p class="review-text">${esc(review.text)}</p>${review.text_origin==="server_grounded"?'<p class="field-help">Показано проверенное резюме. Числа в основаниях подставлены из расчёта сервера.</p>':""}<p class="field-help">${esc(names[review.recommendation] || "Консультационное заключение")}</p>${(review.findings || []).map((f: Dict) => `<div class="review-finding">${esc(f.text)}<small>Основания: ${esc(f.references.join(" · "))}</small></div>`).join("")}<details><summary>Версия и привязка заключения</summary><p class="field-help">${esc(review.policy_version || "")} · ${esc(review.catalog_version || "")}<br />SHA-256 фактов: ${esc(review.facts_hash || "")}<br />${esc(review.decision_authority || "")}</p></details>`;
}
function sourceFacts(check: Dict) {
  const labels: Dict = {
    active: "Бизнес действует",
    inn: "ИНН",
    legal_form: "Правовая форма",
    registered_months_ago: "Возраст по реестру, мес.",
    okved: "ОКВЭД",
    overdue_days: "Дней просрочки",
    monthly_debt: "Платежи по обязательствам, ₽",
    active_loans: "Действующих договоров",
    history_months: "История, месяцев",
    tax_debt: "Налоговая задолженность, ₽",
    mass_address: "Массовый адрес",
  };
  return `<details><summary>Данные источника</summary>${Object.entries(
    check.data || {},
  )
    .filter(([key]) => labels[key])
    .map(
      ([key, value]) =>
        `<div class="live-summary-row"><span>${esc(labels[key])}</span><b>${esc(typeof value === "boolean" ? (value ? "Да" : "Нет") : value)}</b></div>`,
    )
    .join("")}</details>`;
}
function documentHTML(a: Dict) {
  return `<section class="product-card"><span class="product-step">ДОКУМЕНТЫ И СВЕРКА</span><h2>Данные, которые видит банк</h2>${(a.documents || []).map((doc: Dict) => `<details class="contract-document"><summary>${esc(doc.name)} · синтетический пакет</summary><p class="field-help">Источник: ${esc(doc.source)} · ${esc(doc.version)}<br />SHA-256: ${esc(doc.id)}</p><pre>${esc(JSON.stringify(doc.content, null, 2))}</pre></details>`).join("") || "<p>Обязательный пакет ещё не приложен.</p>"}${(a.conflicts || []).map((c: Dict) => `<div class="risk-rule block">${esc(c.field)}: в анкете ${esc(c.declared)}, в документе ${esc(c.document_value)}<small>Документ ${esc(c.document_id.slice(0, 16))}…</small></div>`).join("")}</section>`;
}
function analysis(a: Dict, alternatives = false) {
  return `<section class="product-card"><div class="product-section-heading" style="margin-top:0"><h2>Предварительный результат</h2>${alternatives ? `<span class="status-badge">По правилам: ${a.status === "approved" ? "допустимо" : esc(labels[a.status])}</span>` : badge(a.status)}</div><div class="result-summary"><div><small>Ставка · демо</small><strong>${a.terms.rate}%</strong></div><div><small>Максимальный платёж</small><strong>${rub(a.plan.payment)}</strong></div><div><small>Стоимость финансирования</small><strong>${rub(a.plan.cost)}</strong></div><div><small>Скоринг · не вероятность</small><strong>${a.score ?? "—"} <small>/ 1000</small></strong></div></div><p class="field-help">${esc(a.plan.note)}</p><div class="checks-grid">${a.checks.map((c: Dict) => `<div class="check-card"><b>${esc(c.source)} · ${c.status === "pass" ? "✓" : c.status === "unknown" ? "…" : "!"}</b><p>${esc(c.summary)}</p><small>МОК / СИНТЕТИЧЕСКИЕ ДАННЫЕ</small>${sourceFacts(c)}</div>`).join("")}</div>${a.rules.length ? a.rules.map((r: Dict) => `<div class="risk-rule ${esc(r.severity)}">${esc(r.text)}<small>${esc(r.code)} · ${esc(r.source)}</small></div>`).join("") : '<div class="product-note">Блокирующих факторов не найдено. После подтверждения сервер ещё раз проверит нагрузку и условия.</div>'}<p class="field-help" style="margin-top:18px">Версия правил: ${esc(a.policy_version)} · Каталог: ${esc(a.catalog_version)} · Учтено активных обязательств: ${a.portfolio.count}, платёж ${rub(a.portfolio.payment)} / мес.</p></section>
 <section class="product-card"><span class="product-step">БИЗНЕС ПОСЛЕ ФИНАНСИРОВАНИЯ</span><h2>Выдержит ли денежный поток?</h2>${graph(a.base, a.stress, a.without_financing)}<div class="result-summary"><div><small>Минимум · базовый</small><strong>${rub(a.base.minimum)}</strong></div><div><small>Минимум · стресс</small><strong>${rub(a.stress.minimum)}</strong></div><div><small>Дефицит · базовый</small><strong>${a.base.deficit_month ? "Месяц " + a.base.deficit_month : "Нет"}</strong></div><div><small>Дефицит · стресс</small><strong>${a.stress.deficit_month ? "Месяц " + a.stress.deficit_month : "Нет"}</strong></div></div><details><summary>Допущения и помесячный расчёт</summary>${a.assumptions.map((x: string) => `<p>${esc(x)}</p>`).join("")}<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Месяц</th><th>Выручка</th><th>Платёж</th><th>Остаток</th><th>Остаток в стрессе</th></tr></thead><tbody>${a.base.rows.map((r: Dict, i: number) => `<tr><td>${r.month}</td><td>${rub(r.revenue)}</td><td>${rub(r.payment)}</td><td>${rub(r.balance)}</td><td>${rub(a.stress.rows[i].balance)}</td></tr>`).join("")}</tbody></table></div></details></section>
 <section class="product-card"><span class="product-step">СРАВНЕНИЕ УСЛОВИЙ</span><h2>Есть ли подходящие альтернативы?</h2><div class="alternatives-grid">${a.alternatives.map((alt: Dict, i: number) => `<article class="alternative"><span class="product-pill">${alt.stress_feasible ? "Проходит оба сценария" : alt.feasible ? "Проходит базовый" : "Не проходит расчёт"}</span><h3>${esc(alt.name || "Другие условия")}</h3><b>${rub(alt.amount)}</b><dl><div><dt>Срок / ставка</dt><dd>${alt.months} мес. / ${alt.rate}%</dd></div><div><dt>Макс. платёж</dt><dd>${rub(alt.payment)}</dd></div><div><dt>Стоимость</dt><dd>${rub(alt.cost)}</dd></div><div><dt>Остаток · стресс</dt><dd>${rub(alt.minimum)}</dd></div></dl><p>${esc(alt.reason)}</p>${alt.same_budget && alt.cost_delta < 0 ? `<p class="alternative-delta">Стоимость ниже на ${rub(-alt.cost_delta)} при том же бюджете</p>` : ""}${alt.blocked_reasons?.length ? `<p>${esc(alt.blocked_reasons.join("; "))}</p>` : ""}${alternatives ? `<button class="credit-text-link" data-alternative="${i}">Пересчитать этот вариант →</button>` : ""}</article>`).join("") || "<p>В пределах продукта нет отличающихся вариантов.</p>"}</div><p class="field-help" style="margin-top:16px">Альтернативы не отменяют ограничения реестров и документов. Выбор варианта требует нового расчёта и подтверждения.</p></section>
 ${documentHTML(a)}<section class="product-card"><span class="product-step">ПРОИСХОЖДЕНИЕ ДАННЫХ</span><h2>На чём основан результат</h2><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Показатель</th><th>Значение</th><th>Источник</th><th>Подтверждение</th></tr></thead><tbody>${a.evidence.map((e: Dict) => `<tr><td>${esc(e.field)}</td><td>${rub(e.value)}</td><td>${esc(e.source)}</td><td>${e.confirmed ? "✓ Есть" : "Нет"}</td></tr>`).join("")}</tbody></table></div></section>`;
}
function readForm(): Dict {
  const data = Object.fromEntries(
    new FormData($<HTMLFormElement>("[data-application-form]")!).entries(),
  ) as Dict;
  for (const key of [
    "amount",
    "months",
    "revenue",
    "expenses",
    "taxes",
    "debt",
    "cash",
    "age",
    "stress_drop",
    "delay_months",
    "refinanced_payment",
  ])
    data[key] = Number(data[key]);
  delete data.test_factors;
  return {
    ...data,
    test_factors: Array.from(
      $<HTMLFormElement>(
        "[data-application-form]",
      )!.querySelectorAll<HTMLInputElement>('[name="test_factors"]:checked'),
    ).map((el) => el.value),
    documents_attached: attached,
  };
}
function field(name: string): HTMLInputElement | HTMLSelectElement {
  return $(`[name="${name}"]`)!;
}
function syncProduct() {
  const p = product(field("product").value);
  $("[data-product-description]")!.textContent =
    p.description +
    " · Базовая ставка " +
    p.rate +
    "%, корректируется по риск-политике.";
  for (const key of ["amount", "months"]) {
    const input = field(key) as HTMLInputElement;
    input.min = String(p["min_" + key]);
    input.max = String(p["max_" + key]);
    input.value = String(
      Math.max(
        Number(input.min),
        Math.min(Number(input.value), Number(input.max)),
      ),
    );
  }
  $("[data-document-names]")!.textContent = p.document_names.join(" · ");
  $("[data-refinance]")!.hidden = p.id !== "refinance";
}
function invalidate() {
  $("[data-assessment]")!.hidden = true;
  submissionKey = crypto.randomUUID();
}
async function awaitReview(id: string, retry = false): Promise<Dict> {
  let result = await api(
    "/assessments/" + id + "/review" + (retry ? "?retry=true" : ""),
    "POST",
    {},
  );
  const deadline = Date.now() + 210000;
  while (
    ["queued", "running"].includes(result.review_state) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    result = await api("/assessments/" + id);
  }
  if (!["done", "unavailable"].includes(result.review_state))
    throw new Error(
      "Заключение ещё формируется. Сохранённый расчёт можно повторно проверить позже.",
    );
  return result;
}
async function newApplication() {
  if (account.role !== "client") {
    location.replace("/cabinet/bank/");
    return;
  }
  const form = $<HTMLFormElement>("[data-application-form]")!;
  form.noValidate = true;
  const groups = [...new Set(products.map((p) => p.group))];
  field("product").innerHTML = groups
    .map(
      (group) =>
        `<optgroup label="${esc(group)}">${products
          .filter((p) => p.group === group)
          .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`)
          .join("")}</optgroup>`,
    )
    .join("");
  field("scenario").innerHTML = scenarios
    .map((s) => `<option value="${s.id}">${esc(s.name)}</option>`)
    .join("");
  $("[data-factors]")!.innerHTML = scenarios
    .filter((s) => s.id !== "clean")
    .map(
      (s) =>
        `<label><input type="checkbox" name="test_factors" value="${s.id}" /><span>${esc(s.name)}</span></label>`,
    )
    .join("");
  $("[data-summary-company]")!.textContent = account.name;
  let saved = await api("/draft");
  const params = new URLSearchParams(location.search);
  const edit = params.get("edit");
  let resumeAssessment: Dict | null = null;
  if (params.get("assessment")) {
    resumeAssessment = await api(
      "/assessments/" +
        encodeURIComponent(params.get("assessment")!) +
        "?include_result=true",
    );
    saved = resumeAssessment!.data;
  }
  if (edit) {
    editApplication = await api("/applications/" + encodeURIComponent(edit));
    if (editApplication!.status !== "needs_info")
      throw new Error("Уточнение доступно по запросу сотрудника.");
    saved = editApplication!.data;
  }
  if (saved) {
    for (const [key, value] of Object.entries(saved)) {
      if (key === "test_factors") continue;
      const input = $<HTMLInputElement>(`[name="${key}"]`);
      if (input) input.value = String(value);
    }
    for (const input of form.querySelectorAll<HTMLInputElement>(
      '[name="test_factors"]',
    ))
      input.checked = (saved.test_factors || []).includes(input.value);
    attached = Boolean(saved.documents_attached);
  }
  field("inn").value = account.inn;
  const selected = params.get("product");
  if (
    !resumeAssessment &&
    selected &&
    products.some((p) => p.id === selected)
  ) {
    field("product").value = selected;
    attached = false;
  }
  syncProduct();
  let step = 0,
    maxStep = 0,
    generation = 0;
  const renderSummary = () => {
    const p = product(field("product").value);
    $("[data-live-summary]")!.innerHTML =
      `<p class="live-summary-product">${esc(p.name)}</p><div class="live-summary-row"><span>Сумма / стоимость</span><b>${rub(Number(field("amount").value))}</b></div><div class="live-summary-row"><span>Срок</span><b>${esc(field("months").value)} мес.</b></div><div class="live-summary-row"><span>Базовая ставка</span><b>от ${p.rate}%</b></div><div class="live-summary-row"><span>Документы</span><b>${attached ? "Приложены" : "Нужен пакет"}</b></div>`;
  };
  const attachment = () => {
    $("[data-attach]")!.hidden = attached;
    $("[data-attached]")!.hidden = !attached;
    renderSummary();
  };
  const scenario = () => {
    $("[data-scenario-description]")!.textContent =
      scenarios.find((s) => s.id === field("scenario").value)?.description ||
      "";
  };
  const validateStep = () => {
    for (const el of form.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >(
      `[data-wizard-step="${step}"] input,[data-wizard-step="${step}"] select,[data-wizard-step="${step}"] textarea`,
    )) {
      if (!el.reportValidity()) return false;
    }
    return true;
  };
  const showStep = (next: number) => {
    step = next;
    maxStep = Math.max(maxStep, step);
    $$("[data-wizard-step]").forEach(
      (el) => (el.hidden = Number(el.dataset.wizardStep) !== step),
    );
    $$("[data-wizard-go]").forEach((el) => {
      const index = Number(el.dataset.wizardGo);
      (el as HTMLButtonElement).disabled = index > maxStep;
      el.classList.toggle("is-done", index < step);
      if (index === step) el.setAttribute("aria-current", "step");
      else el.removeAttribute("aria-current");
    });
    $("[data-wizard-back]")!.hidden = step === 0;
    $("[data-wizard-next]")!.hidden = step === 3;
    $("[data-calculate]")!.hidden = step !== 3;
    $(".application-stepper")!.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };
  $("[data-wizard-next]")!.onclick = () => {
    if (validateStep()) showStep(Math.min(3, step + 1));
  };
  $("[data-wizard-back]")!.onclick = () => showStep(Math.max(0, step - 1));
  $$("[data-wizard-go]").forEach(
    (el) =>
      (el.onclick = () => {
        const next = Number(el.dataset.wizardGo);
        if (next <= step || validateStep()) showStep(next);
      }),
  );
  const invalidateResult = () => {
    resumeAssessment = null;
    const url = new URL(location.href);
    url.searchParams.delete("assessment");
    history.replaceState(null, "", url);
    generation++;
    invalidate();
    renderSummary();
  };
  form.addEventListener("input", invalidateResult);
  field("product").addEventListener("change", () => {
    syncProduct();
    attached = false;
    attachment();
    invalidateResult();
    $("[data-document-preview]")!.innerHTML = "";
  });
  field("scenario").addEventListener("change", () => {
    scenario();
    attached = false;
    attachment();
    $("[data-document-preview]")!.innerHTML = "";
  });
  $("[data-attach]")!.onclick = (e) =>
    busy(e.currentTarget as HTMLButtonElement, async () => {
      const result = await api("/documents/preview", "POST", readForm());
      attached = true;
      attachment();
      invalidateResult();
      $("[data-document-preview]")!.innerHTML = result.documents
        .map(
          (d: Dict) =>
            `<div class="document-preview-item">✓ ${esc(d.name)}<br /><small>SHA-256: ${esc(d.id.slice(0, 16))}…</small></div>`,
        )
        .join("");
    });
  $("[data-save]")!.onclick = (e) =>
    busy(e.currentTarget as HTMLButtonElement, async () => {
      if (!validateStep()) return;
      await api("/draft", "PUT", readForm());
      toast("Черновик сохранён на сервере");
    });
  attachment();
  scenario();
  form.onsubmit = (e) => {
    e.preventDefault();
    if (step < 3) {
      if (validateStep()) showStep(step + 1);
      return;
    }
    if (!validateStep()) return;
    busy($<HTMLButtonElement>("[data-calculate]")!, async () => {
      const run = ++generation;
      const data = readForm();
      await api("/draft", "PUT", data);
      const assessment = resumeAssessment
        ? {
            ...resumeAssessment.result,
            assessment_id: resumeAssessment.assessment_id,
            fingerprint: resumeAssessment.fingerprint,
          }
        : await api("/assessments", "POST", data);
      resumeAssessment = null;
      const savedUrl = new URL(location.href);
      savedUrl.searchParams.set("assessment", assessment.assessment_id);
      history.replaceState(null, "", savedUrl);
      if (run !== generation) return;
      submissionKey = crypto.randomUUID();
      const box = $("[data-assessment]")!;
      box.hidden = false;
      box.innerHTML = `<section class="product-card" data-review-panel><div class="review-heading"><h2>Заключение ИИ по заявке</h2><span class="review-model">Qwen / CometAPI</span></div><div class="review-loading">Сопоставляем проверки, обязательства и прогноз. Расчёт уже доступен ниже.</div></section>${analysis(assessment, true)}<section class="product-card"><h2>${editApplication ? "Ответить на запрос сотрудника" : "Проверьте и подтвердите условия"}</h2><div class="result-summary"><div><small>Продукт</small><strong style="font-size:16px">${esc(product(data.product).name)}</strong></div><div><small>Сумма</small><strong>${rub(data.amount)}</strong></div><div><small>Срок</small><strong>${data.months} мес.</strong></div><div><small>Ставка</small><strong>${assessment.terms.rate}%</strong></div></div><label class="consent-row"><input type="checkbox" data-consent disabled /><span>Подтверждаю эту версию данных, сумму, срок и ставку. Ознакомился с прогнозом, заключением и ограничениями модели.</span></label><button class="button button--primary" data-submit-application disabled>Ожидаем заключение ИИ…</button></section>`;
      box.querySelectorAll<HTMLButtonElement>("[data-alternative]").forEach(
        (button) =>
          (button.onclick = () => {
            const alt =
              assessment.alternatives[Number(button.dataset.alternative)];
            const previous = product(field("product").value),
              target = product(alt.product);
            field("product").value = alt.product;
            syncProduct();
            field("amount").value = String(alt.amount);
            field("months").value = String(alt.months);
            if (
              !target.documents.every((kind: string) =>
                previous.documents.includes(kind),
              )
            )
              attached = false;
            attachment();
            invalidateResult();
            if (!attached) {
              showStep(2);
              toast("Для выбранного продукта нужен новый пакет документов.");
            } else {
              showStep(3);
              form.requestSubmit();
            }
          }),
      );
      box.scrollIntoView({ behavior: "smooth" });
      const reviewed = await awaitReview(assessment.assessment_id);
      if (run !== generation) return;
      if (!["done", "unavailable"].includes(reviewed.review_state))
        throw new Error("Заключение ещё формируется. Повторите расчёт позже.");
      assessment.ai_review = reviewed.ai_review;
      $("[data-review-panel]")!.innerHTML = reviewHTML(
        reviewed.ai_review,
        true,
      );
      const consent = $<HTMLInputElement>("[data-consent]")!;
      consent.disabled = false;
      const submit = $<HTMLButtonElement>("[data-submit-application]")!;
      submit.disabled = false;
      submit.textContent = editApplication
        ? "Отправить уточнение →"
        : "Отправить подтверждённую заявку →";
      const bindRetry = () => {
        const button = $<HTMLButtonElement>("[data-review-retry]");
        if (!button) return;
        button.onclick = () =>
          busy(button, async () => {
            consent.checked = false;
            consent.disabled = true;
            submit.disabled = true;
            try {
              const retried = await awaitReview(assessment.assessment_id, true);
              if (run !== generation) return;
              assessment.ai_review = retried.ai_review;
              $("[data-review-panel]")!.innerHTML = reviewHTML(
                retried.ai_review,
                true,
              );
              bindRetry();
            } finally {
              consent.disabled = false;
              submit.disabled = false;
            }
          });
      };
      bindRetry();
      submit.onclick = () =>
        busy(submit, async () => {
          if (!consent.checked)
            throw new Error("Подтвердите согласие с данными и условиями.");
          const row = editApplication
            ? await api(
                "/applications/" + editApplication.id + "/reply",
                "POST",
                {
                  version: editApplication.version,
                  data,
                  assessment_id: assessment.assessment_id,
                  comment: "Клиент подтвердил новую версию данных и заключение",
                },
              )
            : await api(
                "/applications",
                "POST",
                {
                  assessment_id: assessment.assessment_id,
                  data,
                  fingerprint: assessment.fingerprint,
                  consent: true,
                },
                { "Idempotency-Key": submissionKey },
              );
          location.assign("/cabinet/application/?id=" + row.id);
        });
    });
  };
  if (resumeAssessment) {
    showStep(3);
    form.requestSubmit();
  }
}

async function list() {
  if (screen === "bank" && account.role !== "staff")
    throw new Error("Рабочая очередь доступна сотруднику банка.");
  const root = $("[data-list]")!;
  root.innerHTML =
    header(
      account.role === "staff" ? "Очередь кредитных заявок" : "Мои заявки",
      "Статусы и данные синхронизированы с сервером",
      account.role === "client"
        ? '<a href="/cabinet/new/" class="button button--primary">Новая заявка</a>'
        : "",
    ) +
    `<form class="filter-bar"><input name="q" aria-label="Поиск заявки" placeholder="Цель, ИНН или номер заявки"/><select name="status" aria-label="Статус заявки"><option value="all">Все статусы</option>${Object.entries(
      labels,
    )
      .map(([k, v]) => `<option value="${k}">${v}</option>`)
      .join(
        "",
      )}</select><button class="button button--secondary">Найти</button></form><div data-table></div>`;
  let offset = 0,
    total = 0,
    generation = 0;
  root.insertAdjacentHTML(
    "beforeend",
    '<div class="filter-bar"><button class="button button--secondary" data-page-prev>← Назад</button><span data-page-caption></span><button class="button button--secondary" data-page-next>Далее →</button><button class="credit-text-link" data-refresh-list>Обновить</button></div>',
  );
  const load = async () => {
    const run = ++generation;
    const query = new URLSearchParams(
      new FormData(root.querySelector("form")!) as any,
    );
    query.set("offset", String(offset));
    query.set("limit", "25");
    const result = await api("/applications?" + query);
    if (run !== generation) return;
    total = result.total;
    sessionSummary = result.summary;
    $("[data-table]")!.innerHTML = table(result.items);
    $("[data-count]")!.textContent = String(result.summary.total);
    $("[data-page-caption]")!.textContent = total
      ? `${offset + 1}–${Math.min(offset + 25, total)} из ${total}`
      : "Нет заявок";
    ($("[data-page-prev]") as HTMLButtonElement).disabled = offset === 0;
    ($("[data-page-next]") as HTMLButtonElement).disabled = !result.has_more;
  };
  root.querySelector("form")!.onsubmit = (e) => {
    e.preventDefault();
    offset = 0;
    load().catch(error);
  };
  $("[data-page-prev]")!.onclick = () => {
    offset = Math.max(0, offset - 25);
    load().catch(error);
  };
  $("[data-page-next]")!.onclick = () => {
    offset += 25;
    load().catch(error);
  };
  $("[data-refresh-list]")!.onclick = () => load().catch(error);
  await load();
  setInterval(() => {
    if (document.visibilityState === "visible") load().catch(() => {});
  }, 15000);
}
function revisionHTML(revisions: Dict[]) {
  const names: Dict = {
    amount: "Сумма",
    months: "Срок",
    product: "Продукт",
    scenario: "Тестовый пакет",
    documents_attached: "Документы",
    revenue: "Выручка",
    expenses: "Расходы",
    debt: "Внешние платежи",
    cash: "Остаток",
    test_factors: "Факторы",
  };
  return `<section class="product-card"><span class="product-step">ПРОВЕРЯЕМАЯ ИСТОРИЯ</span><h2>Версии данных и решений</h2>${revisions
    .map((r: Dict, i: number) => {
      const old = i ? revisions[i - 1].snapshot.data : {};
      const values = r.snapshot.data;
      const changed = Object.keys(values).filter(
        (k) => JSON.stringify(old[k]) !== JSON.stringify(values[k]),
      );
      return `<details class="revision-row"><summary><span>Версия ${r.version} · ${esc(labels[r.snapshot.status] || r.snapshot.status)}</span><small>${date(r.created_at)}</small></summary><div class="revision-diff">${changed.map((k) => `<div><b>${esc(names[k] || k)}</b><br />${i ? esc(JSON.stringify(old[k])) + " → " : ""}${esc(JSON.stringify(values[k]))}</div>`).join("") || "<p>Данные не менялись. Изменено состояние или выполнено действие.</p>"}</div><p class="field-help">Ставка ${r.snapshot.assessment.terms.rate}% · Правила ${esc(r.snapshot.assessment.policy_version)} · ИИ: ${esc(r.snapshot.assessment.ai_review?.model || "Отдельного заключения этой версии нет")}</p></details>`;
    })
    .join("")}</section>`;
}
function nextStep(a: Dict) {
  const descriptions: Dict = {
    approved: [
      "Финансирование одобрено",
      a.assessment.contract?.success
        ? "Учебные документы оформлены. Сотрудник может запустить симуляцию выдачи."
        : "Следующий этап — учебное оформление договора. Средства ещё не перечислены.",
    ],
    in_review: [
      "Заявка на рассмотрении",
      "Аналитик проверит отмеченные факторы и может запросить уточнения.",
    ],
    needs_info: [
      "Банку нужны сведения",
      "Откройте запрос в истории, дополните данные и подтвердите новую версию.",
    ],
    rejected: [
      "По текущим условиям получен отказ",
      "Причины указаны ниже. Можно сравнить альтернативы и создать новую заявку.",
    ],
    technical_hold: [
      "Ожидаем ответ источника",
      "Отсутствие данных не считается положительной проверкой. Доступно повторное рассмотрение.",
    ],
    offer_pending: [
      "Предложены другие условия",
      "Проверьте сумму, срок, стоимость и подтвердите отдельное согласие.",
    ],
    funded: [
      "Выдача смоделирована",
      "Обязательство учтено в портфеле и влияет на следующие заявки. Реальные деньги не переводились.",
    ],
    settled: [
      "Обязательство погашено в симуляции",
      "Резерв освобождён. История и предыдущие решения сохранены.",
    ],
  };
  const info = descriptions[a.status] || [
    "Заявка завершена",
    "Результат и история доступны ниже.",
  ];
  return `<div class="application-next-step"><div><h3>${esc(info[0])}</h3><p>${esc(info[1])}</p></div>${account.role === "client" && a.status === "rejected" ? '<a class="button button--secondary" href="/cabinet/new/">Новая заявка</a>' : ""}</div>`;
}
async function detail() {
  if (detailTimer) clearInterval(detailTimer);
  const id = new URLSearchParams(location.search).get("id");
  if (!id) throw new Error("Не указан номер заявки.");
  const a = await api("/applications/" + encodeURIComponent(id));
  const canReview = ["in_review", "needs_info", "technical_hold"].includes(
    a.status,
  );
  const root = $("[data-detail]")!;
  root.innerHTML =
    `<a class="credit-back" href="/cabinet/applications/">← Все заявки</a>` +
    header(
      product(a.data.product).name,
      `${a.data.inn} · ${rub(a.data.amount)} · ${a.data.months} мес.`,
      badge(a.status),
    ) +
    `<div class="detail-columns"><div><section class="product-card"><span class="product-step">ЗАКЛЮЧЕНИЕ ПОМОЩНИКА</span>${a.assessment.ai_review ? reviewHTML(a.assessment.ai_review) : '<p data-explanation>Заключение этой версии запрашивается…</p><small data-explanation-mode class="field-help"></small>'}</section>${analysis({ ...a.assessment, status: a.status })}${a.status === "offer_pending" ? `<section class="product-card"><h2>Банк предложил новые условия</h2><p>${rub(a.assessment.offer.data.amount)} · ${a.assessment.offer.data.months} мес. · ${a.assessment.offer.assessment.terms.rate}%</p><p>Платёж ${rub(a.assessment.offer.assessment.plan.payment)} · стоимость ${rub(a.assessment.offer.assessment.plan.cost)}</p><p class="field-help">Срок действия: ${date(a.assessment.offer.expires * 1000)}</p>${account.role === "client" ? '<div class="product-form-actions"><button class="button button--primary" data-accept="true">Согласиться с условиями</button><button class="button button--secondary" data-accept="false">Отклонить</button></div>' : ""}</section>` : ""}${a.assessment.disbursement ? `<section class="product-card"><h2>Симуляция выплаты</h2><p>${esc(a.assessment.disbursement.message)}</p><p class="field-help">${esc(a.assessment.disbursement.reference)}</p></section>` : ""}</div><aside><section class="product-card"><h3>Движение заявки</h3><ol class="event-list">${a.events.map((e: Dict) => `<li><b>${esc(e.actor)}</b><p>${esc(e.comment)}</p><small>${date(e.at)} · ${esc(e.action)}</small></li>`).join("")}</ol><p class="field-help">Версия ${a.version} · ${esc(a.id)}</p></section>${account.role === "client" && a.status === "needs_info" ? `<section class="product-card"><h3>Нужны уточнения</h3><p>Откройте данные заявки, внесите изменения и подтвердите новую версию.</p><a class="button button--primary" href="/cabinet/new/?edit=${esc(id)}">Ответить на запрос →</a></section>` : ""}${account.role === "staff" ? `<section class="product-card"><h3>Действия аналитика</h3><div class="action-controls"><label>Основание действия<textarea data-comment rows="3" minlength="10" placeholder="Обязательный комментарий, от 10 символов"></textarea></label>${canReview ? `<button class="button button--primary" data-action="approve">Одобрить по результатам проверки</button><button class="button button--secondary" data-action="request_info">Запросить уточнение</button><button class="button button--secondary" data-action="recheck">Повторить проверки</button><button class="button button--secondary" data-action="reject">Отказать</button><hr /><label>Альтернативная сумма, ₽<input data-offer-amount type="number" value="${a.data.amount}" /></label><label>Срок, месяцев<input data-offer-months type="number" value="${a.data.months}" /></label><button class="button button--secondary" data-action="offer">Предложить новые условия</button>` : ""}${a.status === "approved" && !a.assessment.contract?.success ? `<button class="button button--primary" data-action="sign">Оформить учебный договор</button><button class="button button--secondary" data-action="sign" data-failure>Симулировать сбой оформления</button>` : ""}${a.status === "approved" && a.assessment.contract?.success && product(a.data.product).kind !== "guarantee" ? `<button class="button button--primary" data-action="pay">Симулировать выдачу</button><button class="button button--secondary" data-action="pay" data-failure>Симулировать сбой выплаты</button>` : ""}${["approved", "funded"].includes(a.status) ? '<button class="button button--secondary" data-action="settle">Симулировать погашение</button>' : ""}</div></section>` : ""}<a href="/cabinet/assistant/?application=${esc(id)}" class="button button--secondary">Объяснить результат с ИИ ↗</a></aside></div>`;
  if (!a.assessment.ai_review)
    api("/applications/" + id + "/explanation", "POST", {})
      .then((answer) => {
        const box = $("[data-explanation]");
        if (box) {
          box.textContent = answer.text;
          $("[data-explanation-mode]")!.textContent =
            answer.mode === "llm"
              ? answer.model + " · открытые веса"
              : answer.mode === "facts" ? "Резюме по данным расчёта" : "Помощник по правилам · LLM недоступна";
        }
      })
      .catch(() => {
        const box = $("[data-explanation]");
        if (box)
          box.textContent =
            "Объяснение временно недоступно. Проверяемые основания приведены ниже.";
      });
  root
    .querySelector(".detail-columns > div")!
    .insertAdjacentHTML(
      "beforeend",
      revisionHTML(await api("/applications/" + id + "/revisions")),
    );
  if (a.assessment.contract)
    root
      .querySelector(".detail-columns > div")!
      .insertAdjacentHTML(
        "beforeend",
        `<section class="product-card"><h2>Учебное оформление</h2><p>${esc(a.assessment.contract.message)}</p><p class="field-help">Хеш документа: ${esc(a.assessment.contract.document_hash)}</p></section>`,
      );
  root.insertAdjacentHTML("afterbegin", nextStep(a));
  root.insertAdjacentHTML(
    "afterbegin",
    '<div class="product-note" data-app-update hidden>Заявка изменилась в другой сессии. <button class="credit-text-link" data-refresh-app>Загрузить новую версию</button></div>',
  );
  $("[data-refresh-app]")!.onclick = () => detail().catch(error);
  detailTimer = setInterval(async () => {
    if (document.visibilityState !== "visible") return;
    try {
      const state = await api("/applications/" + id + "/state");
      if (state.version !== a.version) {
        const comment = $<HTMLTextAreaElement>("[data-comment]")?.value.trim();
        if (comment) $("[data-app-update]")!.hidden = false;
        else await detail();
      }
    } catch {
      /* the next explicit action reports session/network failures */
    }
  }, 12000);
  root.querySelectorAll<HTMLButtonElement>("[data-action]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          const comment =
            $<HTMLTextAreaElement>("[data-comment]")!.value.trim();
          if (comment.length < 10)
            throw new Error(
              "Добавьте основание действия — минимум 10 символов.",
            );
          const payload: Dict = {
            version: a.version,
            action: b.dataset.action,
            comment,
            simulate_failure: b.hasAttribute("data-failure"),
          };
          if (b.dataset.action === "offer") {
            payload.amount = Number(
              $<HTMLInputElement>("[data-offer-amount]")!.value,
            );
            payload.months = Number(
              $<HTMLInputElement>("[data-offer-months]")!.value,
            );
          }
          await api("/applications/" + id + "/actions", "POST", payload);
          await detail();
          toast("Действие сохранено в истории");
        })),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-accept]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api("/applications/" + id + "/reply", "POST", {
            version: a.version,
            accept_offer: b.dataset.accept === "true",
            comment:
              b.dataset.accept === "true"
                ? "Клиент согласился с точной версией новых условий"
                : "Клиент отклонил предложенные условия",
          });
          await detail();
        })),
  );
}
function chatBubble(text: string, user = false, mode = "") {
  const div = document.createElement("div");
  div.className = "chat-bubble" + (user ? " user" : "");
  if (!user) {
    const small = document.createElement("small");
    small.textContent = mode || "ПОМОЩНИК";
    div.append(small);
  }
  div.append(document.createTextNode(text));
  $("[data-chat]")!.append(div);
  div.scrollIntoView({ block: "nearest" });
}
function answerBubble(a: Dict) {
  chatBubble(
    a.text,
    false,
    a.mode === "llm"
      ? `${a.model} · открытые веса`
      : "Помощник по правилам · LLM недоступна",
  );
  const root = $("[data-chat]")!;
  for (const q of a.questions || []) {
    const el = document.createElement("div");
    el.className = "chat-bubble";
    el.textContent = q.text;
    const options = document.createElement("div");
    options.className = "chat-suggestions";
    for (const o of q.options) {
      const b = document.createElement("button");
      b.textContent = o;
      b.onclick = () => {
        if (chatPending) return;
        options
          .querySelectorAll<HTMLButtonElement>("button")
          .forEach((button) => (button.disabled = true));
        const input = $<HTMLTextAreaElement>('[name="message"]')!;
        input.value = q.text + ": " + o;
        $<HTMLFormElement>("[data-chat-form]")!.requestSubmit();
      };
      options.append(b);
    }
    el.append(options);
    root.append(el);
  }
  if (a.proposal?.product && (a.turn_id || a.id)) {
    const proposal = a.proposal;
    const card = document.createElement("div");
    card.className = "chat-proposal";
    card.innerHTML = `<h3>${esc(product(proposal.product)?.name || "Предложение по задаче")}</h3><p>${esc(proposal.goal || "Проверьте цель и параметры в черновике")}${proposal.amount ? " · " + rub(proposal.amount) : ""}${proposal.months ? " · " + esc(proposal.months) + " мес." : ""}</p><button class="button button--primary" data-use-proposal>Продолжить с этой задачей →</button>`;
    const button = card.querySelector<HTMLButtonElement>(
      "[data-use-proposal]",
    )!;
    button.onclick = () =>
      busy(button, async () => {
        await api(
          "/chat/" + encodeURIComponent(a.turn_id || a.id) + "/draft",
          "POST",
          {},
        );
        location.assign("/cabinet/new/?from=assistant");
      });
    root.append(card);
  } else if (a.product) {
    const link = document.createElement("a");
    link.className = "credit-text-link";
    link.href = "/cabinet/new/?product=" + encodeURIComponent(a.product);
    link.textContent = "Рассчитать подходящий продукт →";
    root.append(link);
  }
}
async function chat() {
  const history = await api("/chat");
  if (!history.length)
    chatBubble(
      "Расскажите о задаче бизнеса: что хотите профинансировать и откуда планируете возвращать средства? Если пока не знаете, начнём с короткого опроса.",
    );
  for (const turn of history) {
    chatBubble(turn.question, true);
    answerBubble({ ...turn.answer, turn_id: turn.id });
  }
  const form = $<HTMLFormElement>("[data-chat-form]")!;
  form.onsubmit = (e) => {
    e.preventDefault();
    if (chatPending) return;
    busy(form.querySelector("button")!, async () => {
      chatPending = true;
      try {
        const input = $<HTMLTextAreaElement>('[name="message"]')!;
        const message = input.value.trim();
        if (!message) return;
        chatBubble(message, true);
        input.value = "";
        const application_id = new URLSearchParams(location.search).get(
          "application",
        );
        answerBubble(await api("/chat", "POST", { message, application_id }));
      } finally {
        chatPending = false;
      }
    });
  };
  $$("[data-prompt]").forEach(
    (b) =>
      (b.onclick = () => {
        $<HTMLTextAreaElement>('[name="message"]')!.value = b.dataset.prompt!;
        form.requestSubmit();
      }),
  );
}
async function company() {
  const items = (await api("/applications")).items as Dict[];
  const active = items.filter((a) => ["approved", "funded"].includes(a.status));
  $("[data-company]")!.innerHTML =
    header("Профиль и обязательства", account.name) +
    `<div class="product-company-grid"><section class="product-card"><h2>${esc(account.name)}</h2><p>Роль: ${account.role === "staff" ? "Кредитный аналитик" : "Представитель компании"}</p><p>ИНН: ${esc(account.inn || "Не применяется")}</p><p>Форма: ${esc(account.legal_form || "Сотрудник банка")}</p><span class="product-pill">ОБЩИЙ ДЕМОПРОФИЛЬ</span></section><section class="product-card"><h2>Текущая нагрузка</h2><p>Активных обязательств: ${active.length}</p><p>Резерв лимита: <b>${rub(active.reduce((n, a) => n + a.assessment.plan.exposure, 0))}</b></p><p>Максимальные платежи: <b>${rub(active.reduce((n, a) => n + a.assessment.plan.payment, 0))} / мес.</b></p><p class="field-help">Обязательства резервируются с одобрения до симуляции погашения и учитываются при следующих заявках.</p></section></div><div class="product-note">Демонстрационные профили общие для стенда. Переключение роли выполняется через выход и повторный демовход; сервер проверяет доступ к каждому объекту.</div>`;
}
async function documents() {
  if (account.role !== "client")
    throw new Error("Документы доступны внутри соответствующей заявки.");
  const [attached, templates] = await Promise.all([
    api("/documents"),
    api("/documents/demo"),
  ]);
  $("[data-documents]")!.innerHTML =
    header(
      "Документы компании",
      "Пакеты, приложенные к вашим заявкам, и доступные демонстрационные шаблоны",
    ) +
    `<section class="product-card"><h2>Приложенные документы</h2>${attached.documents.length ? attached.documents.map((d: Dict) => `<details class="contract-document"><summary>${esc(d.name)}</summary><p class="field-help">${esc(d.source)} · SHA-256 ${esc(d.id)}</p><pre>${esc(JSON.stringify(d.content, null, 2))}</pre>${d.applications.map((id: string) => `<a class="credit-text-link" href="/cabinet/application/?id=${esc(id)}">Открыть связанную заявку →</a>`).join("<br />")}</details>`).join("") : "<p>Документы появятся здесь после отправки заявки с синтетическим пакетом.</p>"}</section>
 <section class="product-card"><h2>Демонстрационные шаблоны</h2><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Документ</th><th>Источник</th><th>Тип</th></tr></thead><tbody>${templates.documents.map((d: Dict) => `<tr><td>${esc(d.name)}</td><td>${esc(d.source)}</td><td>Синтетический пакет</td></tr>`).join("")}</tbody></table></div><p class="field-help" style="margin-top:20px">Шаблоны прикладываются одной кнопкой на шаге «Проверки». Сценарий расхождения позволяет сравнить разные значения в анкете и отчётности.</p><a class="button button--primary" href="/cabinet/new/">Добавить к новой заявке →</a></section>`;
}
async function init() {
  $("[data-menu]")!.onclick = () => {
    const opened = $("#navigation")!.classList.toggle("is-open");
    $("[data-menu]")!.setAttribute("aria-expanded", String(opened));
  };
  $$("[data-login-as]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b as HTMLButtonElement, async () => {
          await api("/demo/login", "POST", { profile: b.dataset.loginAs });
          location.assign(
            b.dataset.loginAs === "bank" ? "/cabinet/bank/" : "/cabinet/",
          );
        })),
  );
  let me;
  try {
    me = await api("/me");
  } catch {
    const demo = await api("/demo");
    $("[data-login]")!.hidden = false;
    $("[data-account]")!.textContent = "Выберите демопрофиль";
    if (!demo.enabled) {
      $$("[data-login-as]").forEach(
        (b) => ((b as HTMLButtonElement).disabled = true),
      );
      throw new Error(errors.DEMO_DISABLED);
    }
    return;
  }
  account = me.account;
  sessionSummary = me.summary || {};
  $("[data-count]")!.textContent = String(sessionSummary.total || 0);
  csrf = me.csrf;
  $("[data-account]")!.textContent = account.name;
  $("[data-avatar]")!.textContent = account.legal_form || "А";
  $("[data-logout]")!.hidden = false;
  $("[data-logout]")!.onclick = (e) =>
    busy(e.currentTarget as HTMLButtonElement, async () => {
      await api("/logout", "POST");
      location.assign("/cabinet/");
    });
  $$("[data-client-nav]").forEach(
    (el) => (el.hidden = account.role !== "client"),
  );
  $$("[data-staff-nav]").forEach(
    (el) => (el.hidden = account.role !== "staff"),
  );
  $("[data-workspace]")!.hidden = false;
  const cat = await api("/catalog");
  products = cat.products;
  scenarios = cat.scenarios;
  switch (screen) {
    case "overview":
      await overview();
      bindCatalogFilters();
      await activityFeed();
      break;
    case "new":
      await newApplication();
      break;
    case "applications":
    case "bank":
      await list();
      break;
    case "application":
      await detail();
      break;
    case "assistant":
      await chat();
      break;
    case "company":
      await company();
      break;
    case "documents":
      await documents();
      break;
  }
}
init().catch(error);

export {};
