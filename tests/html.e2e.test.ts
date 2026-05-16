import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE_URL = 'http://localhost:3002';
const BOUNDING_BOX_TOLERANCE = 5;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
});

afterAll(async () => {
  await browser.close();
});

describe('time display — e2e', () => {
  it('спан last-updated-time присутствует в DOM', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    const count = await page.locator('#last-updated-time').count();

    expect(count).toBe(1);
  });

  it('спан видим на странице', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    const visible = await page.locator('#last-updated-time').isVisible();

    expect(visible).toBe(true);
  });

  it('спан содержит непустой текст', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    const text = await page.locator('#last-updated-time').textContent();

    expect(text?.length).toBeGreaterThan(0);
  });

  it('текст соответствует формату: now, Xm, Xh, Xd или пусто', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    const text = (await page.locator('#last-updated-time').textContent()) ?? '';

    expect(text).toMatch(/^(now|\d+[mhd])?$/);
  });

  it('спан находится внутри #dashboard-controls', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    const spanBox = await page.locator('#last-updated-time').boundingBox();
    const controlsBox = await page.locator('#dashboard-controls').boundingBox();

    expect(spanBox).not.toBeNull();
    expect(controlsBox).not.toBeNull();

    const span = spanBox as NonNullable<typeof spanBox>;
    const controls = controlsBox as NonNullable<typeof controlsBox>;

    expect(span.x).toBeGreaterThanOrEqual(controls.x - BOUNDING_BOX_TOLERANCE);
    expect(span.x + span.width).toBeLessThanOrEqual(
      controls.x + controls.width + BOUNDING_BOX_TOLERANCE,
    );
  });

  it('показывает текст после перезагрузки страницы', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });

    const text = await page.locator('#last-updated-time').textContent();

    expect(text?.length).toBeGreaterThan(0);
  });
});
