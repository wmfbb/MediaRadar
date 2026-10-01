'use client';
import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
import { cn } from '../cn';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export interface ChartTheme {
  fg: string;
  muted: string;
  line: string;
  surface: string;
  dark: boolean;
}

const read = (name: string, fallback: string) =>
  typeof document === 'undefined'
    ? fallback
    : getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** Цвета графиков берутся из токенов темы и обновляются при её смене (класс .dark на <html>). */
export function useChartTheme(): ChartTheme {
  const compute = (): ChartTheme => ({
    fg: read('--fg', '#0f172a'),
    muted: read('--muted', '#5b6b82'),
    line: read('--line', '#e9edf4'),
    surface: read('--surface', '#fff'),
    dark: typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  });
  const [theme, setTheme] = useState<ChartTheme>(compute);
  useEffect(() => {
    setTheme(compute());
    const mo = new MutationObserver(() => setTheme(compute()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

export const axisStyle = (t: ChartTheme) => ({
  axisLine: { lineStyle: { color: t.line } },
  axisTick: { show: false },
  axisLabel: { color: t.muted, fontSize: 11 },
  splitLine: { lineStyle: { color: t.line } },
});

export function Chart({
  option,
  height = 240,
  className,
  label,
}: {
  option: EChartsCoreOption;
  height?: number;
  className?: string;
  label: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts | null>(null);
  const t = useChartTheme();

  useEffect(() => {
    if (!el.current) return;
    const chart = echarts.init(el.current, undefined, { renderer: 'canvas' });
    inst.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      inst.current = null;
    };
  }, []);

  useEffect(() => {
    inst.current?.setOption(
      {
        animationDuration: 500,
        textStyle: { color: t.muted, fontFamily: 'Inter Variable, Inter, system-ui, sans-serif' },
        tooltip: {
          backgroundColor: t.surface,
          borderColor: t.line,
          textStyle: { color: t.fg, fontSize: 12 },
          ...(option as { tooltip?: object }).tooltip,
        },
        ...option,
      },
      { notMerge: true },
    );
  }, [option, t]);

  return (
    <div ref={el} role="img" aria-label={label} className={cn('w-full', className)} style={{ height }} />
  );
}

export function Sparkline({ data, color, label }: { data: number[]; color: string; label: string }) {
  const option: EChartsCoreOption = {
    animation: false,
    grid: { left: 0, right: 0, top: 2, bottom: 0 },
    xAxis: { type: 'category', show: false, data: data.map((_, i) => i) },
    yAxis: { type: 'value', show: false, min: 0 },
    tooltip: { show: false },
    series: [
      {
        type: 'line',
        data,
        smooth: 0.4,
        symbol: 'none',
        lineStyle: { width: 1.8, color },
        areaStyle: { color, opacity: 0.12 },
      },
    ],
  };
  return <Chart option={option} height={34} label={label} />;
}
