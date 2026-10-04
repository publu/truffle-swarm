import { readFile } from "node:fs/promises";
import { byName } from "./operations.mjs";

/**
 * Parse `command --flag value` argv. A repeated flag accumulates, so list
 * inputs such as --source can be given more than once. A missing value is an
 * error rather than a silently true flag.
 */
export function parseArgv(argv, { booleans = [] } = {}) {
  const flags = {};
  const positional = [];
  const set = (name, value) => {
    if (!Object.hasOwn(flags, name)) flags[name] = value;
    else if (Array.isArray(flags[name])) flags[name].push(value);
    else flags[name] = [flags[name], value];
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const inline = name.indexOf("=");
    if (inline > 0) {
      set(name.slice(0, inline), name.slice(inline + 1));
      continue;
    }
    if (booleans.includes(name)) {
      set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw Error(`Missing value for --${name}.`);
    set(name, value);
    index++;
  }
  return { command: positional.shift() ?? "help", positional, flags };
}

/** Flags that select the connection rather than feeding an operation. */
export const SELECTORS = new Set(["config", "profile", "store", "workspace"]);

/**
 * Map CLI flags onto one operation's declared inputs. `--file FILE` fills the
 * input marked fromFile, so a long body or brief never has to fit on a command line.
 */
export async function inputsFromFlags(name, flags) {
  const operation = byName.get(name);
  if (!operation) throw Error(`Unknown command ${name}. Run help.`);
  const aliases = new Map(
    Object.entries(operation.inputs).map(([key, spec]) => [spec.flag ?? key, key]),
  );
  const raw = {};
  for (const [flag, value] of Object.entries(flags)) {
    if (SELECTORS.has(flag)) continue;
    if (flag === "file") continue;
    const key = aliases.get(flag);
    if (!key) throw Error(`${name} does not take --${flag}. Run help.`);
    raw[key] = value;
  }
  if (flags.file !== undefined) {
    const target = Object.entries(operation.inputs).find(([, spec]) => spec.fromFile);
    if (!target) throw Error(`${name} does not read input from a file.`);
    if (raw[target[0]] !== undefined) throw Error(`Choose --${target[1].flag ?? target[0]} or --file, not both.`);
    raw[target[0]] = await readFile(String(flags.file), "utf8");
  }
  return raw;
}
