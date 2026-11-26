import io, os, re, json
from pathlib import Path
import joblib
import pandas as pd
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import create_engine, Column, Integer, String, Float, Text, DateTime, func
from sqlalchemy.orm import declarative_base, sessionmaker
from datetime import datetime, timezone

BASE = Path(__file__).resolve().parent
MODEL_PATH = BASE / "model.joblib"
METRICS_PATH = BASE / "metrics.json"
model = joblib.load(MODEL_PATH)
metrics = json.loads(METRICS_PATH.read_text()) if METRICS_PATH.exists() else {}

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./bank_categorizer.db")
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, pool_pre_ping=True, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()

class PredictionRecord(Base):
    __tablename__ = "predictions"
    id = Column(Integer, primary_key=True)
    description = Column(Text, nullable=False)
    predicted_category = Column(String(100), nullable=False)
    confidence = Column(Float, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

class FeedbackRecord(Base):
    __tablename__ = "feedback"
    id = Column(Integer, primary_key=True)
    description = Column(Text, nullable=False)
    predicted_category = Column(String(100), nullable=False)
    corrected_category = Column(String(100), nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Bank Transaction Categorizer API", version="1.0.0", docs_url="/api/docs", openapi_url="/api/openapi.json",
              description="Explainable transaction classification API. Predictions are model evidence, not financial advice.")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False,
                   allow_methods=["*"], allow_headers=["*"])

