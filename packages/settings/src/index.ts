import { z } from 'zod';
import {
  AppError,
  CONTENT_POLICIES,
  DEFAULT_CONTENT_POLICY,
  SOURCE_KINDS,
  type SourceKind,
} from '@mediaradar/core';
import type { Permission } from '@mediaradar/rbac';

/**
 * Реестр настроек (PRODUCT_SPEC §10). Любое поведение, которое хочется менять без релиза,
 * описывается здесь: тип, значение по умолчанию, области действия, кто может менять.
 * Значения хранятся в БД (таблица settings) с историей и аудитом; здесь — только определения.
 */
export type SettingScope = 'platform' | 'tenant' | 'source' | 'user';
/** Порядок специфичности: чем правее, тем приоритетнее. */
export const SCOPE_ORDER: SettingScope[] = ['platform', 'tenant', 'source', 'user'];

export interface SettingDefinition<T = unknown> {
  key: string;
  group: string;
  title: string;
  description: string;
  schema: z.ZodType<T>;
  default: T;
  /** Где значение можно задавать. */
  scopes: SettingScope[];
  /** Кто может менять на каждом уровне: разрешение или 'self' (владелец настройки). */
  editPermission: Partial<Record<SettingScope, Permission | 'self'>>;
  ui: {
    kind: 'bool' | 'number' | 'enum' | 'text' | 'multi';
    options?: Array<{ value: string; label: string }>;
    unit?: string;
  };
  secret?: boolean;
  requiresRestart?: boolean;
  affectsBilling?: boolean;
}

export const GROUP_TITLES: Record<string, string> = {
  content: 'Контент и авторские права',
  backfill: 'Ретро-сбор',
  schedule: 'Расписание сбора',
  fetch: 'Сетевой сбор',
  nlp: 'NLP-конвейер',
  ai: 'AI и бюджеты',
  retention: 'Хранение данных',
  moderation: 'Модерация',
  alerts: 'Алерты',
  reports: 'Отчёты',
  portal: 'Публичный портал',
  discovery: 'AI-дискавери',
  legal: 'Юридический профиль',
  ui: 'Интерфейс',
  auth: 'Доступ и безопасность',
  integrations: 'Интеграции',
};

const REGISTRY = new Map<string, SettingDefinition>();

function def<T>(d: SettingDefinition<T>): void {
  if (REGISTRY.has(d.key)) throw new Error(`Duplicate setting key: ${d.key}`);
  const parsed = d.schema.safeParse(d.default);
  if (!parsed.success) throw new Error(`Default for ${d.key} does not satisfy its schema`);
  for (const s of d.scopes)
    if (!d.editPermission[s]) throw new Error(`Setting ${d.key}: no edit permission for scope ${s}`);
  REGISTRY.set(d.key, d as SettingDefinition);
}

const opts = (m: Record<string, string>) => Object.entries(m).map(([value, label]) => ({ value, label }));
const POLICY_OPTS = opts({
  full: 'Полный текст',
  excerpt: 'Заголовок + лид + ссылка',
  metadata: 'Только метаданные',
});
const T_SETTINGS: Permission = 'tenant:settings';
const T_BASIC: Permission = 'tenant:settings_basic';

// --- content ---------------------------------------------------------------------------------
for (const kind of Object.keys(SOURCE_KINDS) as SourceKind[]) {
  def({
    key: `content.policy.default.${kind}`,
    group: 'content',
    title: `Политика контента по умолчанию: ${SOURCE_KINDS[kind]}`,
    description:
      'Что отдаём пользователям из материалов этого типа источников. Источник или тенант могут переопределить.',
    schema: z.enum(CONTENT_POLICIES),
    default: DEFAULT_CONTENT_POLICY[kind],
    scopes: ['platform', 'tenant'],
    editPermission: { platform: 'platform:settings', tenant: T_SETTINGS },
    ui: { kind: 'enum', options: POLICY_OPTS },
  });
}
def({
  key: 'content.policy.override',
  group: 'content',
  title: 'Политика контента: переопределение',
  description: 'Если задано — заменяет политику по умолчанию для тенанта или конкретного источника.',
  schema: z.enum(CONTENT_POLICIES).nullable(),
  default: null,
  scopes: ['tenant', 'source'],
  editPermission: { tenant: T_SETTINGS, source: 'platform:sources' },
  ui: { kind: 'enum', options: POLICY_OPTS },
});
def({
  key: 'content.excerpt.maxChars',
  group: 'content',
  title: 'Длина лида (символов)',
  description: 'Максимальная длина выжимки при политике «заголовок + лид + ссылка».',
  schema: z.number().int().min(100).max(2000),
  default: 400,
  scopes: ['platform', 'tenant'],
  editPermission: { platform: 'platform:settings', tenant: T_SETTINGS },
  ui: { kind: 'number', unit: 'симв.' },
});

