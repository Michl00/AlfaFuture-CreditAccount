import { toast, payment } from "./ui";
import {
  demoRequests,
  statusLabels,
  money,
  type CreditRequest,
  type RequestStatus,
} from "../data/cabinet";
const KEY = "alfa-credit-cabinet-demo-v2";
type Profile = {
  company: string;
  inn: string;
  representative: string;
  email: string;
};
type State = {
  requests: CreditRequest[];
  updates: Record<string, { status: RequestStatus; comment: string }>;
  documents: { name: string; size: number }[];
  profile?: Profile;
  draft?: Record<string, string>;
};
function read(): State {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) || "{}");
    return {
      requests: Array.isArray(o.requests) ? o.requests : [],
      updates: o.updates || {},
      documents: Array.isArray(o.documents) ? o.documents : [],
      profile: o.profile,
      draft: o.draft,
    };
  } catch {
    return { requests: [], updates: {}, documents: [] };
  }
}
const state = read();
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    toast("Хранилище недоступно. Изменения останутся только на этой странице.");
  }
}
function requests() {
  return [...state.requests, ...demoRequests].map((r) => ({
    ...r,
    status: state.updates[r.id]?.status ?? r.status,
  }));
}
function setStatus(id: string, status: RequestStatus, comment: string) {
  state.updates[id] = { status, comment };
  save();
}
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
}
function pill(status: RequestStatus) {
  const el = h("span", `status-pill status-${status}`);
  el.append(h("i"), document.createTextNode(statusLabels[status]));
  return el;
}
function counts() {
  const all = requests();
  document
    .querySelectorAll("[data-total-count],[data-sidebar-count]")
    .forEach((el) => (el.textContent = String(all.length)));
  document
    .querySelectorAll("[data-review-count]")
    .forEach(
      (el) =>
        (el.textContent = String(
          all.filter((r) => r.status === "bank_review").length,
        )),
    );
  document
    .querySelectorAll("[data-task-count]")
    .forEach(
      (el) =>
        (el.textContent = String(
          all.filter((r) => r.status === "needs_info").length,
        )),
    );
}
counts();
const help = document.querySelector<HTMLDialogElement>("#credit-help");
function information(text: string, trigger?: HTMLElement) {
  const p = help?.querySelector("[data-credit-dialog-text]");
  if (p) p.textContent = text;
  help?.showModal();
  help?.addEventListener("close", () => trigger?.focus(), { once: true });
}
const menu = document.querySelector<HTMLButtonElement>("[data-credit-menu]");
const sidebar = document.getElementById("credit-sidebar")!;
const mobile = matchMedia("(max-width: 760px)");
function closeMenu() {
  const hadFocus = sidebar.contains(document.activeElement);
  sidebar.classList.remove("is-open");
  menu?.setAttribute("aria-expanded", "false");
  sidebar.inert = mobile.matches;
  if (hadFocus) menu?.focus();
}
sidebar.inert = mobile.matches;
mobile.addEventListener("change", closeMenu);
menu?.addEventListener("click", () => {
  if (menu.getAttribute("aria-expanded") === "true") {
    closeMenu();
    return;
  }
  sidebar.inert = false;
  sidebar.classList.add("is-open");
  menu.setAttribute("aria-expanded", "true");
  sidebar.querySelector<HTMLButtonElement>("[data-credit-menu-close]")?.focus();
});
document
  .querySelector("[data-credit-menu-close]")
  ?.addEventListener("click", closeMenu);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
  if (
    event.key === "Tab" &&
    mobile.matches &&
    menu?.getAttribute("aria-expanded") === "true"
  ) {
    const targets = Array.from(
      sidebar.querySelectorAll<HTMLElement>("a,button"),
    );
    const first = targets[0],
      last = targets[targets.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});
