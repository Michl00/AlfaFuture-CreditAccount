export function toast(message: string) {
  const el = document.querySelector<HTMLElement>(".toast");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  window.clearTimeout(Number(el.dataset.timer));
  el.dataset.timer = String(
    window.setTimeout(() => {
      el.hidden = true;
    }, 4000),
  );
}
function openModal(id: string, trigger: HTMLElement, description?: string) {
  const dialog = document.getElementById(id) as HTMLDialogElement | null;
  if (!dialog) return;
  if (description) {
    const p = dialog.querySelector("[data-modal-description]");
    if (p) p.textContent = description;
  }
  dialog.showModal();
  dialog.addEventListener("close", () => trigger.focus(), { once: true });
}
document.addEventListener("click", (event) => {
  const target = (event.target as Element).closest<HTMLElement>("button,a");
  if (!target) return;
  if (target.dataset.toast) toast(target.dataset.toast);
  if (target.dataset.openModal) openModal(target.dataset.openModal, target);
  if (target.dataset.product)
    openModal(
      "product-modal",
      target,
      `${target.dataset.product}. Это учебный пример интерфейса. Реальное оформление недоступно.`,
    );
  if (target.dataset.application)
    openModal(
      "product-modal",
      target,
      `Заявка № ${target.dataset.application}. Синтетический пример для библиотеки компонентов. Реальные проверки не выполнялись.`,
    );
  if (target.hasAttribute("data-close-modal"))
    target.closest("dialog")?.close();
  if (target.hasAttribute("data-menu")) {
    const expanded = target.getAttribute("aria-expanded") === "true";
    target.setAttribute("aria-expanded", String(!expanded));
    document.getElementById("main-nav")?.classList.toggle("is-open", !expanded);
  }
});
document.querySelectorAll<HTMLDialogElement>("dialog").forEach((dialog) =>
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        dialog.close();
    }
  }),
);
document.querySelectorAll<HTMLElement>("[data-tabs]").forEach((widget) => {
  const tabs = Array.from(
    widget.querySelectorAll<HTMLButtonElement>("[role=tab]"),
  );
  function activate(tab: HTMLButtonElement) {
    tabs.forEach((t) => {
      const active = t === tab;
      t.setAttribute("aria-selected", String(active));
      t.tabIndex = active ? 0 : -1;
      const p = document.getElementById(t.getAttribute("aria-controls")!);
      if (p) p.hidden = !active;
    });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (event) => {
      let next = index;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft")
        next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      activate(tabs[next]);
      tabs[next].focus();
    });
  });
});
export function payment(amount: number, months: number, annualRate = 24) {
  const rate = annualRate / 1200;
  return Math.round((amount * rate) / (1 - Math.pow(1 + rate, -months)));
}
const rub = (n: number) => new Intl.NumberFormat("ru-RU").format(n) + " ₽";
document.querySelectorAll<HTMLElement>("[data-calculator]").forEach((el) => {
  const amount = el.querySelector<HTMLInputElement>("[data-amount-range]")!;
  const term = el.querySelector<HTMLInputElement>("[data-term-range]")!;
  function update() {
    const a = Number(amount.value),
      m = Number(term.value);
    el.querySelector("[data-amount]")!.textContent = rub(a);
    const mod = m % 100,
      unit = m % 10;
    const word =
      mod >= 11 && mod <= 14
        ? "месяцев"
        : unit === 1
          ? "месяц"
          : unit >= 2 && unit <= 4
            ? "месяца"
            : "месяцев";
    el.querySelector("[data-term]")!.textContent = `${m} ${word}`;
    el.querySelector("[data-payment]")!.textContent = rub(payment(a, m));
  }
  amount.addEventListener("input", update);
  term.addEventListener("input", update);
  update();
});
