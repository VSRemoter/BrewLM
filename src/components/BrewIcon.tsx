import type { SVGProps } from "react";

type BrewIconProps = {
  size?: number;
  /** Gentle rising steam — used while a reply is brewing. */
  animateSteam?: boolean;
} & SVGProps<SVGSVGElement>;

/**
 * Theme-aware BrewLM mark: the app icon's solid mug in `currentColor`
 * (same shapes as src-tauri/icons/brewlm-icon.svg, mapped to a 24 grid).
 * `strokeWidth` sets the steam weight.
 */
export function BrewIcon({
  size = 24,
  className,
  animateSteam = false,
  strokeWidth = 1.8,
  style,
  ...rest
}: BrewIconProps) {
  const steam = Number(strokeWidth) * 0.8;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={className}
      style={{ overflow: "visible", ...style }}
      {...rest}
    >
      <g fill="none" stroke="currentColor" strokeWidth={steam} strokeLinecap="round">
        <path
          className={animateSteam ? "brew-steam brew-steam-a" : undefined}
          d="M6.43 5.83C5.06 4.37 7.8 3.17 6.43 1.29"
        />
        <path
          className={animateSteam ? "brew-steam brew-steam-b" : undefined}
          d="M11.06 5.83C9.69 4.37 12.43 3.17 11.06 1.29"
        />
      </g>
      <path d="M.69 9.09C.69 8.49 1.2 7.97 1.8 7.97H15.69C16.29 7.97 16.8 8.49 16.8 9.09V17.49C16.8 20.4 14.49 22.71 11.57 22.71H5.91C3 22.71.69 20.4.69 17.49Z" />
      <path d="M16.03 10.11H18.86C21.6 10.11 23.31 12 23.31 14.74 23.31 17.49 21.6 19.37 18.86 19.37H16.03V16.89H18.69C20.06 16.89 20.83 16.03 20.83 14.74 20.83 13.46 20.06 12.6 18.69 12.6H16.03Z" />
    </svg>
  );
}
