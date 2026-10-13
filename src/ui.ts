import { create } from "zustand";

/** Layout state (panel visibility & sizes), remembered per device. */
interface UiState {
  leftOpen: boolean;
  rightOpen: boolean;
  rightWidth: number;
  /** fraction of the right panel's height given to the file tree */
  treeRatio: number;
  toggleLeft(): void;
  toggleRight(): void;
  setRightWidth(w: number): void;
  setTreeRatio(r: number): void;
}

const KEY = "vlm-ui-v1";
export const RIGHT_MIN = 280;
export const MAIN_MIN = 380;
export const LEFT_WIDTH = 268;
export const RIGHT_DEFAULT = 520;

function load(): Partial<UiState> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

function save(s: UiState) {
  try {
    const { leftOpen, rightOpen, rightWidth, treeRatio } = s;
    localStorage.setItem(KEY, JSON.stringify({ leftOpen, rightOpen, rightWidth, treeRatio }));
  } catch {
    /* storage unavailable: layout just isn't remembered */
  }
}

const saved = load();

export const useUi = create<UiState>((set, get) => {
  const update = (p: Partial<UiState>) => {
    set(p);
    save(get());
  };
  return {
    leftOpen: saved.leftOpen ?? true,
    rightOpen: saved.rightOpen ?? true,
    rightWidth: saved.rightWidth ?? RIGHT_DEFAULT,
    treeRatio: saved.treeRatio ?? 0.38,
    toggleLeft: () => update({ leftOpen: !get().leftOpen }),
    toggleRight: () => update({ rightOpen: !get().rightOpen }),
    setRightWidth: (w) => update({ rightWidth: Math.round(w) }),
    setTreeRatio: (r) => update({ treeRatio: Math.min(0.85, Math.max(0.12, r)) }),
  };
});

/** Max width the right panel may take so the chat column keeps MAIN_MIN. */
export function maxRightWidth(leftOpen: boolean) {
  return Math.max(RIGHT_MIN, window.innerWidth - (leftOpen ? LEFT_WIDTH : 0) - MAIN_MIN - 6);
}