// --- backfill --------------------------------------------------------------------------------
def({
  key: 'backfill.defaultDepthDays',
  group: 'backfill',
  title: 'Глубина ретро-сбора по умолчанию',
  description: 'На сколько дней назад собирать материалы при подключении источника.',
  schema: z.number().int().min(1).max(3650),
  default: 365,
  scopes: ['platform', 'tenant', 'source'],
  editPermission: { platform: 'platform:settings', tenant: T_SETTINGS, source: 'platform:sources' },
  ui: { kind: 'number', unit: 'дн.' },
});
def({
  key: 'backfill.maxDepthDays',
  group: 'backfill',
  title: 'Максимальная глубина ретро-сбора',
  description: 'Верхний предел, который нельзя превысить ни на одном уровне.',
  schema: z.number().int().min(1).max(7300),
  default: 1095,
  scopes: ['platform'],
  editPermission: { platform: 'platform:settings' },
  ui: { kind: 'number', unit: 'дн.' },
});
def({
  key: 'backfill.rps',
  group: 'backfill',
  title: 'Скорость ретро-сбора (запросов/с на источник)',
  description: 'Ограничение, чтобы не нагружать сайт и не получить блокировку.',
  schema: z.number().min(0.05).max(20),
  default: 0.5,
  scopes: ['platform', 'source'],
  editPermission: { platform: 'platform:settings', source: 'platform:sources' },
  ui: { kind: 'number', unit: 'зап/с' },
});
def({
  key: 'backfill.priority',
  group: 'backfill',
  title: 'Приоритет ретро-сбора',
  description: 'Приоритет очереди ретро-сбора относительно живого потока.',
  schema: z.enum(['low', 'normal']),
  default: 'low',
  scopes: ['platform', 'source'],
  editPermission: { platform: 'platform:settings', source: 'platform:sources' },
  ui: { kind: 'enum', options: opts({ low: 'Низкий', normal: 'Обычный' }) },
});

// --- schedule / fetch -----------------------------------------------------------------------
def({
  key: 'schedule.minIntervalSec',
  group: 'schedule',
  title: 'Минимальный интервал опроса',
  description: 'Чаще этого значения источник опрашиваться не будет, даже при адаптивной частоте.',
  schema: z.number().int().min(10).max(86400),
  default: 60,
  scopes: ['platform', 'source'],
  editPermission: { platform: 'platform:settings', source: 'platform:sources' },
  ui: { kind: 'number', unit: 'сек.' },
});
def({
  key: 'schedule.maxIntervalSec',
  group: 'schedule',
  title: 'Максимальный интервал опроса',
  description: 'Реже этого значения источник опрашиваться не будет.',
  schema: z.number().int().min(60).max(604800),
  default: 21600,
  scopes: ['platform', 'source'],
  editPermission: { platform: 'platform:settings', source: 'platform:sources' },
  ui: { kind: 'number', unit: 'сек.' },
});
def({
  key: 'schedule.adaptive.enabled',
  group: 'schedule',
  title: 'Адаптивная частота опроса',
  description: 'Чаще опрашивать активные источники и реже — тихие.',
  schema: z.boolean(),
  default: true,
  scopes: ['platform', 'source'],
  editPermission: { platform: 'platform:settings', source: 'platform:sources' },
  ui: { kind: 'bool' },
});
def({
  key: 'fetch.respectRobots',
  group: 'fetch',
  title: 'Соблюдать robots.txt',
  description: 'Отключение для конкретного источника допустимо только вручную и фиксируется в аудите.',
  schema: z.boolean(),
  default: true,
  scopes: ['platform', 'source'],
  editPermission: { platform: 'platform:settings', source: 'platform:sources' },
  ui: { kind: 'bool' },
});
def({
  key: 'fetch.perHostRps',
  group: 'fetch',
  title: 'Запросов в секунду на один сайт',
  description: 'Вежливость к сайту: общий лимит на домен.',
  schema: z.number().min(0.05).max(20),
  default: 1,
  scopes: ['platform', 'source'],
  editPermission: { platform: 'platform:settings', source: 'platform:sources' },
  ui: { kind: 'number', unit: 'зап/с' },
});
def({
  key: 'fetch.userAgent',
  group: 'fetch',
  title: 'User-Agent сборщика',
  description: 'Честный идентификатор бота с контактом для владельцев сайтов.',
  schema: z.string().min(5).max(300),
  default: 'MediaRadarBot/1.0',
  scopes: ['platform'],
  editPermission: { platform: 'platform:settings' },
  ui: { kind: 'text' },
});

