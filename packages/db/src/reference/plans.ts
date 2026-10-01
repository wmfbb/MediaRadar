/** Тарифы (плейсхолдер из прототипа; цены и лимиты — отдельное решение владельца, см. PRODUCT_SPEC §9). */
export interface PlanDef {
  key: string;
  name: string;
  priceMinor: number | null;
  description: string;
  features: string[];
  entitlements: Record<string, number | boolean | null>; // null = без ограничения
  sort: number;
}

export const PLANS: PlanDef[] = [
  {
    key: 'free',
    name: 'FREE',
    priceMinor: 0,
    description: 'Знакомство с платформой',
    features: ['2 источника', '500 материалов/мес', 'Лента и базовые фильтры', '1 пользователь'],
    entitlements: {
      'sources.active': 2, 'articles.delivered_per_month': 500, seats: 1, 'ai.tokens_per_month': 0,
      'history.depth_days': 30, 'reports.per_month': 0, 'exports.per_month': 0, 'alerts.rules': 0,
      'api.requests_per_month': 0, 'feature.api': false, 'feature.pptx': false, 'feature.custom_roles': false,
      'feature.private_sources': false, 'feature.nlp_full': false,
    },
    sort: 10,
  },
  {
    key: 'starter',
    name: 'STARTER',
    priceMinor: 490_000,
    description: 'Малый мониторинг',
    features: ['10 источников', '10 000 материалов/мес', 'Базовая аналитика', 'Email-алерты', '3 пользователя'],
    entitlements: {
      'sources.active': 10, 'articles.delivered_per_month': 10_000, seats: 3, 'ai.tokens_per_month': 50_000,
      'history.depth_days': 180, 'reports.per_month': 5, 'exports.per_month': 20, 'alerts.rules': 5,
      'api.requests_per_month': 0, 'feature.api': false, 'feature.pptx': false, 'feature.custom_roles': false,
      'feature.private_sources': false, 'feature.nlp_full': false,
    },
    sort: 20,
  },
  {
    key: 'pro',
    name: 'PRO',
    priceMinor: 1_990_000,
    description: 'Полная аналитика региона',
    features: [
      '50 источников', '200 000 материалов/мес', 'NER, тональность, саммари', 'Все каналы алертов',
      'PDF / Excel отчёты', 'API-доступ', '10 пользователей',
    ],
    entitlements: {
      'sources.active': 50, 'articles.delivered_per_month': 200_000, seats: 10, 'ai.tokens_per_month': 1_000_000,
      'history.depth_days': 1095, 'reports.per_month': 100, 'exports.per_month': 500, 'alerts.rules': 50,
      'api.requests_per_month': 100_000, 'feature.api': true, 'feature.pptx': false, 'feature.custom_roles': false,
      'feature.private_sources': true, 'feature.nlp_full': true,
    },
    sort: 30,
  },
  {
    key: 'enterprise',
    name: 'ENTERPRISE',
    priceMinor: null,
    description: 'Мульти-регион, SLA',
    features: [
      'Безлимит источников', 'Выделенная инфраструктура', 'On-premise / приватный контур', 'SSO, кастомные роли',
      'Персональный менеджер',
    ],
    entitlements: {
      'sources.active': null, 'articles.delivered_per_month': null, seats: null, 'ai.tokens_per_month': null,
      'history.depth_days': null, 'reports.per_month': null, 'exports.per_month': null, 'alerts.rules': null,
      'api.requests_per_month': null, 'feature.api': true, 'feature.pptx': true, 'feature.custom_roles': true,
      'feature.private_sources': true, 'feature.nlp_full': true,
    },
    sort: 40,
  },
];
