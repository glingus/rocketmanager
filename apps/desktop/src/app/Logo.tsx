export function LogoMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id="lm-metal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fbf5e8" />
          <stop offset="1" stopColor="#cdbd9f" />
        </linearGradient>
        <linearGradient id="lm-brass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f2d58f" />
          <stop offset="1" stopColor="#bd8c2a" />
        </linearGradient>
      </defs>
      <rect x="1.500" y="1.500" width="37" height="37" rx="9" fill="#3d150d" stroke="#d9a43a" strokeWidth="1.600" />
      <path d="M20 6c4.200 3.600 6.200 8.600 6.200 14.200v6.300l3.800 5.600h-5.200L20 34.800l-4.800-2.700H10l3.800-5.600v-6.300C13.800 14.600 15.800 9.600 20 6z" fill="url(#lm-metal)" />
      <circle cx="20" cy="16.500" r="3" fill="#6e2717" stroke="#d9a43a" strokeWidth="1.200" />
      <path d="M16.800 31.500h6.400L20 38z" fill="url(#lm-brass)" />
    </svg>
  );
}
