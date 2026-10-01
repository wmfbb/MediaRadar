import type { SVGProps } from 'react';

const PATHS = {
  dashboard: ['M3 13h8V3H3v10zm10 8h8V11h-8v10zM3 21h8v-6H3v6zm10-12h8V3h-8v6z'],
  feed: ['M4 6h16M4 12h16M4 18h10'],
  chart: ['M4 19V5m0 14h16M8 16v-5m4 5V8m4 8v-3'],
  source: ['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm0 0v18M4 7.5l8 4.5 8-4.5'],
  bell: ['M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8zM13.7 21a2 2 0 01-3.4 0'],
  report: ['M9 12h6m-6 4h6M9 8h2m1 13H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2h-1'],
  users: [
    'M16 20v-1.5a4 4 0 00-4-4H7a4 4 0 00-4 4V20M9.5 9.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM22 20v-1.5a4 4 0 00-3-3.87M16 2.63a4 4 0 010 7.75',
  ],
  settings: [
    'M12 15a3 3 0 100-6 3 3 0 000 6z',
    'M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1A1.6 1.6 0 007.5 19.4l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.6 1.6 0 003.6 14H3a2 2 0 110-4h.1a1.6 1.6 0 001.1-2.7l-.1-.1a2 2 0 112.8-2.8l.1.1A1.6 1.6 0 0010 3.6V3a2 2 0 114 0v.1a1.6 1.6 0 002.7 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 001.1 2.7H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1.3z',
  ],
  card: ['M3 10h18M5 6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2z'],
  search: ['M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-3.5-3.5'],
  plus: ['M12 5v14M5 12h14'],
  x: ['M6 6l12 12M18 6L6 18'],
  check: ['M5 12l5 5L20 7'],
  play: ['M8 5l11 7-11 7V5z'],
  pause: ['M8 5v14M16 5v14'],
  refresh: ['M4 4v6h6M20 20v-6h-6M20 9A8 8 0 006.3 5.7L4 8M4 15a8 8 0 0013.7 3.3L20 16'],
  external: ['M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5'],
  eye: ['M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z', 'M12 15a3 3 0 100-6 3 3 0 000 6z'],
  sun: [
    'M12 3v2m0 14v2M5.6 5.6l1.4 1.4m10 10l1.4 1.4M3 12h2m14 0h2M5.6 18.4L7 17m10-10l1.4-1.4M12 16a4 4 0 100-8 4 4 0 000 8z',
  ],
  moon: ['M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z'],
  logout: ['M15 17l5-5-5-5M20 12H9M12 20H5a1 1 0 01-1-1V5a1 1 0 011-1h7'],
  chevronDown: ['M6 9l6 6 6-6'],
  updown: ['M8 9l4-4 4 4M8 15l4 4 4-4'],
  lock: ['M7 11V8a5 5 0 0110 0v3M5 11h14v10H5z'],
  pin: ['M12 21s7-5.1 7-11a7 7 0 10-14 0c0 5.9 7 11 7 11z', 'M12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z'],
  menu: ['M4 6h16M4 12h16M4 18h16'],
  trash: ['M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'],
  history: ['M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8M3 3v5h5M12 7v5l3 2'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z'],
  info: ['M12 8h.01M11 12h1v5h1', 'M12 21a9 9 0 100-18 9 9 0 000 18z'],
  alert: ['M12 9v4m0 4h.01', 'M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z'],
  building: ['M4 21V5l8-2v18M12 9l8 2v10M4 21h16M8 8h.01M8 12h.01M8 16h.01M16 14h.01M16 18h.01'],
  flag: ['M5 21V4m0 0h11l-2 4 2 4H5'],
  list: ['M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'],
} as const;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.8,
  ...rest
}: { name: IconName; size?: number; strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
