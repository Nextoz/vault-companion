import { createContext, useCallback, useContext, useEffect, useState, type RefObject } from 'react';

type Register = (el: HTMLElement, text: string) => () => void;

const LargeTitleContext = createContext<Register | null>(null);

/**
 * Review #8: the one large-title pattern. The screen's title is a real `<h1 class="large-title">` in the content;
 * once it has scrolled under the top bar, the bar fades in the same text as a centred 17 px title. Screens render
 * this instead of their own big h1/h2; extra classes (e.g. `today-title`) keep screen-specific spacing.
 */
export function LargeTitle({ children, className }: { children: string; className?: string }) {
  const register = useContext(LargeTitleContext);
  // React 19 ref cleanup: the title is withdrawn when this element unmounts or its text changes.
  const ref = useCallback((el: HTMLHeadingElement | null) => (el && register ? register(el, children) : undefined), [register, children]);
  return <h1 ref={ref} className={className ? `large-title ${className}` : 'large-title'}>{children}</h1>;
}

export const LargeTitleProvider = LargeTitleContext.Provider;

/**
 * The bar's side of the pattern: which large title is on screen and whether it has scrolled under the bar. An
 * IntersectionObserver with the bar's height as the top margin decides; no scroll handler.
 */
export function useLargeTitleHost(barRef: RefObject<HTMLElement | null>) {
  const [titles, setTitles] = useState<readonly { el: HTMLElement; text: string }[]>([]);
  // Which title element is under the bar: a new screen's title is never collapsed until its own observer says so.
  const [collapsedEl, setCollapsedEl] = useState<HTMLElement | null>(null);
  const register = useCallback<Register>((el, text) => {
    const entry = { el, text };
    setTitles((list) => [...list, entry]);
    return () => setTitles((list) => list.filter((t) => t !== entry));
  }, []);
  const current = titles.at(-1) ?? null;
  const el = current?.el ?? null;

  useEffect(() => {
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const barHeight = Math.round(barRef.current?.getBoundingClientRect().height ?? 0);
    const observer = new IntersectionObserver(([entry]) => {
      // Hidden above the bar (not below the fold): the bar takes over the title.
      // A late entry for a title that already left the page (a tab switch) must not collapse the new screen's bar.
      if (entry && el.isConnected) setCollapsedEl(!entry.isIntersecting && entry.boundingClientRect.top < barHeight ? el : null);
    }, { rootMargin: `-${barHeight}px 0px 0px 0px`, threshold: 0 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, barRef]);

  return { register, title: current?.text ?? null, collapsed: el !== null && collapsedEl === el };
}
