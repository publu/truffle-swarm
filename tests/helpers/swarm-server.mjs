import { mkdtemp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/** A scratch directory under .cache, which the repository ignores. */
export async function scratch(prefix) {
  await mkdir(".cache", { recursive: true });
  return resolve(await mkdtemp(`.cache/${prefix}-`));
}
