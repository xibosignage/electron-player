const fs = require('node:fs');

/**
 * RTF header: one fixed-pitch font at 8pt, which is what keeps the licence's own
 * column alignment intact inside the installer's scrolling text control.
 */
const RTF_HEADER =
  '{\\rtf1\\ansi\\ansicpg1252\\deff0' +
  '{\\fonttbl{\\f0\\fmodern\\fcharset0 Courier New;}}' +
  '\\viewkind4\\uc1\\pard\\f0\\fs16 ';

/**
 * Escape one line of plain text for RTF.
 *
 * Backslashes and braces are RTF's own syntax, and anything above ASCII has to
 * be written as a byte escape or the control renders it as mojibake.
 *
 * @param {string} line A single line of plain text.
 * @return {string} The same line, safe to embed in an RTF document.
 */
function escapeLine(line) {
  let out = '';

  for (const character of line) {
    const code = character.codePointAt(0);

    if (character === '\\' || character === '{' || character === '}') {
      out += '\\' + character;
    } else if (code < 128) {
      out += character;
    } else if (code <= 255) {
      out += '\\\'' + code.toString(16).padStart(2, '0');
    } else {
      // Outside the code page entirely. RTF's Unicode escape carries a '?' as
      // the fallback for readers that cannot render it.
      out += '\\u' + (code > 32767 ? code - 65536 : code) + '?';
    }
  }

  return out;
}

/**
 * Convert a plain-text licence into the RTF document the installer's licence
 * page expects.
 *
 * Generated at build time rather than committed, so the licence shown to
 * somebody installing the player is always the repository's own LICENSE and the
 * two cannot drift apart.
 *
 * @param {string} sourcePath Path to the plain-text licence.
 * @param {string} targetPath Path to write the RTF document to.
 * @return {string} The path written, for convenience.
 */
function writeLicenseRtf(sourcePath, targetPath) {
  const text = fs.readFileSync(sourcePath, 'utf8');

  const body = text
    .split(/\r?\n/)
    .map((line) => escapeLine(line) + '\\par')
    .join('\n');

  fs.writeFileSync(targetPath, RTF_HEADER + '\n' + body + '\n}', 'ascii');

  return targetPath;
}

module.exports = {writeLicenseRtf};
