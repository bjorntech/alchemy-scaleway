import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Coverage = Map<number, number>;

interface FunctionCandidate {
  file: string;
  name: string;
  start: number;
  end: number;
  complexity: number;
  coverage: number;
  crap: number;
}

const max = Number(process.argv.find((arg) => arg.startsWith("--max="))?.slice("--max=".length) ?? 6);
const lcovPath = join(process.cwd(), "coverage", "lcov.info");

if (!existsSync(lcovPath)) {
  console.error("coverage/lcov.info not found. Run: bun run coverage");
  process.exit(1);
}

const coverage = parseLcov(readFileSync(lcovPath, "utf8"));
const candidates = [...coverage.keys()]
  .filter((file) => file.startsWith("src/") && existsSync(file))
  .flatMap((file) => analyzeFile(file, coverage.get(file)!))
  .sort((a, b) => b.crap - a.crap);

console.log(`Top CRAP scores (approximate, max ${max}):`);
console.log("CRAP  Cplx  Cov%   Function");
for (const item of candidates.slice(0, 20)) {
  console.log(
    `${item.crap.toFixed(1).padStart(5)} ${String(item.complexity).padStart(5)} ${String(Math.round(item.coverage * 100)).padStart(4)}%  ${item.file}:${item.start} ${item.name}`,
  );
}

const offenders = candidates.filter((item) => item.crap > max);
if (offenders.length > 0) {
  console.error(`CRAP threshold failed: ${offenders.length} function(s) exceed ${max}.`);
  process.exit(1);
}

function parseLcov(contents: string) {
  const result = new Map<string, Coverage>();
  let currentFile: string | undefined;
  for (const line of contents.split("\n")) {
    if (line.startsWith("SF:")) {
      currentFile = line.slice(3);
      result.set(currentFile, new Map());
      continue;
    }
    if (!currentFile || !line.startsWith("DA:")) continue;
    const [lineNumber, hits] = line.slice(3).split(",").map(Number);
    result.get(currentFile)!.set(lineNumber, hits);
  }
  return result;
}

function analyzeFile(file: string, coverage: Coverage): FunctionCandidate[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const candidates: FunctionCandidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const name = functionName(lines[i]);
    if (!name) continue;
    const end = findFunctionEnd(lines, i);
    if (lines[i - 1]?.includes("@crap-ignore")) {
      i = end - 1;
      continue;
    }
    const body = lines.slice(i, end).join("\n");
    const complexity = complexityOf(body);
    const coveredLines = [...coverage.entries()].filter(([line]) => line >= i + 1 && line <= end);
    if (coveredLines.length === 0) continue;
    const covered = coveredLines.filter(([, hits]) => hits > 0).length / coveredLines.length;
    const crap = complexity ** 2 * (1 - covered) ** 3 + complexity;
    candidates.push({ file, name, start: i + 1, end, complexity, coverage: covered, crap });
  }
  return candidates;
}

function functionName(line: string) {
  return (
    line.match(/^\s*(?:export\s+)?function\s+([\w$]+)/)?.[1] ??
    line.match(/^\s*(?:export\s+)?const\s+([\w$]+)\s*=\s*(?:\([^)]*\)|[\w$]+)\s*=>/)?.[1]
  );
}

function findFunctionEnd(lines: string[], start: number) {
  let depth = 0;
  let seenBrace = false;
  for (let i = start; i < lines.length; i++) {
    for (const char of lines[i]) {
      if (char === "{") {
        depth++;
        seenBrace = true;
      } else if (char === "}") {
        depth--;
      }
    }
    if (seenBrace && depth <= 0) return i + 1;
  }
  return start + 1;
}

function complexityOf(body: string) {
  const matches = body.match(/\b(if|for|while|case|catch)\b|&&|\|\|/g);
  return 1 + (matches?.length ?? 0);
}
