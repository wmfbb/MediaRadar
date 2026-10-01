import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Avatar, Button, Field, Input, Progress, Segmented, Switch, Tabs } from '../src';
import { cn } from '../src/cn';

afterEach(cleanup);

describe('cn', () => {
  it('склеивает классы и отбрасывает ложные значения', () => {
    expect(cn('a', false, undefined, null, 'b')).toBe('a b');
  });
});

describe('Button', () => {
  it('в состоянии loading заблокирована и помечена aria-busy', () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Сохранить</Button>);
    const b = screen.getByRole('button', { name: 'Сохранить' });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });
  it('по умолчанию type=button, чтобы не отправлять формы случайно', () => {
    render(<Button>Ок</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });
});

describe('Switch', () => {
  it('отдаёт инвертированное значение и отражает aria-checked', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Switch checked={false} onChange={onChange} label="Алерт включён" />);
    const sw = screen.getByRole('switch', { name: 'Алерт включён' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<Switch checked onChange={onChange} label="Алерт включён" />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });
  it('заблокированный переключатель не вызывает onChange', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} disabled onChange={onChange} label="x" />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Field', () => {
  it('связывает подпись с полем и показывает ошибку как alert', () => {
    render(<Field label="Email" error="Неверный формат">{(id) => <Input id={id} />}</Field>);
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Неверный формат');
  });
  it('подсказка скрывается, когда есть ошибка', () => {
    const { rerender } = render(<Field label="Пароль" hint="От 10 символов">{(id) => <Input id={id} />}</Field>);
    expect(screen.getByText('От 10 символов')).toBeInTheDocument();
    rerender(<Field label="Пароль" hint="От 10 символов" error="Слишком короткий">{(id) => <Input id={id} />}</Field>);
    expect(screen.queryByText('От 10 символов')).toBeNull();
  });
});

describe('Segmented и Tabs', () => {
  const opts = [{ value: 'a', label: 'Первый' }, { value: 'b', label: 'Второй' }] as const;
  it('Segmented переключает значение', () => {
    const onChange = vi.fn();
    render(<Segmented value="a" onChange={onChange} options={[...opts]} label="Период" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Второй' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });
  it('Tabs показывает счётчики и выбранную вкладку', () => {
    const onChange = vi.fn();
    render(<Tabs value="a" onChange={onChange} options={[{ value: 'a', label: 'Все', count: 18 }, { value: 'b', label: 'Пауза', count: 1 }]} />);
    expect(screen.getByRole('tab', { name: /Все/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: /Пауза/ }));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('Progress и Avatar', () => {
  it('Progress не ломается без лимита и на нуле', () => {
    const { container, rerender } = render(<Progress value={5} max={null} />);
    expect(container.firstChild).toBeTruthy();
    rerender(<Progress value={0} max={0} />);
    expect(container.firstChild).toBeTruthy();
  });
  it('Avatar строит инициалы из имени', () => {
    render(<Avatar name="Алексей Прохоров" />);
    expect(screen.getByText('АП')).toBeInTheDocument();
  });
});
