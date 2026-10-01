import type { DictEntity, EntityHit } from './types';

const RU = 'А-Яа-яЁё';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unyo = (s: string) => s.replace(/ё/g, 'е').replace(/Ё/g, 'Е');

/**
 * Слово → шаблон с падежными окончаниями: у обычного слова отбрасывается последняя гласная/«й»/«ь»
 * (если слово длиннее 4 букв) и разрешаются до 3 любых букв после основы; сокращение (ЗАГС, МЧС) — только как есть.
 */
function wordPattern(word: string): string {
  if (word.length >= 2 && word === word.toUpperCase() && /[А-ЯA-Z]/.test(word)) return esc(word);
  const stem = word.length > 4 ? word.replace(/[аеиоуыэюяйь]$/i, '') : word;
  return `${esc(stem)}[${RU}]{0,3}`;
}

interface Compiled {
  entity: DictEntity;
  re: RegExp;
}

/**
 * Один шаблон на сущность — «все псевдонимы разом», длинные впереди. Правила регистра:
 *  - персона: первая буква каждого слова как в словаре (фамилия с заглавной), чтобы «Франк» не путался с «франком»;
 *  - организация из одного слова с заглавной (АКЗС, Сбер, Ростелеком): регистр важен;
 *  - остальные организации (несколько слов или строчные): без учёта регистра.
 */
export function compileDictionary(dict: DictEntity[]): Compiled[] {
  return dict.map((entity) => {
    const aliases = [...new Set([entity.name, ...entity.aliases])]
      .map(unyo)
      .sort((a, b) => b.length - a.length)
      .map((alias) => {
        const words = alias.split(/\s+/).filter(Boolean);
        return words.map(wordPattern).join('\\s+');
      });
    const strictCase =
      entity.type === 'person' ||
      (entity.aliases.length > 0 && entity.aliases.every((a) => !/\s/.test(a) && /^[А-ЯA-Z]/.test(a)));
    // у организации со смешанными псевдонимами регистр не учитывается: ложных срабатываний от многословных названий почти нет
    const flags = strictCase ? 'gu' : 'giu';
    const re = new RegExp(`(?<![${RU}])(?:${aliases.join('|')})(?![${RU}])`, flags);
    return { entity, re };
  });
}

const LEGAL_FORMS = '(?:ООО|АО|ПАО|ОАО|ЗАО|ИП|МУП|ГУП|ФГУП|АНО|НКО)';
const AUTO_LEGAL = new RegExp(`(?<![${RU}])(${LEGAL_FORMS})\\s*[«"“]([^»"”\\n]{2,60})[»"”]`, 'gu');
const AUTO_ADMIN = new RegExp(
  `(?<![${RU}])[Аа]дминистраци[яиюей]\\s+((?:города\\s+|района\\s+)?[А-ЯЁ][${RU}-]+(?:\\s+района)?)(?![${RU}])`,
  'gu',
);

/**
 * Персоны и организации в заголовке и лиде. Персоны — только из словаря; организации — из словаря
 * и по шаблонам («ООО «Название»», «Администрация Бийска»). Заголовок учитывается наравне с лидом,
 * поэтому число упоминаний = число вхождений в склеенный текст.
 */
export function extractEntities(text: string, compiled: Compiled[]): EntityHit[] {
  const t = unyo(text);
  const hits = new Map<string, EntityHit>();
  const add = (type: 'person' | 'org', name: string, auto: boolean) => {
    const key = `${type}:${name}`;
    const cur = hits.get(key);
    if (cur) cur.mentions++;
    else hits.set(key, { type, name, mentions: 1, auto });
  };
  for (const { entity, re } of compiled) {
    const n = [...t.matchAll(re)].length;
    for (let i = 0; i < n; i++) add(entity.type, entity.name, false);
  }
  // «ПАО «Россети»», если «Россети» уже есть в словаре, — это та же организация: отдельную запись не заводим
  const known = new Set(
    compiled
      .filter((c) => c.entity.type === 'org')
      .flatMap((c) => [c.entity.name, ...c.entity.aliases])
      .map((n) => unyo(n).toLowerCase()),
  );
  for (const m of t.matchAll(AUTO_LEGAL)) {
    const name = m[2]!.trim();
    if (!known.has(unyo(name).toLowerCase())) add('org', `${m[1]} «${name}»`, true);
  }
  for (const m of t.matchAll(AUTO_ADMIN)) {
    const place = m[1]!.replace(/\s+/g, ' ').trim();
    // «Администрация Барнаула», «Администрация города Бийска» → одна каноническая форма
    add('org', `Администрация ${place.replace(/^города\s+/, '')}`, true);
  }
  return [...hits.values()].sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name, 'ru'));
}
