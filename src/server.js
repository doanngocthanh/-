import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import swaggerUi from 'swagger-ui-express';
import swaggerJSDoc from 'swagger-jsdoc';
import { chromium } from 'playwright';
import { PrismaClient } from '@prisma/client';

const app = express();
const prisma = new PrismaClient();

const uploadDir = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: '3.0.0',
    info: { title: 'OCR Playwright API', version: '0.1.0' },
  },
  apis: ['./src/server.js'],
});

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

async function waitForOCRResults(page, maxPages = 10, timeoutMs = 10 * 60 * 1000) {
  const start = Date.now();
  const poll = 1000;
  while (Date.now() - start < timeoutMs) {
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
      if (presFiltered.length > 0) return { type: 'text', content: presFiltered };
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
          } catch (e) {}
        }
      } else {
        for (let i = 0; i < Math.min(maxPages, images.length); i++) results.push({ index: i + 1, text: null, images: [images[i]] });
      }
      return { type: 'pages', pages: results };
    }

    await page.waitForTimeout(poll);
  }
  throw new Error('Timed out waiting for OCR results');
}

async function runOCRWithBrowser(filePath, maxPages = 10) {
  const headless = process.env.HEADLESS !== 'false';
  const browser = await chromium.launch({ headless, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto('https://olmocr.allenai.org', { waitUntil: 'networkidle' });
    const acceptButton = await page.$('button:has-text("Accept")');
    if (acceptButton) await acceptButton.click();

    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) throw new Error('File input not found on OCR site');
    await fileInput.setInputFiles(filePath);
    console.log('File selected');

    await page.waitForSelector('button:has-text("Process Document")', { state: 'visible', timeout: 15000 });
    const processButton = await page.$('button:has-text("Process Document")');
    if (!processButton) throw new Error('Process Document button not found');
    await processButton.click();
    console.log('Processing started, waiting for results...');

    // Wait initial 60s for processing to start
    await page.waitForTimeout(60000);

    // Wait for OCR pages to appear (max 5 min)
    let res = await waitForOCRResults(page, maxPages, 5 * 60 * 1000);

    if (res.type === 'pages') {
      const pagesResult = { kind: 'pages', data: res.pages };
      const rawEntries = [];

      const containers = await page.$$('[data-page-index], .page, .result-page, .ocr-page, .page-result, .page-block, article, .css-lffl6r');
      const count = Math.min(maxPages, Math.max(containers.length, res.pages.length));

      // Try to extract "View Raw" OCR data for each page (like test code does)
      for (let i = 0; i < count; i++) {
        try {
          let container = null;
          if (i < containers.length) container = containers[i];

          const perPageTimeout = 2 * 60 * 1000;
          if (container) {
            try {
              const processingSelector = ':scope >> text=Processing...';
              await container.waitForSelector(processingSelector, { state: 'detached', timeout: perPageTimeout });
            } catch (e) {
              try {
                await container.waitForSelector('.css-12nj87g, [aria-label="Loading…"], [role="progressbar"]', { state: 'detached', timeout: 30000 });
              } catch (_) {}
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

    if (res.type === 'text') {
      return { kind: 'raw_text', data: res.content };
    }

    return { kind: 'unknown', data: res };
  } finally {
    await browser.close();
  }
}

/**
 * @openapi
 * /ocr:
 *   post:
 *     summary: Upload file for OCR processing
 *     consumes:
 *       - multipart/form-data
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       '202':
 *         description: Job submitted; returns jobId and polling URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId:
 *                   type: string
 *                   format: uuid
 *                 status:
 *                   type: string
 *                 statusUrl:
 *                   type: string
 */
app.post('/ocr', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });

  const jobId = uuidv4();
  const filePath = req.file.path;

  try {
    const job = await prisma.oCRJob.create({
      data: {
        id: jobId,
        fileName: req.file.originalname,
        filePath: filePath,
        status: 'processing',
      },
    });

    res.status(202).json({
      jobId: job.id,
      status: job.status,
      statusUrl: `/ocr/${job.id}`,
    });

    // Start OCR processing in background
    (async () => {
      try {
        const ocrResult = await runOCRWithBrowser(filePath, 10);
        await prisma.oCRJob.update({
          where: { id: jobId },
          data: {
            status: 'completed',
            result: JSON.stringify(ocrResult),
          },
        });
        console.log(`Job ${jobId} completed`);
      } catch (err) {
        console.error(`Job ${jobId} failed:`, err);
        await prisma.oCRJob.update({
          where: { id: jobId },
          data: {
            status: 'failed',
            error: String(err),
          },
        });
      }
    })();
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/**
 * @openapi
 * /ocr/{jobId}:
 *   get:
 *     summary: Get OCR job status and result
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       '200':
 *         description: Job status and result (if completed)
 *       '404':
 *         description: Job not found
 */
app.get('/ocr/:jobId', async (req, res) => {
  const { jobId } = req.params;
  try {
    const job = await prisma.oCRJob.findUnique({ where: { id: jobId } });
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const response = {
      jobId: job.id,
      fileName: job.fileName,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };

    if (job.result) response.result = JSON.parse(job.result);
    if (job.error) response.error = job.error;

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`OCR API listening at http://localhost:${port}`);
  console.log(`Swagger UI: http://localhost:${port}/docs`);
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
