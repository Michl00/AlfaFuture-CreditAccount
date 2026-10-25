export type RequestStatus =
  "bank_review" | "needs_info" | "approved" | "rejected";
export interface CreditRequest {
  id: string;
  title: string;
  company: string;
  amount: number;
  months: number;
  rate: number;
  status: RequestStatus;
  date: string;
  goal: string;
}
export const statusLabels: Record<RequestStatus, string> = {
  bank_review: "На рассмотрении",
  needs_info: "Нужно уточнение",
  approved: "Условия предложены",
  rejected: "Отказ",
};
export const demoRequests: CreditRequest[] = [
  {
    id: "AF-1024",
    title: "На развитие бизнеса",
    company: "ООО «Пример роста»",
    amount: 2000000,
    months: 24,
    rate: 24.9,
    status: "bank_review",
    date: "2026-10-23",
    goal: "Открыть вторую кофейню и закупить оборудование",
  },
  {
    id: "AF-1023",
    title: "На пополнение оборотных средств",
    company: "ООО «Пример роста»",
    amount: 750000,
    months: 12,
    rate: 24.9,
    status: "needs_info",
    date: "2026-10-21",
    goal: "Закупка новой партии товара",
  },
  {
    id: "AF-1022",
    title: "На покупку оборудования",
    company: "ООО «Пример роста»",
    amount: 1200000,
    months: 36,
    rate: 22.9,
    status: "approved",
    date: "2026-10-18",
    goal: "Замена производственного оборудования",
  },
];
export const money = (n: number) =>
  new Intl.NumberFormat("ru-RU").format(n) + " ₽";
