# API библиотеки

Общий импорт: `import { Button, Field, ... } from '../components/ui'`. Каждый компонент можно импортировать отдельно. Базовые стили подключены в `Layout.astro`.

| Компонент | Свойства и контракт |
| --- | --- |
| Button | `variant: primary/secondary/ghost`, `size: sm/md/lg`, `href?`, HTML button-атрибуты, default slot. При href рендерит ссылку; disabled применим к button. |
| Icon | `name?`, `size?`; 13 линейных декоративных SVG. Текст для доступности задаёт родительская кнопка. |
| Badge | `tone: neutral/success/warning/danger/info`, default slot |
| Field | `label`, `name`, `type?`, `placeholder?`, `value?`, `hint?`, `error?`, `required?`. Вложенный label и aria-describedby. |
| Select | `label`, `name`, `options: string[]` |
| Checkbox | `name`, `checked?`, `required?`, default slot |
| Alert | `tone: info/success/warning/danger`, `title?`, default slot |
| Tabs | `items: {label,value}[]`, `active?`, `label?`; named slots по value. Значения value должны быть уникальны на странице: из них создаются id. Клавиатура: стрелки, Home, End. |
| Accordion | `items: {title,body}[]`; нативные details/summary |
| Stepper | `steps: string[]`, `current?` (индекс с нуля) |
| ProductCard | `title`, `description?`, `image?`, `color?`, `href?`, `eyebrow?` |
| PromoTile | `title`, `image`, `color?`, `href?`, `class?` |
| SectionHeading | `title`, `description?`, `eyebrow?`, default slot |
| Modal | `id`, `title`, default slot. Открыть кнопкой с `data-open-modal="id"`; Escape, фон и кнопка закрывают окно. Нативный dialog управляет фокусом. |
| EmptyState | `title`, `description`, default slot для действия |
| ApplicationTable | `rows: {id,company,amount,status,tone}[]`; локальный просмотр подробностей открывает демо-модалку |

Составные блоки: Header (`active`), Footer, Calculator (`id?`, уникальный на странице). Калькулятору нужны обработчики `src/scripts/ui.ts`; формула экспортирована как `payment`.

Дополнительные CSS-примитивы: `.panel`, `.row`, `.form-grid`, `.icon-button`, `.text-button`, `.code-block`, `.eyebrow`. Токены определены в `:root`: фон, текст, границы, красный/лаванда/голубой, радиусы, базовый шаг отступов.

Для использования без Layout импортируйте `styles/global.css` и `scripts/ui.ts` один раз в своей оболочке. JavaScript не является React runtime; это обработчики стандартного DOM.

## Компоненты кредитного кабинета

`src/components/cabinet/`: CreditField (`label`, `hint?`, `options?`, HTML input attributes), CreditProgress (`steps?: string[]`, четыре этапа по умолчанию), StatusPill (`status`), RequestCard (`request: CreditRequest`), PageHeading (`title`, `description?`, `eyebrow?`, slot действия). Оболочка: CabinetLayout (`title`, `active`). Светлая тема живёт в cabinet.css и не меняет публичное демо. Живой каталог — `/cabinet/components/`, примеры использования — экраны `/cabinet/`; визуальное основание — `/cabinet/design/`.
