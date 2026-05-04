/**
 * Parse HTML usage sections from OpenCode Go workspace pages.
 *
 * The OpenCode Go settings page renders usage progress bars using Alpine.js
 * with inline SVG and commented data attributes. This parser extracts:
 *  - usedPercent: the numeric percentage from the bar width
 *  - resetText:  human-readable "Resets in ..." string
 *
 * The regex patterns are brittle by nature (HTML scraping). They target the
 * commented-data-slot pattern Alpine.js produces, e.g.:
 *   <!--$-->42<!--/-->  for the usage value
 *   <!--$-->Resets in 5 days<!--/-->  for the reset time
 */
const SECTION_LEN = 1000;

const USAGE_PERCENT_RE = /usage-value[^>]*>\s*<!--\$-->(\d+)<!--\/-->/;
const RESET_TIME_RE =
  /data-slot="reset-time"[^>]*>\s*<!--\$-->Resets in<!--\/-->\s*<!--\$-->([^<]+)<!--\/-->/;

export class SectionData {
  readonly usedPercent: number;
  readonly resetText: string | null;

  private constructor(usedPercent: number, resetText: string | null) {
    this.usedPercent = usedPercent;
    this.resetText = resetText;
  }

  static fromHtml(html: string, label: string): SectionData {
    const labelIdx = html.indexOf(`data-slot="usage-label">${label}`);
    if (labelIdx === -1) {
      throw new Error(`Usage section not found: ${label}`);
    }

    const section = html.slice(labelIdx, labelIdx + SECTION_LEN);

    const pctMatch = section.match(USAGE_PERCENT_RE);
    if (!pctMatch) {
      throw new Error(`Usage percent not found: ${label}`);
    }

    const pct = Number.parseInt(pctMatch[1], 10);

    const resetMatch = section.match(RESET_TIME_RE);
    const reset = resetMatch ? resetMatch[1].trim() : null;

    return new SectionData(pct, reset);
  }
}
