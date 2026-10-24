import { useEffect, useState } from "react";

/** Phone-sized screens: the web app on a phone. The desktop window never gets this narrow (min 1024px). */
const PHONE = "(max-width: 767px)";
/** Too narrow for the notebook's three panels side by side: phones, and tablets held upright. */
export const NARROW = "(max-width: 1023px)";

/** True while the media query matches; follows rotation and resizes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** True on a phone-sized screen. */
export function usePhone(): boolean {
  return useMediaQuery(PHONE);
}
