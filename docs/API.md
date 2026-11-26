# API quick reference

All endpoints are prefixed with `/api`.

- `GET /health`
- `GET /metrics`
- `POST /validate` — multipart CSV upload, field name `file`
- `POST /predict` — JSON `{ "transaction_description": "..." }`
- `POST /predict/batch` — multipart CSV upload, field name `file`
- `GET /analytics`
- `POST /feedback` — JSON with `transaction_description`, `predicted_category`, `corrected_category`

Swagger/OpenAPI documentation is available at `/docs` on the FastAPI service.
