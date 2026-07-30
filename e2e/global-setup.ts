import { chromium, type FullConfig } from '@playwright/test';

export default async function globalSetup(config: FullConfig) {
	const baseURL = config.projects[0]?.use?.baseURL ?? 'http://127.0.0.1:4173';
	const browser = await chromium.launch();
	const page = await browser.newPage();

	try {
		await page.goto(`${baseURL}/studio`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
		await page.getByTestId('pattern-name-input').waitFor({ state: 'visible', timeout: 60_000 });
	} finally {
		await browser.close();
	}
}
