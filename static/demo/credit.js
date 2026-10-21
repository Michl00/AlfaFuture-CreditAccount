/* Demonstration rules only; no bank integrations or real credit decisions. */
(function (root) {
  'use strict';
  const products = [
    {id: 'working', name: 'На оборотные средства', short: 'Оборотные средства', description: 'Закупайте товары, пополняйте запасы и оплачивайте текущие расходы.', rate: 24.9, max: 10000000, months: 36, icon: '↻', tag: 'ДЛЯ КАЖДОГО ДНЯ'},
    {id: 'equipment', name: 'На развитие бизнеса', short: 'Развитие бизнеса', description: 'Покупайте оборудование, открывайте новые точки и воплощайте планы.', rate: 22.9, max: 10000000, months: 60, icon: '→', tag: 'ДЛЯ БОЛЬШИХ ПЛАНОВ'},
    {id: 'flex', name: 'На короткие задачи', short: 'Короткие задачи', description: 'Закрывайте кассовые разрывы и финансируйте сезонные закупки.', rate: 26.9, max: 3000000, months: 24, icon: '⌁', tag: 'КОГДА НУЖНА ГИБКОСТЬ'},
  ];
  function payment(amount, months, annualRate) {
    const rate = annualRate / 1200;
    if (rate === 0) return amount / months;
    return amount * rate / (1 - Math.pow(1 + rate, -months));
  }
  function validInn(inn) {
    if (!/^([0-9]{10}|[0-9]{12})$/.test(inn)) return false;
    const ctrl = coefs => coefs.reduce((sum, coef, index) => sum + Number(inn[index]) * coef, 0) % 11 % 10;
    return inn.length === 10 ? ctrl([2,4,10,3,5,9,4,6,8]) === Number(inn[9]) : ctrl([7,2,4,10,3,5,9,4,6,8]) === Number(inn[10]) && ctrl([3,7,2,4,10,3,5,9,4,6,8]) === Number(inn[11]);
  }
  function validate(data) {
    const product = products.find(item => item.id === data.product);
    if (!product) return 'Выберите цель финансирования.';
    if (!Number.isFinite(Number(data.amount)) || Number(data.amount) < 100000 || Number(data.amount) > product.max) return `Для выбранной цели укажите сумму от 100 000 до ${product.max.toLocaleString('ru-RU')} ₽.`;
    if (!Number.isInteger(Number(data.months)) || Number(data.months) < 6 || Number(data.months) > product.months) return `Выберите срок от 6 до ${product.months} месяцев.`;
    if (!data.company || data.company.trim().length < 2 || data.company.length > 120) return 'Укажите название компании или ИП (от 2 до 120 символов).';
    if (!validInn(data.inn || '')) return 'Проверьте ИНН: нужны 10 или 12 цифр с корректной контрольной суммой.';
    for (const name of ['revenue', 'expenses', 'debt', 'age']) {
      if (data[name] === '' || data[name] === undefined || !Number.isFinite(Number(data[name])) || Number(data[name]) < 0 || Number(data[name]) > 1000000000) return 'Проверьте финансовые показатели: укажите неотрицательные числа.';
    }
    if (Number(data.revenue) <= 0) return 'Укажите среднемесячную выручку больше нуля.';
    if (!Number.isInteger(Number(data.age)) || Number(data.age) > 1200) return 'Укажите возраст бизнеса в полных месяцах (до 1200).';
    return null;
  }
  function validateRequest(data) {
    if (!products.some(p => p.id === data.goal)) return 'Укажите цель финансирования.';
    if (!Number.isFinite(Number(data.requestedAmount)) || Number(data.requestedAmount) < 100000 || Number(data.requestedAmount) > 10000000) return 'Укажите сумму от 100 000 до 10 000 000 ₽.';
    if (!Number.isInteger(Number(data.requestedMonths)) || Number(data.requestedMonths) < 6 || Number(data.requestedMonths) > 60) return 'Укажите срок от 6 до 60 месяцев.';
    return null;
  }
  function recommend(data) {
    if (validateRequest(data)) throw new Error('Invalid financing request');
    return [...products].sort((a, b) => Number(b.id === data.goal) - Number(a.id === data.goal)).map((product, index) => {
      const amount = Math.min(Number(data.requestedAmount), product.max);
      const months = Math.min(Number(data.requestedMonths), product.months);
      return {product: product.id, amount, months, rate: product.rate, payment: payment(amount, months, product.rate), recommended: index === 0,
        reason: product.id === data.goal ? 'Соответствует вашей цели финансирования.' : product.description,
        limited: amount !== Number(data.requestedAmount) || months !== Number(data.requestedMonths)};
    });
  }
  function assess(data) {
    if (validate(data)) throw new Error('Invalid demonstration application');
    if (Number(data.age) < 6 && (!data.clarification || data.clarification.trim().length < 20)) {
      return {status: 'needs_info', reasons: ['Бизнес работает меньше полугода. Расскажите о заключённых договорах и источниках выручки.']};
    }
    const product = products.find(item => item.id === data.product);
    const available = (Number(data.revenue) - Number(data.expenses)) * 0.5 - Number(data.debt);
    const initialPayment = payment(Number(data.amount), Number(data.months), product.rate);
    const risk = available < initialPayment ? 'high' : Number(data.age) < 12 || initialPayment > available * 0.7 ? 'medium' : 'low';
    const rate = Math.round((product.rate + (risk === 'high' ? 3 : risk === 'medium' ? 1.5 : 0)) * 10) / 10;
    let months = Number(data.months);
    // First consider a longer term, then a smaller principal if necessary.
    if (payment(Number(data.amount), months, rate) > available) months = Math.min(product.months, months + 12);
    const affordable = Math.floor(available / payment(1, months, rate) / 10000) * 10000;
    const amount = Math.min(Number(data.amount), affordable);
    if (amount < 100000 || available <= 0) return {status: 'unavailable', risk: 'high', reasons: ['Свободного дохода сейчас недостаточно для платежа. Попробуйте изменить сумму или финансовые данные.']};
    const reasons = [];
    if (months !== Number(data.months)) reasons.push('Срок увеличен, чтобы снизить ежемесячный платёж.');
    if (amount !== Number(data.amount)) reasons.push('Сумма уменьшена, чтобы платёж соответствовал возможностям бизнеса.');
    if (rate !== product.rate) reasons.push('В демонстрационной оценке ставка скорректирована с учётом срока работы бизнеса и нагрузки на доход.');
    if (!reasons.length) reasons.push('Указанных доходов достаточно для выбранных условий. Корректировки не понадобились.');
    return {status: 'ready', risk, reasons, terms: {amount, months, rate, payment: payment(amount, months, rate)}};
  }
  // Replace this boundary with server-backed recommendations/assessment when CometAPI is connected.
  const advisor = {recommend, assess};
  const api = {products, payment, validInn, validate, validateRequest, advisor};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CreditFlow = api;
})(typeof window === 'undefined' ? globalThis : window);
