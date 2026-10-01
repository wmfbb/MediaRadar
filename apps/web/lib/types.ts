/** Типы ответов API, используемые интерфейсом. */
export interface Me {
  preferences: { theme: 'light' | 'dark' | 'system' };
  user: { id: string; email: string; name: string; locale: string; platformRole: string | null };
  mfa: { enrolled: boolean; verified: boolean; setupRequired: boolean };
  tenant: {
    id: string;
    slug: string;
    name: string;
    branding: { productName?: string; color?: string };
    regionProfile: { core?: string; timezone?: string };
  } | null;
  plan: { key: string; name: string; status: string; periodEnd: string | null } | null;
  role: { key: string; name: string } | null;
  scope: { topics?: string[] };
  permissions: string[];
  tenants: Array<{ id: string; slug: string; name: string; role: string; roleName: string }>;
}

export interface ArticleCard {
  id: string;
  title: string;
  lead: string | null;
  url: string;
  publishedAt: string;
  views: number;
  geo: string | null;
  sentiment: { label: 'VP' | 'P' | 'N' | 'NG' | 'VN'; score: number } | null;
  source: { id: string; name: string; domain: string; kind: string; trust: number };
  topic: { key: string; name: string; color: string } | null;
  persons: string[];
  orgs: string[];
  policy: 'full' | 'excerpt' | 'metadata';
  /** Ссылка на картинку источника (подтягивается при показе; при ошибке — заглушка). */
  imageUrl: string | null;
  /** «Удалено на источнике»: запись у нас остаётся, removedAt — когда обнаружили (сохраняется и после возвращения материала). */
  sourceState: 'available' | 'removed';
  removedAt: string | null;
  restoredAt: string | null;
}
export interface ArticleDetail extends ArticleCard {
  body: string | null;
  summary: string | null;
  related: ArticleCard[];
}
export interface ArticlePage {
  items: ArticleCard[];
  total: number;
  nextCursor: string | null;
  nextOffset: number | null;
}

export interface Facets {
  topics: Array<{ key: string; name: string; color: string; count: number }>;
  kinds: Array<{ key: string; label: string; count: number }>;
  sentiment: Array<{ key: string; label: string; count: number }>;
  geo: Array<{ name: string; count: number }>;
  sources: Array<{ id: string; name: string; domain: string; count: number }>;
}