// --- nlp -------------------------------------------------------------------------------------
const STAGES: Array<[string, string, string, boolean]> = [
  ['dedupe', 'Дедупликация (SimHash)', 'Отсекает перепечатки между источниками', true],
  ['ner', 'Извлечение сущностей (NER)', 'Персоны, организации, локации, даты', true],
  ['sentiment', 'Анализ тональности', '5 градаций: от критической до очень позитивной', true],
  ['summary', 'AI-саммари', 'Краткое изложение длинных материалов', true],
  ['topics', 'Авто-рубрикация', 'Отраслевая классификация по темам', true],
  ['keywords', 'Ключевые слова', 'Основа для облака тем и поиска', true],
  ['fake_detection', 'Детекция фейков / маркировка', 'Сверка с первоисточником, флаг достоверности', false],
  ['translation', 'Перевод на другие языки', 'Готовность к выходу на новые рынки', false],
];
for (const [stage, title, description, on] of STAGES) {
  def({
    key: `nlp.pipeline.stages.${stage}.enabled`,
    group: 'nlp',
    title,
    description,
    schema: z.boolean(),
    default: on,
    scopes: ['platform', 'tenant'],
    editPermission: { platform: 'platform:settings', tenant: T_SETTINGS },
    ui: { kind: 'bool' },
    affectsBilling: stage === 'summary',
  });
}

// --- ai --------------------------------------------------------------------------------------
def({
  key: 'ai.budget.monthlyTokens',
  group: 'ai',
  title: 'Месячный бюджет AI-токенов',
  description: 'Лимит расхода токенов в месяц. По умолчанию задаётся тарифом.',
  schema: z.number().int().min(0),
  default: 1_000_000,
  scopes: ['platform', 'tenant'],
  editPermission: { platform: 'platform:ai', tenant: 'platform:ai' },
  ui: { kind: 'number', unit: 'токенов' },
  affectsBilling: true,
});
def({
  key: 'ai.budget.hardStop',
  group: 'ai',
  title: 'Жёсткая остановка при исчерпании бюджета',
  description: 'Если выключено — только предупреждение, расход продолжается.',
  schema: z.boolean(),
  default: true,
  scopes: ['platform', 'tenant'],
  editPermission: { platform: 'platform:ai', tenant: 'platform:ai' },
  ui: { kind: 'bool' },
  affectsBilling: true,
});

// --- retention -------------------------------------------------------------------------------
const RETENTION: Array<[string, string, number | null, string]> = [
  [
    'rawHtmlDays',
    'Хранение сырого HTML/JSON',
    90,
    'Сколько дней храним исходные документы для перепарсинга.',
  ],
  ['articleDays', 'Хранение нормализованных материалов', null, 'Пусто — бессрочно.'],
  ['aiCallLogDays', 'Хранение журнала AI-вызовов', 30, 'Срок хранения журнала запросов к моделям.'],
  ['fetchRunDays', 'Хранение журнала прогонов', 180, 'Агрегаты по прогонам хранятся бессрочно.'],
  ['auditDays', 'Хранение журнала аудита', 1095, 'Минимум для разбора инцидентов и требований комплаенса.'],
  ['reportDays', 'Хранение файлов отчётов', 365, 'Срок хранения сформированных PDF/XLSX/PPTX.'],
  ['chatMessageDays', 'Хранение сообщений чатов', 30, 'Чаты содержат персональные данные: срок короче.'],
];
for (const [k, title, dflt, description] of RETENTION) {
  def({
    key: `retention.${k}`,
    group: 'retention',
    title,
    description,
    schema: dflt === null ? z.number().int().min(1).nullable() : z.number().int().min(1).max(36500),
    default: dflt,
    scopes: ['platform', 'tenant'],
    editPermission: { platform: 'platform:settings', tenant: T_SETTINGS },
    ui: { kind: 'number', unit: 'дн.' },
  });
}