document.addEventListener("click", (e) => {
  const el = e.target as Element;
  const button = el.closest<HTMLElement>(
    "[data-credit-notifications],[data-document-info]",
  );
  if (button?.hasAttribute("data-credit-notifications"))
    information(
      requests().some((r) => r.status === "needs_info")
        ? "В одной из заявок требуется уточнение данных. Откройте «Мои заявки», чтобы продолжить."
        : "Новых задач нет. Статусы доступны в разделе «Мои заявки».",
      button,
    );
  if (button?.hasAttribute("data-document-info"))
    information(
      "Синтетический пример документа. Содержимое файла не хранится. Настоящая загрузка и распознавание подключаются при интеграции с backend.",
      button,
    );
  if (!el.closest(".credit-sidebar") && !el.closest("[data-credit-menu]"))
    closeMenu();
});
function requestCard(r: CreditRequest) {
  const a = h("a", "credit-request");
  a.href = `/cabinet/application/?id=${encodeURIComponent(r.id)}`;
  a.dataset.requestCard = "";
  a.dataset.requestStatus = r.status;
  const top = h("div", "request-top");
  top.append(h("span", "request-id", `№ ${r.id}`), h("span", "", r.company));
  const bottom = h("div", "request-bottom");
  const status = h("div");
  status.append(h("span", "", "Статус заявки"), pill(r.status));
  const term = h("div");
  term.append(
    h("span", "", "Срок финансирования"),
    h("strong", "", `${r.months} мес.`),
  );
  bottom.append(status, term, h("span", "request-open", "Подробнее"));
  a.append(
    top,
    h("p", "request-label", "Запрошенная сумма"),
    h("strong", "request-amount", money(r.amount)),
    h("h3", "", r.title),
    bottom,
  );
  return a;
}
const dashboard = document.querySelector("[data-dashboard-requests]");
if (dashboard)
  dashboard.replaceChildren(...requests().slice(0, 2).map(requestCard));
