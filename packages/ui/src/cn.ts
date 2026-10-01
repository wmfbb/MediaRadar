export type ClassValue = string | false | null | undefined | ClassValue[];
export function cn(...v: ClassValue[]): string {
  return v.flat(Infinity as 1).filter(Boolean).join(' ');
}
