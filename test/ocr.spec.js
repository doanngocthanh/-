import { test, expect } from '@playwright/test';
import fs from 'fs';

// Increase test timeout so long-running per-page OCR processing can complete
test.setTimeout(10 * 60 * 1000); // 10 minutes
// Allow switching headless mode via env var `HEADLESS` (set to 'false' to run headed)
const _headless = process.env.HEADLESS === undefined ? true : (process.env.HEADLESS !== 'false');
test.use({ headless: _headless });
async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOCRResults(page, maxPages = 10, timeoutMs = 10 * 60 * 1000) {
    const start = Date.now();
    const poll = 1000;
    while (Date.now() - start < timeoutMs) {
        // Heuristics: look for page containers, result text blocks, code/pre/json blocks, or result images
        const pageContainers = await page.$$('[data-page-index], .page, .result-page, .ocr-page, .page-result, .page-block, article, .css-lffl6r');
        const images = await page.$$eval('img', imgs => imgs.map(i => ({ src: i.src, alt: i.alt })).filter(i => i.src && !i.src.startsWith('data:')));
        const pres = await page.$$eval('pre, code, textarea', nodes => nodes.map(n => n.innerText).filter(Boolean));

        if (pres.length > 0) {
            const presFiltered = pres.filter(t => {
                if (!t) return false;
                const s = t.trim();
                if (s.length > 200) return true;
                if (s.split(/\n/).length > 3) return true;
                if (/^[\[{]/.test(s)) return true;
                return false;
            });

            if (presFiltered.length > 0) {
                return { type: 'text', content: presFiltered };
            }

            console.log('Found short pre/code blocks that look like headers — ignoring for now:', pres.map(p=>p.trim()).slice(0,5));
        }

        if (pageContainers.length >= Math.min(maxPages, 1) || images.length >= Math.min(maxPages, 1)) {
            const results = [];
            if (pageContainers.length > 0) {
                for (let i = 0; i < Math.min(maxPages, pageContainers.length); i++) {
                    try {
                        const el = pageContainers[i];
                        const text = await el.innerText().catch(() => '');
                        const imgs = await el.$$eval('img', imgs => imgs.map(i => ({ src: i.src, alt: i.alt })) ).catch(() => []);
                        results.push({ index: i + 1, text: text || null, images: imgs });
                    } catch (e) {
                        // ignore retrieval errors
                    }
                }
            } else {
                for (let i = 0; i < Math.min(maxPages, images.length); i++) {
                    results.push({ index: i + 1, text: null, images: [images[i]] });
                }
            }

            return { type: 'pages', pages: results };
        }

        await page.waitForTimeout(poll);
    }
    throw new Error('Timed out waiting for OCR results');
}

async function gotoWebsiteAndExtract(page, filePath, maxPages = 10) {
    console.log('=== Starting OCR Demo ===');
    await page.goto('https://olmocr.allenai.org');
    const acceptButton = await page.$('button:has-text("Accept")');
    if (acceptButton) {
        await acceptButton.click();
        console.log('Accepted Notice & Consent dialog');
    }

    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) throw new Error('File input not found');

    await fileInput.setInputFiles(filePath);
    console.log('File selected');

    await page.waitForSelector('button:has-text("Process Document")', { state: 'visible', timeout: 15000 });
    const processButton = await page.$('button:has-text("Process Document")');
    if (!processButton) throw new Error('Process Document button not found');
    await processButton.click();
    await sleep(60000); // wait for 1 minute to allow processing to start
    let res = await waitForOCRResults(page, maxPages, 5 * 60 * 1000);

    if (res.type === 'text') {
        const parsed = [];
        for (const t of res.content) {
            try {
                parsed.push(JSON.parse(t));
            } catch (e) {
                parsed.push(t);
            }
        }

        const allShortHeaderLike = parsed.every(p => {
            if (typeof p !== 'string') return false;
            const s = p.trim();
            return s.length < 120 && !s.includes('\n') && /^[\w\/:.\-@]+$/.test(s);
        });

        if (allShortHeaderLike) {
            console.log('Detected short header-like text from initial results; continuing to wait for page containers...');
            try {
                const pagesRes = await waitForOCRResults(page, maxPages, 3 * 60 * 1000);
                if (pagesRes.type === 'pages') {
                    res = pagesRes;
                } else {
                    return { kind: 'raw_text', data: parsed };
                }
            } catch (e) {
                console.log('No pages appeared after waiting; falling back to raw text result');
                return { kind: 'raw_text', data: parsed };
            }
        } else {
            return { kind: 'raw_text', data: parsed };
        }
    }

    if (res.type === 'pages') {
        const pagesResult = { kind: 'pages', data: res.pages };
        const rawEntries = [];

        const containers = await page.$$('[data-page-index], .page, .result-page, .ocr-page, .page-result, .page-block, article, .css-lffl6r');
        const count = Math.min(maxPages, Math.max(containers.length, res.pages.length));

        for (let i = 0; i < count; i++) {
            try {
                let container = null;
                if (i < containers.length) container = containers[i];

                const perPageTimeout = 2 * 60 * 1000; // 2 minutes per page
                if (container) {
                    try {
                        const processingSelector = ':scope >> text=Processing...';
                        await container.waitForSelector(processingSelector, { state: 'detached', timeout: perPageTimeout });
                    } catch (e) {
                        try {
                            await container.waitForSelector('.css-12nj87g, [aria-label="Loading…"], [role="progressbar"]', { state: 'detached', timeout: 30000 });
                        } catch (_) {
                        }
                    }
                } else {
                    await page.waitForTimeout(500);
                }

                let btn = null;
                if (container) {
                    try {
                        await container.waitForSelector('button:has-text("View Raw")', { state: 'visible', timeout: perPageTimeout });
                        btn = await container.$('button:has-text("View Raw")');
                    } catch (e) {
                        btn = null;
                    }
                }

                if (!btn) {
                    const allBtns = await page.$$('button:has-text("View Raw")');
                    if (i < allBtns.length) btn = allBtns[i];
                    else if (allBtns.length > 0) btn = allBtns[0];
                }

                if (!btn) {
                    rawEntries.push({ index: i + 1, error: 'View Raw button not found' });
                    continue;
                }

                await btn.scrollIntoViewIfNeeded();
                await btn.click();

                const dialog = await page.waitForSelector('section[role="dialog"], div[role="dialog"]', { timeout: 10000 });
                if (!dialog) {
                    rawEntries.push({ index: i + 1, error: 'Dialog did not appear' });
                    continue;
                }

                const items = await dialog.evaluate((el) => {
                    const out = [];
                    const headers = Array.from(el.querySelectorAll('h3'));
                    for (const h of headers) {
                        const title = h.innerText ? h.innerText.trim().replace(/:\s*$/, '') : '';
                        let next = h.nextElementSibling;
                        while (next && next.nodeType !== 1) next = next.nextElementSibling;
                        if (next && next.tagName && next.tagName.toLowerCase() === 'pre') {
                            out.push({ title, content: next.innerText });
                        }
                    }
                    if (out.length === 0) {
                        const pres = Array.from(el.querySelectorAll('pre'));
                        for (const p of pres) out.push({ title: 'pre', content: p.innerText });
                    }
                    return out;
                });

                rawEntries.push({ index: i + 1, items });

                try {
                    const pageJsonPath = `raw-page-${i + 1}.json`;
                    fs.writeFileSync(pageJsonPath, JSON.stringify(items, null, 2));
                    const combined = items.map(it => `${it.title}\n${it.content}`).join('\n\n');
                    const pageTxtPath = `raw-page-${i + 1}.txt`;
                    fs.writeFileSync(pageTxtPath, combined);
                } catch (writeErr) {
                    console.error('Failed to write raw page files:', writeErr);
                }

                const closeBtn = await dialog.$('button:has-text("Close")');
                if (closeBtn) {
                    await closeBtn.click();
                } else {
                    await page.keyboard.press('Escape');
                }
                await page.waitForTimeout(300);
            } catch (e) {
                rawEntries.push({ index: i + 1, error: String(e) });
            }
        }

        pagesResult.raw = rawEntries;
        return pagesResult;
    }

    return { kind: 'unknown', data: res };
}

test('OCR - extract first 10 pages or raw output', async ({ page }) => {
    try {
        const filePath = process.env.FILEPATH || './paper.pdf';
        const result = await gotoWebsiteAndExtract(page, filePath, 10);
        console.log('OCR extraction result:', JSON.stringify(result, null, 2));

        fs.writeFileSync('resp.txt', JSON.stringify(result, null, 2));

        expect(['pages', 'raw_text']).toContain(result.kind);
    } catch (err) {
        try {
            await page.screenshot({ path: 'ocr_error.png', fullPage: true });
        } catch (sErr) {
            console.error('Failed to capture screenshot:', sErr);
        }
        fs.writeFileSync('resp_error.txt', String(err));
        throw err;
    }
});