const list = document.querySelector<HTMLElement>("[data-request-list]");
if (list) {
  const search = document.querySelector<HTMLInputElement>(
    "[data-request-search]",
  )!;
  let filter = new URLSearchParams(location.search).get("filter") || "all";
  if (!["all", "bank_review", "needs_info", "approved"].includes(filter))
    filter = "all";
  function render() {
    document
      .querySelectorAll<HTMLButtonElement>("[data-filter]")
      .forEach((b) =>
        b.setAttribute("aria-pressed", String(b.dataset.filter === filter)),
      );
    const query = search.value.trim().toLocaleLowerCase("ru");
    const matches = requests().filter(
      (r) =>
        (filter === "all" || r.status === filter) &&
        `${r.id} ${r.title} ${r.goal}`.toLocaleLowerCase("ru").includes(query),
    );
    list!.replaceChildren(...matches.map(requestCard));
    document.querySelector<HTMLElement>("[data-empty-requests]")!.hidden =
      matches.length > 0;
  }
  document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      filter = b.dataset.filter!;
      render();
    }),
  );
  search.addEventListener("input", render);
  document
    .querySelector("[data-reset-filter]")
    ?.addEventListener("click", () => {
      filter = "all";
      search.value = "";
      render();
    });
  render();
}
const form = document.querySelector<HTMLFormElement>("#credit-form");
if (form) {
  let step = 0,
    selectedOffer = 0;
  const field = (name: string) =>
    form.elements.namedItem(name) as
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const v = (name: string) => field(name).value;
  const n = (name: string) => Number(v(name));
  if (state.profile) {
    field("company").value = state.profile.company;
    field("inn").value = state.profile.inn;
  }
  for (const [name, value] of Object.entries(state.draft ?? {})) {
    const input = form.elements.namedItem(name);
    if (
      input instanceof HTMLInputElement ||
      input instanceof HTMLSelectElement ||
      input instanceof HTMLTextAreaElement
    ) {
      if (input.type !== "checkbox" && input.type !== "radio")
        input.value = String(value);
    } else if (input instanceof RadioNodeList) input.value = value;
  }
  const purpose = () =>
    (form.elements.namedItem("purpose") as HTMLSelectElement).value;
  const term = () =>
    selectedOffer === 1 ? Math.min(n("months") + 12, 60) : n("months");
  const rate = () => (selectedOffer === 1 ? 26.9 : 24.9);
  const error = form.querySelector<HTMLElement>(".credit-error")!;
  function showError(text: string) {
    error.textContent = text;
    error.hidden = false;
    error.tabIndex = -1;
    error.focus();
    return false;
  }
  function valid(index: number) {
    if (index === 0) {
      if (
        !Number.isFinite(n("amount")) ||
        n("amount") < 100000 ||
        n("amount") > 10000000
      )
        return showError("Укажите сумму от 100 000 до 10 000 000 ₽.");
      if (v("goal").trim().length < 3 || v("goal").length > 500)
        return showError("Опишите задачу бизнеса: от 3 до 500 символов.");
    }
    if (index === 2) {
      if (v("company").trim().length < 2 || v("company").length > 120)
        return showError("Укажите название компании: от 2 до 120 символов.");
      if (!/^(\d{10}|\d{12})$/.test(v("inn")))
        return showError("ИНН должен содержать 10 или 12 цифр.");
      for (const name of ["revenue", "expenses", "debt", "age"])
        if (v(name) === "" || !Number.isFinite(n(name)) || n(name) < 0)
          return showError(
            "Заполните финансовые показатели и возраст бизнеса числами от нуля.",
          );
      if (n("revenue") === 0)
        return showError("Выручка должна быть больше нуля.");
      if (
        n("revenue") > 1e9 ||
        n("expenses") > 1e9 ||
        n("debt") > 1e9 ||
        n("age") > 1200
      )
        return showError(
          "Проверьте показатели: до 1 млрд ₽ и до 1200 месяцев.",
        );
    }
    return true;
  }
  function summary() {
    const values: Record<string, string> = {
      "[data-summary-amount]": money(n("amount") || 0),
      "[data-summary-term]": `${term() || 0} мес.`,
      "[data-summary-rate]": `${rate().toLocaleString("ru-RU")}% годовых`,
      "[data-summary-payment]": money(
        payment(n("amount") || 0, term() || 24, rate()),
      ),
    };
    for (const [selector, value] of Object.entries(values)) {
      const el = document.querySelector(selector);
      if (el) el.textContent = value;
    }
  }
  function offerCards() {
    const box = form!.querySelector("[data-credit-offers]")!;
    box.replaceChildren();
    const extended = Math.min(n("months") + 12, 60);
    const offerings = [
      {
        title: "На развитие бизнеса",
        description: "Срок, который вы выбрали",
        months: n("months"),
        rate: 24.9,
      },
      {
        title: "С меньшим ежемесячным платежом",
        description: "Больше срок — больше общая переплата",
        months: extended,
        rate: 26.9,
      },
    ];
    offerings
      .filter((_, i) => i === 0 || extended > n("months"))
      .forEach((o, i) => {
        const label = h("label", "credit-offer");
        const radio = h("input");
        radio.type = "radio";
        radio.name = "offer";
        radio.value = String(i);
        radio.checked = selectedOffer === i;
        const body = h("span", "credit-offer-body");
        body.append(h("h3", "", o.title), h("p", "", o.description));
        const metrics = h("div", "credit-offer-metrics");
        for (const [name, value] of [
          ["Срок", `${o.months} мес.`],
          ["Ставка", `${o.rate.toLocaleString("ru-RU")}%`],
          ["Платёж в месяц", money(payment(n("amount"), o.months, o.rate))],
        ]) {
          const metric = h("div");
          metric.append(h("span", "", name), h("strong", "", value));
          metrics.append(metric);
        }
        body.append(metrics);
        label.append(radio, body);
        radio.addEventListener("change", () => {
          selectedOffer = i;
          summary();
        });
        box.append(label);
      });
  }
  function review() {
    const box = form!.querySelector("[data-credit-review]")!;
    box.replaceChildren();
    for (const [label, value] of [
      ["Компания", v("company")],
      ["ИНН", v("inn")],
      ["Задача", v("goal")],
      ["Сумма", money(n("amount"))],
      ["Срок", `${term()} мес.`],
      ["Условная ставка", `${rate().toLocaleString("ru-RU")}% годовых`],
      ["Примерный платёж", money(payment(n("amount"), term(), rate()))],
    ]) {
      const row = h("div");
      row.append(h("dt", "", label), h("dd", "", value));
      box.append(row);
    }
  }
  function show(index: number, focus = true) {
    step = index;
    form!
      .querySelectorAll<HTMLElement>("[data-credit-step]")
      .forEach((el) => (el.hidden = Number(el.dataset.creditStep) !== step));
    document.querySelectorAll(".credit-wizard-steps li").forEach((el, i) => {
      el.classList.toggle("is-current", i === step);
      el.classList.toggle("is-done", i < step);
      el.removeAttribute("aria-current");
      if (i === step) el.setAttribute("aria-current", "step");
      el.querySelector("span")!.textContent = i < step ? "✓" : String(i + 1);
    });
    error.hidden = true;
    if (step === 1) offerCards();
    if (step === 3) {
      (field("consent") as HTMLInputElement).checked = false;
      review();
    }
    summary();
    if (focus) {
      const heading = form!.querySelector<HTMLElement>(
        `[data-credit-step="${step}"] h2`,
      );
      heading?.setAttribute("tabindex", "-1");
      heading?.focus();
    }
  }
  form.addEventListener("input", () => {
    const data = Object.fromEntries(new FormData(form).entries()) as Record<
      string,
      string
    >;
    delete data.consent;
    delete data.offer;
    state.draft = data;
    save();
    if (step === 0) {
      selectedOffer = 0;
      summary();
    }
  });
  form.querySelectorAll("[data-credit-next]").forEach((b) =>
    b.addEventListener("click", () => {
      if (valid(step)) show(step + 1);
    }),
  );
  form
    .querySelectorAll("[data-credit-prev]")
    .forEach((b) => b.addEventListener("click", () => show(step - 1)));
  document
    .querySelector("[data-credit-clear]")
    ?.addEventListener("click", () => {
      state.draft = undefined;
      save();
      form.reset();
      selectedOffer = 0;
      form.hidden = false;
      document.querySelector<HTMLElement>("[data-credit-success]")!.hidden =
        true;
      show(0);
      toast("Черновик очищен");
    });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (step < 3) {
      if (valid(step)) show(step + 1);
      return;
    }
    if (!valid(0) || !valid(2)) return;
    if (!(field("consent") as HTMLInputElement).checked) {
      showError("Подтвердите создание учебной заявки.");
      return;
    }
    const id = "DEMO-" + Date.now().toString(36).toUpperCase();
    const names: Record<string, string> = {
      working: "На пополнение оборотных средств",
      equipment: "На покупку оборудования",
      growth: "На развитие бизнеса",
    };
    state.requests.unshift({
      id,
      title: names[purpose()] || "На развитие бизнеса",
      company: v("company"),
      amount: n("amount"),
      months: term(),
      rate: rate(),
      status: "bank_review",
      date: "2026-10-23",
      goal: v("goal"),
    });
    state.requests = state.requests.slice(0, 20);
    state.draft = undefined;
    save();
    counts();
    form.hidden = true;
    const success = document.querySelector<HTMLElement>(
      "[data-credit-success]",
    )!;
    success.hidden = false;
    const heading = success.querySelector("h2")!;
    heading.tabIndex = -1;
    heading.focus();
    document.querySelector<HTMLAnchorElement>("[data-created-link]")!.href =
      `/cabinet/application/?id=${id}`;
  });
  show(0, false);
}
const detail = document.querySelector<HTMLElement>("[data-application-detail]");
if (detail) {
  const id = new URLSearchParams(location.search).get("id") || "AF-1024";
  const r = requests().find((x) => x.id === id);
  if (!r) {
    detail.replaceChildren(
      h("h1", "", "Заявка не найдена"),
      h("p", "", "Откройте список заявок и выберите существующую."),
    );
    const link = h("a", "button button--primary", "Мои заявки");
    link.href = "/cabinet/applications/";
    detail.append(link);
  } else {
    const text = (selector: string, value: string) => {
      const el = detail.querySelector(selector);
      if (el) el.textContent = value;
    };
    function render() {
      const status = state.updates[id]?.status ?? r!.status;
      text("[data-detail-id]", `ЗАЯВКА № ${r!.id}`);
      text("[data-detail-title]", r!.title);
      text(
        "[data-detail-date]",
        `Создана ${new Date(r!.date + "T12:00:00").toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}`,
      );
      detail!
        .querySelector("[data-detail-status]")!
        .replaceChildren(pill(status));
      text("[data-detail-company]", r!.company);
      text("[data-detail-goal]", r!.goal);
      text("[data-detail-amount]", money(r!.amount));
      text("[data-detail-months]", `${r!.months} мес.`);
      text("[data-detail-rate]", `${r!.rate.toLocaleString("ru-RU")}% годовых`);
      text(
        "[data-detail-payment]",
        money(payment(r!.amount, r!.months, r!.rate)),
      );
      const titles: Record<RequestStatus, string> = {
        bank_review: "Рассматриваем вашу заявку",
        needs_info: "Нужны дополнительные данные",
        approved: "Для вас готовы условия",
        rejected: "Рассмотрение завершено",
      };
      const desc: Record<RequestStatus, string> = {
        bank_review:
          "Данные получены. Следите за статусом — здесь появится результат или запрос уточнения.",
        needs_info:
          "Сотруднику нужна дополнительная информация. Ответьте на запрос ниже, чтобы продолжить.",
        approved:
          "Ознакомьтесь с демонстрационными условиями справа. Этот статус — часть локальной симуляции.",
        rejected: "В демо показан пример отрицательного результата.",
      };
      text("[data-detail-state-title]", titles[status]);
      text(
        "[data-detail-state-text]",
        state.updates[id]?.comment
          ? `${desc[status]} Комментарий: ${state.updates[id].comment}`
          : desc[status],
      );
      detail!.querySelector<HTMLElement>("[data-clarification]")!.hidden =
        status !== "needs_info";
      detail!
        .querySelectorAll(".credit-status-timeline>div")
        .forEach((el, i) => {
          const current =
            status === "approved" || status === "rejected" ? 2 : 1;
          el.classList.toggle("is-current", i === current);
          el.classList.toggle("is-done", i < current);
        });
    }
    document
      .querySelector<HTMLFormElement>("#clarification-form")
      ?.addEventListener("submit", (event) => {
        event.preventDefault();
        const input = (
          event.currentTarget as HTMLFormElement
        ).elements.namedItem("clarification") as HTMLTextAreaElement;
        const value = input.value.trim();
        if (value.length < 3) {
          toast("Добавьте комментарий: минимум три символа.");
          return;
        }
        setStatus(
          id,
          "bank_review",
          "Уточнение клиента: " + value.slice(0, 1000),
        );
        render();
        counts();
        toast("Уточнение сохранено. Заявка снова на рассмотрении.");
      });
    render();
  }
}
const companyForm = document.querySelector<HTMLFormElement>(
  "#credit-company-form",
);
if (companyForm) {
  const field = (name: string) =>
    companyForm.elements.namedItem(name) as HTMLInputElement;
  if (state.profile)
    for (const [key, value] of Object.entries(state.profile))
      field(key).value = value;
  const heading = document.querySelector("[data-company-name]");
  if (heading) heading.textContent = field("company").value;
  companyForm.addEventListener("submit", (e) => {
    e.preventDefault();
    state.profile = Object.fromEntries(
      new FormData(companyForm).entries(),
    ) as unknown as Profile;
    save();
    if (heading) heading.textContent = state.profile.company;
    const sidebarLabel = document.querySelector("[data-sidebar-company]");
    if (sidebarLabel) sidebarLabel.textContent = state.profile.company;
    toast("Данные компании сохранены в этом браузере");
  });
}
const upload = document.querySelector<HTMLInputElement>("[data-credit-upload]");
if (upload) {
  const list = document.querySelector("[data-documents-list]")!;
  function render() {
    list.querySelectorAll("[data-local-document]").forEach((el) => el.remove());
    state.documents.forEach((d, i) => {
      const row = h("div", "document-row");
      row.dataset.localDocument = "";
      const extension = d.name.split(".").pop()!.slice(0, 4).toUpperCase();
      const info = h("div");
      info.append(
        h("strong", "", d.name),
        h(
          "small",
          "",
          `Локально · ${Math.max(1, Math.round(d.size / 1024))} КБ · Только метаданные`,
        ),
      );
      const remove = h("button", "credit-icon-action", "×");
      remove.setAttribute("aria-label", `Удалить из демо: ${d.name}`);
      remove.addEventListener("click", () => {
        state.documents.splice(i, 1);
        save();
        render();
        toast("Запись о документе удалена из демо");
      });
      row.append(
        h("span", "document-file-type", extension),
        info,
        h("span", "status-pill status-bank_review", "Добавлен в демо"),
        remove,
      );
      list.prepend(row);
    });
  }
  upload.addEventListener("change", () => {
    const file = upload.files?.[0];
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (
      !extension ||
      !["pdf", "docx", "xlsx", "csv", "txt", "json"].includes(extension)
    ) {
      toast("Выберите PDF, DOCX, XLSX, CSV, TXT или JSON");
      upload.value = "";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast("Максимальный размер — 5 МБ");
      upload.value = "";
      return;
    }
    state.documents.push({ name: file.name, size: file.size });
    state.documents = state.documents.slice(-20);
    save();
    render();
    toast("Добавлена запись о документе. Файл не отправлялся.");
    upload.value = "";
  });
  render();
}
const queue = document.querySelector<HTMLElement>("[data-bank-queue]");
if (queue) {
  let selected = requests()[0]?.id;
  const f = document.querySelector<HTMLFormElement>("#bank-action-form")!;
  function render() {
    const all = requests();
    queue!.replaceChildren();
    all.forEach((r) => {
      const b = h("button", "bank-queue-item");
      b.type = "button";
      b.setAttribute("aria-pressed", String(r.id === selected));
      b.append(
        h("strong", "", r.company),
        pill(r.status),
        h("small", "", `${r.id} · ${money(r.amount)}`),
      );
      b.addEventListener("click", () => {
        selected = r.id;
        f.reset();
        render();
      });
      queue!.append(b);
    });
    const r = all.find((x) => x.id === selected);
    if (!r) return;
    document.querySelector("[data-bank-title]")!.textContent =
      `Заявка № ${r.id}`;
    const box = document.querySelector("[data-bank-summary]")!;
    box.replaceChildren();
    for (const [label, value] of [
      ["Цель", r.title],
      ["Сумма", money(r.amount)],
      ["Срок", `${r.months} мес.`],
      ["Статус", statusLabels[r.status]],
    ]) {
      const row = h("div");
      row.append(h("dt", "", label), h("dd", "", value));
      box.append(row);
    }
    document.querySelector("[data-bank-history]")!.textContent = state.updates[
      r.id
    ]?.comment
      ? "Последний комментарий: " + state.updates[r.id].comment
      : "История действий появится после первого изменения.";
  }
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const b = (e as SubmitEvent).submitter as HTMLButtonElement | null;
    if (!b || !selected) return;
    const comment = (
      f.elements.namedItem("comment") as HTMLTextAreaElement
    ).value.trim();
    if (comment.length < 3) {
      toast("Объясните действие: минимум три символа.");
      return;
    }
    setStatus(selected, b.value as RequestStatus, comment.slice(0, 1000));
    render();
    counts();
    f.reset();
    toast("Демо-статус изменён. Он виден в кабинете клиента.");
  });
  render();
}