// --- misc ------------------------------------------------------------------------------------
def({
  key: 'moderation.mode',
  group: 'moderation',
  title: 'Режим модерации',
  description:
    'auto — публикуем сразу; manual — только после одобрения; hybrid — ручная проверка спорных источников.',
  schema: z.enum(['auto', 'manual', 'hybrid']),
  default: 'auto',
  scopes: ['platform', 'tenant', 'source'],
  editPermission: { platform: 'platform:settings', tenant: T_BASIC, source: 'platform:sources' },
  ui: { kind: 'enum', options: opts({ auto: 'Автопубликация', manual: 'Ручная', hybrid: 'Гибридная' }) },
});
def({
  key: 'alerts.dedupeWindowMin',
  group: 'alerts',
  title: 'Окно подавления дублей алертов',
  description: 'Повторные срабатывания в этом окне склеиваются в одно уведомление.',
  schema: z.number().int().min(1).max(1440),
  default: 30,
  scopes: ['platform', 'tenant'],
  editPermission: { platform: 'platform:settings', tenant: T_BASIC },
  ui: { kind: 'number', unit: 'мин.' },
});
def({
  key: 'reports.auto.requireReview',
  group: 'reports',
  title: 'Ручная проверка автообзоров перед публикацией',
  description: 'Автообзоры для публичного портала проходят проверку редактором.',
  schema: z.boolean(),
  default: true,
  scopes: ['platform', 'tenant'],
  editPermission: { platform: 'platform:settings', tenant: T_BASIC },
  ui: { kind: 'bool' },
});
def({
  key: 'portal.public.enabled',
  group: 'portal',
  title: 'Публичный портал включён',
  description: 'Открытая часть ленты без регистрации.',
  schema: z.boolean(),
  default: false,
  scopes: ['tenant'],
  editPermission: { tenant: T_SETTINGS },
  ui: { kind: 'bool' },
});
def({
  key: 'portal.public.showFullText',
  group: 'portal',
  title: 'Показывать полный текст на публичном портале',
  description:
    'Ограничено политикой контента источника: полный текст показывается только там, где он разрешён.',
  schema: z.boolean(),
  default: false,
  scopes: ['tenant'],
  editPermission: { tenant: T_SETTINGS },
  ui: { kind: 'bool' },
});
def({
  key: 'discovery.territory.levels',
  group: 'discovery',
  title: 'Уровни территорий для AI-дискавери',
  description: 'Ядро → города → районы → населённые пункты.',
  schema: z.array(z.enum(['core', 'cities', 'districts', 'settlements'])).min(1),
  default: ['core', 'cities'],
  scopes: ['tenant'],
  editPermission: { tenant: T_BASIC },
  ui: {
    kind: 'multi',
    options: opts({ core: 'Ядро', cities: 'Города', districts: 'Районы', settlements: 'Населённые пункты' }),
  },
});
def({
  key: 'legal.profile',
  group: 'legal',
  title: 'Юридический профиль',
  description: 'Набор правил обработки данных: 152-ФЗ, GDPR и т.д.',
  schema: z.enum(['RU_152', 'EU_GDPR']),
  default: 'RU_152',
  scopes: ['tenant'],
  editPermission: { tenant: T_SETTINGS },
  ui: { kind: 'enum', options: opts({ RU_152: 'РФ (152-ФЗ)', EU_GDPR: 'ЕС (GDPR)' }) },
});
def({
  key: 'ui.theme.default',
  group: 'ui',
  title: 'Тема интерфейса',
  description: 'Светлая, тёмная или системная.',
  schema: z.enum(['light', 'dark', 'system']),
  default: 'system',
  scopes: ['tenant', 'user'],
  editPermission: { tenant: T_BASIC, user: 'self' },
  ui: { kind: 'enum', options: opts({ light: 'Светлая', dark: 'Тёмная', system: 'Как в системе' }) },
});
def({
  key: 'auth.registration.open',
  group: 'auth',
  title: 'Открытая регистрация',
  description: 'Разрешить самостоятельную регистрацию с созданием нового тенанта.',
  schema: z.boolean(),
  default: false,
  scopes: ['platform'],
  editPermission: { platform: 'platform:settings' },
  ui: { kind: 'bool' },
});
def({
  key: 'auth.mfa.enforceForAdmins',
  group: 'auth',
  title: 'Обязательная 2FA для администраторов',
  description: 'OWNER, ADMIN и платформенные роли не смогут работать без включённой двухфакторной защиты.',
  schema: z.boolean(),
  default: true,
  scopes: ['platform'],
  editPermission: { platform: 'platform:settings' },
  ui: { kind: 'bool' },
});

