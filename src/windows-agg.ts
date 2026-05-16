import { SectionData } from './section-data.js';
import { UsageWindow } from './usage-window.js';

export class WindowsAgg {
  private constructor() {}

  static from(html: string): UsageWindow[] {
    const rollingData = SectionData.fromHtml(html, 'Rolling Usage');
    const weeklyData = SectionData.fromHtml(html, 'Weekly Usage');
    const monthlyData = SectionData.fromHtml(html, 'Monthly Usage');

    return [
      UsageWindow.fromSection('5h', rollingData.usedPercent, rollingData.resetText),
      UsageWindow.fromSection('weekly', weeklyData.usedPercent, weeklyData.resetText),
      UsageWindow.fromSection('monthly', monthlyData.usedPercent, monthlyData.resetText),
    ];
  }
}
