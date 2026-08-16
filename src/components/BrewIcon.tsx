import type { SVGProps } from "react";

type BrewIconProps = {
  size?: number;
  /** Invert the coffee fill for use on a solid accent background. */
  onAccent?: boolean;
  /** Gentle rising steam — used while a reply is brewing. */
  animateSteam?: boolean;
} & SVGProps<SVGSVGElement>;

/**
 * Theme-aware BrewLM mark: line-art cup that follows `currentColor`,
 * with the coffee surface filled from the active theme accent.
 */
export function BrewIcon({
  size = 24,
  className,
  onAccent = false,
  animateSteam = false,
  strokeWidth = 1.8,
  ...rest
}: BrewIconProps) {
  const coffeeFill = onAccent ? "var(--color-canvas)" : "var(--color-accent)";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={className}
      {...rest}
    >
      <g
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path
          className={animateSteam ? "brew-steam brew-steam-a" : undefined}
          d="M9.55 8.15c-.75-1.05.7-1.65.15-2.8C9.15 4.2 10.4 3.4 10.4 3.15"
        />
        <path
          className={animateSteam ? "brew-steam brew-steam-b" : undefined}
          d="M13.05 8.35c.65-.85-.15-1.55.45-2.5.55-.9-.25-1.7-.2-1.85"
        />
        <ellipse cx="11.15" cy="10.7" rx="6.15" ry="2.05" />
        <ellipse cx="11.15" cy="10.78" rx="4.7" ry="1.22" fill={coffeeFill} stroke="none" />
        <path d="M5 10.7c.18 4.55 2.55 7.55 6.15 7.55 3.6 0 5.97-3 6.15-7.55" />
        <path d="M17.3 11.75c2.35.4 3.5 2.2 2.35 3.95-1.05 1.6-2.9 1.9-4.1 1.1" />
        <path d="M6.85 20.2c1.4.7 2.85 1.05 4.3 1.05 1.45 0 2.9-.35 4.3-1.05" />
      </g>
    </svg>
  );
}
