/** Story writes in flight. Auto-lock waits these out so a chapter is not cut off. */

let depth = 0;

export function writesInFlight(): boolean {
  return depth > 0;
}

export function beginAppWrite(): void {
  depth += 1;
}

export function endAppWrite(): void {
  depth = Math.max(0, depth - 1);
}
