from fastapi.testclient import TestClient
from app.main import app, clean_text, validate_frame
import pandas as pd

client = TestClient(app)

def test_health():
    assert client.get("/api/health").json()["status"] == "ok"

def test_clean_text_removes_reference_numbers():
    assert clean_text("SWIGGY 123456789 PAYMENT") == "swiggy payment"

def test_validation_requires_description():
    result = validate_frame(pd.DataFrame({"amount": [10]}))
    assert result["valid"] is False

def test_single_prediction():
    result = client.post("/api/predict", json={"transaction_description": "SWIGGY FOOD ORDER"})
    assert result.status_code == 200
    assert result.json()["predicted_category"]
    assert "confidence" in result.json()
