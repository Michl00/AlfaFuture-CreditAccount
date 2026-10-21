/* Local, continuous affordability indicator; AI advice is requested from the server. */
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
  const goalSuggestions = ['Закупка товаров', 'Покупка оборудования', 'Открытие новой точки', 'Ремонт помещения', 'Пополнение оборотных средств', 'Покрытие кассового разрыва'];
  function approvalEstimate(data) {
    const product = products.find(p => p.id === data.product);
    if (!product || ['revenue', 'expenses', 'debt'].some(key => data[key] === '' || data[key] === undefined || !Number.isFinite(Number(data[key])) || Number(data[key]) < 0) || Number(data.revenue) <= 0 || Number(data.amount) <= 0 || Number(data.months) <= 0) {
      return {level: 'unknown', label: 'Добавьте доходы и расходы', score: 0};
    }
    const available = (Number(data.revenue) - Number(data.expenses)) * 0.5 - Number(data.debt);
    const monthly = payment(Number(data.amount), Number(data.months), Number(data.rate ?? product.rate));
    const ratio = available / monthly;
    const level = ratio < 0.3 ? 'critical' : ratio < 1 ? 'low' : ratio < 1.25 || data.age !== '' && Number(data.age) < 6 ? 'medium' : 'high';
    const label = {critical: 'Крайне низкая', low: 'Низкая', medium: 'Средняя', high: 'Высокая'}[level];
    // A continuous curve avoids the old 35 → 60 → 90 jumps at category boundaries.
    const score = 100 * Math.max(0, ratio) / (Math.max(0, ratio) + 0.65);
    return {level, label, score, monthly};
  }

  function validateRequest(data) {
    if (typeof data.goal !== 'string' || data.goal.trim().length < 3 || data.goal.trim().length > 500) return 'Опишите цель кредита: от 3 до 500 символов.';
    if (!Number.isFinite(Number(data.requestedAmount)) || Number(data.requestedAmount) < 100000 || Number(data.requestedAmount) > 10000000) return 'Укажите сумму от 100 000 до 10 000 000 ₽.';
    if (!Number.isInteger(Number(data.requestedMonths)) || Number(data.requestedMonths) < 6 || Number(data.requestedMonths) > 60) return 'Укажите срок от 6 до 60 месяцев.';
    return null;
  }
  const api = {products, payment, validInn, validate, validateRequest, goalSuggestions, approvalEstimate};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CreditFlow = api;
})(typeof window === 'undefined' ? globalThis : window);
