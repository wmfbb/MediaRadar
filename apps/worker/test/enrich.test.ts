import { describe, expect, it } from 'vitest';
import { REAL_ENTITIES } from '@mediaradar/db';
import { rulesAnalyzer } from '../src/enrich/rules';
import { analyzeSentiment } from '../src/enrich/sentiment';
import { analyzeTopic } from '../src/enrich/topics';
import type { Analysis, DictEntity } from '../src/enrich/types';

const dict: DictEntity[] = REAL_ENTITIES.map((e) => ({ type: e.type, name: e.name, aliases: e.aliases }));
const analyze = (title: string, lead: string | null = null) =>
  rulesAnalyzer.analyze({ title, lead }, dict) as Analysis;

describe('тональность', () => {
  it('нет слов из словаря — нейтрально, оценка 0', () => {
    expect(analyzeSentiment('Заседание комитета состоится в четверг', null)).toEqual({
      score: 0,
      label: 'N',
    });
  });
  it('гибель людей — критическая, награда — позитивная', () => {
    expect(analyzeSentiment('В ДТП на трассе погибли два человека', null).label).toBe('VN');
    expect(analyzeSentiment('Коллектив завода награждён за успехи', null).label).toMatch(/^(P|VP)$/);
  });
  it('«не» и «без» переворачивают смысл: «без пострадавших» не негатив', () => {
    expect(analyzeSentiment('Пожар потушили, никто не пострадал', null).score).toBeGreaterThan(
      analyzeSentiment('Пожар потушили, трое пострадали', null).score,
    );
    expect(analyzeSentiment('Авария без пострадавших', null).score).toBeGreaterThan(0);
  });
  it('«защиты от мошенников» — позитив, а «мошенники украли» — негатив', () => {
    expect(
      analyzeSentiment('Новая защита: красная кнопка для защиты от мошенников', null).score,
    ).toBeGreaterThan(0);
    expect(analyzeSentiment('Мошенники украли у пенсионера миллион', null).score).toBeLessThan(-0.2);
  });
  it('повтор одного слова почти ничего не добавляет, оценка остаётся в −1…+1', () => {
    const once = analyzeSentiment('Пожар в бане', null).score;
    const many = analyzeSentiment('Пожар в бане', 'Пожар. Пожар. Пожар. Пожар. Пожар. Пожар.').score;
    expect(many).toBeLessThan(once);
    expect(many).toBeGreaterThan(-1);
    expect(many).toBeGreaterThanOrEqual(-0.8); // повторы не уводят оценку в крайность
  });
});

describe('тема', () => {
  it.each([
    ['Более 700 тонн сахарной свёклы уже собрали в Алтайском крае', 'agro'],
    ['В Барнауле начался отопительный сезон', 'city'],
    ['Центробанк сохранил ключевую ставку, рубль укрепился', 'econ'],
    ['Депутаты Заксобрания утвердили бюджет края', 'gov'],
    ['Школьники Бийска выиграли олимпиаду', 'soc'],
  ])('«%s» → %s', (title, topic) => {
    expect(analyzeTopic(title, null)).toBe(topic);
  });
  it('материал вне региональных секторов остаётся без темы', () => {
    expect(analyzeTopic('Сводка СВО на 30 сентября: ВСУ атаковали беспилотниками', null)).toBeNull();
    expect(analyzeTopic('Погода всегда хороша', null)).toBeNull();
  });
  it('новость про войну не уходит в «Госуправление» из-за упоминания президента', () => {
    expect(analyzeTopic('Путин заявил о перемирии: сводка СВО, удары БПЛА по Украине', null)).toBeNull();
  });
});

describe('персоны и организации', () => {
  const names = (a: { entities: Array<{ type: string; name: string }> }, type: string) =>
    a.entities.filter((e) => e.type === type).map((e) => e.name);

  it('находит персон из словаря в любом падеже, считает упоминания', () => {
    const a = analyze(
      'Губернатору Виктору Томенко доложили',
      'Томенко поручил проверить. Позже Томенко подписал указ.',
    );
    expect(a.entities.find((e) => e.name === 'Виктор Томенко')).toMatchObject({
      type: 'person',
      mentions: 3,
    });
  });
  it('регистр важен: «Франк» — персона, «франк» (валюта) — нет', () => {
    expect(names(analyze('Вячеслав Франк открыл сквер'), 'person')).toEqual(['Вячеслав Франк']);
    expect(names(analyze('Курс швейцарского франка вырос'), 'person')).toEqual([]);
  });
  it('персон вне словаря не придумывает', () => {
    expect(names(analyze('Директор завода Иван Петров получил награду'), 'person')).toEqual([]);
  });
  it('организации: словарь, сокращения и шаблоны (ООО «…», Администрация …)', () => {
    const a = analyze(
      'УФАС возбудило дело против ООО «Алтайтюн»',
      'В администрации Бийска и Заксобрании это обсудили. МЧС и Роспотребнадзор проверили объект.',
    );
    expect(names(a, 'org').sort()).toEqual(
      [
        'УФАС',
        'ООО «Алтайтюн»',
        'Администрация Бийска',
        'Алтайское краевое Законодательное Собрание',
        'МЧС',
        'Роспотребнадзор',
      ].sort(),
    );
  });
  it('организация из словаря с юридической формой не дублируется', () => {
    expect(names(analyze('Сотрудники ПАО «Россети» провели уроки'), 'org')).toEqual(['Россети']);
  });
  it('«МЧС» не находится внутри чужих слов', () => {
    expect(names(analyze('Сумчс и мчсистема — не организации'), 'org')).toEqual([]);
  });
  it('результат разметки целиком: тема, тональность, сущности', () => {
    const a = analyze(
      'Томенко открыл новую школу в Бийске',
      'Администрация Бийска поддержала проект, строительство завершили досрочно.',
    );
    expect(a.topic).toBe('soc');
    expect(a.sentiment.label).toMatch(/^(P|VP)$/);
    expect(names(a, 'person')).toEqual(['Виктор Томенко']);
    expect(names(a, 'org')).toEqual(['Администрация Бийска']);
  });
});
