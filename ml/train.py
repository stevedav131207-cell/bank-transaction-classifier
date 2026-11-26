"""Train and evaluate the TF-IDF + Logistic Regression baseline."""
import json, re, time
from pathlib import Path
import joblib
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score, classification_report, confusion_matrix

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(__file__).resolve().parents[1] / "data" / "transactions.csv"
MODEL_OUT = ROOT / "backend" / "app" / "model.joblib"
METRICS_OUT = ROOT / "backend" / "app" / "metrics.json"

def clean_text(value):
    value = str(value or "").lower()
    value = re.sub(r"https?://\S+|www\.\S+", " ", value)
    value = re.sub(r"\b\d{5,}\b", " ", value)
    value = re.sub(r"[^a-z]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()

def main():
    df = pd.read_csv(DATA)
    required = {"transaction_description", "category"}
    if not required.issubset(df.columns):
        raise ValueError(f"Dataset must contain: {sorted(required)}")
    df = df.dropna(subset=["transaction_description", "category"])
    X = df["transaction_description"].map(clean_text)
    y = df["category"].astype(str)
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )
    pipeline = Pipeline([
        ("tfidf", TfidfVectorizer(ngram_range=(1, 2), min_df=2,
                                  max_features=180000, sublinear_tf=True,
                                  strip_accents="unicode")),
        ("clf", LogisticRegression(max_iter=500, class_weight="balanced", C=3.0))
    ])
    started = time.time()
    pipeline.fit(X_train, y_train)
    predictions = pipeline.predict(X_test)
    report = classification_report(y_test, predictions, output_dict=True, zero_division=0)
    labels = sorted(y.unique())
    matrix = confusion_matrix(y_test, predictions, labels=labels)
    results = {
        "model": "TF-IDF + Logistic Regression",
        "accuracy": float(accuracy_score(y_test, predictions)),
        "macro_f1": float(f1_score(y_test, predictions, average="macro")),
        "weighted_f1": float(f1_score(y_test, predictions, average="weighted")),
        "train_rows": len(X_train), "test_rows": len(X_test),
        "classes": labels, "classification_report": report,
        "confusion_matrix": matrix.tolist(), "training_seconds": round(time.time()-started, 2),
        "random_state": 42
    }
    MODEL_OUT.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(pipeline, MODEL_OUT, compress=3)
    METRICS_OUT.write_text(json.dumps(results, indent=2))
    print(json.dumps({k:v for k,v in results.items() if k not in ("classification_report","confusion_matrix")}, indent=2))

if __name__ == "__main__":
    main()
