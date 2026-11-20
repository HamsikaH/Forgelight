"""Tiny Flask app used to demo Task B: `flask --app <path-to>/demo/app.py config`.

Its config contains keys that must be masked (SECRET, PASSWORD, TOKEN, KEY) next to
ordinary values, plus Flask's own defaults (which include a timedelta).
"""
from flask import Flask

app = Flask(__name__)
app.config.update(
    SECRET_KEY="dev-secret-123",
    DATABASE_PASSWORD="hunter2",
    API_TOKEN="tok_demo_abc",
    STRIPE_API_KEY="sk_test_456",
    MAIL_SERVER="smtp.example.com",
    ITEMS_PER_PAGE=20,
)


@app.route("/")
def index() -> str:
    return "Forgelight demo app"
