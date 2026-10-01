import type { Mailer } from '../deps';

/** Пока нет почтового канала (Фаза 5) письма пишутся в лог. В dev ссылки из писем берутся оттуда. */
export class LogMailer implements Mailer {
  private log: { info: (obj: object, msg: string) => void } | null = null;
  /** Логгер приложения подключается после сборки Fastify. */
  attach(log: { info: (obj: object, msg: string) => void }): void {
    this.log = log;
  }
  async send(msg: { to: string; subject: string; text: string }): Promise<void> {
    this.log?.info({ mail: msg }, 'mail (не отправлено: почтовый канал не настроен)');
  }
}

/** Для тестов: складывает письма в память. */
export class CaptureMailer implements Mailer {
  sent: Array<{ to: string; subject: string; text: string }> = [];
  async send(msg: { to: string; subject: string; text: string }): Promise<void> {
    this.sent.push(msg);
  }
  last(): { to: string; subject: string; text: string } | undefined {
    return this.sent[this.sent.length - 1];
  }
}
