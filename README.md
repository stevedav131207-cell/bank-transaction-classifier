# Bank Transaction Categorizer

A compact, end-to-end transaction classification app built from the supplied PRD and CSV dataset.

## What is included

- React + CSS dashboard for CSV upload, batch categorization, filtering and CSV export.
- FastAPI REST API for validation, single prediction, batch prediction, analytics and feedback.
- Trained TF-IDF + Logistic Regression model (included as `backend/app/model.joblib`).
- Local, per-prediction text-feature evidence from the linear classifier.
- PostgreSQL persistence for prediction history and user corrections.
- Docker Compose deployment, health endpoint and basic API tests.
- Reproducible training/evaluation script.

## Model and evaluation

The model uses **only `transaction_description`** to predict `category`. It intentionally does not use account number, account-holder name, merchant, transaction type, amount or other identifying/derived columns. This avoids direct dependence on fields that could create leakage or expose unnecessary personal data.

Training uses an 80/20 stratified split with `random_state=42`. The included trained model was fitted on 88,000 rows and evaluated on 22,000 held-out rows from the supplied synthetic dataset:

| Metric | Result |
|---|---:|
| Accuracy | 94.64% |
| Macro F1 | 92.25% |
| Weighted F1 | 94.74% |

These are dataset-specific synthetic-data results, not evidence of equivalent performance on real bank statements. Validate against independently sourced, representative and correctly labelled data before real financial use.

The explanation shows positive TF-IDF feature contributions from the predicted class's linear decision function. It is a lightweight, exact model-evidence explanation; it is **not SHAP and is not a causal explanation**. The PRD's full SHAP integration and Transformer-vs-baseline study remain follow-on work.

## Dataset

The supplied dataset is copied to `data/transactions.csv`. It has 110,000 rows and 12 columns. The API requires `transaction_description`; all other CSV columns are optional and are not used by this model.

For privacy, the app only persists transaction descriptions, predicted category, confidence and user corrections. Do not upload real bank statements unless you have permission and have reviewed your data-retention and security requirements.

## Run locally with Docker (recommended)

Requirements: Docker Desktop / Docker Engine with the Compose plugin.

1. Copy `.env.example` to `.env`.
2. Replace `POSTGRES_PASSWORD` with a long random password.
3. Start the application:

   ```bash
   docker compose up --build -d
   ```

4. Open the dashboard: <http://localhost:8080>
5. Open interactive API docs: <http://localhost:8080/api/docs> (or <http://localhost:8000/docs> if you run the API directly).
6. Check API health: <http://localhost:8080/api/health>

Stop:

```bash
docker compose down
```

Keep database data between restarts with the named Docker volume. To remove database data as well:

```bash
docker compose down -v
```

## Run without Docker

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

The backend uses a local SQLite database by default when `DATABASE_URL` is not set. API docs: <http://localhost:8000/docs>.

### Frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

For local Vite development, add a proxy to `frontend/vite.config.js` or use the Docker setup. The production Nginx configuration already proxies `/api` to FastAPI.

## API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/metrics` | Held-out model metrics |
| POST | `/api/validate` | Validate uploaded CSV |
| POST | `/api/predict` | Predict one description |
| POST | `/api/predict/batch` | Categorize uploaded CSV |
| GET | `/api/analytics` | Stored prediction counts |
| POST | `/api/feedback` | Save a human correction |

Example single prediction:

```bash
curl -X POST http://localhost:8000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"transaction_description":"UPI SWIGGY FOOD ORDER"}'
```

Batch endpoints accept `multipart/form-data` with a file field named `file`. CSV must include `transaction_description`, be at most 25 MB and contain no more than 200,000 rows.

## Retrain the model

The training script expects `data/transactions.csv` with `transaction_description` and `category` columns.

```bash
pip install -r backend/requirements.txt
python ml/train.py
```

This overwrites the model and metrics artifacts. Restart the backend after retraining.

## Tests

```bash
cd backend
pip install -r requirements.txt
pip install pytest httpx
PYTHONPATH=. pytest
```

## Deployment checklist

- Set a unique production database password in `.env`; never commit `.env`.
- Put the app behind HTTPS using your hosting provider's reverse proxy/load balancer.
- Restrict network access to PostgreSQL; do not expose port 5432 publicly.
- Configure backups, log rotation, monitoring and retention/deletion policies.
- Restrict upload size and rate-limit public endpoints at the proxy.
- Add authentication and per-user authorization before allowing multiple users or sensitive real data. The current MVP has no login system.
- Review privacy, consent and applicable financial-data regulations before production use.
- Pin and scan dependency versions and keep model/data artifacts versioned.

## Scope notes

This is a deployable MVP, deliberately kept small and readable. It covers the working data-to-prediction-to-dashboard loop, but does not claim to complete every aspirational PRD item. In particular, SHAP, fine-tuned BERT/DistilBERT comparison, MLflow experiment tracking, PDF reports, JWT authentication and automated retraining are not implemented in this version. User corrections are stored for later review and do not automatically change the model.
