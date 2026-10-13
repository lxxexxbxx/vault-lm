/** Panel toggle icons (inline SVG, inherits currentColor). */
export function PanelLeftIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" />
      {open && <rect x="1.5" y="2.5" width="4.5" height="11" rx="2" fill="currentColor" opacity="0.35" stroke="none" />}
    </svg>
  );
}

export function PanelRightIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <line x1="10" y1="2.5" x2="10" y2="13.5" />
      {open && <rect x="10" y="2.5" width="4.5" height="11" rx="2" fill="currentColor" opacity="0.35" stroke="none" />}
    </svg>
  );
}
