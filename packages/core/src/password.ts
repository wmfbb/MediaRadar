import { hash, verify } from '@node-rs/argon2';

// Алгоритм по умолчанию в @node-rs/argon2 — argon2id (проверяется тестом по префиксу хэша).
// Параметры по рекомендациям OWASP: m=19 MiB, t=2, p=1.
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string): Promise<string> => hash(password, OPTS);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

const COMMON = new Set([
  'password123', 'qwerty12345', '1234567890', 'qwertyuiop', 'password1234', 'iloveyou123', '12345678910',
  'йцукенгшщз', 'пароль12345', 'qwerty123456', 'admin12345', 'letmein12345',
]);

/** Возвращает текст ошибки или null, если пароль приемлем. */
export function checkPasswordPolicy(password: string, ctx: { email?: string } = {}): string | null {
  if (password.length < 10) return 'Пароль должен быть не короче 10 символов';
  if (password.length > 200) return 'Пароль слишком длинный';
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'Слишком простой пароль';
  if (ctx.email && lower.includes(ctx.email.split('@')[0]!.toLowerCase()) && ctx.email.split('@')[0]!.length >= 4)
    return 'Пароль не должен содержать адрес почты';
  if (new Set(password).size < 5) return 'Слишком мало разных символов';
  return null;
}

/** Предвычисленный хэш для выравнивания времени ответа при несуществующем пользователе. */
export const DUMMY_HASH_PROMISE = hashPassword('dummy-password-for-timing');
