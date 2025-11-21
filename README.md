# -
**OCR Playwright Demo**

Hướng dẫn nhanh để chạy demo Playwright cục bộ cho quy trình upload PDF/hình ảnh và thu kết quả OCR (mã test đã được di chuyển vào `test/ocr.spec.js`).

- Yêu cầu: `node >= 18`, `npm`.
- Dự án sử dụng Playwright test runner (`@playwright/test`).

Thiết lập và chạy (trong thư mục gốc của workspace):

1) Cài Node.js (nếu chưa có). Trên Ubuntu bạn có thể dùng:

```
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

2) Cài phụ thuộc và các browser Playwright:

```
npm install
npx playwright install --with-deps
```

3) Chạy test (ví dụ chạy headed để thấy trình duyệt):

```
FILEPATH=./paper.pdf npm run test:headed
```

Ghi chú:
- Test sử dụng biến môi trường `FILEPATH` (mặc định `./paper.pdf`) để chỉ đường dẫn file sẽ upload tới trang OCR.
- Kết quả raw sẽ được ghi vào các file `resp.txt`, `raw-page-*.json` trong thư mục làm việc.

Xem các file cấu hình và test trong `package.json`, `playwright.config.mjs` và `test/ocr.spec.js`.

**Chạy server & Swagger (local)**

- Start server cục bộ:

```
npm start
```

- Mở Swagger UI:

```
http://localhost:3000/docs
```

Nếu bạn thấy "No operations defined" — làm mới trang; `swagger-jsdoc` đã được cấu hình để quét `./src/server.js`, và endpoint `/ocr` được khai báo bằng JSDoc OpenAPI comment trong `src/server.js`.

**Docker**

Dockerfile đã được thêm vào dự án. Image dùng base Playwright (đã có browsers).

Build image:

```
docker build -t ocr-playwright-demo:latest .
```

Run container (map port 3000):

```
docker run --rm -p 3000:3000 \
	-e HEADLESS=true \
	ocr-playwright-demo:latest
```

Upload file via Swagger UI (`/docs`) or using `curl`:

```
curl -v -F "file=@./CV_VN_DoanNgocThanh-2.pdf" http://localhost:3000/ocr
```

Ghi chú Docker:
- Image `mcr.microsoft.com/playwright:latest` đã bao gồm các browser Playwright; `npm install` trong Dockerfile cài gói `playwright` (package.json hiện khai báo `playwright` trong `devDependencies`) — nếu bạn muốn tạo image tối ưu hơn, chuyển `playwright` sang `dependencies` hoặc dùng `npm ci` với `package-lock.json`.
- Nếu chạy Docker trên host thiếu GPU/X server thì vẫn chạy được bởi Playwright trong container dùng bản browser có headless hỗ trợ; để chạy headed trong container cần cấu hình X forwarding / VNC.

**API Workflow (UUID-based)**

Hệ thống hỗ trợ workflow tất cả là API với UUID để tra cứu kết quả OCR.

*Bước 1: Upload file*

```bash
curl -X POST -F "file=@./CV_VN_DoanNgocThanh-2.pdf" http://localhost:3000/ocr
```

Response (202 Accepted):
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "processing",
  "statusUrl": "/ocr/550e8400-e29b-41d4-a716-446655440000"
}
```

*Bước 2: Polling để lấy kết quả*

Dùng `jobId` để kiểm tra trạng thái:

```bash
curl http://localhost:3000/ocr/550e8400-e29b-41d4-a716-446655440000
```

Response khi đang xử lý (status: processing):
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "fileName": "CV_VN_DoanNgocThanh-2.pdf",
  "status": "processing",
  "createdAt": "2025-11-21T10:35:00Z",
  "updatedAt": "2025-11-21T10:35:05Z"
}
```

Response khi hoàn thành (status: completed):
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "fileName": "CV_VN_DoanNgocThanh-2.pdf",
  "status": "completed",
  "createdAt": "2025-11-21T10:35:00Z",
  "updatedAt": "2025-11-21T10:45:30Z",
  "result": {
    "kind": "pages",
    "data": [...]
  }
}
```

**Database**

Dự án dùng SQLite + Prisma. Database được tạo tự động khi chạy `npm db:setup`.

- Database file: `prisma/dev.db`
- Schema: `prisma/schema.prisma`

Để reset database:

```bash
rm -f prisma/dev.db && npm run db:setup
```

