// Discards results of superseded async requests: only the latest ticket stays current.
export const latest = (): { next: () => number; isCurrent: (ticket: number) => boolean } => {
  let gen = 0;
  return { next: () => ++gen, isCurrent: (ticket) => ticket === gen };
};

// Index of the tab to focus for an arrow key (wrapping), or null for other keys.
export const stepTab = (count: number, from: number, key: string): number | null => {
  if (count <= 0) return null;
  if (key === "ArrowRight") return (from + 1) % count;
  if (key === "ArrowLeft") return (from + count - 1) % count;
  return null;
};