def clean_text(value):
    value = str(value or "").lower()
    value = re.sub(r"https?://\S+|www\.\S+", " ", value)
    value = re.sub(r"\b\d{5,}\b", " ", value)
    value = re.sub(r"[^a-z]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()

def normalize_column_name(column):
    """Normalize CSV headers regardless of case, spaces or punctuation."""
    column = str(column).strip().lower()
    column = re.sub(r"[^a-z0-9]+", "_", column)
    return column.strip("_")


COLUMN_ALIASES = {
    "transaction_description": [
        "transaction_description",
        "description",
        "transaction_desc",
        "transaction_details",
        "details",
        "narration",
        "particulars",
        "remarks",
        "remark",
        "transaction",
        "description_of_transaction",
        "transaction_narration",
    ],
    "amount": [
        "amount",
        "transaction_amount",
        "txn_amount",
        "debit_amount",
        "credit_amount",
    ],
    "date": [
        "date",
        "transaction_date",
        "txn_date",
        "value_date",
    ],
    "merchant": [
        "merchant",
        "merchant_name",
        "payee",
        "recipient",
        "vendor",
    ],
    "transaction_type": [
        "transaction_type",
        "type",
        "txn_type",
        "payment_type",
    ],
}


def normalize_csv_columns(frame):
    """Map common CSV header variations to standard internal column names."""
    normalized = {}

    for original_column in frame.columns:
        normalized[original_column] = normalize_column_name(original_column)

    frame = frame.rename(columns=normalized)

    for canonical_name, aliases in COLUMN_ALIASES.items():
        if canonical_name in frame.columns:
            continue

        for alias in aliases:
            normalized_alias = normalize_column_name(alias)

            if normalized_alias in frame.columns:
                frame = frame.rename(
                    columns={normalized_alias: canonical_name}
                )
                break

    return frame


def explain(description, category, limit=5):
    """Exact local linear-model feature contributions; evidence, not causation or SHAP."""
    vectorizer, classifier = model.named_steps["tfidf"], model.named_steps["clf"]
    row = vectorizer.transform([clean_text(description)])
    class_index = list(classifier.classes_).index(category)
    weights = classifier.coef_[class_index]
    contributions = row.multiply(weights).tocoo()
    ranked = sorted(zip(contributions.col, contributions.data), key=lambda item: item[1], reverse=True)
    names = vectorizer.get_feature_names_out()
    return [{"term": str(names[i]), "contribution": round(float(value), 4)}
            for i, value in ranked[:limit] if value > 0]

def validate_frame(frame):
    errors, warnings = [], []
    if "transaction_description" not in frame.columns:
        errors.append("Required column 'transaction_description' is missing.")
        return {"valid": False, "errors": errors, "warnings": warnings,
                "row_count": len(frame), "columns": list(frame.columns)}
    missing = int(frame["transaction_description"].isna().sum())
    duplicates = int(frame.duplicated().sum())
    if frame.empty:
        errors.append("The uploaded CSV is empty.")
    if missing:
        warnings.append(f"{missing} rows have missing transaction descriptions and will be skipped.")
    if duplicates:
        warnings.append(f"{duplicates} exact duplicate rows were found.")
    if len(frame) > 200000:
        errors.append("Maximum upload size is 100,000 rows.")
    return {"valid": not errors, "errors": errors, "warnings": warnings,
            "row_count": len(frame), "columns": list(frame.columns),
            "missing_descriptions": missing, "duplicate_rows": duplicates}


async def read_csv(file):
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(400, "Please upload a CSV file.")

    raw = await file.read()

    if len(raw) > 25 * 1024 * 1024:
        raise HTTPException(413, "CSV must be smaller than 25 MB.")

    try:
        frame = pd.read_csv(io.BytesIO(raw))

        # Normalize column names before validation and prediction.
        frame = normalize_csv_columns(frame)

        return frame

    except Exception as exc:
        raise HTTPException(400, f"Could not read CSV: {exc}")


class PredictRequest(BaseModel):
    transaction_description: str = Field(min_length=1, max_length=2000)

class FeedbackRequest(BaseModel):
    transaction_description: str = Field(min_length=1, max_length=2000)
    predicted_category: str
    corrected_category: str

@app.get("/api/health")
def health():
    return {"status": "ok", "model": "TF-IDF + Logistic Regression"}

@app.get("/api/metrics")
def get_metrics():
    return {k: v for k, v in metrics.items() if k != "classification_report"}

@app.post("/api/validate")
async def validate(file: UploadFile = File(...)):
    frame = await read_csv(file)
    return validate_frame(frame)

@app.post("/api/predict")
def predict(request: PredictRequest):
    text = clean_text(request.transaction_description)
    if not text:
        raise HTTPException(422, "Description must contain letters.")
    probabilities = model.predict_proba([text])[0]
    index = int(probabilities.argmax())
    category = str(model.classes_[index])
    confidence = float(probabilities[index])
    db = SessionLocal()
    try:
        db.add(PredictionRecord(description=request.transaction_description,
                                predicted_category=category, confidence=confidence))
        db.commit()
    finally:
        db.close()
    return {"transaction_description": request.transaction_description,
            "predicted_category": category, "confidence": round(confidence, 4),
            "explanation": explain(request.transaction_description, category)}

@app.post("/api/predict/batch")
async def predict_batch(file: UploadFile = File(...)):
    frame = await read_csv(file)
    check = validate_frame(frame)
    if not check["valid"]:
        raise HTTPException(422, detail=check)
    frame = frame.dropna(subset=["transaction_description"]).copy()
    descriptions = frame["transaction_description"].astype(str).tolist()
    cleaned = [clean_text(item) for item in descriptions]
    valid_indices = [i for i, item in enumerate(cleaned) if item]
    if not valid_indices:
        raise HTTPException(422, "No usable transaction descriptions found.")
    valid_texts = [cleaned[i] for i in valid_indices]
    predictions = model.predict(valid_texts)
    probabilities = model.predict_proba(valid_texts)
    rows = []
    db = SessionLocal()
    try:
        for position, original_index in enumerate(valid_indices):
            category = str(predictions[position])
            confidence = float(probabilities[position].max())
            description = descriptions[original_index]
            result_row = {"transaction_description": description,
                          "predicted_category": category,
                          "confidence": round(confidence, 4),
                          "explanation": []}
            # Optional source fields enable spending analytics; account identifiers are deliberately excluded.
            if "amount" in frame.columns:
                amount = pd.to_numeric(pd.Series([frame.iloc[original_index]["amount"]]), errors="coerce").iloc[0]
                result_row["amount"] = float(amount) if pd.notna(amount) else None
            if "transaction_type" in frame.columns:
                value = frame.iloc[original_index]["transaction_type"]
                result_row["transaction_type"] = str(value).strip() if pd.notna(value) else None
            if "date" in frame.columns:
                value = frame.iloc[original_index]["date"]
                result_row["date"] = str(value) if pd.notna(value) else None
            if "merchant" in frame.columns:
                value = frame.iloc[original_index]["merchant"]
                result_row["merchant"] = str(value) if pd.notna(value) else None
            rows.append(result_row)
            db.add(PredictionRecord(description=description,
                                    predicted_category=category, confidence=confidence))
        db.commit()
    finally:
        db.close()
    counts = pd.Series([row["predicted_category"] for row in rows]).value_counts().to_dict()
    return {"total": len(rows), "skipped": len(frame) - len(rows),
            "rows": rows, "category_counts": counts,
            "warnings": check["warnings"]}

@app.post("/api/feedback")
def save_feedback(request: FeedbackRequest):
    db = SessionLocal()
    try:
        db.add(FeedbackRecord(description=request.transaction_description,
                              predicted_category=request.predicted_category,
                              corrected_category=request.corrected_category))
        db.commit()
    finally:
        db.close()
    return {"saved": True, "message": "Correction saved for future review; the model is not retrained automatically."}

@app.get("/api/analytics")
def analytics():
    db = SessionLocal()
    try:
        total = db.query(func.count(PredictionRecord.id)).scalar() or 0
        grouped = db.query(PredictionRecord.predicted_category,
                           func.count(PredictionRecord.id)).group_by(
                           PredictionRecord.predicted_category).all()
        feedback_count = db.query(func.count(FeedbackRecord.id)).scalar() or 0
        return {"total_predictions": total, "feedback_count": feedback_count,
                "category_counts": {name: count for name, count in grouped}}
    finally:
        db.close()
