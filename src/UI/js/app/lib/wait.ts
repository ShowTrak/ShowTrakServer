// Tiny promise-based delay used across the renderer (modal close animations,
// staged UI transitions). Extracted from the old 14-selection-init barrel so
// consumers can import it from a leaf module.
export async function Wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