// Keep dashboard tasks consistent with the shared local request state.
const tasks = requests().filter((r) => r.status === "needs_info");
const taskLink = document.querySelector<HTMLAnchorElement>("[data-task-stat]");
if (taskLink)
  taskLink.href = tasks[0]
    ? `/cabinet/application/?id=${tasks[0].id}`
    : "/cabinet/applications/?filter=needs_info";
const taskCard = document.querySelector<HTMLElement>("[data-dashboard-task]");
if (taskCard && !tasks.length) {
  taskCard.querySelector("h3")!.textContent = "Всё необходимое уже заполнено";
  taskCard.querySelector("p")!.textContent =
    "Новых запросов на уточнение нет. Следите за статусами в разделе «Мои заявки».";
  const link = taskCard.querySelector<HTMLAnchorElement>("a")!;
  link.textContent = "Посмотреть заявки →";
  link.href = "/cabinet/applications/";
}
if (state.profile) {
  const label = document.querySelector("[data-sidebar-company]");
  if (label) label.textContent = state.profile.company;
}
document.querySelector("[data-reset-demo]")?.addEventListener("click", () => {
  state.requests = [];
  state.updates = {};
  state.documents = [];
  state.profile = undefined;
  state.draft = undefined;
  save();
  location.href = "/cabinet/";
});

document.querySelectorAll("[data-save-draft]").forEach((button) =>
  button.addEventListener("click", () => {
    save();
    toast("Черновик сохранён в этом браузере");
  }),
);
