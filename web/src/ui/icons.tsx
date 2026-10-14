// Small inline icons, sized by the surrounding font.
type IconProps = { className?: string };

const base = {
  width: "1em",
  height: "1em",
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export const CheckIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M3.5 8.5l3 3 6-7" />
  </svg>
);

export const CrossIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </svg>
);

export const AlertIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M8 4.5v4.25M8 11.25v.25" />
  </svg>
);

export const ChevronIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4.5 6.5l3.5 3.5 3.5-3.5" />
  </svg>
);

export const ExternalIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M9.5 3.5h3v3M12.5 3.5L7.5 8.5M11 9.5v3h-7.5v-7.5h3" />
  </svg>
);

export const CopyIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <rect x="5.5" y="5.5" width="7" height="7" rx="1.5" />
    <path d="M3.5 10.5v-6a1 1 0 0 1 1-1h6" />
  </svg>
);

export const ArrowIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M3 8h10M9.5 4.5L13 8l-3.5 3.5" />
  </svg>
);

// Two tracks splitting at a switch, for the brand mark.
export const SwitchyardMark = (p: IconProps) => (
  <svg {...base} viewBox="0 0 20 20" strokeWidth={2} {...p}>
    <path d="M3 16V10c0-3 2-5 5-5h9" />
    <path d="M3 10v-6" />
    <path d="M13 2l4 3-4 3" />
  </svg>
);
