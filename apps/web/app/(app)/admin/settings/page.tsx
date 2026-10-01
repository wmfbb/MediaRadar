'use client';
import { PageHeader } from '@/components/page';
import { SettingsPanel } from '@/components/settings-panel';

export default function Page() {
  return (
    <div className="mr-fade-up">
      <PageHeader
        eyebrow="Платформа"
        title="Настройки платформы"
        subtitle="Значения по умолчанию для всех тенантов. Тенанты могут переопределять только разрешённые ключи."
      />
      <SettingsPanel view="platform" />
    </div>
  );
}