// --- integrations ---------------------------------------------------------------------------
export const INTEGRATIONS: Array<{ id: string; name: string; description: string; phase: number }> = [
  { id: 'yookassa', name: 'ЮKassa', description: 'Эквайринг, подписки, возвраты, чеки 54-ФЗ', phase: 8 },
  {
    id: 'telegram_bot',
    name: 'Telegram Bot API',
    description: 'Уведомления, алерты, бот-интерфейс ленты',
    phase: 5,
  },
  {
    id: 'ai_gateway',
    name: 'AI Gateway',
    description: 'GigaChat, YandexGPT, Qwen, DeepSeek, локальные модели',
    phase: 3,
  },
  {
    id: 'email',
    name: 'Почта (SMTP / Unisender)',
    description: 'Рассылки дайджестов и системные письма',
    phase: 5,
  },
  {
    id: 'object_storage',
    name: 'Объектное хранилище (S3)',
    description: 'Изображения, PDF, бэкапы',
    phase: 1,
  },
  { id: 'dadata', name: 'Дадата', description: 'Обогащение: ЕГРЮЛ, адреса, ИНН', phase: 9 },
  { id: 'geocoder', name: 'Геокодер', description: 'Привязка материалов к координатам', phase: 4 },
  { id: 'translate', name: 'Переводчик', description: 'Мультиязычность для экспансии', phase: 9 },
];
for (const i of INTEGRATIONS) {
  def({
    key: `integrations.${i.id}.enabled`,
    group: 'integrations',
    title: i.name,
    description: i.description,
    schema: z.boolean(),
    default: false,
    scopes: ['platform', 'tenant'],
    editPermission: { platform: 'platform:settings', tenant: T_SETTINGS },
    ui: { kind: 'bool' },
  });
}

// ------------------------------------------------------------------------------------------------

export const listDefinitions = (): SettingDefinition[] => [...REGISTRY.values()];
export const getDefinition = (key: string): SettingDefinition | undefined => REGISTRY.get(key);

export function requireDefinition(key: string): SettingDefinition {
  const d = REGISTRY.get(key);
  if (!d) throw new AppError('not_found', `Неизвестная настройка: ${key}`);
  return d;
}

export function parseSettingValue(definition: SettingDefinition, raw: unknown): unknown {
  const r = definition.schema.safeParse(raw);
  if (r.success) return r.data;
  throw new AppError(
    'validation_failed',
    `Недопустимое значение для «${definition.title}»: ${r.error.issues.map((i) => i.message).join('; ')}`,
    r.error.issues,
  );
}

export function assertScopeAllowed(definition: SettingDefinition, scope: SettingScope): void {
  if (!definition.scopes.includes(scope))
    throw new AppError('bad_request', `Настройка ${definition.key} не может задаваться на уровне «${scope}»`);
}

export interface StoredSetting {
  scope_type: SettingScope;
  scope_id: string | null;
  value: unknown;
}
export interface ResolveContext {
  tenantId?: string | null;
  sourceId?: string | null;
  userId?: string | null;
}
export interface ResolvedSetting {
  value: unknown;
  from: SettingScope | 'default';
}

/** Выбирает значение самого специфичного подходящего уровня: user › source › tenant › platform › default. */
export function resolveSetting(
  definition: SettingDefinition,
  rows: StoredSetting[],
  ctx: ResolveContext,
): ResolvedSetting {
  let best: { rank: number; row: StoredSetting } | null = null;
  for (const row of rows) {
    if (!definition.scopes.includes(row.scope_type)) continue;
    const matches =
      (row.scope_type === 'platform' && row.scope_id === null) ||
      (row.scope_type === 'tenant' && !!ctx.tenantId && row.scope_id === ctx.tenantId) ||
      (row.scope_type === 'source' && !!ctx.sourceId && row.scope_id === ctx.sourceId) ||
      (row.scope_type === 'user' && !!ctx.userId && row.scope_id === ctx.userId);
    if (!matches) continue;
    const rank = SCOPE_ORDER.indexOf(row.scope_type);
    if (!best || rank > best.rank) best = { rank, row };
  }
  return best
    ? { value: best.row.value, from: best.row.scope_type }
    : { value: definition.default, from: 'default' };
}
