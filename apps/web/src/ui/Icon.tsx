import { iconPath, type IconName } from './icons.ts';

/**
 * One SVG icon set (redesign R5): 24 viewBox, stroke 1.8, round caps, currentColor (the parent's CSS sets the hue).
 * Decorative: `aria-hidden`, so the control that holds it carries the `aria-label`. `filled` is the selected-tab
 * variant: closed shapes take a soft fill of the same colour.
 */
export function Icon({ name, filled = false, className, size }: { name: IconName; filled?: boolean; className?: string; size?: number }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      data-icon={name}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      fillOpacity={filled ? 0.3 : undefined}
      stroke="currentColor"
      strokeWidth={filled ? 2.1 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={iconPath(name)} />
    </svg>
  );
}
