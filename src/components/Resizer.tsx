import { useRef } from "react";

/**
 * Drag handle. Reports the pointer delta from where the drag started, so the
 * parent computes the new size from its own start value. Uses pointer
 * capture so the drag keeps working over iframes / the code viewer.
 */
export function Resizer({
  dir,
  onStart,
  onDrag,
  onReset,
  title,
}: {
  dir: "col" | "row";
  onStart: () => void;
  onDrag: (delta: number) => void;
  onReset?: () => void;
  title?: string;
}) {
  const start = useRef<number | null>(null);
  return (
    <div
      className={`resizer ${dir}`}
      role="separator"
      aria-orientation={dir === "col" ? "vertical" : "horizontal"}
      title={title}
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = dir === "col" ? e.clientX : e.clientY;
        document.body.classList.add(dir === "col" ? "resizing-col" : "resizing-row");
        onStart();
      }}
      onPointerMove={(e) => {
        if (start.current == null) return;
        onDrag((dir === "col" ? e.clientX : e.clientY) - start.current);
      }}
      onPointerUp={(e) => {
        start.current = null;
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        document.body.classList.remove("resizing-col", "resizing-row");
      }}
    />
  );
}
