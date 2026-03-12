/**
 * COBOL source pre-processing and regex-based symbol extraction.
 *
 * tree-sitter-cobol@0.0.1 has limitations:
 * - Patch markers in columns 1-6 (mzADD, estero, etc.) cause parse errors
 * - Only ~15% of paragraph headers are detected by the grammar
 *
 * This module provides:
 * 1. preprocessCobolSource() — cleans patch markers before tree-sitter parsing
 * 2. extractCobolSymbolsWithRegex() — supplements tree-sitter with regex extraction
 */

export interface CobolRegexResults {
  paragraphs: Array<{ name: string; line: number }>;
  sections: Array<{ name: string; line: number }>;
  performs: Array<{ caller: string | null; target: string; thruTarget?: string; line: number }>;
  calls: Array<{ target: string; line: number }>;
  copies: Array<{ target: string; line: number }>;
}

/**
 * Clean COBOL source before tree-sitter parsing.
 * Replaces non-standard patch markers in columns 1-6 with spaces.
 * Preserves exact line count for AST position mapping.
 */
export function preprocessCobolSource(content: string): string {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 7) continue;
    const seq = line.substring(0, 6);
    // Standard COBOL: cols 1-6 are spaces or digits (sequence numbers)
    // Patch markers contain letters or '#' — replace with spaces
    if (/[a-zA-Z#]/.test(seq)) {
      lines[i] = '      ' + line.substring(6);
    }
  }
  return lines.join('\n');
}

const EXCLUDED_PARA_NAMES = new Set([
  'DECLARATIVES', 'END', 'PROCEDURE', 'IDENTIFICATION',
  'ENVIRONMENT', 'DATA', 'WORKING-STORAGE', 'LINKAGE',
  'FILE', 'LOCAL-STORAGE', 'COMMUNICATION', 'REPORT',
  'SCREEN', 'INPUT-OUTPUT', 'CONFIGURATION',
]);

/**
 * Extract COBOL symbols using regex to supplement tree-sitter.
 * Only extracts from the PROCEDURE DIVISION onward.
 */
export function extractCobolSymbolsWithRegex(
  content: string,
  _filePath: string,
): CobolRegexResults {
  const lines = content.split('\n');
  const result: CobolRegexResults = {
    paragraphs: [],
    sections: [],
    performs: [],
    calls: [],
    copies: [],
  };

  // Find PROCEDURE DIVISION start
  let procDivLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/\bPROCEDURE\s+DIVISION\b/i.test(lines[i])) {
      procDivLine = i;
      break;
    }
  }

  // Extract COPY statements from entire file (they appear in DATA DIVISION too)
  const copyUnquoted = /\bCOPY\s+([A-Z][A-Z0-9-]*)\s*\./gim;
  const copyQuoted = /\bCOPY\s+"([^"]+)"\s*\./gim;
  let m: RegExpExecArray | null;

  while ((m = copyUnquoted.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length - 1;
    result.copies.push({ target: m[1], line });
  }
  while ((m = copyQuoted.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length - 1;
    result.copies.push({ target: m[1], line });
  }

  // Extract CALL statements from entire file
  const callRe = /\bCALL\s+"([^"]+)"/gim;
  while ((m = callRe.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length - 1;
    result.calls.push({ target: m[1], line });
  }

  if (procDivLine < 0) return result;

  // Extract paragraphs and sections from PROCEDURE DIVISION
  let currentParagraph: string | null = null;

  for (let i = procDivLine + 1; i < lines.length; i++) {
    const line = lines[i];

    // Section header: "       SECTION-NAME SECTION."
    const secMatch = line.match(/^       ([A-Z][A-Z0-9-]+)\s+SECTION\.\s*$/);
    if (secMatch) {
      const name = secMatch[1];
      if (!EXCLUDED_PARA_NAMES.has(name) && !name.includes('DIVISION')) {
        result.sections.push({ name, line: i });
        currentParagraph = name;
      }
      continue;
    }

    // Paragraph header: "       PARAGRAPH-NAME."
    const paraMatch = line.match(/^       ([A-Z][A-Z0-9-]+)\.\s*$/);
    if (paraMatch) {
      const name = paraMatch[1];
      if (!EXCLUDED_PARA_NAMES.has(name) && !name.includes('DIVISION') && !name.includes('SECTION')) {
        result.paragraphs.push({ name, line: i });
        currentParagraph = name;
      }
      continue;
    }

    // PERFORM statement
    const perfMatch = line.match(/\bPERFORM\s+([A-Z][A-Z0-9-]+)(?:\s+THRU\s+([A-Z][A-Z0-9-]+))?/i);
    if (perfMatch) {
      result.performs.push({
        caller: currentParagraph,
        target: perfMatch[1],
        thruTarget: perfMatch[2] || undefined,
        line: i,
      });
    }
  }

  return result;
}
