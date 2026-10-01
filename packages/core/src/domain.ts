/** Общие доменные константы: используются и API, и веб-интерфейсом. */

export const SENTIMENTS = {
  VP: { label: 'Очень позитивный', short: 'позитив++', min: 0.6, hex: '#059669' },
  P: { label: 'Позитивный', short: 'позитив', min: 0.2, hex: '#34d399' },
  N: { label: 'Нейтральный', short: 'нейтрально', min: -0.2, hex: '#94a3b8' },
  NG: { label: 'Негативный', short: 'негатив', min: -0.6, hex: '#f59e0b' },
  VN: { label: 'Критический', short: 'критично', min: -1.01, hex: '#e11d48' },
} as const;
export type SentimentLabel = keyof typeof SENTIMENTS;
export const SENTIMENT_KEYS = Object.keys(SENTIMENTS) as SentimentLabel[];

/** Скор −1…+1 → одна из 5 градаций. Пороги — настройки, здесь значения по умолчанию. */
export function sentimentFromScore(score: number): SentimentLabel {
  if (score >= SENTIMENTS.VP.min) return 'VP';
  if (score >= SENTIMENTS.P.min) return 'P';
  if (score >= SENTIMENTS.N.min) return 'N';
  if (score >= SENTIMENTS.NG.min) return 'NG';
  return 'VN';
}

export const SOURCE_KINDS = {
  GOV_PORTAL: 'Гос. портал',
  NEWS_SITE: 'СМИ',
  TELEGRAM: 'Telegram',
  VK: 'VK',
  FORUM: 'Форум',
  YOUTUBE: 'YouTube',
} as const;
export type SourceKind = keyof typeof SOURCE_KINDS;

export const PARSERS = ['PLAYWRIGHT', 'RSS', 'CHEERIO', 'TELEGRAM_BOT', 'VK_API', 'YOUTUBE_API'] as const;
export type Parser = (typeof PARSERS)[number];

export const SOURCE_STATUSES = ['active', 'paused', 'error', 'needs_attention'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export const CONTENT_POLICIES = ['full', 'excerpt', 'metadata'] as const;
export type ContentPolicy = (typeof CONTENT_POLICIES)[number];

/** Политика контента по умолчанию для типа источника (см. PLAN §2.1, п. 5). */
export const DEFAULT_CONTENT_POLICY: Record<SourceKind, ContentPolicy> = {
  GOV_PORTAL: 'full',
  NEWS_SITE: 'excerpt',
  TELEGRAM: 'excerpt',
  VK: 'excerpt',
  FORUM: 'excerpt',
  YOUTUBE: 'excerpt',
};

export const TENANT_ROLE_KEYS = ['OWNER', 'ADMIN', 'ANALYST', 'EDITOR', 'MODERATOR', 'VIEWER'] as const;
export type TenantRoleKey = (typeof TENANT_ROLE_KEYS)[number];

export const PLATFORM_ROLE_KEYS = ['SUPER_ADMIN', 'DATA_STEWARD', 'BILLING_ADMIN', 'SUPPORT'] as const;
export type PlatformRoleKey = (typeof PLATFORM_ROLE_KEYS)[number];

export const ALERT_LEVELS = ['high', 'mid', 'low'] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number];

/** Стартовый пресет тем (сектора из прототипа). Тенант может расширять/менять. */
export const TOPIC_PRESET = [
  { key: 'agro', name: 'Агросектор', color: '#059669' },
  { key: 'fuel', name: 'Топливо/энергия', color: '#f59e0b' },
  { key: 'gov', name: 'Госуправление', color: '#3363ff' },
  { key: 'food', name: 'Пищевая пром.', color: '#8b5cf6' },
  { key: 'city', name: 'Город/ЖКХ', color: '#0ea5e9' },
  { key: 'econ', name: 'Экономика', color: '#e11d48' },
  { key: 'soc', name: 'Общество', color: '#64748b' },
] as const;
export type TopicKey = (typeof TOPIC_PRESET)[number]['key'];
